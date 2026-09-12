// SysDeck bridge — vault (real LUKS inventory + real cryptsetup, live)
// Port of bridge/vault.py: the cockpit edition listed LUKS-encrypted
// block devices via `lsblk -J` (cryptsetup operations needed the
// cockpit superuser channel). The web edition:
//   - luks/entries/summary derive EVERYTHING from the REAL lsblk -J
//     inventory: a crypto_LUKS device with an open /dev/mapper child
//     is unlocked, without one it is locked — no seeded entries
//   - keyfile entries are REAL files the operator registers from the
//     filesystem (must exist; sizes stat'ed)
//   - lock runs the REAL `cryptsetup luksClose` / unlock runs the REAL
//     `cryptsetup luksOpen` — privilege-gated (root / sudo -n), honest
//     failure otherwise (the operator command is shown)
//   - backup runs the REAL `cryptsetup luksHeaderBackup`
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { ok, fail, run, which } from './shared'
import { stat } from 'fs/promises'

function failE(error: string, source: 'live' | 'hybrid' = 'live') {
  return { ...fail(error), source }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'vault', action, detail } })
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

// ── real LUKS state derivation ───────────────────────────────────────

interface VaultEntryRow {
  id: string
  label: string
  kind: 'luks-volume' | 'keyfile'
  device: string
  cipher: string
  sizeBytes: number | null // KiB for volumes, bytes for keyfiles
  status: string
  note: string
}

function parseSizeToKiB(size: string): number | null {
  const m = size.match(/^([\d.]+)\s*([KMGT]i?B)?/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? '').toUpperCase().replace('I', '')
  const mult: Record<string, number> = { B: 1 / 1024, KB: 1, K: 1, MB: 1024, M: 1024, GB: 1024 ** 2, G: 1024 ** 2, TB: 1024 ** 3, T: 1024 ** 3 }
  return Math.round(n * (mult[unit] ?? 1))
}

async function luksEntries(): Promise<VaultEntryRow[]> {
  const devices = await lsblk()
  const flat = flatten(devices)
  const rows: VaultEntryRow[] = []
  for (const d of flat) {
    if (d.fstype !== 'crypto_LUKS') continue
    // an open mapper child (type crypt) means the volume is unlocked
    const open = (d.children ?? []).find((c) => c.type === 'crypt')
    const cipher = await luksCipher(d.name)
    rows.push({
      id: `live:${d.name}`,
      label: open?.name ?? d.name,
      kind: 'luks-volume',
      device: `/dev/${d.name}`,
      cipher: cipher ?? 'crypto_LUKS',
      sizeBytes: parseSizeToKiB(d.size),
      status: open ? 'unlocked' : 'locked',
      note: open ? `open as /dev/mapper/${open.name}${open.children?.[0]?.mountpoint ? ` → ${open.children[0].mountpoint}` : ''}` : 'no open mapper — locked',
    })
  }
  return rows
}

/** real cipher query: cryptsetup luksDump <dev> | grep "Cipher name" */
async function luksCipher(devName: string): Promise<string | null> {
  if (!(await which('cryptsetup'))) return null
  const r = await run('cryptsetup', ['luksDump', `/dev/${devName}`], 8000)
  const m = r.stdout.match(/Cipher name:\s*(\S+)/)
  return m ? `${m[1]} (luksDump)` : null
}

/** registered keyfiles — REAL files only (must exist on disk) */
async function keyfileEntries(): Promise<VaultEntryRow[]> {
  const row = await db.sdKv.findUnique({ where: { key: 'vault.keyfiles' } })
  if (!row) return []
  let paths: string[] = []
  try {
    paths = JSON.parse(row.value) as string[]
  } catch {
    return []
  }
  const out: VaultEntryRow[] = []
  for (const p of paths.slice(0, 64)) {
    try {
      const s = await stat(p)
      out.push({
        id: `key:${p}`,
        label: p.split('/').pop() ?? p,
        kind: 'keyfile',
        device: p,
        cipher: '—',
        sizeBytes: s.size,
        status: 'present',
        note: `keyfile on disk (mode ${(s.mode & 0o777).toString(8)})`,
      })
    } catch {
      out.push({
        id: `key:${p}`,
        label: p.split('/').pop() ?? p,
        kind: 'keyfile',
        device: p,
        cipher: '—',
        sizeBytes: null,
        status: 'missing',
        note: 'registered keyfile no longer exists on disk',
      })
    }
  }
  return out
}

