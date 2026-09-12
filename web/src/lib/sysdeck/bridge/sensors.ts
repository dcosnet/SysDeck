// SysDeck bridge — sensors (hardware sensor readings, all live)
// Port of bridge/sensors.py: the cockpit edition shells out to
// `sensors -j` (lm-sensors). The web edition does exactly the same:
//   1. `sensors -j` when lm-sensors is installed (the canonical source,
//      chip labels and all — identical to the cockpit panel)
//   2. otherwise it reads the same sysfs sources lm-sensors itself
//      reads (/sys/class/hwmon/hwmon*/*_input with *_label + *_crit,
//      plus /sys/class/thermal/thermal_zone*)
// No fabricated rows, ever: a host with no sensors gets an honest
// empty inventory with a note, not a made-up chip set.
import { readdir } from 'fs/promises'
import { ok, run, which, cached, readText } from './shared'

interface SensorReading {
  label: string
  value: number
  unit: string
  critical?: number
}

interface SensorAdapter {
  name: string
  kind: 'temp' | 'fan' | 'voltage'
  readings: SensorReading[]
}

// ── `sensors -j` (lm-sensors canonical JSON) ─────────────────────────

interface SensorsJson {
  [chip: string]: {
    Adapter?: string
    [key: string]: unknown
  }
}

// lm-sensors JSON shape (real `sensors -j` output):
// { "coretemp-isa-0000": { "Adapter": "ISA adapter",
//     "Package id 0": { "temp1_input": 45, "temp1_max": 100, "temp1_crit": 100 },
//     "Core 0":       { "temp2_input": 44 } },
//   "nct6775-isa-0a40": { "fan1": { "fan1_input": 1240 }, "in0": { "in0_input": 1.344 } } }
function sensorsJsonAdapters(stdout: string): SensorAdapter[] {
  let parsed: SensorsJson
  try {
    parsed = JSON.parse(stdout) as SensorsJson
  } catch {
    return []
  }
  const out: SensorAdapter[] = []
  for (const [chip, fields] of Object.entries(parsed)) {
    const temps: SensorReading[] = []
    const fans: SensorReading[] = []
    const volts: SensorReading[] = []
    for (const [label, raw] of Object.entries(fields)) {
      if (label === 'Adapter' || typeof raw !== 'object' || raw === null) continue
      const entry = raw as Record<string, number>
      // the feature prefix in the *_input key is the authoritative kind
      const inputKey = Object.keys(entry).find((k) => /^(temp|fan|in)\d+_input$/.test(k))
      if (!inputKey) continue
      const value = entry[inputKey]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      const prefix = inputKey.replace(/_input$/, '')
      if (inputKey.startsWith('temp')) {
        const crit = entry[`${prefix}_crit`] ?? entry[`${prefix}_max`] ?? null
        temps.push({
          label,
          value: Math.round(value * 10) / 10,
          unit: '°C',
          ...(typeof crit === 'number' && Number.isFinite(crit) ? { critical: Math.round(crit * 10) / 10 } : {}),
        })
      } else if (inputKey.startsWith('fan')) {
        fans.push({ label, value: Math.round(value), unit: 'RPM' })
      } else {
        volts.push({ label, value: Math.round(value * 1000) / 1000, unit: 'V' })
      }
    }
    if (temps.length) out.push({ name: chip, kind: 'temp', readings: temps })
    if (fans.length) out.push({ name: chip, kind: 'fan', readings: fans })
    if (volts.length) out.push({ name: chip, kind: 'voltage', readings: volts })
  }
  return out
}

// ── sysfs collectors (what lm-sensors reads under the hood) ──────────
// All reads are async — the hwmon walk never blocks the event loop.

async function readNum(path: string): Promise<number | null> {
  const t = await readText(path)
  if (!t) return null
  const v = Number(t.trim())
  return Number.isFinite(v) ? v : null
}

async function readStr(path: string): Promise<string | null> {
  const t = await readText(path)
  return t.trim() || null
}

