/**
 * Fester clock — periodic-loop + sleep primitives that survive `bun --hot`.
 *
 * Bun 1.3.x --hot quirk (observed in this environment): after a module
 * re-evaluation the process timer subsystem ends up dead — setTimeout /
 * setInterval / Bun.sleep are registered but NEVER fire, and async chains
 * started during module re-evaluation never resume either. Socket I/O and
 * subprocess completion created from LIVE request contexts keep working.
 *
 * So fester never touches the timer queue:
 *   - sleep(): awaits a tiny `sleep` coreutils subprocess (SIGCHLD-driven)
 *   - loops: created lazily from a request/WS context via ensureLoop(),
 *     supervised for staleness, with the tick function re-bound on every
 *     module (re)evaluation through globalThis.
 *
 * Overhead is ~2–5ms per call (fork+exec), negligible at fester's
 * simulation scale (per-action durations of 150–2200ms).
 */

export function sleep(ms: number): Promise<void> {
  const secs = Math.max(0.01, ms / 1000)
  return Bun.spawn(['sleep', secs.toFixed(3)]).exited.then(() => undefined)
}

/** Register (or re-bind) the tick function of a named loop. Safe to call on
 *  every module (re)evaluation — the running loop picks up the new closure. */
export function bindLoop(key: string, ms: number, fn: () => void): void {
  const g = globalThis as Record<string, unknown>
  g[`${key}__tick`] = fn
  g[`${key}__ms`] = ms
}

/** Supervisor: create the named loop if it is missing or has gone stale
 *  (e.g. killed by a hot reload). Call from live request / WS contexts. */
export function ensureLoop(key: string): void {
  const g = globalThis as Record<string, unknown>
  const ms = (g[`${key}__ms`] as number | undefined) ?? 0
  if (!ms) return // nothing bound under this key yet
  const last = (g[`${key}__last`] as number) ?? 0
  const running = g[`${key}__loop`] === true
  if (running && Date.now() - last < ms * 3) return // alive and ticking
  g[`${key}__loop`] = true
  g[`${key}__last`] = Date.now()
  void (async () => {
    for (;;) {
      await sleep(ms)
      g[`${key}__last`] = Date.now()
      const tick = g[`${key}__tick`] as (() => void) | undefined
      try {
        tick?.()
      } catch (err) {
        console.error(`[fester:clock] ${key} tick failed`, err)
      }
    }
  })()
}
