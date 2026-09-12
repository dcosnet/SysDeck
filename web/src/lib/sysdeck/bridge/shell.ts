// SysDeck bridge — shell
// Web-shell module visibility toggles: any module can be turned OFF in
// the sidebar (hidden from navigation + the command palette) and back
// ON from the sidebar's "Disabled" section. Persisted in SdKv
// (shell.disabled = JSON array of module ids) so toggles survive
// restarts, and audited like every other operator action.
//
// The motivating case: "it should be easy to toggle this ai gateway on
// or off in case i decide to use something like pi" — a disabled module
// stops being offered anywhere in the shell while its bridge commands
// stay available for scripts (only navigation is toggled, not access).
//
// 'overview' is protected: it is the landing view and always enabled.
import { db } from '@/lib/db'
import { ok, fail } from './shared'
import { MODULE_MAP } from '../registry'

const KEY = 'shell.disabled'
const PROTECTED = ['overview']

async function readDisabled(): Promise<string[]> {
  const row = await db.sdKv.findUnique({ where: { key: KEY } })
  if (!row) return []
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return []
    // defensive: drop unknown ids (registry may have changed)
    return parsed.filter((id): id is string => typeof id === 'string' && Boolean(MODULE_MAP[id]))
  } catch {
    return []
  }
}

async function writeDisabled(ids: string[]): Promise<void> {
  const value = JSON.stringify([...ids].sort())
  await db.sdKv.upsert({
    where: { key: KEY },
    create: { key: KEY, value },
    update: { value },
  })
}

export const commands = {
  toggles: async () =>
    ok(
      { disabled: await readDisabled() },
      'live',
      'module visibility toggles — persisted in SQLite (SdKv shell.disabled); a disabled module is hidden from the sidebar and command palette until re-enabled. Overview is protected',
    ),

  setToggle: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    const enabled = args.enabled !== false // default true
    if (!MODULE_MAP[id]) return fail(`unknown module: ${id}`)
    if (PROTECTED.includes(id)) {
      return fail(`module '${id}' is protected (the landing view) and cannot be disabled`)
    }
    const disabled = new Set(await readDisabled())
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    const next = [...disabled].sort()
    await writeDisabled(next)
    await db.auditLog.create({
      data: {
        module: 'shell',
        action: enabled ? 'module-enable' : 'module-disable',
        detail: `${id} — ${MODULE_MAP[id].name}`,
      },
    })
    return ok({ id, enabled, disabled: next }, 'live')
  },

  resetToggles: async () => {
    await writeDisabled([])
    await db.auditLog.create({
      data: { module: 'shell', action: 'module-reset', detail: 'all module visibility toggles restored' },
    })
    return ok({ disabled: [] }, 'live')
  },
}
