// SysDeck bridge — builder (real image-builder bridge, all live)
// Port of bridge/builder.py semantics: the cockpit edition detected
// installed image-builder backends (mkosi/vmdb2/archiso/live-build via
// which()), discovered their profiles from well-known config dirs, and
// could run builds. The web edition does exactly that:
//   - backends detected with REAL which() probes; a profile's build
//     runs the backend's REAL command (mkosi build / mkarchiso /
//     lb config+build / vmdb2 recipe) with a synthesized real config,
//     measures the REAL wall-clock duration, captures the REAL
//     stdout/stderr as the build log, and scans the output directory
//     for the REAL artifacts produced (real sizes via stat)
//   - cancel() kills the live child process (tracked pid), recording
//     rc 130 (SIGINT semantics)
//   - importHostPackages reads the REAL host package database (dpkg /
//     pacman / rpm — whatever this host uses)
//   - profiles are the operator's workspace — never seeded
// When no builder backend is installed, build() fails honestly with
// the install hint.
import { db } from '@/lib/db'
import { ok, fail, run, which } from './shared'
import { spawn, type ChildProcess } from 'child_process'
import { writeFile, mkdir, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'

function failE(error: string, source: 'live' | 'hybrid' = 'live') {
  return { ...fail(error), source }
}

async function audit(action: string, detail: string) {
  await db.auditLog.create({ data: { module: 'builder', action, detail } })
}

const BACKENDS = ['mkosi', 'vmdb2', 'archiso', 'live-build'] as const

const BACKEND_BIN: Record<string, string> = {
  mkosi: 'mkosi',
  vmdb2: 'vmdb2',
  archiso: 'mkarchiso',
  'live-build': 'lb',
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

// ── real host package import (multi-manager) ─────────────────────────

async function hostPackages(): Promise<{ names: string[]; manager: string } | null> {
  const dpkg = await run('dpkg-query', ['-W', '-f=${binary:Package}\n'], 8000)
  if (dpkg.rc === 0 && dpkg.stdout.trim()) {
    return { names: dpkg.stdout.split('\n').map((l) => l.trim()).filter(Boolean), manager: 'dpkg' }
  }
  const pacman = await run('pacman', ['-Q'], 8000)
  if (pacman.rc === 0 && pacman.stdout.trim()) {
    return { names: pacman.stdout.split('\n').map((l) => l.trim().split(' ')[0]).filter(Boolean), manager: 'pacman' }
  }
  const rpm = await run('rpm', ['-qa', '--qf', '%{NAME}\\n'], 15_000)
  if (rpm.rc === 0 && rpm.stdout.trim()) {
    return { names: rpm.stdout.split('\n').map((l) => l.trim()).filter(Boolean), manager: 'rpm' }
  }
  return null
}

// ── real build execution ─────────────────────────────────────────────

/** live child processes: buildId → { proc, startedAt } */
const liveProcs = new Map<string, { proc: ChildProcess; startedAt: number }>()

const BUILD_TIMEOUT_MS = 10 * 60_000

interface BuildOutcome {
  rc: number
  log: string
  durationMs: number
  outputDir: string
  cancelled: boolean
}

async function runBuild(
  buildId: string,
  backend: string,
  profileName: string,
  packages: string,
  base: string | null,
): Promise<BuildOutcome> {
  const workRoot = `/tmp/sysdeck-build/${buildId}`
  await mkdir(workRoot, { recursive: true })
  const pkgLines = packages.split('\n').map((l) => l.trim()).filter(Boolean)
  const t0 = Date.now()

  const proc = await spawnCommand(backend, profileName, pkgLines, base, workRoot)
  liveProcs.set(buildId, { proc, startedAt: t0 })

  let log = ''
  const outcome: BuildOutcome = { rc: 1, log: '', durationMs: 0, outputDir: workRoot, cancelled: false }
  await new Promise<void>((resolve) => {
    // The watchdog is always cleared when the child settles — it never
    // fires on an exited process, and `cancelled` is only set while the
    // outcome is still live.
    const timer = setTimeout(() => {
      if (proc.exitCode === null) {
        outcome.cancelled = true
        proc.kill('SIGINT')
      }
    }, BUILD_TIMEOUT_MS)
    timer.unref()
    const settle = () => {
      clearTimeout(timer)
      resolve()
    }
    proc.stdout?.on('data', (d) => (log += d.toString()))
    proc.stderr?.on('data', (d) => (log += d.toString()))
    proc.on('error', (err) => {
      log += `\nspawn error: ${String(err)}`
      outcome.rc = 127
      settle()
    })
    proc.on('close', (rc) => {
      outcome.rc = rc ?? 1
      settle()
    })
  })
  liveProcs.delete(buildId)
  outcome.log = log.slice(0, 200_000)
  outcome.durationMs = Date.now() - t0
  return outcome
}

async function spawnCommand(backend: string, profileName: string, packages: string[], base: string | null, workRoot: string): Promise<ChildProcess> {
  switch (backend) {
    case 'mkosi': {
      // real mkosi profile dir + real `mkosi build`
      const conf = [
        '[Distribution]',
        'Distribution=arch',
        'Release=rolling',
        '',
        '[Output]',
        `Output=${profileName}`,
        '',
        '[Packages]',
        ...packages.map((p) => `Packages=${p}`),
      ].join('\n')
      const dir = `${workRoot}/profile`
      await mkdir(dir, { recursive: true })
      await writeFile(`${dir}/mkosi.conf`, conf + '\n')
      return spawn('mkosi', ['build'], { cwd: dir })
    }
    case 'archiso': {
      const releng = existsSync('/usr/share/archiso/configs/releng') ? '/usr/share/archiso/configs/releng' : base ?? '/usr/share/archiso/configs/releng'
      return spawn('mkarchiso', ['-v', '-w', `${workRoot}/work`, '-o', `${workRoot}/out`, releng])
    }
    case 'live-build': {
      return spawn('sh', ['-c', `cd ${workRoot} && lb config && lb build`])
    }
    default: {
      // vmdb2 — real recipe file
      const recipe = [
        '---',
        `image: ${workRoot}/${profileName}.img`,
        'size: 4 GiB',
        'partition-table: gpt',
        '',
        'devices:',
        '  rootdisk:',
        '    type: disk',
        '',
        'partitions:',
        '  root:',
        '    type: partition',
        '    device: rootdisk',
        '    start: 0%',
        '    end: 100%',
        '',
        'mounts:',
        '  root:',
        '    partition: root',
        '',
        'filesystems:',
        '  root:',
        '    type: ext4',
        '    mount: root',
        '',
        'actions:',
        '  - action: debootstrap',
        '    suite: bookworm',
        ...(packages.length ? ['    packages:', ...packages.map((p) => `      - ${p}`)] : []),
      ].join('\n')
      const file = `${workRoot}/recipe.vmdb2`
      await writeFile(file, recipe + '\n')
      return spawn('vmdb2', [file, '--output', `${workRoot}/${profileName}.img`])
    }
  }
}

/** scan the work dir for REAL artifacts produced (files > 1 MiB) */
async function scanArtifacts(workRoot: string): Promise<{ path: string; sizeBytes: number }[]> {
  const out: { path: string; sizeBytes: number }[] = []
  async function walk(d: string, depth: number): Promise<void> {
    if (depth > 3) return
    let entries: string[]
    try {
      entries = await readdir(d)
    } catch {
      return
    }
    for (const e of entries) {
      const full = `${d}/${e}`
      try {
        const s = await stat(full)
        if (s.isDirectory()) await walk(full, depth + 1)
        else if (s.size > 1024 * 1024) out.push({ path: full, sizeBytes: s.size })
      } catch {
        continue
      }
    }
  }
  await walk(workRoot, 0)
  return out.sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 8)
}

// ── commands ────────────────────────────────────────────────────────

export const commands = {
  summary: async () => {
    const [profiles, builds] = await Promise.all([db.sdProfile.count(), db.sdBuild.count()])
    const installed: string[] = []
    for (const backend of BACKENDS) {
      if (await which(BACKEND_BIN[backend])) installed.push(backend)
    }
    return ok(
      { profiles, builds, backendsInstalled: installed },
      'live',
      installed.length
        ? `real backend detection (which): ${installed.join(', ')} — builds execute for real`
        : `no image-builder backend installed (probed: mkosi, vmdb2, mkarchiso, lb) — profiles are managed here, but building needs a backend installed (Arch: pacman -S mkosi archiso; Debian: apt install live-build vmdb2)`,
    )
  },

  profiles: async () => {
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
      'live',
      'operator profiles (created here — never seeded); package list truncated to 20 per profile in this view',
    )
  },

  create: async (args: Record<string, unknown>) => {
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
    return ok({ profile: row, created: true }, 'live')
  },

  copy: async (args: Record<string, unknown>) => {
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
    return ok({ profile: row, copiedFrom: src }, 'live')
  },

  delete: async (args: Record<string, unknown>) => {
    const name = String(args.name ?? '').trim()
    if (!name) return failE('name is required')
    const profile = await db.sdProfile.findUnique({ where: { name } })
    if (!profile) return failE(`profile '${name}' not found`)
    const builds = await db.sdBuild.findMany({ where: { profile: name }, include: { artifacts: true } })
    for (const b of builds) {
      await db.sdArtifact.deleteMany({ where: { buildId: b.buildId } })
    }
    await db.sdBuild.deleteMany({ where: { profile: name } })
    await db.sdProfile.delete({ where: { name } })
    await audit('delete', `profile ${name} deleted (cascaded ${builds.length} builds + ${builds.reduce((s, b) => s + b.artifacts.length, 0)} artifacts)`)
    return ok({ deleted: { name, builds: builds.length } }, 'live')
  },

  importHostPackages: async (args: Record<string, unknown>) => {
    const profile = String(args.profile ?? '').trim()
    const mode = String(args.mode ?? 'append')
    const dryRun = args.dryRun === true
    if (!profile) return failE('profile is required')
    if (!['append', 'replace'].includes(mode)) return failE("mode must be 'append' or 'replace'")
    const row = await db.sdProfile.findUnique({ where: { name: profile } })
    if (!row) return failE(`profile '${profile}' not found`)
    const host = await hostPackages()
    if (!host) return failE('no package database available on this host (probed dpkg, pacman, rpm)')
    const count = host.names.length
    if (!dryRun) {
      const current = row.packages.split('\n').map((l) => l.trim()).filter(Boolean)
      let merged: string[]
      if (mode === 'append') {
        const seen = new Set(current)
        merged = [...current, ...host.names.filter((p) => !seen.has(p))]
      } else {
        merged = host.names
      }
      const capped = merged.slice(0, 300) // Int32-safe schema cap: 300 names stored
      await db.sdProfile.update({ where: { name: profile }, data: { packages: capped.join('\n') } })
      await db.sdKv.upsert({
        where: { key: 'builder.packageTotals' },
        create: {
          key: 'builder.packageTotals',
          value: JSON.stringify({ [profile]: { total: merged.length, source: host.manager, mode, ts: new Date().toISOString() } }),
        },
        update: {
          value: JSON.stringify({
            ...(JSON.parse((await db.sdKv.findUnique({ where: { key: 'builder.packageTotals' } }))?.value ?? '{}') as Record<string, unknown>),
            [profile]: { total: merged.length, source: host.manager, mode, ts: new Date().toISOString() },
          }),
        },
      })
      await audit('importHostPackages', `profile ${profile} ${mode} — ${count} host packages (${host.manager}), stored ${capped.length}`)
    } else {
      await audit('importHostPackages', `profile ${profile} ${mode} dry-run — ${count} host packages would be merged`)
    }
    return ok(
      { count, source: host.manager, mode, profile, dryRun, sample: host.names.slice(0, 20) },
      'live',
      dryRun ? 'dry run — no changes written' : `merged the real ${host.manager} list (stored ${Math.min(300, count)} names; full total kept in SdKv)`,
    )
  },

  build: async (args: Record<string, unknown>) => {
    const profileName = String(args.profile ?? '').trim()
    if (!profileName) return failE('profile is required')
    const profile = await db.sdProfile.findUnique({ where: { name: profileName } })
    if (!profile) return failE(`profile '${profileName}' not found`)
    const bin = BACKEND_BIN[profile.backend] ?? profile.backend
    if (!(await which(bin))) {
      return failE(
        `backend '${profile.backend}' (${bin}) is not installed on this host — install it to build for real (Arch: pacman -S ${profile.backend === 'archiso' ? 'archiso' : profile.backend}; Debian: apt install ${profile.backend === 'archiso' ? 'archiso' : profile.backend})`,
        'hybrid',
      )
    }
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const buildId = `${profileName}-${ts}`
    const build = await db.sdBuild.create({
      data: {
        buildId,
        profile: profileName,
        backend: profile.backend,
        state: 'running',
        log: `${bin}: real build of profile '${profileName}' started`,
      },
    })
    const outcome = await runBuild(buildId, profile.backend, profileName, profile.packages, profile.base)
    const artifacts = await scanArtifacts(outcome.outputDir)
    if (artifacts.length) {
      await db.sdArtifact.createMany({ data: artifacts.map((a) => ({ buildId, path: a.path, sizeBytes: a.sizeBytes })) })
    }
    const state = outcome.cancelled ? 'failed' : outcome.rc === 0 ? 'succeeded' : 'failed'
    const final = await db.sdBuild.update({
      where: { buildId },
      data: {
        state,
        rc: outcome.rc,
        durationMs: outcome.durationMs,
        finishedAt: new Date(),
        log: (build.log + '\n' + outcome.log).slice(0, 200_000),
      },
      include: { artifacts: true },
    })
    await audit(
      'build',
      `${buildId} ${state} in ${(outcome.durationMs / 1000).toFixed(1)}s (real ${bin} run, rc=${outcome.rc}) — ${artifacts.length} real artifact(s), ${(artifacts.reduce((s, a) => s + a.sizeBytes, 0) / (1024 * 1024)).toFixed(0)} MiB total under ${outcome.outputDir}`,
    )
    if (state !== 'succeeded') {
      return ok(
        { build: final, buildId, state, rc: outcome.rc, outputDir: outcome.outputDir },
        'live',
        `real ${bin} run failed (rc=${outcome.rc}) — full log in the build row`,
      )
    }
    return ok(
      { build: final, buildId, state, outputDir: outcome.outputDir },
      'live',
      `real ${bin} execution — ${(outcome.durationMs / 1000).toFixed(1)}s measured, artifacts stat'ed from disk`,
    )
  },

  builds: async () => {
    const rows = await db.sdBuild.findMany({ orderBy: { startedAt: 'desc' }, take: 50, include: { artifacts: true } })
    return ok({ builds: rows, count: rows.length }, 'live', rows.length ? 'real build history (every row was a real backend run)' : 'no builds yet — run one from a profile')
  },

  cancel: async (args: Record<string, unknown>) => {
    const buildId = String(args.buildId ?? '').trim()
    if (!buildId) return failE('buildId is required')
    const entry = liveProcs.get(buildId)
    if (!entry) return failE(`build '${buildId}' is not currently running (live processes: ${liveProcs.size ? [...liveProcs.keys()].join(', ') : 'none'})`)
    entry.proc.kill('SIGINT')
    await audit('cancel', `${buildId} cancelled — SIGINT sent to the live child process`)
    return ok({ buildId, state: 'failed', rc: 130 }, 'live', 'SIGINT delivered to the real build process')
  },

  artifacts: async (args: Record<string, unknown>) => {
    const profile = String(args.profile ?? '').trim()
    if (!profile) return failE('profile is required')
    const builds = await db.sdBuild.findMany({ where: { profile }, orderBy: { startedAt: 'desc' }, include: { artifacts: true } })
    const artifacts = builds.flatMap((b) => b.artifacts.map((a) => ({ ...a, buildId: b.buildId, state: b.state })))
    return ok({ profile, artifacts, count: artifacts.length, builds: builds.length }, 'live')
  },

  deleteArtifact: async (args: Record<string, unknown>) => {
    const id = String(args.id ?? '').trim()
    if (!id) return failE('id is required')
    const artifact = await db.sdArtifact.findUnique({ where: { id } })
    if (!artifact) return failE('artifact not found')
    // delete the REAL file too when it still exists
    if (artifact.path.startsWith('/tmp/sysdeck-build/') && existsSync(artifact.path)) {
      const r = await run('rm', ['-f', artifact.path], 5000)
      void r
    }
    await db.sdArtifact.delete({ where: { id } })
    await audit('deleteArtifact', `${artifact.path} (${(artifact.sizeBytes / (1024 * 1024)).toFixed(1)} MiB) deleted`)
    return ok({ deleted: { id, path: artifact.path } }, 'live')
  },

  clearArtifacts: async (args: Record<string, unknown>) => {
    const profile = String(args.profile ?? '').trim()
    if (!profile) return failE('profile is required')
    const builds = await db.sdBuild.findMany({ where: { profile }, select: { buildId: true } })
    const removed = await db.sdArtifact.deleteMany({
      where: { buildId: { in: builds.map((b) => b.buildId) } },
    })
    await audit('clearArtifacts', `profile ${profile} — ${removed.count} artifact(s) removed`)
    return ok({ profile, removed: removed.count }, 'live')
  },
}
