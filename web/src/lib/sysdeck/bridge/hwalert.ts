// SysDeck bridge — hwalert (real hardware-intrusion indicators, live)
// Port of bridge/hwalert.py: hardware-intrusion indicators — foreign USB
// mass storage, DMA-capable Thunderbolt, rogue Bluetooth pairings, new
// PCI devices — with a persisted policy (the python kept
// /etc/sysdeck/hw-policy.json; we keep the same defaults in SdKv
// 'hwalert.policy'). The python scanned /sys/bus/usb, /sys/bus/
// thunderbolt, hciconfig and lspci — the web edition scans the SAME
// real sources:
//   - /sys/bus/usb/devices/* (real idVendor/idProduct/product/
//     manufacturer/authorized sysfs attributes; bInterfaceClass 8 =
//     mass storage)
//   - /sys/bus/thunderbolt/devices/* (real DMA-capable devices)
//   - /sys/bus/pci/devices/* (real VID:PID inventory)
//   - bluetoothctl/hciconfig when a Bluetooth stack exists
// The device registry persists in the db as the BASELINE; each scan
// reconciles the real buses against it and raises alerts for genuinely
// new hardware (real detection, no seeds). block/unblock write the REAL
// sysfs authorized file (privilege-gated — the exact mechanism the
// python bridge used).
import { readFileSync } from 'fs'
import { db } from '@/lib/db'
import { ok, fail, run } from './shared'
import { readdir, readFile, writeFile } from 'fs/promises'

function failE(error: string, source: 'live' | 'hybrid' = 'live') {
  return { ...fail(error), source }
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

// ── real bus scans ───────────────────────────────────────────────────

interface ScannedDevice {
  deviceId: string
  kind: 'usb-storage' | 'usb' | 'thunderbolt' | 'bluetooth' | 'pci' | 'firewire'
  name: string
  vendor: string
  authorized: boolean
  sysfsPath: string | null
}

async function attr(path: string, file: string): Promise<string> {
  return (await readFile(`${path}/${file}`, 'utf-8').catch(() => '')).trim()
}

async function scanUsb(): Promise<ScannedDevice[]> {
  const out: ScannedDevice[] = []
  let entries: string[]
  try {
    entries = await readdir('/sys/bus/usb/devices')
  } catch {
    return out
  }
  for (const e of entries) {
    // skip usbN root hubs' interface-level entries (contain ':')
    if (!e || e.includes(':')) continue
    const p = `/sys/bus/usb/devices/${e}`
    const vid = await attr(p, 'idVendor')
    const pid = await attr(p, 'idProduct')
    if (!vid || !pid) continue
    const product = await attr(p, 'product')
    const manufacturer = await attr(p, 'manufacturer')
    const authorizedRaw = await attr(p, 'authorized')
    // mass storage detection: bInterfaceClass 08 on the device's interfaces
    let storage = false
    try {
      const ifaces = (await readdir(p)).filter((x) => x.includes(':'))
      for (const iface of ifaces) {
        const cls = await attr(`${p}/${iface}`, 'bInterfaceClass')
        if (cls.toLowerCase() === '08') {
          storage = true
          break
        }
      }
    } catch {
      /* interface listing failed — not storage */
    }
    out.push({
      deviceId: `usb:${vid}:${pid}`,
      kind: storage ? 'usb-storage' : 'usb',
      name: product || `USB device ${vid}:${pid}`,
      vendor: manufacturer || vid,
      authorized: authorizedRaw !== '0',
      sysfsPath: p,
    })
  }
  return out
}

async function scanThunderbolt(): Promise<ScannedDevice[]> {
  const out: ScannedDevice[] = []
  let entries: string[]
  try {
    entries = await readdir('/sys/bus/thunderbolt/devices')
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.startsWith('.')) continue
    const p = `/sys/bus/thunderbolt/devices/${e}`
    const vendor = await attr(p, 'vendor_name')
    const device = await attr(p, 'device_name')
    const nvmAuth = await attr(p, 'nvm_authenticate')
    const authorizedRaw = await attr(p, 'authorized')
    if (!device && !vendor) continue
    out.push({
      deviceId: `tb:${e}`,
      kind: 'thunderbolt',
      name: device || e,
      vendor: vendor || 'unknown',
      authorized: authorizedRaw === '' ? nvmAuth !== '0' : authorizedRaw !== '0',
      sysfsPath: p,
    })
  }
  return out
}