async function sysfsAdapters(): Promise<SensorAdapter[]> {
  const out: SensorAdapter[] = []
  let hwmons: string[] = []
  try {
    hwmons = await readdir('/sys/class/hwmon')
  } catch {
    return out // /sys/class/hwmon absent — honest empty
  }
  for (const h of hwmons) {
    const base = `/sys/class/hwmon/${h}`
    const name = (await readStr(`${base}/name`)) ?? h
    let files: string[] = []
    try {
      files = await readdir(base)
    } catch {
      continue
    }
    const temps: SensorReading[] = []
    const fans: SensorReading[] = []
    const volts: SensorReading[] = []
    for (const f of files) {
      const m = f.match(/^(temp|fan|in)(\d+)_input$/)
      if (!m) continue
      const raw = await readNum(`${base}/${f}`)
      if (raw === null) continue
      const label = (await readStr(`${base}/${m[1]}${m[2]}_label`)) ?? `${m[1]}${m[2]}`
      if (m[1] === 'temp') {
        const crit = await readNum(`${base}/${m[1]}${m[2]}_crit`)
        temps.push({
          label,
          value: Math.round((raw / 1000) * 10) / 10,
          unit: '°C',
          ...(crit !== null ? { critical: Math.round((crit / 1000) * 10) / 10 } : {}),
        })
      } else if (m[1] === 'fan') {
        fans.push({ label, value: raw, unit: 'RPM' })
      } else {
        volts.push({ label, value: Math.round((raw / 1000) * 100) / 100, unit: 'V' })
      }
    }
    if (temps.length) out.push({ name, kind: 'temp', readings: temps })
    if (fans.length) out.push({ name, kind: 'fan', readings: fans })
    if (volts.length) out.push({ name, kind: 'voltage', readings: volts })
  }
  return out
}

async function thermalZones(): Promise<SensorAdapter[]> {
  const out: SensorAdapter[] = []
  let zones: string[] = []
  try {
    zones = await readdir('/sys/class/thermal')
  } catch {
    return out // /sys/class/thermal absent — honest empty
  }
  for (const z of zones) {
    if (!/^thermal_zone\d+$/.test(z)) continue
    const temp = await readNum(`/sys/class/thermal/${z}/temp`)
    if (temp === null) continue
    const type = (await readStr(`/sys/class/thermal/${z}/type`)) ?? z
    out.push({
      name: `${type} (thermal_zone)`,
      kind: 'temp',
      readings: [{ label: type, value: Math.round((temp / 1000) * 10) / 10, unit: '°C' }],
    })
  }
  return out
}

// ── collection ───────────────────────────────────────────────────────

async function collectSysfs(): Promise<{ adapters: SensorAdapter[]; note?: string }> {
  // sysfs fallback rung — always available, zero dependencies
  const adapters = [...(await sysfsAdapters()), ...(await thermalZones())]
  if (adapters.length === 0) {
    return {
      adapters,
      note: 'no sensor readings on this host (probed /sys/class/hwmon + /sys/class/thermal; install lm-sensors and run sensors-detect for chip-level labels)',
    }
  }
  return { adapters }
}

/** Sensor chain: `sensors -j` (lm-sensors, the cockpit panel's source)
 *  → raw sysfs hwmon + thermal zones → honest empty. The whole sweep is
 *  TTL-cached so the summary/temps/fans/voltages polls share one pass. */
async function collect(): Promise<{ adapters: SensorAdapter[]; note?: string }> {
  return cached('sensors:collect', 3000, async () => {
    if (await which('sensors')) {
      const r = await run('sensors', ['-j'], 10_000)
      if (r.rc === 0 && r.stdout.trim().startsWith('{')) {
        const adapters = sensorsJsonAdapters(r.stdout)
        if (adapters.length > 0) {
          return {
            adapters,
            note: 'real `sensors -j` (lm-sensors) — the same source the cockpit edition reads',
          }
        }
        // lm-sensors present but no chips configured → step down to sysfs
        // and say so honestly
        const sys = await collectSysfs()
        return { ...sys, note: `sensors -j returned no chips (run sensors-detect); showing raw sysfs readings — ${sys.note ?? 'direct /sys/class/hwmon + thermal_zone reads'}` }
      }
    }
    return collectSysfs()
  })
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    const { adapters, note } = await collect()
    return ok({ adapters, source: 'live' }, 'live', note)
  },

  temps: async () => {
    const { adapters, note } = await collect()
    return ok(
      { adapters: adapters.filter((a) => a.kind === 'temp'), source: 'live' },
      'live',
      note,
    )
  },

  fans: async () => {
    const { adapters, note } = await collect()
    return ok(
      { adapters: adapters.filter((a) => a.kind === 'fan'), source: 'live' },
      'live',
      note,
    )
  },

  voltages: async () => {
    const { adapters, note } = await collect()
    return ok(
      { adapters: adapters.filter((a) => a.kind === 'voltage'), source: 'live' },
      'live',
      note,
    )
  },
}
