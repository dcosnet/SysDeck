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
        // Subcommands aligned with bridge/containers.py COMMANDS:
        //   list     → list podman containers
        //   inspect  → inspect one container
        // (containers.py has no 'count' or 'action' subcommand)
        list:   () => bridgeCmd("containers", ["list"]),
        inspect: (id) => bridgeCmd("containers", ["inspect", id]),
        action: async (id, action) => {
            // containers.py has no 'action' subcommand; use podman directly
            const map = { stop: "stop", restart: "restart", rm: "rm" };
            // 'try': rootless podman manages the operator's own store;
            // escalation only when the host demands it
            await spawn(["podman", map[action] || action, id], { superuser: "try" });
        },
        count: async () => {  // no 'count' subcommand; compute from list
            try {
                const list = await bridgeCmd("containers", ["list"]);
                return Array.isArray(list) ? list.length : 0;
            } catch { return 0; }
        },
        subscribeCount: (_cb) => () => {},  // no-op: manual refresh only
    },

    firewall: {
        // v0.0.31 REWRITE — PREVIOUS SURFACE WAS READ-ONLY.
        // Subcommands aligned with bridge/firewall.py COMMANDS:
        //   ruleset       → list active nftables rules (v0.0.30, kept)
        //   chains        → list nftables chain names (v0.0.30, kept)
        //   templates     → list installed *.sh templates
        //   template-info → show one template's metadata
        //   detect        → run active template's detect action
        //   apply         → apply a template (start action) under polkit
        //   stop          → stop the firewall
        //   restart        → stop + re-apply active template
        //   status        → running state + ban lists + counters
        //   ban           → add IP to ssh_abuse set
        //   unban         → delete IP from all ban sets
        //   banned        → list banned IPs across all sets
        //   clear-bans    → flush all ban sets
        //   check         → nft -c list ruleset (validate)
        //
        // v0.0.36 additions — backend dropdown + Cilium + security-hardening:
        //   backends                  → list backends + availability
        //   backend-info              → one backend's details + install hint
        //   active-backend            → currently selected backend id + metadata
        //   switch-backend            → switch backend (stops old, applies new)
        //   install-backend           → install backend deps via packages module
        //   cilium-status             → cilium status --brief
        //   cilium-endpoints          → cilium endpoint list -o json
        //   cilium-policy             → cilium policy get -o json
        //   cilium-policy-apply       → cilium policy apply <file>
        //   cilium-policy-validate    → cilium policy validate <file>
        //   security-hardening        → CVE-derived hardening checklist
        //
        // Mutating ops (apply, stop, restart, ban, unban, clear-bans,
        // switch-backend, install-backend, cilium-policy-apply) run with
        // { superuser: 'try' } — the cockpit bridge prompts the operator
        // via polkit for the org.sysdeck.firewall.modify action (shipped
        // since v0.0.17). v0.0.36 extends the action to authorize
        // /usr/bin/cilium, /usr/sbin/cilium, /usr/bin/cilium-agent,
        // /usr/sbin/cilium-agent, and /usr/bin/helm.
        // No `sudo` shell-out from JS; the bridge runs as the cockpit
        // user and gets root privileges via polkit when the operator
        // authenticates. This is the "cockpit way" per user directive
        // v0.0.31.
        listChains:   () => bridgeCmd("firewall", ["chains"]),
        listRules:    () => bridgeCmd("firewall", ["ruleset"]),
        ruleCount:    async () => {  // no 'count' subcommand; compute from ruleset
            try {
                const rs = await bridgeCmd("firewall", ["ruleset"]);
                const text = typeof rs === 'string' ? rs : JSON.stringify(rs);
                return (text.match(/\bchain\b/g) || []).length;
            } catch { return 0; }
        },
        // v0.0.31 manager methods — all use the bridge subcommands
        // added in this release.
        templates:    () => bridgeCmd("firewall", ["templates"]),
        templateInfo: (name) => bridgeCmd("firewall", ["template-info", name]),
        detect:       () => bridgeCmd("firewall", ["detect"]),
        apply:        (template, policy) => bridgeCmd(
            "firewall",
            policy ? ["apply", template, policy] : ["apply", template],
            { superuser: "try" },
        ),
        stop:         () => bridgeCmd("firewall", ["stop"], { superuser: "try" }),
        restart:      () => bridgeCmd("firewall", ["restart"], { superuser: "try" }),
        status:       () => bridgeCmd("firewall", ["status"]),
        ban:          (ip) => bridgeCmd("firewall", ["ban", ip], { superuser: "try" }),
        unban:        (ip) => bridgeCmd("firewall", ["unban", ip], { superuser: "try" }),
        banned:       () => bridgeCmd("firewall", ["banned"]),
        clearBans:    () => bridgeCmd("firewall", ["clear-bans"], { superuser: "try" }),
        check:        () => bridgeCmd("firewall", ["check"]),
        // v0.0.36 backend dropdown — read-only queries do NOT need superuser.
        backends:              () => bridgeCmd("firewall", ["backends"]),
        backendInfo:           (name) => bridgeCmd("firewall", ["backend-info", name]),
        activeBackend:         () => bridgeCmd("firewall", ["active-backend"]),
        switchBackend:         (name) => bridgeCmd("firewall", ["switch-backend", name], { superuser: "try" }),
        installBackend:        (name) => bridgeCmd("firewall", ["install-backend", name], { superuser: "try" }),
        // v0.0.36 Cilium eBPF backend — read-only queries do NOT need superuser.
        ciliumStatus:          () => bridgeCmd("firewall", ["cilium-status"]),
        ciliumEndpoints:       () => bridgeCmd("firewall", ["cilium-endpoints"]),
        ciliumPolicy:          () => bridgeCmd("firewall", ["cilium-policy"]),
        ciliumPolicyApply:     (file) => bridgeCmd("firewall", ["cilium-policy-apply", file], { superuser: "try" }),
        ciliumPolicyValidate:  (file) => bridgeCmd("firewall", ["cilium-policy-validate", file]),
        // v0.0.36 security-hardening — read-only, no auth needed.
        securityHardening:     () => bridgeCmd("firewall", ["security-hardening"]),
        // v0.0.44 service/port editor — detect running services + edit
        // their ports + restart. The 3 new public-server templates
        // (remote-admin.sh, public-webserver.sh, ai-llm.sh) and this
        // editor together implement the user directive: "a few public
        // server variants ... and lastly a full service/port editor
        // that detects based on running ports and services detected
        // on them. make it as simple as editing the port to change it
        // in a config on the system. auto restart the associated
        // service if it is changed."
        // services + serviceInfo are read-only — no auth.
        // setServicePort + restartService mutate state — they need
        // superuser (polkit prompts via the cockpit bridge). The
        // org.sysdeck.firewall.modify action (shipped since v0.0.17)
        // already authorizes systemctl.
        services:       () => bridgeCmd("firewall", ["services"]),
        serviceInfo:    (id) => bridgeCmd("firewall", ["service-info", id]),
        setServicePort: (id, port) => bridgeCmd(
            "firewall",
            ["set-service-port", id, String(port)],
            { superuser: "try" },
        ),
        restartService: (id) => bridgeCmd(
            "firewall",
            ["restart-service", id],
            { superuser: "try" },
        ),
    },

    // v0.0.47: Service / Port Editor is now its own sidebar entry —
    // sysdeck-services at order 45. Per user directive: "we should
    // move the service/ports editor to its own module entry for ease
    // of access." The bridge surface below is a thin proxy over the
    // existing firewall.py subcommands (services / service-info /
    // set-service-port / restart-service) — no new bridge helper
    // needed, no Python changes. The firewall.py SERVICES_REGISTRY
    // and the four subcommands remain the source of truth.
    //
    // Why proxy instead of move: the bridge/firewall.py helper already
    // owns the SERVICES_REGISTRY + the atomic-write + systemctl
    // restart logic + the CONFIG_BASE_DIRS allowlist. Duplicating
    // that into a new bridge/services.py would split the security-
    // critical path across two files. Keeping it in firewall.py and
    // proxying from bridge.services keeps one auditable code path.
    services: {
        // list() — detect running listening services + cross-reference
        //          against SERVICES_REGISTRY. Read-only — no auth.
        // info(id) — show one service's full registry entry + detected
        //            port from its config file. Read-only — no auth.
        // setPort(id, port) — edit the port in the service's config
        //                     file (atomic write) + systemctl restart.
        //                     Mutates state — needs superuser.
        // restart(id) — systemctl restart only (no port change).
        //               Mutates state — needs superuser.
        list:      ()            => bridgeCmd("firewall", ["services"]),
        info:      (id)          => bridgeCmd("firewall", ["service-info", id]),
        setPort:   (id, port)    => bridgeCmd(
            "firewall",
            ["set-service-port", id, String(port)],
            { superuser: "try" },
        ),
        restart:   (id)          => bridgeCmd(
            "firewall",
            ["restart-service", id],
            { superuser: "try" },
        ),
    },

    integrity: {
        // Subcommands aligned with bridge/integrity.py COMMANDS:
        //   score → trust score from lynis
        //   scan  → run lynis scan
        trustScore: () => bridgeCmd("integrity", ["score"]),
        runLynis:   () => bridgeCmd("integrity", ["scan"], { superuser: true }),
    },

    netsec: {
        // v0.0.43: iptraf-ng-style network monitor. Reads /proc/net/dev,
        // /proc/net/snmp, /proc/net/tcp+udp directly — no iptraf-ng
        // binary dependency. The traffic subcommand samples /proc/net/dev
        // twice (1s apart) to compute live RX/TX rates.
        // Legacy sockets/established kept for back-compat.
        summary:        () => bridgeCmd("netsec", ["summary"]),
        traffic:        () => bridgeCmd("netsec", ["traffic"]),
        connections:    () => bridgeCmd("netsec", ["connections"]),
        interfaces:     () => bridgeCmd("netsec", ["interfaces"]),
        protocols:      () => bridgeCmd("netsec", ["protocols"]),
        listeningPorts:    () => bridgeCmd("netsec", ["sockets"]),
        subscribeSocketRate: (_cb) => () => {},  // no-op (legacy)
    },

    mesh: {
        services: () => bridgeCmd("mesh", ["services"]),
    },

    vault: {
        listLuks: () => bridgeCmd("vault", ["list-luks"]),
    },

    fleet: {
        // Subcommands aligned with bridge/fleet.py COMMANDS:
        //   summary → local host + peers + uptime
        //   local   → local host only
        //   peers   → peer hosts only
        // (fleet.py has no 'uptime' or 'node-count' subcommand — use 'summary')
        uptime:    async () => {
            const s = await bridgeCmd("fleet", ["summary"]);
            return s?.local?.uptime ?? 'unavailable';
        },
        nodeCount: async () => {
            const s = await bridgeCmd("fleet", ["summary"]);
            return 1 + (s?.peers?.length ?? 0);
        },
        summary: () => bridgeCmd("fleet", ["summary"]),
        subscribeLoadAvg: (_cb) => () => {},  // no-op
    },

    firmware: {
        // bridge/firmware.py COMMANDS: devices
        // (firmware.py has no 'tpm-info' subcommand; read PCR0 directly)
        devices: () => bridgeCmd("firmware", ["devices"]),
        tpmInfo: async () => {
            try {
                return await spawn(["tpm2_pcrread", "sha256:0"]);
            } catch {
                return 'tpm2-tools not installed';
            }
        },
    },

    builder: {
        // Subcommands aligned with bridge/builder.py COMMANDS.
        // v0.0.30 viewer subcommands (kept):
        //   status       → {state, primary, backends, distro}
        //   profiles     → flat list of build profiles/specs across backends
        //   summary      → combined status + profiles in one call
        //   backends     → just the installed backend list
        //   install-hint → recommended pacman/apt install command for the
        //                  host distro (used when no backend is installed)
        // v0.0.31 full-featured subcommands (new):
        //   build              → run a build for a profile
        //   profile-create     → scaffold a new mkosi.conf / vmdb2 yaml
        //                        (v0.0.49: accepts --packages=<json> + --mode)
        //   profile-copy       → (v0.0.48) copy a shipped archiso/live-build
        //                        profile tree into /etc/
        //                        (v0.0.49: accepts --packages=<json> + --mode)
        //   profile-delete     → delete a profile (refuses /usr/share)
        //   profile-import-packages (v0.1.0) → write the host's
        //                        explicitly-installed packages into a
        //                        profile's package list
        //   build-status       → list active + recent builds
        //   build-log          → tail a build's log file
        //   artifacts          → list image/ISO files per profile
        //
        // Mutating ops (build, profile-create, profile-copy, profile-delete,
        // profile-import-packages) run with { superuser: 'try' } — the cockpit bridge prompts the
        // operator via polkit for the org.sysdeck.builder.modify action
        // (shipped since v0.0.17, v0.0.30 expanded for mkosi/vmdb2/archiso/
        // live-build). No `sudo` shell-out from JS.
        status:        () => bridgeCmd("builder", ["status"]),
        profiles:      () => bridgeCmd("builder", ["profiles"]),
        summary:       () => bridgeCmd("builder", ["summary"]),
        backends:      () => bridgeCmd("builder", ["backends"]),
        installHint:   () => bridgeCmd("builder", ["install-hint"]),
        // v0.0.31 new methods.
        build:         (profile, backend, options) => bridgeCmd(
            "builder",
            ["build", profile, ...(backend ? [backend] : []),
             ...(options ? [`--options=${JSON.stringify(options)}`] : [])],
            { superuser: "try" },
        ),
        // v0.0.49: profileCreate and profileCopy accept an optional
        // inline package list (packagesText — multiline string, one
        // package per line, # comments allowed) and a merge mode
        // ("append" or "replace"). packagesText is JSON-encoded so
        // newlines and quotes survive the argv boundary cleanly. When
        // omitted, the bridge writes no package file (back-compat
        // with v0.0.48 callers).
        profileCreate: (name, backend, base, packagesText, mode) => bridgeCmd(
            "builder",
            ["profile-create", name, backend,
             ...(base ? [base] : []),
             ...(packagesText ? [`--packages=${JSON.stringify(packagesText)}`] : []),
             ...(mode ? [`--mode=${mode}`] : [])],
            { superuser: "try" },
        ),
        // v0.0.48: copy a shipped archiso/live-build profile tree into
        // /etc/. Used by the panel's "Copy shipped profile" form, which
        // is the directory-based-backend counterpart to profileCreate.
        // v0.0.49: accepts the same packagesText + mode args as
        // profileCreate. Default mode for copy is "append" (preserves
        // the baseline's packages); pass "replace" to overwrite.
        profileCopy:   (srcName, newName, backend, packagesText, mode) => bridgeCmd(
            "builder",
            ["profile-copy", srcName, newName,
             ...(backend ? [backend] : []),
             ...(packagesText ? [`--packages=${JSON.stringify(packagesText)}`] : []),
             ...(mode ? [`--mode=${mode}`] : [])],
            { superuser: "try" },
        ),
        profileDelete: (name, force) => bridgeCmd(
            "builder",
            ["profile-delete", name, ...(force ? ["--force"] : [])],
            { superuser: "try" },
        ),
        // v0.1.0: import the host's explicitly-installed packages into
        // an existing profile's package list. Queries pacman -Qqe /
        // apt-mark showmanual / dnf repoquery --userinstalled on the
        // host and writes the result via the same _write_packages
        // dispatch used by profileCreate/profileCopy. mode defaults to
        // "append" (layer host packages on top of the profile's
        // existing baseline); pass "replace" to wipe first. dryRun
        // returns what would be written without touching the file.
        profileImportPackages: (name, mode, dryRun) => bridgeCmd(
            "builder",
            ["profile-import-packages", name,
             ...(mode ? [`--mode=${mode}`] : []),
             ...(dryRun ? ["--dry-run"] : [])],
            { superuser: "try" },
        ),
        buildStatus:   () => bridgeCmd("builder", ["build-status"]),
        buildLog:       (id) => bridgeCmd("builder", ["build-log", id]),
        // v0.1.3: build management — delete state + log (+ optionally artifacts).
        buildDelete:    (id, deleteArtifacts) => bridgeCmd(
            "builder",
            ["build-delete", id, ...(deleteArtifacts ? ["--artifacts"] : [])],
            { superuser: "try" },
        ),
        artifacts:      (profile) => bridgeCmd(
            "builder",
            ["artifacts", ...(profile ? [profile] : [])],
        ),
        // v0.1.3: artifact management — delete single file or clear all.
        artifactDelete: (profile, name) => bridgeCmd(
            "builder",
            ["artifact-delete", profile, name],
            { superuser: "try" },
        ),
        artifactsClear: (profile) => bridgeCmd(
            "builder",
            ["artifacts-clear", profile],
            { superuser: "try" },
        ),
    },

    mining: {
        // v0.0.34 EXPANDED TO 1999 POWER-TOOL STYLE.
        // Read-only:
        workers:          () => bridgeCmd("mining", ["summary"]),
        summary:          () => bridgeCmd("mining", ["summary"]),
        threads:          () => bridgeCmd("mining", ["threads"]),
        poolConfigGet:    () => bridgeCmd("mining", ["pool-config-get"]),
        threadsConfigGet: () => bridgeCmd("mining", ["threads-config-get"]),
        algorithmGet:     () => bridgeCmd("mining", ["algorithm-get"]),
        serviceStatus:    () => bridgeCmd("mining", ["service-status"]),
        // Mutating (XMRig REST API):
        poolConfigSet:    (url, user, pass) => bridgeCmd("mining", ["pool-config-set", url, user, pass]),
        threadsConfigSet: (count) => bridgeCmd("mining", ["threads-config-set", String(count)]),
        algorithmSet:     (presetId) => bridgeCmd("mining", ["algorithm-set", presetId]),
        pause:            () => bridgeCmd("mining", ["pause"]),
        resume:           () => bridgeCmd("mining", ["resume"]),
        pauseWorker:      (id) => bridgeCmd("mining", ["pause-worker", String(id)]),
        resumeWorker:     (id) => bridgeCmd("mining", ["resume-worker", String(id)]),
        // Mutating (systemd service control — polkit org.sysdeck.system.modify):
        start:            () => bridgeCmd("mining", ["start"], { superuser: "try" }),
        stop:             () => bridgeCmd("mining", ["stop"], { superuser: "try" }),
        restart:          () => bridgeCmd("mining", ["restart"], { superuser: "try" }),
    },

    themes: {
        // v0.0.34 EXPANDED TO 1999 POWER-TOOL STYLE.
        // Read-only:
        readConfig:     () => bridgeCmd("themes", ["read-config"]),
        presetList:     () => bridgeCmd("themes", ["preset-list"]),
        variableList:   () => bridgeCmd("themes", ["variable-list"]),
        variableGet:    (name) => bridgeCmd("themes", ["variable-get", name]),
        // Mutating (writes /etc/cockpit/cockpit.conf — polkit org.sysdeck.system.modify):
        writeConfig:    (text) => bridgeCmd("themes", ["write-config", text], { superuser: "try" }),
        set:            (section, key, value) => bridgeCmd("themes", ["set", section, key, value], { superuser: "try" }),
        unset:          (section, key) => bridgeCmd("themes", ["unset", section, key], { superuser: "try" }),
        reset:          () => bridgeCmd("themes", ["reset"], { superuser: "try" }),
        presetApply:    (id) => bridgeCmd("themes", ["preset-apply", id], { superuser: "try" }),
        variableSet:    (name, value) => bridgeCmd("themes", ["variable-set", name, value], { superuser: "try" }),
        variableReset:  () => bridgeCmd("themes", ["variable-reset"], { superuser: "try" }),
    },

    auth: {
        // Subcommands aligned with bridge/auth.py COMMANDS:
        //   slots       → PKCS#11 smartcard reader slots
        //   identities  → SSH keys + Kerberos principals
        //   ssh-keys    → SSH keys only
        //   kerberos    → Kerberos principals only
        //   readers     → smartcard-class USB devices (lsusb)
        //   certs       → PKCS#11 cert objects (v0.1.4 — replaces the
        //                 panel's bridge.spawn() calls that never worked)
        // (auth.py has no 'smartcards' subcommand — use 'slots')
        smartcards: () => bridgeCmd("auth", ["slots"]),
        identities: () => bridgeCmd("auth", ["identities"]),
        sshKeys:    () => bridgeCmd("auth", ["ssh-keys"]),
        kerberos:   () => bridgeCmd("auth", ["kerberos"]),
        readers:    () => bridgeCmd("auth", ["readers"]),
        certs:      () => bridgeCmd("auth", ["certs"]),
    },

    // v0.0.38: Kata panel rewritten as vanilla JS backed by bridge/kata.py.
    // The v0.0.35-v0.0.37 React bundle is deleted (it showed hardcoded
    // mock data — 5 fake sandboxes, fake metrics, fake PXE status).
    // Every method below calls the REAL Kata Containers 3.x APIs:
    //   - list/inspect/metrics → kata-monitor HTTP /sandboxes, /agent-url,
    //     /metrics?sandbox=<id> + filesystem /run/vc/sbs/, /run/kata/
    //   - summary/version/check → kata-runtime version/env --json/check
    //   - pxeStatus → systemctl is-active dnsmasq + real /srv/tftp probes
    //   - qcrowsList → filesystem /usr/share/sysdeck/kata/qcrows/
    // Read-only queries do NOT pass { superuser: 'try' }.
    kata: {
        list:       () => bridgeCmd("kata", ["list"]),
        inspect:    (id) => bridgeCmd("kata", ["inspect", id]),
        metrics:    (id) => bridgeCmd("kata", ["metrics", id]),
        summary:    () => bridgeCmd("kata", ["summary"]),
        version:    () => bridgeCmd("kata", ["version"]),
        check:      () => bridgeCmd("kata", ["check"]),
        pxeStatus:  () => bridgeCmd("kata", ["pxe-status"]),
        qcrowsList: () => bridgeCmd("kata", ["qcrows-list"]),
    },

    // v0.0.39: Monitoring module — shared tabbed Prometheus + Grafana panel.
    // Both bridge helpers (bridge/prometheus.py, bridge/grafana.py) call
    // the real HTTP APIs. No mock data. Read-only queries do NOT pass
    // { superuser: 'try' }; restart/reload DO (they invoke systemctl).
    prometheus: {
        summary:    () => bridgeCmd("prometheus", ["summary"]),
        targets:    () => bridgeCmd("prometheus", ["targets"]),
        alerts:     () => bridgeCmd("prometheus", ["alerts"]),
        rules:      () => bridgeCmd("prometheus", ["rules"]),
        config:     () => bridgeCmd("prometheus", ["config"]),
        logSummary: () => bridgeCmd("prometheus", ["log-summary"]),
        restart:    () => bridgeCmd("prometheus", ["restart"], { superuser: "try" }),
        reload:     () => bridgeCmd("prometheus", ["reload"], { superuser: "try" }),
    },

    grafana: {
        summary:     () => bridgeCmd("grafana", ["summary"]),
        dashboards:  () => bridgeCmd("grafana", ["dashboards"]),
        datasources: () => bridgeCmd("grafana", ["datasources"]),
        alerts:      () => bridgeCmd("grafana", ["alerts"]),
        health:      () => bridgeCmd("grafana", ["health"]),
        org:         () => bridgeCmd("grafana", ["org"]),
        users:       () => bridgeCmd("grafana", ["users"]),
        plugins:     () => bridgeCmd("grafana", ["plugins"]),
        search:      (q) => bridgeCmd("grafana", ["search", q]),
        restart:     () => bridgeCmd("grafana", ["restart"], { superuser: "try" }),
        reload:      () => bridgeCmd("grafana", ["reload"], { superuser: "try" }),
    },

    fester: {
        // v0.2.0 — real integration with the vendored fester service
        // (web/mini-services/fester, REST on :3010). The old build-jobs
        // stub that listed systemd units is gone.
        status:   () => bridgeCmd("fester", ["status"]),
        metrics:  () => bridgeCmd("fester", ["metrics"]),
        builds:   () => bridgeCmd("fester", ["builds"]),
        build:    (id) => bridgeCmd("fester", ["build", String(id)]),
        nodes:    () => bridgeCmd("fester", ["nodes"]),
        targets:  () => bridgeCmd("fester", ["targets"]),
        timeline: (id) => bridgeCmd("fester", ["timeline", String(id)]),
        sessions: () => bridgeCmd("fester", ["sessions"]),
        startBuild: (project, targets, opts) => bridgeCmd("fester", ["start-build", "--project", String(project), "--targets", (targets || []).join(","), ...((opts && opts.noCache) ? ["--no-cache"] : []), ...((opts && opts.retries != null) ? ["--retries", String(opts.retries)] : [])]),
        cancel:   (id) => bridgeCmd("fester", ["cancel", String(id)]),
        replay:   (buildId, label) => bridgeCmd("fester", ["replay", String(buildId), ...((label != null) ? ["--label", String(label)] : [])]),
    },

    klanker: {
        // v0.3.0 NEW MODULE — the vendored klanker-gate service
        // (master-build/klanker-gate): the Frosty Deno LLM gateway,
        // REST on :8080. UPSTREAM: klanker-gate by TykoDev
        // (https://github.com/TykoDev/klanker-gate, Apache-2.0) —
        // not SysDeck code; see klanker-gate/ATTRIBUTION.md.
        // Read-only polls hit the operator API
        // (KLANKER_URL / KLANKER_ADMIN_TOKEN env, see bridge/klanker.py
        // — the token travels as a bearer header only, never echoed);
        // service/journal wrap systemctl + journalctl for the
        // klanker-gate.service unit (superuser via the bridgeCmd
        // default, so polkit prompts the operator).
        status:    () => bridgeCmd("klanker", ["status"]),
        providers: () => bridgeCmd("klanker", ["providers"]),
        models:    () => bridgeCmd("klanker", ["models"]),
        vkeys:     () => bridgeCmd("klanker", ["vkeys"]),
        logs:      (limit) => bridgeCmd("klanker", ["logs", "--limit", String(limit ?? 25)]),
        analytics: () => bridgeCmd("klanker", ["analytics"]),
        runtime:   () => bridgeCmd("klanker", ["runtime"]),
        service:   (action) => bridgeCmd("klanker", ["service", String(action)]),
        journal:   (n) => bridgeCmd("klanker", ["journal", String(n ?? 40)]),
        localstack: () => bridgeCmd("klanker", ["localstack"]),
    },

    glances: {
        // v0.0.34 INTEGRATES THE GLANCES BUILT-IN WEB UI.
        // Read-only:
        snapshot:    () => bridgeCmd("glances", ["snapshot"]),
        cpu:         () => bridgeCmd("glances", ["cpu"]),
        memory:      () => bridgeCmd("glances", ["memory"]),
        network:     () => bridgeCmd("glances", ["network"]),
        webStatus:   () => bridgeCmd("glances", ["web-status"]),
        // Mutating — start/stop the built-in webserver via subprocess
        // under the cockpit superuser channel (polkit org.sysdeck.system.modify):
        startWeb:    (port) => bridgeCmd("glances", ["start-web", ...(port ? [String(port)] : [])], { superuser: "try" }),
        stopWeb:     () => bridgeCmd("glances", ["stop-web"], { superuser: "try" }),
    },

    sensors: {
        summary: () => bridgeCmd("sensors", ["summary"]),
    },

    benchmark: {
        listTests:  () => bridgeCmd("benchmark", ["list-tests"]),
        // sysbench needs no root; lynis (runLynis) does and keeps it
        runCpu:     () => bridgeCmd("benchmark", ["run-cpu"], { superuser: "try" }),
        runMemory:  () => bridgeCmd("benchmark", ["run-memory"], { superuser: "try" }),
        runIo:      () => bridgeCmd("benchmark", ["run-io"], { superuser: "try" }),
        runTest:    (name) => bridgeCmd("benchmark", ["run-test", name], { superuser: "try" }),
    },

    packages: {
        // v0.0.31: install/remove/update/update-all now ACTUALLY RUN
        // the package manager via subprocess. The bridge helper
        // executes pacman/apt/dnf and returns the actual stdout/stderr
        // in the response. The JS panel passes { superuser: 'try' } so
        // the cockpit bridge prompts the operator via polkit for the
        // org.sysdeck.packages.modify action (shipped since v0.0.17).
        // No `sudo` shell-out from JS — this is the cockpit way.
        summary:       () => bridgeCmd("packages", ["summary"]),
        listInstalled: () => bridgeCmd("packages", ["list-installed"]),
        search:        (q) => bridgeCmd("packages", ["search", q]),
        install:       (pkg) => bridgeCmd("packages", ["install", pkg], { superuser: "try" }),
        remove:        (pkg) => bridgeCmd("packages", ["remove", pkg], { superuser: "try" }),
        update:        (pkg) => bridgeCmd("packages", ["update", pkg], { superuser: "try" }),
        updateAll:     () => bridgeCmd("packages", ["update-all"], { superuser: "try" }),
        // v0.0.31: dry-run returns the command string without running
        // it, for the panel's preview-before-confirm flow.
        dryRun:        (action, pkg) => bridgeCmd("packages", ["dry-run", action, ...(pkg ? [pkg] : [])]),
    },

    policy: {
        // v0.0.32 NEW MODULE — modern policy management and permissions
        // manager for groups.
        // v0.0.33 EXPANDED — adds the rest of the modern Linux LSM
        // stack: Smack, TOMOYO, Yama, LoadPin, Lockdown, BPF-LSM,
        // Landlock, plus file capabilities (setcap/getcap). SELinux
        // remains skipped (native). Each new LSM is optional — the
        // bridge auto-detects whether it is compiled into the kernel
        // and returns { available: false, reason: ... } when absent;
        // the panel renders an install/enable hint instead of an
        // empty table.
        //
        // Mutating ops (acl-set, acl-remove, acl-default, cgroup-create,
        // cgroup-move, cgroup-set, vlan-create, vlan-delete, ebpf-pin,
        // apparmor-enforce, apparmor-complain, smack-load, yama-set-scope,
        // tomoyo-save-policy, filecaps-set, filecaps-remove) use
        // { superuser: 'try' } — the cockpit bridge prompts the
        // operator via polkit for the org.sysdeck.policy.modify action.
        summary:            () => bridgeCmd("policy", ["summary"]),
        // ACLs
        aclList:            (path) => bridgeCmd("policy", ["acl-list", path]),
        aclSet:             (path, entry) => bridgeCmd("policy", ["acl-set", path, entry], { superuser: "try" }),
        aclRemove:          (path, entry) => bridgeCmd("policy", ["acl-remove", path, entry], { superuser: "try" }),
        aclDefault:         (path, entry) => bridgeCmd("policy", ["acl-default", path, entry], { superuser: "try" }),
        // cgroups v2
        cgroupList:         () => bridgeCmd("policy", ["cgroup-list"]),
        cgroupShow:         (path) => bridgeCmd("policy", ["cgroup-show", path]),
        cgroupProcs:        (path) => bridgeCmd("policy", ["cgroup-procs", path]),
        cgroupCreate:       (path) => bridgeCmd("policy", ["cgroup-create", path], { superuser: "try" }),
        cgroupMove:         (pid, path) => bridgeCmd("policy", ["cgroup-move", pid, path], { superuser: "try" }),
        cgroupSet:          (path, ctrl, val) => bridgeCmd("policy", ["cgroup-set", path, ctrl, val], { superuser: "try" }),
        // VLANs
        vlanList:           () => bridgeCmd("policy", ["vlan-list"]),
        vlanShow:           (iface) => bridgeCmd("policy", ["vlan-show", iface]),
        vlanCreate:         (iface, vid) => bridgeCmd("policy", ["vlan-create", iface, vid], { superuser: "try" }),
        vlanDelete:         (iface, vid) => bridgeCmd("policy", ["vlan-delete", iface, vid], { superuser: "try" }),
        // eBPF
        ebpfList:           () => bridgeCmd("policy", ["ebpf-list"]),
        ebpfShow:           (id) => bridgeCmd("policy", ["ebpf-show", id]),
        ebpfMaps:           () => bridgeCmd("policy", ["ebpf-maps"]),
        ebpfPin:            (id, path) => bridgeCmd("policy", ["ebpf-pin", id, path], { superuser: "try" }),
        // namespaces
        nsList:             () => bridgeCmd("policy", ["ns-list"]),
        nsShow:             (nsid) => bridgeCmd("policy", ["ns-show", nsid]),
        // AppArmor (optional)
        apparmorStatus:     () => bridgeCmd("policy", ["apparmor-status"]),
        apparmorProfiles:   () => bridgeCmd("policy", ["apparmor-profiles"]),
        apparmorEnforce:    (profile) => bridgeCmd("policy", ["apparmor-enforce", profile], { superuser: "try" }),
        apparmorComplain:   (profile) => bridgeCmd("policy", ["apparmor-complain", profile], { superuser: "try" }),

        // v0.0.33: additional LSMs — Smack, TOMOYO, Yama, LoadPin,
        // Lockdown, BPF-LSM, Landlock + file capabilities. Each is
        // optional; the bridge auto-detects and the panel renders an
        // install/enable hint when absent.
        lsmStatus:          () => bridgeCmd("policy", ["lsm-status"]),
        // Smack
        smackStatus:        () => bridgeCmd("policy", ["smack-status"]),
        smackLabels:        () => bridgeCmd("policy", ["smack-labels"]),
        smackLoad:          (rulesFile) => bridgeCmd("policy", ["smack-load", rulesFile], { superuser: "try" }),
        // TOMOYO
        tomoyoStatus:       () => bridgeCmd("policy", ["tomoyo-status"]),
        tomoyoProfiles:     () => bridgeCmd("policy", ["tomoyo-profiles"]),
        tomoyoSavePolicy:   (outPath) => bridgeCmd("policy", ["tomoyo-save-policy", outPath], { superuser: "try" }),
        // Yama
        yamaStatus:         () => bridgeCmd("policy", ["yama-status"]),
        yamaSetScope:       (scope) => bridgeCmd("policy", ["yama-set-scope", String(scope)], { superuser: "try" }),
        // LoadPin
        loadpinStatus:      () => bridgeCmd("policy", ["loadpin-status"]),
        // Lockdown
        lockdownStatus:     () => bridgeCmd("policy", ["lockdown-status"]),
        // BPF-LSM
        bpflsmStatus:       () => bridgeCmd("policy", ["bpflsm-status"]),
        // Landlock
        landlockStatus:     () => bridgeCmd("policy", ["landlock-status"]),
        // File capabilities (setcap/getcap)
        filecapsList:       () => bridgeCmd("policy", ["filecaps-list"]),
        filecapsShow:       (path) => bridgeCmd("policy", ["filecaps-show", path]),
        filecapsSet:        (caps, path) => bridgeCmd("policy", ["filecaps-set", caps, path], { superuser: "try" }),
        filecapsRemove:     (path) => bridgeCmd("policy", ["filecaps-remove", path], { superuser: "try" }),
    },

    db: {
        // DB Control module — unified control for SQL/NoSQL/vector/AI
        // database engines. The bridge helper bridge/db.py surfaces
        // 32+ engines across SQL/NoSQL/Vector/TimeSeries/Graph/
        // Embedded/Cloud/AI families with summary/status/start/stop/
        // restart/connections/query subcommands.
        //
        // The cockpit-way pattern: the bridge runs systemctl directly
        // via subprocess; the JS panel passes { superuser: 'try' } to
        // cockpit.spawn so the cockpit bridge prompts the operator via
        // polkit for the org.sysdeck.db.modify action.
        //
        // Subcommands aligned with bridge/db.py:
        //   summary       — list all detected engines with status
        //   status <id>   — detailed status for one engine
        //   start <id>    — start engine via systemctl
        //   stop <id>     — stop engine via systemctl
        //   restart <id>  — restart engine via systemctl
        //   connections <id> — list active TCP connections
        //   query <id> <sql>  — execute a SQL query (SQL engines only)
        summary:        () => bridgeCmd("db", ["summary"]),
        status:         (id) => bridgeCmd("db", ["status", id]),
        start:          (id) => bridgeCmd("db", ["start", id], { superuser: "try" }),
        stop:           (id) => bridgeCmd("db", ["stop", id], { superuser: "try" }),
        restart:        (id) => bridgeCmd("db", ["restart", id], { superuser: "try" }),
        connections:    (id) => bridgeCmd("db", ["connections", id]),
        query:          (id, sql) => bridgeCmd("db", ["query", id, sql], { superuser: "try" }),
    },

    jellyfin: {
        // v0.0.35 NEW MODULE — Jellyfin media server management.
        // Per user directive: "next we will integrate a jellyfin
        // management module where it starts, stops, and loads the
        // admin panel in the module." Jellyfin ships a single systemd
        // unit (jellyfin.service) and serves a full admin web UI on
        // http://127.0.0.1:8096. The bridge starts/stops/restarts the
        // service via systemctl; the panel iframes the running admin
        // UI — same pattern as the v0.0.34 Glances integration.
        //
        // Mutating ops (start, stop, restart) run with
        // { superuser: 'try' } — the cockpit bridge prompts the
        // operator via polkit for the org.sysdeck.jellyfin.modify
        // action (added in v0.0.35).
        //
        // Subcommands aligned with bridge/jellyfin.py:
        //   summary       — service status + version + port + url
        //   status        — service status only
        //   start         — systemctl start jellyfin.service
        //   stop          — systemctl stop jellyfin.service
        //   restart       — systemctl restart jellyfin.service
        //   web-status    — {running, url, port, ...} for iframe
        //   libraries     — best-effort GET /Library/VirtualFolders
        summary:    () => bridgeCmd("jellyfin", ["summary"]),
        status:     () => bridgeCmd("jellyfin", ["status"]),
        start:      () => bridgeCmd("jellyfin", ["start"], { superuser: "try" }),
        stop:       () => bridgeCmd("jellyfin", ["stop"], { superuser: "try" }),
        restart:    () => bridgeCmd("jellyfin", ["restart"], { superuser: "try" }),
        webStatus:  () => bridgeCmd("jellyfin", ["web-status"]),
        libraries:  () => bridgeCmd("jellyfin", ["libraries"]),
    },

    photos: {
        // v0.0.35 NEW MODULE — Photo Manager. Per user directive:
        // "as well as a photo manager of equal quality. with its own
        // module." Following the Jellyfin pattern: each supported
        // backend ships as a systemd service with a built-in admin
        // web UI; the bridge starts/stops/restarts the service via
        // systemctl and the panel iframes the running admin UI.
        //
        // Multi-backend design — same shape as bridge/db.py. The
        // bridge auto-detects which backends are installed.
        //
        // Subcommands aligned with bridge/photos.py:
        //   summary       — list all backends with status
        //   status <id>   — single-backend detail
        //   start <id>    — systemctl start <service>
        //   stop <id>     — systemctl stop <service>
        //   restart <id>  — systemctl restart <service>
        //   web-status <id> — {running, url, port, ...} for iframe
        summary:    () => bridgeCmd("photos", ["summary"]),
        status:     (id) => bridgeCmd("photos", ["status", id]),
        start:      (id) => bridgeCmd("photos", ["start", id], { superuser: "try" }),
        stop:       (id) => bridgeCmd("photos", ["stop", id], { superuser: "try" }),
        restart:    (id) => bridgeCmd("photos", ["restart", id], { superuser: "try" }),
        webStatus:  (id) => bridgeCmd("photos", ["web-status", id]),
    },

    remotefs: {
        // v0.0.35 NEW MODULE — Remote Filesystems. Per user
        // directive: "then a remote fs manager such as ceph, and
        // others but not nfs or amanada fs." Manages remote /
        // distributed filesystem backends as systemd services and
        // surfaces cluster status from each backend's CLI tool.
        //
        // Multi-backend design — same shape as bridge/db.py.
        // Backends shipped: Ceph, GlusterFS, MooseFS, BeeGFS,
        // OrangeFS. NFS and Amanda explicitly excluded per directive.
        //
        // Subcommands aligned with bridge/remotefs.py:
        //   summary       — list all backends + excluded dict
        //   status <id>   — single-backend detail
        //   start <id>    — systemctl start <service>
        //   stop <id>     — systemctl stop <service>
        //   restart <id>  — systemctl restart <service>
        //   cluster-info <id> — backend-specific cluster status
        summary:      () => bridgeCmd("remotefs", ["summary"]),
        status:       (id) => bridgeCmd("remotefs", ["status", id]),
        start:        (id) => bridgeCmd("remotefs", ["start", id], { superuser: "try" }),
        stop:         (id) => bridgeCmd("remotefs", ["stop", id], { superuser: "try" }),
        restart:      (id) => bridgeCmd("remotefs", ["restart", id], { superuser: "try" }),
        clusterInfo:  (id) => bridgeCmd("remotefs", ["cluster-info", id]),
    },

    // v0.0.46 — 3rd-party Cockpit module installer.
    //   catalog     → full module catalog (static list from bridge)
    //   status      → per-module installed + missing-deps status
    //   preflight   → license / author / source / install plan disclosure
    //                 (the front-end renders this BEFORE calling install)
    //   install     → run the pull. The 1-click UI always passes
    //                 acceptLicense=true because the license is shown
    //                 inline next to the Install button — the click IS
    //                 the operator's acceptance gesture. The bridge
    //                 still refuses silent installs (no acceptLicense)
    //                 as a guard against malicious callers.
    //   uninstall   → remove the module
    //   audit       → tail of /etc/cockpit/MODULE_LICENSES.log
    //
    // install / uninstall run with { superuser: 'try' } — the cockpit
    // bridge prompts the operator via polkit for the
    // org.sysdeck.modules3p.modify action (shipped in
    // packaging/polkit/org.sysdeck.modules3p.policy).
    modules3p: {
        catalog:    () => bridgeCmd("modules3p", ["catalog"]),
        status:     () => bridgeCmd("modules3p", ["status"]),
        preflight:  (id) => bridgeCmd("modules3p", ["preflight", id]),
        install:    (id, acceptLicense) => bridgeCmd(
            "modules3p",
            acceptLicense ? ["install", id, "--accept-license=1"] : ["install", id],
            { superuser: "try" },
        ),
        uninstall:  (id) => bridgeCmd("modules3p", ["uninstall", id], { superuser: "try" }),
        audit:      (limit) => bridgeCmd("modules3p", limit != null ? ["audit", String(limit)] : ["audit"]),
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
