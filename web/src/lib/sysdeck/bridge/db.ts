// SysDeck bridge — db (hybrid: REAL sqlite stats + demo engines)
// Port of bridge/db.py semantics: the cockpit edition had an
// ENGINE_REGISTRY of database engines (postgresql, mariadb, sqlite,
// redis, ...) detected via systemctl + config paths, with start/stop
// via systemd. In this sandbox only SQLite exists (the SysDeck state
// store itself), so that instance is reported with REAL stats (file
// size via fs.statSync, live table row counts, dpkg sqlite library
// version) and the other engines are a seeded demo inventory with the
// same lifecycle surface. start/stop/backup are audited.
import { statSync } from 'fs'
import path from 'path'
import { db } from '@/lib/db'
import { ok, fail, run } from './shared'

const SOURCE = 'hybrid' as const
const NOTE = 'sqlite instance is REAL (this app\'s state store); other engines are demo rows — no mariadb/postgres/redis daemons in sandbox'

const SQLITE_ID = 'sqlite-local'
const DB_PATH = path.join(process.cwd(), 'db', 'custom.db')

function failE(error: string) {
  return { ...fail(error), source: SOURCE }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'db', action, detail } })
}

// ── lazy seed (demo engines) ────────────────────────────────────────

async function ensureSeeded(): Promise<void> {
  const count = await db.dbInstance.count()
  if (count > 0) return
  await db.dbInstance.createMany({
    data: [
      {
        name: 'mariadb-main',
        engine: 'mariadb',
        host: '127.0.0.1',
        port: 3306,
        status: 'running',
        sizeMb: 2150.4,
        conns: 47,
        version: '10.11.3-MariaDB',
        note: 'main OLTP — wordpress + forgejo schemas',
      },
      {
        name: 'pg-analytics',
        engine: 'postgres',
        host: '127.0.0.1',
        port: 5432,
        status: 'running',
        sizeMb: 18432.0,
        conns: 12,
        version: 'PostgreSQL 16.3',
        note: 'analytics warehouse — timescaledb extension, nightly ETL',
      },
      {
        name: 'redis-cache',
        engine: 'redis',
        host: '127.0.0.1',
        port: 6379,
        status: 'running',
        sizeMb: 512,
        conns: 89,
        version: '7.2.5',
        note: 'session + job queue cache, maxmemory 512mb allkeys-lru',
      },
      {
        name: 'timescale-demo',
        engine: 'postgres',
        host: '127.0.0.1',
        port: 5433,
        status: 'stopped',
        sizeMb: 1024.7,
        conns: 0,
        version: 'PostgreSQL 16.1 (TimescaleDB 2.14.2)',
        note: 'metrics retention playground — stopped to save memory',
      },
    ],
  })
  await audit('seed', 'seeded demo database instances: mariadb-main, pg-analytics, redis-cache, timescale-demo')
}

// ── REAL sqlite stats ───────────────────────────────────────────────

let sqliteVersionCache: string | null = null

async function sqliteVersion(): Promise<string> {
  if (sqliteVersionCache) return sqliteVersionCache
  // no sqlite3 CLI in this container — ask dpkg for the library version
  const r = await run('dpkg-query', ['-W', '-f=${Version}', 'libsqlite3-0'], 3000)
  if (r.rc === 0 && r.stdout.trim()) {
    sqliteVersionCache = `SQLite ${r.stdout.trim()} (libsqlite3-0, via dpkg)`
  } else {
    sqliteVersionCache = 'SQLite (bundled with Prisma engine)'
  }
  return sqliteVersionCache
}

