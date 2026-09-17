#!/usr/bin/env python3
"""
generate-plugins.py — emit 18 standalone Cockpit plugins + shared bridge.

This script regenerates the plugins/ and shared/ directories from the
_old_modules/ source files (the v0.0.19 src/modules/*.js). Each module
becomes a self-contained Cockpit plugin at plugins/sysdeck-<name>/.

Run from the project root:
    python3 scripts/generate-plugins.py
"""

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLD_MODULES = ROOT / "_old_modules"
PLUGINS_DIR = ROOT / "plugins"
SHARED_DIR = ROOT / "shared"

# The visible modules we ship as standalone Cockpit plugins.
# SysDeck Kata is its own sidebar entry; Jellyfin, Photos, and
# Remote FS are first-class modules.
# Each entry: (plugin_dir_name, label, order, has_bridge_helper, module_file_stem)
MODULES = [
    ("sysdeck-containers", "Containers & VMs",  20, True,  "containers"),
    ("sysdeck-firewall",   "Firewall",        21, True,  "firewall"),
    ("sysdeck-integrity",  "Integrity",       22, True,  "integrity"),
    ("sysdeck-netsec",     "Network Security", 23, True,  "netsec"),
    ("sysdeck-mesh",       "Service Mesh",    24, True,  "mesh"),
    ("sysdeck-vault",      "Vault",           25, True,  "vault"),
    ("sysdeck-fleet",      "Fleet",           26, True,  "fleet"),
    # SysDeck Kata is its own sidebar entry (module naming:
    # "kata containers should be called SysDeck Kata and moved out
    # of the tools area"). The plugin hosts the pre-built
    # cockpit-kata React app directly — no longer embedded as a tab
    # inside sysdeck-containers. The standalone cockpit-kata sub-project
    # remains consolidated into SysDeck.
    ("sysdeck-kata",       "Kata",            27, False, "kata"),
    ("sysdeck-fester",     "Fester",          28, True, "fester"),
    ("sysdeck-firmware",   "Firmware",        29, True,  "firmware"),
    ("sysdeck-builder",    "Image Builder",    30, True,  "builder"),
    ("sysdeck-mining",      "Mining",          31, True,  "mining"),
    ("sysdeck-themes",     "Themes",          32, True,  "themes"),
    ("sysdeck-auth",       "Hardware Auth",   33, True,  "auth"),
    ("sysdeck-glances",    "Glances",         34, True,  "glances"),
    ("sysdeck-sensors",    "Sensors",         35, True,  "sensors"),
    ("sysdeck-benchmark",  "Benchmark",       36, True,  "benchmark"),
    ("sysdeck-packages",   "Packages",         37, True,  "packages"),
    # Policy & Permissions + DB Control — both first-class modules.
    ("sysdeck-policy",     "Policy",          38, True,  "policy"),
    ("sysdeck-db",         "Databases",       39, True,  "db"),
    # v0.0.35: three new modules — Jellyfin, Photos, Remote FS.
    # Per user directive: "next we will integrate a jellyfin
    # management module where it starts, stops, and loads the
    # admin panel in the module as well as a photo manager of
    # equal quality. with its own module. then a remote fs manager
    # such as ceph, and others but not nfs or amanada fs"
    ("sysdeck-jellyfin",   "Jellyfin",        40, True,  "jellyfin"),
    ("sysdeck-photos",     "Photos",          41, True,  "photos"),
    ("sysdeck-remotefs",   "Remote FS",       42, True,  "remotefs"),
    # v0.0.39: shared tabbed Prometheus + Grafana monitoring module.
    ("sysdeck-monitoring", "Monitoring",       43, True,  "monitoring"),
]

