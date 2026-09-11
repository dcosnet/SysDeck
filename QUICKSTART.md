# SysDeck — Quick Start

Author: **Jeremy Anderson** · <info@dcos.net> · <https://dcos.net>
Version: **0.2.0** (Master Edition)

Five-minute path from tarball to 26 sidebar entries in your Cockpit — plus the Web Edition with Fester pre-integrated (section 9).

---

## 1. Prerequisites

| Component | Why | Install |
|-----------|-----|---------|
| `cockpit-bridge` ≥ 239 | The plugin runtime | `pacman -S cockpit` / `apt install cockpit` / `dnf install cockpit` |
| `python3` ≥ 3.9 | Bridge helpers | Universal on modern Linux |
| `polkit` | Privilege escalation (the cockpit way) | `pacman -S polkit` / `apt install policykit-1` / `dnf install polkit` |
| `appstream` (optional) | Cockpit Applications menu | `pacman -S appstream` / `apt install appstream` |

Cockpit itself ships its own `cockpit-bridge` package — that is the only hard dependency. SysDeck degrades gracefully when optional backends (podman, nftables, mkosi, bpftool, apparmor, …) are absent — each panel renders an install hint instead of crashing.

## 2. Install

```bash
# Get the tarball
ls sysdeck-0.0.35.tar.bz2  # download from your release source

# Extract and install
tar xjf sysdeck-0.0.35.tar.bz2
cd sysdeck-0.0.35
sudo make install

# Restart cockpit so it re-scans the plugin directory
sudo systemctl restart cockpit.socket
```

`make install` does:

- Copies each `plugins/sysdeck-*/{manifest.json,index.html,*.js}` to `/usr/share/cockpit/sysdeck-*/`
- Copies `shared/{manifest.json,bridge.js,sysdeck.css}` to `/usr/share/cockpit/sysdeck-common/`
- Copies each `bridge/*.py` (executable, 0755) to `/usr/lib/sysdeck/bridge/`
- Copies `firewall/templates/*.sh` (executable, 0755) to `/usr/share/sysdeck/firewall/templates/`
- Installs the AppStream metainfo at `/usr/share/metainfo/sysdeck.metainfo.xml`
- Installs the polkit policy at `/usr/share/polkit-1/actions/org.sysdeck.policy`
- Reloads polkit and refreshes the AppStream cache

## 3. Verify the install

Open `https://<host>:9090` in your browser and authenticate as a wheel/sudo user. The Cockpit sidebar should now list **23** entries under the `SysDeck <Name>` prefix:

| # | Module | # | Module |
|---|--------|---|--------|
| 1 | SysDeck Containers      | 13 | SysDeck Themes |
| 2 | SysDeck Firewall        | 14 | SysDeck Hardware Auth |
| 3 | SysDeck Integrity       | 15 | SysDeck Glances |
| 4 | SysDeck Network Security | 16 | SysDeck Sensors |
| 5 | SysDeck Service Mesh    | 17 | SysDeck Benchmark |
| 6 | SysDeck Vault           | 18 | SysDeck Packages |
| 7 | SysDeck Fleet           | 19 | SysDeck Policy |
| 8 | SysDeck Kata            | 20 | SysDeck Databases |
| 9 | SysDeck Fester          | 21 | SysDeck Jellyfin |
| 10 | SysDeck Firmware        | 22 | SysDeck Photos |
| 11 | SysDeck Image Builder   | 23 | SysDeck Remote FS |
| 12 | SysDeck Mining          |    | |

If any are missing, run the diagnostic:

```bash
sudo /usr/share/sysdeck/sysdeck-diagnose.sh
```

It prints exactly what cockpit sees on your system — installed manifests, bridge helpers present, polkit actions loaded, and the cockpit-bridge version.

## 4. First-use walkthrough

### 4a. Firewall (the cockpit way)

Open **SysDeck Firewall**. The panel renders:

1. **Capability matrix** — confirms nftables is installed.
2. **Template selector** — pick `vps-webserver` (service-aware firewall that auto-detects SSH/Caddy/Varnish/Forgejo) or `no-services` (locked-down host with no public services except SSH).
3. **Detect Services** — runs the template's `detect` action and shows the OS, interface, IPv4/IPv6, and which services the template found.
4. **Apply Template** — cockpit prompts for the superuser password via polkit. The bridge runs the template's `start` action under the `org.sysdeck.firewall.modify` action.
5. **Banned IPs** — live `ssh_abuse` / `port_scanners` / `connlimit_abuse` ban sets, with per-IP **Unban** buttons and a **Clear All** button.
6. **Active Ruleset** — the live nftables rules table, refreshed after each operation.

To drop in your own template, copy a `*.sh` file into `/usr/share/sysdeck/firewall/templates/` — the panel's `templates` subcommand discovers it automatically. The script must implement `start / stop / restart / detect / status` subcommands (see the shipped templates for reference).

### 4b. Packages (the cockpit way)

Open **SysDeck Packages**. Click **⬆ Update All**. Cockpit prompts for the superuser password via polkit. The bridge runs `pacman -Syu` / `apt upgrade -y` / `dnf upgrade -y` directly via subprocess — no `sudo` shell-out from JS. Live stdout/stderr stream into the in-panel `<pre>` log. The **👁 Preview Command** button shows the exact command that will be run before you confirm.

### 4c. Policy & Permissions

Open **SysDeck Policy**. The panel renders:

