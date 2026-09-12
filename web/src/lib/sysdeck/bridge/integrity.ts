// SysDeck bridge — integrity (tripwire-style file integrity monitoring)
// Port of bridge/integrity.py: the cockpit edition ran a lynis audit and
// parsed the hardening index (lynis is absent here). The web edition
// implements the tripwire SEMANTICS natively: sha256 baselines over a
// fixed set of real system files (plus a sentinel file operators can
// edit to watch drift detection work), re-hash on check, and drift rows
// (modified/added/removed) persisted in IntegrityDrift. All hashes are
// real — nothing is seeded.
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { db } from '@/lib/db'
import { ok, fail } from './shared'

/** fail() + source → the dispatcher spreads this into a top-level
 *  {ok:false, error, source} envelope. (A bare fail() lacks data/source
 *  keys, so the dispatcher would wrap it as {ok:true, data:{ok:false}}.) */
function failE(error: string, source: 'live' | 'hybrid' = 'live') {
  return { ...fail(error), source }
}

const TARGETS = [
  '/etc/passwd',
  '/etc/group',
  '/etc/shadow', // included only when readable
  '/etc/hosts',
  '/etc/resolv.conf',
  '/etc/hostname',
  '/etc/os-release',
  '/etc/debian_version',
  '/bin/sh',
  '/bin/ls',
  '/usr/bin/env',
  '/usr/bin/python3',
  '/usr/bin/dpkg',
] as const

const SENTINEL = '/var/tmp/sysdeck-integrity-sentinel'
const SENTINEL_CONTENT =
  'sysdeck integrity sentinel v1\n' +
  'This file is baselined by the integrity module.\n' +
  'Edit it (or delete it) to watch drift detection report a real change.\n'

const LAST_CHECK_KV = 'integrity.lastCheck'

// ── hashing helpers ──────────────────────────────────────────────────

type HashResult = { hash: string; size: number } | 'missing' | 'unreadable'

function hashFile(path: string): HashResult {
  try {
    const buf = readFileSync(path)
    return { hash: createHash('sha256').update(buf).digest('hex'), size: buf.length }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'missing'
    return 'unreadable' // e.g. EACCES on /etc/shadow
  }
}

function ensureSentinel(): boolean {
  if (existsSync(SENTINEL)) return true
  try {
    writeFileSync(SENTINEL, SENTINEL_CONTENT, { mode: 0o644 })
    return true
  } catch {
    return false
  }
}

function monitoredPaths(): string[] {
  return [...TARGETS, SENTINEL]
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  baseline: async () => {
    const created = ensureSentinel()
    const baselined: { path: string; hash: string; size: number }[] = []
    const skipped: { path: string; reason: string }[] = []
    for (const path of monitoredPaths()) {
      const r = hashFile(path)
      if (r === 'missing') {
        skipped.push({ path, reason: 'not present on this host' })
        continue
      }
      if (r === 'unreadable') {
        skipped.push({ path, reason: 'not readable (permissions)' })
        continue
      }
      await db.integrityBaseline.upsert({
        where: { path },
        create: { path, hash: r.hash, kind: 'file' },
        update: { hash: r.hash, ts: new Date() },
      })
      baselined.push({ path, hash: r.hash, size: r.size })
    }
    await db.auditLog.create({
      data: {
        module: 'integrity',
        action: 'baseline',
        detail: `${baselined.length} files hashed (sha256), ${skipped.length} skipped`,
      },
    })
    return ok(
      {
        baselined: baselined.length,
        files: baselined,
        skipped,
        sentinel: { path: SENTINEL, created },
        ts: new Date().toISOString(),
      },
      'live',
      'sha256 baselines of real files; edit the sentinel to see drift on the next check',
    )
  },

  check: async () => {
    const baselines = await db.integrityBaseline.findMany()
    if (baselines.length === 0) {
      return failE('no baseline yet — run the baseline command first')
    }
    const baselineMap = new Map(baselines.map((b) => [b.path, b.hash]))
    const drift: { path: string; change: string; oldHash: string | null; newHash: string | null }[] = []
    const unreadable: string[] = []

    // 1. baseline rows: modified / removed
    for (const [path, oldHash] of baselineMap) {
      const r = hashFile(path)
      if (r === 'missing') {
        drift.push({ path, change: 'removed', oldHash, newHash: null })
      } else if (r === 'unreadable') {
        unreadable.push(path)
      } else if (r.hash !== oldHash) {
        drift.push({ path, change: 'modified', oldHash, newHash: r.hash })
      }
    }
    // 2. monitored targets with no baseline row: added
    for (const path of monitoredPaths()) {
      if (baselineMap.has(path)) continue
      const r = hashFile(path)
      if (r === 'missing' || r === 'unreadable') continue
      drift.push({ path, change: 'added', oldHash: null, newHash: r.hash })
    }

    // persist: one unresolved row per (path, change); refresh newHash if
    // the file keeps moving, create a fresh row once the old one is resolved.
    for (const d of drift) {
      const existing = await db.integrityDrift.findFirst({
        where: { path: d.path, change: d.change, resolved: false },
        orderBy: { detected: 'desc' },
      })
      if (existing) {
        await db.integrityDrift.update({
          where: { id: existing.id },
          data: { newHash: d.newHash, detected: new Date() },
        })
      } else {
        await db.integrityDrift.create({
          data: { path: d.path, change: d.change, oldHash: d.oldHash, newHash: d.newHash },
        })
      }
    }

    const ts = new Date().toISOString()
    await db.sdKv.upsert({
      where: { key: LAST_CHECK_KV },
      create: { key: LAST_CHECK_KV, value: ts },
      update: { value: ts },
    })
    await db.auditLog.create({
      data: {
        module: 'integrity',
        action: 'check',
        detail: drift.length === 0 ? 'clean' : `${drift.length} drift(s): ${drift.map((d) => `${d.change}:${d.path}`).join(', ')}`,
      },
    })

    return ok(
      {
        clean: drift.length === 0 && unreadable.length === 0,
        drift,
        checked: baselineMap.size,
        unreadable,
        lastCheck: ts,
      },
      'live',
      drift.length === 0
        ? 'all monitored files match the baseline'
        : 're-hash differs from baseline — see drift rows',
    )
  },

  drifts: async () => {
    const drifts = await db.integrityDrift.findMany({ orderBy: { detected: 'desc' } })
    return ok(
      {
        drifts,
        unresolved: drifts.filter((d) => !d.resolved).length,
        total: drifts.length,
      },
      'live',
    )
  },

  resolve: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    try {
      const row = await db.integrityDrift.update({ where: { id }, data: { resolved: true } })
      await db.auditLog.create({
        data: { module: 'integrity', action: 'resolve', detail: `${row.change}:${row.path}` },
      })
      return ok({ resolved: { path: row.path, change: row.change, detected: row.detected } }, 'live')
    } catch {
      return failE('drift not found')
    }
  },

  summary: async () => {
    const [monitored, driftRows, lastCheck] = await Promise.all([
      db.integrityBaseline.count(),
      db.integrityDrift.findMany({ where: { resolved: false } }),
      db.sdKv.findUnique({ where: { key: LAST_CHECK_KV } }),
    ])
    return ok(
      {
        monitored,
        drift: driftRows.length,
        driftRows,
        lastCheck: lastCheck?.value ?? null,
        sentinel: SENTINEL,
        baselined: monitored > 0,
      },
      'live',
      monitored === 0
        ? 'no baseline yet — run the baseline command to hash the monitored set'
        : undefined,
    )
  },
}
