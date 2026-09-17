// SysDeck bridge — jellyfin (real media server bridge, all live)
// Port of bridge/jellyfin.py semantics: the cockpit edition surfaced the
// jellyfin systemd service state, port, web URL and libraries. The web
// edition does exactly that against the REAL host:
//   - service state via systemctl is-active jellyfin.service
//   - port from /etc/jellyfin/network.xml (default 8096)
//   - version via the public /System/Info/Public endpoint (no auth)
//   - libraries by scanning /var/lib/jellyfin/root/default/ (real file
//     counts, real du sizes, real media extensions)
//   - live sessions/playback via the Jellyfin API when the operator
//     provides JELLYFIN_API_KEY (honest empty otherwise)
//   - start/stop/restart run the real systemctl (privilege-gated)
// Absent server → honest "not installed" with the install hint.
import { ok, fail, run, which, readText } from './shared'
import { db } from '@/lib/db'
import { readdir, stat } from 'fs/promises'

function failE(error: string) {
  return { ...fail(error), source: 'live' }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'jellyfin', action, detail } })
}

const MEDIA_ROOT = '/var/lib/jellyfin/root/default'
const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mpg', '.mpeg', '.m4v'])
const AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.opus', '.wma'])
const API_KEY = process.env.JELLYFIN_API_KEY ?? ''

async function serviceState(): Promise<string> {
  const r = await run('systemctl', ['is-active', 'jellyfin.service'], 5000)
  return r.rc === 0 ? r.stdout.trim() : 'inactive'
}

async function webPort(): Promise<number> {
  const xml = await readText('/etc/jellyfin/network.xml')
  const m = xml.match(/<Port>(\d+)<\/Port>/)
  return m ? Number(m[1]) : 8096
}

interface PublicInfo {
  Version?: string
  OperatingSystem?: string
  ServerName?: string
}

