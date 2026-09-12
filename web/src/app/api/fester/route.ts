// Fester sub-app server-side proxy — the only sanctioned path from the
// browser to the fester mini-service REST surface (port 3010).
//
// Browser contract (keeps the browser on relative URLs only):
//   POST /api/fester        { path: '/api/builds', method?: 'GET'|'POST', body?: object }
//     → fetches http://127.0.0.1:3010${path} with method/body, 4s timeout,
//       and streams back the upstream JSON + status verbatim.
//   GET  /api/fester        → proxy of the fester service health endpoint.
//
// The browser WebSocket goes DIRECT (never through this route):
//   new WebSocket(`${ws|wss}://${location.host}/?XTransformPort=3010`)
import { NextResponse } from 'next/server'
import { mintServerCookie, requireSession } from '@/lib/sysdeck/session'

export const dynamic = 'force-dynamic'

const UPSTREAM = 'http://127.0.0.1:3010'
const TIMEOUT_MS = 4000

/** Guard: only /api/… paths, no traversal, no foreign schemes, sane length. */
function safePath(p: unknown): string | null {
  if (typeof p !== 'string') return null
  if (!p.startsWith('/api/')) return null
  if (p.length > 512) return null
  if (p.includes('..') || p.includes('\\') || p.includes('\0')) return null
  // RFC 3986 pchar + '/' — rejects anything the fester router would never use
  if (!/^[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]+$/.test(p)) return null
  return p
}

/** Shared upstream fetch — returns the upstream JSON body + status verbatim.
 *  Carries a minted short-lived session cookie: the route's own gate has
 *  already verified the caller, and fester independently verifies the
 *  same HMAC token on its side of the loopback hop. */
async function proxyFetch(path: string, method: 'GET' | 'POST', body?: unknown): Promise<NextResponse> {
  try {
    const res = await fetch(`${UPSTREAM}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: await mintServerCookie() },
      body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
    const text = await res.text()
    return new NextResponse(text === '' ? JSON.stringify({ ok: false, error: 'empty upstream body' }) : text, {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `fester service unreachable on 127.0.0.1:3010 (${err instanceof Error ? err.message : String(err)})`,
      },
      { status: 502 },
    )
  }
}

export async function POST(req: Request) {
  const denied = await requireSession(req)
  if (denied) return denied

  let payload: { path?: unknown; method?: unknown; body?: unknown }
  try {
    payload = (await req.json()) as typeof payload
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
  }

  const path = safePath(payload.path)
  if (!path) {
    return NextResponse.json({ ok: false, error: 'path is required and must start with /api/' }, { status: 403 })
  }

  const method = payload.method === undefined || payload.method === null ? 'GET' : payload.method
  if (method !== 'GET' && method !== 'POST') {
    return NextResponse.json({ ok: false, error: "method must be 'GET' or 'POST'" }, { status: 403 })
  }

  return proxyFetch(path, method as 'GET' | 'POST', payload.body)
}

export async function GET(req: Request) {
  const denied = await requireSession(req)
  if (denied) return denied

  return proxyFetch('/api/health', 'GET')
}
