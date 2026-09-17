# Installation Guide

SysDeck ships in two shapes from one tree: the **standalone web console** (the default — no Cockpit on the host at all) and the **Cockpit plugin suite** (optional — the same 27 domain modules dropped into an existing Cockpit). Pick the path that matches your operational model.

Author: **Jeremy Anderson** · <info@dcos.net> · <https://dcos.net> · [github.com/dcosnet/SysDeck](https://github.com/dcosnet/SysDeck)

---

## Prerequisites

**Standalone web console:** Bun ≥ 1.1 (`pacman -S bun`, or the installer from bun.sh; Node-only hosts work too — see the node path below), ~200 MB disk, ~512 MB RAM. **Not required:** Cockpit, the Python bridge, systemd, Docker, root. SQLite is bundled via Prisma — no database server.

**Cockpit plugin suite:**

- **Cockpit** ≥ 239 (`cockpit-bridge --version` to verify) — *only* needed for this path
- **Python** ≥ 3.9 (`python3 --version`)
- **polkit** — privilege escalation, the cockpit way
- Root or sudo access for the system-wide install

Recommended backend tools (each module fails closed when its backend is absent, but the dashboard is more useful with all present):

| Tool | Module(s) | Install (Fedora/RHEL) |
|------|-----------|------------------------|
| `podman` | Containers & VMs | `dnf install podman` |
| `nftables` | Firewall, Netsec | `dnf install nftables` |
| `lynis` | Integrity | `dnf install lynis` (EPEL) |
| `iproute2` | Netsec | `dnf install iproute` |
| `kubectl` | Service Mesh | See Kubernetes docs |
| `util-linux` | Vault | `dnf install util-linux` |
| `kata-runtime` | Kata | `dnf install kata-runtime` |
| `fwupd` | Firmware | `dnf install fwupd` |
| `tpm2-tools` | Firmware | `dnf install tpm2-tools` |
| `mkosi` (Arch) / `vmdb2` (Debian) | Image Builder | Arch: `pacman -S mkosi` · Debian: `apt install vmdb2` · Fedora: `dnf install mkosi` |
| `opensc` / `pcsc-lite` | Hardware Auth | `dnf install opensc pcsc-lite` |
| `prometheus` / `grafana` | Monitoring | See upstream docs |
| `jellyfin` | Jellyfin | `dnf install jellyfin` · Arch: `pacman -S jellyfin` · Debian: `apt install jellyfin` |
| `photoprism` (or `piwigo` / `lychee` / `librephotos`) | Photos | `yay -S photoprism` · Debian: see PhotoPrism docs |
| `ceph` (or `glusterfs` / `moosefs` / `beegfs` / `orangefs`) | Remote FS | `dnf install ceph` · Arch: `pacman -S ceph` · Debian: `apt install ceph` |

---

## Option 0 — Standalone web console (no Cockpit)

Best for hosts without Cockpit — or anywhere you want the console to be the whole deployment.

```bash
tar xjf sysdeck-0.4.4-master.tar.bz2
cd sysdeck-0.4.4-master
make web-dev        # bun install + db:push + fester (:3010) + web console (:3000)
```

