// SysDeck bridge — mining (demo rig fleet)
// Port of bridge/mining.py semantics: the cockpit edition talked to the
// local XMRig daemon's HTTP API (/1/summary: live hashrate, pool,
// threads; /1/config for pool-config-set) and xmrig.service state. This
// sandbox has no miner, so the web edition keeps the same surface over
// a seeded MiningRig/MiningGpu fleet (rig + per-GPU hashrate/temp/fan)
// where `refresh` random-walks the live values on online rigs.
import { db } from '@/lib/db'
import { ok, fail } from './shared'

const SOURCE = 'demo' as const
const NOTE = 'no mining daemons (xmrig/bosminer) in sandbox — demo rig fleet with live random-walk values'

function failE(error: string) {
  return { ...fail(error), source: SOURCE }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'mining', action, detail } })
}

// ── lazy seed ───────────────────────────────────────────────────────

const RIGS = [
  {
    name: 'basement-1',
    host: '10.0.0.21',
    coins: 'BTC',
    status: 'online',
    hashrate: 1680,
    powerW: 2400,
    tempC: 66.5,
    pool: 'stratum+tcp://us.stratum.slushpool.com',
    gpus: { model: 'RTX 4090', count: 6, unitHashrate: 280 },
  },
  {
    name: 'garage-2',
    host: '10.0.0.22',
    coins: 'BTC',
    status: 'online',
    hashrate: 1120,
    powerW: 2200,
    tempC: 63.2,
    pool: 'stratum+tcp://us.stratum.slushpool.com',
    gpus: { model: 'RTX 3090', count: 8, unitHashrate: 140 },
  },
  {
    name: 'attic-3',
    host: '10.0.0.23',
    coins: 'BTC',
    status: 'idle',
    hashrate: 0,
    powerW: 0,
    tempC: 78.4,
    pool: 'stratum+tcp://us.stratum.slushpool.com',
    gpus: { model: 'RTX 4070 Ti', count: 4, unitHashrate: 0 },
  },
  {
    name: 'solar-1',
    host: '10.0.0.24',
    coins: 'BTC',
    status: 'offline',
    hashrate: 0,
    powerW: 0,
    tempC: 0,
    pool: 'stratum+tcp://solo.ckpool.org',
    gpus: { model: 'Antminer S19', count: 12, unitHashrate: 0 },
  },
]

async function ensureSeeded(): Promise<void> {
  const count = await db.miningRig.count()
  if (count > 0) return
  for (const rig of RIGS) {
    await db.miningRig.create({
      data: {
        name: rig.name,
        host: rig.host,
        coins: rig.coins,
        status: rig.status,
        hashrate: rig.hashrate,
        powerW: rig.powerW,
        tempC: rig.tempC,
        pool: rig.pool,
        gpus: {
          create: Array.from({ length: rig.gpus.count }, (_, i) => ({
            model: rig.gpus.model,
            hashrate: rig.status === 'online' ? Math.round(rig.gpus.unitHashrate * (0.94 + Math.random() * 0.12) * 10) / 10 : 0,
            tempC: rig.status === 'online' ? Math.round(56 + Math.random() * 18) : rig.status === 'idle' ? Math.round(70 + Math.random() * 10) : 0,
            fanPct: rig.status === 'online' ? Math.round(55 + Math.random() * 30) : 0,
          })),
        },
      },
    })
  }
  await audit('seed', 'seeded demo rig fleet: basement-1 (6×4090), garage-2 (8×3090), attic-3 (4×4070Ti idle), solar-1 (12×S19 offline)')
}

// ── helpers ─────────────────────────────────────────────────────────

async function rigsWithGpus() {
  return db.miningRig.findMany({ include: { gpus: true }, orderBy: { name: 'asc' } })
}

