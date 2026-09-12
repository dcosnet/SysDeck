'use client'

// SysDeck — unix-account login screen (v0.4.1).
//
// The cockpit login, wearing the console's own identity: the HOST is
// the headline (hostname + OS, exactly what cockpit shows on its login
// card), the credentials are a Unix username + password verified by
// the host's PAM stack, and the session that comes back is bound to
// that account. The scene behind the card is the midnight/teal
// identity the Themes engine ships — aurora blooms, grid, vignette —
// so the first thing an operator sees is the same console they'll use.
import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { applySdTheme } from '@/lib/sysdeck/theme'
import {
  ArrowRight,
  CheckCircle2,
  Loader2,
  LockKeyhole,
  Server,
  ShieldCheck,
  TriangleAlert,
  User as UserIcon,
  Waves,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export interface LoginScreenProps {
  hostname: string
  authMode: 'pam' | 'local' | 'pam+local'
  pamAvailable: boolean
  usingDefault: boolean
}

export function LoginScreen({ hostname, authMode, pamAvailable, usingDefault }: LoginScreenProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [capsLock, setCapsLock] = useState(false)
  const [shakeKey, setShakeKey] = useState(0)
  const userRef = useRef<HTMLInputElement>(null)
  const passRef = useRef<HTMLInputElement>(null)

  // wear the operator's persisted theme (the bridge is session-gated,
  // so the login screen reads the localStorage mirror the shell keeps)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('sd_theme')
      if (saved) applySdTheme(saved)
    } catch {
      /* default theme is fine */
    }
    userRef.current?.focus()
  }, [])

  const advance = useCallback(() => {
    if (username.trim()) passRef.current?.focus()
  }, [username])

  const onUserKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      advance()
    }
  }

  // caps-lock is the classic silent login failure — surface it live
  const trackCaps = (e: KeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === 'function') setCapsLock(e.getModifierState('CapsLock'))
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (res.ok && data.ok) {
        // full reload: the page-level gate re-renders the server side
        // and the shell mounts with a fresh, clean query state
        window.location.reload()
        return
      }
      setError(data.error ?? `sign-in failed (HTTP ${res.status})`)
      setShakeKey((k) => k + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'network error')
      setShakeKey((k) => k + 1)
    } finally {
      setPending(false)
    }
  }

  const modeLabel =
    authMode === 'pam'
      ? pamAvailable
        ? 'Unix accounts · host PAM'
        : 'Unix accounts · PAM helper missing'
      : authMode === 'local'
        ? 'Console accounts · local store'
        : 'Unix accounts · PAM + local fallback'

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* ambient scene — aurora blooms, grid, vignette (all theme-var driven) */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="sd-login-aurora" />
        <div className="absolute inset-0 sd-grid-bg opacity-40" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,transparent_55%,var(--background)_100%)]" />
        {/* horizon line — a faint teal edge under the card */}
        <div className="absolute inset-x-0 top-1/2 h-px bg-gradient-to-r from-transparent via-primary/25 to-transparent" />
      </div>

      <main className="relative z-10 flex flex-1 items-center justify-center px-4 py-10">
        <section
          aria-labelledby="sd-login-title"
          key={shakeKey}
          className={cn(
            'sd-login-card w-full max-w-sm overflow-hidden rounded-xl border border-border',
            'bg-card/85 shadow-2xl shadow-black/40 backdrop-blur-xl',
            shakeKey > 0 && 'sd-shake-once',
          )}
        >
          {/* top edge highlight — the fester tell: a 1px gradient seam */}
          <div aria-hidden className="h-px w-full bg-gradient-to-r from-transparent via-primary/60 to-transparent" />

          {/* host identity — what cockpit leads its login with */}
          <header className="flex items-center gap-2.5 border-b border-border/70 px-6 py-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30 sd-glow">
              <Waves className="h-5 w-5 text-primary" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs font-medium text-foreground" title={hostname}>
                {hostname}
              </p>
              <a
                href="http://dcos.net/"
                target="_blank"
                rel="noreferrer"
                className="block truncate font-mono text-[10px] text-muted-foreground transition-colors hover:text-primary"
                title="dcos.net"
              >
                dcos.net
              </a>
            </div>
            <Server className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
          </header>

          <div className="px-6 pb-6 pt-5">
            <h1 id="sd-login-title" className="text-base font-semibold tracking-tight">
              Sign in to the console
            </h1>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className={cn('h-3.5 w-3.5', pamAvailable || authMode !== 'pam' ? 'text-primary' : 'text-amber-500')} aria-hidden />
              {modeLabel}
            </p>

            <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="sd-username" className="gap-1.5">
                  <UserIcon className="h-3 w-3 text-muted-foreground" aria-hidden />
                  Unix account
                </Label>
                <Input
                  id="sd-username"
                  ref={userRef}
                  type="text"
                  name="username"
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value)
                    if (error) setError(null)
                  }}
                  onKeyDown={onUserKey}
                  disabled={pending}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? 'sd-login-error' : undefined}
                  placeholder="operator"
                  className="font-mono"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="sd-password" className="gap-1.5">
                  <LockKeyhole className="h-3 w-3 text-muted-foreground" aria-hidden />
                  Password
                </Label>
                <Input
                  id="sd-password"
                  ref={passRef}
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    if (error) setError(null)
                  }}
                  onKeyUp={trackCaps}
                  disabled={pending}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? 'sd-login-error' : capsLock ? 'sd-caps-lock' : undefined}
                  placeholder="••••••••"
                  className="font-mono"
                />
                {capsLock ? (
                  <p id="sd-caps-lock" role="status" className="flex items-center gap-1.5 text-[11px] text-amber-500 dark:text-amber-400">
                    <TriangleAlert className="h-3 w-3" aria-hidden />
                    Caps Lock is on
                  </p>
                ) : null}
              </div>

              {error ? (
                <p
                  id="sd-login-error"
                  role="alert"
                  className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400"
                >
                  {error}
                </p>
              ) : null}

              <Button
                type="submit"
                disabled={pending || username.trim().length === 0 || password.length === 0}
                className="group w-full gap-2 font-medium"
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                )}
                {pending ? 'Authenticating…' : 'Sign in'}
              </Button>
            </form>

            {usingDefault ? (
              <div
                role="status"
                className={cn(
                  'mt-5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5',
                  'text-[11px] leading-relaxed text-amber-500 dark:text-amber-400',
                )}
              >
                <p className="font-semibold">Default password active</p>
                <p className="mt-0.5">
                  The seeded console account still accepts{' '}
                  <span className="font-mono">sysdeck</span> — rotate it with{' '}
                  <span className="font-mono">bun scripts/manage-users.mjs passwd &lt;user&gt;</span>{' '}
                  in <span className="font-mono">web/</span>.
                </p>
              </div>
            ) : null}
          </div>

          {/* provenance strip — what cockpit prints under its login */}
          <footer className="flex items-center gap-2 border-t border-border/70 bg-muted/30 px-6 py-2.5">
            <CheckCircle2 className="h-3 w-3 shrink-0 text-primary/70" aria-hidden />
            <p className="truncate font-mono text-[10px] leading-relaxed text-muted-foreground">
              LAN-side console · binds 127.0.0.1 · session 12h · {authMode === 'pam' ? 'PAM login stack' : authMode === 'local' ? 'local account store' : 'PAM + local'}
            </p>
          </footer>
        </section>
      </main>

      <footer className="relative z-10 mt-auto px-4 pb-6 pt-2">
        <p className="text-center font-mono text-[10px] leading-relaxed text-muted-foreground">
          Cockpit-style Unix login · accounts verified by the host PAM stack
        </p>
      </footer>
    </div>
  )
}
