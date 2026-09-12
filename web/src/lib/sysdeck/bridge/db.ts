// SysDeck bridge — db (real database-engine registry, all live)
// Port of bridge/db.py semantics: the cockpit edition had an
// ENGINE_REGISTRY of database engines (postgresql, mariadb, sqlite,
// redis, ...) detected via systemctl + config paths, with start/stop
// via systemd. The web edition does exactly that:
//   - the app's own SQLite state store with REAL stats (file size,
//     live table row counts, dpkg sqlite library version)
//   - each installed engine detected via systemctl units + client
//     binaries, probed with the real readiness tools (pg_isready,
//     mariadb-admin/mysqladmin status, redis-cli ping), real data-dir
//     sizes via du, real client versions
//   - start/stop run the real systemctl (privilege-gated)
//   - backup runs the real dump tool (pg_dump / mariadb-dump /
//     mysqldump) — sqlite backup is a real file copy
// Absent engines simply do not appear. Never a seeded inventory.
import { statSync, copyFileSync, mkdirSync, openSync, closeSync } from 'fs'
import { spawn, type StdioOptions } from 'child_process'
import path from 'path'
import { db } from '@/lib/db'
import { ok, fail, run, which } from './shared'

function failE(error: string) {
  return { ...fail(error), source: 'live' }
}

/** `dump | gzip > path` — a real pipeline assembled without a shell:
 *  the dump's stdout feeds gzip's stdin and gzip's stdout lands directly
 *  in the file. Binary-safe and unbounded — the dump never routes
 *  through a JS string, so large databases cannot truncate. */
function dumpToGzip(dumpCmd: string, dumpArgs: string[], outPath: string, timeoutMs = 300_000): Promise<{ rc: number; stderr: string }> {
  return new Promise((resolve) => {
    const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', NODE_ENV: process.env.NODE_ENV }
    let fd: number
    try {
      fd = openSync(outPath, 'w', 0o600)
    } catch (err) {
      resolve({ rc: 1, stderr: `cannot create ${outPath} — ${String(err).split('\n')[0]}` })
      return
    }
    let stderr = ''
    let done = false
    const acc = (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384)
    }
    const finish = (rc: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
      resolve({ rc, stderr })
    }
    const timer = setTimeout(() => {
      try {
        dump.kill('SIGKILL')
        gz.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish(124)
    }, timeoutMs)
    const gzStdio: StdioOptions = ['pipe', fd, 'pipe']
    const gz = spawn('gzip', ['-c'], { stdio: gzStdio, env: childEnv })
    const dumpStdio: StdioOptions = ['ignore', 'pipe', 'pipe']
    const dump = spawn(dumpCmd, dumpArgs, { stdio: dumpStdio, env: childEnv })
    dump.stdout?.on('data', (d) => gz.stdin?.write(d))
    dump.stderr?.on('data', acc)
    gz.stdin?.on('error', () => {})
    gz.on('error', () => finish(127))
    dump.on('error', () => {
      gz.stdin?.end()
      finish(127)
    })
    dump.on('close', (rc) => {
      gz.stdin?.end()
      gz.on('close', (grc) => finish((rc ?? 1) !== 0 ? (rc ?? 1) : grc ?? 1))
    })
  })
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'db', action, detail } })
}

const SQLITE_ID = 'sqlite-local'
const DB_PATH = path.join(process.cwd(), 'db', 'custom.db')

// ── engine registry (systemd unit + client binary + probes) ──────────

interface EngineDef {
  id: string
  name: string
  engine: string
  unit: string
  port: number
  client: string
  dataDir: string
  readyProbe?: (this: EngineDef) => Promise<{ running: boolean; conns: number | null; detail: string }>
}

async function unitActive(unit: string): Promise<boolean> {
  const r = await run('systemctl', ['is-active', unit], 5000)
  return r.rc === 0
}

async function duMb(dir: string): Promise<number> {
  const r = await run('du', ['-sm', dir], 8000)
  const m = r.stdout.match(/^(\d+)/)
  return r.rc === 0 && m ? Number(m[1]) : 0
}

