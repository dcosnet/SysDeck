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
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OLD_MODULES = ROOT / "_old_modules"
PLUGINS_DIR = ROOT / "plugins"
SHARED_DIR = ROOT / "shared"

# The 22 visible modules we ship as standalone Cockpit plugins
# (v0.0.35: SysDeck Kata restored as a standalone sidebar entry,
#  plus three new modules — Jellyfin, Photos, Remote FS).
# Each entry: (plugin_dir_name, label, order, has_bridge_helper, module_file_stem)
MODULES = [
    ("sysdeck-containers", "Containers & VMs",  20, True,  "containers"),
    ("sysdeck-firewall",   "Firewall",        21, True,  "firewall"),
    ("sysdeck-integrity",  "Integrity",       22, True,  "integrity"),
    ("sysdeck-netsec",     "Network Security", 23, True,  "netsec"),
    ("sysdeck-mesh",       "Service Mesh",    24, True,  "mesh"),
    ("sysdeck-vault",      "Vault",           25, True,  "vault"),
    ("sysdeck-fleet",      "Fleet",           26, True,  "fleet"),
    # v0.0.35: SysDeck Kata restored to its own sidebar entry per
    # user directive: "kata containers should be called SysDeck Kata
    # and moved out of the tools area." The plugin hosts the pre-built
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
    # v0.0.32: two new modules — Policy & Permissions (new) + DB Control (restored).
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
    # v0.0.35: Kata restored to its own keywords entry.
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


BRIDGE_JS = '''\
/*
 * SysDeck — shared bridge.js
 *
 * Provides the `bridge` and `EventBus` objects that each SysDeck Cockpit
 * plugin imports. Wraps cockpit.spawn() calls to the Python bridge helpers
 * under /usr/lib/sysdeck/bridge/ (invoked as `python3 -m sysdeck.bridge.<m>`).
 *
 * COCKPIT.JS LOADING CONTRACT (verified from cockpit source code):
 *   - pkg/base1/cockpit.js is a UMD/IIFE script that sets `window.cockpit`
 *     as a global. It is NOT an ES module — it has no `export` statements.
 *   - Plugins load it via `<script src="../base1/cockpit.js"></script>` in
 *     their index.html (see pkg/systemd/index.html for the reference pattern).
 *   - At build time, cockpit's esbuild plugin (build.js:71-83) rewrites
 *     `import cockpit from "cockpit"` in plugin source to
 *     `module.exports = cockpit` — i.e., a reference to the global.
 *   - SysDeck plugins don't go through esbuild, so we access the global
 *     `window.cockpit` directly. The index.html already loads cockpit.js
 *     via <script src> before this module runs.
 *
 * v0.0.22 BUG: this file did `import cockpit from "../base1/cockpit.js"`
 * — that's an ES module import, but cockpit.js has no ES exports. The
 * import returned undefined, so cockpit.spawn() threw when mount() ran,
 * and the plugin page stayed on "Loading…". Fixed in v0.0.23 by using
 * the global `window.cockpit` instead.
 *
 * Live-update subscriptions (subscribeCount, subscribeLoadAvg,
 * subscribeSocketRate, dbusProxies.systemd) are no-ops in v0.0.23.
 * Each module's mount() already wraps them in try/catch, so they degrade
 * gracefully — the page loads once and provides a manual refresh button.
 */

// cockpit.js is loaded by index.html's <script src="../base1/cockpit.js">.
// It sets window.cockpit as a global. We access it directly here.
//
// If window.cockpit is undefined at this point, it means cockpit.js failed
// to load (404, network error, or wrong path). Throw a clear error so the
// plugin page shows the actual problem instead of silently failing.
if (typeof window.cockpit === 'undefined') {
    throw new Error(
        'shared/bridge.js: window.cockpit is undefined. ' +
        'This means ../base1/cockpit.js (loaded via <script src> in ' +
        'index.html) failed to load. Check that ' +
        '/usr/share/cockpit/base1/cockpit.js exists on disk (installed ' +
        'by the cockpit-bridge package). Run: ' +
        'ls -l /usr/share/cockpit/base1/cockpit.js'
    );
}
const cockpit = window.cockpit;

// ── spawn helpers ──────────────────────────────────────────────────
//
// HOW BRIDGE HELPERS ARE INVOKED (verified working in v0.0.26):
//
// Each Python helper at /usr/lib/sysdeck/bridge/<module>.py has a
// `if __name__ == "__main__": sys.exit(main(sys.argv[1:]))` guard, so it
// can be run as a standalone script: `python3 /usr/lib/sysdeck/bridge/glances.py snapshot`.
//
// v0.0.25 BUG: bridge.js called `python3 -m sysdeck.bridge.glances`. That
// requires `sysdeck` to be importable as a Python package AND `sysdeck.bridge`
// to be a subpackage containing `glances.py`. The install layout was:
//   /usr/lib/sysdeck/bridge/__init__.py  (the sysdeck package)
//   /usr/lib/sysdeck/bridge/glances.py   (the helper, in the sysdeck package)
// So `python3 -m sysdeck.glances` would work, but `python3 -m sysdeck.bridge.glances`
// looks for `sysdeck/bridge/glances.py` — a path that doesn't exist. Every
// plugin that called a bridge helper got ModuleNotFoundError.
//
// v0.0.26 FIX: call helpers by absolute path. No package layout, no
// symlink, no PYTHONPATH magic. The Makefile installs each helper to
// /usr/lib/sysdeck/bridge/<module>.py and the JS calls it directly.

const BRIDGE_DIR = "/usr/lib/sysdeck/bridge";

function spawn(argv, options = {}) {
    return cockpit.spawn(argv, { err: "message", ...options });
}

async function spawnJson(argv, options = {}) {
    const out = await spawn(argv, options);
    try { return JSON.parse(out); } catch { return out; }
}

async function bridgeCmd(module, args = [], options = {}) {
    return spawnJson(
        ["python3", `${BRIDGE_DIR}/${module}.py`, ...args],
        { superuser: "try", ...options }
    );
}

// ── bridge module surfaces (per-module helpers) ─────────────────────

export const bridge = {
    containers: {
        list: () => bridgeCmd("containers", ["list"]),
        action: (id, action) => bridgeCmd("containers", ["action", id, action], { superuser: true }),
        count: () => bridgeCmd("containers", ["count"]),
        subscribeCount: (_cb) => () => {},  // no-op: manual refresh only in v0.0.20
    },

    firewall: {
        listChains: () => bridgeCmd("firewall", ["list-chains"]),
        listRules:  () => bridgeCmd("firewall", ["list-rules"]),
        ruleCount:  () => bridgeCmd("firewall", ["count"]),
    },

    integrity: {
        trustScore: () => bridgeCmd("integrity", ["trust-score"]),
        runLynis:   () => bridgeCmd("integrity", ["run-lynis"], { superuser: true }),
    },

    netsec: {
        summary:        () => bridgeCmd("netsec", ["summary"]),
        traffic:        () => bridgeCmd("netsec", ["traffic"]),
        connections:    () => bridgeCmd("netsec", ["connections"]),
        interfaces:     () => bridgeCmd("netsec", ["interfaces"]),
        protocols:      () => bridgeCmd("netsec", ["protocols"]),
        listeningPorts:    () => bridgeCmd("netsec", ["sockets"]),
        subscribeSocketRate: (_cb) => () => {},  // no-op
    },

    mesh: {
        services: () => bridgeCmd("mesh", ["services"]),
    },

    vault: {
        listLuks: () => bridgeCmd("vault", ["list-luks"]),
    },

    fleet: {
        uptime: () => bridgeCmd("fleet", ["uptime"]),
        nodeCount: () => bridgeCmd("fleet", ["node-count"]),
        subscribeLoadAvg: (_cb) => () => {},  // no-op
    },

    firmware: {
        devices: () => bridgeCmd("firmware", ["devices"]),
        tpmInfo: () => bridgeCmd("firmware", ["tpm-info"]),
    },

    builder: {
        status: () => bridgeCmd("builder", ["status"]),
    },

    mining: {
        workers: () => bridgeCmd("mining", ["workers"]),
    },

    themes: {
        readConfig: async () => {
            return cockpit.file("/etc/cockpit/cockpit.conf").read();
        },
    },

    auth: {
        smartcards: () => bridgeCmd("auth", ["smartcards"]),
        identities: () => bridgeCmd("auth", ["identities"]),
        sshKeys:    () => bridgeCmd("auth", ["ssh-keys"]),
        kerberos:   () => bridgeCmd("auth", ["kerberos"]),
    },

    kata: {
        // v0.0.38: real bridge surface — replaces the v0.0.37 mock.
        list:       () => bridgeCmd("kata", ["list"]),
        inspect:    (id) => bridgeCmd("kata", ["inspect", id]),
        metrics:    (id) => bridgeCmd("kata", ["metrics", id]),
        summary:    () => bridgeCmd("kata", ["summary"]),
        version:    () => bridgeCmd("kata", ["version"]),
        check:      () => bridgeCmd("kata", ["check"]),
        pxeStatus:  () => bridgeCmd("kata", ["pxe-status"]),
        qcrowsList: () => bridgeCmd("kata", ["qcrows-list"]),
    },

    fester: {
        buildJobs: () => bridgeCmd("fester", ["build-jobs"]),
    },

    glances: {
        snapshot: () => bridgeCmd("glances", ["snapshot"]),
    },

    sensors: {
        summary: () => bridgeCmd("sensors", ["summary"]),
    },

    benchmark: {
        listTests:  () => bridgeCmd("benchmark", ["list-tests"]),
        runCpu:     () => bridgeCmd("benchmark", ["run-cpu"], { superuser: true }),
        runMemory:  () => bridgeCmd("benchmark", ["run-memory"], { superuser: true }),
        runIo:      () => bridgeCmd("benchmark", ["run-io"], { superuser: true }),
        runTest:    (name) => bridgeCmd("benchmark", ["run-test", name], { superuser: true }),
    },

    packages: {
        summary:       () => bridgeCmd("packages", ["summary"]),
        listInstalled: () => bridgeCmd("packages", ["list-installed"]),
        search:        (q) => bridgeCmd("packages", ["search", q]),
        updateAll:     () => bridgeCmd("packages", ["update-all"], { superuser: true }),
    },
};

// ── dbusProxies (no-op in v0.0.20) ──────────────────────────────────

export const dbusProxies = {
    systemd: null,
};

// ── EventBus (no-op in v0.0.20) ─────────────────────────────────────

export const EventBus = {
    emit: () => {},
    on:   () => () => {},
    off:  () => {},
};
'''


SHARED_CSS = """\
/*
 * SysDeck — shared sysdeck.css
 *
 * Base styles for every SysDeck Cockpit plugin. Loaded via
 * <link rel="stylesheet" href="../sysdeck-common/sysdeck.css"> from each
 * plugin's index.html.
 *
 * The class names below (.sysdeck-card, .sysdeck-table, etc.) are the
 * canonical v0.0.20 names. For backward compatibility with the v0.0.19
 * module JS (which still uses .suite-* class names), we alias every
 * .suite-* name to its .sysdeck-* equivalent at the bottom of this file.
 * v0.0.21 can rename the classes inside the module JS and drop the aliases.
 */

:root {
    --sysdeck-bg: #1e1e1e;
    --sysdeck-fg: #e0e0e0;
    --sysdeck-muted: #888;
    --sysdeck-accent: #06c;
    --sysdeck-accent-success: #3c9;
    --sysdeck-accent-warn: #f0ad4e;
    --sysdeck-accent-danger: #d9534f;
    --sysdeck-border: #444;
    --sysdeck-card-bg: #2a2a2a;
}

body {
    background: var(--sysdeck-bg);
    color: var(--sysdeck-fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    margin: 0;
}

.sysdeck-page { padding: 1.5rem; max-width: 1200px; margin: 0 auto; }
.sysdeck-loading { color: var(--sysdeck-muted); padding: 2rem; text-align: center; }

.sysdeck-card { background: var(--sysdeck-card-bg); border: 1px solid var(--sysdeck-border); border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
.sysdeck-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
.sysdeck-card-title { margin: 0; font-size: 1.05rem; font-weight: 600; }
.sysdeck-card-body { color: var(--sysdeck-fg); line-height: 1.5; }
.sysdeck-panel-title { margin: 0 0 0.25rem 0; font-size: 1.4rem; font-weight: 600; }
.sysdeck-panel-subtitle { margin: 0 0 1rem 0; color: var(--sysdeck-muted); font-size: 0.9rem; }
.sysdeck-muted { color: var(--sysdeck-muted); }
.sysdeck-mono, .sysdeck-table-mono { font-family: "SF Mono", "Monaco", "Inconsolata", "Roboto Mono", "Cascadia Code", monospace; font-size: 0.85rem; }

.sysdeck-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
.sysdeck-table th, .sysdeck-table td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--sysdeck-border); }
.sysdeck-table th { color: var(--sysdeck-muted); font-weight: 500; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; }
.sysdeck-table tr:hover td { background: rgba(255, 255, 255, 0.03); }

.sysdeck-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 3px; font-size: 0.75rem; font-weight: 500; background: rgba(255, 255, 255, 0.1); }
.sysdeck-badge.success { background: var(--sysdeck-accent-success); color: #000; }
.sysdeck-badge.warn { background: var(--sysdeck-accent-warn); color: #000; }
.sysdeck-badge.danger { background: var(--sysdeck-accent-danger); color: #fff; }

.sysdeck-btn { display: inline-block; padding: 0.35rem 0.75rem; border: 1px solid var(--sysdeck-border); background: transparent; color: var(--sysdeck-fg); border-radius: 4px; cursor: pointer; font-size: 0.85rem; font-family: inherit; }
.sysdeck-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.05); }
.sysdeck-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sysdeck-btn-ghost { background: transparent; border-color: transparent; color: var(--sysdeck-muted); }
.sysdeck-btn-ghost:hover:not(:disabled) { color: var(--sysdeck-fg); background: rgba(255, 255, 255, 0.05); }

.sysdeck-skeleton { display: flex; flex-direction: column; gap: 0.75rem; padding: 1rem 0; }
.sysdeck-skeleton-line { height: 0.85rem; background: linear-gradient(90deg, var(--sysdeck-border) 0%, rgba(255,255,255,0.05) 50%, var(--sysdeck-border) 100%); background-size: 200% 100%; animation: sysdeck-skeleton-pulse 1.5s ease-in-out infinite; border-radius: 3px; }
.sysdeck-skeleton-line.w-1\\/3 { width: 33%; }
.sysdeck-skeleton-line.w-1\\/2 { width: 50%; }
.sysdeck-skeleton-line.w-2\\/3 { width: 66%; }
.sysdeck-skeleton-line.w-3\\/4 { width: 75%; }

@keyframes sysdeck-skeleton-pulse {
    0%   { background-position: 0% 50%; }
    100% { background-position: -200% 50%; }
}

/* ── v0.0.19 backward-compatibility aliases ──────────────────────────
 * Each .suite-* selector below aliases to its .sysdeck-* counterpart
 * above. This lets the v0.0.19 module JS (which still references
 * .suite-card, .suite-table, etc.) render correctly without code changes.
 */

.suite-card           { background: var(--sysdeck-card-bg); border: 1px solid var(--sysdeck-border); border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
.suite-card-header    { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
.suite-card-title      { margin: 0; font-size: 1.05rem; font-weight: 600; }
.suite-card-body       { color: var(--sysdeck-fg); line-height: 1.5; }
.suite-panel-title     { margin: 0 0 0.25rem 0; font-size: 1.4rem; font-weight: 600; }
.suite-panel-subtitle  { margin: 0 0 1rem 0; color: var(--sysdeck-muted); font-size: 0.9rem; }
.suite-muted           { color: var(--sysdeck-muted); }
.suite-mono, .suite-table-mono { font-family: "SF Mono", "Monaco", "Inconsolata", "Roboto Mono", "Cascadia Code", monospace; font-size: 0.85rem; }
.suite-table           { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
.suite-table th, .suite-table td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--sysdeck-border); }
.suite-table th        { color: var(--sysdeck-muted); font-weight: 500; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; }
.suite-table tr:hover td { background: rgba(255, 255, 255, 0.03); }
.suite-badge           { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 3px; font-size: 0.75rem; font-weight: 500; background: rgba(255, 255, 255, 0.1); }
.suite-badge.success   { background: var(--sysdeck-accent-success); color: #000; }
.suite-badge.warn      { background: var(--sysdeck-accent-warn); color: #000; }
.suite-badge.danger    { background: var(--sysdeck-accent-danger); color: #fff; }
.suite-btn             { display: inline-block; padding: 0.35rem 0.75rem; border: 1px solid var(--sysdeck-border); background: transparent; color: var(--sysdeck-fg); border-radius: 4px; cursor: pointer; font-size: 0.85rem; font-family: inherit; }
.suite-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.05); }
.suite-btn:disabled    { opacity: 0.5; cursor: not-allowed; }
.suite-btn-ghost       { background: transparent; border-color: transparent; color: var(--sysdeck-muted); }
.suite-btn-ghost:hover:not(:disabled) { color: var(--sysdeck-fg); background: rgba(255, 255, 255, 0.05); }
.suite-skeleton        { display: flex; flex-direction: column; gap: 0.75rem; padding: 1rem 0; }
.suite-skeleton-line   { height: 0.85rem; background: linear-gradient(90deg, var(--sysdeck-border) 0%, rgba(255,255,255,0.05) 50%, var(--sysdeck-border) 100%); background-size: 200% 100%; animation: sysdeck-skeleton-pulse 1.5s ease-in-out infinite; border-radius: 3px; }
.suite-skeleton-line.w-1\\/3 { width: 33%; }
.suite-skeleton-line.w-1\\/2 { width: 50%; }
.suite-skeleton-line.w-2\\/3 { width: 66%; }
.suite-skeleton-line.w-3\\/4 { width: 75%; }
"""


def main():
    # Hand-maintained plugins ship their own manifest.json + index.html +
    # pre-built JS/CSS bundles and are NOT generated by this script. They
    # are listed in MODULES so that tests/check_manifest_consistency.py
    # and scripts/generate-plugins.py enumerate them correctly, but the
    # generator must NOT overwrite their hand-crafted assets.
    # v0.0.35: sysdeck-kata hosts the pre-built cockpit-kata React bundle
    # (index.js ~470KB + index.css ~60KB). Running `make plugins` would
    # wipe these — protect them by backing up + restoring.
    HAND_MAINTAINED_PLUGINS = {"sysdeck-kata"}

    # Backup hand-maintained plugins before wiping plugins/.
    backups: dict[str, dict[str, bytes]] = {}
    if PLUGINS_DIR.exists():
        for plugin_name in HAND_MAINTAINED_PLUGINS:
            plugin_dir = PLUGINS_DIR / plugin_name
            if plugin_dir.is_dir():
                backups[plugin_name] = {
                    f.name: f.read_bytes()
                    for f in plugin_dir.iterdir() if f.is_file()
                }
                print(f"BACKUP (hand-maintained): {plugin_name} "
                      f"({len(backups[plugin_name])} files)")

    if PLUGINS_DIR.exists():
        shutil.rmtree(PLUGINS_DIR)

    # v0.3.0: shared/sysdeck-web.css is the hand-maintained web-edition
    # skin (ports the Next.js console's midnight/teal design onto the
    # cockpit plugin pages). The generator regenerates bridge.js +
    # sysdeck.css + manifest.json from templates below, but the skin is
    # maintained by hand — back it up across the shared/ wipe, exactly
    # like HAND_MAINTAINED_PLUGINS above.
    web_skin_backup: bytes | None = None
    if (SHARED_DIR / "sysdeck-web.css").is_file():
        web_skin_backup = (SHARED_DIR / "sysdeck-web.css").read_bytes()
        print(f"BACKUP (hand-maintained): shared/sysdeck-web.css "
              f"({len(web_skin_backup)} bytes)")

    if SHARED_DIR.exists():
        shutil.rmtree(SHARED_DIR)
    PLUGINS_DIR.mkdir(parents=True)
    SHARED_DIR.mkdir(parents=True)

    # Write shared/bridge.js + shared/sysdeck.css + shared/manifest.json
    # The manifest.json is REQUIRED — without it, cockpit doesn't register
    # sysdeck-common as a package (packages.py:457 scans cockpit/*/manifest.json)
    # and every URL like /cockpit/@localhost/sysdeck-common/bridge.js returns 404.
    # This was the v0.0.24 root cause of "Module load failed: error loading
    # dynamically imported module: .../sysdeck-common/bridge.js".
    # Pattern verified from cockpit's own pkg/static/manifest.json (just `{}`).
    (SHARED_DIR / "bridge.js").write_text(BRIDGE_JS)
    (SHARED_DIR / "sysdeck.css").write_text(SHARED_CSS)
    if web_skin_backup is not None:
        (SHARED_DIR / "sysdeck-web.css").write_bytes(web_skin_backup)
        print("RESTORE (hand-maintained): shared/sysdeck-web.css")
    else:
        (SHARED_DIR / "sysdeck-web.css").write_text(
            "/* stub — the canonical web-edition skin is hand-maintained.\n"
            " * Restore it from the released tarball (shared/sysdeck-web.css)\n"
            " * or the git history before shipping. Plugin index.html pages\n"
            " * link it unconditionally; a missing file 404s harmlessly and\n"
            " * pages fall back to base sysdeck.css. */\n"
        )
    (SHARED_DIR / "manifest.json").write_text(
        '{\n'
        '    "name": "sysdeck-common",\n'
        '    "content-security-policy": "default-src \'self\' \'unsafe-inline\' \'unsafe-eval\'"\n'
        '}\n'
    )

    count = 0
    for plugin_name, label, order, _has_bridge, module_stem in MODULES:
        plugin_dir = PLUGINS_DIR / plugin_name
        plugin_dir.mkdir(parents=True)

        if plugin_name in HAND_MAINTAINED_PLUGINS:
            # Restore the hand-maintained files from the backup we took
            # before wiping plugins/. If no backup (first run on a clean
            # tree), print a clear message — the operator must populate
            # the directory manually (e.g. by extracting the tarball's
            # pre-built assets).
            backup = backups.get(plugin_name, {})
            if not backup:
                print(f"WARN (hand-maintained): {plugin_name} — no existing files "
                      f"to restore. Run `make install` from the tarball instead "
                      f"of `make plugins` to populate the pre-built assets.")
                count += 1
                continue
            for fname, content in backup.items():
                (plugin_dir / fname).write_bytes(content)
            print(f"RESTORE (hand-maintained): {plugin_name} "
                  f"({len(backup)} files)")
            count += 1
            continue

        keywords = KEYWORDS.get(module_stem, [module_stem])
        (plugin_dir / "manifest.json").write_text(
            write_manifest(plugin_name, label, order, keywords)
        )

        (plugin_dir / "index.html").write_text(
            write_index_html(plugin_name, module_stem, label)
        )

        src = OLD_MODULES / f"{module_stem}.js"
        if not src.is_file():
            print(f"WARN: {src} not found, skipping {plugin_name}")
            continue
        shutil.copy2(src, plugin_dir / f"{module_stem}.js")
        count += 1

    print(f"Generated {count} plugins under plugins/")
    print(f"Generated shared/bridge.js + shared/sysdeck.css under shared/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
