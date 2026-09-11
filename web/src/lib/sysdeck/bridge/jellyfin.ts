// SysDeck bridge — jellyfin (demo media server)
// Port of bridge/jellyfin.py semantics: the cockpit edition surfaced the
// jellyfin systemd service state, port, web URL and libraries. No
// jellyfin daemon exists in this sandbox, so the web edition keeps the
// same surface over seeded MediaItem / MediaSession rows plus library
// aggregates in SdKv (full catalog counts: 2.1k movies, 2.4k series
// rows, 28k music tracks) — the item rows are a realistic sample.
import { db } from '@/lib/db'
import { ok, fail } from './shared'

const SOURCE = 'demo' as const
const NOTE = 'jellyfin daemon not present in sandbox — demo media inventory'

function failE(error: string) {
  return { ...fail(error), source: SOURCE }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'jellyfin', action, detail } })
}

// ── library aggregates (SdKv) + item samples (MediaItem) ────────────

interface Library {
  name: string
  kind: string
  items: number
  tracks?: number
  sizeMb: number
}

const LIBRARIES: Library[] = [
  { name: 'Movies', kind: 'movie', items: 2148, sizeMb: 1843200 },
  { name: 'TV Shows', kind: 'series', items: 2361, sizeMb: 3276800 },
  { name: 'Music', kind: 'music', items: 1, tracks: 28412, sizeMb: 430080 },
  { name: 'Photos', kind: 'photo', items: 304, sizeMb: 131072 },
]

const SAMPLE_MOVIES = [
  { title: 'Blade Runner 2049', year: 2017, sizeMb: 58432, note: '2160p HDR10 Dolby Vision remux' },
  { title: 'Dune: Part Two', year: 2024, sizeMb: 72704, note: '2160p HDR10+ remux' },
  { title: 'The Matrix', year: 1999, sizeMb: 51200, note: '2160p HDR remux' },
  { title: 'Interstellar', year: 2014, sizeMb: 18944, note: '1080p Blu-ray' },
  { title: 'Arrival', year: 2016, sizeMb: 15360, note: '1080p Blu-ray' },
  { title: 'Mad Max: Fury Road', year: 2015, sizeMb: 22016, note: '2160p HDR' },
  { title: '2001: A Space Odyssey', year: 1968, sizeMb: 17408, note: '1080p Blu-ray' },
  { title: 'Blade Runner (Final Cut)', year: 1982, sizeMb: 10240, note: '1080p Blu-ray' },
  { title: 'Sicario', year: 2015, sizeMb: 9216, note: '1080p Blu-ray' },
  { title: 'Ex Machina', year: 2014, sizeMb: 12288, note: '1080p Blu-ray' },
  { title: 'Her', year: 2013, sizeMb: 7168, note: '1080p Blu-ray' },
  { title: 'The Empire Strikes Back', year: 1980, sizeMb: 8960, note: '1080p Blu-ray (Despecialized)' },
]

const SAMPLE_SERIES = [
  { title: 'Severance', year: 2022, sizeMb: 46080, note: 'S1+S2 1080p' },
  { title: 'The Expanse', year: 2015, sizeMb: 96256, note: 'S1-S6 1080p' },
  { title: 'Andor', year: 2022, sizeMb: 51200, note: 'S1+S2 1080p' },
  { title: 'Better Call Saul', year: 2015, sizeMb: 88064, note: 'S1-S6 1080p' },
  { title: 'Dark', year: 2017, sizeMb: 40960, note: 'S1-S3 1080p' },
  { title: 'Foundation', year: 2021, sizeMb: 58368, note: 'S1+S2 1080p' },
  { title: 'The Bear', year: 2022, sizeMb: 14336, note: 'S1-S3 1080p' },
  { title: 'Shōgun', year: 2024, sizeMb: 52224, note: 'S1 1080p' },
]

const SAMPLE_PHOTOS = [
  { title: 'Iceland 2025', year: 2025, sizeMb: 2048, note: '402 RAW + timelapse' },
  { title: 'Studio portraits', year: 2024, sizeMb: 1024, note: 'portfolio selects' },
  { title: 'Family archive 1990s', year: 1994, sizeMb: 4096, note: 'scanned negatives' },
  { title: 'Aurora timelapse', year: 2025, sizeMb: 6144, note: '4K prores' },
]

// session transport methods (MediaSession rows carry user/device/item/
// state; the play method lives here so summary can count transcodes).
// Keyed by user so re-seeds can't orphan entries.
const SESSION_METHODS: Record<string, { method: string; detail: string }> = {
  default: { method: 'direct', detail: 'direct play 1080p' },
}

