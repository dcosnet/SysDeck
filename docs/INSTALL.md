# Installation Guide

SysDeck can be installed four ways. Pick the one that matches your distribution and operational model.

Author: **Jeremy Anderson** · <https://dcos.net>

---

## Prerequisites

All install paths require:

- **Cockpit** ≥ 239 (`cockpit-bridge --version` to verify)
- **Python** ≥ 3.9 (`python3 --version`)
- Root or sudo access for system-wide install

Recommended backend tools (the plugin fails closed when any are absent, but the dashboard is more useful with all present):

| Tool | Module(s) | Install (Fedora/RHEL) |
|------|-----------|------------------------|
| `podman` | Containers | `dnf install podman` |
| `nftables` | Firewall | `dnf install nftables` |
| `lynis` | Integrity | `dnf install lynis` (EPEL) |
| `iproute2` | Netsec | `dnf install iproute` |
| `kubectl` | Mesh | See Kubernetes docs |
| `util-linux` | Vault | `dnf install util-linux` |
| `kata-runtime` | Kata | `dnf install kata-runtime` |
| `fwupd` | Firmware | `dnf install fwupd` |
| `tpm2-tools` | Firmware | `dnf install tpm2-tools` |
| `mkosi` (Arch) / `vmdb2` (Debian) | Builder | Arch: `pacman -S mkosi` · Debian: `apt install vmdb2` · Fedora: `dnf install mkosi` |
| `opensc` | Auth | `dnf install opensc` |
| `pcsc-lite` | Auth | `dnf install pcsc-lite` |
| `prometheus` | Prometheus | `dnf install prometheus` |
| `grafana` | Grafana | See Grafana docs |
| `jellyfin` | Jellyfin | `dnf install jellyfin` · Arch: `pacman -S jellyfin` · Debian: `apt install jellyfin` |
| `photoprism` (or `piwigo` / `lychee` / `librephotos`) | Photos | `yay -S photoprism` · Debian: see PhotoPrism docs |
| `ceph` (or `glusterfs` / `moosefs` / `beegfs` / `orangefs`) | Remote FS | `dnf install ceph` · Arch: `pacman -S ceph` · Debian: `apt install ceph` |

---

## Option A — Make (manual install)

Best for operators who want a single-command install from source.

```bash
tar xjf sysdeck-0.0.35.tar.bz2
cd sysdeck-0.0.35
sudo make install
sudo systemctl restart cockpit.socket
```

**What it does:**
- Copies `manifest.json`, `index.html`, `suite.js`, `suite.css`, `logo.svg` to `/usr/share/cockpit/sysdeck/`.
- Copies `src/*.js` and `src/modules/*.js` to `/usr/share/cockpit/sysdeck/src/` (runtime dynamic imports).
- Copies `bridge/*.py` and `bridge/modules/*.py` to `/usr/lib/sysdeck/bridge/`.
- Copies `README.md` and `LICENSE` to the plugin root.

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
sudo dnf install ~/rpmbuild/RPMS/noarch/sysdeck-0.0.35-1.*.noarch.rpm
sudo systemctl restart cockpit.socket
```

**What the RPM does:**
- Installs the plugin under `/usr/share/cockpit/sysdeck/`.
- Installs the Python bridge under `/usr/lib/sysdeck/bridge/`.
- `Recommends:` the backend tools so dnf suggests them on install.
- `%post` and `%postun` scriptlets restart `cockpit.socket` automatically.

**Uninstall:**
```bash
sudo dnf remove sysdeck
```

---

## Option C — pip

Best for Python-shop environments that prefer pip over RPM.

```bash
tar xjf sysdeck-0.0.35.tar.bz2
cd sysdeck-0.0.35
sudo pip3 install packaging/
sudo systemctl restart cockpit.socket
```

**What it does:**
- `setup.py` declares `data_files` for the cockpit plugin root and the Python bridge location.
- Pip lays them out under the system paths (`/usr/share/cockpit/...` and `/usr/lib/...`).

**Uninstall:**
```bash
sudo pip3 uninstall sysdeck
sudo rm -rf /usr/share/cockpit/sysdeck
sudo systemctl restart cockpit.socket
```

Note: pip's `data_files` are not tracked for uninstall on all platforms. The `rm -rf` above is the safe path.

---

## Option D — staged overlay (for image builds)

Best for building container images or kickstart-installed systems where you want to stage files into a directory and then copy them into the image.

```bash
tar xjf sysdeck-0.0.35.tar.bz2
cd sysdeck-0.0.35
make install DESTDIR=/tmp/overlay
# /tmp/overlay now contains:
#   /tmp/overlay/usr/share/cockpit/sysdeck/
#   /tmp/overlay/usr/lib/sysdeck/bridge/
```

Copy `/tmp/overlay/usr/*` into your image's `/usr/` and the plugin is ready.

---

## Verifying the install

After any install path, verify:

```bash
# 1. Manifest is in place
ls /usr/share/cockpit/sysdeck/manifest.json

# 2. Manifest is valid JSON
python3 -m json.tool /usr/share/cockpit/sysdeck/manifest.json

# 3. Entry HTML is in place
ls /usr/share/cockpit/sysdeck/index.html

# 4. Bridge helpers are in place
ls /usr/lib/sysdeck/bridge/

# 5. Cockpit socket is running
systemctl status cockpit.socket
```

Then open `https://<host>:9090` and look for the **SysDeck** menu entry.

---

## Troubleshooting

### Menu entry does not appear

1. Confirm `manifest.json` is valid JSON.
2. Confirm the `content` key has a `suite` entry pointing to `/index.html`.
3. Restart `cockpit.socket`: `sudo systemctl restart cockpit.socket`.
4. Check the journal: `journalctl -u cockpit -f --since "5 min ago"`.

### Panel shows "X unavailable"

Each panel calls a backend tool via `cockpit.spawn`. If the tool is absent, the panel shows an install hint. Install the missing tool (see the prerequisites table above) and click **Refresh** in the header.

### Python bridge helpers not found

The JS bridge client calls `python3 -m sysdeck.bridge.<module>`. Confirm:

1. `python3` is in the cockpit service's PATH (usually `/usr/bin/python3`).
2. The bridge package is installed at `/usr/lib/sysdeck/bridge/__init__.py`.
3. The `PYTHONPATH` includes `/usr/lib/sysdeck` (the RPM and Makefile set this; pip install does not — add a `/etc/cockpit/cockpit.conf` entry or symlink if needed).

### Content Security Policy violations

The manifest declares `content-security-policy: default-src 'self' 'unsafe-inline' 'unsafe-eval'`. If your cockpit deployment enforces a stricter policy, tighten the manifest to match. The plugin does not require `'unsafe-eval'` if you remove the dynamic `import()` calls and bundle all modules into `suite.js`.

---

## Optional: standalone Next.js dashboard

For hosts without cockpit, the Next.js dashboard variant is preserved under `nextjs-dashboard/`. See [`nextjs-dashboard/QUICKSTART.md`](../nextjs-dashboard/QUICKSTART.md) for its setup. The Next.js variant uses mock data; the cockpit plugin uses real backend calls.
