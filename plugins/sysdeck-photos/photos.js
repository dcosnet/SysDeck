/*
 * SysDeck - Photos Panel (v0.0.35)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * v0.0.35 directive: "as well as a photo manager of equal quality.
 * with its own module." Following the Jellyfin pattern: each
 * supported backend ships as a systemd service with a built-in admin
 * web UI; the bridge starts/stops/restarts the service via systemctl
 * and the panel iframes the running admin UI. Equal quality means
 * the same service-control + iframe-load shape as Jellyfin.
 *
 * Multi-backend design — same shape as the DB Control module
 * (plugins/sysdeck-db/db.js): the operator chooses the backend
 * installed on the host; the bridge auto-detects each backend via
 * CLI availability and/or systemd unit presence.
 *
 * Supported backends (see bridge/photos.py BACKEND_REGISTRY):
 *   PhotoPrism         — single Go binary · MIT · port 2342
 *   Piwigo             — single PHP-FPM app · GPL-2.0 · port 80
 *   Lychee             — single PHP-FPM app · MIT · port 80
 *   Nextcloud Memories — Nextcloud plugin · AGPL-3.0 · port 80
 *   LibrePhotos        — Django + React · MIT · port 3000
 *
 * Excluded (intentionally): NFS-mounted photo libraries (no admin
 * panel — use the Remote FS module for storage management), Amanda
 * (backup system, not a photo manager), Google Photos / iCloud /
 * etc. (cloud-only, no on-host admin panel reachable).
 *
 * Bridge surface (see shared/bridge.js → bridge.photos):
 *   summary()              → {backends, totalBackends, installedCount, runningCount}
 *   status(id)             → single-backend detail dict
 *   start(id)              → {action, rc, success, output, stderr}
 *   stop(id)               → same shape
 *   restart(id)            → same shape
 *   webStatus(id)          → {running, url, port, ...}
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    let summary = {};
    try {
        summary = await bridge.photos.summary();
    } catch (err) {
        panel.innerHTML = renderError(err);
        return;
    }

    const backends = summary.backends || [];
    const installed = backends.filter((b) => b.status !== 'uninstalled');
    const running = backends.filter((b) => b.status === 'running');

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Photo Manager</h2>
            <p class="suite-panel-subtitle">
                Self-hosted photo & album management · multi-backend
                · ${summary.totalBackends || backends.length} supported
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
                <div class="suite-stat-label">${running.length ? 'admin UIs live' : 'all stopped'}</div>
            </div>
        </div>

        ${renderBackendsGrid(backends, { bridge, EventBus })}

        <div class="suite-card">
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem">
                    The bridge runs <code>systemctl start/stop/restart</code> for
                    the chosen backend via the cockpit superuser channel (polkit
                    <code>org.sysdeck.photos.modify</code>). The admin UI loads in
                    an iframe once the service is running. Each backend is a
                    separate process — no third-party code is bundled in the suite.
                </p>
            </div>
        </div>
    `;

    wireEvents(panel, { bridge, EventBus });
    EventBus.emit('photos.loaded', { installed: installed.length, running: running.length });
}

// ── Backend cards ──────────────────────────────────────────────────

function renderBackendsGrid(backends, { bridge, EventBus }) {
    if (!backends.length) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Backends (0)</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">No photo backends registered.</p>
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
                    <button class="suite-btn ${running ? '' : 'suite-btn-primary'} btn-photos-start" data-id="${escapeHtml(b.id)}" ${running ? 'disabled' : ''}>▶ Start</button>
                    <button class="suite-btn btn-photos-stop" data-id="${escapeHtml(b.id)}" ${!running ? 'disabled' : ''}>■ Stop</button>
                    <button class="suite-btn btn-photos-restart" data-id="${escapeHtml(b.id)}" ${!running ? 'disabled' : ''}>↻ Restart</button>
                    <button class="suite-btn suite-btn-ghost btn-photos-refresh" data-id="${escapeHtml(b.id)}">↻</button>
                </div>
            </div>
            <div class="suite-card-body">
                <table class="suite-table">
                    <tbody>
                        <tr><th>Status</th><td>${statusBadge(b.status)}</td></tr>
                        <tr><th>Service</th><td class="suite-table-mono">${escapeHtml(b.serviceUnit || '—')}</td></tr>
                        <tr><th>Port</th><td class="suite-table-mono">${b.port}</td></tr>
                        <tr><th>URL</th><td class="suite-table-mono">${running ? `<a href="${escapeHtml(b.url)}" target="_blank" style="color:var(--sysdeck-accent)">${escapeHtml(b.url)}</a>` : '— (service stopped)'}</td></tr>
                        <tr><th>License</th><td class="suite-muted">${escapeHtml(b.license)} · <a href="${escapeHtml(b.homepage)}" target="_blank" style="color:var(--sysdeck-accent)">${escapeHtml(b.homepage)}</a></td></tr>
                    </tbody>
                </table>
                ${running ? renderWebIframe(b) : `<p class="suite-muted" style="font-size:0.85rem;margin-top:0.5rem">Click <strong>▶ Start</strong> to launch ${escapeHtml(b.name)}. The admin UI will load in an iframe below.</p>`}
            </div>
        </div>
    `;
}

function renderWebIframe(b) {
    return `
        <div style="margin-top:1rem">
            <iframe src="${escapeHtml(b.url)}"
                    style="width:100%;height:600px;border:1px solid var(--sysdeck-border);border-radius:6px;background:#1e1e1e;"
                    id="photos-iframe-${escapeHtml(b.id)}"
                    title="${escapeHtml(b.name)} Admin Panel"
                    allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                    allowfullscreen></iframe>
        </div>
    `;
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }) {
    const action = async (btn, method, label) => {
        const id = btn.dataset.id;
        if (!id) return;
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = `${label} ...`;
        try {
            const r = await bridge.photos[method](id);
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

    panel.querySelectorAll('.btn-photos-start').forEach((btn) => {
        btn.addEventListener('click', (ev) => action(ev.currentTarget, 'start', 'Start'));
    });
    panel.querySelectorAll('.btn-photos-stop').forEach((btn) => {
        btn.addEventListener('click', (ev) => action(ev.currentTarget, 'stop', 'Stop'));
    });
    panel.querySelectorAll('.btn-photos-restart').forEach((btn) => {
        btn.addEventListener('click', (ev) => action(ev.currentTarget, 'restart', 'Restart'));
    });
    panel.querySelectorAll('.btn-photos-refresh').forEach((btn) => {
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
        <h3 class="suite-card-title">Photos bridge unavailable</h3>
        <p class="suite-card-body suite-muted">${err.message || err}. Ensure the bridge helper is installed at /usr/lib/sysdeck/bridge/photos.py.</p>
    </div>`;
}
