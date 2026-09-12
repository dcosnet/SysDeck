// GET /api/auth/session — session probe (intentionally unauthenticated).
//
// Tells the client whether a valid session cookie is present, WHICH
// unix account it is bound to (v0.4.0), when it expires, and which
// auth policy the console is running — so the login screen can label
// itself honestly before the first sign-in. No secrets cross the wire:
// the token itself is HttpOnly.
import { NextResponse } from 'next/server'
import { tokenFromCookieHeader, verifySessionToken } from '@/lib/sysdeck/session'
import { authMode, consoleUser, hasDefaultPasswordAccount, hostIdentity } from '@/lib/sysdeck/users'
import { pamViable } from '@/lib/sysdeck/pam'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const info = await verifySessionToken(tokenFromCookieHeader(req.headers.get('cookie')))
  const mode = authMode()
  const pam = pamViable()
  let user: Awaited<ReturnType<typeof consoleUser>> = null
  if (info?.user) user = await consoleUser(info.user)

  return NextResponse.json({
    ok: true,
    authenticated: info !== null,
    expiresAt: info?.expiresAt,
    legacy: info?.version === 1,
    user: user
      ? {
          username: user.username,
          realname: user.realname,
          isAdmin: user.isAdmin,
          source: user.source,
          uid: user.uid,
        }
      : info?.user
        ? { username: info.user, realname: null, isAdmin: false, source: 'local', uid: null }
        : null,
    // login-screen labeling (all pre-auth public facts on a LAN console)
    authMode: mode,
    pamAvailable: pam.viable,
    usingDefault:
      mode !== 'pam' ? await hasDefaultPasswordAccount().catch(() => false) : false,
    host: hostIdentity(),
  })
}
