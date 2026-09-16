# Third-Party Attributions

SysDeck integrates with external tools and plugins. Each
integration invokes the external tool as a **separate process** —
`cockpit.spawn` in the Cockpit plugin edition, fixed-argv spawns from
the web console's bridge modules — and no external code is bundled
within the suite. The
suite (MIT) and the external tools remain independent programs.

This file satisfies the attribution requirements of the licenses listed
below and documents every external integration point — including the
one vendored project in the master tarball (klanker-gate, below).

---

## Vendored Project (master tarball only)

### klanker-gate — the "Frosty Deno" LLM gateway (the AI Gateway module)

**klanker-gate is not SysDeck's code.** All credit belongs to its
author, **TykoDev**. The master tarball vendors the upstream tree
unmodified, as a sibling of the suite, under its own Apache-2.0
license; the suite's modules talk to it as a separate process over
REST (same no-linking rule as every other entry in this file).

| Field | Value |
|-------|-------|
| **Project** | klanker-gate ("Frosty Deno" LLM Gateway) |
| **Author** | **TykoDev** |
| **Source** | https://github.com/TykoDev/klanker-gate |
| **License** | Apache-2.0 (full text kept at `klanker-gate/LICENSE`; notice kept at `klanker-gate/ATTRIBUTION.md`) |
| **Vendored at** | `klanker-gate/` in the master tarball, own version **0.9.0** (independent from SysDeck's version) |
| **SysDeck additions** | `klanker-gate/arch/` only (PKGBUILD, systemd unit, sysusers/tmpfiles, run wrapper, runbook) — zero upstream source changes |
| **Modules** | `sysdeck-klanker` (cockpit edition: `bridge/klanker.py` + `plugins/sysdeck-klanker/`) and the web edition `klanker` bridge + AI Gateway panel — both are thin REST *clients* containing no upstream code |
| **Integration** | REST against `KLANKER_URL` (default `http://127.0.0.1:8080`), `Authorization: Bearer <KLANKER_ADMIN_TOKEN>` — a separate process invoked over HTTP, never linked or embedded |
| **License compat** | MIT suite + Apache-2.0 vendored tree redistributed in source form with LICENSE and notices retained — compliant; the two programs remain independent works |

---

## Bundled Dependencies (shipped with the suite itself)

None. The suite is self-contained MIT-licensed code with no vendored
third-party libraries. (The master tarball separately vendors the
klanker-gate project — see the section above; it is a sibling tree,
not part of the suite.)

---

## External Tool Integrations (invoked via cockpit.spawn)

These tools are called as separate processes. They must be installed
on the target system for their corresponding module to function. Each
module fails closed with an install hint when its tool is absent.

### Prometheus — Monitoring & Log Pipeline

| Field | Value |
|-------|-------|
| **Module** | `cockpit-prometheus` |
| **Tool** | Prometheus server / pushgateway |
| **License** | Apache-2.0 |
| **Author** | Prometheus Authors |
| **Source** | https://github.com/prometheus/prometheus |
| **Install** | `pacman -S prometheus` |
| **Integration** | `cockpit.spawn(["python3", "-m", "sysdeck.bridge.prometheus", "push-log"])` |
| **License compat** | MIT calling Apache-2.0 via subprocess — independent programs |

### Grafana — Dashboards & Visualization

| Field | Value |
|-------|-------|
| **Module** | `cockpit-grafana` |
| **Tool** | Grafana server |
| **License** | AGPL-3.0 |
| **Author** | Grafana Labs |
| **Source** | https://github.com/grafana/grafana |
| **Install** | `pacman -S grafana` |
| **Integration** | `cockpit.spawn(["python3", "-m", "sysdeck.bridge.grafana", "dashboards"])` |
| **License compat** | MIT calling AGPL-3.0 via subprocess — independent programs |

### DB Engines — Database Control

| Field | Value |
|-------|-------|
| **Module** | `cockpit-db` |
| **Tool** | `psql`, `mysql`, `sqlite3`, and others |
| **License** | PostgreSQL License (psql), GPL-2.0 (mysql), Public Domain (sqlite3) |
| **Author** | PostgreSQL Global Dev Group, Oracle, SQLite Contributors |
| **Source** | https://www.postgresql.org/, https://dev.mysql.com/, https://sqlite.org/ |
| **Install** | `pacman -S postgresql mysql sqlite` |
| **Integration** | `cockpit.spawn(["python3", "-m", "sysdeck.bridge.db", "summary"])` |
| **License compat** | MIT calling permissively-licensed CLIs via subprocess — independent programs |

### hwalert — Hardware Alert Aggregation

| Field | Value |
|-------|-------|
| **Module** | Bridge helper only (panel integration pending) |
| **Tool** | `sensors`, `smartctl`, `mcelog` |
| **License** | MIT / LGPL-2.1+ (lm_sensors), GPL-2.0 (smartmontools), GPL-2.0 (mcelog) |
| **Author** | Various |
| **Source** | https://github.com/lm-sensors/lm-sensors, https://github.com/smartmontools/smartmontools |
| **Integration** | `cockpit.spawn(["python3", "-m", "sysdeck.bridge.hwalert", "summary"])` |
| **License compat** | MIT calling GPL/LGPL/MIT via subprocess — independent programs |

### Glances — System Monitor

| Field | Value |
|-------|-------|
| **Module** | `cockpit-glances` |
| **Tool** | `glances` CLI |
| **License** | GPL-3.0 |
| **Author** | Nicolargo |
| **Source** | https://github.com/nicolargo/glances |
| **Install** | `pip install glances` |
| **Integration** | `cockpit.spawn(["python3", "-m", "sysdeck.bridge.glances", "snapshot"])` |
| **License compat** | MIT calling GPL-3.0 via subprocess — independent programs |

### lm_sensors — Hardware Sensors

| Field | Value |
|-------|-------|
| **Module** | `cockpit-sensors` |
| **Tool** | `sensors` CLI (from lm_sensors) |
| **License** | MIT / LGPL-2.1+ (varies by component) |
| **Author** | lm_sensors project |
| **Source** | https://github.com/lm-sensors/lm-sensors |
| **Install** | `pacman -S lm_sensors` |
| **Integration** | `cockpit.spawn(["python3", "-m", "sysdeck.bridge.sensors", "summary"])` |
| **License compat** | MIT calling MIT/LGPL — compatible |

### cockpit-sensors — Standalone Cockpit Plugin (reference)

| Field | Value |
|-------|-------|
| **Module** | Referenced by `cockpit-sensors` (not bundled) |
| **License** | MIT |
| **Author** | ocristopfer |
| **Source** | https://github.com/ocristopfer/cockpit-sensors |
| **Note** | The suite provides its own sensor rendering panel. The standalone cockpit-sensors plugin may be installed separately via the in-suite **3rd-Party Modules** panel (v0.0.46+, see `plugins/sysdeck-modules/` and `bridge/modules3p.py`). The legacy `cockpit-module-pull.sh` script remains as a CLI fallback. |

### sysbench — System Benchmark

| Field | Value |
|-------|-------|
| **Module** | `cockpit-benchmark` |
| **Tool** | `sysbench` CLI |
| **License** | GPL-2.0 |
| **Author** | Alexey Kopytov |
| **Source** | https://github.com/akopytov/sysbench |
| **Install** | `pacman -S sysbench` |
| **Integration** | `cockpit.spawn(["python3", "-m", "sysdeck.bridge.benchmark", "run-cpu"])` |
| **License compat** | MIT calling GPL-2.0 via subprocess — independent programs |

### cockpit-benchmark — Standalone Cockpit Plugin (reference)

| Field | Value |
|-------|-------|
| **Module** | Referenced by `cockpit-benchmark` (not bundled) |
| **License** | MIT |
| **Author** | ealier |
| **Source** | https://github.com/ealier/cockpit-benchmark |
| **Note** | The suite provides its own benchmark panel. The standalone cockpit-benchmark plugin may be installed separately. |

### pacman / dnf / apt — Package Manager

| Field | Value |
|-------|-------|
| **Module** | `cockpit-packages` |
| **Tool** | `pacman` (Arch), `dnf` (Fedora/RHEL), `apt` (Debian/Ubuntu) |
| **License** | GPL-2.0+ (pacman), GPL-2.0+ (dnf), GPL-2.0+ (apt) |
| **Author** | Pacman Development Team, RPM project, Debian project |
| **Source** | https://archlinux.org/pacman/, https://github.com/rpm-software-management/dnf, https://salsa.debian.org/apt-team/apt |
| **Install** | Pre-installed on respective distros |
| **Integration** | `cockpit.spawn(["python3", "-m", "sysdeck.bridge.packages", "summary"])` |
| **License compat** | MIT calling GPL-2.0+ via subprocess — independent programs |

### cockpit-identities — Standalone Cockpit Plugin (reference)

| Field | Value |
|-------|-------|
| **Module** | Referenced by `cockpit-auth` identities extension (not bundled) |
| **License** | LGPL-2.1 |
| **Author** | cockpit-project |
| **Source** | https://github.com/cockpit-project/cockpit-identities |
| **Note** | The suite's auth identities enumeration invokes the same underlying tools (ssh-add, pkcs11-tool, klist). The standalone cockpit-identities plugin may be installed separately via the in-suite **3rd-Party Modules** panel (v0.0.46+, see `plugins/sysdeck-modules/` and `bridge/modules3p.py`). |

### OpenSSH — SSH Key Enumeration

| Field | Value |
|-------|-------|
| **Module** | `cockpit-auth` (identities) |
| **Tool** | `ssh-add`, `ssh-keygen` |
| **License** | BSD-2-Clause |
| **Author** | OpenBSD project |
| **Source** | https://www.openssh.com/ |
| **Integration** | `cockpit.spawn(["python3", "-m", "sysdeck.bridge.auth", "ssh-keys"])` |
| **License compat** | MIT calling BSD-2-Clause — compatible |

### MIT Kerberos — Kerberos Principal Enumeration

| Field | Value |
|-------|-------|
| **Module** | `cockpit-auth` (identities) |
| **Tool** | `klist` |
| **License** | MIT (Kerberos) |
| **Author** | MIT Kerberos Consortium |
| **Source** | https://web.mit.edu/kerberos/ |
| **Integration** | `cockpit.spawn(["python3", "-m", "sysdeck.bridge.auth", "kerberos"])` |
| **License compat** | MIT calling MIT — compatible |

---

## External Tools Used by Pre-existing Modules (v0.0.10 and earlier)

Listed for completeness. All invoked as separate processes.

| Tool | Module | License | Author | Source |
|------|--------|---------|--------|--------|
| `podman` | cockpit-containers | Apache-2.0 | containers/podman | https://github.com/containers/podman |
| `nft` | cockpit-firewall | GPL-2.0 | netfilter project | https://git.netfilter.org/nftables |
| `lynis` | cockpit-integrity | GPL-3.0 | CISOfy | https://github.com/CISOfy/lynis |
| `ss` | cockpit-netsec | GPL-2.0 | iproute2 project | https://git.kernel.org/pub/scm/utils/iproute2/iproute2 |
| `kubectl` | cockpit-mesh | Apache-2.0 | Kubernetes | https://github.com/kubernetes/kubernetes |
| `lsblk` | cockpit-vault | GPL-2.0 | util-linux | https://git.kernel.org/pub/scm/utils/util-linux/util-linux |
| `fwupdmgr` | cockpit-firmware | LGPL-2.1+ | fwupd project | https://github.com/fwupd/fwupd |
| `tpm2_pcrread` | cockpit-firmware | BSD-3-Clause | tpm2-software | https://github.com/tpm2-software/tpm2-tools |
| `kata-runtime` | cockpit-kata | Apache-2.0 | kata-containers | https://github.com/kata-containers/kata-containers |
| `mkosi` | cockpit-builder | LGPL-2.1+ | systemd project | https://github.com/systemd/mkosi |
| `mkarchiso` | cockpit-builder | GPL-3.0 | Arch Linux | https://gitlab.archlinux.org/archlinux/archiso |
| `vmdb2` | cockpit-builder | GPL-3.0+ | LVM team (Debian) | https://gitlab.com/lvm-team/vmdb2 |
| `lb` (live-build) | cockpit-builder | GPL-3.0+ | Debian Live team | https://salsa.debian.org/live-team/live-build |
| `pkcs11-tool` | cockpit-auth | MIT (OpenSC) | OpenSC project | https://github.com/OpenSC/OpenSC |

### v0.0.35 — Jellyfin, Photos, Remote FS backends

| Tool | Module | License | Author | Source |
|------|--------|---------|--------|--------|
| `jellyfin` | cockpit-jellyfin | GPL-2.0 | Jellyfin contributors | https://github.com/jellyfin/jellyfin |
| `photoprism` | cockpit-photos | MIT | PhotoPrism contributors | https://github.com/photoprism/photoprism |
| `piwigo` | cockpit-photos | GPL-2.0 | Piwigo contributors | https://github.com/Piwigo/Piwigo |
| `lychee` | cockpit-photos | MIT | LycheeOrg | https://github.com/LycheeOrg/Lychee |
| `occ` (Nextcloud Memories) | cockpit-photos | AGPL-3.0 | pulsejet (memories) + Nextcloud | https://github.com/pulsejet/memories |
| `librephotos` | cockpit-photos | MIT | LibrePhotos contributors | https://github.com/LibrePhotos/librephotos |
| `ceph` | cockpit-remotefs | LGPL-2.1 | Ceph contributors | https://github.com/ceph/ceph |
| `gluster` | cockpit-remotefs | GPL-2.0 | GlusterFS contributors | https://github.com/gluster/glusterfs |
| `moosefs-cli` | cockpit-remotefs | GPL-2.0 | MooseFS contributors | https://github.com/moosefs/moosefs |
| `beegfs-ctl` | cockpit-remotefs | BeeGFS EULA (free) | BeeGFS / NetApp | https://www.beegfs.io/ |
| `pvfs2-server` | cockpit-remotefs | BSD-3 (OrangeFS) | OrangeFS / Omnibond | http://www.orangefs.org/ |

### Intentionally excluded (per v0.0.35 directive)

| Tool | Reason |
|------|--------|
| `nfsd` (NFS) | Kernel-builtin; no cluster; no remote-FS-as-data-store semantics. Use cockpit-nfs. |
| `amanda` (AMANDA) | Backup system (Advanced Maryland Automatic Network Disk Archiver), not a remote/distributed filesystem. Use a dedicated backup solution. |

---

## License Compatibility Summary

The suite is MIT licensed. All external tools are invoked as **separate
programs** via `cockpit.spawn` (subprocess). Under copyright law,
communicating with a separate program via pipes or sockets does not
create a combined work. The licenses of the external tools impose
obligations on the tools themselves, not on the suite.

For GPL-family tools (Glances, nft, lynis, sysbench, ss, lsblk, Grafana):
- The suite does not link against, embed, or distribute their code.
- The suite invokes them as subprocesses, which is permitted without
  imposing GPL on the calling program.
- Users who distribute the suite alongside these tools should verify
  their own compliance with each tool's license terms.

For MIT/LGPL/BSD/Apache tools: fully compatible with the suite's MIT license.

---

### v0.0.46 — In-Suite 3rd-Party Module Installer

Prior to v0.0.46, the only way to install third-party Cockpit modules
(45Drives Navigator, cockpit-pacman, cockpit-identities, etc.) was the
side-channel `cockpit-module-pull.sh` shell script. That script bundled
a single blanket license prompt at the top and wrote a post-install
text audit log — but it did not surface per-module license / credit /
install-plan disclosures BEFORE the pull, and it had no per-module
opt-out.

v0.0.46 replaces that flow with a first-class **3rd-Party Modules**
panel (`plugins/sysdeck-modules/`) backed by a Python bridge helper
(`bridge/modules3p.py`). Each catalog entry declares its license,
author, source URL, and install hook. The panel renders all four
fields INLINE in every row, right next to a 1-click Install button —
clicking Install is the operator's acceptance of the inline-displayed
license. No modal, no separate confirmation step.

The bridge itself refuses silent installs (no `--accept-license=1`
⇒ `license-not-accepted`) as a guard against malicious callers. The
JS always passes that flag because the license is rendered inline next
to the button — the click IS the acceptance gesture.

Every install / uninstall is appended to
`/etc/cockpit/MODULE_LICENSES.log` as a JSON record. Legacy plain-text
lines from `cockpit-module-pull.sh` are preserved as `{raw: ...}`
records, so a single audit view shows both old and new entries.

### Catalog entries (v0.0.46)

| Module | License | Author | Source | Kind |
|--------|---------|--------|--------|------|
| cockpit-machines | LGPL-2.1 | Cockpit Project | https://github.com/cockpit-project/cockpit-machines | pacman |
| cockpit-podman | LGPL-2.1 | Cockpit Project | https://github.com/cockpit-project/cockpit-podman | pacman |
| cockpit-storaged | LGPL-2.1 | Cockpit Project | https://github.com/cockpit-project/cockpit-storaged | pacman |
| cockpit-identities | LGPL-2.1 | Cockpit Project | https://github.com/cockpit-project/cockpit-identities | git |
| cockpit-navigator | GPL-3.0 | 45Drives | https://github.com/45Drives/cockpit-navigator | deb-tar |
| cockpit-file-sharing | GPL-3.0 | 45Drives | https://github.com/45Drives/cockpit-file-sharing | deb-tar |
| cockpit-zfs-manager | GPL-3.0 | 45Drives | https://github.com/45Drives/cockpit-zfs-manager | git |
| cockpit-pacman | GPL-3.0 | pfeifferj | https://github.com/pfeifferj/cockpit-pacman | git |
| cockpit-sensors | MIT | ocristopfer | https://github.com/ocristopfer/cockpit-sensors | tarball |
| cockpit-benchmark | MIT | ealier | https://github.com/ealier/cockpit-benchmark | git |

Adding a new module to the catalog is a single dict append to
`CATALOG` in `bridge/modules3p.py`. No per-module code branches.

### License compatibility

All entries are invoked as **separate processes** via
`cockpit.spawn`. The suite (MIT) does not link against, embed, or
distribute any of these modules. Under copyright law, communicating
with a separate program via pipes or sockets does not create a
combined work. The licenses of the upstream modules impose
obligations on the modules themselves, not on SysDeck.

For GPL-family modules (cockpit-navigator, cockpit-file-sharing,
cockpit-zfs-manager, cockpit-pacman): operators who distribute SysDeck
alongside these modules should verify their own compliance with each
module's license terms.

For MIT/LGPL/BSD/Apache modules: fully compatible with the suite's MIT
license.
