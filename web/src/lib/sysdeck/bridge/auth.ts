// SysDeck bridge — auth (demo PKCS#11 / smartcard identity bridge)
// Port of bridge/auth.py semantics: the cockpit edition aggregated
// PKCS#11 token slots (opensc pkcs11-tool --list-token-slots), readers
// detected via lsusb, pcscd service state, SSH keys and Kerberos
// principals. No opensc/pcscd exists in this sandbox, so the web
// edition keeps the same surface (readers, certs, session state,
// unlock) over SdKv-seeded state. unlock() simulates the card PIN
// verification, including the ISO 7816 '6982' status word on a wrong
// PIN. The demo PIN is 123456.
import { db } from '@/lib/db'
import { ok, fail } from './shared'

const SOURCE = 'demo' as const
const NOTE = 'opensc/pcsc-lite absent — demo reader inventory (demo PIN: 123456)'

function failE(error: string) {
  return { ...fail(error), source: SOURCE }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'auth', action, detail } })
}

// ── state (SdKv) ────────────────────────────────────────────────────

interface Reader {
  id: string
  name: string
  vendor: string
  slots: number
  pinSupport: string
  present: boolean
}

interface Cert {
  id: string
  label: string
  kind: string
  keyType: string
  subject: string
  notBefore: string
  notAfter: string
}

interface SessionState {
  loggedIn: boolean
  reader: string | null
  slot: number | null
  mechanism: string | null
  ts: string | null
}

const SEED_READERS: Reader[] = [
  { id: '1050:0407', name: 'YubiKey 5C NFC', vendor: 'Yubico', slots: 2, pinSupport: 'PIN + PUK (9a/9c PIV slots)', present: true },
  { id: '0723:9069', name: 'SmartCard Reader USB', vendor: 'Generic (Alcor Micro AU9540)', slots: 1, pinSupport: 'PIN', present: false },
]

const SEED_CERTS: Cert[] = [
  {
    id: 'cert-piv-auth',
    label: 'jeremy@dcos.net',
    kind: 'PIV authentication (slot 9a)',
    keyType: 'RSA-2048',
    subject: 'CN=jeremy@dcos.net, O=dcos.net',
    notBefore: '2024-03-14T00:00:00Z',
    notAfter: '2027-03-14T00:00:00Z',
  },
  {
    id: 'cert-piv-sig',
    label: 'jeremy code-signing',
    kind: 'PIV digital signature (slot 9c)',
    keyType: 'RSA-2048',
    subject: 'CN=jeremy code-signing, O=dcos.net',
    notBefore: '2024-11-02T00:00:00Z',
    notAfter: '2026-11-02T00:00:00Z',
  },
  {
    id: 'cert-vpn',
    label: 'VPN client cert',
    kind: 'openvpn client (PKCS#11)',
    keyType: 'ECDSA P-384',
    subject: 'CN=jeremy-vpn, O=dcos.net',
    notBefore: '2025-03-01T00:00:00Z',
    // seeded 12 days out so the expiry stays "realistic soon"
    notAfter: new Date(Date.now() + 12 * 86400000).toISOString(),
  },
  {
    id: 'cert-backup',
    label: 'expired backup key',
    kind: 'PIV backup (slot 82)',
    keyType: 'RSA-3072',
    subject: 'CN=backup-key, O=dcos.net',
    notBefore: '2022-08-15T00:00:00Z',
    notAfter: '2023-08-15T00:00:00Z',
  },
]

const SEED_SESSION: SessionState = { loggedIn: false, reader: null, slot: null, mechanism: null, ts: null }

async function ensureSeeded(): Promise<void> {
  const existing = await db.sdKv.findUnique({ where: { key: 'auth.readers' } })
  if (existing) return
  try {
    await db.sdKv.createMany({
      data: [
        { key: 'auth.readers', value: JSON.stringify(SEED_READERS) },
        { key: 'auth.certs', value: JSON.stringify(SEED_CERTS) },
        { key: 'auth.session', value: JSON.stringify(SEED_SESSION) },
      ],
    })
  } catch {
    return // concurrent seed won
  }
  await audit('seed', 'seeded demo reader inventory: YubiKey 5C NFC + generic SmartCard Reader, 4 certs')
}

