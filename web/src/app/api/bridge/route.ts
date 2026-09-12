import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { BRIDGE_MODULES } from '@/lib/sysdeck/bridge'
import { requireSession } from '@/lib/sysdeck/session'

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
  // Behind the local port gateway the forwarding headers are set; a
  // direct connection has no X-Forwarded-For, so fall back to 'local'.
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return 'local'
}

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
  try {
    const out = await handler(args)
    // Commands may return {data, source, note} envelopes, plain data, or
    // the {ok:false, error} envelope from fail() — the error envelope
    // passes through top-level so panels see command-level failures.
    if (
      out &&
      typeof out === 'object' &&
      ('data' in (out as Record<string, unknown>) ||
        'source' in (out as Record<string, unknown>) ||
        'error' in (out as Record<string, unknown>)) &&
      'ok' in (out as Record<string, unknown>)
    ) {
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
    version: '0.4.1',
  })
}
