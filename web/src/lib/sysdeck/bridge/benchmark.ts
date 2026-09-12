// SysDeck bridge — benchmark (REAL micro-benchmarks)
// Port of bridge/benchmark.py: the cockpit edition wrapped sysbench /
// phoronix-test-suite via subprocess. Neither is installed here (and
// they would need root + long runtimes), so the web edition ports the
// SUITE SEMANTICS to native Node micro-benchmarks that actually
// execute: integer/float/string rounds for cpu, Buffer write+verify
// bandwidth for memory, chunked file write/read through /tmp for
// disk. Scores are computed from measured wall-clock time — no
// fabricated numbers. Results persist to BenchmarkResult + AuditLog.
import { writeFileSync, readFileSync, unlinkSync } from 'fs'
import os from 'os'
import { db } from '@/lib/db'
import { ok, fail } from './shared'

/** fail() + source → the dispatcher spreads this into a top-level
 *  {ok:false, error, source} envelope. (A bare fail() lacks data/source
 *  keys, so the dispatcher would wrap it as {ok:true, data:{ok:false}}.) */
function failE(error: string, source: 'live' | 'hybrid' = 'live') {
  return { ...fail(error), source }
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

// ── cpu suite ────────────────────────────────────────────────────────
// 3 rounds: 50M integer additions, 50M Math.sqrt, 100k string
// concatenations. A checksum accumulator keeps the JIT from
// eliminating the work.

function cpuSuite(): { score: number; metric: string; detail: Record<string, unknown> } {
  const rounds = 3
  const intOps = 50_000_000
  const floatOps = 50_000_000
  const stringOps = 100_000

  let sink = 0
  const t0 = performance.now()
  for (let r = 0; r < rounds; r++) {
    let acc = 0
    for (let i = 0; i < intOps; i++) acc = (acc + i) | 0
    sink += acc
    let facc = 0
    for (let i = 0; i < floatOps; i++) facc += Math.sqrt(i)
    sink += Math.round(facc)
    let s = ''
    const chunk = '0123456789abcdef'
    for (let i = 0; i < stringOps; i++) s += chunk
    sink += s.length
  }
  const ms = performance.now() - t0
  const totalOps = rounds * (intOps + floatOps + stringOps)
  const score = Math.round(1_000_000 / Math.max(0.001, ms))
  return {
    score,
    metric: 'score = round(1e6 / total ms) — higher is better',
    detail: {
      rounds,
      intOpsPerRound: intOps,
      floatOpsPerRound: floatOps,
      stringOpsPerRound: stringOps,
      totalMs: round(ms),
      opsPerSec: Math.round(totalOps / (ms / 1000)),
      checksum: sink,
      cores: os.cpus().length,
      cpuModel: os.cpus()[0]?.model?.trim() ?? 'unknown',
    },
  }
}

// ── memory suite ─────────────────────────────────────────────────────
// 4 × 64MB Buffers, write a pattern, read it back and verify.

function memorySuite(): { score: number; metric: string; detail: Record<string, unknown> } {
  const bufs: Buffer[] = []
  const count = 4
  const eachMb = 64
  const eachBytes = eachMb * 1024 * 1024

  const t0 = performance.now()
  for (let b = 0; b < count; b++) {
    const buf = Buffer.alloc(eachBytes)
    const pattern = (b * 37 + 11) & 0xff
    buf.fill(pattern)
    bufs.push(buf)
  }
  const writeMs = performance.now() - t0

  const t1 = performance.now()
  let sink = 0
  for (const buf of bufs) {
    const step = 4096
    for (let i = 0; i < buf.length; i += step) sink = (sink + buf[i]) & 0xffff
  }
  const readMs = performance.now() - t1

  const totalMb = count * eachMb
  const writeMbps = totalMb / (writeMs / 1000)
  const readMbps = totalMb / (readMs / 1000)
  const bandwidth = (totalMb * 2) / ((writeMs + readMs) / 1000)
  return {
    score: Math.round(bandwidth),
    metric: 'MB/s combined write+read bandwidth (4 × 64MB buffers)',
    detail: {
      buffers: count,
      bufferMb: eachMb,
      totalMb,
      writeMs: round(writeMs),
      readMs: round(readMs),
      writeMbps: round(writeMbps),
      readMbps: round(readMbps),
      checksum: sink,
      memTotalGb: round(os.totalmem() / 1024 ** 3),
    },
  }
}

// ── disk suite ───────────────────────────────────────────────────────
// 64MB written to /tmp in 1MB chunks, read back, deleted.

function diskSuite(): { score: number; metric: string; detail: Record<string, unknown> } | null {
  const path = '/tmp/sysdeck-benchmark-1b.bin'
  const totalMb = 64
  const chunkMb = 1
  const chunk = Buffer.alloc(chunkMb * 1024 * 1024, 0x5a)
  try {
    const t0 = performance.now()
    for (let i = 0; i < totalMb / chunkMb; i++) {
      writeFileSync(path, chunk, { flag: i === 0 ? 'w' : 'a' })
    }
    const writeMs = performance.now() - t0

    const t1 = performance.now()
    const readBack = readFileSync(path)
    const readMs = performance.now() - t1

    const verified = readBack.length === totalMb * 1024 * 1024 && readBack[0] === 0x5a && readBack[readBack.length - 1] === 0x5a
    const writeMbps = totalMb / (writeMs / 1000)
    const readMbps = totalMb / (readMs / 1000)
    return {
      score: Math.round((writeMbps + readMbps) / 2),
      metric: 'MB/s (average of 64MB write + 64MB read on /tmp)',
      detail: {
        path,
        totalMb,
        chunkMb,
        writeMs: round(writeMs),
        readMs: round(readMs),
        writeMbps: round(writeMbps),
        readMbps: round(readMbps),
        verified,
      },
    }
  } catch {
    return null
  } finally {
    try {
      unlinkSync(path)
    } catch {
      /* already gone */
    }
  }
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  run: async (args: Record<string, unknown>) => {
    const suite = String(args.suite ?? '').trim()
    const started = Date.now()
    let result: { score: number; metric: string; detail: Record<string, unknown> } | null = null
    if (suite === 'cpu') result = cpuSuite()
    else if (suite === 'memory') result = memorySuite()
    else if (suite === 'disk') result = diskSuite()
    else return failE(`unknown suite: ${suite} (expected cpu | memory | disk)`)

    if (!result) return failE('disk benchmark failed — /tmp not writable?')
    const durationMs = Date.now() - started

    await db.benchmarkResult.create({
      data: {
        suite,
        score: result.score,
        metric: result.metric,
        detail: JSON.stringify(result.detail).slice(0, 2000),
      },
    })
    await db.auditLog.create({
      data: { module: 'benchmark', action: 'run', detail: `suite=${suite} score=${result.score}` },
    })

    return ok(
      { suite, ...result, durationMs },
      'live',
      'real measured micro-benchmark (Node native), stored to BenchmarkResult',
    )
  },

  history: async () => {
    const rows = await db.benchmarkResult.findMany({ orderBy: { ts: 'desc' }, take: 20 })
    const bySuite: Record<string, { score: number; ts: string }[]> = {}
    for (const row of rows) {
      const runs = (bySuite[row.suite] ??= [])
      runs.push({ score: row.score, ts: row.ts.toISOString() })
    }
    return ok(
      {
        suites: bySuite,
        total: rows.length,
        last: rows[0] ? { suite: rows[0].suite, score: rows[0].score, ts: rows[0].ts.toISOString() } : null,
      },
      'live',
      'last 20 runs grouped by suite',
    )
  },
}
