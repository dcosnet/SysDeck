/**
 * Fester store — SQLite persistence (bun:sqlite).
 * Port of backend/storage/sqlite_db.py: builds / sessions / events /
 * node_states tables, WAL mode, serialized writes.
 */

import { Database } from 'bun:sqlite'
import { join } from 'path'
import type { FesterEvent } from './events'

const DB_PATH = process.env.FESTER_DB_PATH ?? join(import.meta.dir, 'fester.db')

export class Store {
  private db: Database
  private writeLock: Promise<unknown> = Promise.resolve()

  constructor() {
    this.db = new Database(DB_PATH, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS builds (
        build_id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        targets TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        started_at REAL NOT NULL,
        finished_at REAL,
        actions_total INTEGER DEFAULT 0,
        actions_done INTEGER DEFAULT 0,
        actions_failed INTEGER DEFAULT 0,
        cache_hits INTEGER DEFAULT 0,
        critical_path_ms INTEGER,
        rc INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        build_id TEXT,
        label TEXT,
        created_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL NOT NULL,
        build_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS node_states (
        name TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        cpu_load REAL,
        memory_load REAL,
        temp REAL,
        active_jobs INTEGER,
        instability REAL,
        score REAL,
        updated_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_build ON events(build_id, id);
    `)
    // additive migrations AFTER the base schema exists (fresh DB safe)
    this.migrate()
  }

  /** Additive schema migrations (safe to re-run on every boot / hot reload). */
  private migrate() {
    const cols = (this.db.query("PRAGMA table_info('builds')").all() as { name: string }[]).map((c) => c.name)
    if (!cols.includes('note')) this.db.exec('ALTER TABLE builds ADD COLUMN note TEXT')
    if (!cols.includes('meta')) this.db.exec('ALTER TABLE builds ADD COLUMN meta TEXT')
  }

  /** Boot fix: a build left 'running' by a previous process never finished —
   *  mark it failed with a "service restarted" note so the UI never shows a
   *  phantom in-flight build. Returns the builds that were fixed. */
  markStaleRunningFailed(): { build_id: string }[] {
    const stale = this.db
      .query("SELECT build_id FROM builds WHERE state IN ('running','queued')")
      .all() as { build_id: string }[]
    if (stale.length === 0) return []
    const fix = this.db.query(
      "UPDATE builds SET state = 'failed', note = 'service restarted', rc = 1 WHERE state IN ('running','queued')",
    )
    fix.run()
    return stale
  }

  /** Serialize writes through a single promise chain (threading.Lock equivalent). */
  private write<T>(fn: () => T): Promise<T> {
    const run = this.writeLock.then(fn)
    this.writeLock = run.catch(() => undefined)
    return run
  }

  createBuild(
    buildId: string,
    project: string,
    targets: string[],
    opts: { startedAt?: number; state?: string; meta?: Record<string, unknown>; note?: string } = {},
  ) {
    return this.write(() => {
      this.db
        .query(
          'INSERT OR REPLACE INTO builds (build_id, project, targets, state, started_at, note, meta) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          buildId,
          project,
          JSON.stringify(targets),
          opts.state ?? 'queued',
          opts.startedAt ?? Date.now() / 1000,
          opts.note ?? null,
          opts.meta ? JSON.stringify(opts.meta) : null,
        )
    })
  }

  updateBuild(buildId: string, fields: Partial<Record<string, string | number | null>>) {
    return this.write(() => {
      const keys = Object.keys(fields)
      if (keys.length === 0) return
      const sets = keys.map((k) => `${k} = ?`).join(', ')
      this.db
        .query(`UPDATE builds SET ${sets} WHERE build_id = ?`)
        .run(...keys.map((k) => fields[k] as string | number | null), buildId)
    })
  }

  getBuild(buildId: string) {
    const row = this.db.query('SELECT * FROM builds WHERE build_id = ?').get(buildId) as Record<string, unknown> | null
    return row ? withParsedMeta(row) : null
  }

  listBuilds(limit = 50) {
    return this.db
      .query('SELECT * FROM builds ORDER BY started_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[]
  }

  appendEvent(event: FesterEvent) {
    return this.write(() => {
      const { type, timestamp, ...payload } = event
      this.db
        .query('INSERT INTO events (ts, build_id, type, payload) VALUES (?,?,?,?)')
        .run(timestamp, event.build_id ?? null, type, JSON.stringify(payload))
    })
  }

  listEvents(buildId: string | null, limit = 500) {
    if (buildId) {
      return (
        this.db
          .query('SELECT * FROM events WHERE build_id = ? ORDER BY id LIMIT ?')
          .all(buildId, limit) as Record<string, unknown>[]
      ).map(parseEventRow)
    }
    return (
      this.db.query('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]
    )
      .reverse()
      .map(parseEventRow)
  }

  /** Cursor-based replay: only events with id > after (per build, or global). */
  listEventsAfter(buildId: string | null, after: number, limit = 5000) {
    if (buildId) {
      return (
        this.db
          .query('SELECT * FROM events WHERE build_id = ? AND id > ? ORDER BY id LIMIT ?')
          .all(buildId, after, limit) as Record<string, unknown>[]
      ).map(parseEventRow)
    }
    return (
      this.db.query('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(after, limit) as Record<string, unknown>[]
    ).map(parseEventRow)
  }

  countEvents(buildId: string): number {
    return (this.db.query('SELECT COUNT(*) AS c FROM events WHERE build_id = ?').get(buildId) as { c: number }).c
  }

  /** Journal cap: drop the k oldest events of a build. */
  trimEvents(buildId: string, k: number) {
    return this.write(() => {
      this.db
        .query('DELETE FROM events WHERE id IN (SELECT id FROM events WHERE build_id = ? ORDER BY id ASC LIMIT ?)')
        .run(buildId, k)
    })
  }

  buildCount(): number {
    return (this.db.query('SELECT COUNT(*) AS c FROM builds').get() as { c: number }).c
  }

  // ── sessions (replay sessions, port of backend/session semantics) ─────

  /** Synchronous insert (bun:sqlite ops are sync) — POST /api/sessions reads
   *  the row back immediately after this returns, so it must not be queued
   *  behind the async write chain. */
  createSession(buildId: string, label?: string, opts: { createdAt?: number } = {}): string {
    const sessionId = `sess-${Math.floor(Date.now() / 1000).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    try {
      this.db
        .query('INSERT INTO sessions (session_id, build_id, label, created_at) VALUES (?,?,?,?)')
        .run(sessionId, buildId, label ?? null, opts.createdAt ?? Date.now() / 1000)
    } catch (err) {
      console.error('[fester:store] session insert failed', err)
    }
    return sessionId
  }

  listSessions() {
    return (
      this.db
        .query(
          `SELECT s.session_id, s.build_id, s.label, s.created_at,
                  b.project, b.state AS build_state, b.started_at, b.finished_at,
                  b.actions_total, b.actions_done, b.actions_failed, b.cache_hits,
                  b.critical_path_ms, b.rc, b.note, b.meta
           FROM sessions s LEFT JOIN builds b ON s.build_id = b.build_id
           ORDER BY s.created_at DESC`,
        )
        .all() as Record<string, unknown>[]
    ).map(withParsedMeta)
  }

  getSession(sessionId: string) {
    const row = this.db
      .query(
        `SELECT s.session_id, s.build_id, s.label, s.created_at,
                b.project, b.state AS build_state, b.started_at, b.finished_at,
                b.actions_total, b.actions_done, b.actions_failed, b.cache_hits,
                b.critical_path_ms, b.rc, b.note, b.meta
         FROM sessions s LEFT JOIN builds b ON s.build_id = b.build_id
         WHERE s.session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | null
    return row ? withParsedMeta(row) : null
  }

  // ── metrics aggregation (computed from history) ──────────────────

  buildStateCounts(): Record<string, number> {
    const rows = this.db.query('SELECT state, COUNT(*) AS c FROM builds GROUP BY state').all() as {
      state: string
      c: number
    }[]
    return Object.fromEntries(rows.map((r) => [r.state, r.c]))
  }

  buildActionSums(): { total: number; done: number; failed: number; cache_hits: number } {
    return this.db
      .query(
        `SELECT COALESCE(SUM(actions_total),0) AS total, COALESCE(SUM(actions_done),0) AS done,
                COALESCE(SUM(actions_failed),0) AS failed, COALESCE(SUM(cache_hits),0) AS cache_hits
         FROM builds`,
      )
      .get() as { total: number; done: number; failed: number; cache_hits: number }
  }

  /** Per-node share of scheduled actions over the whole event history. */
  nodeUtilization(): Map<string, number> {
    const counts = new Map<string, number>()
    let total = 0
    const rows = this.db.query("SELECT payload FROM events WHERE type = 'task_update'").all() as {
      payload: string
    }[]
    for (const row of rows) {
      try {
        const p = JSON.parse(row.payload) as { state?: string; node?: string }
        if (p.state === 'scheduled' && p.node) {
          counts.set(p.node, (counts.get(p.node) ?? 0) + 1)
          total += 1
        }
      } catch {
        /* skip malformed row */
      }
    }
    const pct = new Map<string, number>()
    for (const [node, c] of counts) pct.set(node, Math.round((c / Math.max(1, total)) * 1000) / 10)
    return pct
  }

  upsertNodeState(s: {
    name: string
    state: string
    cpu_load?: number
    memory_load?: number
    temp?: number
    active_jobs?: number
    instability?: number
    score?: number
  }) {
    return this.write(() => {
      this.db
        .query(
          `INSERT INTO node_states (name, state, cpu_load, memory_load, temp, active_jobs, instability, score, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(name) DO UPDATE SET
             state=excluded.state, cpu_load=excluded.cpu_load, memory_load=excluded.memory_load,
             temp=excluded.temp, active_jobs=excluded.active_jobs, instability=excluded.instability,
             score=excluded.score, updated_at=excluded.updated_at`,
        )
        .run(
          s.name as string,
          s.state as string,
          (s.cpu_load as number) ?? 0,
          (s.memory_load as number) ?? 0,
          (s.temp as number) ?? 0,
          (s.active_jobs as number) ?? 0,
          (s.instability as number) ?? 0,
          (s.score as number) ?? 0,
          Date.now() / 1000,
        )
    })
  }

  listNodeStates() {
    return this.db.query('SELECT * FROM node_states ORDER BY name').all() as Record<string, unknown>[]
  }

  close() {
    this.db.close()
  }
}

function parseEventRow(row: Record<string, unknown>): Record<string, unknown> {
  const payload = JSON.parse(String(row.payload ?? '{}'))
  return { id: row.id, ts: row.ts, build_id: row.build_id, type: row.type, ...payload }
}

function withParsedMeta(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row }
  if (typeof out.meta === 'string') {
    try {
      out.meta = JSON.parse(out.meta)
    } catch {
      /* keep raw string */
    }
  }
  if (typeof out.targets === 'string') {
    try {
      out.targets = JSON.parse(out.targets)
    } catch {
      /* keep raw string */
    }
  }
  return out
}