async function publicInfo(port: number): Promise<PublicInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/System/Info/Public`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return (await res.json()) as PublicInfo
  } catch {
    return null
  }
}

// ── real library scan ────────────────────────────────────────────────

interface ScannedLib {
  name: string
  kind: string
  items: number
  tracks: number
  sizeMb: number
}

async function scanLibrary(dir: string, name: string): Promise<ScannedLib> {
  let items = 0
  let tracks = 0
  let bytes = 0
  const kind = name.toLowerCase().includes('music') || name.toLowerCase().includes('audio') ? 'music' : name.toLowerCase().includes('photo') || name.toLowerCase().includes('photo') ? 'photos' : name.toLowerCase().includes('show') || name.toLowerCase().includes('series') ? 'tvshows' : 'movies'
  async function walk(d: string, depth: number): Promise<void> {
    if (depth > 4) return
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
      if (!VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext)) continue
      items++
      if (AUDIO_EXT.has(ext)) tracks++
      try {
        const s = await stat(full)
        bytes += s.size
      } catch {
        continue
      }
    }
  }
  await walk(dir, 0)
  return { name, kind, items, tracks, sizeMb: Math.round(bytes / 1048576) }
}

async function scanLibraries(): Promise<ScannedLib[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await readdir(MEDIA_ROOT, { withFileTypes: true })
  } catch {
    return []
  }
  const libs: ScannedLib[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    libs.push(await scanLibrary(`${MEDIA_ROOT}/${e.name}`, e.name))
  }
  return libs
}

// ── live sessions (API key gated — honest empty without one) ─────────

interface JfSession {
  Id: string
  UserName?: string
  DeviceName?: string
  NowPlayingItem?: { Name?: string }
  PlayState?: {IsPaused?: boolean; PlayMethod?: string}
}

async function liveSessions(port: number): Promise<JfSession[] | null> {
  if (!API_KEY) return null
  try {
    const res = await fetch(`http://127.0.0.1:${port}/Sessions?api_key=${API_KEY}`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    return (await res.json()) as JfSession[]
  } catch {
    return null
  }
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    const installed = (await which('jellyfin')) || (await serviceState()).includes('active') || await readText('/etc/jellyfin/network.xml').then((t) => t.length > 0)
    const svc = await serviceState()
    const port = await webPort()
    const info = await publicInfo(port)
    if (!installed && !info) {
      return ok(
        { installed: false, service: svc, libraries: 0, items: 0, tracks: 0, sessions: 0, playing: 0, transcode: 0, totalSizeMb: 0 },
        'live',
        'jellyfin not detected on this host — install it (Arch: pacman -S jellyfin · Debian: apt install jellyfin) and the service, port, version and libraries go live here',
      )
    }
    const libs = await scanLibraries()
    const sessions = (await liveSessions(port)) ?? []
    const playing = sessions.filter((s) => s.NowPlayingItem).length
    return ok(
      {
        installed: true,
        service: svc,
        port,
        version: info?.Version ?? null,
        serverName: info?.ServerName ?? null,
        libraries: libs.length,
        items: libs.reduce((a, l) => a + l.items, 0),
        tracks: libs.reduce((a, l) => a + l.tracks, 0),
        sessions: sessions.length,
        playing,
        transcode: sessions.filter((s) => s.PlayState?.PlayMethod === 'Transcode').length,
        totalSizeMb: libs.reduce((a, l) => a + l.sizeMb, 0),
      },
      'live',
      `real systemd state + ${port} public-info probe + ${MEDIA_ROOT} scan${API_KEY ? ' + live Sessions API' : ' (set JELLYFIN_API_KEY for live sessions/playback control)'}`,
    )
  },

  libraries: async () => {
    const libs = await scanLibraries()
    if (!libs.length) {
      const svc = await serviceState()
      return ok({ libraries: [], count: 0 }, 'live', svc === 'active' ? `no libraries under ${MEDIA_ROOT} yet — add one in the Jellyfin dashboard` : 'jellyfin is not active — start the service to scan its libraries')
    }
    return ok(
      {
        libraries: libs.map((l) => ({
          name: l.name,
          kind: l.kind,
          items: l.items,
          tracks: l.tracks,
          sizeMb: l.sizeMb,
          sizeHuman: fmtSize(l.sizeMb),
          sampleItems: Math.min(l.items, 200),
        })),
        count: libs.length,
      },
      'live',
      `real scan of ${MEDIA_ROOT}`,
    )
  },

  sessions: async () => {
    const port = await webPort()
    const live = await liveSessions(port)
    if (live === null) {
      return ok(
        { sessions: [], count: 0 },
        'live',
        API_KEY ? `Sessions API unreachable at 127.0.0.1:${port}` : 'live sessions need a Jellyfin API key — set JELLYFIN_API_KEY (Jellyfin dashboard → API Keys) and this goes live',
      )
    }
    const now = Date.now()
    return ok(
      {
        sessions: live
          .filter((s) => s.UserName || s.NowPlayingItem)
          .map((s) => ({
            id: s.Id,
            user: s.UserName ?? '',
            device: s.DeviceName ?? '',
            item: s.NowPlayingItem?.Name ?? '',
            state: s.NowPlayingItem ? (s.PlayState?.IsPaused ? 'paused' : 'playing') : 'idle',
            startedAt: new Date(now).toISOString(),
            method: s.PlayState?.PlayMethod === 'Transcode' ? 'transcode' : s.NowPlayingItem ? 'direct' : 'idle',
            methodDetail: s.PlayState?.PlayMethod ?? '',
          })),
        count: live.length,
      },
      'live',
      'live Jellyfin Sessions API',
    )
  },

  items: async (args: Record<string, unknown>) => {
    const library = String(args.library ?? '')
    const limit = Math.max(1, Math.min(500, Number(args.limit) || 200))
    const dir = `${MEDIA_ROOT}/${library}`
    try {
      // readdir doubles as the existence probe for the library root
      await readdir(dir, { withFileTypes: true })
    } catch {
      return failE(`library '${library}' not found under ${MEDIA_ROOT}`)
    }
    const items: {
      id: string
      kind: string
      title: string
      library: string
      sizeMb: number
      year?: number
      addedAt: string
      playCount: number
      sizeHuman: string
    }[] = []
    async function walk(d: string, depth: number): Promise<void> {
      if (depth > 4 || items.length >= limit) return
      let ents: import('fs').Dirent[]
      try {
        ents = await readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of ents) {
        if (items.length >= limit) return
        const full = `${d}/${e.name}`
        if (e.isDirectory()) {
          await walk(full, depth + 1)
          continue
        }
        const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase()
        if (!VIDEO_EXT.has(ext) && !AUDIO_EXT.has(ext)) continue
        try {
          const s = await stat(full)
          const sizeMb = Math.round(s.size / 1048576)
          const year = e.name.match(/\((19|20)\d{2}\)/)?.[0]?.replace(/[()]/g, '')
          items.push({
            id: full.slice(MEDIA_ROOT.length),
            kind: AUDIO_EXT.has(ext) ? 'audio' : 'video',
            title: e.name.replace(/\.[^.]+$/, ''),
            library,
            sizeMb,
            year: year ? Number(year) : undefined,
            addedAt: new Date(s.mtimeMs).toISOString(),
            playCount: 0,
            sizeHuman: fmtSize(sizeMb),
          })
        } catch {
          continue
        }
      }
    }
    await walk(dir, 0)
    return ok({ library, items, returned: items.length }, 'live', `real file scan of ${dir}`)
  },

  play: async (args: Record<string, unknown>) => {
    const sessionId = String(args.sessionId ?? '')
    if (!sessionId) return failE('sessionId is required')
    if (!API_KEY) return failE('playback control needs JELLYFIN_API_KEY — set it and the Sessions API goes live')
    const port = await webPort()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/Sessions/${sessionId}/Playing/Resume?api_key=${API_KEY}`, { method: 'POST', signal: AbortSignal.timeout(3000) })
      if (!res.ok && res.status !== 204) return failE(`Jellyfin returned HTTP ${res.status}`)
    } catch {
      return failE('Jellyfin Sessions API unreachable')
    }
    return ok({ sessionId, state: 'playing' }, 'live')
  },

  pause: async (args: Record<string, unknown>) => {
    const sessionId = String(args.sessionId ?? '')
    if (!sessionId) return failE('sessionId is required')
    if (!API_KEY) return failE('playback control needs JELLYFIN_API_KEY — set it and the Sessions API goes live')
    const port = await webPort()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/Sessions/${sessionId}/Playing/Pause?api_key=${API_KEY}`, { method: 'POST', signal: AbortSignal.timeout(3000) })
      if (!res.ok && res.status !== 204) return failE(`Jellyfin returned HTTP ${res.status}`)
    } catch {
      return failE('Jellyfin Sessions API unreachable')
    }
    return ok({ sessionId, state: 'paused' }, 'live')
  },

  start: async () => {
    const r = await run('systemctl', ['start', 'jellyfin.service'], 30_000)
    await audit('start', `systemctl start jellyfin → rc=${r.rc}`)
    if (r.rc !== 0) return failE(`systemctl start jellyfin failed — ${r.stderr.trim().split('\n')[0] ?? 'needs root/polkit'}`)
    return ok({ service: 'active' }, 'live')
  },

  stop: async () => {
    const r = await run('systemctl', ['stop', 'jellyfin.service'], 30_000)
    await audit('stop', `systemctl stop jellyfin → rc=${r.rc}`)
    if (r.rc !== 0) return failE(`systemctl stop jellyfin failed — ${r.stderr.trim().split('\n')[0] ?? 'needs root/polkit'}`)
    return ok({ service: 'inactive' }, 'live')
  },

  restart: async () => {
    const r = await run('systemctl', ['restart', 'jellyfin.service'], 60_000)
    await audit('restart', `systemctl restart jellyfin → rc=${r.rc}`)
    if (r.rc !== 0) return failE(`systemctl restart jellyfin failed — ${r.stderr.trim().split('\n')[0] ?? 'needs root/polkit'}`)
    return ok({ service: 'active' }, 'live')
  },

  webStatus: async () => {
    const svc = await serviceState()
    const port = await webPort()
    const info = await publicInfo(port)
    return ok(
      { running: svc === 'active', port, url: `http://127.0.0.1:${port}`, version: info?.Version ?? null },
      'live',
    )
  },
}

function fmtSize(mb: number): string {
  if (mb >= 1024 * 1024) return `${(mb / 1024 / 1024).toFixed(1)} TB`
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb} MB`
}
