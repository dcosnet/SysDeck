// Shared helpers for SysDeck bridge modules (server-side only).
import type { BridgeResponse } from '../types'

/** Wrap command output in the canonical bridge envelope. */
export function ok<T>(data: T, source: BridgeResponse['source'] = 'demo', note?: string): BridgeResponse<T> {
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

/** run() — safe subprocess with timeout, mirroring the python bridge's run(). */
import { spawn } from 'child_process'

export async function run(
  cmd: string,
  cmdArgs: string[],
  timeoutMs = 5000,
): Promise<{ rc: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, cmdArgs, { timeout: timeoutMs })
      let stdout = ''
      let stderr = ''
      p.stdout?.on('data', (d) => (stdout += d.toString()))
      p.stderr?.on('data', (d) => (stderr += d.toString()))
      p.on('error', (err) => resolve({ rc: 127, stdout, stderr: String(err) }))
      p.on('close', (rc) => resolve({ rc: rc ?? 1, stdout, stderr }))
    } catch (err) {
      resolve({ rc: 127, stdout: '', stderr: String(err) })
    }
  })
}

/** which() — shutil.which equivalent. */
export async function which(bin: string): Promise<boolean> {
  const r = await run('which', [bin], 2000)
  return r.rc === 0 && r.stdout.trim().length > 0
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

/** Fetch JSON from the fester service (server-side). */
export async function festerFetch<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`http://127.0.0.1:3010${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}
