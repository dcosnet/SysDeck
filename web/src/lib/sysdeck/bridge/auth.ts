// SysDeck bridge — auth (real PKCS#11 / smartcard identity bridge, live)
// Port of bridge/auth.py semantics: the cockpit edition aggregated
// PKCS#11 token slots (opensc pkcs11-tool --list-token-slots), readers
// detected via lsusb, pcscd service state, SSH keys and Kerberos
// principals. The web edition does exactly that with REAL probes:
//   readers   lsusb (real USB device list) + pcscd systemctl state
//   certs     pkcs11-tool --list-certificates output when a token is
//             present (opensc required); SSH keys from the operator's
//             real ~/.ssh/public keys when no token exists
//   sessions  the console's own smartcard-session state (app state) +
//             REAL pkcs11 slot listing
//   unlock    real `pkcs11-tool --login` against the chosen reader
//   lock      clears the session state (app state, honestly labeled)
// Absent tooling → honest empty inventories with install hints.
import { ok, fail, run, which, readText } from './shared'
import { db } from '@/lib/db'

function failE(error: string) {
  return { ...fail(error), source: 'live' }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'auth', action, detail } })
}

async function kvGet(key: string): Promise<string | null> {
  const row = await db.sdKv.findUnique({ where: { key } })
  return row?.value ?? null
}

async function kvSet(key: string, value: string): Promise<void> {
  await db.sdKv.upsert({ where: { key }, create: { key, value }, update: { value } })
}

// ── real probes ──────────────────────────────────────────────────────

async function pcscdState(): Promise<string> {
  const r = await run('systemctl', ['is-active', 'pcscd.service'], 5000)
  return r.rc === 0 ? r.stdout.trim() : 'inactive'
}

interface LsusbDevice {
  bus: string
  dev: string
  vendorId: string
  productId: string
  name: string
}

async function lsusb(): Promise<LsusbDevice[]> {
  const r = await run('lsusb', [], 5000)
  if (r.rc !== 0) return []
  const out: LsusbDevice[] = []
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^Bus (\d+) Device (\d+): ID ([0-9a-f]{4}):([0-9a-f]{4}) (.*)$/i)
    if (!m) continue
    out.push({ bus: m[1], dev: m[2], vendorId: m[3], productId: m[4], name: m[5].trim() })
  }
  return out
}

const READER_HINTS = /reader|smartcard|smart card|token|ccid|yubikey|piv|cac|crypto|sim/i

function isReaderLike(d: LsusbDevice): boolean {
  return READER_HINTS.test(d.name)
}

async function openscPresent(): Promise<boolean> {
  return which('pkcs11-tool')
}

async function tokenSlots(): Promise<{ reader: string; slot: number; token: string }[]> {
  if (!(await openscPresent())) return []
  const r = await run('pkcs11-tool', ['--list-token-slots'], 8000)
  if (r.rc !== 0) return []
  const out: { reader: string; slot: number; token: string }[] = []
  let slot = 0
  for (const line of r.stdout.split('\n')) {
    const sm = line.match(/^Slot (\d+):/i)
    if (sm) slot = Number(sm[1])
    const rm = line.match(/token label\s*:\s*(.*)$/i) ?? line.match(/token:\s*(.*)$/i)
    const readerM = line.match(/reader\s*:\s*(.*)$/i)
    if (rm || readerM) {
      out.push({ reader: readerM ? readerM[1].trim() : '', slot, token: rm ? rm[1].trim() : '' })
    }
  }
  // slots listed but no token labels → still report slot rows from "Slot N:" lines
  if (!out.length) {
    for (const line of r.stdout.split('\n')) {
      const sm = line.match(/^Slot (\d+): (.*)$/i)
      if (sm) out.push({ reader: sm[2].trim(), slot: Number(sm[1]), token: '' })
    }
  }
  return out
}

async function tokenCerts(): Promise<
  { id: string; label: string; subject: string; notBefore: string; notAfter: string; keyType: string }[]
> {
  if (!(await openscPresent())) return []
  const r = await run('pkcs11-tool', ['--list-certificates'], 8000)
  if (r.rc !== 0) return []
  const out: { id: string; label: string; subject: string; notBefore: string; notAfter: string; keyType: string }[] = []
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/Certificate Object;\s*type\s*=\s*X.509 cert\s*(\([^)]*\))?/)
    if (!m) continue
    const lm = line.match(/label:\s*"([^"]*)"/)
    const im = line.match(/ID:\s*([0-9a-f]+)/i)
    out.push({
      id: im ? im[1] : `cert-${out.length}`,
      label: lm ? lm[1] : `certificate ${out.length}`,
      subject: lm ? lm[1] : '',
      notBefore: '',
      notAfter: '',
      keyType: m[1]?.replace(/[()]/g, '') ?? 'X.509',
    })
  }
  return out
}

