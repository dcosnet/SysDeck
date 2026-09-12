import { z } from "zod";
import { BudgetSchema } from "./virtual_keys.ts";

export const TeamSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  customerId: z.string().optional(),
  budget: BudgetSchema.optional(),
  usedRequests: z.number().int().nonnegative().default(0),
  usedCostMicroUsd: z.number().int().nonnegative().default(0),
});
export type Team = z.infer<typeof TeamSchema>;

export const CustomerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  budget: BudgetSchema.optional(),
  usedRequests: z.number().int().nonnegative().default(0),
  usedCostMicroUsd: z.number().int().nonnegative().default(0),
});
export type Customer = z.infer<typeof CustomerSchema>;

export type ChainDecision =
  | { ok: true }
  | { ok: false; status: number; message: string; code: string };

interface Entity {
  id: string;
  name: string;
  enabled: boolean;
  budget?: z.infer<typeof BudgetSchema>;
  usedRequests: number;
  usedCostMicroUsd: number;
}

function checkEntity(kind: "team" | "customer", entity: Entity): ChainDecision {
  if (!entity.enabled) {
    return {
      ok: false,
      status: 401,
      message: `${kind} "${entity.name}" is disabled.`,
      code: `${kind}_disabled`,
    };
  }
  if (
    entity.budget?.resetIntervalMs === undefined &&
    entity.budget?.maxRequests !== undefined &&
    entity.usedRequests >= entity.budget.maxRequests
  ) {
    return {
      ok: false,
      status: 402,
      message: `${kind} "${entity.name}" has exhausted its request budget.`,
      code: `${kind}_budget_exhausted`,
    };
  }
  if (
    entity.budget?.resetIntervalMs === undefined &&
    entity.budget?.maxCostUsd !== undefined &&
    entity.usedCostMicroUsd >= Math.round(entity.budget.maxCostUsd * 1_000_000)
  ) {
    return {
      ok: false,
      status: 402,
      message: `${kind} "${entity.name}" has exhausted its cost budget.`,
      code: `${kind}_cost_budget_exhausted`,
    };
  }
  return { ok: true };
}

export type AccountField = "usage" | "cost";
export type HierarchyPersistence =
  | boolean
  | { team?: boolean; customer?: boolean };

function shouldPersist(
  persist: HierarchyPersistence,
  kind: "team" | "customer",
): boolean {
  if (typeof persist === "boolean") {
    return persist;
  }
  return persist[kind] ?? true;
}

export class GovernanceHierarchy {
  private teams = new Map<string, Team>();
  private customers = new Map<string, Customer>();
  private sink?: (
    kind: "team" | "customer",
    id: string,
    field: AccountField,
    amount: number,
  ) => void;

  constructor(teams: Team[] = [], customers: Customer[] = []) {
    for (const team of teams) {
      this.teams.set(team.id, team);
    }
    for (const customer of customers) {
      this.customers.set(customer.id, customer);
    }
  }

  upsertTeam(team: Team): void {
    this.teams.set(team.id, TeamSchema.parse(team));
  }

  removeTeam(id: string): boolean {
    return this.teams.delete(id);
  }

  getTeam(id: string): Team | undefined {
    return this.teams.get(id);
  }

  listTeams(): Team[] {
    return [...this.teams.values()];
  }

  upsertCustomer(customer: Customer): void {
    this.customers.set(customer.id, CustomerSchema.parse(customer));
  }

  removeCustomer(id: string): boolean {
    return this.customers.delete(id);
  }

  getCustomer(id: string): Customer | undefined {
    return this.customers.get(id);
  }

  listCustomers(): Customer[] {
    return [...this.customers.values()];
  }

