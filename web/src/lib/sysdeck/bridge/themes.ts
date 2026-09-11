// SysDeck bridge — themes
// Theme engine port: themes registry + active theme persisted to
// ThemeSetting (the web edition's equivalent of /etc/sysdeck/theme).
import { db } from '@/lib/db'
import { ok, fail } from './shared'

const THEME_KEY = 'active'

export const THEMES: { id: string; name: string; description: string }[] = [
  { id: 'midnight', name: 'Midnight', description: 'The SysDeck default console — deep slate with a teal edge.' },
  { id: 'carbon', name: 'Carbon', description: 'Near-black monochrome for dim control rooms.' },
  { id: 'phosphor', name: 'Phosphor', description: 'Green CRT phosphor terminal nostalgia.' },
  { id: 'amber', name: 'Amber', description: 'Amber CRT terminal — warm and low-glare.' },
  { id: 'paper', name: 'Paper', description: 'Light reading theme for documentation runs.' },
  { id: 'arctic', name: 'Arctic', description: 'Cool light theme with a blue-teal accent.' },
]

async function readActive(): Promise<string> {
  const row = await db.themeSetting.findUnique({ where: { key: THEME_KEY } })
  if (row && THEMES.some((t) => t.id === row.value)) return row.value
  return 'midnight'
}

export const commands = {
  list: async () => ok({ themes: THEMES, active: await readActive() }, 'live'),

  getActive: async () => ok(await readActive(), 'live'),

  setActive: async (args: Record<string, unknown>) => {
    const theme = String(args.theme ?? '')
    if (!THEMES.some((t) => t.id === theme)) {
      return fail(`unknown theme: ${theme}`)
    }
    await db.themeSetting.upsert({
      where: { key: THEME_KEY },
      create: { key: THEME_KEY, value: theme },
      update: { value: theme },
    })
    return ok({ active: theme }, 'live')
  },
}
