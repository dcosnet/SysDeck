import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { BRIDGE_MODULES } from '@/lib/sysdeck/bridge'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  let body: { module?: string; command?: string; args?: Record<string, unknown> }
  try {
    body = await req.json()
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
    // Commands may return {data, source, note} or plain data.
    if (
      out &&
      typeof out === 'object' &&
      ('data' in (out as Record<string, unknown>) || 'source' in (out as Record<string, unknown>)) &&
      'ok' in (out as Record<string, unknown>)
    ) {
      return NextResponse.json({ ...(out as object), module: modName, command })
    }
    return NextResponse.json({ ok: true, data: out, module: modName, command })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        module: modName,
        command,
      },
      { status: 200 },
    )
  }
}

// Health probe for the shell: confirms the bridge dispatcher + db client are alive.
export async function GET() {
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
    version: '0.2.0',
  })
}
