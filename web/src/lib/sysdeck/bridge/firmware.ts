// SysDeck bridge — firmware (DMI + fwupd-style inventory + TPM)
// Port of bridge/firmware.py: the cockpit edition aggregated
// `fwupdmgr get-devices --json` plus `tpm2_pcrread sha256:0`. Neither
// fwupd nor tpm2-tools exist in this container, and /sys/class/dmi is
// not mounted, so the web edition: (1) reads DMI fields from
// /sys/class/dmi/id when present (real — empty here, and honestly
// reported), (2) supplements a fwupd-style device list seeded with
// realistic board/BMC/NIC/SSD firmware (demo rows flagged), (3) exposes
// a demo TPM PCR0 digest clearly labeled, and (4) stages firmware
// updates as SdKv state — the actual flash requires the cockpit bridge
// on a managed host. Device rows keep fwupd's capitalized keys
// (Name/Vendor/Version/Kind/Flags/Guid) so panels port directly.
import { readFileSync } from 'fs'
import os from 'os'
import { db } from '@/lib/db'
import { ok, fail } from './shared'

/** fail() + source → the dispatcher spreads this into a top-level
 *  {ok:false, error, source} envelope. (A bare fail() lacks data/source
 *  keys, so the dispatcher would wrap it as {ok:true, data:{ok:false}}.) */
function failE(error: string, source: 'live' | 'demo' | 'hybrid' = 'hybrid') {
  return { ...fail(error), source }
}

// ── DMI (real when exposed) ──────────────────────────────────────────

const DMI_FIELDS = [
  'sys_vendor',
  'product_name',
  'product_version',
  'board_name',
  'board_version',
  'bios_vendor',
  'bios_version',
  'bios_date',
] as const

type DmiField = (typeof DMI_FIELDS)[number]

function readDmi(): Record<DmiField, string> {
  const out = {} as Record<DmiField, string>
  for (const f of DMI_FIELDS) {
    try {
      out[f] = readFileSync(`/sys/class/dmi/id/${f}`, 'utf-8').trim()
    } catch {
      out[f] = ''
    }
  }
  return out
}

// ── demo fwupd-style devices ────────────────────────────────────────

interface FwDevice {
  Name: string
  Vendor: string
  Version: string
  Kind: string
  Flags: string
  Guid: string
  demo?: boolean
}

const DEMO_DEVICES: FwDevice[] = [
  {
    Name: 'UEFI dbx',
    Vendor: 'UEFI Forum',
    Version: '77',
    Kind: 'firmware',
    Flags: 'internal',
    Guid: '4bde22fb-3e24-5a53-a539-8b0c9e1e6b90',
    demo: true,
  },
  {
    Name: 'Supermicro X10SLH-F BMC',
    Vendor: 'Supermicro',
    Version: '3.88',
    Kind: 'firmware',
    Flags: 'internal|updatable',
    Guid: 'c9a1c6a2-1d3e-5f47-9b26-8e5f4e2a7c31',
    demo: true,
  },
  {
    Name: 'Intel I210 NVM',
    Vendor: 'Intel Corporation',
    Version: '3.25',
    Kind: 'firmware',
    Flags: 'internal|updatable',
    Guid: '2d47a2b1-9f3c-5e18-b764-1c2e5a8d4f02',
    demo: true,
  },
  {
    Name: 'Samsung SSD 870 EVO',
    Vendor: 'Samsung',
    Version: '2B4QEXM7',
    Kind: 'device',
    Flags: 'internal|updatable|needs-reboot',
    Guid: '67a5f0b9-8e2d-5c14-a938-f1e7d6b3a85c',
    demo: true,
  },
]

interface FwUpdate {
  device: string
  guid: string
  current: string
  candidate: string
  severity: 'critical' | 'low'
  description: string
  releaseNotes?: string
}

const DEMO_UPDATES: FwUpdate[] = [
  {
    device: 'Supermicro X10SLH-F BMC',
    guid: 'c9a1c6a2-1d3e-5f47-9b26-8e5f4e2a7c31',
    current: '3.88',
    candidate: '4.12',
    severity: 'critical',
    description: 'BMC firmware update — fixes CVE-2022-40242 (authentication bypass) and CVE-2022-40242 adjacent issues in the Redfish API.',
    releaseNotes: 'Supermicro BIOS/BMC release 4.12 (2024-06): hardens Redfish authentication, fixes SSH cipher negotiation, updates SSL bundle.',
  },
  {
    device: 'Samsung SSD 870 EVO',
    guid: '67a5f0b9-8e2d-5c14-a938-f1e7d6b3a85c',
    current: '2B4QEXM7',
    candidate: '2B6QEXM7',
    severity: 'low',
    description: 'SSD firmware upgrade — improves sustained-write consistency on nearly-full drives.',
    releaseNotes: 'Samsung 870 EVO firmware 2B6QEXM7: enhanced error recovery on low-NAND-health blocks.',
  },
]

