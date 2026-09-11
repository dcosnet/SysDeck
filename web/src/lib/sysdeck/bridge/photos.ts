// SysDeck bridge — photos (demo photo-library inventory)
// Port of bridge/photos.py semantics: the cockpit edition had a
// BACKEND_REGISTRY of photo management backends (photoprism, piwigo,
// lychee, nextcloud-memories, librephotos) detected via systemctl and
// binaries. None exist in this sandbox, so the web edition keeps the
// same surface over seeded PhotoLibrary rows; indexing progress and
// backend errors live in SdKv (the model has no columns for them).
import { db } from '@/lib/db'
import { ok, fail } from './shared'

const SOURCE = 'demo' as const
const NOTE = 'photoprism/piwigo/lychee/nextcloud daemons not present in sandbox — demo library inventory'

function failE(error: string) {
  return { ...fail(error), source: SOURCE }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'photos', action, detail } })
}

// ── per-library metadata (progress / errors) in SdKv ────────────────

interface PhotoMeta {
  progress?: number
  error?: string
  lastScan?: string
}

const SEED_META: Record<string, PhotoMeta> = {
  family: { progress: 62 },
  scan: { error: 'EXIF tool missing (install libimage-exiftool-perl) — cannot read camera metadata' },
}

async function getMeta(): Promise<Record<string, PhotoMeta>> {
  const row = await db.sdKv.findUnique({ where: { key: 'photos.meta' } })
  return row ? (JSON.parse(row.value) as Record<string, PhotoMeta>) : {}
}

async function putMeta(meta: Record<string, PhotoMeta>) {
  await db.sdKv.upsert({
    where: { key: 'photos.meta' },
    create: { key: 'photos.meta', value: JSON.stringify(meta) },
    update: { value: JSON.stringify(meta), ts: new Date() },
  })
}

// ── lazy seed ───────────────────────────────────────────────────────

async function ensureSeeded(): Promise<void> {
  const count = await db.photoLibrary.count()
  if (count > 0) return
  await db.photoLibrary.createMany({
    data: [
      { backend: 'photoprism', name: 'family', photos: 48213, videos: 1290, sizeGb: 412, state: 'indexing' },
      { backend: 'piwigo', name: 'public', photos: 3412, videos: 0, sizeGb: 8, state: 'idle' },
      { backend: 'nextcloud-memories', name: 'sync', photos: 18240, videos: 640, sizeGb: 96, state: 'idle' },
      { backend: 'lychee', name: 'scan', photos: 892, videos: 0, sizeGb: 2, state: 'error' },
    ],
  })
  await putMeta(SEED_META)
  await audit('seed', 'seeded demo libraries: family (photoprism), public (piwigo), sync (nextcloud-memories), scan (lychee)')
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    await ensureSeeded()
    const rows = await db.photoLibrary.findMany()
    const meta = await getMeta()
    return ok(
      {
        libraries: rows.length,
        photos: rows.reduce((sum, r) => sum + r.photos, 0),
        videos: rows.reduce((sum, r) => sum + r.videos, 0),
        sizeGb: rows.reduce((sum, r) => sum + r.sizeGb, 0),
        states: rows.reduce<Record<string, number>>((acc, r) => {
          acc[r.state] = (acc[r.state] ?? 0) + 1
          return acc
        }, {}),
        errors: rows.filter((r) => r.state === 'error').length,
        indexingProgress: Object.fromEntries(
          rows.filter((r) => r.state === 'indexing').map((r) => [r.name, meta[r.name]?.progress ?? 0]),
        ),
      },
      SOURCE,
      NOTE,
    )
  },

  list: async () => {
    await ensureSeeded()
    const rows = await db.photoLibrary.findMany({ orderBy: { name: 'asc' } })
    const meta = await getMeta()
    return ok(
      {
        libraries: rows.map((r) => ({ ...r, progress: meta[r.name]?.progress ?? null, error: meta[r.name]?.error ?? null })),
        count: rows.length,
      },
      SOURCE,
      NOTE,
    )
  },

  index: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const lib = await db.photoLibrary.findUnique({ where: { id } })
    if (!lib) return failE('library not found')
    const meta = await getMeta()
    const before = meta[lib.name]?.progress ?? 0
    if (lib.state === 'error') {
      return failE(`${lib.name} is in error state: ${meta[lib.name]?.error ?? 'unknown error'} — fix the backend first`)
    }
    // indexing advances ~7% per call; at 100% the library goes idle
    const after = Math.min(100, before + 7)
    const done = after >= 100
    const row = await db.photoLibrary.update({
      where: { id },
      data: { state: done ? 'idle' : 'indexing', photos: lib.photos + (done ? 128 : 0) },
    })
    meta[lib.name] = { ...meta[lib.name], progress: after }
    await putMeta(meta)
    await audit('index', `${lib.name} (${lib.backend}) indexing ${before}% → ${after}%${done ? ' — complete, state idle' : ''}`)
    return ok(
      { library: { ...row, progress: after }, before, after, state: row.state },
      SOURCE,
      `indexing pass: ${before}% → ${after}% (demo progress)`,
    )
  },

  scan: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const lib = await db.photoLibrary.findUnique({ where: { id } })
    if (!lib) return failE('library not found')
    if (lib.state === 'error') {
      return failE(`${lib.name} is in error state: ${(await getMeta())[lib.name]?.error ?? 'unknown error'} — fix the backend first`)
    }
    const meta = await getMeta()
    // a scan completes synchronously in the demo: new files found
    const added = 12 + Math.floor(Math.random() * 40)
    const row = await db.photoLibrary.update({
      where: { id },
      data: { photos: lib.photos + added, state: 'idle' },
    })
    meta[lib.name] = { ...meta[lib.name], lastScan: new Date().toISOString() }
    await putMeta(meta)
    await audit('scan', `${lib.name} (${lib.backend}) scanned — ${added} new photos, ${row.photos} total`)
    return ok(
      { library: { ...row, progress: meta[lib.name]?.progress ?? null }, added, scanned: lib.photos + added, state: 'idle' },
      SOURCE,
      'demo scan — completed synchronously',
    )
  },
}
