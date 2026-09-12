// SysDeck module registry — mirrors the cockpit edition's 26 plugin
// manifests (menu order 20–45) plus the Overview landing view and the
// Hardware Alerts module (bridge-only in the cockpit edition, full panel
// here).
import type { ModuleMeta } from './types'

export const MODULES: ModuleMeta[] = [
  // ── system ──────────────────────────────────────────────
  { id: 'overview', name: 'Overview', group: 'system', order: 15, description: 'Host vitals — CPU, memory, disks, network, load and process summary, plus suite health.', status: 'live' },
  { id: 'runbook', name: 'Run without Cockpit', group: 'system', order: 16, description: 'The standalone deployment runbook — run the whole console on the Next.js backend alone: dev, production build, systemd, proxy, troubleshooting.', status: 'live' },
  { id: 'glances', name: 'Glances', group: 'system', order: 34, description: 'Live cross-domain system monitor in the Glances tradition — this console ships its own stunning webui.', status: 'live' },
  { id: 'sensors', name: 'Sensors', group: 'system', order: 35, description: 'Hardware sensor readings (temperature, fans, voltages) from /sys/class/hwmon.', status: 'live' },
  { id: 'fleet', name: 'Fleet', group: 'system', order: 26, description: 'Fleet compute — node registry and live host metrics.', status: 'hybrid' },
  { id: 'services', name: 'Service / Ports', group: 'system', order: 45, description: 'Enumerates every listening socket, cross-references the SERVICES_REGISTRY and edits service ports atomically.', status: 'live' },
  { id: 'packages', name: 'Packages', group: 'system', order: 37, description: 'Package inventory, updates and operations across ten managers: pacman (Arch) · emerge (Gentoo) · lunar · sorcery (SourceMage) · xbps (Void) · apk (Alpine) · zypper (openSUSE) · dnf/yum (RPM) · apt (Debian).', status: 'live' },
  { id: 'benchmark', name: 'Benchmark', group: 'system', order: 36, description: 'CPU, memory and disk micro-benchmarks with score history.', status: 'live' },
  { id: 'firmware', name: 'Firmware', group: 'system', order: 29, description: 'fwupd-style firmware inventory, DMI identity and TPM PCR boot chain.', status: 'hybrid' },
  { id: 'themes', name: 'Themes', group: 'system', order: 32, description: 'Theme engine — live-switch the whole suite between console themes.', status: 'live' },

  // ── security ────────────────────────────────────────────
  { id: 'firewall', name: 'Firewall', group: 'security', order: 21, description: 'Rulesets, zones and deployable firewall templates (public-webserver, vps-webserver, ai-llm, remote-admin, no-services, cilium) — live nft/iptables ruleset reads and privilege-gated real applies.', interactive: true, status: 'live' },
  { id: 'netsec', name: 'Network Security', group: 'security', order: 23, description: 'Connection states, listening surfaces, ban list (real nftables/iptables enforcement + fail2ban) and port sweeps.', interactive: true, status: 'live' },
  { id: 'integrity', name: 'Integrity', group: 'security', order: 22, description: 'Tripwire-style file integrity — baseline, drift detection and audit.', interactive: true, status: 'live' },
  { id: 'vault', name: 'Vault', group: 'security', order: 25, description: 'Encryption vault — LUKS volumes from lsblk plus keyfile/TPM-sealed secret entries.', interactive: true, status: 'hybrid' },
  { id: 'auth', name: 'Hardware Auth', group: 'security', order: 33, description: 'PKCS#11 smartcard readers, certificates and hardware tokens.', status: 'live' },
  { id: 'hwalert', name: 'Hardware Alerts', group: 'security', order: 46, description: 'Foreign-device detection — USB storage, Thunderbolt DMA, rogue bluetooth, new PCI, firmware tamper.', interactive: true, status: 'hybrid' },
  { id: 'policy', name: 'Policy', group: 'security', order: 38, description: 'Polkit-style policy and permission rules with an audit trail.', interactive: true, status: 'live' },

  // ── compute ─────────────────────────────────────────────
  { id: 'containers', name: 'Containers & VMs', group: 'compute', order: 20, description: 'Incus / LXC / Podman / libvirt / Firecracker inventory with lifecycle actions.', interactive: true, status: 'live' },
  { id: 'mesh', name: 'Service Mesh', group: 'compute', order: 24, description: 'Kubernetes services, deployments and pods across namespaces.', status: 'live' },
  { id: 'kata', name: 'Kata', group: 'compute', order: 27, description: 'Kata Containers confidential-compute sandboxes.', status: 'live' },
  { id: 'remotefs', name: 'Remote FS', group: 'compute', order: 42, description: 'Ceph / GlusterFS / MooseFS / BeeGFS / OrangeFS distributed filesystems.', status: 'live' },
  { id: 'db', name: 'Databases', group: 'compute', order: 39, description: 'MariaDB / Postgres / Redis / SQLite instance control.', interactive: true, status: 'hybrid' },

  // ── build ───────────────────────────────────────────────
  { id: 'fester', name: 'Fester', group: 'build', order: 28, description: 'Distributed DAG build orchestration — its own dedicated service with live event stream, replay, autopsy and debugger.', interactive: true, status: 'live' },
  { id: 'builder', name: 'Image Builder', group: 'build', order: 30, description: 'mkosi / vmdb2 / archiso / live-build profile management with package lists, build runs and artifacts.', interactive: true, status: 'live' },
  { id: 'mining', name: 'Mining', group: 'build', order: 31, description: 'Rig fleet, per-GPU hashrate and thermal watch — live XMRig API + nvidia-smi.', status: 'live' },

  // ── media ───────────────────────────────────────────────
  { id: 'jellyfin', name: 'Jellyfin', group: 'media', order: 40, description: 'Media server library and active sessions.', status: 'live' },
  { id: 'photos', name: 'Photos', group: 'media', order: 41, description: 'PhotoPrism / Piwigo / Lychee / Nextcloud-Memories / LibrePhotos libraries.', status: 'live' },

  // ── integrations ────────────────────────────────────────
  { id: 'monitoring', name: 'Monitoring', group: 'integrations', order: 43, description: 'Observability stack — Prometheus metrics and Grafana dashboards, with native metrics when absent.', status: 'hybrid' },
  { id: 'modules', name: '3rd-Party Modules', group: 'integrations', order: 44, description: 'In-suite installer for third-party Cockpit modules with inline license disclosure.', interactive: true, status: 'live' },
  { id: 'klanker', name: 'AI Gateway', group: 'integrations', order: 47, description: 'klanker-gate ("Frosty Deno") LLM gateway by TykoDev — local stack (ollama, llama.cpp, koboldcpp, LM Studio, SGLang, vLLM) and SaaS providers behind one OpenAI-compatible API, with live local-backend probes.', status: 'hybrid', interactive: true },
  { id: 'cockpit', name: 'Cockpit Modules', group: 'integrations', order: 48, description: 'Every cockpit module detected on this host — distro modules (machines, podman, networking, storage...) and addons alike, scanned from /usr/share/cockpit manifests and loaded into this console with live backend probes.', status: 'hybrid', interactive: true },
]

export const GROUP_LABELS: Record<string, string> = {
  system: 'System',
  security: 'Security & Hardening',
  compute: 'Compute & Storage',
  build: 'Build Orchestration',
  media: 'Media',
  integrations: 'Integrations',
}

export const MODULE_MAP: Record<string, ModuleMeta> = Object.fromEntries(
  MODULES.map((m) => [m.id, m]),
)

export function modulesByGroup(): { group: string; modules: ModuleMeta[] }[] {
  const groups = Object.keys(GROUP_LABELS)
  return groups
    .map((group) => ({
      group,
      modules: MODULES.filter((m) => m.group === group).sort((a, b) => a.order - b.order),
    }))
    .filter((g) => g.modules.length > 0)
}

export const SYSDECK_VERSION = '0.4.3'