const ENGINES: EngineDef[] = [
  {
    id: 'postgresql', name: 'PostgreSQL', engine: 'postgres',
    unit: 'postgresql.service', port: 5432, client: 'psql', dataDir: '/var/lib/postgresql',
    async readyProbe() {
      const r = await run('pg_isready', [], 5000)
      return { running: r.rc === 0, conns: null, detail: r.stdout.trim() || r.stderr.trim() }
    },
  },
  {
    id: 'mariadb', name: 'MariaDB', engine: 'mariadb',
    unit: 'mariadb.service', port: 3306, client: 'mariadb', dataDir: '/var/lib/mysql',
    async readyProbe() {
      const r = await run('mariadb-admin', ['status'], 5000)
      if (r.rc === 0) {
        const m = r.stdout.match(/Threads:\s*(\d+)/)
        return { running: true, conns: m ? Number(m[1]) : null, detail: r.stdout.trim().split('\n')[0] }
      }
      return { running: false, conns: null, detail: r.stderr.trim().split('\n')[0] || 'mariadb-admin status failed' }
    },
  },
  {
    id: 'mysql', name: 'MySQL', engine: 'mysql',
    unit: 'mysql.service', port: 3306, client: 'mysql', dataDir: '/var/lib/mysql',
    async readyProbe() {
      const r = await run('mysqladmin', ['status'], 5000)
      if (r.rc === 0) {
        const m = r.stdout.match(/Threads:\s*(\d+)/)
        return { running: true, conns: m ? Number(m[1]) : null, detail: r.stdout.trim().split('\n')[0] }
      }
      return { running: false, conns: null, detail: r.stderr.trim().split('\n')[0] || 'mysqladmin status failed' }
    },
  },
  {
    id: 'redis', name: 'Redis', engine: 'redis',
    unit: 'redis.service', port: 6379, client: 'redis-cli', dataDir: '/var/lib/redis',
    async readyProbe() {
      const r = await run('redis-cli', ['ping'], 5000)
      if (r.stdout.includes('PONG')) {
        const info = await run('redis-cli', ['info', 'clients'], 5000)
        const m = info.stdout.match(/connected_clients:(\d+)/)
        return { running: true, conns: m ? Number(m[1]) : null, detail: 'redis-cli ping → PONG' }
      }
      return { running: false, conns: null, detail: r.stderr.trim() || 'redis-cli ping failed' }
    },
  },
]

async function clientVersion(client: string): Promise<string | null> {
  const r = await run(client, ['--version'], 5000)
  return r.rc === 0 ? r.stdout.trim().split('\n')[0] : null
}

// ── REAL sqlite stats (the app's own state store) ────────────────────

let sqliteVersionCache: string | null = null

async function sqliteVersion(): Promise<string> {
  if (sqliteVersionCache) return sqliteVersionCache
  // no sqlite3 CLI in many containers — ask the package manager for the
  // library version (dpkg here; pacman/rpm handled the same way)
  for (const [mgr, args] of [
    ['dpkg-query', ['-W', '-f=${Version}', 'libsqlite3-0']],
    ['pacman', ['-Q', 'sqlite']],
    ['rpm', ['-q', '--qf', '%{VERSION}', 'sqlite-libs']],
  ] as const) {
    const r = await run(mgr, [...args], 3000)
    if (r.rc === 0 && r.stdout.trim()) {
      sqliteVersionCache = `SQLite ${r.stdout.trim()} (${mgr}, system library)`
      return sqliteVersionCache
    }
  }
  sqliteVersionCache = 'SQLite (bundled with Prisma engine)'
  return sqliteVersionCache
}

async function sqliteInstance() {
  let sizeMb = 0
  try {
    sizeMb = Math.round((statSync(DB_PATH).size / (1024 * 1024)) * 10) / 10
  } catch {
    sizeMb = 0
  }
  const [auditRows, kvRows] = await Promise.all([db.auditLog.count(), db.sdKv.count()])
  return {
    id: SQLITE_ID,
    name: 'sysdeck-state',
    engine: 'sqlite',
    host: '(local file)',
    port: 0,
    status: 'running',
    sizeMb,
    conns: 1,
    version: await sqliteVersion(),
    note: `sysdeck state store — real file ${DB_PATH} (${auditRows} audit rows, ${kvRows} kv rows)`,
    real: true,
    tableCounts: { auditLog: auditRows, sdKv: kvRows },
    path: DB_PATH,
  }
}

// ── real engine instances ────────────────────────────────────────────

async function engineInstances(): Promise<
  {
    id: string
    name: string
    engine: string
    host: string
    port: number
    status: string
    sizeMb: number
    conns: number
    version: string
    note: string
  }[]
