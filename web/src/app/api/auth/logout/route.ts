// POST /api/auth/logout — clear the session cookie and audit the sign-out.
// v0.4.0: the audit entry carries the unix account the session belonged to.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AUTH_COOKIE, isRequestAuthed, sessionCookieOptions, sessionUserFor } from '@/lib/sysdeck/session'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  // clearing an absent session is fine — just don't audit no-ops
  if (await isRequestAuthed(req)) {
    const user = (await sessionUserFor(req)) ?? 'operator'
    try {
      await db.auditLog.create({
        data: { module: 'web', action: 'logout', detail: 'session cleared at the console', actor: user },
      })
    } catch (err) {
      console.error('[auth] audit write failed for logout:', err)
    }
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set(AUTH_COOKIE, '', sessionCookieOptions(0)) // maxAge 0 → delete
  return res
}
