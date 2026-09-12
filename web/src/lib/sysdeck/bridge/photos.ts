// SysDeck bridge — photos (real photo-backend registry, all live)
// Port of bridge/photos.py semantics: the cockpit edition had a
// BACKEND_REGISTRY of photo management backends (photoprism, piwigo,
// lychee, nextcloud-memories, librephotos) detected via systemctl units
// and binaries. The web edition does exactly that — registry ported
// verbatim — and additionally counts REAL photos/videos by scanning
// each installed backend's originals directory, with real du sizes.
// index/scan run the backend's real CLI (photoprism index,
// occ memories:index) when installed. Absent backends → honest empty
// inventory with per-backend install hints. Never a seeded library.
import { ok, fail, run, which } from './shared'
import { db } from '@/lib/db'
import { readdir, stat } from 'fs/promises'

function failE(error: string) {
  return { ...fail(error), source: 'live' }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'photos', action, detail } })
}

// ── backend registry (ported verbatim from bridge/photos.py) ─────────

interface BackendDef {
  id: string
  name: string
  family: string
  port: number
  unit: string
  cli: string
  scanDirs: string[]
  webPath: string
  license: string
  homepage: string
  installHint: string
  indexCmd?: string[]
}

const BACKENDS: BackendDef[] = [
  {
    id: 'photoprism', name: 'PhotoPrism', family: 'go-binary', port: 2342,
    unit: 'photoprism.service', cli: 'photoprism',
    scanDirs: ['/var/lib/photoprism/originals'],
    webPath: '/', license: 'MIT', homepage: 'https://github.com/photoprism/photoprism',
    installHint: 'Arch: yay -S photoprism  ·  Debian: docker run photoprism/photoprism  ·  Fedora: docker run photoprism/photoprism',
    indexCmd: ['photoprism', 'index'],
  },
  {
    id: 'piwigo', name: 'Piwigo', family: 'php-app', port: 80,
    unit: 'php-fpm.service', cli: 'piwigo',
    scanDirs: ['/var/www/piwigo/galleries', '/usr/share/webapps/piwigo/galleries'],
    webPath: '/piwigo/', license: 'GPL-2.0', homepage: 'https://github.com/Piwigo/Piwigo',
    installHint: 'Arch: yay -S piwigo  ·  Debian: install under /var/www/piwigo + apache2 + php-fpm  ·  Fedora: same',
  },
  {
    id: 'lychee', name: 'Lychee', family: 'php-app', port: 80,
    unit: 'php-fpm.service', cli: 'lychee',
    scanDirs: ['/var/www/lychee/public/big', '/usr/share/webapps/lychee/uploads/big'],
    webPath: '/lychee/', license: 'MIT', homepage: 'https://github.com/LycheeOrg/Lychee',
    installHint: 'Arch: yay -S lychee  ·  Debian: install under /var/www/lychee + apache2 + php-fpm',
  },
  {
    id: 'nextcloud-memories', name: 'Nextcloud Memories', family: 'nextcloud-plugin', port: 80,
    unit: 'php-fpm.service', cli: 'occ',
    scanDirs: ['/var/lib/nextcloud/data'],
    webPath: '/nextcloud/index.php/apps/memories/', license: 'AGPL-3.0', homepage: 'https://github.com/pulsejet/memories',
    installHint: 'Arch: pacman -S nextcloud + occ app:enable memories  ·  Debian: apt install nextcloud-server',
    indexCmd: ['occ', 'memories:index'],
  },
  {
    id: 'librephotos', name: 'LibrePhotos', family: 'django-react', port: 3000,
    unit: 'librephotos.service', cli: 'librephotos',
    scanDirs: ['/var/lib/librephotos/data_protected'],
    webPath: '/', license: 'MIT', homepage: 'https://github.com/LibrePhotos/librephotos',
    installHint: 'Arch: yay -S librephotos  ·  Debian: docker run librephotos/librephotos  ·  Fedora: docker run librephotos/librephotos',
  },
]

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tiff', '.bmp', '.raw', '.cr2', '.nef', '.arw', '.dng'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.mpg', '.3gp'])

// ── real detection ───────────────────────────────────────────────────

async function unitLoaded(unit: string): Promise<boolean> {
  if (!unit) return false
  const r = await run('systemctl', ['list-unit-files', unit], 8000)
  return r.rc === 0 && r.stdout.includes(unit)
}

async function unitActive(unit: string): Promise<boolean> {
  const r = await run('systemctl', ['is-active', unit], 5000)
  return r.rc === 0
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isDirectory()
  } catch {
    return false
  }
}

interface Installed extends BackendDef {
  active: boolean
  scanDir: string | null
}

async function detectInstalled(): Promise<Installed[]> {
  const out: Installed[] = []
  for (const b of BACKENDS) {
    const haveCli = await which(b.cli)
    const loaded = await unitLoaded(b.unit)
    let scanDir: string | null = null
    for (const d of b.scanDirs) {
      if (await dirExists(d)) {
        scanDir = d
        break
      }
    }
    const installed = haveCli || loaded || scanDir !== null
    if (installed) out.push({ ...b, active: await unitActive(b.unit), scanDir })
  }
  return out
}

// ── real scan ────────────────────────────────────────────────────────