function walk(value: number, pct: number, lo: number, hi: number): number {
  const next = value * (1 + (Math.random() - 0.5) * 2 * pct)
  return Math.round(Math.min(hi, Math.max(lo, next)) * 10) / 10
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    await ensureSeeded()
    const rigs = await rigsWithGpus()
    const online = rigs.filter((r) => r.status === 'online')
    const totalHashrate = Math.round(rigs.reduce((sum, r) => sum + r.hashrate, 0) * 10) / 10
    const totalPower = rigs.reduce((sum, r) => sum + r.powerW, 0)
    const gpuTemps = online.flatMap((r) => r.gpus.map((g) => g.tempC))
    const avgTemp = gpuTemps.length ? Math.round((gpuTemps.reduce((s, t) => s + t, 0) / gpuTemps.length) * 10) / 10 : 0
    return ok(
      {
        rigs: rigs.length,
        online: online.length,
        idle: rigs.filter((r) => r.status === 'idle').length,
        offline: rigs.filter((r) => r.status === 'offline').length,
        totalHashrate,
        totalPower,
        avgTemp,
      },
      SOURCE,
      NOTE,
    )
  },

  list: async () => {
    await ensureSeeded()
    const rigs = await rigsWithGpus()
    return ok({ rigs, count: rigs.length }, SOURCE, NOTE)
  },

  refresh: async () => {
    await ensureSeeded()
    const rigs = await rigsWithGpus()
    for (const rig of rigs) {
      if (rig.status !== 'online') continue
      await db.miningRig.update({
        where: { id: rig.id },
        data: {
          hashrate: walk(rig.hashrate, 0.03, rig.hashrate * 0.9, rig.hashrate * 1.1),
          powerW: walk(rig.powerW, 0.02, rig.powerW * 0.95, rig.powerW * 1.05),
          tempC: walk(rig.tempC, 0.02, rig.tempC - 2, rig.tempC + 2),
        },
      })
      for (const gpu of rig.gpus) {
        await db.miningGpu.update({
          where: { id: gpu.id },
          data: {
            hashrate: walk(gpu.hashrate, 0.03, gpu.hashrate * 0.85, gpu.hashrate * 1.15),
            tempC: walk(gpu.tempC, 0.03, gpu.tempC - 3, gpu.tempC + 3),
            fanPct: Math.round(Math.min(100, Math.max(40, gpu.fanPct + (Math.random() - 0.5) * 8))),
          },
        })
      }
    }
    const after = await rigsWithGpus()
    await audit('refresh', `random-walked live values on ${rigs.filter((r) => r.status === 'online').length} online rigs`)
    return ok({ rigs: after, count: after.length }, SOURCE, 'live values random-walked (±3% hashrate, ±3% temps)')
  },

  start: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const rig = await db.miningRig.findUnique({ where: { id }, include: { gpus: true } })
    if (!rig) return failE('rig not found')
    if (rig.status === 'online') return failE(`${rig.name} is already online`)
    const nominal = RIGS.find((r) => r.name === rig.name)
    const rigHash = nominal ? nominal.hashrate : 500
    const unit = nominal ? nominal.gpus.unitHashrate : 80
    const row = await db.miningRig.update({
      where: { id },
      data: { status: 'online', hashrate: rigHash, powerW: nominal?.powerW ?? 1000, tempC: 64 },
    })
    for (const gpu of rig.gpus) {
      await db.miningGpu.update({
        where: { id: gpu.id },
        data: { hashrate: unit, tempC: walk(63, 0.05, 55, 70), fanPct: 70 },
      })
    }
    await audit('start', `rig ${rig.name} → online (nominal ${rigHash} TH/s, ${rig.gpus.length}× ${rig.gpus[0]?.model ?? 'GPU'})`)
    return ok(
      { rig: { ...row, gpus: await db.miningGpu.findMany({ where: { rigId: id } }) }, status: 'online' },
      SOURCE,
      `${rig.name} started — demo state transition`,
    )
  },

  stop: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const rig = await db.miningRig.findUnique({ where: { id }, include: { gpus: true } })
    if (!rig) return failE('rig not found')
    if (rig.status === 'offline') return failE(`${rig.name} is already offline`)
    const row = await db.miningRig.update({
      where: { id },
      data: { status: 'offline', hashrate: 0, powerW: 0, tempC: 0 },
    })
    for (const gpu of rig.gpus) {
      await db.miningGpu.update({ where: { id: gpu.id }, data: { hashrate: 0, tempC: 0, fanPct: 0 } })
    }
    await audit('stop', `rig ${rig.name} → offline (hashrate/power zeroed)`)
    return ok({ rig: row, status: 'offline' }, SOURCE, `${rig.name} stopped — demo state transition`)
  },
}
