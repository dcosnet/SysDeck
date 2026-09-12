import { spawn } from 'child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

// SysDeck web edition — PAM bridge to the host account system (v0.4.0).
//
// Spawns scripts/pam-auth.py (stdlib-only ctypes client of libpam) and
// hands it the credentials over stdin — the password never touches
// argv (world-readable via /proc) and never crosses a network hop.
// This is the same login primitive Cockpit uses: the HOST decides,
// through the same PAM stacks the console/sshd get.
//
// Failure taxonomy the caller (login route) acts on:
//   ok:true                    → authenticated as user
//   reason 'auth-failed'       → wrong username or password
//   reason 'pam-unavailable'   → no libpam / no python3 → local fallback
//   reason 'timeout'           → helper wedged (kill after PAM_TIMEOUT_S)

export interface PamResult {
  ok: boolean
  user?: string
  reason?: string
  code?: number
}

const HELPER_TIMEOUT_MS = Number(process.env.SYSDECK_PAM_TIMEOUT_MS ?? 8000)

/** Locate pam-auth.py across dev / standalone-build cwd shapes. */
function helperPath(): string | null {
  const roots = [
    process.cwd(), // dev: web/ · standalone: .next/standalone
    path.join(process.cwd(), '..'),
  ]
  for (const root of roots) {
    for (const rel of ['scripts/pam-auth.py', 'web/scripts/pam-auth.py', '../scripts/pam-auth.py']) {
      const p = path.resolve(root, rel)
      if (existsSync(p)) return p
    }
  }
  return null
}

/** The python3 binary the helper runs under (configurable, probed). */
function pythonBin(): string {
  return process.env.SYSDECK_PYTHON ?? 'python3'
}

/** Cached once-per-boot: whether the PAM path is even viable here. */
let viableCache: { viable: boolean; checkedAt: number } | null = null
export function pamViable(): { viable: boolean; reason: string } {
  const now = Date.now()
  if (viableCache && now - viableCache.checkedAt < 60_000) {
    return { viable: viableCache.viable, reason: viableCache.viable ? '' : 'no-helper' }
  }
  const helper = helperPath()
  const viable = helper !== null
  viableCache = { viable, checkedAt: now }
  return { viable, reason: helper ? '' : 'pam-auth.py not found on this install' }
}

/**
 * Authenticate a Unix account through the host's PAM stack.
 * Resolves (never rejects) — auth failure is data, not an exception.
 */
export function authenticateViaPam(user: string, password: string): Promise<PamResult> {
  return new Promise((resolve) => {
    const helper = helperPath()
    if (!helper) return resolve({ ok: false, reason: 'pam-unavailable' })

    let settled = false
    const done = (r: PamResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve(r)
    }

    const child = spawn(pythonBin(), [helper], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
    })

    let out = ''
    child.stdout?.on('data', (d) => (out += d.toString().slice(0, 4096)))
    child.stderr?.on('data', (d) => {
      // stderr is diagnostics only — never returned to the client
      const line = d.toString().trim()
      if (line) console.error(`[pam] helper stderr: ${line.slice(0, 200)}`)
    })

    const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), HELPER_TIMEOUT_MS)

    child.on('error', (err) => {
      // spawn failure: no python3, exec format … → local fallback
      console.error(`[pam] helper spawn failed: ${err.message}`)
      done({ ok: false, reason: 'pam-unavailable' })
    })
    child.on('close', (rc) => {
      try {
        const doc = JSON.parse(out.trim() || '{}') as PamResult
        const code = doc.code ?? (typeof rc === 'number' && rc !== 0 ? rc : undefined)
        done({ ...doc, code })
      } catch {
        done({ ok: false, reason: 'helper-protocol-error' })
      }
    })

    // credentials over stdin, then close it so the helper answers
    try {
      child.stdin?.write(JSON.stringify({ user, password, service: process.env.SYSDECK_PAM_SERVICE ?? 'sysdeck' }))
      child.stdin?.end()
    } catch {
      /* pipe died early — close handler resolves */
    }
  })
}

/** Absolute path of the helper (diagnostics + release surface). */
export const pamHelperFile = (): string | null => helperPath()