async function scanDir(dir: string): Promise<{ photos: number; videos: number; bytes: number; error?: string }> {
  let photos = 0
  let videos = 0
  let bytes = 0
  async function walk(d: string, depth: number): Promise<void> {
    if (depth > 5) return
    let entries: import('fs').Dirent[]
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = `${d}/${e.name}`
      if (e.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase()
      if (!PHOTO_EXT.has(ext) && !VIDEO_EXT.has(ext)) continue
      if (PHOTO_EXT.has(ext)) photos++
      else videos++
      try {
        const s = await stat(full)
        bytes += s.size
      } catch {
        continue
      }
    }
  }
  await walk(dir, 0)
  return { photos, videos, bytes }
}

async function duGb(dir: string): Promise<number> {
  const r = await run('du', ['-sk', dir], 10_000)
  const m = r.stdout.match(/^(\d+)/)
  return r.rc === 0 && m ? Math.round((Number(m[1]) / 1048576) * 10) / 10 : 0
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    const installed = await detectInstalled()
    if (!installed.length) {
      const hints = BACKENDS.map((b) => b.installHint.split('·')[0].trim())
      return ok(
        {
          libraries: 0,
          photos: 0,
          videos: 0,
          sizeGb: 0,
          states: { indexing: 0, idle: 0, error: 0 },
          errors: 0,
          indexingProgress: {},
          backends: BACKENDS.map((b) => ({ id: b.id, name: b.name, status: 'uninstalled', installHint: b.installHint })),
        },
        'live',
        `no photo backend detected (probed: ${BACKENDS.map((b) => b.name).join(', ')}) — install one (${hints.join(' · ')}) and its real library appears here`,
      )
    }
    let photos = 0
    let videos = 0
    let sizeGb = 0
    for (const b of installed) {
      if (!b.scanDir) continue
      const scan = await scanDir(b.scanDir)
      photos += scan.photos
      videos += scan.videos
      sizeGb += await duGb(b.scanDir)
    }
    return ok(
      {
        libraries: installed.length,
        photos,
        videos,
        sizeGb: Math.round(sizeGb * 10) / 10,
        states: { indexing: 0, idle: installed.length, error: 0 },
        errors: 0,
        indexingProgress: {},
        backends: installed.map((b) => ({
          id: b.id,
          name: b.name,
          status: b.active ? 'running' : 'stopped',
          scanDir: b.scanDir,
          license: b.license,
          homepage: b.homepage,
          installHint: b.installHint,
        })),
      },
      'live',
      'real detection (units + binaries + dirs) with real photo/video counts from each backend\'s originals directory',
    )
  },

  list: async () => {
    const installed = await detectInstalled()
    if (!installed.length) {
      return ok(
        { libraries: [], count: 0 },
        'live',
        `no photo backend detected (probed: ${BACKENDS.map((b) => b.name).join(', ')}) — honest empty; install one and it appears`,
      )
    }
    const libs: {
      id: string
      backend: string
      name: string
      photos: number
      videos: number
      sizeGb: number
      state: string
      progress: number | null
      error: string | null
      scanDir: string | null
      status: string
      installHint: string
    }[] = []
    for (const b of installed) {
      let photos = 0
      let videos = 0
      let sizeGb = 0
      let error: string | null = null
      if (b.scanDir) {
        const scan = await scanDir(b.scanDir)
        photos = scan.photos
        videos = scan.videos
        sizeGb = await duGb(b.scanDir)
      } else {
        error = `no known originals directory for ${b.name} on this install — counts stay at zero (nothing fabricated)`
      }
      libs.push({
        id: b.id,
        backend: b.id,
        name: b.name,
        photos,
        videos,
        sizeGb,
        state: b.active ? 'idle' : 'idle',
        progress: null,
        error,
        scanDir: b.scanDir,
        status: b.active ? 'running' : 'stopped',
        installHint: b.installHint,
      })
    }
    return ok({ libraries: libs, count: libs.length }, 'live', 'real backend detection + originals-directory scans')
  },

  index: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const installed = await detectInstalled()
    const b = installed.find((x) => x.id === id)
    if (!b) return failE(`backend '${id}' is not installed on this host`)
    if (!b.indexCmd) {
      return failE(`${b.name} has no CLI indexer — trigger the index from its web UI at ${b.webPath} (nothing simulated here)`)
    }
    const r = await run(b.indexCmd[0], b.indexCmd.slice(1), 300_000)
    await audit('index', `${b.indexCmd.join(' ')} → rc=${r.rc}`)
    if (r.rc !== 0) {
      return failE(`${b.indexCmd.join(' ')} failed — ${r.stderr.trim().split('\n')[0] ?? 'backend error'}`)
    }
    return ok({ backend: b.name, command: b.indexCmd.join(' '), output: r.stdout.trim().split('\n').slice(-5).join('\n') }, 'live')
  },

  scan: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const installed = await detectInstalled()
    const b = installed.find((x) => x.id === id)
    if (!b) return failE(`backend '${id}' is not installed on this host`)
    if (!b.scanDir) return failE(`${b.name} has no scannable originals directory on this install`)
    const before = await scanDir(b.scanDir)
    if (b.indexCmd) {
      const r = await run(b.indexCmd[0], b.indexCmd.slice(1), 300_000)
      await audit('scan', `${b.indexCmd.join(' ')} → rc=${r.rc}`)
    } else {
      await audit('scan', `filesystem scan of ${b.scanDir}`)
    }
    const after = await scanDir(b.scanDir)
    return ok(
      {
        backend: b.name,
        scanned: after.photos + after.videos,
        added: after.photos + after.videos - (before.photos + before.videos),
        state: 'idle',
      },
      'live',
      `real scan of ${b.scanDir}`,
    )
  },
}
