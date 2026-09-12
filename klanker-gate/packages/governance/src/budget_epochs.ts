import type { StateKey, StateStore } from "../../config/src/store.ts";

export const MIN_BUDGET_RESET_INTERVAL_MS = 60_000;
export const MAX_BUDGET_RESET_INTERVAL_MS = 31_622_400_000;

export type BudgetEntityKind = "virtual-key" | "team" | "customer";
export type BudgetDimension = "requests" | "cost-micro-usd";

export interface ResettableBudget {
  maxRequests?: number;
  maxCostUsd?: number;
  resetIntervalMs?: number;
}

export interface BudgetSubject {
  kind: BudgetEntityKind;
  id: string;
  name: string;
  budget?: ResettableBudget;
}

export interface ScheduledBudget extends BudgetSubject {
  budget: ResettableBudget & { resetIntervalMs: number };
  periodStartMs: number;
}

export type BudgetAdmission =
  | { ok: true; schedules: ScheduledBudget[] }
  | { ok: false; status: 402 | 503; code: string; message: string };

function anchorKey(kind: BudgetEntityKind, id: string): StateKey {
  return ["governance", "budget-v2", "anchor", kind, id];
}

function counterKey(
  schedule: ScheduledBudget,
  dimension: BudgetDimension,
): StateKey {
  return [
    "governance",
    "budget-v2",
    "counter",
    schedule.kind,
    schedule.id,
    schedule.periodStartMs,
    dimension,
  ];
}

function code(kind: BudgetEntityKind, suffix: "requests" | "cost"): string {
  if (kind === "virtual-key") {
    return suffix === "cost" ? "cost_budget_exhausted" : "budget_exhausted";
  }
  return suffix === "cost"
    ? `${kind}_cost_budget_exhausted`
    : `${kind}_budget_exhausted`;
}

function message(
  subject: BudgetSubject,
  dimension: "request" | "cost",
): string {
  const kind = subject.kind === "virtual-key"
    ? "Virtual key"
    : subject.kind[0].toUpperCase() + subject.kind.slice(1);
  return `${kind} "${subject.name}" has exhausted its ${dimension} budget.`;
}

/**
 * Server-timed, immutable-period budget accounting. Scheduled counters never
 * reuse the legacy lifetime keys, so delayed writes cannot refill a later
 * period. It is intentionally a small authority: the managers remain public
 * projections, while this store owns scheduled admission.
 */
export class BudgetEpochStore {
  private anchors = new Map<string, number>();

  constructor(
    private store?: StateStore,
    private now: () => number = () => Date.now(),
  ) {}

  async configure(
    kind: BudgetEntityKind,
    id: string,
    previous: ResettableBudget | undefined,
    next: ResettableBudget | undefined,
  ): Promise<void> {
    const before = previous?.resetIntervalMs;
    const after = next?.resetIntervalMs;
    if (after === undefined || before === after) {
      return;
    }
    const key = this.anchorId(kind, id);
    const anchor = this.now();
    this.anchors.set(key, anchor);
    if (this.store) {
      await this.store.set(anchorKey(kind, id), anchor);
    }
  }

  async schedules(
    subjects: readonly BudgetSubject[],
  ): Promise<ScheduledBudget[]> {
    const at = this.now();
    const schedules: ScheduledBudget[] = [];
    for (const subject of subjects) {
      const interval = subject.budget?.resetIntervalMs;
      if (interval === undefined) {
        continue;
      }
      const anchor = await this.anchorFor(subject.kind, subject.id, at);
      schedules.push({
        ...subject,
        budget: { ...subject.budget, resetIntervalMs: interval },
        periodStartMs: anchor + Math.floor((at - anchor) / interval) * interval,
      });
    }
    return schedules;
  }

  async admit(subjects: readonly BudgetSubject[]): Promise<BudgetAdmission> {
    const schedules = await this.schedules(subjects);
    for (const schedule of schedules) {
      if (schedule.budget.maxCostUsd === undefined) {
        continue;
      }
      const used = await this.count(schedule, "cost-micro-usd");
      if (used >= Math.round(schedule.budget.maxCostUsd * 1_000_000)) {
        return {
          ok: false,
          status: 402,
          code: code(schedule.kind, "cost"),
          message: message(schedule, "cost"),
        };
      }
    }

    const requestLimits = schedules.flatMap((schedule) =>
      schedule.budget.maxRequests === undefined
        ? []
        : [{ schedule, max: schedule.budget.maxRequests }]
    );
    if (requestLimits.length === 0) {
      return { ok: true, schedules };
    }

    const result = this.store
      ? await this.store.reserveCounts(
        requestLimits.map(({ schedule, max }) => ({
          key: counterKey(schedule, "requests"),
          max,
        })),
      )
      : this.reserveInMemory(requestLimits);
    if (result === "reserved") {
      return { ok: true, schedules };
    }
    if (result === "conflict") {
      return {
        ok: false,
        status: 503,
        code: "budget_reservation_unavailable",
        message: "Budget reservation is temporarily unavailable.",
      };
    }
    const exhausted = (await Promise.all(
      requestLimits.map(async ({ schedule, max }) => ({
        schedule,
        count: await this.count(schedule, "requests"),
        max,
      })),
    )).find(({ count, max }) => count >= max)?.schedule ??
      requestLimits[0].schedule;
    return {
      ok: false,
      status: 402,
      code: code(exhausted.kind, "requests"),
      message: message(exhausted, "request"),
    };
  }

  async recordCost(schedule: ScheduledBudget, microUsd: number): Promise<void> {
    if (microUsd <= 0) {
      return;
    }
    const key = counterKey(schedule, "cost-micro-usd");
    if (this.store) {
      await this.store.sum(key, BigInt(microUsd));
    } else {
      this.anchors.set(
        this.counterId(schedule, "cost-micro-usd"),
        this.memoryCount(schedule, "cost-micro-usd") + microUsd,
      );
    }
  }

  async count(
    schedule: ScheduledBudget,
    dimension: BudgetDimension,
  ): Promise<number> {
    if (this.store) {
      return await this.store.getCount(counterKey(schedule, dimension));
    }
    return this.memoryCount(schedule, dimension);
  }

  private async anchorFor(
    kind: BudgetEntityKind,
    id: string,
    now: number,
  ): Promise<number> {
    const key = this.anchorId(kind, id);
    const local = this.anchors.get(key);
    if (local !== undefined) {
      return local;
    }
    const anchor = this.store
      ? await this.store.getOrSet(anchorKey(kind, id), now)
      : now;
    this.anchors.set(key, anchor);
    return anchor;
  }

  private reserveInMemory(
    limits: ReadonlyArray<{ schedule: ScheduledBudget; max: number }>,
  ): "reserved" | "exhausted" {
    if (
      limits.some(({ schedule, max }) =>
        this.memoryCount(schedule, "requests") >= max
      )
    ) {
      return "exhausted";
    }
    for (const { schedule } of limits) {
      const id = this.counterId(schedule, "requests");
      this.anchors.set(id, (this.anchors.get(id) ?? 0) + 1);
    }
    return "reserved";
  }

  private memoryCount(
    schedule: ScheduledBudget,
    dimension: BudgetDimension,
  ): number {
    return this.anchors.get(this.counterId(schedule, dimension)) ?? 0;
  }

  private anchorId(kind: BudgetEntityKind, id: string): string {
    return `anchor:${kind}:${id}`;
  }

  private counterId(
    schedule: ScheduledBudget,
    dimension: BudgetDimension,
  ): string {
    return `${schedule.kind}:${schedule.id}:${schedule.periodStartMs}:${dimension}`;
  }
}
