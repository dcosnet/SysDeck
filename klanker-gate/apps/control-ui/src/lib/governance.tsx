import type { ReactNode } from "react";
import type { Budget, VirtualKeyPublic } from "../api";
import { Badge } from "../components/ui/badge";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Field, Label } from "../components/ui/label";
import { NativeSelect } from "../components/ui/select";
import { eurToUsd, formatEurFromUsd, usdToEur } from "./currency";

export type WindowUnit = "seconds" | "minutes" | "hours";

const UNIT_MS: Record<WindowUnit, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
};

const LIMIT_LOCK_HINT =
  "Limits can be raised or changed, not removed (API limitation).";

export function microToUsd(micro: number): number {
  return micro / 1_000_000;
}

/** Compact window label for table chips, e.g. 3600000 -> "1h". */
export function humanizeWindow(ms: number): string {
  if (ms > 0 && ms % UNIT_MS.hours === 0) {
    return `${ms / UNIT_MS.hours}h`;
  }
  if (ms > 0 && ms % UNIT_MS.minutes === 0) {
    return `${ms / UNIT_MS.minutes}m`;
  }
  return `${Math.round(ms / UNIT_MS.seconds)}s`;
}

export function msFromWindow(value: number, unit: WindowUnit): number {
  return value * UNIT_MS[unit];
}

/** Best-fit split of a stored windowMs back into an editable value + unit. */
export function windowToDraft(ms: number): { value: string; unit: WindowUnit } {
  if (ms > 0 && ms % UNIT_MS.hours === 0) {
    return { value: String(ms / UNIT_MS.hours), unit: "hours" };
  }
  if (ms > 0 && ms % UNIT_MS.minutes === 0) {
    return { value: String(ms / UNIT_MS.minutes), unit: "minutes" };
  }
  return { value: String(Math.round(ms / UNIT_MS.seconds)), unit: "seconds" };
}

/* ------------------------------- budget -------------------------------- */

export interface BudgetDraft {
  on: boolean;
  maxRequests: string;
  maxCostUsd: string;
}

export function emptyBudgetDraft(): BudgetDraft {
  return { on: false, maxRequests: "", maxCostUsd: "" };
}

export function budgetToDraft(budget?: Budget): BudgetDraft {
  if (!budget) {
    return emptyBudgetDraft();
  }
  return {
    on: true,
    maxRequests: budget.maxRequests != null ? String(budget.maxRequests) : "",
    // The stored cap is canonical USD; the operator edits it in euros.
    maxCostUsd: budget.maxCostUsd != null
      ? String(usdToEur(budget.maxCostUsd))
      : "",
  };
}

export function budgetToPayload(draft: BudgetDraft): Budget | undefined {
  if (!draft.on) {
    return undefined;
  }
  const budget: Budget = {};
  if (draft.maxRequests.trim()) {
    budget.maxRequests = Number(draft.maxRequests);
  }
  if (draft.maxCostUsd.trim()) {
    // The operator types euros; store the canonical USD value.
    budget.maxCostUsd = eurToUsd(Number(draft.maxCostUsd));
  }
  return budget;
}

export function budgetError(draft: BudgetDraft): string | null {
  if (!draft.on) {
    return null;
  }
  if (!draft.maxRequests.trim() && !draft.maxCostUsd.trim()) {
    return "Set a request cap, a cost cap, or both.";
  }
  return null;
}

function budgetSummary(budget: Budget): string[] {
  const parts: string[] = [];
  if (budget.maxRequests != null) {
    parts.push(`${budget.maxRequests} req`);
  }
  if (budget.maxCostUsd != null) {
    parts.push(formatEurFromUsd(budget.maxCostUsd));
  }
  return parts;
}

/** Compact limit chips for a virtual key row (rate / tokens / budget). */
export function vkLimitChips(vk: VirtualKeyPublic): string[] {
  const chips: string[] = [];
  if (vk.rateLimit) {
    chips.push(
      `rate ${vk.rateLimit.maxRequests}/${
        humanizeWindow(vk.rateLimit.windowMs)
      }`,
    );
  }
  if (vk.tokenLimit) {
    chips.push(
      `tokens ${vk.tokenLimit.maxTokens}/${
        humanizeWindow(vk.tokenLimit.windowMs)
      }`,
    );
  }
  if (vk.budget) {
    const parts = budgetSummary(vk.budget);
    if (parts.length > 0) {
      chips.push(`budget ${parts.join(" ")}`);
    }
  }
  return chips;
}

export function budgetChips(budget?: Budget): string[] {
  return budget ? budgetSummary(budget) : [];
}

/* ---------------------------- presentational --------------------------- */

/** Muted chip row; falls back to a "no value" hyphen when empty. */
export function Chips({ items }: { items: string[] }): ReactNode {
  if (items.length === 0) {
    return <span className="text-muted-foreground">-</span>;
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {items.map((item) => <Badge key={item} tone="muted">{item}</Badge>)}
    </span>
  );
}

