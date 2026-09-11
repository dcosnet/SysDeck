// SysDeck bridge — kata (demo Kata Containers sandbox inventory)
// Port of bridge/kata.py semantics: the cockpit edition enumerated kata
// sandboxes via kata-monitor HTTP /sandboxes, /run/vc/sbs/<id>/ (Go
// shim) or /run/kata/<id>/ (Rust shim), and reported kata-runtime
// version + host capability. None of that exists in this sandbox, so
// the web edition keeps the same surface (sandbox list with runtime,
// vmm, vCPU/mem, state + lifecycle) over a seeded Prisma inventory.
import { db } from '@/lib/db'
import { ok, fail } from './shared'

const SOURCE = 'demo' as const
const NOTE = 'kata-runtime / kata-monitor not present in sandbox — demo sandbox inventory'

function failE(error: string) {
  return { ...fail(error), source: SOURCE }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'kata', action, detail } })
}

// ── lazy seed ───────────────────────────────────────────────────────

async function ensureSeeded(): Promise<void> {
  const count = await db.kataPod.count()
  if (count > 0) return
  await db.kataPod.createMany({
    data: [
      {
        name: 'confidential-ml',
        runtime: 'kata-qemu',
        sandbox: 'default/confidential-ml',
        state: 'running',
        vmm: 'qemu-system-x86_64 v8.1.2 (confidential guest, memory encryption)',
        memMb: 4096,
        cpuPct: 34.2,
        pods: 2,
      },
      {
        name: 'secure-signing',
        runtime: 'kata-clh',
        sandbox: 'signing/secure-signing',
        state: 'running',
        vmm: 'cloud-hypervisor 38.1',
        memMb: 1024,
        cpuPct: 2.8,
        pods: 1,
      },
      {
        name: 'pci-workload',
        runtime: 'kata-qemu',
        sandbox: 'default/pci-workload',
        state: 'running',
        vmm: 'qemu-system-x86_64 v8.1.2 (vfio-pci passthrough: 0000:01:00.0)',
        memMb: 8192,
        cpuPct: 11.5,
        pods: 1,
      },
      {
        name: 'test-sandbox',
        runtime: 'kata-qemu',
        sandbox: 'default/test-sandbox',
        state: 'stopped',
        vmm: null,
        memMb: 2048,
        cpuPct: 0,
        pods: 1,
      },
      {
        name: 'attested-job',
        runtime: 'kata-clh',
        sandbox: 'jobs/attested-job',
        state: 'running',
        vmm: 'cloud-hypervisor 38.1 (measured boot, TPM 2.0 attestation quote verified)',
        memMb: 2048,
        cpuPct: 6.1,
        pods: 1,
      },
    ],
  })
  await audit('seed', 'seeded demo inventory: 5 kata sandboxes (2 kata-qemu running, 2 kata-clh, 1 stopped)')
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    await ensureSeeded()
    const rows = await db.kataPod.findMany()
    const running = rows.filter((p) => p.state === 'running').length
    const vmms = [...new Set(rows.filter((p) => p.vmm).map((p) => (p.vmm ?? '').split(' (')[0]))]
    return ok(
      {
        pods: rows.length,
        running,
        stopped: rows.length - running,
        vmm: vmms.join(' + ') || 'none',
      },
      SOURCE,
      NOTE,
    )
  },

  list: async () => {
    await ensureSeeded()
    const rows = await db.kataPod.findMany({ orderBy: { name: 'asc' } })
    return ok({ pods: rows, count: rows.length }, SOURCE, NOTE)
  },

  start: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const pod = await db.kataPod.findUnique({ where: { id } })
    if (!pod) return failE('sandbox not found')
    if (pod.state === 'running') return failE(`${pod.name} is already running`)
    const row = await db.kataPod.update({
      where: { id },
      data: {
        state: 'running',
        vmm: pod.runtime === 'kata-clh' ? 'cloud-hypervisor 38.1' : 'qemu-system-x86_64 v8.1.2',
        cpuPct: Math.round((2 + Math.random() * 6) * 10) / 10,
      },
    })
    await audit('start', `kata sandbox ${pod.name} → running (${row.vmm})`)
    return ok({ pod: row, state: 'running' }, SOURCE, `${pod.name} started — demo state transition`)
  },

  stop: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '')
    if (!id) return failE('id is required')
    const pod = await db.kataPod.findUnique({ where: { id } })
    if (!pod) return failE('sandbox not found')
    if (pod.state === 'stopped') return failE(`${pod.name} is already stopped`)
    const row = await db.kataPod.update({ where: { id }, data: { state: 'stopped', cpuPct: 0 } })
    await audit('stop', `kata sandbox ${pod.name} → stopped (vmm torn down)`)
    return ok({ pod: row, state: 'stopped' }, SOURCE, `${pod.name} stopped — demo state transition`)
  },
}
