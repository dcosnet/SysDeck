// SysDeck bridge — sensors (hardware sensor readings)
// Port of bridge/sensors.py: the cockpit edition shells out to
// `sensors -j` (lm-sensors). This environment has no lm-sensors and a
// sparse /sys/class/hwmon, so the web edition reads the sysfs sources
// lm-sensors itself reads (/sys/class/hwmon/hwmon*/*_input, plus
// /sys/class/thermal/thermal_zone*) and — when fewer than 3 real
// readings exist (the honest case in this container) — supplements a
// clearly-labeled demo chip set. Real rows always come first and are
// unflagged; every supplemented row carries demo: true.
import { readFileSync, readdirSync } from 'fs'
import { ok } from './shared'

interface SensorReading {
  label: string
  value: number
  unit: string
  critical?: number
  demo?: boolean
}

interface SensorAdapter {
  name: string
  kind: 'temp' | 'fan' | 'voltage'
  readings: SensorReading[]
}

// ── real sysfs collectors ────────────────────────────────────────────

function readNum(path: string): number | null {
  try {
    const v = Number(readFileSync(path, 'utf-8').trim())
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

function readStr(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8').trim() || null
  } catch {
    return null
  }
}

function realAdapters(): SensorAdapter[] {
  const out: SensorAdapter[] = []
  try {
    for (const h of readdirSync('/sys/class/hwmon')) {
      const base = `/sys/class/hwmon/${h}`
      const name = readStr(`${base}/name`) ?? h
      let files: string[] = []
      try {
        files = readdirSync(base)
      } catch {
        continue
      }
      const temps: SensorReading[] = []
      const fans: SensorReading[] = []
      const volts: SensorReading[] = []
      for (const f of files) {
        const m = f.match(/^(temp|fan|in)(\d+)_input$/)
        if (!m) continue
        const raw = readNum(`${base}/${f}`)
        if (raw === null) continue
        const label = readStr(`${base}/${m[1]}${m[2]}_label`) ?? `${m[1]}${m[2]}`
        if (m[1] === 'temp') {
          const crit = readNum(`${base}/${m[1]}${m[2]}_crit`)
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
  } catch {
    /* /sys/class/hwmon absent — honest empty */
  }
  return out
}

function realThermal(): SensorAdapter[] {
  const out: SensorAdapter[] = []
  try {
    for (const z of readdirSync('/sys/class/thermal')) {
      if (!/^thermal_zone\d+$/.test(z)) continue
      const temp = readNum(`/sys/class/thermal/${z}/temp`)
      if (temp === null) continue
      const type = readStr(`/sys/class/thermal/${z}/type`) ?? z
      out.push({
        name: `${type} (thermal_zone)`,
        kind: 'temp',
        readings: [{ label: type, value: Math.round((temp / 1000) * 10) / 10, unit: '°C' }],
      })
    }
  } catch {
    /* /sys/class/thermal absent — honest empty */
  }
  return out
}

// ── demo supplement (labeled per row) ────────────────────────────────
// Realistic values modeled on the chips every lm-sensors user knows:
// a coretemp package + cores, an nct6798 fan bank, an it8620 voltage
// rail set. Small sinusoidal drift so repeated polls look alive.

function drift(seed: number, amp: number): number {
  return Math.round(Math.sin(Date.now() / 15000 + seed) * amp * 10) / 10
}

function demoAdapters(): SensorAdapter[] {
  const cores = [0, 1, 2, 3].map((i) => ({
    label: `Core ${i}`,
    value: 58 + i * 2 + drift(i, 0.8),
    unit: '°C',
    critical: 100,
    demo: true,
  }))
  return [
    {
      name: 'coretemp',
      kind: 'temp',
      readings: [
        { label: 'Package id 0', value: 62 + drift(0.5, 0.9), unit: '°C', critical: 100, demo: true },
        ...cores,
      ],
    },
    {
      name: 'nct6798',
      kind: 'fan',
      readings: [
        { label: 'fan1 (CPU)', value: 1240 + drift(1, 25), unit: 'RPM', demo: true },
        { label: 'fan2 (SYS)', value: 980 + drift(2, 20), unit: 'RPM', demo: true },
        { label: 'fan3 (AUX)', value: 760 + drift(3, 15), unit: 'RPM', demo: true },
      ],
    },
    {
      name: 'it8620',
      kind: 'voltage',
      readings: [
        { label: 'in0 (vcore)', value: 1.34 + drift(4, 0.02), unit: 'V', demo: true },
        { label: '+3.3V', value: 3.31 + drift(5, 0.01), unit: 'V', demo: true },
        { label: '+5V', value: 5.02 + drift(6, 0.01), unit: 'V', demo: true },
        { label: '+12V', value: 12.1 + drift(7, 0.03), unit: 'V', demo: true },
        { label: 'vbat', value: 3.2, unit: 'V', demo: true },
      ],
    },
  ]
}

// ── commands ─────────────────────────────────────────────────────────

const MIN_REAL_READINGS = 3

function collect(): { adapters: SensorAdapter[]; source: 'live' | 'hybrid'; note?: string } {
  const real = [...realAdapters(), ...realThermal()]
  const realCount = real.reduce((n, a) => n + a.readings.length, 0)
  if (realCount >= MIN_REAL_READINGS) return { adapters: real, source: 'live' }
  return {
    adapters: [...real, ...demoAdapters()],
    source: 'hybrid',
    note: 'supplemented — /sys/class/hwmon sparse in container',
  }
}

export const commands = {
  summary: async () => {
    const { adapters, source, note } = collect()
    return ok({ adapters, source }, source, note)
  },

  temps: async () => {
    const { adapters, source, note } = collect()
    return ok(
      { adapters: adapters.filter((a) => a.kind === 'temp'), source },
      source,
      note,
    )
  },

  fans: async () => {
    const { adapters, source, note } = collect()
    return ok(
      { adapters: adapters.filter((a) => a.kind === 'fan'), source },
      source,
      note,
    )
  },

  voltages: async () => {
    const { adapters, source, note } = collect()
    return ok(
      { adapters: adapters.filter((a) => a.kind === 'voltage'), source },
      source,
      note,
    )
  },
}
