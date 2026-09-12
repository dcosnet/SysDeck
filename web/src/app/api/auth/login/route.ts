// POST /api/auth/login — unix-account sign-in, the Cockpit way (v0.4.0).
//
// The username + password pair goes to the HOST's PAM stack (via
// scripts/pam-auth.py — the same primitive cockpit-session uses), or,
// in local / pam+local modes, to the SdUser scrypt table. Success mints
// an HMAC session cookie BOUND TO THE USERNAME (v2 tokens); failures
// are rate limited per IP AND per username, and every attempt is
// audited with the source IP.
//
// Deliberately missing (matching Cockpit's posture):
//   * no user enumeration — wrong-user and wrong-password are the same
//     "incorrect username or password" answer, same timing path
//   * no password ever logged, echoed, or stored
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  AUTH_COOKIE,
  SESSION_TTL_MS,
  createSessionToken,
  sessionCookieOptions,
} from '@/lib/sysdeck/session'
import { authenticateViaPam, pamViable } from '@/lib/sysdeck/pam'
import {
  authMode,
  authenticateLocal,
  consoleUser,
  seedDefaultLocalAccount,
  touchLocalLogin,
  validUsername,
} from '@/lib/sysdeck/users'

export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 4096 // credentials are never bigger than this
const FAIL_WINDOW_MS = 60_000
const MAX_FAILURES = 5 // per IP AND per username per window

type Bucket = { windowStart: number; failures: number }
const failBuckets = new Map<string, Bucket>()

// X-Forwarded-For defines lockout identity only when the operator opts
// in — a client-supplied header must never shape auth limits on a
// loopback-bound console. Direct connections share the 'local' bucket.
const TRUST_PROXY = process.env.SYSDECK_TRUST_PROXY === '1'

function bucket(key: string, now = Date.now()): Bucket {
  let b = failBuckets.get(key)
  if (!b || now - b.windowStart > FAIL_WINDOW_MS) {
    if (failBuckets.size > 1024) {
      for (const [k, x] of failBuckets) {
        if (now - x.windowStart > FAIL_WINDOW_MS) failBuckets.delete(k)
      }
    }
    b = { windowStart: now, failures: 0 }
    failBuckets.set(key, b)
  }
  return b
}

function clientIp(req: Request): string {
  const fwd = TRUST_PROXY ? req.headers.get('x-forwarded-for') : null
  if (fwd) return fwd.split(',')[0].trim()
  return 'local'
}

async function audit(action: string, detail: string, actor: string): Promise<void> {
  try {
    await db.auditLog.create({ data: { module: 'web', action, detail, actor } })
  } catch (err) {
    console.error(`[auth] audit write failed for ${action}:`, err)
  }
}

export async function POST(req: Request) {
  const ip = clientIp(req)

  const contentLength = Number(req.headers.get('content-length') ?? '0')
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'request body too large' }, { status: 413 })
  }
  let body: { username?: unknown; password?: unknown }
  try {
    const raw = await req.text()
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: 'request body too large' }, { status: 413 })
    }
    body = raw ? JSON.parse(raw) : {}
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
  }

  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''

  if (!validUsername(username) || password.length === 0) {
    await audit('login-failed', `ip ${ip} · malformed credentials`, 'anonymous')
    return NextResponse.json({ ok: false, error: 'incorrect username or password' }, { status: 401 })
  }

  // per-IP and per-username lockout — same shape the sshd stack applies
  const ipBucket = bucket(`ip:${ip}`)
  const userBucket = bucket(`user:${username.toLowerCase()}`)
  if (ipBucket.failures >= MAX_FAILURES || userBucket.failures >= MAX_FAILURES) {
    const wait = Math.max(
      Math.ceil(
        (Math.max(ipBucket.windowStart, userBucket.windowStart) + FAIL_WINDOW_MS - Date.now()) / 1000,
      ),
      1,
    )
    return NextResponse.json(
      { ok: false, error: `too many failed attempts — try again in ${wait}s` },
      { status: 429, headers: { 'Retry-After': String(wait) } },
    )
  }

  const fail = async (reason: string) => {
    // never log the attempted secret — only where it came from
    ipBucket.failures += 1
    userBucket.failures += 1
    await audit('login-failed', `ip ${ip} · ${reason}`, username)
    return NextResponse.json({ ok: false, error: 'incorrect username or password' }, { status: 401 })
  }

  // ── authenticate, in policy order ───────────────────────────────────
  //   pam        → host PAM only (cockpit-faithful; needs root, or
  //                unix_chkpwd covers just the invoking uid)
  //   local      → SdUser scrypt table only
  //   pam+local  → PAM first, SdUser as the fallback for installs the
  //                PAM path cannot serve (non-root service uid)
  const mode = authMode()
  const pamAllowed = mode !== 'local'
  const localAllowed = mode !== 'pam'
  let via: 'pam' | 'local' | null = null

  // boot-path convenience: ensure the local store exists when it is
  // part of this install's policy (in-process once, cheap count)
  if (localAllowed) await seedDefaultLocalAccount()

  if (pamAllowed) {
    const { viable, reason: why } = pamViable()
    if (viable) {
      const res = await authenticateViaPam(username, password)
      if (res.ok) {
        via = 'pam'
      } else if (res.reason === 'auth-failed') {
        // PAM answered definitively — wrong password for a unix account.
        // local (pam+local) still gets a say below.
      } else {
        // helper ran but wedged (timeout / protocol error) — fail CLOSED,
        // never silently fall back: a wedged PAM is a health incident.
        console.error(`[auth] pam helper problem: ${res.reason}`)
        return fail(`pam ${res.reason}`)
      }
    } else if (!localAllowed) {
      // pam-only install with a broken helper — say so: it's a setup
      // bug, not a credential mistake
      return NextResponse.json(
        { ok: false, error: `PAM unavailable (${why}) — see web/README.md §login` },
        { status: 503 },
      )
    }
    // helper not viable + local allowed → straight to the local store
  }

  if (via === null && localAllowed) {
    const local = await authenticateLocal(username, password)
    if (local) via = 'local'
  }

  if (via === null) return fail('no store accepted')

  // ── success: reset both failure windows, mint the user-bound session
  ipBucket.failures = 0
  userBucket.failures = 0
  const { token, expiresAt } = await createSessionToken(username)
  const profile = await consoleUser(username)
  if (via === 'local') await touchLocalLogin(username, ip)
  await audit('login', `ip ${ip} · via ${via} · session ${SESSION_TTL_MS / 3600_000}h`, username)

  const res = NextResponse.json({
    ok: true,
    via,
    expiresAt,
    user: profile
      ? {
          username: profile.username,
          realname: profile.realname,
          isAdmin: profile.isAdmin,
          source: profile.source,
        }
      : { username, realname: null, isAdmin: false, source: 'local' as const },
  })
  res.cookies.set(AUTH_COOKIE, token, sessionCookieOptions())
  return res
}
