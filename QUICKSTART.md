# SysDeck — Quick Start

Author: **Jeremy Anderson** · <info@dcos.net> · <https://dcos.net>
Version: **0.4.3** (Master Edition)

Two five-minute paths: run the console standalone (no Cockpit required — section 9), or install the full plugin suite into an existing Cockpit (sections 1–8). Either way every module also loads in the other front end.

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

Or use the **quiet uninstaller** — same coverage, silent on success, idempotent, and it restarts cockpit.socket itself (so the sidebar flushes in one step):

```bash
sudo ./sysdeck-uninstall.sh                 # quiet; also handles the
                                            # 0.3.0 branding skin (restores
                                            # the distro branding.css backup)
                                            # + dpkg/rpm copies + python
                                            # site-packages links
sudo ./sysdeck-uninstall.sh -n              # dry-run: list what would go
sudo ./sysdeck-uninstall.sh --purge-state   # also drop /var/lib/sysdeck
                                            # (builder artifacts — operator
                                            # data, off by default)
sudo ./sysdeck-uninstall.sh --no-restart    # skip the cockpit.socket restart
```

It prints nothing on success — including when nothing was installed — and leaves operator data alone (`/etc/sysdeck/`, `/var/lib/sysdeck/` unless `--purge-state`, `/etc/pam.d/sysdeck`, and any third-party cockpit modules). `make install` also drops the script at `/usr/share/sysdeck/sysdeck-uninstall.sh`, so it stays available on boxes that installed via package manager and no longer have the tarball.

## 7. Where to go next

- [README.md](./README.md) — full module catalog, architecture, coding standards.
- [BLOG.md](./BLOG.md) — release narrative for v0.0.33 and prior versions.
- [docs/INSTALL.md](./docs/INSTALL.md) — RPM, DEB, pip, and manual install paths.
- [QA.md](./QA.md) — QA notes per release.
- [worklog.md](./worklog.md) — per-task development log.

## 8. Reporting issues

Open the in-panel error view: every SysDeck plugin's `index.html` installs `window.addEventListener('error')` and `'unhandledrejection'` handlers that replace the "Loading…" placeholder with the actual error message on the page — no devtools required. The same page tells you whether `cockpit.js` itself loaded, whether `bridge.js` imported cleanly, and whether the panel's `mount()` threw.

## 9. The standalone web console (master tarball, no Cockpit required)

The master tarball ships the **SysDeck web console** at `web/` — a standalone server-management console that signs you in with your Unix account (PAM, the same mechanism Cockpit uses), reads real host state through 30 bridge modules (`/proc`, `/sys`, lsblk, systemctl, the real package manager...), detects and loads every installed Cockpit module into its own navigation, and carries **Fester pre-integrated** (vendored at `web/mini-services/fester`, independent version 0.2.1). Every module in this console can equally be loaded inside Cockpit itself — one module catalog, two front ends:

```bash
make web-dev        # fester service in the background (:3010) + web console (:3000)
```

Manual equivalent:

```bash
make fester-start                              # terminal 1: fester on :3010
cd web && bun install && bun run db:push       # terminal 2: console setup
bun run dev                                    #            web console on :3000
```

Open `http://localhost:3000`. The master tarball can be rebuilt any time with `make master`.

## 10. The AI Gateway (master tarball, v0.3.0)

