/*
 * SysDeck - Remote FS Panel (v0.0.35)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * v0.0.35 directive: "then a remote fs manager such as ceph, and
 * others but not nfs or amanada fs." Manages remote / distributed
 * filesystem backends as systemd services and surfaces cluster
 * status from each backend's CLI tool. Each backend card has
 * Start / Stop / Restart controls + a cluster-info viewer.
 *
 * Backends shipped (see bridge/remotefs.py BACKEND_REGISTRY):
 *   Ceph        — distributed object storage · LGPL-2.1
 *   GlusterFS   — scale-out network filesystem · GPL-2.0
 *   MooseFS     — distributed fault-tolerant FS · GPL-2.0
 *   BeeGFS      — parallel cluster filesystem · BeeGFS EULA (free)
 *   OrangeFS    — parallel FS (PVFS2 successor) · BSD-3
 *
 * EXCLUDED per directive — documented in the panel footer:
 *   NFS    — kernel-builtin; no cluster; no remote-FS-as-data-store
 *   Amanda — backup system, not a remote/distributed filesystem
 *
 * Bridge surface (see shared/bridge.js → bridge.remotefs):
 *   summary()              → {backends, totalBackends, installedCount, runningCount, excluded}
 *   status(id)             → single-backend detail dict
 *   start(id)              → {action, rc, success, output, stderr}
 *   stop(id)               → same shape
 *   restart(id)            → same shape
 *   clusterInfo(id)        → backend-specific cluster status
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    let summary = {};
    try {
        summary = await bridge.remotefs.summary();
    } catch (err) {
        panel.innerHTML = renderError(err);
        return;
    }

    const backends = summary.backends || [];
    const installed = backends.filter((b) => b.status !== 'uninstalled');
    const running = backends.filter((b) => b.status === 'running');

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Remote Filesystems</h2>
            <p class="suite-panel-subtitle">
                Distributed & cluster filesystem management
                · ${summary.totalBackends || backends.length} backends supported
                · ${summary.installedCount || installed.length} installed
                · ${summary.runningCount || running.length} running
            </p>
        </header>

        <div class="suite-row">
            <div class="suite-card suite-col-3">
                <h3 class="suite-card-title">Backends</h3>
                <div class="suite-stat-value">${summary.totalBackends || backends.length}</div>
                <div class="suite-stat-label">total supported</div>
            </div>
            <div class="suite-card suite-col-3">
                <h3 class="suite-card-title">Installed</h3>
                <div class="suite-stat-value ${installed.length ? 'suite-warn' : ''}">${installed.length}</div>
                <div class="suite-stat-label">${installed.length ? 'detected on host' : 'none — install one'}</div>
            </div>
            <div class="suite-card suite-col-3">
                <h3 class="suite-card-title">Running</h3>
                <div class="suite-stat-value ${running.length ? 'suite-warn' : ''}">${running.length}</div>
                <div class="suite-stat-label">${running.length ? 'clusters live' : 'all stopped'}</div>
            </div>
        </div>

        ${renderBackendsGrid(backends, { bridge, EventBus })}

        ${renderExcludedCard(summary.excluded)}

        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Cluster Info</h3>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem">
                    Click <strong>🔍 Cluster Info</strong> on a backend card above to
                    query its cluster status (<code>ceph status --format=json</code>,
                    <code>gluster pool list</code>, <code>moosefs-cli info</code>,
                    <code>beegfs-ctl --listnodes</code>, or
                    <code>pvfs2-server -m</code>). The output renders below.
                </p>
            </div>
            <pre class="suite-mono" id="remotefs-cluster-output" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:500px;min-height:60px;color:var(--sysdeck-muted)">(no cluster info requested yet)</pre>
        </div>
    `;

    wireEvents(panel, { bridge, EventBus });
    EventBus.emit('remotefs.loaded', { installed: installed.length, running: running.length });
}

// ── Backend cards ──────────────────────────────────────────────────

function renderBackendsGrid(backends, { bridge, EventBus }) {
    if (!backends.length) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Backends (0)</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">No remote FS backends registered.</p>
                </div>
            </div>
        `;
    }
    return backends.map((b) => renderBackendCard(b)).join('');
}

function renderBackendCard(b) {
    if (b.status === 'uninstalled') {
        return `
            <div class="suite-card">
                <div class="suite-card-header">
                    <h3 class="suite-card-title">${escapeHtml(b.name)} <span class="suite-muted" style="font-size:0.85rem">· ${escapeHtml(b.id)}</span></h3>
                    <span class="suite-badge">${escapeHtml(b.family)}</span>
                </div>
                <div class="suite-card-body">
                    <p class="suite-muted" style="font-size:0.85rem">
                        Not installed. ${escapeHtml(b.name)} is <strong>${escapeHtml(b.license)}</strong>
                        licensed — <a href="${escapeHtml(b.homepage)}" target="_blank" style="color:var(--sysdeck-accent)">${escapeHtml(b.homepage)}</a>
                    </p>
                    <p class="suite-muted suite-mono" style="margin-top:0.5rem;font-size:0.8rem">${escapeHtml(b.installHint)}</p>
                </div>
            </div>
        `;
    }

    const running = b.status === 'running';
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">${escapeHtml(b.name)} <span class="suite-muted" style="font-size:0.85rem">· ${escapeHtml(b.id)}</span></h3>
                <div class="suite-row" style="gap:0.5rem">
                    <button class="suite-btn ${running ? '' : 'suite-btn-primary'} btn-remotefs-start" data-id="${escapeHtml(b.id)}" ${running ? 'disabled' : ''}>▶ Start</button>
                    <button class="suite-btn btn-remotefs-stop" data-id="${escapeHtml(b.id)}" ${!running ? 'disabled' : ''}>■ Stop</button>
                    <button class="suite-btn btn-remotefs-restart" data-id="${escapeHtml(b.id)}" ${!running ? 'disabled' : ''}>↻ Restart</button>
                    <button class="suite-btn suite-btn-ghost btn-remotefs-cluster" data-id="${escapeHtml(b.id)}">🔍 Cluster Info</button>
                    <button class="suite-btn suite-btn-ghost btn-remotefs-refresh" data-id="${escapeHtml(b.id)}">↻</button>
                </div>
            </div>
            <div class="suite-card-body">
                <table class="suite-table">
                    <tbody>
                        <tr><th>Status</th><td>${statusBadge(b.status)}</td></tr>
                        <tr><th>Service</th><td class="suite-table-mono">${escapeHtml(b.serviceUnit || '—')}</td></tr>
                        <tr><th>CLI tool</th><td class="suite-table-mono">${escapeHtml(b.cli || '—')}</td></tr>
                        <tr><th>Default port</th><td class="suite-table-mono">${b.port}</td></tr>
                        <tr><th>Config</th><td class="suite-muted suite-table-mono">${escapeHtml(b.configPath || '—')}</td></tr>
                        <tr><th>License</th><td class="suite-muted">${escapeHtml(b.license)} · <a href="${escapeHtml(b.homepage)}" target="_blank" style="color:var(--sysdeck-accent)">${escapeHtml(b.homepage)}</a></td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function renderExcludedCard(excluded) {
    if (!excluded || !Object.keys(excluded).length) return '';
    const rows = Object.entries(excluded).map(([name, reason]) => `
        <tr>
            <td class="suite-table-mono"><strong>${escapeHtml(name)}</strong></td>
            <td class="suite-muted">${escapeHtml(reason)}</td>
        </tr>
    `).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Intentionally excluded</h3>
                <span class="suite-badge info">per directive</span>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem;margin-bottom:0.5rem">
                    Per v0.0.35 directive: "and others but not nfs or amanada fs."
                    The following backends are intentionally excluded from this module:
                </p>
                <table class="suite-table">
                    <thead><tr><th>Backend</th><th>Reason</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `;
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }) {
    const output = panel.querySelector('#remotefs-cluster-output');
    const showCluster = (title, text, isError = false) => {
        if (!output) return;
        output.textContent = `${title}\n\n${text}`;
        output.style.color = isError ? 'var(--sysdeck-accent-danger)' : 'var(--sysdeck-fg)';
    };

    const action = async (btn, method, label) => {
        const id = btn.dataset.id;
        if (!id) return;
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = `${label} ...`;
        try {
            const r = await bridge.remotefs[method](id);
            if (r?.error) {
                alert(`${label} ${id} failed:\n${r.error}`);
            } else if (!r?.success && method !== 'restart') {
                alert(`${label} ${id} failed:\n${r?.stderr || r?.output || 'unknown'}`);
            }
            setTimeout(() => mount(panel, { bridge, EventBus }), 1000);
        } catch (err) {
            btn.disabled = false;
            btn.textContent = original;
            alert(`${label} ${id} error: ${err.message || err}`);
        }
    };

    panel.querySelectorAll('.btn-remotefs-start').forEach((btn) => {
        btn.addEventListener('click', (ev) => action(ev.currentTarget, 'start', 'Start'));
    });
    panel.querySelectorAll('.btn-remotefs-stop').forEach((btn) => {
        btn.addEventListener('click', (ev) => action(ev.currentTarget, 'stop', 'Stop'));
    });
    panel.querySelectorAll('.btn-remotefs-restart').forEach((btn) => {
        btn.addEventListener('click', (ev) => action(ev.currentTarget, 'restart', 'Restart'));
    });
    panel.querySelectorAll('.btn-remotefs-cluster').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
            const id = ev.currentTarget.dataset.id;
            if (!id) return;
            showCluster(`Cluster Info: ${id}`, 'Loading ...');
            try {
                const r = await bridge.remotefs.clusterInfo(id);
                if (r.error) {
                    showCluster(`Cluster Info: ${id} — error`, r.error, true);
                    return;
                }
                if (r.summary) {
                    showCluster(`Cluster Info: ${id} (parsed)`,
                        JSON.stringify(r.summary, null, 2) + '\n\n--- raw ---\n' + (r.rawText || ''));
                } else {
                    showCluster(`Cluster Info: ${id} (raw)`, r.rawText || JSON.stringify(r, null, 2));
                }
            } catch (err) {
                showCluster(`Cluster Info: ${id} — error`, String(err.message || err), true);
            }
        });
    });
    panel.querySelectorAll('.btn-remotefs-refresh').forEach((btn) => {
        btn.addEventListener('click', () => {
            mount(panel, { bridge, EventBus });
        });
    });
}

// ── Utilities ───────────────────────────────────────────────────────

function statusBadge(status) {
    const map = {
        'running':     '<span class="suite-badge success">running</span>',
        'starting':    '<span class="suite-badge warn">starting</span>',
        'stopped':     '<span class="suite-badge">stopped</span>',
        'error':       '<span class="suite-badge danger">error</span>',
        'uninstalled': '<span class="suite-badge">uninstalled</span>',
        'unknown':     '<span class="suite-badge">unknown</span>',
    };
    return map[status] || `<span class="suite-badge">${escapeHtml(status || 'unknown')}</span>`;
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

function renderError(err) {
    return `<div class="suite-card">
        <h3 class="suite-card-title">Remote FS bridge unavailable</h3>
        <p class="suite-card-body suite-muted">${err.message || err}. Ensure the bridge helper is installed at /usr/lib/sysdeck/bridge/remotefs.py.</p>
    </div>`;
}
