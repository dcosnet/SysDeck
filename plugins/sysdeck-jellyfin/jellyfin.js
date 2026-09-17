/*
 * SysDeck - Jellyfin Panel (v0.0.35)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * v0.0.35 directive: "next we will integrate a jellyfin management
 * module where it starts, stops, and loads the admin panel in the
 * module." Jellyfin ships a single systemd unit (jellyfin.service)
 * and serves a full admin web UI on http://127.0.0.1:8096. The
 * bridge starts/stops/restarts the service via systemctl; the panel
 * iframes the running admin UI — same pattern as the v0.0.34 Glances
 * integration.
 *
 * The panel surfaces:
 *   - Service summary card: status badge, version, port, uptime
 *   - Service controls: Start / Stop / Restart (polkit prompts)
 *   - Admin UI iframe: loads http://127.0.0.1:8096 when running
 *   - Library list: best-effort GET /Library/VirtualFolders
 *   - Install hint when jellyfin is not installed
 *
 * Jellyfin is GPL-2.0 licensed by the Jellyfin contributors. The
 * bridge helper invokes it as a separate process via subprocess —
 * the suite (MIT) and Jellyfin (GPL-2.0) remain independent
 * programs. No Jellyfin code is bundled.
 *
 * Bridge surface (see shared/bridge.js → bridge.jellyfin):
 *   summary()              → {available, status, version, port, url, ...}
 *   status()               → service state dict
 *   start()                → {action, rc, success, output, stderr}
 *   stop()                 → same shape
 *   restart()              → same shape
 *   webStatus()            → {running, url, port, ...}
 *   libraries()            → {libraries: [...], count: N}
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    const [summary, webStatus, libraries] = await Promise.all([
        safe(bridge.jellyfin.summary(), {}),
        safe(bridge.jellyfin.webStatus(), {}),
        safe(bridge.jellyfin.libraries(), { libraries: [], count: 0 }),
    ]);

    const running = webStatus?.running === true || summary?.status === 'running';
    const available = webStatus?.available !== false && summary?.available !== false;
    const webUrl = webStatus?.url || summary?.url || 'http://127.0.0.1:8096';

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Jellyfin Media Server</h2>
            <p class="suite-panel-subtitle">
                Self-hosted media streaming · movies · TV · music
                · <span class="suite-badge info">GPL-2.0 · Jellyfin contributors</span>
                ${available
                    ? (running
                        ? ` · <span class="suite-badge success">running</span>`
                        : ` · <span class="suite-badge">stopped</span>`)
                    : ` · <span class="suite-badge danger">not installed</span>`}
            </p>
        </header>

        ${renderServiceCard(summary, available, running, webUrl)}

        ${available && running ? renderWebIframe(webUrl) : ''}

        ${available ? renderLibrariesCard(libraries) : ''}
    `;

    wireEvents(panel, { bridge, EventBus });
    EventBus.emit('jellyfin.loaded', { running, available });
}

// ── Service card ────────────────────────────────────────────────────

function renderServiceCard(summary, available, running, webUrl) {
    if (!available) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Jellyfin Service</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">
                        ${escapeHtml(summary?.reason || 'Jellyfin is not installed.')}
                    </p>
                    ${summary?.install
                        ? `<p class="suite-muted" style="margin-top:0.5rem"><code>${escapeHtml(summary.install)}</code></p>`
                        : ''}
                    <p class="suite-muted" style="margin-top:0.5rem">
                        Jellyfin is GPL-2.0 licensed by the Jellyfin contributors —
                        <a href="https://jellyfin.org/" style="color:var(--sysdeck-accent)">https://jellyfin.org/</a>
                    </p>
                </div>
            </div>
        `;
    }

    const uptime = formatUptime(summary?.uptime_seconds || 0);
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Service — <code>${escapeHtml(summary?.service || 'jellyfin.service')}</code></h3>
                <div class="suite-row" style="gap:0.5rem">
                    <button class="suite-btn ${running ? '' : 'suite-btn-primary'}" id="btn-jellyfin-start" ${running ? 'disabled' : ''}>▶ Start</button>
                    <button class="suite-btn" id="btn-jellyfin-stop" ${!running ? 'disabled' : ''}>■ Stop</button>
                    <button class="suite-btn" id="btn-jellyfin-restart" ${!running ? 'disabled' : ''}>↻ Restart</button>
                    <button class="suite-btn suite-btn-ghost" id="btn-jellyfin-refresh">↻ Refresh</button>
                </div>
            </div>
            <div class="suite-card-body">
                <table class="suite-table">
                    <tbody>
                        <tr><th>Status</th><td>${statusBadge(summary?.status)}</td></tr>
                        <tr><th>ActiveState</th><td class="suite-table-mono">${escapeHtml(summary?.active || '—')}</td></tr>
                        <tr><th>SubState</th><td class="suite-table-mono">${escapeHtml(summary?.sub || '—')}</td></tr>
                        <tr><th>Uptime</th><td class="suite-muted">${running ? escapeHtml(uptime) : '—'}</td></tr>
                        <tr><th>Version</th><td class="suite-muted">${escapeHtml(summary?.version || '—')}</td></tr>
                        <tr><th>Port</th><td class="suite-table-mono">${summary?.port || 8096}</td></tr>
                        <tr><th>URL</th><td class="suite-table-mono"><a href="${escapeHtml(webUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--sysdeck-accent)">${escapeHtml(webUrl)}</a></td></tr>
                    </tbody>
                </table>
                <p class="suite-muted" style="font-size:0.85rem;margin-top:0.5rem">
                    The bridge runs <code>systemctl start/stop/restart jellyfin.service</code>
                    via the cockpit superuser channel (polkit <code>org.sysdeck.jellyfin.modify</code>).
                </p>
            </div>
        </div>
    `;
}

function renderWebIframe(webUrl) {
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Admin Panel — ${escapeHtml(webUrl)}</h3>
                <a href="${escapeHtml(webUrl)}" target="_blank" rel="noopener noreferrer" class="suite-btn suite-btn-ghost">↗ Open in new tab</a>
            </div>
            <iframe src="${escapeHtml(webUrl)}"
                    style="width:100%;height:800px;border:1px solid var(--sysdeck-border);border-radius:6px;background:#1e1e1e;"
                    id="jellyfin-iframe"
                    title="Jellyfin Admin Panel"
                    allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                    allowfullscreen></iframe>
        </div>
    `;
}

function renderLibrariesCard(libraries) {
    const libs = libraries?.libraries || [];
    if (libraries?.error) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Libraries</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">${escapeHtml(libraries.error)}</p>
                </div>
            </div>
        `;
    }
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Libraries (${libraries?.count || 0})</h3>
            </div>
            <table class="suite-table">
                <thead><tr><th>Name</th><th>Type</th><th>Paths</th></tr></thead>
                <tbody>
                    ${libs.map((lib) => `
                        <tr>
                            <td><strong>${escapeHtml(lib.name)}</strong></td>
                            <td class="suite-table-mono">${escapeHtml(lib.type || 'mixed')}</td>
                            <td class="suite-muted suite-table-mono">${escapeHtml((lib.paths || []).join(' · ') || '—')}</td>
                        </tr>
                    `).join('') || '<tr><td colspan="3" class="suite-muted">No libraries configured. Open the admin panel above to add media folders.</td></tr>'}
                </tbody>
            </table>
        </div>
    `;
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }) {
    const action = async (btn, method, label) => {
        if (!btn) return;
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = `${label} ...`;
        try {
            const r = await bridge.jellyfin[method]();
            if (!r?.success && method !== 'restart') {
                alert(`${label} failed:\n${r?.stderr || r?.output || 'unknown'}`);
            }
            setTimeout(() => mount(panel, { bridge, EventBus }), 1000);
        } catch (err) {
            btn.disabled = false;
            btn.textContent = original;
            alert(`${label} error: ${err.message || err}`);
        }
    };

    panel.querySelector('#btn-jellyfin-start')?.addEventListener('click', (ev) => action(ev.currentTarget, 'start', 'Start'));
    panel.querySelector('#btn-jellyfin-stop')?.addEventListener('click', (ev) => action(ev.currentTarget, 'stop', 'Stop'));
    panel.querySelector('#btn-jellyfin-restart')?.addEventListener('click', (ev) => action(ev.currentTarget, 'restart', 'Restart'));
    panel.querySelector('#btn-jellyfin-refresh')?.addEventListener('click', () => {
        mount(panel, { bridge, EventBus });
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

function statusBadge(status) {
    const map = {
        'running':  '<span class="suite-badge success">running</span>',
        'starting': '<span class="suite-badge warn">starting</span>',
        'stopped':  '<span class="suite-badge">stopped</span>',
        'error':    '<span class="suite-badge danger">error</span>',
        'unknown':  '<span class="suite-badge">unknown</span>',
    };
    return map[status] || `<span class="suite-badge">${escapeHtml(status || 'unknown')}</span>`;
}

function formatUptime(seconds) {
    if (!seconds || seconds <= 0) return '—';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
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
