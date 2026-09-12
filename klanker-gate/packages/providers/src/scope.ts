import { AsyncLocalStorage } from "node:async_hooks";
import type { ResolvedTarget } from "./manager.ts";

export interface DispatchScope {
  /** Allowed provider account ids; null = any provider. */
  providers: Set<string> | null;
  /** Allowed model ids (lowercased, prefix-stripped); null = any model. */
  models: Set<string> | null;
}

export const targetScope = new AsyncLocalStorage<DispatchScope>();

/** True when a resolved target is within the active dispatch scope. */
export function targetInScope(
  scope: DispatchScope,
  target: ResolvedTarget,
): boolean {
  if (scope.providers && !scope.providers.has(target.providerId)) {
    return false;
  }
  if (scope.models && !scope.models.has(target.model.toLowerCase())) {
    return false;
  }
  return true;
}
