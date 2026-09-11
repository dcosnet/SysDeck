// SysDeck bridge — vault (LUKS volumes + encryption vault entries)
// Port of bridge/vault.py: the cockpit edition listed LUKS-encrypted
// block devices via `lsblk -J` (cryptsetup operations needed the
// cockpit superuser channel). The web edition keeps the real lsblk
// inventory (no crypto_LUKS in this container — honestly reported) and
// adds a VaultEntry-backed vault (the cockpit edition's
// /var/lib/sysdeck/vault state): lock/unlock toggle recorded state,
// backup returns a simulated header-backup record. Real LUKS
// operations require the cockpit bridge on a managed host.
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { ok, fail, run } from './shared'

/** fail() + source → the dispatcher spreads this into a top-level
 *  {ok:false, error, source} envelope. (A bare fail() lacks data/source
 *  keys, so the dispatcher would wrap it as {ok:true, data:{ok:false}}.) */
function failE(error: string, source: 'live' | 'demo' | 'hybrid' = 'hybrid') {
  return { ...fail(error), source }
}

interface BlockDevice {
  name: string
  size: string
  fstype: string | null
  mountpoint: string | null
  type: string
  children?: BlockDevice[]
}

async function lsblk(): Promise<BlockDevice[]> {
  const r = await run('lsblk', ['-J', '-o', 'NAME,SIZE,FSTYPE,MOUNTPOINT,TYPE'], 5000)
  if (r.rc !== 0 || !r.stdout) return []
  try {
    const parsed = JSON.parse(r.stdout) as { blockdevices?: BlockDevice[] }
    return parsed.blockdevices ?? []
  } catch {
    return []
  }
}

function flatten(devices: BlockDevice[]): BlockDevice[] {
  const out: BlockDevice[] = []
  const walk = (d: BlockDevice) => {
    out.push(d)
    for (const c of d.children ?? []) walk(c)
  }
  for (const d of devices) walk(d)
  return out
}

// ── seeding ─────────────────────────────────────────────────────────

// UNIT NOTE: the frozen schema declares VaultEntry.sizeBytes as Prisma
// `Int` (32-bit signed) — multi-TB byte counts do not fit and make every
// findMany() throw "Conversion failed". Vault rows therefore store the
// size in KIBIBYTES (exact for all seeded values, Int32-safe); the note
// field carries the human-readable size. Responses expose a `sizeUnit`
// hint so panels render units correctly.
const SIZE_UNIT = 'KiB'
const INT32_MAX = 2_147_483_647

async function repairOversized(): Promise<void> {
  // Rows seeded by the earlier stub session stored raw bytes (2e12 /
  // 5e11) — every read of those rows throws. Convert them to KiB once
  // (matched by device/label so each row gets its own conversion), and
  // normalize the sub-KiB rows to the same unit convention.
  await db.vaultEntry.updateMany({
    where: { sizeBytes: { gt: INT32_MAX }, device: '/dev/sdb1' },
    data: { sizeBytes: 1_953_125_000, note: 'data pool — 2 TB' },
  })
  await db.vaultEntry.updateMany({
    where: { sizeBytes: { gt: INT32_MAX }, device: '/dev/nvme0n1p2' },
    data: { sizeBytes: 488_281_250, note: 'OS root — 500 GB' },
  })
  await db.vaultEntry.updateMany({
    where: { device: '/etc/luks/keys/pool.key', sizeBytes: 4096 },
    data: { sizeBytes: 4, note: 'keyfile for data-pool on root fs (mode 0400) — 4096 B' },
  })
  await db.vaultEntry.updateMany({
    where: { device: 'tpm0', sizeBytes: 32 },
    data: { sizeBytes: null, note: 'TPM2.0 seal 256-bit — 32 B' },
  })
}