The master tarball also vendors **klanker-gate** — the Frosty Deno LLM gateway (independent version 0.9.0, Apache-2.0, **by TykoDev: https://github.com/TykoDev/klanker-gate — not SysDeck code**, see `klanker-gate/ATTRIBUTION.md`) — at `klanker-gate/`, with the new **AI Gateway** module in both editions. On Arch Linux the whole gateway is one package away:

```bash
cd klanker-gate/arch
pacman -S --needed deno base-devel     # deno is in [extra]
makepkg -si                            # /usr/share/klanker-gate + systemd unit
sudoedit /etc/klanker-gate/env         # FROSTY_PG_URL + one provider key (+ token)
sudo systemctl enable --now klanker-gate
curl http://localhost:8080/healthz
```

Then point SysDeck at it (cockpit bridge env, or `web/.env` for the web edition, then restart):

```bash
KLANKER_URL=http://127.0.0.1:8080
KLANKER_ADMIN_TOKEN=<the FROSTY_ADMIN_TOKEN you set>
```

Both the cockpit AI Gateway panel and the web edition's AI Gateway panel flip from their offline/demo state to live data automatically. The full runbook — postgres provisioning, multi-worker serving (`FROSTY_WORKERS`, an Arch bonus via `SO_REUSEPORT`), the optional control-UI build — is `klanker-gate/arch/INSTALL-ARCH.md`.

### 10.1 Running an all-local stack (ollama · llama.cpp · koboldcpp)

The gateway is **not SaaS-only** — no API key is required anywhere in this
setup. Five provider types are local-first upstream: `ollama`, `lmstudio`,
`sgl` (SGLang) natively, plus the generic `openai-compatible` type that
llama.cpp (llama-server), KoboldCpp, vLLM and TGI all speak:

| backend | provider type | base URL | auth |
|---|---|---|---|
| Ollama | `ollama` | `http://127.0.0.1:11434/v1` | none |
| llama.cpp (llama-server) | `openai-compatible` | `http://127.0.0.1:8081/v1` | optional |
| KoboldCpp | `openai-compatible` | `http://127.0.0.1:5001/v1` | optional |
| LM Studio | `lmstudio` | `http://127.0.0.1:1234/v1` | none |
| SGLang | `sgl` | `http://127.0.0.1:30000/v1` | none |

Env wiring (in `/etc/klanker-gate/env` or the gateway's `.env`):

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODELS=qwen3:14b,llama3.1:8b,nomic-embed-text
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
OPENAI_COMPAT_BASE_URL=http://127.0.0.1:8081/v1   # ONE openai-wire server
```

Env registers one `openai-compatible` account — to run llama.cpp **and**
koboldcpp (and vLLM) side by side, register each via the admin API, then
auto-discover its catalog:

```bash
curl -s http://127.0.0.1:8080/api/providers -H 'Authorization: Bearer $FROSTY_ADMIN_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"id":"llama-server","type":"openai-compatible","baseUrl":"http://127.0.0.1:8081/v1","enabled":true}'
curl -s -X POST http://127.0.0.1:8080/api/providers/llama-server/refresh-models \
  -H 'Authorization: Bearer $FROSTY_ADMIN_TOKEN'
```

**Port note:** llama-server defaults to `:8080` — the same port the gateway
listens on. Run it on another port (`--port 8081`) or move the gateway.

Both editions ship a **Local stack wiring** card (in the AI Gateway panel)
that live-probes each backend's `/v1/models` from the host and shows these
recipes with copy buttons — `klanker localstack` at the bridge level.

### 10.2 Turning the AI Gateway off (module toggles)

Not using the gateway (or switched to a different assistant stack)?
Both editions let you remove it from the console without uninstalling
anything:

- **web edition** — every sidebar module carries a power toggle (hover
  a row → ⏻). Clicking it hides the module from the sidebar AND the
  ⌘K palette; a **Disabled (N)** section appears at the sidebar bottom
  with one-click re-enable (plus a restore-all ↻). State is persisted
  in SQLite (`shell.disabled` via the `shell` bridge module) and
  survives restarts; Overview is protected. If you disable the module
  you are viewing, the console jumps back to Overview.
- **cockpit edition** — plugins are discovered by directory: `sudo rm
  -rf /usr/share/cockpit/sysdeck-klanker` removes the sidebar entry
  (bridge helper stays at `/usr/lib/sysdeck/bridge/klanker.py` for
  scripts); restore with `sudo make install`.

### 10.3 The 0.3.0 security audit (both editions + the vendored gateway)

A full-codebase security review shipped with 0.3.0 — the cockpit bridge
helpers, the 27 plugin panels, the web edition, and the vendored
klanker-gate tree. What changed:

- **bridge helpers fail closed now.** `cgroup-set` validates both the
  cgroup path (must resolve under `/sys/fs/cgroup`) and the control-file
  name (real controller knobs only); `artifacts-clear` /
  `build-delete` / `build-log` / `artifacts` validate ids as single
  path components before touching state/artifacts/logs dirs;
  `profile-create` rejects names that aren't single components (was
  directory traversal + config injection into root-executed build
  configs); hwalert's `sudo sh -c` is gone (direct write, device path
  validated under the scanned sysfs bases); `db start/stop/restart`
  resolve engines through the registry; `db query` now actually
  enforces the read-only promise (SELECT/WITH/SHOW/… only);
  `themes set` rejects newlines (cockpit.conf section injection);
  `packages install/remove/update` reject option-shaped names.
- **every plugin escapes its data.** The 8 oldest panels (packages,
  benchmark, auth, sensors, vault, firmware, mesh, and the auth quick
  actions) now escape every interpolated string — package metadata,
  USB reader descriptors, fwupd device fields, sensor labels, spawn
  errors — before it lands in `innerHTML`. All 27 manifests dropped
  `unsafe-eval` from their CSP. Every external link carries
  `rel="noopener noreferrer"`.
- **the web edition binds loopback.** `bun run dev` → `127.0.0.1:3000`,
  the fester service → `127.0.0.1:3010`, the production start script
  pins `HOSTNAME=127.0.0.1`; the bridge endpoint gained a body-size
  cap, a per-IP rate limit and generic error responses (details go to
  the server log).
- **the vendored gateway got audited, not modified.** Findings live in
  `klanker-gate/arch/SECURITY-UPSTREAM.md` (10 findings, 3 critical:
  no-token admin mode, 0.0.0.0 default bind, open `/v1/*` until the
  first virtual key exists). Upstream source stays byte-identical per
  the attribution contract; the SysDeck `arch/` packaging layer
  mitigates: the systemd unit refuses to start without
  `FROSTY_ADMIN_TOKEN`, `INSTALL-ARCH.md` §9 carries the firewall +
  first-vkey runbook.
- **fixed along the way (functional):** the Packages panel's
  firewall-backend install path (`packages.py install --` choke), the
  auth panel's quick-action buttons (called a bridge.spawn that never
  existed), and the mesh panel's table (read a data shape the bridge
  never returned).

### 10.4 The web edition login (Unix accounts, cockpit-style)

SysDeck is a **LAN-side console** — loopback binding stays the outer
boundary. What 0.4.0 changes is the login itself: instead of the 0.3.1
shared password, you now sign in with a **Unix account — the username
and password are verified by the host's PAM stack**, exactly the
mechanism Cockpit uses at its own login screen. The host decides; the
console keeps no password data of its own.

- **PAM path:** `web/scripts/pam-auth.py` (stdlib-only ctypes client of
  `libpam`) runs the `pam_start` → `pam_authenticate` → `pam_acct_mgmt`
  sequence under the **`sysdeck`** service when `/etc/pam.d/sysdeck`
  exists, else the stock **`login`** stack. Credentials travel over
  stdin (never argv — `/proc` would leak them). Ship your own
  `/etc/pam.d/sysdeck` (e.g. `auth required pam_unix.so`, plus
  `pam_google_authenticator` for MFA if you want it) to tailor the
  stack — `SYSDECK_PAM_SERVICE` renames it.
- **Root, or pam+local:** pam_unix needs root to read `/etc/shadow`
  for *arbitrary* users (non-root processes only get the invoking uid
  via `unix_chkpwd` — a pam_unix guarantee). So the modes are
  `SYSDECK_AUTH_MODE=pam` (default; run the service as root, like
  cockpit-ws), `pam+local` (PAM first, then the `SdUser` scrypt table
  for installs that can't run privileged), or `local` (console
  accounts only). Manage the local table with
  `bun scripts/manage-users.mjs list|add|passwd|disable|enable|remove`
  from `web/`.
- **Session:** an HttpOnly, SameSite=Lax cookie (`sd_session`) holding
  an HMAC-SHA256-signed token **bound to the username**
  (`v2.<exp>.<userB64>.<hmac>`), **12h** expiry. The HMAC key is random
  per install and persists in the SQLite DB, so sessions survive
  restarts — including the 0.3.1 → 0.4.0 upgrade (old v1 tokens still
  verify as a legacy "operator" session until they age out).
- **Gate scope:** the page itself is server-rendered as the login
  screen until the cookie verifies, every `/api/*` route answers 401
  until signed in, and the **fester service verifies the identical
  v2 token** on its REST + WebSocket surface — no unauthenticated path
  into the console's data.
- **Lockout:** wrong attempts are rate limited per-IP **and**
  per-username (5 per 60s each — the same shape the sshd stack
  applies). Wrong-user and wrong-password return the same generic
  answer; nothing enumerates accounts.
- **Identity in the shell:** the header carries an account menu —
  avatar, `user@host`, unix-account provenance (PAM vs local), the
  wheel/sudo "Administrative access" badge, and a live session-expiry
  countdown with a draining life bar; the status bar shows
  `user@host` next to the vitals. Login/logout are audited with the
  unix username as the actor.
- **TLS:** LAN deployments typically run plain http; front the console
  with TLS and set `SYSDECK_SESSION_SECURE=1` to add the `Secure`
  cookie flag. Sign out lives in the account menu (clears the cookie).

The login/logout actions are audited (`module: web`, actions
`login` / `login-failed` / `logout`, actor = the unix username, with
source IP). This is deliberately *not* MFA-by-default or rate-proof
crypto — it is the host's own account system doing what it already
does at every other login surface on the box, recorded here so nobody
mistakes it for more or less than that.

### 10.5 Cockpit module detection in the web console (v0.4.1)

The console scans the host the same way the cockpit shell discovers
pages — every `/usr/share/cockpit/<pkg>/manifest.json` with a `menu`
entry is a module — and **loads each one into its own navigation**:

- a **Cockpit** sidebar group (with a LIVE/DEMO provenance badge) lists
  every detected module — distro modules (`cockpit-machines`,
  `cockpit-podman`, networking, storage, accounts, updates, SELinux,
  PCP metrics, kdump, tuned...) and third-party addons alike;
- each module opens a detail view with its manifest identity, shipped
  files, **live backend presence probes** (`virsh`/`podman`/`nmcli`/
  `pkcon`/... — real `which()` checks), and a jump to the native
  console panel covering the domain when one exists;
- `sysdeck-*` modules never duplicate (native panels already ship), and
  menu-less chrome (`base1`, `shell`) is skipped — exactly the cockpit
  shell's own rules;
- `SYSDECK_COCKPIT_SCAN` (colon-separated paths) adds extra scan roots
  for staged trees; with no cockpit tree on the host, a clearly-badged
  typical-distro set keeps the surface explorable;
- the **Cockpit Modules** hub panel (Integrations group) summarizes
  detection: counts, backend availability, native coverage, and the
  scan paths in play.

This is the piece that makes the console/host pair 100% compatible:
install a cockpit module on the box, and it shows up here — no cockpit
login required to browse it.

### 10.6 The zero-demo release (v0.4.2)

Every web-console module now ships production implementations only — no
demo, mock, stub, or seeded data anywhere in the codebase:

- **Sensors** parse the real `sensors -j` (lm-sensors) JSON — the exact
  source the cockpit edition reads — with raw sysfs collectors as the
  fallback. No sensors → an honest empty panel.
- **Netsec bans enforce for real** — an atomic nftables batch (`table
  inet sysdeck`, `blacklist` set, 30-day timeouts) or an iptables DROP
  rule, privilege-gated like every mutation; the live fail2ban ban list
  is merged when fail2ban runs, and fail2ban rows unban through the
  real `fail2ban-client set <jail> unbanip`.
- **The firewall panel reads the host's actual kernel ruleset** (new
  live-ruleset tab: `nft -j list ruleset` / `iptables-save`) and the
  template catalog covers all seven shipped topologies.
- The bridge `DataSource` type no longer admits a `'demo'` value — the
  compiler itself rejects any reintroduction. Absent backends always
  render honest empty inventories with install guidance.


### 10.7 The MoE QA pass (v0.4.3)

A multi-expert audit hardened every axis of the console:

- Privileged writes ride stdin and verify themselves (polkit rules
  byte-for-byte post-write; `nft -f -` / `iptables-restore` piped
  rulesets; PIN off argv; `mktemp` staging everywhere `/tmp` was
  predictable).
- Mutating bridge commands require an admin session (wheel/sudo/adm);
  reads stay open to every signed-in unix account. Set
  `SYSDECK_MUTATIONS=any` for single-operator consoles.
- Dry-runs preview exactly what apply executes (the shipped template
  script verbatim); unbans/applies report the firewall's real exit
  code; rule comments are injection-guarded.
- `X-Forwarded-For` defines rate-limit identity only behind an opted-in
  proxy (`SYSDECK_TRUST_PROXY=1`).
- The polling layer shares TTL + single-flight probes across panels —
  one subprocess sweep per window, not a spawn storm per tick — and
  the Python bridges match the web side's chains (sensors `sensors -j`
  → sysfs; dnf `check-update` rc 100 = updates exist; timeouts on
  every spawn).



## 11. Run without Cockpit (the complete standalone runbook, v0.3.0)

The web edition needs **nothing from sections 1–8** — no cockpit, no Python
bridge, no systemd, no root. One Bun runtime serves the whole console:

```bash
tar xjf sysdeck-0.4.3-master.tar.bz2
cd sysdeck-0.4.3-master
make web-dev          # bun install + db:push + fester + next dev :3000
```

Production path (standalone build, systemd on Arch, reverse proxy with the
`?XTransformPort=` websocket gateway, environment reference, troubleshooting):

```bash
cd web
bun run build                              # self-contained .next/standalone/
PORT=3000 HOSTNAME=0.0.0.0 bun run start   # or: node .next/standalone/server.js
```

The complete runbook — with the two systemd units (web + fester), the
`.env` reference table, the Caddy/nginx websocket-gateway configs and a
troubleshooting matrix — lives in two places, kept in sync:

- **`web/README.md`** in this tarball (plain markdown)
- the **"Run without Cockpit" panel** in the web console (system group,
  right under Overview) — every command block has a copy button

## 12. The web-edition skin for Cockpit (v0.3.0)

Since 0.3.0 the Cockpit plugin pages wear the **web-edition skin** by
default: every plugin's `index.html` links
`../sysdeck-common/sysdeck-web.css` after the base stylesheet, porting
the Next.js console's midnight/teal design (teal accent `#3fc9b0`,
soft-tinted badges, 10px radii, tabular numerals, thin teal-edged
scrollbars) onto the classic cockpit panels. Nothing else changes — the
class vocabulary, the bridge, and every module are untouched.

```bash
# revert the plugin pages to the classic 0.1.x skin:
sudo rm /usr/share/cockpit/sysdeck-common/sysdeck-web.css

# also theme the Cockpit SHELL chrome (sidebar, header, login) to match:
sudo make install-branding      # backs up any existing branding.css first
sudo make uninstall-branding    # restore the backup
```

`install-branding` installs `shared/branding.css` as
`/usr/share/cockpit/branding.css` — Cockpit's documented override point
for the shell. It targets both PatternFly v5 (`pf-v5-*`, Cockpit ≥ 300)
and v4 (`pf-c-*`) selector generations, so unmatched rules simply no-op.

Author: **Jeremy Anderson** · <info@dcos.net> · <https://dcos.net>
