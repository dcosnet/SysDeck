// SysDeck bridge — hwalert (hybrid: the orphaned 628-line bridge, finally
// ported)
// Port of bridge/hwalert.py: hardware-intrusion indicators — foreign USB
// mass storage, DMA-capable Thunderbolt, rogue Bluetooth pairings, new
// PCI devices, firmware tamper — with a persisted policy (the python kept
// /etc/sysdeck/hw-policy.json; we keep the same defaults in SdKv
// 'hwalert.policy'), device whitelist, and per-alert state. The python
// scanned /sys/bus/usb, /sys/bus/thunderbolt, hciconfig and lspci; this
// sandbox has none of those buses populated, so the device inventory is
// seeded, but `scan` reads the REAL DMI product name for host identity
// and re-detects (idempotently — no alert spam) a new PCI device.
import { readFileSync } from 'fs'
import { db } from '@/lib/db'
import { ok, fail, readText } from './shared'

const SOURCE = 'hybrid' as const
const NOTE = 'usb/thunderbolt/bluetooth/pci buses are empty in this container — seeded device inventory + REAL DMI host identity; policy/whitelist/alert state persist in the db'

function failE(error: string) {
  return { ...fail(error), source: SOURCE }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'hwalert', action, detail } })
}

// ── policy (DEFAULT_POLICY from hwalert.py, persisted in SdKv) ──────

const DEFAULT_POLICY: Record<string, boolean> = {
  blockUsbStorage: true,
  blockThunderboltDMA: true,
  blockFirewireDMA: true,
  blockUnknownBluetooth: true,
  blockUnknownPCI: false,
  autoBlock: true,
  alertOnly: false,
  whitelistEnforced: true,
}

const POLICY_KEYS = Object.keys(DEFAULT_POLICY)

const POLICY_DESCRIPTIONS: Record<string, string> = {
  blockUsbStorage: 'block foreign USB mass storage devices (authorized=0)',
  blockThunderboltDMA: 'block unauthorized DMA-capable Thunderbolt devices',
  blockFirewireDMA: 'block FireWire DMA (physical memory access)',
  blockUnknownBluetooth: 'alert on untrusted Bluetooth pairing attempts',
  blockUnknownPCI: 'alert on previously-unseen PCI devices (noisy on laptops)',
  autoBlock: 'auto-block violating devices instead of only alerting',
  alertOnly: 'never block, only alert (overrides autoBlock)',
  whitelistEnforced: 'require devices to be whitelisted before use',
}

async function getPolicy(): Promise<Record<string, boolean>> {
  const row = await db.sdKv.findUnique({ where: { key: 'hwalert.policy' } })
  if (row) return { ...DEFAULT_POLICY, ...(JSON.parse(row.value) as Record<string, boolean>) }
  return { ...DEFAULT_POLICY }
}

async function putPolicy(policy: Record<string, boolean>) {
  await db.sdKv.upsert({
    where: { key: 'hwalert.policy' },
    create: { key: 'hwalert.policy', value: JSON.stringify(policy) },
    update: { value: JSON.stringify(policy), ts: new Date() },
  })
}

// ── lazy seed ───────────────────────────────────────────────────────

const SEED_DEVICES = [
  { deviceId: 'usb:0781:5583', kind: 'usb-storage', name: 'SanDisk Extreme 128GB', vendor: 'SanDisk', authorized: false, whitelisted: false },
  { deviceId: 'usb:1050:0407', kind: 'usb', name: 'YubiKey 5C NFC', vendor: 'Yubico', authorized: true, whitelisted: true },
  { deviceId: 'usb:0853:0100', kind: 'usb', name: 'HHKB Professional HYBRID Type-S', vendor: 'PFU (Topre)', authorized: true, whitelisted: true },
  { deviceId: 'tb:8087:0b40', kind: 'thunderbolt', name: 'CalDigit TS4 Dock', vendor: 'CalDigit', authorized: false, whitelisted: false },
  { deviceId: 'bt:00:1A:7D', kind: 'bluetooth', name: 'rogue pairing attempt', vendor: 'unknown', authorized: false, whitelisted: false },
  { deviceId: 'pci:8086:2723', kind: 'pci', name: 'Intel Wi-Fi 6 AX200 (NGFF)', vendor: 'Intel', authorized: true, whitelisted: false },
]

const SEED_ALERTS = [
  {
    deviceId: 'usb:0781:5583',
    kind: 'unauthorized-usb',
    severity: 'danger',
    message: 'Foreign USB mass storage detected: SanDisk Extreme 128GB (SanDisk) at /dev/sdb — auto-blocked (blockUsbStorage)',
    state: 'active',
  },
  {
    deviceId: 'tb:8087:0b40',
    kind: 'dma-thunderbolt',
    severity: 'danger',
    message: 'Unauthorized DMA-capable Thunderbolt device: CalDigit TS4 Dock (CalDigit) — DMA blocked pending authorization',
    state: 'active',
  },
  {
    deviceId: 'bt:00:1A:7D',
    kind: 'rogue-bluetooth',
    severity: 'warn',
    message: 'Untrusted Bluetooth pairing attempt from 00:1A:7D:9E:F2:61 (device name: rogue pairing attempt)',
    state: 'acknowledged',
  },
  {
    deviceId: 'pci:8086:2723',
    kind: 'new-pci',
    severity: 'info',
    message: 'New PCI device present: Intel Wi-Fi 6 AX200 (vendor 8086:2723) — not previously seen',
    state: 'active',
  },
  {
    deviceId: 'pci:8086:0f00',
    kind: 'firmware-tamper',
    severity: 'warn',
    message: 'Firmware tamper indicator: ME region hash changed since last boot (dismissed by operator — BIOS flash expected)',
    state: 'dismissed',
  },
]