// ── commands ─────────────────────────────────────────────────────────

const APPLIED_KV = 'firmware.applied'

async function appliedSet(): Promise<string[]> {
  const row = await db.sdKv.findUnique({ where: { key: APPLIED_KV } })
  if (!row) return []
  try {
    const parsed = JSON.parse(row.value) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export const commands = {
  devices: async () => {
    const dmi = readDmi()
    const devices: FwDevice[] = []
    if (dmi.sys_vendor || dmi.bios_version) {
      devices.push({
        Name: `${dmi.product_name || 'System'} — System Firmware`,
        Vendor: dmi.sys_vendor || dmi.bios_vendor || 'Unknown',
        Version: dmi.bios_version || 'unknown',
        Kind: 'firmware',
        Flags: 'internal',
        Guid: '00000000-0000-5000-8000-000000000001',
      })
    } else {
      // No DMI in this container — an honest placeholder built from the
      // real kernel identity rather than a fabricated board.
      devices.push({
        Name: 'System Firmware (container — no DMI)',
        Vendor: 'Unknown',
        Version: os.release(),
        Kind: 'firmware',
        Flags: 'internal',
        Guid: '00000000-0000-5000-8000-000000000001',
      })
    }
    const applied = await appliedSet()
    devices.push(
      ...DEMO_DEVICES.map((d) => ({
        ...d,
        Flags: applied.includes(d.Guid) ? `${d.Flags}|staged` : d.Flags,
      })),
    )
    const realDmi = Boolean(dmi.sys_vendor || dmi.bios_version)
    return ok(
      { Devices: devices, applied: applied.length },
      realDmi ? 'hybrid' : 'hybrid',
      realDmi
        ? 'DMI entry real; fwupd-style devices are seeded demo rows (fwupd absent)'
        : '/sys/class/dmi not mounted in this container — entry built from real kernel identity; fwupd-style devices are seeded demo rows (fwupd absent)',
    )
  },

  dmi: async () => {
    const dmi = readDmi()
    const anyValue = Object.values(dmi).some((v) => v.length > 0)
    return ok(
      { dmi },
      'live',
      anyValue ? 'raw /sys/class/dmi/id values' : '/sys/class/dmi/id not exposed in this container',
    )
  },

  tpm: async () => {
    // tpm2-tools absent — installed:false is the honest answer. The PCR0
    // block below is a demo digest (labeled) so panels can render the
    // layout the cockpit edition showed.
    const digest = '3a7f2e9c4d18b6a5f0e2c8d4b1a9f7e3c5d2b8a4f1e6c9d3b7a5f2e8c4d1b6a9f3'
    return ok(
      {
        installed: false,
        note: 'tpm2-tools not available in this environment',
        pcr0: {
          demo: true,
          algorithm: 'SHA256',
          pcr: 0,
          digest,
          extensions: [
            'EFI boot variables (EV_EFI_VARIABLE_DRIVER_CONFIG)',
            'Secure Boot policy (EV_EFI_VARIABLE_DRIVER_CONFIG)',
            'measured boot (EV_EFI_ACTION)',
          ],
        },
      },
      'hybrid',
      'TPM status real (tools absent); PCR0 block is a labeled demo digest',
    )
  },

  updates: async () => {
    const applied = await appliedSet()
    return ok(
      {
        updates: DEMO_UPDATES.map((u) => ({ ...u, staged: applied.includes(u.guid) })),
        count: DEMO_UPDATES.length,
      },
      'demo',
      'seeded update catalog — fwupd/LVFS metadata requires the cockpit bridge on a managed host',
    )
  },

  apply: async (args: Record<string, unknown>) => {
    const guid = String(args.guid ?? '').trim()
    const update = DEMO_UPDATES.find((u) => u.guid === guid) ?? DEMO_DEVICES.find((d) => d.Guid === guid)
    if (!update) return failE(`unknown firmware guid: ${guid}`)
    const applied = await appliedSet()
    if (!applied.includes(guid)) applied.push(guid)
    await db.sdKv.upsert({
      where: { key: APPLIED_KV },
      create: { key: APPLIED_KV, value: JSON.stringify(applied) },
      update: { value: JSON.stringify(applied) },
    })
    await db.auditLog.create({
      data: {
        module: 'firmware',
        action: 'apply',
        detail: `staged ${'device' in update ? update.device : update.Name} (${'current' in update ? `${update.current} → ${update.candidate}` : update.Version})`,
      },
    })
    return ok(
      { applied: guid, staged: true },
      'hybrid',
      'staging recorded — the actual flash requires the cockpit bridge on a managed host',
    )
  },
}
