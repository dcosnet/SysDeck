import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { BRIDGE_MODULES } from '@/lib/sysdeck/bridge'
import { isMutation } from '@/lib/sysdeck/bridge/mutations'
import { SYSDECK_VERSION } from '@/lib/sysdeck/registry'
import { currentSession, requireSession } from '@/lib/sysdeck/session'
import { consoleUser } from '@/lib/sysdeck/users'

export const dynamic = 'force-dynamic'

// ── v0.4.0 unix-account session gate (cockpit-style) ────────────────
// This console is a personal, LAN-side dashboard. As of 0.4.0 the
// surface is gated by the unix-account session cookie (host-PAM login,
// see /api/auth/login + src/lib/sysdeck/session.ts); the guards below are
// the accidental-exposure backstops kept from 0.3.0: a request body
// cap (JSON args are tiny; anything bigger is abuse) and a per-IP
// token bucket for DoS — the real boundary remains loopback binding
// (see the web README "Security" section).
const MAX_BODY_BYTES = 256 * 1024 // 256 KB
const RATE_WINDOW_MS = 10_000
const RATE_MAX = 240 // 24 req/s sustained — panels poll every 5-30s

// X-Forwarded-For defines rate-limit identity only when the operator
// opts in — a client-supplied header must never shape limits on a
// loopback-bound console. Direct connections share the 'local' bucket.
const TRUST_PROXY = process.env.SYSDECK_TRUST_PROXY === '1'

const rateBuckets = new Map<string, { windowStart: number; count: number }>()

function rateLimited(ip: string, now = Date.now()): boolean {
  let bucket = rateBuckets.get(ip)
  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 }
    rateBuckets.set(ip, bucket)
    // opportunistic GC: drop expired buckets once the map grows
    if (rateBuckets.size > 512) {
      for (const [key, b] of rateBuckets) {
        if (now - b.windowStart > RATE_WINDOW_MS) rateBuckets.delete(key)
      }
    }
  }
  bucket.count += 1
  return bucket.count > RATE_MAX
}

function clientIp(req: Request): string {
  const fwd = TRUST_PROXY ? req.headers.get('x-forwarded-for') : null
  if (fwd) return fwd.split(',')[0].trim()
  return 'local'
}

// Mutation policy: 'admin' (default) gates the mutation registry behind
// an admin session; 'any' restores the single-operator posture for
// consoles where every login IS the operator.
const MUTATIONS_REQUIRE_ADMIN = process.env.SYSDECK_MUTATIONS !== 'any'

export async function POST(req: Request) {
  const denied = await requireSession(req)
  if (denied) return denied

  if (rateLimited(clientIp(req))) {
    return NextResponse.json({ ok: false, error: 'rate limit exceeded' }, { status: 429 })
  }
  // Cap the body before parsing: req.json() buffers whatever arrives.
  const contentLength = Number(req.headers.get('content-length') ?? '0')
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: 'request body too large' }, { status: 413 })
  }
  let body: { module?: string; command?: string; args?: Record<string, unknown> }
  try {
    const raw = await req.text()
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: 'request body too large' }, { status: 413 })
    }
    body = raw ? JSON.parse(raw) : {}
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
  }

  const modName = body.module?.trim()
  const command = body.command?.trim()
  if (!modName || !command) {
    return NextResponse.json(
      { ok: false, error: 'module and command are required' },
      { status: 400 },
    )
  }

  // Guards: module must be registered; command must be declared in its
  // COMMANDS map — same contract the python bridge enforces per-file.
  const mod = BRIDGE_MODULES[modName] as
    | { commands: Record<string, (args: Record<string, unknown>) => Promise<unknown>> }
    | undefined
  if (!mod) {
    return NextResponse.json({ ok: false, error: `unknown module: ${modName}` }, { status: 404 })
  }
  const handler = mod.commands[command]
  if (!handler) {
    return NextResponse.json(
      { ok: false, error: `unknown command: ${modName}.${command}` },
      { status: 404 },
    )
  }

  const args = body.args ?? {}

  // ── mutation authorization (cockpit-shaped) ─────────────────────────
  // Any signed-in unix account may look; commands that change operator
  // state or the host require an admin session. The OS boundary (root /
  // sudo -n with honest refusal) remains the enforcement of last resort.
  if (MUTATIONS_REQUIRE_ADMIN && isMutation(modName, command)) {
    const session = await currentSession()
    const user = session?.user
    const profile = user ? await consoleUser(user) : null
    if (!profile?.isAdmin) {
      return NextResponse.json(
        {
          ok: false,
          error: `${modName}.${command} requires an admin session (wheel/sudo/adm or uid 0) — sign in as an admin, or set SYSDECK_MUTATIONS=any for the single-operator posture`,
          module: modName,
          command,
        },
        { status: 403 },
      )
    }
  }

  try {
    const out = await handler(args)
    // Envelope contract: handlers return a BridgeResponse — an object
    // with a boolean `ok` key — or plain data, which is wrapped. The
    // boolean type check keeps plain data models that happen to carry an
    // `ok` field from being misread as envelopes.
    if (out && typeof out === 'object' && 'ok' in (out as Record<string, unknown>) && typeof (out as Record<string, unknown>).ok === 'boolean') {
      return NextResponse.json({ ...(out as object), module: modName, command })
    }
    return NextResponse.json({ ok: true, data: out, module: modName, command })
  } catch (err) {
    // Unexpected exceptions can carry absolute server paths / library
    // internals (ENOENT on /home/..., prisma engine paths). Log the full
    // detail server-side; give the client a stable, generic message.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error(`[bridge] ${modName}.${command} failed: ${detail}`)
    return NextResponse.json(
      {
        ok: false,
        error: `${modName}.${command} failed on the server (see server log)`,
        module: modName,
        command,
      },
      { status: 200 },
    )
  }
}

// Health probe for the shell: confirms the bridge dispatcher + db client are alive.
export async function GET(req: Request) {
  const denied = await requireSession(req)
  if (denied) return denied

  let dbOk = true
  try {
    await db.sdKv.count()
  } catch {
    dbOk = false
  }
  return NextResponse.json({
    ok: true,
    db: dbOk,
    modules: Object.keys(BRIDGE_MODULES).length,
    version: SYSDECK_VERSION,
  })
}