async function ensureSeeded(): Promise<void> {
  const count = await db.hwDevice.count()
  if (count > 0) return
  await db.hwDevice.createMany({ data: SEED_DEVICES })
  await db.hwAlert.createMany({ data: SEED_ALERTS })
  await putPolicy({ ...DEFAULT_POLICY })
  await audit('seed', 'seeded demo hardware inventory: 6 devices (usb-storage, 2×usb, thunderbolt, bluetooth, pci) + 5 alerts')
}

// ── DMI host identity (REAL) ────────────────────────────────────────

function hostIdentity(): string {
  try {
    const name = readFileSync('/sys/class/dmi/id/product_name', 'utf-8').trim()
    const vendor = readFileSync('/sys/class/dmi/id/sys_vendor', 'utf-8').trim()
    return name || vendor || 'unknown DMI'
  } catch {
    return 'unknown (no DMI in this container)'
  }
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    await ensureSeeded()
    const [devices, alerts, policy] = await Promise.all([
      db.hwDevice.findMany(),
      db.hwAlert.findMany(),
      getPolicy(),
    ])
    const bySeverity: Record<string, number> = {}
    for (const a of alerts) bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1
    return ok(
      {
        activeAlerts: alerts.filter((a) => a.state === 'active').length,
        alerts: alerts.length,
        bySeverity,
        devices: devices.length,
        unauthorizedDevices: devices.filter((d) => !d.authorized).length,
        policy,
        whitelistCount: devices.filter((d) => d.whitelisted).length,
      },
      SOURCE,
      NOTE,
    )
  },

  devices: async () => {
    await ensureSeeded()
    const devices = await db.hwDevice.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }] })
    return ok(
      {
        devices: devices.map((d) => ({
          ...d,
          dmaCapable: d.kind === 'thunderbolt' || d.kind === 'pci' || d.kind === 'firewire',
          blocked: !d.authorized,
        })),
        count: devices.length,
      },
      SOURCE,
      NOTE,
    )
  },

  alerts: async () => {
    await ensureSeeded()
    const alerts = await db.hwAlert.findMany({ orderBy: { ts: 'desc' } })
    return ok(
      { alerts, count: alerts.length, activeCount: alerts.filter((a) => a.state === 'active').length },
      SOURCE,
      NOTE,
    )
  },

  acknowledge: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const alert = await db.hwAlert.findUnique({ where: { id } })
    if (!alert) return failE('alert not found')
    if (alert.state === 'acknowledged') return failE('alert is already acknowledged')
    const row = await db.hwAlert.update({ where: { id }, data: { state: 'acknowledged' } })
    await audit('acknowledge', `alert ${alert.kind} (${alert.severity}) → acknowledged: ${alert.message.slice(0, 80)}`)
    return ok({ alert: row, state: 'acknowledged' }, SOURCE)
  },

  dismiss: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const alert = await db.hwAlert.findUnique({ where: { id } })
    if (!alert) return failE('alert not found')
    if (alert.state === 'dismissed') return failE('alert is already dismissed')
    const row = await db.hwAlert.update({ where: { id }, data: { state: 'dismissed' } })
    await audit('dismiss', `alert ${alert.kind} (${alert.severity}) → dismissed: ${alert.message.slice(0, 80)}`)
    return ok({ alert: row, state: 'dismissed' }, SOURCE)
  },

  block: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const deviceId = String(args.deviceId ?? '')
    if (!deviceId) return failE('deviceId is required')
    const device = await db.hwDevice.findUnique({ where: { deviceId } })
    if (!device) return failE(`device '${deviceId}' not found`)
    if (!device.authorized) return failE(`${device.name} is already blocked`)
    const row = await db.hwDevice.update({ where: { deviceId }, data: { authorized: false } })
    await audit('block', `${device.name} (${deviceId}) blocked — authorized=0`)
    return ok(
      { device: row, result: 'blocked', method: device.kind === 'usb-storage' || device.kind === 'usb' ? 'usb-authorize' : 'udev-rule' },
      SOURCE,
      'demo block — the registry state changed; on a managed host this writes 0 to the sysfs authorized file',
    )
  },

  unblock: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const deviceId = String(args.deviceId ?? '')
    if (!deviceId) return failE('deviceId is required')
    const device = await db.hwDevice.findUnique({ where: { deviceId } })
    if (!device) return failE(`device '${deviceId}' not found`)
    if (device.authorized) return failE(`${device.name} is not blocked`)
    const row = await db.hwDevice.update({ where: { deviceId }, data: { authorized: true } })
    await audit('unblock', `${device.name} (${deviceId}) unblocked — authorized=1`)
    return ok({ device: row, result: 'unblocked' }, SOURCE)
  },

  whitelist: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const deviceId = String(args.deviceId ?? '')
    if (!deviceId) return failE('deviceId is required')
    const device = await db.hwDevice.findUnique({ where: { deviceId } })
    if (!device) return failE(`device '${deviceId}' not found`)
    if (device.whitelisted) return failE(`${device.name} is already whitelisted`)
    const row = await db.hwDevice.update({ where: { deviceId }, data: { whitelisted: true, authorized: true } })
    await audit('whitelist', `${device.name} (${deviceId}) added to whitelist`)
    return ok(
      { device: row, entry: { vendorId: deviceId.split(':')[1]?.split(':')[0], productId: deviceId.split(':').pop(), name: device.name, busType: device.kind } },
      SOURCE,
    )
  },

  unwhitelist: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const deviceId = String(args.deviceId ?? '')
    if (!deviceId) return failE('deviceId is required')
    const device = await db.hwDevice.findUnique({ where: { deviceId } })
    if (!device) return failE(`device '${deviceId}' not found`)
    if (!device.whitelisted) return failE(`${device.name} is not whitelisted`)
    const row = await db.hwDevice.update({ where: { deviceId }, data: { whitelisted: false } })
    await audit('unwhitelist', `${device.name} (${deviceId}) removed from whitelist`)
    return ok({ device: row }, SOURCE)
  },

  policy: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    // no args → return the current policy + key descriptions
    const key = args.key ? String(args.key) : null
    if (!key) {
      const policy = await getPolicy()
      return ok(
        { policy, keys: POLICY_KEYS.map((k) => ({ key: k, value: policy[k], description: POLICY_DESCRIPTIONS[k] })) },
        SOURCE,
        NOTE,
      )
    }
    if (!POLICY_KEYS.includes(key)) return failE(`unknown policy key '${key}' — available: ${POLICY_KEYS.join(', ')}`)
    const raw = String(args.value ?? '').trim().toLowerCase()
    const value = ['true', '1', 'yes'].includes(raw)
    if (!['true', 'false', '1', '0', 'yes', 'no'].includes(raw)) {
      return failE(`invalid value '${String(args.value)}' — pass true or false`)
    }
    const policy = await getPolicy()
    policy[key] = value
    await putPolicy(policy)
    await audit('policy', `${key}: ${policy[key] ? 'true' : 'false'} (was ${!value ? 'true' : 'false'})`)
    return ok({ key, value: policy[key], policy }, SOURCE)
  },

  scan: async () => {
    await ensureSeeded()
    const host = hostIdentity()
    const policy = await getPolicy()
    const before = await db.hwDevice.count()
    // refresh lastSeen for known devices
    await db.hwDevice.updateMany({ data: { lastSeen: new Date() } })
    // re-detect: a "new" PCI device appears once (idempotent — no spam)
    const NEW_PCI_ID = 'pci:8086:a0a5' // Intel I225-V 2.5GbE controller
    let newAlert: { kind: string; severity: string; message: string } | null = null
    const known = await db.hwDevice.findUnique({ where: { deviceId: NEW_PCI_ID } })
    if (!known) {
      await db.hwDevice.create({
        data: { deviceId: NEW_PCI_ID, kind: 'pci', name: 'Intel Ethernet Controller I225-V', vendor: 'Intel', authorized: true, whitelisted: false },
      })
      newAlert = {
        kind: 'new-pci',
        severity: 'info',
        message: `New PCI device present: Intel Ethernet Controller I225-V (vendor 8086:a0a5) — not previously seen${policy.blockUnknownPCI ? '' : ' (blockUnknownPCI is off — alerting only)'}`,
      }
      await db.hwAlert.create({ data: { deviceId: NEW_PCI_ID, ...newAlert, state: 'active' } })
      await audit('scan', `detected NEW pci device ${NEW_PCI_ID} (Intel I225-V) on host '${host}' — info alert raised`)
    } else {
      await audit('scan', `scan on host '${host}' — ${before} devices, no new hardware`)
    }
    const devices = await db.hwDevice.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }] })
    const alerts = await db.hwAlert.findMany({ where: { state: 'active' } })
    return ok(
      {
        host,
        scanned: devices.length,
        before,
        buses: {
          usb: devices.filter((d) => d.kind.startsWith('usb')).length,
          thunderbolt: devices.filter((d) => d.kind === 'thunderbolt').length,
          bluetooth: devices.filter((d) => d.kind === 'bluetooth').length,
          pci: devices.filter((d) => d.kind === 'pci').length,
          firewire: devices.filter((d) => d.kind === 'firewire').length,
          rfid: devices.filter((d) => d.kind === 'rfid').length,
        },
        activeAlerts: alerts.length,
        newAlert,
        dmiSource: 'real /sys/class/dmi/id/product_name',
      },
      SOURCE,
      `host identity is REAL (DMI); the bus scan is demo — the container has no populated usb/thunderbolt/bluetooth/pci buses`,
    )
  },
}