Open `http://localhost:3000` and sign in with a Unix account (the host's PAM stack — see `SYSDECK_AUTH_MODE` in `web/README.md` §5). The production path — standalone build, the two systemd units, reverse proxy with the `?XTransformPort=` websocket gateway, environment reference, troubleshooting — is the complete runbook at [`web/README.md`](../web/README.md), shipped in-console as the "Run without Cockpit" panel.

Nothing this path installs touches the system: one process, a bundled SQLite store, an optional sidecar service for Fester.

---

## Option A — Make (Cockpit plugin install)

Best for operators who want a single-command install from source.

```bash
tar xjf sysdeck-0.4.4-master.tar.bz2
cd sysdeck-0.4.4-master
sudo make install
sudo systemctl restart cockpit.socket
```

**What it does:**
- Copies each `plugins/sysdeck-*/{manifest.json,index.html,*.js}` to `/usr/share/cockpit/sysdeck-<name>/` (27 plugins).
- Copies `shared/{manifest.json,bridge.js,sysdeck.css,sysdeck-web.css}` to `/usr/share/cockpit/sysdeck-common/`.
- Copies each `bridge/*.py` (executable, 0755, invoked by absolute path) to `/usr/lib/sysdeck/bridge/` (28 helpers).
- Copies the 7 firewall templates to `/usr/share/sysdeck/firewall/templates/` and the prometheus/grafana provisioning configs to `/usr/share/sysdeck/prometheus/`.
- Installs the AppStream metainfo and both polkit policies; reloads polkit, refreshes the AppStream cache.
- Drops `sysdeck-diagnose.sh`, `cockpit-smoke-test.sh`, and `sysdeck-uninstall.sh` at `/usr/share/sysdeck/`.

**Uninstall:**
```bash
sudo make uninstall
sudo systemctl restart cockpit.socket
```

---

## Option B — RPM (Fedora / RHEL / CentOS)

Best for production deployments that want package-manager lifecycle.

```bash
# Build the RPM from the tarball
rpmbuild -bb packaging/sysdeck.spec \
    -D "_sourcedir $PWD"

# Install
sudo dnf install ~/rpmbuild/RPMS/noarch/sysdeck-0.4.4-1.*.noarch.rpm
sudo systemctl restart cockpit.socket
```

**What the RPM does:**
- Installs the 27 plugins under `/usr/share/cockpit/sysdeck-*/` and the shared bridge under `/usr/share/cockpit/sysdeck-common/`.
- Installs the Python bridge under `/usr/lib/sysdeck/bridge/`.
- `Recommends:` the backend tools so dnf suggests them on install.
- `%post` and `%postun` scriptlets restart `cockpit.socket` automatically.

**Uninstall:**
```bash
sudo dnf remove sysdeck
```

On **Arch Linux**, use `packaging/PKGBUILD`; on **Debian/Ubuntu**, use `packaging/debian/` with `dpkg-buildpackage`. Both carry the same file set as the RPM.

---

## Option C — pip

Best for Python-shop environments that prefer pip over RPM.

```bash
tar xjf sysdeck-0.4.4-master.tar.bz2
cd sysdeck-0.4.4-master
sudo pip3 install packaging/
sudo systemctl restart cockpit.socket
```

**What it does:**
- `setup.py` declares the package plus the bridge helpers.
- Pip lays the helpers out under the system paths (`/usr/lib/sysdeck/`).

**Uninstall:**
```bash
sudo pip3 uninstall sysdeck
sudo ./sysdeck-uninstall.sh     # sweeps the file layout pip does not track
sudo systemctl restart cockpit.socket
```

Note: pip's `data_files` are not tracked for uninstall on all platforms. The quiet uninstaller above is the safe path — it covers every layout ever shipped.

---

## Option D — staged overlay (for image builds)

Best for building container images or kickstart-installed systems where you want to stage files into a directory and then copy them into the image.

```bash
tar xjf sysdeck-0.4.4-master.tar.bz2
cd sysdeck-0.4.4-master
make install DESTDIR=/tmp/overlay
# /tmp/overlay now contains:
#   /tmp/overlay/usr/share/cockpit/sysdeck-*/
#   /tmp/overlay/usr/lib/sysdeck/bridge/
```

Copy `/tmp/overlay/usr/*` into your image's `/usr/` and the plugins are ready.

---

## Verifying the install (Cockpit path)

After any Cockpit-path install, verify:

```bash
# 1. Plugin manifests are in place (27 directories + sysdeck-common)
ls -d /usr/share/cockpit/sysdeck-*/ | wc -l

# 2. A manifest is valid JSON
python3 -m json.tool /usr/share/cockpit/sysdeck-firewall/manifest.json

# 3. Bridge helpers are in place
ls /usr/lib/sysdeck/bridge/

# 4. Cockpit socket is running
systemctl status cockpit.socket

# 5. The full diagnostic
sudo /usr/share/sysdeck/sysdeck-diagnose.sh
```

Then open `https://<host>:9090` and look for the **27 `SysDeck <Name>` entries** in the sidebar (the full list with orders is in [QUICKSTART.md](../QUICKSTART.md) §5).

---

## Troubleshooting

### Menu entries do not appear

1. Confirm each plugin's `manifest.json` is valid JSON and registers under the `menu` → `index` key (the magic key cockpit scans for).
2. Confirm `sysdeck-common/manifest.json` exists — without it, every `/cockpit/@localhost/sysdeck-common/bridge.js` URL 404s and panels stay on "Loading…".
3. Restart `cockpit.socket`: `sudo systemctl restart cockpit.socket`.
4. Check the journal: `journalctl -u cockpit -f --since "5 min ago"`.
5. Run the diagnostic: `sudo /usr/share/sysdeck/sysdeck-diagnose.sh`.

### Panel shows "X unavailable"

Each panel calls a backend tool through the bridge (`cockpit.spawn` on the cockpit side, the `/api/bridge` dispatcher on the web side). If the tool is absent, the panel shows an install hint. Install the missing tool (see the prerequisites table above) and click **Refresh** in the header.

### Python bridge helpers not found

The JS bridge client calls each helper by absolute path — `python3 /usr/lib/sysdeck/bridge/<module>.py <subcommand>`. Confirm:

1. `python3` is in the cockpit service's PATH (usually `/usr/bin/python3`).
2. The helpers are installed at `/usr/lib/sysdeck/bridge/<module>.py` with the executable bit (0755).
3. No `python3 -m sysdeck.bridge` call exists anywhere — that pattern requires a nested package layout the install never produced, and a `make check` guard rejects it.

### Content Security Policy violations

The manifests declare `content-security-policy: default-src 'self' 'unsafe-inline'` — no plugin evaluates code, so `unsafe-eval` stays out of every manifest. If your cockpit deployment enforces a stricter policy, tighten the manifest to match; the panels do not require it.

### Web console: login loop or 401 on every route

The page is server-rendered as the login screen until the `sd_session` cookie verifies. Check that the system clock is sane (tokens carry a 12 h expiry), that `DATABASE_URL` points at the initialized SQLite file (`bun run db:push` once), and that the browser is not stripping cookies (behind a proxy, set `SYSDECK_SESSION_SECURE=1` only when the proxy terminates TLS).

---

For the standalone console's own deployment runbook — production build, systemd units, reverse proxy, websocket gateway — see [`web/README.md`](../web/README.md).