async function sqliteInstance() {
  let sizeMb = 0
  try {
    sizeMb = Math.round((statSync(DB_PATH).size / (1024 * 1024)) * 10) / 10
  } catch {
    sizeMb = 0
  }
  const [auditRows, kvRows, containerRows] = await Promise.all([
    db.auditLog.count(),
    db.sdKv.count(),
    db.container.count(),
  ])
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
    note: `sysdeck state store — real file db/custom.db (${auditRows} audit rows, ${kvRows} kv rows, ${containerRows} container rows)`,
    real: true,
    tableCounts: { auditLog: auditRows, sdKv: kvRows, container: containerRows },
    path: DB_PATH,
  }
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    await ensureSeeded()
    const rows = await db.dbInstance.findMany()
    const sqlite = await sqliteInstance()
    const all = [sqlite, ...rows]
    return ok(
      {
        instances: all.length,
        running: all.filter((i) => i.status === 'running').length,
        stopped: all.filter((i) => i.status === 'stopped').length,
        engines: [...new Set(all.map((i) => i.engine))],
        totalSizeMb: Math.round(all.reduce((sum, i) => sum + i.sizeMb, 0) * 10) / 10,
        totalConns: all.reduce((sum, i) => sum + i.conns, 0),
      },
      SOURCE,
      NOTE,
    )
  },

  list: async () => {
    await ensureSeeded()
    const rows = await db.dbInstance.findMany({ orderBy: { name: 'asc' } })
    const sqlite = await sqliteInstance()
    return ok({ instances: [sqlite, ...rows], count: rows.length + 1 }, SOURCE, NOTE)
  },

  start: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    if (id === SQLITE_ID) return failE('cannot stop or start the sysdeck state store — it is this app\'s own database')
    const inst = await db.dbInstance.findUnique({ where: { id } })
    if (!inst) return failE('instance not found')
    if (inst.status === 'running') return failE(`${inst.name} is already running`)
    const row = await db.dbInstance.update({
      where: { id },
      data: {
        status: 'running',
        conns: 1 + Math.floor(Math.random() * 8),
      },
    })
    await audit('start', `${inst.name} (${inst.engine} :${inst.port}) → running`)
    return ok({ instance: row, status: 'running' }, SOURCE, `${inst.name} started — demo state transition`)
  },

  stop: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    if (id === SQLITE_ID) return failE('cannot stop the sysdeck state store — it is this app\'s own database')
    const inst = await db.dbInstance.findUnique({ where: { id } })
    if (!inst) return failE('instance not found')
    if (inst.status === 'stopped') return failE(`${inst.name} is already stopped`)
    const row = await db.dbInstance.update({ where: { id }, data: { status: 'stopped', conns: 0 } })
    await audit('stop', `${inst.name} (${inst.engine} :${inst.port}) → stopped`)
    return ok({ instance: row, status: 'stopped' }, SOURCE, `${inst.name} stopped — demo state transition`)
  },

  backup: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    let name: string
    let engine: string
    let sizeMb: number
    if (id === SQLITE_ID) {
      const sqlite = await sqliteInstance()
      name = sqlite.name
      engine = 'sqlite'
      sizeMb = sqlite.sizeMb
    } else {
      const inst = await db.dbInstance.findUnique({ where: { id } })
      if (!inst) return failE('instance not found')
      name = inst.name
      engine = inst.engine
      sizeMb = inst.sizeMb
      if (inst.status === 'stopped') return failE(`${inst.name} is stopped — start it before dumping`)
    }
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    // a dump compresses well: ~40% of the live size, ±3% jitter
    const sizeBytes = Math.round(sizeMb * 1024 * 1024 * 0.4 * (1 + (Math.random() - 0.5) * 0.06))
    const backupPath = `/var/backups/${name}-${ts}.sql.gz`
    await audit('backup', `${name} (${engine}) → ${backupPath} (${(sizeBytes / 1024 / 1024).toFixed(1)} MiB simulated dump)`)
    return ok(
      {
        instance: name,
        engine,
        path: backupPath,
        sizeBytes,
        sizeHuman: `${(sizeBytes / 1024 / 1024).toFixed(1)} MiB`,
        ts,
      },
      SOURCE,
      'simulated dump — no real pg_dump/mariadb-dump in sandbox (sqlite included: the app store is not dumped from here)',
    )
  },
}