async function ensureSeeded(): Promise<void> {
  const count = await db.vaultEntry.count()
  if (count > 0) {
    await repairOversized()
    return
  }
  await db.vaultEntry.createMany({
    data: [
      {
        label: 'data-pool',
        kind: 'luks-volume',
        device: '/dev/sdb1',
        cipher: 'aes-xts-plain64',
        sizeBytes: 1_953_125_000, // 2 TB in KiB
        status: 'unlocked',
        note: 'data pool — 2 TB',
      },
      {
        label: 'os-root',
        kind: 'luks-volume',
        device: '/dev/nvme0n1p2',
        cipher: 'aes-xts-plain64',
        sizeBytes: 488_281_250, // 500 GB in KiB
        status: 'locked',
        note: 'OS root — 500 GB',
      },
      {
        label: 'pool-key',
        kind: 'keyfile',
        device: '/etc/luks/keys/pool.key',
        sizeBytes: 4, // 4096 B in KiB
        status: 'sealed',
        note: 'keyfile for data-pool on root fs (mode 0400) — 4096 B',
      },
      {
        label: 'tpm-sealed root key',
        kind: 'tpm-sealed',
        device: 'tpm0',
        cipher: 'TPM2.0 seal 256-bit',
        sizeBytes: null, // 32 B — below 1 KiB
        status: 'sealed',
        note: 'TPM2.0 seal 256-bit — 32 B',
      },
    ],
  })
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  luks: async () => {
    const devices = await lsblk()
    const flat = flatten(devices)
    const luks = flat
      .filter((d) => d.fstype === 'crypto_LUKS')
      .map((d) => ({ name: d.name, size: d.size, mountpoint: d.mountpoint ?? '', type: d.type }))
    return ok(
      {
        luks,
        devices: flat.map((d) => ({
          name: d.name,
          size: d.size,
          fstype: d.fstype,
          mountpoint: d.mountpoint,
          type: d.type,
        })),
      },
      'live',
      luks.length === 0 ? 'real lsblk inventory — no crypto_LUKS devices in this container' : undefined,
    )
  },

  entries: async () => {
    await ensureSeeded()
    const entries = await db.vaultEntry.findMany({ orderBy: { label: 'asc' } })
    return ok(
      { entries, sizeUnit: SIZE_UNIT },
      'hybrid',
      'entry list seeded (demo vault); sizeBytes is in KiB — real LUKS state requires the cockpit bridge on a managed host',
    )
  },

  summary: async () => {
    await ensureSeeded()
    const entries = await db.vaultEntry.findMany()
    const luks = entries.filter((e) => e.kind === 'luks-volume')
    const encryptedKiB = luks.reduce((n, e) => n + (e.sizeBytes ?? 0), 0)
    return ok(
      {
        entries: entries.length,
        luksVolumes: luks.length,
        unlocked: luks.filter((e) => e.status === 'unlocked').length,
        locked: luks.filter((e) => e.status === 'locked').length,
        keyfiles: entries.filter((e) => e.kind === 'keyfile').length,
        tpmSealed: entries.filter((e) => e.kind === 'tpm-sealed').length,
        encryptedKiB,
        encryptedGb: Math.round((encryptedKiB / 1024 ** 2) * 10) / 10,
        sizeUnit: SIZE_UNIT,
      },
      'hybrid',
    )
  },

  lock: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    const entry = await db.vaultEntry.findUnique({ where: { id } })
    if (!entry) return failE('vault entry not found')
    if (entry.kind !== 'luks-volume') return failE(`lock/unlock applies to LUKS volumes (entry is ${entry.kind})`)
    await db.vaultEntry.update({ where: { id }, data: { status: 'locked' } })
    await db.auditLog.create({
      data: { module: 'vault', action: 'lock', detail: `${entry.label} (${entry.device})` },
    })
    return ok(
      { id, label: entry.label, status: 'locked' },
      'hybrid',
      'state change recorded — LUKS operations require the cockpit bridge on a managed host',
    )
  },

  unlock: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    const entry = await db.vaultEntry.findUnique({ where: { id } })
    if (!entry) return failE('vault entry not found')
    if (entry.kind !== 'luks-volume') return failE(`lock/unlock applies to LUKS volumes (entry is ${entry.kind})`)
    await db.vaultEntry.update({ where: { id }, data: { status: 'unlocked' } })
    await db.auditLog.create({
      data: { module: 'vault', action: 'unlock', detail: `${entry.label} (${entry.device})` },
    })
    return ok(
      { id, label: entry.label, status: 'unlocked' },
      'hybrid',
      'state change recorded — LUKS operations require the cockpit bridge on a managed host',
    )
  },

  backup: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    const entry = await db.vaultEntry.findUnique({ where: { id } })
    if (!entry) return failE('vault entry not found')
    if (entry.kind !== 'luks-volume') return failE('header backups apply to LUKS volumes')
    const date = new Date().toISOString().slice(0, 10)
    const safeName = (entry.label ?? 'entry').replace(/[^a-zA-Z0-9._-]/g, '-')
    const path = `/var/lib/sysdeck/vault/backup/${safeName}-${date}.img`
    const sha256 = createHash('sha256').update(`${entry.id}:${entry.device}:${date}`).digest('hex')
    await db.auditLog.create({
      data: { module: 'vault', action: 'backup', detail: `${entry.label} → ${path}` },
    })
    return ok(
      {
        entry: entry.label,
        device: entry.device,
        path,
        size: '16MB',
        sha256,
        createdAt: new Date().toISOString(),
      },
      'hybrid',
      'simulated header backup record — an actual cryptsetup luksHeaderBackup requires the cockpit bridge on a managed host',
    )
  },
}