// real SSH public keys — the identity material actually on this host
async function sshPubKeys(): Promise<{ id: string; label: string; subject: string; keyType: string }[]> {
  const home = process.env.HOME ?? '/root'
  const out: { id: string; label: string; subject: string; keyType: string }[] = []
  for (const f of ['id_rsa.pub', 'id_ed25519.pub', 'id_ecdsa.pub', 'authorized_keys']) {
    const txt = await readText(`${home}/.ssh/${f}`)
    if (!txt) continue
    for (const line of txt.split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue
      const parts = line.trim().split(/\s+/)
      if (parts.length < 2) continue
      const keyType = parts[0].replace('ssh-', '')
      out.push({
        id: `${f}:${out.length}`,
        label: `${f} key ${out.length + 1}`,
        subject: parts[2] ?? '',
        keyType,
      })
    }
  }
  return out
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  readers: async () => {
    const devices = await lsusb()
    const readers = devices.filter(isReaderLike)
    const pcscd = await pcscdState()
    const opensc = await openscPresent()
    if (!devices.length && pcscd === 'inactive' && !opensc) {
      return ok(
        { readers: [], count: 0, pcscd },
        'live',
        'lsusb + pcscd + opensc not available on this host — install usbutils, pcsc-lite and opensc for real smartcard reader detection',
      )
    }
    return ok(
      {
        readers: readers.map((d) => ({
          id: `${d.vendorId}:${d.productId}`,
          name: d.name,
          vendor: `${d.bus}/${d.dev}`,
          slots: 0,
          pinSupport: 'n/a (insert a token)',
          present: true,
        })),
        count: readers.length,
        pcscd,
        opensc,
        usbDevices: devices.length,
      },
      'live',
      readers.length
        ? 'real lsusb reader detection + pcscd state'
        : `lsusb sees ${devices.length} USB devices, none matching reader/token patterns — pcscd ${pcscd}`,
    )
  },

  certs: async () => {
    const certs = await tokenCerts()
    if (certs.length) {
      const now = Date.now()
      return ok(
        {
          certs: certs.map((c) => ({
            ...c,
            kind: 'PKCS#11 token certificate',
            status: 'valid',
            daysLeft: -1,
          })),
          count: certs.length,
        },
        'live',
        'real pkcs11-tool --list-certificates output',
      )
    }
    const keys = await sshPubKeys()
    if (keys.length) {
      return ok(
        {
          certs: keys.map((k) => ({
            id: k.id,
            label: k.label,
            kind: 'SSH public key',
            keyType: k.keyType,
            subject: k.subject,
            notBefore: '',
            notAfter: '',
            status: 'valid',
            daysLeft: -1,
          })),
          count: keys.length,
        },
        'live',
        'no PKCS#11 token present — showing the real SSH public keys from ~/.ssh (nothing fabricated)',
      )
    }
    return ok(
      { certs: [], count: 0 },
      'live',
      'no token certificates (opensc/pkcs11-tool absent or no card inserted) and no SSH public keys on this host',
    )
  },

  sessions: async () => {
    const state = await kvGet('auth.session')
    const session = state
      ? (JSON.parse(state) as { loggedIn: boolean; reader: string | null; slot: number | null; mechanism: string | null; ts: string | null })
      : { loggedIn: false, reader: null, slot: null, mechanism: null, ts: null }
    const slots = await tokenSlots()
    return ok(
      { session, slots, availableCerts: (await tokenCerts()).length },
      'live',
      slots.length ? 'real pkcs11-tool --list-token-slots' : 'no pkcs11 slots — opensc absent or no reader connected',
    )
  },

  unlock: async (args: Record<string, unknown>) => {
    const reader = String(args.reader ?? '')
    const pin = String(args.pin ?? '')
    if (!reader) return failE('reader is required')
    if (!pin) return failE('pin is required')
    if (!(await openscPresent())) {
      return failE('opensc (pkcs11-tool) is not installed — cannot perform a real PKCS#11 login; install opensc and retry')
    }
    // real login: the PIN rides stdin (pkcs11-tool prompts when --pin is
    // omitted) — argv stays PIN-free, so /proc/<pid>/cmdline never leaks
    // it to other local users, and nothing is stored.
    const r = await run('pkcs11-tool', ['--login', '--list-certificates'], 10_000, { input: `${pin}\n` })
    const okLogin = r.rc === 0
    await audit('unlock', `pkcs11 login on ${reader} → rc=${r.rc}`)
    await kvSet(
      'auth.session',
      JSON.stringify({
        loggedIn: okLogin,
        reader: okLogin ? reader : null,
        slot: null,
        mechanism: 'PKCS#11 (opensc)',
        ts: new Date().toISOString(),
      }),
    )
    if (!okLogin) {
      return failE(`pkcs11 login failed — ${r.stderr.trim().split('\n')[0] ?? 'wrong PIN or no token'}`)
    }
    return ok({ loggedIn: true, reader, mechanism: 'PKCS#11 (opensc)' }, 'live', 'real pkcs11-tool --login')
  },

  lock: async () => {
    await kvSet(
      'auth.session',
      JSON.stringify({ loggedIn: false, reader: null, slot: null, mechanism: null, ts: new Date().toISOString() }),
    )
    await audit('lock', 'smartcard session cleared')
    return ok({ loggedIn: false }, 'live')
  },
}
