/**
 * Fester target catalog — the project/target matrix from config.yaml
 * plus the build-system step generators from backend/graph/target_dag.py.
 */

export interface BuildTarget {
  project: string
  name: string // e.g. "debian"
  system: string // make | gentoo | buildroot | openwrt | sourcemage | lunar | alfs
  arch: string
  command: string
}

export interface Project {
  name: string
  repo: string
  targets: { name: string; command: string; system: string; arch: string }[]
}

export const PROJECTS: Project[] = [
  {
    name: 'linux-tool',
    repo: 'https://forgejo.local/linux-tool.git',
    targets: [
      { name: 'debian', command: 'make clean && make debian', system: 'make', arch: 'x86_64' },
      { name: 'arch', command: 'make clean && make arch', system: 'make', arch: 'x86_64' },
      { name: 'fedora', command: 'make clean && make fedora', system: 'make', arch: 'x86_64' },
    ],
  },
  {
    name: 'smgl-core',
    repo: 'https://forgejo.local/smgl-core.git',
    targets: [
      { name: 'x86_64', command: 'cast smgl-core', system: 'sourcemage', arch: 'x86_64' },
      { name: 'armv7', command: 'cast smgl-core', system: 'sourcemage', arch: 'arm' },
    ],
  },
  {
    name: 'gentoo-stage3',
    repo: 'https://forgejo.local/gentoo-stage3.git',
    targets: [{ name: 'mipsel', command: 'emerge -e world', system: 'gentoo', arch: 'mipsel' }],
  },
  {
    name: 'openwrt-image',
    repo: 'https://forgejo.local/openwrt-image.git',
    targets: [{ name: 'arm64', command: 'make world', system: 'openwrt', arch: 'arm64' }],
  },
  {
    name: 'buildroot-rootfs',
    repo: 'https://forgejo.local/buildroot-rootfs.git',
    targets: [{ name: 'arm64', command: 'make', system: 'buildroot', arch: 'arm64' }],
  },
]

/** Per-target DAG step list — port of target_dag.py generate_steps() with
 *  the real pipeline shape: fetch → configure → compile → package. */
export function stepsFor(project: string, targetName: string): { name: string; command: string; deps: string[] }[] {
  const prefix = `${project}:${targetName}`
  return [
    { name: `${prefix}:fetch`, command: `git clone --depth 1`, deps: [] },
    { name: `${prefix}:toolchain`, command: `btc --verify golden-image`, deps: [`${prefix}:fetch`] },
    { name: `${prefix}:configure`, command: `./configure --prefix=/usr`, deps: [`${prefix}:toolchain`] },
    { name: `${prefix}:compile`, command: `make -j$(nproc)`, deps: [`${prefix}:configure`] },
    { name: `${prefix}:test`, command: `make check`, deps: [`${prefix}:compile`] },
    { name: `${prefix}:package`, command: `make package`, deps: [`${prefix}:compile`, `${prefix}:test`] },
    { name: `${prefix}:stamp`, command: `btc --stamp outputs`, deps: [`${prefix}:package`] },
  ]
}