export function StatusBadge({ enabled }: { enabled: boolean }): ReactNode {
  return (
    <Badge tone={enabled ? "ok" : "muted"}>
      {enabled ? "enabled" : "disabled"}
    </Badge>
  );
}

/** Number input + unit select composite for rate/token windows (spec 2.6). */
export function NumberAndUnit(
  { id, value, unit, onValue, onUnit }: {
    id: string;
    value: string;
    unit: WindowUnit;
    onValue: (value: string) => void;
    onUnit: (unit: WindowUnit) => void;
  },
): ReactNode {
  return (
    <div className="flex gap-2">
      <Input
        id={id}
        type="number"
        min="1"
        className="w-24"
        value={value}
        onChange={(event) => onValue(event.target.value)}
      />
      <NativeSelect
        aria-label="Window unit"
        value={unit}
        onChange={(event) => onUnit(event.target.value as WindowUnit)}
      >
        <option value="seconds">seconds</option>
        <option value="minutes">minutes</option>
        <option value="hours">hours</option>
      </NativeSelect>
    </div>
  );
}

export interface LimitDraft {
  on: boolean;
  max: string;
  windowValue: string;
  windowUnit: WindowUnit;
}

export function emptyLimitDraft(): LimitDraft {
  return { on: false, max: "", windowValue: "1", windowUnit: "minutes" };
}

export function rateLimitToDraft(
  limit?: { maxRequests: number; windowMs: number },
): LimitDraft {
  if (!limit) {
    return emptyLimitDraft();
  }
  const win = windowToDraft(limit.windowMs);
  return {
    on: true,
    max: String(limit.maxRequests),
    windowValue: win.value,
    windowUnit: win.unit,
  };
}

export function tokenLimitToDraft(
  limit?: { maxTokens: number; windowMs: number },
): LimitDraft {
  if (!limit) {
    return emptyLimitDraft();
  }
  const win = windowToDraft(limit.windowMs);
  return {
    on: true,
    max: String(limit.maxTokens),
    windowValue: win.value,
    windowUnit: win.unit,
  };
}

/**
 * Checkbox-gated limit/budget sub-form. `locked` keeps a previously-set limit
 * from being unchecked on edit, because the PUT partial cannot clear it (R6).
 */
export function LimitField(
  { title, maxLabel, idPrefix, draft, onChange, locked }: {
    title: string;
    /** Undefined = budget sub-form (two money fields, no window). */
    maxLabel?: string;
    idPrefix: string;
    draft: LimitDraft;
    onChange: (draft: LimitDraft) => void;
    locked?: boolean;
  },
): ReactNode {
  const disableToggle = Boolean(locked) && draft.on;
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={draft.on}
          disabled={disableToggle}
          title={disableToggle ? LIMIT_LOCK_HINT : undefined}
          onChange={(event) => onChange({ ...draft, on: event.target.checked })}
        />
        {title}
      </label>
      {draft.on && (
        <div className="grid gap-3 pl-6 sm:grid-cols-2">
          <Field id={`${idPrefix}-max`} label={maxLabel ?? "Max requests"}>
            <Input
              id={`${idPrefix}-max`}
              type="number"
              min="1"
              value={draft.max}
              onChange={(event) =>
                onChange({ ...draft, max: event.target.value })}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-window`}>Window</Label>
            <NumberAndUnit
              id={`${idPrefix}-window`}
              value={draft.windowValue}
              unit={draft.windowUnit}
              onValue={(value) => onChange({ ...draft, windowValue: value })}
              onUnit={(unit) => onChange({ ...draft, windowUnit: unit })}
            />
          </div>
        </div>
      )}
    </fieldset>
  );
}

/** Budget-specific sub-form (request cap + cost cap, no window). */
export function BudgetField(
  { idPrefix, draft, onChange, locked }: {
    idPrefix: string;
    draft: BudgetDraft;
    onChange: (draft: BudgetDraft) => void;
    locked?: boolean;
  },
): ReactNode {
  const disableToggle = Boolean(locked) && draft.on;
  const error = budgetError(draft);
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={draft.on}
          disabled={disableToggle}
          title={disableToggle ? LIMIT_LOCK_HINT : undefined}
          onChange={(event) => onChange({ ...draft, on: event.target.checked })}
        />
        Budget
      </label>
      {draft.on && (
        <div className="grid gap-3 pl-6 sm:grid-cols-2">
          <Field id={`${idPrefix}-req`} label="Max requests">
            <Input
              id={`${idPrefix}-req`}
              type="number"
              min="1"
              value={draft.maxRequests}
              onChange={(event) =>
                onChange({ ...draft, maxRequests: event.target.value })}
            />
          </Field>
          <Field id={`${idPrefix}-cost`} label="Max cost (EUR)">
            <Input
              id={`${idPrefix}-cost`}
              type="number"
              min="0"
              step="0.01"
              value={draft.maxCostUsd}
              onChange={(event) =>
                onChange({ ...draft, maxCostUsd: event.target.value })}
            />
          </Field>
          {error && (
            <p className="col-span-full text-sm text-destructive">{error}</p>
          )}
        </div>
      )}
    </fieldset>
  );
}
