import { ProviderError } from "./client.ts";
import type { ResolvedTarget } from "./manager.ts";
import { targetInScope, targetScope } from "./scope.ts";

export interface DispatchOutcome {
  response: Response;
  target: ResolvedTarget;
  /** Failed attempts that preceded the successful one. */
  failures: Array<{ target: ResolvedTarget; error: unknown }>;
}

export class AllProvidersFailedError extends Error {
  constructor(
    public failures: Array<{ target: ResolvedTarget; error: unknown }>,
  ) {
    const last = failures.at(-1);
    super(
      `All ${failures.length} provider target(s) failed. Last error: ${
        last ? String(last.error) : "unknown"
      }`,
    );
    this.name = "AllProvidersFailedError";
  }
}

/** Retriable-for-fallback: rate limits, server errors, network failures. */
export function isFallbackEligible(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return false; // the client hung up — never reroute
  }
  return error instanceof TypeError; // fetch network failure
}

/**
 * Tries each target in order. Non-eligible errors (4xx contract errors,
 * client aborts) propagate immediately; eligible errors advance the chain.
 */
export async function dispatchWithFallback(
  targets: ResolvedTarget[],
  dispatch: (target: ResolvedTarget) => Promise<Response>,
): Promise<DispatchOutcome> {
  const failures: Array<{ target: ResolvedTarget; error: unknown }> = [];

  // Per-request virtual-key scope (set by the gateway admission middleware):
  // drop any failover / client-fallback target outside the key's allowlist so
  // dispatch can never escape the scope the admission check validated.
  const scope = targetScope.getStore();
  const chain = scope
    ? targets.filter((t) => targetInScope(scope, t))
    : targets;

  for (const target of chain) {
    try {
      // Every provider egress attempt consumes one request from that account's
      // window, including attempts that subsequently fail and trigger fallback.
      target.recordRequest?.();
      const response = await dispatch(target);
      return { response, target, failures };
    } catch (error) {
      if (!isFallbackEligible(error)) {
        throw error;
      }
      failures.push({ target, error });
    }
  }

  throw new AllProvidersFailedError(failures);
}