async function getReaders(): Promise<Reader[]> {
  const row = await db.sdKv.findUnique({ where: { key: 'auth.readers' } })
  return row ? (JSON.parse(row.value) as Reader[]) : []
}

async function getCerts(): Promise<Cert[]> {
  const row = await db.sdKv.findUnique({ where: { key: 'auth.certs' } })
  return row ? (JSON.parse(row.value) as Cert[]) : []
}

async function getSession(): Promise<SessionState> {
  const row = await db.sdKv.findUnique({ where: { key: 'auth.session' } })
  return row ? (JSON.parse(row.value) as SessionState) : SEED_SESSION
}

async function putSession(state: SessionState) {
  await db.sdKv.upsert({
    where: { key: 'auth.session' },
    create: { key: 'auth.session', value: JSON.stringify(state) },
    update: { value: JSON.stringify(state), ts: new Date() },
  })
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  readers: async () => {
    await ensureSeeded()
    const readers = await getReaders()
    return ok({ readers, count: readers.length, pcscd: 'not installed (sandbox)' }, SOURCE, NOTE)
  },

  certs: async () => {
    await ensureSeeded()
    const certs = await getCerts()
    const now = Date.now()
    return ok(
      {
        certs: certs.map((c) => ({
          ...c,
          status: now > Date.parse(c.notAfter) ? 'expired' : Date.parse(c.notAfter) - now < 30 * 86400000 ? 'expiring' : 'valid',
          daysLeft: Math.round((Date.parse(c.notAfter) - now) / 86400000),
        })),
        count: certs.length,
      },
      SOURCE,
      NOTE,
    )
  },

  sessions: async () => {
    await ensureSeeded()
    const session = await getSession()
    const readers = await getReaders()
    const certs = await getCerts()
    return ok(
      { session, slots: readers.flatMap((r) => Array.from({ length: r.slots }, (_, i) => ({ reader: r.name, slot: i, token: r.present ? 'present' : 'empty' }))), availableCerts: certs.length },
      SOURCE,
      NOTE,
    )
  },

  unlock: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const reader = String(args.reader ?? '').trim()
    const pin = String(args.pin ?? '')
    if (!reader) return failE('reader is required (reader id, e.g. 1050:0407)')
    if (!pin) return failE('pin is required')
    const readers = await getReaders()
    const r = readers.find((x) => x.id === reader || x.name === reader)
    if (!r) return failE(`reader '${reader}' not found — available: ${readers.map((x) => x.id).join(', ')}`)
    if (!r.present) return failE(`no card present in '${r.name}'`)
    if (pin !== '123456') {
      await audit('unlock', `FAILED PIN verification on ${r.name} (reader ${r.id}) — SW=6982`)
      return failE('verification failed: SW=6982 (security status not satisfied) — wrong PIN, 2 attempts left before card lock')
    }
    const state: SessionState = {
      loggedIn: true,
      reader: r.name,
      slot: 0,
      mechanism: 'PKCS#11 C_Login (CKU_USER, slot 0)',
      ts: new Date().toISOString(),
    }
    await putSession(state)
    await audit('unlock', `unlocked ${r.name} (reader ${r.id}) — PKCS#11 session opened on slot 0`)
    return ok(
      { session: state, reader: r.name, slots: r.slots },
      SOURCE,
      'simulated C_Login — demo PIN 123456, wrong PINs return the ISO 7816 6982 status word',
    )
  },

  lock: async () => {
    await ensureSeeded()
    const session = await getSession()
    if (!session.loggedIn) return failE('no open PKCS#11 session')
    await putSession({ loggedIn: false, reader: null, slot: null, mechanism: null, ts: null })
    await audit('lock', `closed PKCS#11 session on ${session.reader} (slot ${session.slot})`)
    return ok({ session: SEED_SESSION, locked: true }, SOURCE)
  },
}