> {
  const out: {
    id: string
    name: string
    engine: string
    host: string
    port: number
    status: string
    sizeMb: number
    conns: number
    version: string
    note: string
  }[] = []
  for (const e of ENGINES) {
    const haveClient = await which(e.client)
    const active = await unitActive(e.unit)
    if (!haveClient && !active) continue
    const probe = e.readyProbe ? await e.readyProbe.call(e) : { running: active, conns: null, detail: '' }
    const sizeMb = await duMb(e.dataDir)
    const ver = haveClient ? await clientVersion(e.client) : null
    out.push({
      id: e.id,
      name: e.name,
      engine: e.engine,
      host: '127.0.0.1',
      port: e.port,
      status: probe.running ? 'running' : active ? 'running (unit active, probe unanswered)' : 'stopped',
      sizeMb,
      conns: probe.conns ?? 0,
      version: ver ?? 'client not installed',
      note: probe.detail || (active ? `${e.unit} active` : `${e.unit} inactive`),
    })
  }
  return out
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    const [sqlite, engines] = await Promise.all([sqliteInstance(), engineInstances()])
    const all = [sqlite, ...engines]
    return ok(
      {
        instances: all.length,
        running: all.filter((i) => i.status.startsWith('running')).length,
        stopped: all.filter((i) => i.status === 'stopped').length,
        engines: [...new Set(all.map((i) => i.engine))],
        totalSizeMb: Math.round(all.reduce((sum, i) => sum + i.sizeMb, 0) * 10) / 10,
        totalConns: all.reduce((sum, i) => sum + i.conns, 0),
      },
      'live',
      engines.length
        ? `real detection: systemd units + readiness probes + du of data dirs (engines: ${engines.map((e) => e.name).join(', ')})`
        : 'only the app\'s own SQLite state store exists on this host — install postgresql/mariadb/redis and they are detected live',
    )
  },

  list: async () => {
    const [sqlite, engines] = await Promise.all([sqliteInstance(), engineInstances()])
    return ok(
      { instances: [sqlite, ...engines], count: engines.length + 1 },
      'live',
      'real systemd + readiness-probe inventory (nothing seeded)',
    )
  },

  start: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    if (id === SQLITE_ID) return failE('cannot start the sysdeck state store — it is this app\'s own database and always up')
    const e = ENGINES.find((x) => x.id === id)
    if (!e) return failE('engine not detected on this host')
    const r = await run('systemctl', ['start', e.unit], 30_000)
    await audit('start', `systemctl start ${e.unit} → rc=${r.rc}`)
    if (r.rc !== 0) return failE(`systemctl start ${e.unit} failed — ${r.stderr.trim().split('\n')[0] ?? 'needs root/polkit'}`)
    return ok({ id, status: 'running', command: `systemctl start ${e.unit}` }, 'live')
  },

  stop: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    if (id === SQLITE_ID) return failE('cannot stop the sysdeck state store — it is this app\'s own database')
    const e = ENGINES.find((x) => x.id === id)
    if (!e) return failE('engine not detected on this host')
    const r = await run('systemctl', ['stop', e.unit], 30_000)
    await audit('stop', `systemctl stop ${e.unit} → rc=${r.rc}`)
    if (r.rc !== 0) return failE(`systemctl stop ${e.unit} failed — ${r.stderr.trim().split('\n')[0] ?? 'needs root/polkit'}`)
    return ok({ id, status: 'stopped', command: `systemctl stop ${e.unit}` }, 'live')
  },

  backup: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    try {
      mkdirSync('/var/backups', { recursive: true })
    } catch {
      // may exist or need root — the dump itself reports the real error
    }
    if (id === SQLITE_ID) {
      const sqlite = await sqliteInstance()
      const backupPath = `/var/backups/sysdeck-state-${ts}.db`
      try {
        copyFileSync(DB_PATH, backupPath)
      } catch (err) {
        return failE(`sqlite file copy failed — ${String(err).split('\n')[0]} (needs write access to /var/backups)`)
      }
      await audit('backup', `sqlite file copy → ${backupPath}`)
      return ok(
        {
          instance: sqlite.name,
          engine: 'sqlite',
          path: backupPath,
          sizeBytes: statSync(backupPath).size,
          sizeHuman: `${(statSync(backupPath).size / 1024 / 1024).toFixed(1)} MiB`,
          ts,
        },
        'live',
        'real file copy of the state store',
      )
    }
    const e = ENGINES.find((x) => x.id === id)
    if (!e) return failE('engine not detected on this host')
    const backupPath = `/var/backups/${e.id}-${ts}.sql.gz`
    let dumpCmd: string
    let dumpArgs: string[]
    if (e.engine === 'postgres') {
      if (!(await which('pg_dump'))) return failE('pg_dump not installed — install postgresql-client to dump this engine')
      dumpCmd = 'pg_dump'
      dumpArgs = ['-h', '127.0.0.1', '-U', 'postgres', 'postgres']
    } else {
      const dumpBin = (await which('mariadb-dump')) ? 'mariadb-dump' : (await which('mysqldump')) ? 'mysqldump' : null
      if (!dumpBin) return failE('mariadb-dump/mysqldump not installed — install the client package to dump this engine')
      dumpCmd = dumpBin
      dumpArgs = ['-h', '127.0.0.1', '--all-databases']
    }
    const pipe = await dumpToGzip(dumpCmd, dumpArgs, backupPath)
    await audit('backup', `${dumpCmd} ${dumpArgs.join(' ')} | gzip > ${backupPath} → rc=${pipe.rc}`)
    if (pipe.rc !== 0) {
      return failE(`${dumpCmd} failed — ${pipe.stderr.trim().split('\n')[0] ?? 'engine error (auth/socket)'}`)
    }
    const statSync2 = statSync(backupPath)
    return ok(
      {
        instance: e.name,
        engine: e.engine,
        path: backupPath,
        sizeBytes: statSync2.size,
        sizeHuman: `${(statSync2.size / 1024 / 1024).toFixed(1)} MiB`,
        ts,
      },
      'live',
      `real ${dumpCmd} dump`,
    )
  },
}