// ── privilege model ──────────────────────────────────────────────────

function isRoot(): boolean {
  return typeof process.geteuid === 'function' && process.geteuid() === 0
}

let sudoProbe: { at: number; ok: boolean } | null = null
async function havePasswordlessSudo(): Promise<boolean> {
  if (sudoProbe && Date.now() - sudoProbe.at < 60_000) return sudoProbe.ok
  const r = await run('sudo', ['-n', 'true'], 3000)
  sudoProbe = { at: Date.now(), ok: r.rc === 0 }
  return sudoProbe.ok
}

async function privilegedRun(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ rc: number; stdout: string; stderr: string; command: string } | null> {
  if (isRoot()) {
    const r = await run(cmd, args, timeoutMs)
    return { ...r, command: [cmd, ...args].join(' ') }
  }
  if (await havePasswordlessSudo()) {
    const r = await run('sudo', ['-n', cmd, ...args], timeoutMs)
    return { ...r, command: `sudo -n ${cmd} ${args.join(' ')}` }
  }
  return null
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
      luks.length === 0 ? 'real lsblk inventory — no crypto_LUKS devices on this host (nothing fabricated)' : undefined,
    )
  },

  entries: async () => {
    const [luksRows, keyRows] = await Promise.all([luksEntries(), keyfileEntries()])
    const entries = [...luksRows, ...keyRows]
    return ok(
      { entries, sizeUnit: 'KiB (volumes) / B (keyfiles)' },
      'live',
      luksRows.length
        ? 'entries derived live from lsblk -J (real LUKS state) + registered real keyfiles'
        : `real lsblk shows no crypto_LUKS devices${keyRows.length ? `; ${keyRows.length} registered keyfile(s)` : ''} — the vault fills the moment real LUKS volumes exist`,
    )
  },

  summary: async () => {
    const [luksRows, keyRows] = await Promise.all([luksEntries(), keyfileEntries()])
    const encryptedKiB = luksRows.reduce((n, e) => n + (e.sizeBytes ?? 0), 0)
    return ok(
      {
        entries: luksRows.length + keyRows.length,
        luksVolumes: luksRows.length,
        unlocked: luksRows.filter((e) => e.status === 'unlocked').length,
        locked: luksRows.filter((e) => e.status === 'locked').length,
        keyfiles: keyRows.length,
        tpmSealed: 0,
        encryptedKiB,
        encryptedGb: Math.round((encryptedKiB / 1024 ** 2) * 10) / 10,
        sizeUnit: 'KiB',
      },
      'live',
      'derived from the real lsblk inventory each call',
    )
  },

  registerKeyfile: async (args: Record<string, unknown>) => {
    const path = String(args.path ?? '').trim()
    if (!path) return failE('path is required')
    if (!path.startsWith('/')) return failE('an absolute path is required')
    try {
      await stat(path)
    } catch {
      return failE(`no such file: ${path} — keyfiles must actually exist on disk`)
    }
    const row = await db.sdKv.findUnique({ where: { key: 'vault.keyfiles' } })
    let paths: string[] = []
    if (row) {
      try {
        paths = JSON.parse(row.value) as string[]
      } catch {
        paths = []
      }
    }
    if (!paths.includes(path)) paths.push(path)
    await db.sdKv.upsert({
      where: { key: 'vault.keyfiles' },
      create: { key: 'vault.keyfiles', value: JSON.stringify(paths) },
      update: { value: JSON.stringify(paths) },
    })
    await audit('registerKeyfile', path)
    return ok({ path, registered: true }, 'live', 'real file verified on disk')
  },

  lock: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id.startsWith('live:')) return failE('lock applies to live LUKS volumes (id format live:<name>)')
    const name = id.slice(5)
    // find the REAL open mapper name for this device
    const devices = await lsblk()
    const dev = flatten(devices).find((d) => d.name === name && d.fstype === 'crypto_LUKS')
    if (!dev) return failE(`LUKS device ${name} not found in the live lsblk inventory`)
    const open = (dev.children ?? []).find((c) => c.type === 'crypt')
    if (!open) return failE(`${name} is already locked (no open mapper)`)
    const res = await privilegedRun('cryptsetup', ['luksClose', open.name])
    const command = `cryptsetup luksClose ${open.name}`
    await audit('lock', `${command} → ${res ? `rc=${res.rc}` : 'denied (unprivileged)'}`)
    if (!res) {
      return failE(`org.sysdeck.vault.modify — not authorized: run as root or grant sudo -n to execute:\n  ${command}`, 'hybrid')
    }
    if (res.rc !== 0) return failE(`${command} failed — ${res.stderr.trim().split('\n')[0] ?? 'cryptsetup error'}`)
    return ok({ id, label: open.name, status: 'locked', command }, 'live', `real ${command}`)
  },

  unlock: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id.startsWith('live:')) return failE('unlock applies to live LUKS volumes (id format live:<name>)')
    const name = id.slice(5)
    const label = String(args.label ?? name).replace(/[^a-zA-Z0-9_-]/g, '-')
    const devices = await lsblk()
    const dev = flatten(devices).find((d) => d.name === name && d.fstype === 'crypto_LUKS')
    if (!dev) return failE(`LUKS device ${name} not found in the live lsblk inventory`)
    const open = (dev.children ?? []).find((c) => c.type === 'crypt')
    if (open) return failE(`${name} is already unlocked (/dev/mapper/${open.name})`)
    // a real unlock needs a passphrase via stdin or a keyfile — the
    // web console takes a keyfile path (registered vault keyfiles work)
    const keyfile = String(args.keyfile ?? '').trim()
    if (!keyfile) {
      return failE(
        `unlock needs a key material: pass keyfile=<path> (a registered vault keyfile) — the real command is:\n  cryptsetup luksOpen /dev/${name} ${label} --key-file <path>`,
      )
    }
    const res = await privilegedRun('cryptsetup', ['luksOpen', `/dev/${name}`, label, '--key-file', keyfile])
    const command = `cryptsetup luksOpen /dev/${name} ${label} --key-file ${keyfile}`
    await audit('unlock', `${command} → ${res ? `rc=${res.rc}` : 'denied (unprivileged)'}`)
    if (!res) {
      return failE(`org.sysdeck.vault.modify — not authorized: run as root or grant sudo -n to execute:\n  ${command}`, 'hybrid')
    }
    if (res.rc !== 0) return failE(`${command} failed — ${res.stderr.trim().split('\n')[0] ?? 'wrong key or cryptsetup error'}`)
    return ok({ id, label, status: 'unlocked', command }, 'live', `real ${command}`)
  },

  backup: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id.startsWith('live:')) return failE('header backups apply to live LUKS volumes (id format live:<name>)')
    const name = id.slice(5)
    const devices = await lsblk()
    const dev = flatten(devices).find((d) => d.name === name && d.fstype === 'crypto_LUKS')
    if (!dev) return failE(`LUKS device ${name} not found in the live lsblk inventory`)
    if (!(await which('cryptsetup'))) {
      return failE('cryptsetup not installed — header backup needs cryptsetup on the host')
    }
    const date = new Date().toISOString().slice(0, 10)
    const dir = '/var/lib/sysdeck/vault/backup'
    await run('mkdir', ['-p', dir], 3000)
    const path = `${dir}/${name}-${date}.img`
    const res = await privilegedRun('cryptsetup', ['luksHeaderBackup', `/dev/${name}`, '--headerBackupFile', path])
    const command = `cryptsetup luksHeaderBackup /dev/${name} --headerBackupFile ${path}`
    await audit('backup', `${command} → ${res ? `rc=${res.rc}` : 'denied (unprivileged)'}`)
    if (!res) {
      return failE(`org.sysdeck.vault.modify — not authorized: run as root or grant sudo -n to execute:\n  ${command}`, 'hybrid')
    }
    if (res.rc !== 0) return failE(`${command} failed — ${res.stderr.trim().split('\n')[0] ?? 'cryptsetup error'}`)
    let size = 'unknown'
    let sha256: string | null = null
    try {
      const s = await stat(path)
      size = `${Math.max(1, Math.round(s.size / 1024))} KiB`
      // hash the ACTUAL header image — the operator can verify it against
      // `sha256sum <path>` on the command line
      const bytes = await (await import('fs/promises')).readFile(path)
      sha256 = createHash('sha256').update(bytes).digest('hex')
    } catch {
      /* header file unreadable — sizes stay unknown */
    }
    return ok({ entry: name, device: `/dev/${name}`, path, size, sha256, createdAt: new Date().toISOString(), command }, 'live', `real ${command}`)
  },
}
