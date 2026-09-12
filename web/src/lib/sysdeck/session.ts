// SysDeck web edition — unix-account session gate (server-only, v0.4.0).
//
// v0.4.0 replaces the 0.3.1 shared password with the login model
// Cockpit uses: sign in with a UNIX ACCOUNT (verified by the host's
// PAM stack — see scripts/pam-auth.py), exchange the credentials for
// a signed session cookie that is BOUND TO THE USERNAME.
//
//   login      username + password → PAM (host account system) or, in
//              local / pam+local modes, the SdUser SQLite table
//              (scrypt). Route: /api/auth/login.
//   session    cookie 'sd_session' =
//                v2: 'v2.<expMs>.<userB64url>.<hmac-sha256>'
//                v1: 'v1.<expMs>.<hmac-sha256>'   (pre-0.4.0 legacy)
//              HMAC key = random 32 bytes, generated once per install
//              and persisted in SdKv (web.session.secret) so sessions
//              survive restarts and the fester mini-service verifies
//              the identical token straight out of the same SQLite
//              file — the live WebSocket event stream is gated too.
//   lifetime   12h absolute; login/logout audited to AuditLog with the
//              unix username as actor; failed logins rate limited per
//              IP *and* per username in the login route.
//
// The v1 format still verifies (as a legacy "operator" session) so a
// restart across the 0.3.1 → 0.4.0 upgrade does not log anybody out —
// the 0.3.1 README promised exactly that.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const AUTH_COOKIE = 'sd_session'
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12h absolute
const SECRET_KEY = 'web.session.secret'

export interface SessionInfo {
  expiresAt: number
  /** Bound unix/local account name; null on legacy v1 tokens. */
  user: string | null
  version: 1 | 2
}

let secretCache: { value: string; readAt: number } | null = null

/** HMAC key — get-or-create, one random 32-byte hex value per install.
 *  Cached in-process for 60s: every gated request re-verifies the HMAC,
 *  so the key read must not cost a DB round-trip each time. */
async function sessionSecret(): Promise<string> {
  const now = Date.now()
  if (secretCache && now - secretCache.readAt < 60_000) return secretCache.value
  const existing = await db.sdKv.findUnique({ where: { key: SECRET_KEY } })
  if (existing?.value) {
    secretCache = { value: existing.value, readAt: now }
    return existing.value
  }
  const secret = randomBytes(32).toString('hex')
  try {
    // update:{} keeps a concurrent winner's value if we lost the race
    await db.sdKv.upsert({
      where: { key: SECRET_KEY },
      create: { key: SECRET_KEY, value: secret },
      update: {},
    })
  } catch {
    // lost a create race — fall through and re-read
  }
  const winner = await db.sdKv.findUnique({ where: { key: SECRET_KEY } })
  const value = winner?.value ?? secret
  secretCache = { value, readAt: now }
  return value
}

function hmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

function b64u(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

function unb64u(input: string): string | null {
  try {
    return Buffer.from(input, 'base64url').toString('utf8')
  } catch {
    return null
  }
}

/**
 * Mint a fresh session token bound to a username; returns the cookie
 * value + expiry epoch ms. Username null → legacy v1 shape (used only
 * by the v1 back-compat path, never minted fresh after 0.4.0).
 */
export async function createSessionToken(
  username: string,
  ttlMs = SESSION_TTL_MS,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Date.now() + ttlMs
  const body = `v2.${expiresAt}.${b64u(username)}`
  return { token: `${body}.${hmac(body, await sessionSecret())}`, expiresAt }
}

/** Constant-time compare over equal-length ASCII hex. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/**
 * Verify a session token (v2 user-bound or legacy v1). Returns the
 * session info, or null when the token is malformed, expired, or
 * signed with a different key.
 */
export async function verifySessionToken(token: string | undefined | null): Promise<SessionInfo | null> {
  if (!token) return null
  const parts = token.split('.')
  const secret = await sessionSecret()

  // v2: 'v2.<expMs>.<userB64url>.<hmac>'
  if (parts.length === 4 && parts[0] === 'v2') {
    const expiresAt = Number(parts[1])
    if (!Number.isFinite(expiresAt) || String(expiresAt) !== parts[1]) return null
    if (expiresAt < Date.now()) return null
    const user = unb64u(parts[2])
    if (user === null || user.length === 0 || user.length > 64) return null
    const expected = hmac(`v2.${parts[1]}.${parts[2]}`, secret)
    if (!sameHex(parts[3], expected)) return null
    return { expiresAt, user, version: 2 }
  }

  // v1 (0.3.1 shared-password session): 'v1.<expMs>.<hmac>'
  if (parts.length === 3 && parts[0] === 'v1') {
    const expiresAt = Number(parts[1])
    if (!Number.isFinite(expiresAt) || String(expiresAt) !== parts[1]) return null
    if (expiresAt < Date.now()) return null
    const expected = hmac(`v1.${parts[1]}`, secret)
    if (!sameHex(parts[2], expected)) return null
    return { expiresAt, user: null, version: 1 }
  }

  return null
}

/** Pull the sd_session value out of a raw Cookie header (route handlers). */
export function tokenFromCookieHeader(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === AUTH_COOKIE) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** Route-handler check: the session's username (or null). */
export async function sessionUserFor(req: Request): Promise<string | null> {
  const info = await verifySessionToken(tokenFromCookieHeader(req.headers.get('cookie')))
  return info?.user ?? null
}

/** Route-handler check: is the request carrying a valid session? */
export async function isRequestAuthed(req: Request): Promise<boolean> {
  return (await verifySessionToken(tokenFromCookieHeader(req.headers.get('cookie')))) !== null
}

/**
 * API-route guard: null when the session is valid, else a ready-to-return
 * 401 envelope. Usage:
 *   const denied = await requireSession(req); if (denied) return denied
 */
export async function requireSession(req: Request): Promise<NextResponse | null> {
  if (await isRequestAuthed(req)) return null
  return NextResponse.json(
    { ok: false, error: 'authentication required (sign in first)', auth: AUTH_COOKIE },
    { status: 401 },
  )
}

/** Page-level check: reads cookies() from next/headers (App Router). */
export async function currentSession(): Promise<SessionInfo | null> {
  const store = await cookies()
  return verifySessionToken(store.get(AUTH_COOKIE)?.value)
}

/** Cookie attributes for the session — HttpOnly, Lax, path=/. */
export function sessionCookieOptions(maxAgeSec = Math.floor(SESSION_TTL_MS / 1000)) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSec,
    // LAN-side consoles run plain http on the LAN; front it with TLS and
    // opt into the Secure flag with SYSDECK_SESSION_SECURE=1.
    secure: process.env.SYSDECK_SESSION_SECURE === '1',
  }
}

/**
 * Mint a short-lived session cookie VALUE for server-to-server hops —
 * the web app's own probes of the fester REST surface (which verifies
 * the identical token). Returns a ready `sd_session=…` string for a
 * Cookie header; 90s lifetime keeps the exposure window negligible
 * and the traffic never leaves loopback.
 */
export async function mintServerCookie(ttlMs = 90_000): Promise<string> {
  const { token } = await createSessionToken('sysdeck-internal', ttlMs)
  return `${AUTH_COOKIE}=${token}`
}