1. **LSM Stack** — a badge row in the header showing which LSMs the kernel has stacked (`/sys/kernel/security/lsm`), and a table of all 9 supported LSMs with their securityfs paths and active/inactive status.
2. **Capability Matrix** — confirms availability of ACLs, cgroups v2, VLANs, eBPF, namespaces, file caps, and each LSM. Absent concerns show a red "no" badge plus the install command.
3. **ACL Manager** — pick a path, type an entry like `group:www-data:rwx`, click `setfacl -m` (or `setfacl -x` to remove, `set default ACL` for directory inheritance).
4. **cgroups v2** — the unified hierarchy tree under `/sys/fs/cgroup/` with per-cgroup process counts and controllers. Use **Show** to inspect one cgroup's processes and control files; **mkdir** to create a new one; **move** to migrate a PID; **write** to set `memory.max`, `cpu.weight`, etc.
5. **VLANs** — list and create/delete 802.1Q VLANs via `ip link add ... type vlan id <vid>`.
6. **eBPF programs** — list loaded BPF programs via `bpftool prog show -j`, list maps, pin a program to `/sys/fs/bpf/...`.
7. **Namespaces** — `lsns -J` output as a table.
8. **File Capabilities** — `getcap -r /` enumeration with `setcap` / `getcap` / `setcap -r` controls.
9. **AppArmor** (optional) — if the kernel compiled AppArmor in, shows the enforcement mode and lets you switch profiles between `enforce` and `complain` modes. If absent, renders an install hint.
10. **Smack / TOMOYO / Yama / LoadPin / Lockdown / BPF-LSM / Landlock** — each has its own card with the live state and any management controls the LSM supports. Each card follows the same shape: if the LSM is not active, the card shows the kernel cmdline that enables it; if active, it shows the live state.

### 4d. Databases

Open **SysDeck Databases**. The panel auto-detects 32+ engines across SQL (PostgreSQL/MySQL/MariaDB/SQLite/CockroachDB/TiDB), NoSQL (MongoDB/CouchDB/RethinkDB/DynamoDB-local), Vector (Milvus/Qdrant/Weaviate/Chroma/pgvector), TimeSeries (InfluxDB/TimescaleDB/QuestDB/ClickHouse), Graph (Neo4j/ArangoDB/OrientDB), Embedded (Redis/KeyDB/ValKey/RocksDB/LMDB/BadgerDB), Cloud (Firestore-emulator/Supabase-local), and AI (LanceDB/DuckDB/Tile38). Each row has **▶ Start / ■ Stop / ↻ Restart / 🔍 Status** buttons. The **Run SQL Query** card lets you execute arbitrary SQL against SQL-family engines via the engine's CLI client (`psql -tAc`, `mysql -e`, etc.).

## 5. Build from source

```bash
cd sysdeck-0.0.35
make check         # 7 build-time guards: manifests, metainfo, tabs, no-broken-import, no-broken-module, bridge-subcommands cross-check, version sync
make dist          # builds sysdeck-0.0.35.tar.bz2
make distcheck     # extracts + runs make check inside the tarball tree
```

`make check` is a hard pre-flight: it cross-checks every `bridgeCmd("<module>", ["<sub>", ...])` call in `shared/bridge.js` against the `COMMANDS` dict declared in each `bridge/<module>.py`. If the JS calls a subcommand the Python helper doesn't implement, `make check` fails with a clear message naming the file, line, and missing subcommand.

## 6. Uninstall

```bash
sudo make uninstall
sudo systemctl restart cockpit.socket
```

`make uninstall` removes every trace of every prior version (the v0.0.9-v0.0.19 single-plugin `/usr/share/cockpit/sysdeck/` directory, the v0.0.20+ multi-plugin `/usr/share/cockpit/sysdeck-*/` directories, the Python bridge helpers, the diagnostic scripts, the firewall templates, the AppStream metainfo, the polkit policy, and any pacman-installed `sysdeck` package).

## 7. Where to go next

- [README.md](./README.md) — full module catalog, architecture, coding standards.
- [BLOG.md](./BLOG.md) — release narrative for v0.0.33 and prior versions.
- [docs/INSTALL.md](./docs/INSTALL.md) — RPM, DEB, pip, and manual install paths.
- [QA.md](./QA.md) — QA notes per release.
- [worklog.md](./worklog.md) — per-task development log.

## 8. Reporting issues

Open the in-panel error view: every SysDeck plugin's `index.html` installs `window.addEventListener('error')` and `'unhandledrejection'` handlers that replace the "Loading…" placeholder with the actual error message on the page — no devtools required. The same page tells you whether `cockpit.js` itself loaded, whether `bridge.js` imported cleanly, and whether the panel's `mount()` threw.

## 9. The Web Edition (master tarball, v0.2.0)

The master tarball also ships the **SysDeck Web Edition** at `web/` — a standalone browser console (no cockpit required) with 28 bridge modules, real `/proc` / `/sys` collectors, and **Fester pre-integrated** (vendored at `web/mini-services/fester`, independent version 0.2.1):

```bash
make web-dev        # fester service in the background (:3010) + web console (:3000)
```

Manual equivalent:

```bash
make fester-start                              # terminal 1: fester on :3010
cd web && bun install && bun run db:push       # terminal 2: web edition setup
bun run dev                                    #            web console on :3000
```

Open `http://localhost:3000`. The master tarball can be rebuilt any time with `make master`.

Author: **Jeremy Anderson** · <info@dcos.net> · <https://dcos.net>