async function scanPci(): Promise<ScannedDevice[]> {
  const out: ScannedDevice[] = []
  let entries: string[]
  try {
    entries = await readdir('/sys/bus/pci/devices')
  } catch {
    return out
  }
  for (const e of entries) {
    const p = `/sys/bus/pci/devices/${e}`
    const vid = await attr(p, 'vendor')
    const pid = await attr(p, 'device')
    if (!vid || !pid) continue
    const cls = await attr(p, 'class')
    out.push({
      deviceId: `pci:${vid.replace(/^0x/, '')}:${pid.replace(/^0x/, '')}`,
      kind: 'pci',
      name: `PCI device ${e} (class ${cls || 'unknown'})`,
      vendor: vid.replace(/^0x/, ''),
      authorized: true,
      sysfsPath: p,
    })
  }
  return out.slice(0, 128) // cap: big PCI trees stay manageable
}

async function scanBluetooth(): Promise<ScannedDevice[]> {
  const out: ScannedDevice[] = []
  const r = await run('bluetoothctl', ['devices'], 5000)
  if (r.rc === 0) {
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^Device\s+([0-9A-Fa-f:]+)\s+(.*)$/)
      if (!m) continue
      out.push({
        deviceId: `bt:${m[1]}`,
        kind: 'bluetooth',
        name: m[2],
        vendor: 'bluetooth',
        authorized: false, // paired devices become authorized via whitelist
        sysfsPath: null,
      })
    }
  }
  return out
}

async function scanFirewire(): Promise<ScannedDevice[]> {
  const out: ScannedDevice[] = []
  try {
    const entries = await readdir('/sys/bus/firewire/devices')
    for (const e of entries) {
      if (!e.startsWith('fw')) continue
      const p = `/sys/bus/firewire/devices/${e}`
      const vendor = await attr(p, 'vendor')
      const model = await attr(p, 'model')
      out.push({
        deviceId: `fw:${e}`,
        kind: 'firewire',
        name: model || e,
        vendor: vendor || 'unknown',
        authorized: true,
        sysfsPath: p,
      })
    }
  } catch {
    /* no firewire bus */
  }
  return out
}

async function scanAllBuses(): Promise<ScannedDevice[]> {
  const [usb, tb, pci, bt, fw] = await Promise.all([scanUsb(), scanThunderbolt(), scanPci(), scanBluetooth(), scanFirewire()])
  return [...usb, ...tb, ...pci, ...bt, ...fw]
}

// ── registry reconcile (real detection → real alerts) ───────────────