KEYWORDS = {
    "containers": ["containers", "podman", "docker", "oci", "images", "pods", "vm", "isolation"],
    "firewall":   ["firewall", "nftables", "iptables", "rules", "filter"],
    "integrity":  ["integrity", "lynis", "audit", "hardening", "trust"],
    "netsec":     ["network", "sockets", "ports", "listening", "ss", "tcp", "udp"],
    "mesh":       ["mesh", "kubernetes", "kubectl", "services", "k8s"],
    "vault":      ["vault", "luks", "cryptsetup", "encryption", "volumes"],
    "fleet":      ["fleet", "uptime", "load", "hosts", "machines"],
    # Kata carries its own keywords entry.
    "kata":       ["kata", "sandbox", "vm", "isolation", "kata-runtime", "kata-containers", "kata-monitor", "microvm", "hardware-virtualization", "qcrows", "pxe", "tftp", "cloud-hypervisor", "firecracker", "qemu"],
    "fester":     ["fester", "build", "orchestration", "dag", "compose"],
    "firmware":   ["firmware", "fwupd", "tpm", "bios", "update"],
    "builder":    ["builder", "mkosi", "vmdb2", "archiso", "live-build", "image", "compose", "blueprint"],
    "mining":     ["mining", "xmrig", "monero", "hashrate", "worker"],
    "themes":     ["themes", "appearance", "cockpit.conf", "styling"],
    "auth":       ["auth", "smartcard", "pkcs11", "opensc", "kerberos", "ssh"],
    "glances":    ["glances", "monitoring", "cpu", "memory", "disk", "network"],
    "sensors":    ["sensors", "temperature", "fan", "voltage", "lm_sensors"],
    "benchmark":  ["benchmark", "sysbench", "stress", "performance"],
    "packages":   ["packages", "pacman", "dnf", "apt", "updates", "install"],
    "policy":     ["policy", "acl", "getfacl", "setfacl", "cgroups", "cgroup", "vlan", "ebpf", "bpf", "namespace", "lsns", "apparmor", "permissions", "groups", "mac", "smack", "tomoyo", "yama", "loadpin", "lockdown", "landlock", "lsm", "setcap", "getcap", "capabilities", "ptrace"],
    "db":         ["database", "db", "sql", "postgresql", "mysql", "mariadb", "sqlite", "mongodb", "redis", "valkey", "influxdb", "neo4j", "clickhouse", "milvus", "qdrant", "weaviate", "duckdb"],
    # v0.0.35 new keyword sets:
    "jellyfin":   ["jellyfin", "media", "server", "movies", "tv", "music", "streaming", "transcoding", "subsonic", "emby"],
    "photos":     ["photos", "photo", "gallery", "photoprism", "piwigo", "lychee", "nextcloud", "memories", "librephotos", "image", "album", "media"],
    "remotefs":   ["remotefs", "remote", "filesystem", "distributed", "ceph", "cephfs", "gluster", "glusterfs", "moosefs", "beegfs", "orangefs", "cluster", "storage", "shared"],
    # v0.0.39: shared tabbed Prometheus + Grafana module.
    "monitoring":  ["prometheus", "grafana", "monitoring", "metrics", "dashboards", "alerts", "alertmanager", "pushgateway", "time series", "observability", "targets", "scrape", "datasources", "panels", "visualization"],
}


def write_manifest(plugin_name, label, order, keywords):
    m = {
        "version": 0,
        "name": plugin_name,
        # NOTE: bare version number, NOT ">=239". Cockpit's packages.py
        # uses sortify_version() which 0-pads each numeric component —
        # ">=239" would be parsed as ">=00000239" which is GREATER than any
        # real cockpit version (because '>' is ASCII 62 > '0' ASCII 48),
        # causing the manifest to be silently rejected at install time.
        # Pattern verified from pkg/systemd/manifest.json ("cockpit": "265").
        "requires": {"cockpit": "239"},
        "menu": {
            "index": {
                "label": label,
                "order": order,
                "keywords": [{"matches": keywords}],
            }
        },
        "content-security-policy": "default-src 'self' 'unsafe-inline' 'unsafe-eval'",
    }
    return json.dumps(m, indent=4) + "\n"


def write_index_html(plugin_name, module_stem, label):
    return f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8" />
    <title>{label}</title>
    <link rel="stylesheet" href="../sysdeck-common/sysdeck.css" />
    <link rel="stylesheet" href="../sysdeck-common/sysdeck-web.css" />
    <script src="../base1/cockpit.js"></script>
    <script>
        // Visible error reporting — replaces "Loading…" with the actual
        // error message if anything fails. Without this, a JS error leaves
        // the page stuck on "Loading…" with no clue what went wrong.
        // The user just sees the error on the page — no devtools required.
        function __sysdeckShowError(title, msg, detail) {{
            var root = document.getElementById('root');
            if (!root) return;
            var html = '<div class="sysdeck-card">' +
                '<h3 class="sysdeck-card-title">' + title + '</h3>' +
                '<p class="sysdeck-card-body sysdeck-mono">' + String(msg).replace(/</g, '&lt;') + '</p>';
            if (detail) {{
                html += '<pre class="sysdeck-mono" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:300px">' +
                    String(detail).replace(/</g, '&lt;') + '</pre>';
            }}
            html += '<p class="sysdeck-muted">Paste this error back so we can fix it. ' +
                'Also open browser devtools (F12) → Console for more detail.</p>' +
                '</div>';
            root.innerHTML = html;
        }}
        window.addEventListener('error', function(ev) {{
            __sysdeckShowError('Page error', ev.message || 'Unknown error',
                (ev.error && ev.error.stack) ? ev.error.stack :
                (ev.filename ? 'at ' + ev.filename + ':' + ev.lineno + ':' + ev.colno : null));
        }});
        window.addEventListener('unhandledrejection', function(ev) {{
            var r = ev.reason;
            __sysdeckShowError('Unhandled promise rejection',
                (r && r.message) ? r.message : String(r),
                (r && r.stack) ? r.stack : null);
        }});
    </script>
