/*
 * SysDeck - Monitoring Panel (v0.0.43)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * Shared tabbed module hosting Prometheus + Grafana — the two
 * observability stack components. Per user directive: "we have 2
 * modules left, we can actually have them share a module with tabs
 * similar to the container/vm module. we should add prometheus, and
 * graphana webui modules."
 *
 * The panel has two tabs:
 *   1. Prometheus — status card (version, uptime, targets, alerts) +
 *      iframe of the real Prometheus web UI at http://127.0.0.1:9095
 *   2. Grafana — status card (version, dashboards, datasources) +
 *      iframe of the real Grafana web UI at http://127.0.0.1:3000
 *
 * Both tabs back their data with REAL bridge helpers (bridge/prometheus.py
 * and bridge/grafana.py) that call the actual HTTP APIs. No mock data.
 * The iframes load the real web UIs directly — same pattern as the
 * v0.0.34 Glances integration.
 *
 * v0.0.43 hardening applied to both bridge helpers:
 *   - NoRedirectHandler on all HTTP calls (SSRF defense, CVE-2020-35850)
 *   - 127.0.0.1-only URL check (SSRF defense)
 *   - Env scrubbed on every subprocess (CVE-2024-6126)
 *   - Output sanitized (CVE-2022-36446)
 *   - No sudo — cockpit superuser channel + polkit handles auth
 *     (CVE-2022-0824 lesson — the v0.0.15-era sudo shell-out is gone)
 *
 * Bridge surface (see shared/bridge.js → bridge.prometheus + bridge.grafana):
 *   Prometheus:
 *     summary()    → overall status + version + targets + alerts count
 *     targets()    → scrape target health (up/down/duration)
 *     alerts()     → current firing + pending alerts
 *     rules()      → alerting + recording rules
 *     config()     → full Prometheus config
 *     logSummary() → pushgateway log pipeline throughput
 *     restart()    → systemctl restart prometheus.service (superuser)
 *     reload()     → SIGHUP config reload (superuser)
 *   Grafana:
 *     summary()      → overall status + version + dashboard count
 *     dashboards()   → list of provisioned dashboards
 *     datasources()  → list of configured datasources
 *     alerts()       → Grafana-managed alerts
 *     health()       → Grafana health endpoint
 *     org()          → current organization info
 *     users()        → Grafana user list
 *     plugins()      → installed Grafana plugins
 *     search(query)  → search dashboards by name
 *     restart()      → systemctl restart grafana-server.service (superuser)
 *     reload()       → SIGUSR2 provisioning reload (superuser)
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    // Load both summaries in parallel.
    const [promSummary, grafSummary] = await Promise.all([
        safe(bridge.prometheus.summary(), { installed: false, status: 'uninstalled' }),
        safe(bridge.grafana.summary(), { installed: false, status: 'uninstalled' }),
    ]);

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">SysDeck Monitoring</h2>
            <p class="suite-panel-subtitle">
                Observability stack — Prometheus (metrics) + Grafana (dashboards)
                · <span class="suite-badge ${promSummary.installed ? 'success' : 'danger'}">Prometheus ${promSummary.installed ? 'installed' : 'absent'}</span>
                · <span class="suite-badge ${grafSummary.installed ? 'success' : 'danger'}">Grafana ${grafSummary.installed ? 'installed' : 'absent'}</span>
            </p>
        </header>

        <div class="monitoring-tabs">
            <button class="monitoring-tab active" data-tab="prometheus">📊 Prometheus</button>
            <button class="monitoring-tab" data-tab="grafana">📈 Grafana</button>
        </div>

        <div class="monitoring-tab-panel active" id="tab-prometheus">
            ${renderPrometheusTab(promSummary)}
        </div>

        <div class="monitoring-tab-panel" id="tab-grafana">
            ${renderGrafanaTab(grafSummary)}
        </div>

        <div id="monitoring-output" class="suite-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Operation Output</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-monitoring-output-close">✕</button>
            </div>
            <pre class="suite-mono" id="monitoring-output-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:300px"></pre>
        </div>
    `;

    wireEvents(panel, { bridge, EventBus });
    EventBus.emit('monitoring.loaded', {
        prometheusInstalled: promSummary.installed,
        grafanaInstalled: grafSummary.installed,
    });
}

// ── Prometheus tab ──────────────────────────────────────────────────

function renderPrometheusTab(summary) {
    if (!summary.installed) {
        return renderInstallHint('Prometheus', 'prometheus', 'prometheus.service', [
            '# Arch:',
            'sudo pacman -S prometheus',
            '# Debian/Ubuntu:',
            'sudo apt install prometheus prometheus-alertmanager',
            '# Fedora/RHEL:',
            'sudo dnf install prometheus alertmanager',
            '',
            '# IMPORTANT: Cockpit-ws uses port 9090 by default.',
            '# Move Prometheus to port 9095 to avoid the conflict.',
            '# Edit /etc/prometheus/prometheus.yml and add:',
            '#   web.listen_address: "127.0.0.1:9095"',
            '# Or set in /etc/default/prometheus:',
            '#   ARGS="--web.listen-address=127.0.0.1:9095"',
        ], '9095');
    }
    const status = summary.status || 'unknown';
    const statusBadge = `<span class="suite-badge ${status === 'running' ? 'success' : 'danger'}">${escapeHtml(status)}</span>`;
    const targetsUp = summary.targetsUp || 0;
    const targetsTotal = summary.targetsTotal || 0;
    const alertsFiring = summary.alertsFiring || 0;
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Prometheus Status</h3>
                <div>
                    <button class="suite-btn suite-btn-ghost btn-prom-refresh">↻ Refresh</button>
                    <button class="suite-btn suite-btn-ghost btn-prom-reload">↻ Reload Config</button>
                    <button class="suite-btn btn-prom-restart">↻ Restart</button>
                </div>
            </div>
            <div class="suite-card-body">
                <table class="suite-table">
                    <tbody>
                        <tr><td>status</td><td>${statusBadge}</td></tr>
                        <tr><td>version</td><td class="suite-table-mono">${escapeHtml(summary.version || '?')}</td></tr>
                        <tr><td>uptime</td><td class="suite-table-mono suite-muted">${escapeHtml(summary.uptime || '?')}</td></tr>
                        <tr><td>targets</td><td>${targetsUp}/${targetsTotal} up</td></tr>
                        <tr><td>alerts firing</td><td>${alertsFiring > 0 ? `<span class="suite-badge danger">${alertsFiring}</span>` : '<span class="suite-badge success">0</span>'}</td></tr>
                        <tr><td>API URL</td><td class="suite-table-mono suite-muted">http://127.0.0.1:9095</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Prometheus Web UI</h3>
                <a class="suite-btn suite-btn-ghost" href="http://127.0.0.1:9095" target="_blank" rel="noopener noreferrer">↗ Open in new tab</a>
            </div>
            <div class="suite-card-body">
                <iframe class="monitoring-iframe" src="http://127.0.0.1:9095" title="Prometheus Web UI"></iframe>
            </div>
        </div>
    `;
}

// ── Grafana tab ─────────────────────────────────────────────────────

function renderGrafanaTab(summary) {
    if (!summary.installed) {
        return renderInstallHint('Grafana', 'grafana-server', 'grafana-server.service', [
            '# Arch (AUR):',
            'yay -S grafana',
            '# Debian/Ubuntu:',
            'sudo apt install -y adduser libfontconfig1',
            'wget https://dl.grafana.com/oss/release/grafana_latest_amd64.deb',
            'sudo dpkg -i grafana_latest_amd64.deb',
            '# Fedora/RHEL:',
            'sudo dnf install grafana',
        ], '3000');
    }
    const status = summary.status || 'unknown';
    const statusBadge = `<span class="suite-badge ${status === 'running' ? 'success' : 'danger'}">${escapeHtml(status)}</span>`;
    const dashboards = summary.dashboardsCount || 0;
    const datasources = summary.datasourcesCount || 0;
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Grafana Status</h3>
                <div>
                    <button class="suite-btn suite-btn-ghost btn-graf-refresh">↻ Refresh</button>
                    <button class="suite-btn suite-btn-ghost btn-graf-reload">↻ Reload Provisioning</button>
                    <button class="suite-btn btn-graf-restart">↻ Restart</button>
                </div>
            </div>
            <div class="suite-card-body">
                <table class="suite-table">
                    <tbody>
                        <tr><td>status</td><td>${statusBadge}</td></tr>
                        <tr><td>version</td><td class="suite-table-mono">${escapeHtml(summary.version || '?')}</td></tr>
                        <tr><td>dashboards</td><td>${dashboards}</td></tr>
                        <tr><td>datasources</td><td>${datasources}</td></tr>
                        <tr><td>URL</td><td class="suite-table-mono suite-muted">http://127.0.0.1:3000</td></tr>
                        <tr><td>default login</td><td class="suite-table-mono suite-muted">admin / admin (change immediately)</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Grafana Web UI</h3>
                <a class="suite-btn suite-btn-ghost" href="http://127.0.0.1:3000" target="_blank" rel="noopener noreferrer">↗ Open in new tab</a>
            </div>
            <div class="suite-card-body">
                <iframe class="monitoring-iframe" src="http://127.0.0.1:3000" title="Grafana Web UI"></iframe>
            </div>
        </div>
    `;
}

// ── Shared install hint (shown when service is not installed) ───────

function renderInstallHint(name, binary, service, commands, port) {
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">${escapeHtml(name)} — Not Installed</h3>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted">
                    <code>${escapeHtml(binary)}</code> is not installed.
                    Install it to enable the ${escapeHtml(name)} tab:
                </p>
                <pre class="suite-mono" style="margin-top:0.5rem;background:#1a1a1a;padding:8px;border-radius:4px;font-size:0.85rem">${commands.map(escapeHtml).join('\n')}</pre>
                <p class="suite-muted" style="margin-top:0.5rem;font-size:0.85rem">
                    After install, enable + start the service:
                </p>
                <pre class="suite-mono" style="margin-top:0.5rem;background:#1a1a1a;padding:8px;border-radius:4px;font-size:0.85rem">sudo systemctl enable --now ${escapeHtml(service)}</pre>
                <p class="suite-muted" style="margin-top:0.5rem;font-size:0.85rem">
                    The web UI will be available at <code>http://127.0.0.1:${escapeHtml(port)}</code>
                    and will appear in the iframe below once the service is running.
                </p>
            </div>
        </div>
    `;
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }) {
    const output = (msg, isError = false) => {
        const card = panel.querySelector('#monitoring-output');
        const pre = panel.querySelector('#monitoring-output-pre');
        if (!card || !pre) return;
        card.style.display = 'block';
        pre.textContent = msg;
        pre.style.color = isError ? 'var(--sysdeck-accent-danger)' : 'var(--sysdeck-fg)';
    };
    panel.querySelector('#btn-monitoring-output-close')?.addEventListener('click', () => {
        const card = panel.querySelector('#monitoring-output');
        if (card) card.style.display = 'none';
    });

    // Tab switching.
    panel.querySelectorAll('.monitoring-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            panel.querySelectorAll('.monitoring-tab').forEach((t) => t.classList.remove('active'));
            panel.querySelectorAll('.monitoring-tab-panel').forEach((p) => p.classList.remove('active'));
            tab.classList.add('active');
            const target = tab.dataset.tab;
            panel.querySelector(`#tab-${target}`)?.classList.add('active');
        });
    });

    // Prometheus controls.
    panel.querySelector('.btn-prom-refresh')?.addEventListener('click', () => mount(panel, { bridge, EventBus }));
    panel.querySelector('.btn-prom-reload')?.addEventListener('click', async () => {
        output('Reloading Prometheus config (SIGHUP) ... (cockpit will prompt for auth)');
        try {
            const r = await bridge.prometheus.reload();
            output(r.result === 'ok'
                ? 'Prometheus config reloaded.'
                : `Reload FAILED: ${r.stderr || r.message || JSON.stringify(r)}`,
                r.result !== 'ok');
        } catch (err) { output(`Reload error: ${err.message || err}`, true); }
    });
    panel.querySelector('.btn-prom-restart')?.addEventListener('click', async () => {
        output('Restarting Prometheus ... (cockpit will prompt for auth)');
        try {
            const r = await bridge.prometheus.restart();
            output(r.result === 'ok'
                ? 'Prometheus restarted.'
                : `Restart FAILED: ${r.stderr || r.message || JSON.stringify(r)}`,
                r.result !== 'ok');
            if (r.result === 'ok') setTimeout(() => mount(panel, { bridge, EventBus }), 2000);
        } catch (err) { output(`Restart error: ${err.message || err}`, true); }
    });

    // Grafana controls.
    panel.querySelector('.btn-graf-refresh')?.addEventListener('click', () => mount(panel, { bridge, EventBus }));
    panel.querySelector('.btn-graf-reload')?.addEventListener('click', async () => {
        output('Reloading Grafana provisioning (SIGUSR2) ... (cockpit will prompt for auth)');
        try {
            const r = await bridge.grafana.reload();
            output(r.result === 'ok'
                ? 'Grafana provisioning reloaded.'
                : `Reload FAILED: ${r.stderr || r.message || JSON.stringify(r)}`,
                r.result !== 'ok');
        } catch (err) { output(`Reload error: ${err.message || err}`, true); }
    });
    panel.querySelector('.btn-graf-restart')?.addEventListener('click', async () => {
        output('Restarting Grafana ... (cockpit will prompt for auth)');
        try {
            const r = await bridge.grafana.restart();
            output(r.result === 'ok'
                ? 'Grafana restarted.'
                : `Restart FAILED: ${r.stderr || r.message || JSON.stringify(r)}`,
                r.result !== 'ok');
            if (r.result === 'ok') setTimeout(() => mount(panel, { bridge, EventBus }), 2000);
        } catch (err) { output(`Restart error: ${err.message || err}`, true); }
    });
}

// ── Utilities ───────────────────────────────────────────────────────

async function safe(p, fallback) {
    try {
        const v = await p;
        return v ?? fallback;
    } catch {
        return fallback;
    }
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderSkeleton() {
    return `<div class="suite-skeleton">
        <div class="suite-skeleton-line w-1/3"></div>
        <div class="suite-skeleton-line w-2/3"></div>
        <div class="suite-skeleton-line w-1/2"></div>
    </div>`;
}
