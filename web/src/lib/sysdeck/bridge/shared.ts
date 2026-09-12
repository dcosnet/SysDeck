// Shared helpers for SysDeck bridge modules (server-side only).
import type { BridgeResponse } from '../types'

/** Wrap command output in the canonical bridge envelope.
 *  Default source is 'live' — every bridge in this codebase reads real
 *  host state; anything that cannot be read live fails honestly instead
 *  of fabricating rows. */
export function ok<T>(data: T, source: BridgeResponse['source'] = 'live', note?: string): BridgeResponse<T> {
  return { ok: true, data, source, note }
}

/** Error envelope — bridges fail soft, the panel decides how to render it. */
export function fail(error: string): BridgeResponse<never> {
  return { ok: false, error }
}

export type BridgeCommands = Record<string, (args: Record<string, unknown>) => Promise<unknown>>

export interface BridgeModule {
  commands: BridgeCommands
}

/** run() — safe subprocess with timeout and a scrubbed environment,
 *  mirroring the python bridge's run() posture.
 *
 *  Children see LC_ALL=C (parsed output stays locale-stable) and never
 *  inherit process secrets — the env is rebuilt from a fixed allowlist.
 *  stdout/stderr are tail-capped at maxOutput characters so a chatty
 *  child cannot balloon the console's memory. */
import { spawn } from 'child_process'

export interface RunOptions {
  /** Bytes fed to the child's stdin; the pipe closes after the write. */
  input?: string
  /** Cap for accumulated stdout/stderr (characters, tail kept). Default 8 MiB. */
  maxOutput?: number
  /** Extra env vars merged over the scrubbed base. */
  env?: Record<string, string>
}

const MAX_OUTPUT = 8 * 1024 * 1024

const SCRUBBED_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  NODE_ENV: process.env.NODE_ENV,
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  ...(process.env.USER ? { USER: process.env.USER } : {}),
}

export async function run(
  cmd: string,
  cmdArgs: string[],
  timeoutMs = 5000,
  opts: RunOptions = {},
): Promise<{ rc: number; stdout: string; stderr: string }> {
  const cap = opts.maxOutput ?? MAX_OUTPUT
  return new Promise((resolve) => {
    try {
      const childEnv: NodeJS.ProcessEnv = { ...SCRUBBED_ENV, ...opts.env }
      const p = spawn(cmd, cmdArgs, { timeout: timeoutMs, env: childEnv })
      let stdout = ''
      let stderr = ''
      // Bulk-drop only after reaching 2×cap: bounded memory, amortized O(1) per chunk.
      const acc = (cur: string, d: Buffer): string => {
        const next = cur + d.toString()
        return next.length > cap * 2 ? next.slice(-cap) : next
      }
      p.stdout?.on('data', (d) => (stdout = acc(stdout, d)))
      p.stderr?.on('data', (d) => (stderr = acc(stderr, d)))
      if (opts.input !== undefined) {
        // The child may exit before consuming stdin (EPIPE is expected, not an error).
        p.stdin?.on('error', () => {})
        p.stdin?.end(opts.input)
      }
      p.on('error', (err) => resolve({ rc: 127, stdout: capTail(stdout, cap), stderr: capTail(String(err), cap) }))
      p.on('close', (rc) => resolve({ rc: rc ?? 1, stdout: capTail(stdout, cap), stderr: capTail(stderr, cap) }))
    } catch (err) {
      resolve({ rc: 127, stdout: '', stderr: String(err) })
    }
  })
}

const capTail = (s: string, cap: number): string => (s.length > cap ? s.slice(-cap) : s)

/** ── TTL + single-flight cache ────────────────────────────────────────
 *  Read-side bridges re-probe the host on every poll; the binary-presence
 *  and aggregate probes underneath them change on human timescales. cached()
 *  deduplicates concurrent callers onto one in-flight probe and serves the
 *  settled value until its TTL lapses — panels stay live without spawning
 *  a subprocess storm per tick. Failures are never cached. */
const inflight = new Map<string, Promise<unknown>>()
const settled = new Map<string, { value: unknown; expires: number }>()
const CACHE_MAX = 256

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = settled.get(key)
  if (hit && hit.expires > now) return hit.value as T
  const pending = inflight.get(key)
  if (pending) return pending as Promise<T>
  const promise = (async () => fn())()
  inflight.set(key, promise)
  try {
    const value = await promise
    if (settled.size >= CACHE_MAX) {
      // FIFO sweep keeps the map bounded; probe keys are few dozen in practice.
      const oldest = settled.keys().next().value
      if (oldest !== undefined) settled.delete(oldest)
    }
    settled.set(key, { value, expires: Date.now() + ttlMs })
    return value
  } finally {
    if (inflight.get(key) === promise) inflight.delete(key)
  }
}

/** Drop settled entries whose key starts with `prefix` — mutations call
 *  this so the next read reflects host state immediately instead of
 *  waiting out the TTL. In-flight probes finish and settle once; their
 *  result is then re-fetchable. */
export function invalidateCache(prefix: string): void {
  for (const key of [...settled.keys()]) if (key.startsWith(prefix)) settled.delete(key)
  for (const key of [...inflight.keys()]) if (key.startsWith(prefix)) inflight.delete(key)
}

/** which() — shutil.which equivalent, TTL-cached: binary presence is a
 *  slow-moving fact and the live badge tolerates 30 s staleness. */
export function which(bin: string): Promise<boolean> {
  return cached(`which:${bin}`, 30_000, async () => {
    const r = await run('which', [bin], 2000)
    return r.rc === 0 && r.stdout.trim().length > 0
  })
}

/** Read a /proc or /sys file as text; '' when absent. */
import { readFile } from 'fs/promises'

export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return ''
  }
}

/** Read a /proc or /sys file as JSON-ish lines; [] when absent. */
export async function readLines(path: string): Promise<string[]> {
  const t = await readText(path)
  return t ? t.split('\n').filter((l) => l.length > 0) : []
}

/** Fetch JSON from the fester service (server-side). Carries a
 *  short-lived minted session cookie — fester verifies the same HMAC
 *  token the web console issues, so even the loopback hop is gated. */
export async function festerFetch<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const { mintServerCookie } = await import('../session')
    const res = await fetch(`http://127.0.0.1:3010${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Cookie: await mintServerCookie(),
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}