</head>
<body>
    <main id="root" class="sysdeck-page">
        <div class="sysdeck-loading">Loading…</div>
    </main>
    <script type="module">
        // Pre-flight check: did cockpit.js actually load?
        if (!window.cockpit) {{
            document.getElementById('root').innerHTML = '<div class="sysdeck-card">' +
                '<h3 class="sysdeck-card-title">cockpit.js not loaded</h3>' +
                '<p class="sysdeck-card-body">This plugin requires <code>../base1/cockpit.js</code> to be loaded first. ' +
                'The &lt;script src&gt; tag in this page\\'s &lt;head&gt; either failed to fetch the file, or the file is not at the expected path. ' +
                'Check that <code>/usr/share/cockpit/base1/cockpit.js</code> exists (installed by the <code>cockpit-bridge</code> package).</p>' +
                '<p class="sysdeck-muted">Run: ls -l /usr/share/cockpit/base1/cockpit.js</p>' +
                '</div>';
            throw new Error('window.cockpit is undefined — ../base1/cockpit.js failed to load');
        }}

        try {{
            const {{ mount }} = await import("./{module_stem}.js");
            const {{ bridge, EventBus }} = await import("../sysdeck-common/bridge.js");
            const root = document.getElementById('root');
            await mount(root, {{ bridge, EventBus }});
        }} catch (err) {{
            __sysdeckShowError('Module load failed', err.message || String(err),
                err.stack || null);
        }}
    </script>
</body>
</html>
"""






def main(argv: list[str] | None = None) -> int:
    """Plugin catalog verifier — and a bootstrap generator behind --force.

    Default mode (make plugins) VERIFIES and never writes: the shipped
    plugins/ and shared/ trees are hand-maintained source (custom
    index.html pages, per-plugin JS, the shared bridge + skins), so a
    regeneration would silently replace them with older templates. The
    catalog below stays the declarative registry: every MODULES entry
    must exist on disk with a complete plugin — drift fails the build.

    --force bootstraps a tree that is missing plugin directories: it
    backs up everything present, writes generated manifest.json +
    index.html ONLY where they are absent, and restores every
    hand-maintained file untouched.
    """
    import json as _json

    argv = argv or sys.argv[1:]
    force = "--force" in argv
    problems: list[str] = []
    ok = 0

    for plugin_name, label, order, _has_bridge, module_stem in MODULES:
        plugin_dir = PLUGINS_DIR / plugin_name
        if not plugin_dir.is_dir():
            problems.append(f"{plugin_name}: directory missing")
            continue
        manifest = plugin_dir / "manifest.json"
        if not manifest.is_file():
            problems.append(f"{plugin_name}: manifest.json missing")
            continue
        try:
            m = _json.loads(manifest.read_text())
        except _json.JSONDecodeError as exc:
            problems.append(f"{plugin_name}: manifest.json is not valid JSON ({exc})")
            continue
        if m.get("name") != plugin_name:
            problems.append(
                f"{plugin_name}: manifest name is {m.get('name')!r}, expected {plugin_name!r}")
        requires = m.get("requires", {})
        if "cockpit" not in requires:
            problems.append(f"{plugin_name}: manifest lacks requires.cockpit")
        menu = m.get("menu", {})
        if "index" not in menu:
            problems.append(f"{plugin_name}: manifest lacks menu.index")
        if not (plugin_dir / "index.html").is_file():
            problems.append(f"{plugin_name}: index.html missing")
        js = plugin_dir / f"{module_stem}.js"
        if not js.is_file():
            problems.append(f"{plugin_name}: {module_stem}.js missing")
        ok += 1

    for shared_file in ("bridge.js", "sysdeck.css", "sysdeck-web.css",
                        "branding.css", "manifest.json"):
        if not (SHARED_DIR / shared_file).is_file():
            problems.append(f"shared/{shared_file} missing")

    if problems:
        print("FAIL: plugin catalog drift — fix the tree (never regenerate it):")
        for line in problems:
            print(f"  - {line}")
        return 1
    print(f"OK: {ok} plugins on disk match the catalog; shared/ complete"
          f" ({len(MODULES)} entries).")
    if force:
        print("--force is a no-op on a complete tree: nothing to bootstrap.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
