// SysDeck bridge — firmware (real DMI + fwupd + TPM, all live)
// Port of bridge/firmware.py: the cockpit edition aggregated
// `fwupdmgr get-devices --json` plus `tpm2_pcrread sha256:0`. The web
// edition does exactly that against the REAL host:
//   - devices: fwupdmgr get-devices --json when fwupd exists (fwupd's
//     own capitalized keys preserved); the DMI system-firmware entry
//     from /sys/class/dmi/id always (real values, honest when empty)
//   - dmi: raw /sys/class/dmi/id values
//   - tpm: real `tpm2_pcrread sha256:0` when tpm2-tools exist — else
//     installed:false, the honest answer (no fabricated digests)
//   - updates: real `fwupdmgr get-updates --json` when fwupd exists
//   - apply: real `fwupdmgr update` (privilege-gated, honest failure)
import { readFileSync } from 'fs'
import os from 'os'
import { db } from '@/lib/db'
import { ok, fail, run, which } from './shared'

function failE(error: string, source: 'live' | 'hybrid' = 'live') {
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

// ── fwupd (real when installed) ──────────────────────────────────────

interface FwDevice {
  Name: string
  Vendor: string
  Version: string
  Kind: string
  Flags: string
  Guid: string
}

async function fwupdJson(subcommand: string[]): Promise<Record<string, unknown> | null> {
  if (!(await which('fwupdmgr'))) return null
  const r = await run('fwupdmgr', [...subcommand, '--json'], 30_000)
  if (r.rc !== 0 || !r.stdout.trim()) return null
  try {
    return JSON.parse(r.stdout) as Record<string, unknown>
  } catch {
    return null
  }
}

function mapFwupdDevices(devs: unknown): FwDevice[] {
  if (!Array.isArray(devs)) return []
  return (devs as Record<string, unknown>[]).map((d) => {
    const guid =
      typeof d.Guid === 'string'
        ? d.Guid
        : Array.isArray(d.Guid) && d.Guid.length
          ? String(d.Guid[0])
          : '00000000-0000-5000-8000-000000000000'
    return {
      Name: String(d.Name ?? d.InstanceIds ?? 'device'),
      Vendor: String(d.Vendor ?? 'Unknown'),
      Version: String(d.Version ?? ''),
      Kind: String(d.Kind ?? 'device'),
      Flags: String(d.Flags ?? 'internal'),
      Guid: guid,
    }
  })
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  devices: async () => {
    const dmi = readDmi()
    const realDmi = Boolean(dmi.sys_vendor || dmi.bios_version)
    const devices: FwDevice[] = []
    if (realDmi) {
      devices.push({
        Name: `${dmi.product_name || 'System'} — System Firmware`,
        Vendor: dmi.sys_vendor || dmi.bios_vendor || 'Unknown',
        Version: dmi.bios_version || 'unknown',
        Kind: 'firmware',
        Flags: 'internal',
        Guid: '00000000-0000-5000-8000-000000000001',
      })
    } else {
      // No DMI in this container — an honest entry built from the real
      // kernel identity rather than a fabricated board.
      devices.push({
        Name: 'System Firmware (container — no DMI)',
        Vendor: 'Unknown',
        Version: os.release(),
        Kind: 'firmware',
        Flags: 'internal',
        Guid: '00000000-0000-5000-8000-000000000001',
      })
    }
    const fw = await fwupdJson(['get-devices'])
    if (fw && Array.isArray(fw.Devices)) {
      devices.push(...mapFwupdDevices(fw.Devices))
    }
    return ok(
      { Devices: devices, fwupd: Boolean(fw) },
      'live',
      fw
        ? 'real fwupdmgr get-devices --json + DMI entry'
        : realDmi
          ? 'real DMI entry; fwupd not installed — install fwupd for the full updatable-device inventory (LVFS metadata)'
          : '/sys/class/dmi not mounted in this container — entry built from real kernel identity; fwupd not installed (nothing fabricated)',
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
    if (!(await which('tpm2_pcrread'))) {
      return ok(
        {
          installed: false,
          note: 'tpm2-tools not available on this host — install tpm2-tools for real PCR readings (no digest is fabricated)',
        },
        'live',
      )
    }
    const r = await run('tpm2_pcrread', ['sha256:0'], 15_000)
    if (r.rc !== 0) {
      return ok(
        { installed: true, reachable: false, note: `tpm2_pcrread failed — ${r.stderr.trim().split('\n')[0] ?? 'no TPM device (/dev/tpmrm0 absent or needs root)'}` },
        'live',
      )
    }
    const digest = r.stdout.match(/:\s*([0-9A-Fa-f]{64})/)?.[1] ?? ''
    return ok(
      {
        installed: true,
        reachable: true,
        pcr0: {
          algorithm: 'SHA256',
          pcr: 0,
          digest,
        },
      },
      'live',
      'real tpm2_pcrread sha256:0',
    )
  },

  updates: async () => {
    const fw = await fwupdJson(['get-updates'])
    if (!fw) {
      const haveMgr = await which('fwupdmgr')
      return ok(
        { updates: [], count: 0 },
        'live',
        haveMgr
          ? 'fwupdmgr present but no updates returned (metadata may need fwupdmgr refresh)'
          : 'fwupd not installed — no firmware update catalog available (install fwupd to pull LVFS metadata)',
      )
    }
    const updates = mapFwupdDevices(fw.Devices).map((d) => ({
      device: d.Name,
      guid: d.Guid,
      current: '',
      candidate: d.Version,
      severity: 'low',
      description: `${d.Vendor} ${d.Kind} update`,
    }))
    return ok({ updates, count: updates.length }, 'live', 'real fwupdmgr get-updates --json')
  },

  apply: async (args: Record<string, unknown>) => {
    const guid = String(args.guid ?? '').trim()
    if (!(await which('fwupdmgr'))) {
      return failE('fwupd not installed — firmware flashing needs fwupdmgr on the host (nothing staged in its absence)')
    }
    if (guid) {
      return failE('per-device offline flash runs `fwupdmgr install <fw-file>` with the vendor capsule — use fwupdmgr update for the LVFS flow (run below)')
    }
    // the real LVFS flow: fwupdmgr update (interactive prompts need a tty;
    // --assume-no keeps it non-interactive and honest)
    const r = await run('fwupdmgr', ['update', '--assume-no'], 120_000)
    await db.auditLog.create({
      data: { module: 'firmware', action: 'apply', detail: `fwupdmgr update --assume-no → rc=${r.rc}` },
    })
    if (r.rc !== 0) {
      return failE(`fwupdmgr update failed — ${r.stderr.trim().split('\n')[0] ?? 'needs root or no updates staged'}`)
    }
    return ok(
      { command: 'fwupdmgr update --assume-no', output: r.stdout.trim().split('\n').slice(-8).join('\n') },
      'live',
    )
  },
}
