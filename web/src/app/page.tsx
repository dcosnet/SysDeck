// SysDeck web edition — page-level session gate (v0.4.0).
//
// The unix-account login: a server-rendered check of the sd_session
// cookie decides what reaches the browser — the login screen or the
// full shell. Signing in (POST /api/auth/login, verified by the host's
// PAM stack) sets the HttpOnly cookie bound to the username and
// reloads; signing out clears it. Every /api/* route enforces the same
// session (see requireSession in session.ts), and the fester
// mini-service verifies the identical token straight from the shared
// SQLite secret.
import { currentSession } from '@/lib/sysdeck/session'
import {
  authMode,
  consoleUser,
  hasDefaultPasswordAccount,
  hostIdentity,
  legacyUser,
  seedDefaultLocalAccount,
} from '@/lib/sysdeck/users'
import { pamViable } from '@/lib/sysdeck/pam'
import { LoginScreen } from '@/components/sysdeck/login-screen'
import { SysDeckShell } from '@/components/sysdeck/shell'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const session = await currentSession()

  if (!session) {
    const host = hostIdentity()
    const mode = authMode()
    const pam = pamViable()
    if (mode !== 'pam') await seedDefaultLocalAccount().catch(() => undefined)
    const usingDefault = mode !== 'pam' ? await hasDefaultPasswordAccount().catch(() => false) : false
    return (
      <LoginScreen
        hostname={host.hostname}
        authMode={mode}
        pamAvailable={pam.viable}
        usingDefault={usingDefault}
      />
    )
  }

  const user = session.user ? ((await consoleUser(session.user)) ?? legacyUser()) : legacyUser()
  return <SysDeckShell sessionUser={user} sessionExpiresAt={session.expiresAt} />
}