  /**
   * Admission up the chain for a key's team. Unknown references deny —
   * a dangling teamId is a misconfiguration, not an open door.
   */
  checkChain(teamId: string | undefined): ChainDecision {
    if (!teamId) {
      return { ok: true };
    }
    const team = this.teams.get(teamId);
    if (!team) {
      return {
        ok: false,
        status: 401,
        message: `Virtual key references unknown team "${teamId}".`,
        code: "invalid_team",
      };
    }
    const teamDecision = checkEntity("team", team);
    if (!teamDecision.ok) {
      return teamDecision;
    }
    if (team.customerId) {
      const customer = this.customers.get(team.customerId);
      if (!customer) {
        return {
          ok: false,
          status: 401,
          message: `Team "${team.name}" references unknown customer ` +
            `"${team.customerId}".`,
          code: "invalid_customer",
        };
      }
      return checkEntity("customer", customer);
    }
    return { ok: true };
  }

  /**
   * Per-admission request accounting up the chain. Mirrors VirtualKeyManager's
   * reserve→commit/release protocol: `recordUsage(teamId, false)` reserves the
   * increment in-memory (atomic with checkChain), `persistUsage` commits it once
   * fully admitted, and `releaseRequest` rolls it back if a later gate denies.
   */
  recordUsage(
    teamId: string | undefined,
    persist: HierarchyPersistence = true,
  ): void {
    const team = teamId ? this.teams.get(teamId) : undefined;
    if (!team) {
      return;
    }
    team.usedRequests += 1;
    if (shouldPersist(persist, "team")) {
      this.sink?.("team", team.id, "usage", 1);
    }
    const customer = team.customerId
      ? this.customers.get(team.customerId)
      : undefined;
    if (customer) {
      customer.usedRequests += 1;
      if (shouldPersist(persist, "customer")) {
        this.sink?.("customer", customer.id, "usage", 1);
      }
    }
  }

  /** Rollback of reserved (not-yet-persisted) request increments up the chain. */
  releaseRequest(teamId: string | undefined): void {
    const team = teamId ? this.teams.get(teamId) : undefined;
    if (!team) {
      return;
    }
    if (team.usedRequests > 0) {
      team.usedRequests -= 1;
    }
    const customer = team.customerId
      ? this.customers.get(team.customerId)
      : undefined;
    if (customer && customer.usedRequests > 0) {
      customer.usedRequests -= 1;
    }
  }

  /** Commit reserved request increments to the persistence sink. */
  persistUsage(
    teamId: string | undefined,
    persist: HierarchyPersistence = true,
  ): void {
    const team = teamId ? this.teams.get(teamId) : undefined;
    if (!team) {
      return;
    }
    if (shouldPersist(persist, "team")) {
      this.sink?.("team", team.id, "usage", 1);
    }
    const customer = team.customerId
      ? this.customers.get(team.customerId)
      : undefined;
    if (customer && shouldPersist(persist, "customer")) {
      this.sink?.("customer", customer.id, "usage", 1);
    }
  }

  /** Post-response micro-USD cost accounting up the chain. */
  recordCost(
    teamId: string | undefined,
    costMicroUsd: number,
    persist: HierarchyPersistence = true,
  ): void {
    const team = teamId ? this.teams.get(teamId) : undefined;
    if (!team || costMicroUsd <= 0) {
      return;
    }
    team.usedCostMicroUsd += costMicroUsd;
    if (shouldPersist(persist, "team")) {
      this.sink?.("team", team.id, "cost", costMicroUsd);
    }
    const customer = team.customerId
      ? this.customers.get(team.customerId)
      : undefined;
    if (customer) {
      customer.usedCostMicroUsd += costMicroUsd;
      if (shouldPersist(persist, "customer")) {
        this.sink?.("customer", customer.id, "cost", costMicroUsd);
      }
    }
  }

  hydrate(
    kind: "team" | "customer",
    usage: Record<string, number>,
    costs: Record<string, number>,
  ): void {
    const map = kind === "team" ? this.teams : this.customers;
    for (const [id, count] of Object.entries(usage)) {
      const entity = map.get(id);
      if (entity) {
        entity.usedRequests = count;
      }
    }
    for (const [id, micro] of Object.entries(costs)) {
      const entity = map.get(id);
      if (entity) {
        entity.usedCostMicroUsd = micro;
      }
    }
  }

  onAccount(
    sink: (
      kind: "team" | "customer",
      id: string,
      field: AccountField,
      amount: number,
    ) => void,
  ): void {
    this.sink = sink;
  }
}