async function ensureSeeded(): Promise<void> {
  // concurrency-safe: panel agents may poll while this seeds — every
  // step is guarded + idempotent, races degrade to no-ops.
  if ((await db.mediaItem.count()) === 0) {
    try {
      await db.mediaItem.createMany({
        data: [
          ...SAMPLE_MOVIES.map((m) => ({ kind: 'movie', title: m.title, library: 'Movies', sizeMb: m.sizeMb, year: m.year, playCount: Math.floor(Math.random() * 9) })),
          ...SAMPLE_SERIES.map((s) => ({ kind: 'series', title: s.title, library: 'TV Shows', sizeMb: s.sizeMb, year: s.year, playCount: Math.floor(Math.random() * 30) })),
          { kind: 'music', title: 'Music Library (28,412 tracks)', library: 'Music', sizeMb: 430080, year: null, playCount: 8421 },
          ...SAMPLE_PHOTOS.map((p) => ({ kind: 'photo', title: p.title, library: 'Photos', sizeMb: p.sizeMb, year: p.year, playCount: 0 })),
        ],
      })
    } catch {
      /* concurrent seed won */
    }
  }
  if ((await db.mediaSession.count()) === 0) {
    try {
      await db.mediaSession.createMany({
        data: [
          { user: 'jeremy', device: 'iPhone 16', item: 'Dune: Part Two', state: 'playing', startedAt: new Date(Date.now() - 640000) },
          { user: 'maya', device: 'Firefox on Linux', item: 'Severance S02E05', state: 'paused', startedAt: new Date(Date.now() - 4100000) },
          { user: 'guest-tv', device: 'LG webOS TV', item: 'Jellyfin home', state: 'idle', startedAt: new Date(Date.now() - 180000) },
        ],
      })
    } catch {
      /* concurrent seed won */
    }
  }
  // methods keyed by user (stable across re-seeds)
  await db.sdKv.upsert({
    where: { key: 'jellyfin.methods' },
    create: {
      key: 'jellyfin.methods',
      value: JSON.stringify({
        jeremy: { method: 'transcode', detail: '4K HDR → 1080p H.264 (remote, 18 Mbps limit)' },
        maya: { method: 'direct', detail: 'direct play 1080p' },
        'guest-tv': { method: 'idle', detail: 'idle on home screen' },
      }),
    },
    update: {},
  })
}

async function getMethods(): Promise<Record<string, { method: string; detail: string }>> {
  const row = await db.sdKv.findUnique({ where: { key: 'jellyfin.methods' } })
  return row ? (JSON.parse(row.value) as typeof SESSION_METHODS) : SESSION_METHODS
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    await ensureSeeded()
    const sessions = await db.mediaSession.findMany()
    const methods = await getMethods()
    const transcode = sessions.filter((s) => methods[s.user]?.method === 'transcode' && s.state === 'playing').length
    const items = LIBRARIES.filter((l) => l.kind !== 'music').reduce((sum, l) => sum + l.items, 0)
    return ok(
      {
        libraries: LIBRARIES.length,
        items,
        tracks: LIBRARIES.find((l) => l.kind === 'music')?.tracks ?? 0,
        sessions: sessions.length,
        playing: sessions.filter((s) => s.state === 'playing').length,
        transcode,
        totalSizeMb: LIBRARIES.reduce((sum, l) => sum + l.sizeMb, 0),
      },
      SOURCE,
      NOTE,
    )
  },

  libraries: async () => {
    await ensureSeeded()
    const rows = await db.mediaItem.findMany()
    const libraries = LIBRARIES.map((l) => {
      const sample = rows.filter((r) => r.library === l.name)
      const sampleSizeMb = sample.reduce((sum, r) => sum + r.sizeMb, 0)
      return {
        ...l,
        sizeHuman: `${(l.sizeMb / 1024 / 1024).toFixed(1)} TB`.replace('0.4 TB', '420 GB'),
        sampleItems: sample.length,
        sampleSizeMb,
      }
    })
    return ok({ libraries, count: libraries.length }, SOURCE, NOTE + ' — aggregate counts in SdKv, item rows are a sample')
  },

  items: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const library = String(args.library ?? '')
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 50))
    if (!library) return failE('library is required (Movies | TV Shows | Music | Photos)')
    if (!LIBRARIES.some((l) => l.name === library)) return failE(`unknown library '${library}'`)
    const rows = await db.mediaItem.findMany({ where: { library }, orderBy: { title: 'asc' }, take: limit })
    return ok(
      {
        library,
        items: rows.map((r) => ({ ...r, sizeHuman: `${(r.sizeMb / 1024).toFixed(1)} GB` })),
        returned: rows.length,
        note: 'sample rows — full catalog is aggregate-only',
      },
      SOURCE,
      NOTE,
    )
  },

  sessions: async () => {
    await ensureSeeded()
    const rows = await db.mediaSession.findMany({ orderBy: { startedAt: 'desc' } })
    const methods = await getMethods()
    return ok(
      {
        sessions: rows.map((s) => ({
          ...s,
          method: methods[s.user]?.method ?? 'direct',
          methodDetail: methods[s.user]?.detail ?? 'direct play',
        })),
        count: rows.length,
      },
      SOURCE,
      NOTE,
    )
  },

  play: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const sessionId = String(args.sessionId ?? '')
    if (!sessionId) return failE('sessionId is required')
    const session = await db.mediaSession.findUnique({ where: { id: sessionId } })
    if (!session) return failE('session not found')
    if (session.state === 'playing') return failE(`${session.user}'s session is already playing`)
    const row = await db.mediaSession.update({ where: { id: sessionId }, data: { state: 'playing' } })
    await audit('play', `session ${session.user} (${session.device}) — ${session.item} → playing`)
    return ok({ session: row, state: 'playing' }, SOURCE, `${session.user} → playing — demo state transition`)
  },

  pause: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const sessionId = String(args.sessionId ?? '')
    if (!sessionId) return failE('sessionId is required')
    const session = await db.mediaSession.findUnique({ where: { id: sessionId } })
    if (!session) return failE('session not found')
    if (session.state !== 'playing') return failE(`${session.user}'s session is not playing (state: ${session.state})`)
    const row = await db.mediaSession.update({ where: { id: sessionId }, data: { state: 'paused' } })
    await audit('pause', `session ${session.user} (${session.device}) — ${session.item} → paused`)
    return ok({ session: row, state: 'paused' }, SOURCE, `${session.user} → paused — demo state transition`)
  },
}
