// GET /api — tiny authed index for the web edition's API surface.
// (Cockpit-style login gate applies here too: 401 until signed in.)
import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/sysdeck/session'
import { SYSDECK_VERSION } from '@/lib/sysdeck/registry'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const denied = await requireSession(req)
  if (denied) return denied

  return NextResponse.json({
    ok: true,
    service: 'sysdeck-web',
    version: SYSDECK_VERSION,
    auth: 'POST /api/auth/login {password}',
  })
}
