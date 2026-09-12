import { apiFetch } from "../api";

/** Fallback EUR-per-USD rate when the gateway does not supply one. */
export const DEFAULT_EUR_RATE = 0.92;

let eurRate = DEFAULT_EUR_RATE;

export function getEurRate(): number {
  return eurRate;
}

/** Apply an operator-configured rate; ignores non-finite / non-positive input. */
export function setEurRate(rate: number | undefined): void {
  if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
    eurRate = rate;
  }
}

let ratePromise: Promise<number> | null = null;

/**
 * Fetch + cache the operator rate once per session. Cost views await this in
 * their load() before rendering money so the first paint already uses the
 * configured rate. Only a SUCCESSFUL fetch is memoized; a failure (e.g. a 401
 * before the admin token is set) clears the memo so a later authed call retries.
 */
export function ensureEurRate(): Promise<number> {
  if (!ratePromise) {
    ratePromise = apiFetch<{ eurRate?: number }>("/api/config")
      .then((body) => {
        setEurRate(body?.eurRate);
        return eurRate;
      })
      .catch((err) => {
        ratePromise = null;
        throw err;
      });
  }
  return ratePromise;
}

/** Test seam: reset the memoized fetch + rate to defaults. */
export function resetEurRate(): void {
  ratePromise = null;
  eurRate = DEFAULT_EUR_RATE;
}

export function usdToEur(usd: number): number {
  return usd * eurRate;
}

export function eurToUsd(eur: number): number {
  return eur / eurRate;
}

export function microUsdToEur(micro: number): number {
  return (micro / 1_000_000) * eurRate;
}

function fmt(value: number, precision: number): string {
  return `€${value.toFixed(precision)}`;
}

/** Format a whole-USD amount as a euro string (e.g. 12.5 -> "€11.50"). */
export function formatEurFromUsd(usd: number, precision = 2): string {
  return fmt(usd * eurRate, precision);
}

/** Format an integer micro-USD amount as a euro string. */
export function formatEurFromMicroUsd(micro: number, precision = 2): string {
  return fmt((micro / 1_000_000) * eurRate, precision);
}