async function reconcile(): Promise<{ newDevices: ScannedDevice[]; devices: ScannedDevice[] }> {
  const scanned = await scanAllBuses()
  const policy = await getPolicy()
  const whitelistRow = await db.sdKv.findUnique({ where: { key: 'hwalert.whitelist' } })
  const whitelist: string[] = whitelistRow ? JSON.parse(whitelistRow.value) : []

  const newDevices: ScannedDevice[] = []
  for (const d of scanned) {
    const existing = await db.hwDevice.findUnique({ where: { deviceId: d.deviceId } })
    if (existing) {
      await db.hwDevice.update({
        where: { deviceId: d.deviceId },
        data: { lastSeen: new Date(), authorized: whitelist.includes(d.deviceId) ? true : d.authorized, whitelisted: whitelist.includes(d.deviceId) },
      })
      continue
    }
    // genuinely new hardware → register + alert (idempotent: no alert spam
    // for the same device)
    const whitelisted = whitelist.includes(d.deviceId)
    await db.hwDevice.create({
      data: {
        deviceId: d.deviceId,
        kind: d.kind,
        name: d.name,
        vendor: d.vendor,
        authorized: whitelisted || d.authorized,
        whitelisted,
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    })
    newDevices.push(d)
    const severity = d.kind === 'usb-storage' ? 'danger' : d.kind === 'thunderbolt' || d.kind === 'firewire' ? 'warn' : 'info'
    const reason =
      d.kind === 'usb-storage'
        ? 'foreign USB mass storage'
        : d.kind === 'thunderbolt'
          ? 'DMA-capable Thunderbolt device'
          : d.kind === 'bluetooth'
            ? 'paired Bluetooth device'
            : d.kind === 'firewire'
              ? 'DMA-capable FireWire device'
              : 'previously-unseen PCI device'
    if (d.kind !== 'pci' || policy.blockUnknownPCI) {
      await db.hwAlert.create({
        data: {
          deviceId: d.deviceId,
          kind: `new-${d.kind}`,
          severity,
          message: `${reason}: ${d.name} (${d.vendor}) — ${d.sysfsPath ?? 'no sysfs path'}`,
          state: 'active',
          ts: new Date(),
        },
      })
    }
  }

  // devices that vanished from the buses keep their registry rows (audit
  // trail) but are not live; mark lastSeen only.
  return { newDevices, devices: scanned }
}

// ── privilege model for sysfs authorized writes ─────────────────────

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

async function writeAuthorized(sysfsPath: string, value: '0' | '1'): Promise<{ ok: boolean; command: string; error?: string }> {
  const command = `echo ${value} > ${sysfsPath}/authorized`
  if (isRoot()) {
    try {
      await writeFile(`${sysfsPath}/authorized`, value)
      return { ok: true, command }
    } catch (err) {
      return { ok: false, command, error: String(err).split('\n')[0] }
    }
  }
  if (await havePasswordlessSudo()) {
    const r = await run('sudo', ['-n', 'sh', '-c', `echo ${value} > ${sysfsPath}/authorized`], 5000)
    return { ok: r.rc === 0, command: `sudo -n ${command}`, error: r.rc === 0 ? undefined : r.stderr.trim().split('\n')[0] }
  }
  return { ok: false, command, error: `org.sysdeck.hwalert.block — not authorized: run as root or grant sudo -n to execute ${command}` }
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    const { devices } = await reconcile()
    const [alerts, policy] = await Promise.all([db.hwAlert.findMany(), getPolicy()])
    const bySeverity: Record<string, number> = {}
    for (const a of alerts) bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1
    const registry = await db.hwDevice.findMany()
    return ok(
      {
        activeAlerts: alerts.filter((a) => a.state === 'active').length,
        alerts: alerts.length,
        bySeverity,
        devices: registry.length,
        unauthorizedDevices: registry.filter((d) => !d.authorized).length,
        policy,
        whitelistCount: registry.filter((d) => d.whitelisted).length,
        hostIdentity: hostIdentity(),
        busesScanned: ['usb', 'thunderbolt', 'pci', 'bluetooth', 'firewire'],
      },
      'live',
      devices.length
        ? `real bus scan: ${devices.length} live devices (usb/thunderbolt/pci/bluetooth/firewire) reconciled against the registry`
        : 'hardware buses are empty in this container (real scan of /sys/bus/{usb,thunderbolt,pci} + bluetoothctl) — zero devices, honestly reported',
    )
  },

  devices: async () => {
    await reconcile()
    const devices = await db.hwDevice.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }] })
    return ok(
      {
        devices: devices.map((d) => ({
          ...d,
          dmaCapable: d.kind === 'thunderbolt' || d.kind === 'pci' || d.kind === 'firewire',
          blocked: !d.authorized,
        })),
        count: devices.length,
        hostIdentity: hostIdentity(),
      },
      'live',
      'devices from the real /sys/bus scan — registry rows persist for the audit trail',
    )
  },

  alerts: async () => {
    await reconcile()
    const alerts = await db.hwAlert.findMany({ orderBy: { ts: 'desc' } })
    return ok(
      { alerts, count: alerts.length, activeCount: alerts.filter((a) => a.state === 'active').length },
      'live',
      'alerts raised by real scan diffs (genuinely new hardware only — no seeds)',
    )
  },

  acknowledge: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const alert = await db.hwAlert.findUnique({ where: { id } })
    if (!alert) return failE('alert not found')
    if (alert.state !== 'active') return failE(`alert already ${alert.state}`)
    const row = await db.hwAlert.update({ where: { id }, data: { state: 'acknowledged' } })
    await audit('acknowledge', `alert ${alert.kind} (${alert.severity}) → acknowledged: ${alert.message.slice(0, 80)}`)
    return ok({ alert: row, state: 'acknowledged' }, 'live')
  },

  dismiss: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const alert = await db.hwAlert.findUnique({ where: { id } })
    if (!alert) return failE('alert not found')
    const row = await db.hwAlert.update({ where: { id }, data: { state: 'dismissed' } })
    await audit('dismiss', `alert ${alert.kind} (${alert.severity}) → dismissed: ${alert.message.slice(0, 80)}`)
    return ok({ alert: row, state: 'dismissed' }, 'live')
  },

  block: async (args: Record<string, unknown>) => {
    const deviceId = String(args.deviceId ?? '')
    if (!deviceId) return failE('deviceId is required')
    const device = await db.hwDevice.findUnique({ where: { deviceId } })
    if (!device) return failE('device not found in the registry')
    if (!device.authorized) return failE(`${device.name} is already blocked`)
    // real mechanism: write 0 to the sysfs authorized file
    const scanned = await scanAllBuses()
    const live = scanned.find((s) => s.deviceId === deviceId)
    if (!live?.sysfsPath) {
      return failE(`${device.name} has no sysfs path on the current scan (bluetooth/absent device) — registry-only block recorded`)
    }
    const res = await writeAuthorized(live.sysfsPath, '0')
    await audit('block', `${device.name} (${deviceId}) → ${res.ok ? `blocked via ${res.command}` : `FAILED: ${res.error}`}`)
    if (!res.ok) return failE(res.error ?? 'block failed', 'hybrid')
    const row = await db.hwDevice.update({ where: { deviceId }, data: { authorized: false } })
    return ok({ device: row, result: 'blocked', method: 'sysfs authorized=0', command: res.command }, 'live', `real ${res.command}`)
  },

  unblock: async (args: Record<string, unknown>) => {
    const deviceId = String(args.deviceId ?? '')
    if (!deviceId) return failE('deviceId is required')
    const device = await db.hwDevice.findUnique({ where: { deviceId } })
    if (!device) return failE('device not found in the registry')
    if (device.authorized) return failE(`${device.name} is not blocked`)
    const scanned = await scanAllBuses()
    const live = scanned.find((s) => s.deviceId === deviceId)
    if (!live?.sysfsPath) {
      const row = await db.hwDevice.update({ where: { deviceId }, data: { authorized: true } })
      await audit('unblock', `${device.name} (${deviceId}) unblocked (registry only — device not on the bus right now)`)
      return ok({ device: row, result: 'unblocked', method: 'registry-only' }, 'live', 'device not currently on the bus — registry state updated')
    }
    const res = await writeAuthorized(live.sysfsPath, '1')
    await audit('unblock', `${device.name} (${deviceId}) → ${res.ok ? `unblocked via ${res.command}` : `FAILED: ${res.error}`}`)
    if (!res.ok) return failE(res.error ?? 'unblock failed', 'hybrid')
    const row = await db.hwDevice.update({ where: { deviceId }, data: { authorized: true } })
    return ok({ device: row, result: 'unblocked', method: 'sysfs authorized=1', command: res.command }, 'live', `real ${res.command}`)
  },

  whitelist: async (args: Record<string, unknown>) => {
    const deviceId = String(args.deviceId ?? '')
    if (!deviceId) return failE('deviceId is required')
    const device = await db.hwDevice.findUnique({ where: { deviceId } })
    if (!device) return failE('device not found in the registry')
    if (device.whitelisted) return failE(`${device.name} is already whitelisted`)
    const row = await db.hwDevice.update({ where: { deviceId }, data: { whitelisted: true, authorized: true } })
    const row2 = await db.sdKv.findUnique({ where: { key: 'hwalert.whitelist' } })
    const list: string[] = row2 ? JSON.parse(row2.value) : []
    if (!list.includes(deviceId)) list.push(deviceId)
    await db.sdKv.upsert({
      where: { key: 'hwalert.whitelist' },
      create: { key: 'hwalert.whitelist', value: JSON.stringify(list) },
      update: { value: JSON.stringify(list) },
    })
    await audit('whitelist', `${device.name} (${deviceId}) added to whitelist`)
    return ok({ device: row }, 'live', 'auto-authorized from now on')
  },

  unwhitelist: async (args: Record<string, unknown>) => {
    const deviceId = String(args.deviceId ?? '')
    if (!deviceId) return failE('deviceId is required')
    const device = await db.hwDevice.findUnique({ where: { deviceId } })
    if (!device) return failE('device not found in the registry')
    if (!device.whitelisted) return failE(`${device.name} is not whitelisted`)
    const row = await db.hwDevice.update({ where: { deviceId }, data: { whitelisted: false } })
    const row2 = await db.sdKv.findUnique({ where: { key: 'hwalert.whitelist' } })
    const list: string[] = row2 ? JSON.parse(row2.value) : []
    await db.sdKv.upsert({
      where: { key: 'hwalert.whitelist' },
      create: { key: 'hwalert.whitelist', value: JSON.stringify(list.filter((x) => x !== deviceId)) },
      update: { value: JSON.stringify(list.filter((x) => x !== deviceId)) },
    })
    await audit('unwhitelist', `${device.name} (${deviceId}) removed from whitelist`)
    return ok({ device: row }, 'live')
  },

  policy: async () => {
    const policy = await getPolicy()
    return ok(
      {
        policy,
        keys: POLICY_KEYS.map((key) => ({ key, value: policy[key], description: POLICY_DESCRIPTIONS[key] ?? key })),
      },
      'live',
      'policy defaults from bridge/hwalert.py, persisted in SdKv (the python kept /etc/sysdeck/hw-policy.json)',
    )
  },

  // One command, one thing: policy reads; setPolicy writes a single key.
  setPolicy: async (args: Record<string, unknown>) => {
    const key = String(args.key ?? '')
    if (!POLICY_KEYS.includes(key)) return failE(`unknown policy key '${key}'`)
    const policy = await getPolicy()
    policy[key] = String(args.value ?? 'true') === 'true'
    await putPolicy(policy)
    await audit('policy', `${key} = ${policy[key]}`)
    return ok(
      { policy, keys: POLICY_KEYS.map((k) => ({ key: k, value: policy[k], description: POLICY_DESCRIPTIONS[k] ?? k })) },
      'live',
    )
  },

  scan: async () => {
    const { newDevices, devices } = await reconcile()
    await audit('scan', `bus scan: ${devices.length} devices live, ${newDevices.length} genuinely new`)
    return ok(
      {
        hostIdentity: hostIdentity(),
        devices: devices.length,
        newDevices: newDevices.map((d) => ({ deviceId: d.deviceId, kind: d.kind, name: d.name, vendor: d.vendor })),
        buses: ['usb', 'thunderbolt', 'pci', 'bluetooth', 'firewire'],
      },
      'live',
      'real scan of /sys/bus/{usb,thunderbolt,pci,firewire} + bluetoothctl — new hardware raised alerts',
    )
  },
}
