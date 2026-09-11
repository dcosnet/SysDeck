// SysDeck bridge — builder (hybrid: image-profile registry + REAL host
// package import)
// Port of bridge/builder.py semantics: the cockpit edition detected
// installed image-builder backends (mkosi/vmdb2/archiso/live-build via
// which()), discovered their profiles from well-known config dirs, and
// could run builds. In this sandbox no builder binary exists, so
// profiles are a seeded registry, `build` is a simulated staged
// pipeline (deterministic, no real waiting), and
// importHostPackages is REAL: it shells out to
// `dpkg-query -W -f='${binary:Package}\n'` and merges the actual
// installed package list into a profile.
import { db } from '@/lib/db'
import { ok, fail, run, which } from './shared'

const SOURCE = 'hybrid' as const
const NOTE = 'no mkosi/vmdb2/archiso/live-build binaries in sandbox — profiles are a seeded registry, builds are simulated; importHostPackages reads the REAL dpkg database'

function failE(error: string) {
  return { ...fail(error), source: SOURCE }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'builder', action, detail } })
}

const BACKENDS = ['mkosi', 'vmdb2', 'archiso', 'live-build'] as const

// ── lazy seed ───────────────────────────────────────────────────────

async function seedWorkstationPackages(): Promise<string> {
  // REAL: first 412 installed packages from this host's dpkg database
  const r = await run('dpkg-query', ['-W', '-f=${binary:Package}\n'], 8000)
  if (r.rc === 0 && r.stdout.trim()) {
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 412)
      .join('\n')
  }
  return 'linux\nlinux-firmware\nsystemd\nopenssh\ndocker\npipewire\nnetworkmanager\ngnome\nfirefox'
}

async function ensureSeeded(): Promise<void> {
  const count = await db.sdProfile.count()
  if (count > 0) return
  await db.sdProfile.createMany({
    data: [
      {
        name: 'myarch',
        backend: 'mkosi',
        base: null,
        packages: 'linux\nlinux-firmware\nsystemd\nopenssh\ndocker',
      },
      {
        name: 'workstation',
        backend: 'mkosi',
        base: null,
        packages: await seedWorkstationPackages(),
      },
      {
        name: 'debian-releng',
        backend: 'archiso',
        base: 'releng',
        packages: 'arch-install-scripts\nsyslinux\nedk2-ovmf\nmemtest86+',
      },
      {
        name: 'ubuntu-live',
        backend: 'live-build',
        base: null,
        packages: 'live-build\nubuntu-standard\ncasper\ndosfstools',
      },
    ],
  })
  await audit('seed', 'seeded build profiles: myarch (mkosi), workstation (mkosi, 412 packages from real dpkg), debian-releng (archiso/releng), ubuntu-live (live-build)')
}

// ── validation ──────────────────────────────────────────────────────

function validName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && !name.includes('..')
}

function packageList(packages: unknown): string {
  if (typeof packages === 'string') return packages
  if (Array.isArray(packages)) return packages.map(String).join('\n')
  return ''
}

// ── simulated build pipeline ────────────────────────────────────────

interface ArtifactSpec {
  path: string
  sizeBytes: number
}

function artifactsFor(profile: { name: string; backend: string; packages: string }): ArtifactSpec[] {
  const pkgCount = profile.packages.split('\n').filter((l) => l.trim()).length
  switch (profile.backend) {
    case 'mkosi':
      return [
        { path: `/var/lib/mkosi/output/${profile.name}/image.raw`, sizeBytes: 894128537 },
        { path: `/var/lib/mkosi/output/${profile.name}/rootfs.tar.xz`, sizeBytes: 220200960 + pkgCount * 1024 },
      ]
    case 'archiso':
      return [{ path: `/var/cache/archiso/out/${profile.name}.iso`, sizeBytes: 1073741824 }]
    case 'live-build':
      return [{ path: `/var/cache/live-build/${profile.name}/binary.hybrid.iso`, sizeBytes: 1288490188 }]
    default: // vmdb2
      return [{ path: `/var/lib/sysdeck/images/${profile.name}.img`, sizeBytes: 858993459 }]
  }
}

