// SysDeck bridge — kata (real Kata Containers 3.x APIs, all live)
// Port of bridge/kata.py v0.0.38 PRODUCTION REWRITE semantics: every
// subcommand calls the REAL Kata APIs —
//   list      kata-monitor HTTP /sandboxes (plain text, one 64-hex id
//             per line) → /run/vc/sbs/<id>/ (Go shim) → /run/kata/<id>/
//             (Rust shim) filesystem enumeration
//   summary   sandbox counts by status + kata-runtime version +
//             kata-monitor status + kata-runtime check host capability
//   start/stop  kata sandboxes are managed by their container engine
//             (containerd/CRI-O owns the lifecycle) — this bridge says
//             so honestly instead of flipping rows
// Sandbox IDs validated ^[0-9a-f]{64}$ (CVE-2024-2947 lesson from the
// python bridge). No runtime → honest "not installed" inventory.
import { ok, fail, run, which, readText, cached } from './shared'
import { readdir } from 'fs/promises'

function failE(error: string) {
  return { ...fail(error), source: 'live' }
}

const SANDBOX_ID_RE = /^[0-9a-f]{64}$/
const MONITOR_URL = 'http://127.0.0.1:8090'

// ── real enumeration ─────────────────────────────────────────────────

interface RawSandbox {
  id: string
  source: 'kata-monitor' | 'go-shim' | 'rust-shim'
  runtime: 'kata-qemu' | 'kata-clh'
  vmm: string
}

async function monitorSandboxes(): Promise<RawSandbox[]> {
  try {
    const res = await fetch(`${MONITOR_URL}/sandboxes`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return []
    const text = await res.text()
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => SANDBOX_ID_RE.test(l))
      .map((id) => ({ id, source: 'kata-monitor' as const, runtime: 'kata-qemu' as const, vmm: 'qemu' }))
  } catch {
    return []
  }
}

async function fsSandboxes(): Promise<RawSandbox[]> {
  const out: RawSandbox[] = []
  for (const [root, source, runtime] of [
    ['/run/vc/sbs', 'go-shim', 'kata-qemu'],
    ['/run/kata', 'rust-shim', 'kata-clh'],
  ] as const) {
    try {
      const entries = await readdir(root)
      for (const e of entries) {
        if (!SANDBOX_ID_RE.test(e)) continue
        out.push({ id: e, source, runtime, vmm: runtime === 'kata-qemu' ? 'qemu' : 'cloud-hypervisor' })
      }
    } catch {
      continue
    }
  }
  return out
}

/** Sandbox enumeration, TTL-cached and single-flight: summary and list
 *  polls share one monitor+fs sweep. */
async function enumerate(): Promise<RawSandbox[]> {
  return cached('kata:sandboxes', 3_000, async () => {
    const viaMonitor = await monitorSandboxes()
    const viaFs = await fsSandboxes()
    const seen = new Set(viaMonitor.map((s) => s.id))
    return [...viaMonitor, ...viaFs.filter((s) => !seen.has(s.id))]
  })
}

async function kataVersion(): Promise<string | null> {
  return cached('kata:version', 300_000, async () => {
    const r = await run('kata-runtime', ['--version'], 10_000)
    if (r.rc !== 0) return null
    const m = r.stdout.match(/kata-runtime\s+([^\s]+)/)
    return m ? m[1] : r.stdout.trim().split('\n')[0] ?? null
  })
}

async function hostCapable(): Promise<boolean | null> {
  const r = await run('kata-runtime', ['check'], 20_000)
  return r.rc === 0 ? true : r.rc === 127 ? null : false
}

// ── commands ─────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    const haveRuntime = await which('kata-runtime')
    const haveMonitor = await which('kata-monitor')
    if (!haveRuntime && !haveMonitor) {
      return ok(
        { pods: 0, running: 0, stopped: 0, vmm: 'not installed' },
        'live',
        'kata-runtime / kata-monitor not detected — install katacontainers and sandboxes appear here automatically',
      )
    }
    const sandboxes = await enumerate()
    const version = await kataVersion()
    const capable = await hostCapable()
    return ok(
      {
        pods: sandboxes.length,
        running: sandboxes.length, // an enumerated sandbox dir/monitor entry is a live sandbox
        stopped: 0,
        vmm: version ?? (haveMonitor ? 'kata-monitor' : 'unknown'),
        hostCapable: capable,
        monitor: haveMonitor ? 'present' : 'absent',
      },
      'live',
      `real enumeration: kata-monitor ${MONITOR_URL}/sandboxes + /run/vc/sbs + /run/kata scans`,
    )
  },

  list: async () => {
    const sandboxes = await enumerate()
    if (!(await which('kata-runtime')) && !(await which('kata-monitor'))) {
      return ok(
        { pods: [], count: 0 },
        'live',
        'kata-runtime / kata-monitor not detected — install katacontainers for a live sandbox inventory',
      )
    }
    const pods = sandboxes.map((s) => ({
      id: s.id,
      name: s.id.slice(0, 12),
      runtime: s.runtime,
      sandbox: s.source,
      state: 'running' as const,
      vmm: s.vmm,
      memMb: 0,
      cpuPct: 0,
      pods: 1,
    }))
    return ok({ pods, count: pods.length }, 'live', 'real enumeration via kata-monitor + shim filesystem')
  },

  inspect: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!SANDBOX_ID_RE.test(id)) return failE('invalid sandbox id (64 hex chars expected)')
    const sandboxes = await enumerate()
    if (!sandboxes.some((s) => s.id === id)) return failE(`sandbox ${id.slice(0, 12)} not found in the live inventory`)
    const detail: Record<string, unknown> = { id, source: sandboxes.find((s) => s.id === id)?.source }
    // real kata-monitor agent-url probe
    try {
      const res = await fetch(`${MONITOR_URL}/agent-url?id=${id}&ns=default`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) detail.agentUrl = (await res.text()).trim()
    } catch {
      // monitor absent — filesystem facts only
    }
    // readText yields '' for every failure mode — an empty string is
    // an absent socket, and only a non-empty read proves the shim.
    const shimSock = await readText(`/run/vc/sbs/${id}/shim.sock`)
    if (shimSock !== '') detail.shimSocket = `/run/vc/sbs/${id}/shim.sock`
    return ok(detail, 'live')
  },

  start: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    return failE(
      'kata sandboxes are created and started by their container engine (containerd/CRI-O with the kata runtimeClass) — sysdeck reports the live inventory; create sandboxes through the engine',
    )
  },

  stop: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    return failE(
      'kata sandbox lifecycle belongs to its container engine (containerd/CRI-O) — stop the owning pod/container there; sysdeck reports the live inventory',
    )
  },

  version: async () => {
    const version = await kataVersion()
    if (!version) return failE('kata-runtime not detected')
    const env = await run('kata-runtime', ['env', '--json'], 10_000)
    let structured: unknown = null
    if (env.rc === 0 && env.stdout.trim()) {
      try {
        structured = JSON.parse(env.stdout)
      } catch {
        structured = null
      }
    }
    return ok({ version, structured }, 'live')
  },

  check: async () => {
    const capable = await hostCapable()
    if (capable === null) return failE('kata-runtime not detected')
    const r = await run('kata-runtime', ['check'], 20_000)
    return ok({ capable, output: r.stdout.trim() }, 'live', capable ? 'host can run kata containers' : 'host lacks kata requirements (see output)')
  },
}