function buildLog(profile: { name: string; backend: string; base: string | null; packages: string }, durationMs: number, artifacts: ArtifactSpec[]): string {
  const pkgCount = profile.packages.split('\n').filter((l) => l.trim()).length
  const stage = (i: number, n: number, name: string, ms: number) =>
    `${profile.backend}: ● Running build stage ${i}/${n}: ${name} (${(ms / 1000).toFixed(1)}s)`
  const lines = [
    `${profile.backend}: Using profile '${profile.name}' (backend ${profile.backend}, base=${profile.base ?? 'null'})`,
    ...(['mkosi', 'vmdb2'].includes(profile.backend)
      ? [`${profile.backend}: Distribution: ${profile.backend === 'mkosi' ? 'arch' : 'debian'}, release: current`]
      : [`${profile.backend}: Using shipped profile '${profile.base ?? profile.name}' as the base`]),
    `${profile.backend}: Installing packages: ${pkgCount}`,
    stage(1, 5, 'prepare', durationMs * 0.06),
    stage(2, 5, 'dependency-resolve', durationMs * 0.09),
    stage(3, 5, 'install-rootfs', durationMs * 0.55),
    stage(4, 5, 'configure', durationMs * 0.18),
    stage(5, 5, 'output', durationMs * 0.12),
    `${profile.backend}: ● Build finished in ${(durationMs / 1000).toFixed(1)}s`,
    ...artifacts.map((a) => `${profile.backend}: Output: ${a.path} (${(a.sizeBytes / (1024 * 1024)).toFixed(1)} MiB)`),
  ]
  return lines.join('\n')
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    await ensureSeeded()
    const [profiles, builds] = await Promise.all([db.sdProfile.count(), db.sdBuild.count()])
    // REAL backend detection (which())
    const installed: string[] = []
    for (const [backend, binary] of [
      ['mkosi', 'mkosi'],
      ['vmdb2', 'vmdb2'],
      ['archiso', 'mkarchiso'],
      ['live-build', 'lb'],
    ] as const) {
      if (await which(binary)) installed.push(backend)
    }
    return ok({ profiles, builds, backendsInstalled: installed }, SOURCE, NOTE)
  },

  profiles: async () => {
    await ensureSeeded()
    const rows = await db.sdProfile.findMany({ orderBy: { name: 'asc' } })
    return ok(
      {
        profiles: rows.map((p) => ({
          ...p,
          packageCount: p.packages.split('\n').filter((l) => l.trim()).length,
          packages: p.packages.split('\n').filter((l) => l.trim()).slice(0, 20),
        })),
        count: rows.length,
      },
      SOURCE,
      'package list truncated to 20 per profile in this view — full list stays in the row',
    )
  },

  create: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const name = String(args.name ?? '').trim()
    const backend = String(args.backend ?? '').trim()
    const packages = packageList(args.packages)
    if (!name) return failE('name is required')
    if (!validName(name)) return failE(`invalid profile name '${name}' — no slashes, no '..', alphanumerics/dots/dashes/underscores only`)
    if (!BACKENDS.includes(backend as (typeof BACKENDS)[number])) return failE(`backend must be one of: ${BACKENDS.join(', ')}`)
    const existing = await db.sdProfile.findUnique({ where: { name } })
    if (existing) return failE(`profile '${name}' already exists`)
    const row = await db.sdProfile.create({ data: { name, backend, base: null, packages } })
    await audit('create', `profile ${name} (backend ${backend}, ${packages ? `${packages.split('\n').length} packages` : 'no packages'})`)
    return ok({ profile: row, created: true }, SOURCE)
  },

  copy: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const src = String(args.src ?? '').trim()
    const name = String(args.name ?? '').trim()
    if (!src) return failE('src is required')
    if (!name) return failE('name is required')
    if (!validName(name)) return failE(`invalid profile name '${name}' — no slashes, no '..', alphanumerics/dots/dashes/underscores only`)
    const source = await db.sdProfile.findUnique({ where: { name: src } })
    if (!source) return failE(`source profile '${src}' not found`)
    if (await db.sdProfile.findUnique({ where: { name } })) return failE(`profile '${name}' already exists`)
    const row = await db.sdProfile.create({
      data: { name, backend: source.backend, base: source.name, packages: source.packages },
    })
    await audit('copy', `profile ${src} → ${name} (copied backend + ${source.packages.split('\n').filter((l) => l.trim()).length} packages)`)
    return ok({ profile: row, copiedFrom: src }, SOURCE)
  },

  delete: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const name = String(args.name ?? '').trim()
    if (!name) return failE('name is required')
    const profile = await db.sdProfile.findUnique({ where: { name } })
    if (!profile) return failE(`profile '${name}' not found`)
    // cascade: artifacts → builds → profile
    const builds = await db.sdBuild.findMany({ where: { profile: name }, include: { artifacts: true } })
    for (const b of builds) {
      await db.sdArtifact.deleteMany({ where: { buildId: b.buildId } })
    }
    await db.sdBuild.deleteMany({ where: { profile: name } })
    await db.sdProfile.delete({ where: { name } })
    await audit('delete', `profile ${name} deleted (cascaded ${builds.length} builds + ${builds.reduce((s, b) => s + b.artifacts.length, 0)} artifacts)`)
    return ok({ deleted: { name, builds: builds.length } }, SOURCE)
  },

  importHostPackages: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const profile = String(args.profile ?? '').trim()
    const mode = String(args.mode ?? 'append')
    const dryRun = args.dryRun === true
    if (!profile) return failE('profile is required')
    if (!['append', 'replace'].includes(mode)) return failE("mode must be 'append' or 'replace'")
    const row = await db.sdProfile.findUnique({ where: { name: profile } })
    if (!row) return failE(`profile '${profile}' not found`)
    // REAL: the host's installed package list via dpkg-query
    const r = await run('dpkg-query', ['-W', '-f=${binary:Package}\n'], 8000)
    if (r.rc !== 0 || !r.stdout.trim()) return failE(`dpkg-query failed (rc=${r.rc}): ${r.stderr.trim() || 'no output'}`)
    const hostPackages = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    const count = hostPackages.length
    if (!dryRun) {
      const current = row.packages.split('\n').map((l) => l.trim()).filter(Boolean)
      let merged: string[]
      if (mode === 'append') {
        const seen = new Set(current)
        merged = [...current, ...hostPackages.filter((p) => !seen.has(p))]
      } else {
        merged = hostPackages
      }
      const capped = merged.slice(0, 300) // Int32-safe schema cap: 300 names stored
      await db.sdProfile.update({ where: { name: profile }, data: { packages: capped.join('\n') } })
      // the real total lives in SdKv (packages column holds max 300)
      await db.sdKv.upsert({
        where: { key: 'builder.packageTotals' },
        create: {
          key: 'builder.packageTotals',
          value: JSON.stringify({ [profile]: { total: merged.length, source: 'dpkg', mode, ts: new Date().toISOString() } }),
        },
        update: {
          value: JSON.stringify({
            ...(JSON.parse((await db.sdKv.findUnique({ where: { key: 'builder.packageTotals' } }))?.value ?? '{}') as Record<string, unknown>),
            [profile]: { total: merged.length, source: 'dpkg', mode, ts: new Date().toISOString() },
          }),
        },
      })
      await audit('importHostPackages', `profile ${profile} ${mode} — ${count} host packages (dpkg), stored ${capped.length}`)
    } else {
      await audit('importHostPackages', `profile ${profile} ${mode} dry-run — ${count} host packages would be merged`)
    }
    return ok(
      { count, source: 'dpkg', mode, profile, dryRun, sample: hostPackages.slice(0, 20) },
      SOURCE,
      dryRun ? 'dry run — no changes written' : `merged real dpkg list (stored ${Math.min(300, count)} names; full total kept in SdKv)`,
    )
  },

  build: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const profileName = String(args.profile ?? '').trim()
    if (!profileName) return failE('profile is required')
    const profile = await db.sdProfile.findUnique({ where: { name: profileName } })
    if (!profile) return failE(`profile '${profileName}' not found`)
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const buildId = `${profileName}-${ts}`
    const durationMs = 8000 + Math.floor(Math.random() * 12000) // 8–20s synthetic
    const artifacts = artifactsFor(profile)
    // queued → running → succeeded, computed immediately (no real wait)
    const build = await db.sdBuild.create({
      data: {
        buildId,
        profile: profileName,
        backend: profile.backend,
        state: 'queued',
        log: `${profile.backend}: queued build of profile '${profileName}'`,
      },
    })
    await db.sdBuild.update({
      where: { buildId },
      data: {
        state: 'running',
        log: `${build.log}\n${profile.backend}: build started (pid ${1000 + Math.floor(Math.random() * 30000)})`,
      },
    })
    await db.sdArtifact.createMany({
      data: artifacts.map((a) => ({ buildId, path: a.path, sizeBytes: a.sizeBytes })),
    })
    const final = await db.sdBuild.update({
      where: { buildId },
      data: {
        state: 'succeeded',
        rc: 0,
        durationMs,
        finishedAt: new Date(),
        log: buildLog(profile, durationMs, artifacts),
      },
      include: { artifacts: true },
    })
    await audit('build', `${buildId} succeeded in ${(durationMs / 1000).toFixed(1)}s — ${artifacts.length} artifact(s), ${(artifacts.reduce((s, a) => s + a.sizeBytes, 0) / (1024 * 1024)).toFixed(0)} MiB total`)
    return ok({ build: final, buildId, state: 'succeeded' }, SOURCE, 'simulated staged pipeline — durationMs is synthetic (8–20s), artifacts are demo rows')
  },

  builds: async () => {
    await ensureSeeded()
    const rows = await db.sdBuild.findMany({ orderBy: { startedAt: 'desc' }, take: 50, include: { artifacts: true } })
    return ok({ builds: rows, count: rows.length }, SOURCE)
  },

  cancel: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const buildId = String(args.buildId ?? '').trim()
    if (!buildId) return failE('buildId is required')
    const build = await db.sdBuild.findUnique({ where: { buildId }, include: { artifacts: true } })
    if (!build) return failE(`build '${buildId}' not found`)
    if (build.state !== 'running' && build.state !== 'queued') return failE(`build ${buildId} already finished (state: ${build.state})`)
    const row = await db.sdBuild.update({
      where: { buildId },
      data: {
        state: 'failed',
        rc: 130, // SIGINT — the classic build-cancel exit code
        finishedAt: new Date(),
        log: `${build.log}\n${build.backend}: ✗ cancelled by operator (SIGINT)`,
      },
    })
    await db.sdArtifact.deleteMany({ where: { buildId } })
    await audit('cancel', `${buildId} cancelled — recorded as failed/rc 130 (schema states: queued|running|succeeded|failed)`)
    return ok(
      { build: row, state: 'failed', rc: 130 },
      SOURCE,
      "cancelled — the build schema has no 'cancelled' state, so it is recorded as failed with rc 130 (SIGINT) and its artifacts were dropped",
    )
  },

  artifacts: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const profile = String(args.profile ?? '').trim()
    if (!profile) return failE('profile is required')
    const builds = await db.sdBuild.findMany({ where: { profile }, orderBy: { startedAt: 'desc' }, include: { artifacts: true } })
    const artifacts = builds.flatMap((b) => b.artifacts.map((a) => ({ ...a, buildId: b.buildId, state: b.state })))
    return ok({ profile, artifacts, count: artifacts.length, builds: builds.length }, SOURCE)
  },

  deleteArtifact: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const id = String(args.id ?? '').trim()
    if (!id) return failE('id is required')
    const artifact = await db.sdArtifact.findUnique({ where: { id } })
    if (!artifact) return failE('artifact not found')
    await db.sdArtifact.delete({ where: { id } })
    await audit('deleteArtifact', `${artifact.path} (${(artifact.sizeBytes / (1024 * 1024)).toFixed(1)} MiB) deleted`)
    return ok({ deleted: { id, path: artifact.path } }, SOURCE)
  },

  clearArtifacts: async (args: Record<string, unknown>) => {
    await ensureSeeded()
    const profile = String(args.profile ?? '').trim()
    if (!profile) return failE('profile is required')
    const builds = await db.sdBuild.findMany({ where: { profile }, select: { buildId: true } })
    const removed = await db.sdArtifact.deleteMany({
      where: { buildId: { in: builds.map((b) => b.buildId) } },
    })
    await audit('clearArtifacts', `profile ${profile} — ${removed.count} artifact(s) removed`)
    return ok({ profile, removed: removed.count }, SOURCE)
  },
}
