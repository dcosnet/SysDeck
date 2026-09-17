/*
 * SysDeck - Containers Panel (v0.0.35)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * Podman container management panel. The Kata portion of the
 * former merged "Containers & VMs" module is now its own sidebar
 * entry — `SysDeck Kata` (plugins/sysdeck-kata/) — per the v0.0.35
 * user directive: "kata containers should be called SysDeck Kata and
 * moved out of the tools area."
 *
 * One module, one concern: this panel manages Podman containers
 * only; the SysDeck Kata plugin owns Kata sandboxes & VMs.
 *
 * Bridge surface (see shared/bridge.js → bridge.containers):
 *   list()                    → podman ps --format json (normalized)
 *   inspect(id)               → podman inspect <id>
 *   action(id, action)        → podman stop|restart|rm <id>
 *   count()                   → derived from list()
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderShell();
    await renderPodmanTable(panel, { bridge, EventBus });
    EventBus.emit('containers.loaded', {});
}

// ── Shell ──────────────────────────────────────────────────────────

function renderShell() {
    return `
        <header>
            <h2 class="suite-panel-title">Containers</h2>
            <p class="suite-panel-subtitle">Podman runtime — list, inspect, stop / restart / remove</p>
        </header>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title" id="containers-summary">Loading containers…</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-containers-refresh">↻ Refresh</button>
            </div>
            <div id="containers-flash" class="suite-badge danger" style="display:none; margin-bottom:0.5rem; padding:0.4rem 0.6rem;"></div>
            <div id="containers-table-host"></div>
        </div>
        <div class="suite-card">
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem">
                    Kata Containers (hardware-virtualized OCI sandboxes) lives in its
                    own sidebar entry — <strong>SysDeck Kata</strong> — real sandbox
                    and VM state from the host, not a bundle mock.
                </p>
            </div>
        </div>
    `;
}

async function renderPodmanTable(panel, { bridge, EventBus }) {
    const host = panel.querySelector('#containers-table-host');
    const summary = panel.querySelector('#containers-summary');
    if (!host || !summary) return;
    host.innerHTML = `<div class="suite-skeleton"><div class="suite-skeleton-line w-1/3"></div></div>`;

    let containers = [];
    try {
        containers = await bridge.containers.list();
    } catch (err) {
        summary.textContent = 'Podman unavailable';
        host.innerHTML = renderPodmanError(err);
        return;
    }
    summary.textContent = `Podman runtime — ${containers.length} container${containers.length === 1 ? '' : 's'}`;
    host.innerHTML = `
        <table class="suite-table">
            <thead>
                <tr><th>ID</th><th>Name</th><th>Image</th><th>Status</th><th>Ports</th><th>Actions</th></tr>
            </thead>
            <tbody>
                ${containers.map(renderPodmanRow).join('') || '<tr><td colspan="6" class="suite-muted">No containers. Run `podman run -d --name hello alpine sleep 9999` to create one.</td></tr>'}
            </tbody>
        </table>
    `;

    host.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const action = btn.dataset.action;
            btn.disabled = true;
            try {
                await bridge.containers.action(id, action);
                EventBus.emit('container.action', { id, action });
            } catch (err) {
                EventBus.emit('container.error', { id, error: err.message });
                // the operator sees the failure where they clicked it —
                // the table re-render alone would silently swallow it
                const flash = panel.querySelector('#containers-flash');
                if (flash) {
                    flash.textContent = `action failed: ${err.message || err}`;
                    flash.style.display = 'inline-block';
                    clearTimeout(panel._containersFlashTimer);
                    panel._containersFlashTimer = setTimeout(() => { flash.style.display = 'none'; }, 4000);
                }
            }
            renderPodmanTable(panel, { bridge, EventBus });
        });
    });
}

function renderPodmanRow(c) {
    const statusClass = (c.status || '').startsWith('Up') ? 'success' : 'warn';
    const id = (c.id || '').substring(0, 12);
    const name = c.name || '—';
    const image = c.image || '—';
    const status = c.status || '—';
    const ports = c.ports || '—';
    return `
        <tr>
            <td class="suite-table-mono">${escapeHtml(id)}</td>
            <td>${escapeHtml(name)}</td>
            <td class="suite-table-mono">${escapeHtml(image)}</td>
            <td><span class="suite-badge ${statusClass}">${escapeHtml(status)}</span></td>
            <td class="suite-table-mono suite-muted">${escapeHtml(ports)}</td>
            <td>
                <button class="suite-btn suite-btn-ghost" data-id="${escapeHtml(c.id)}" data-action="stop">stop</button>
                <button class="suite-btn suite-btn-ghost" data-id="${escapeHtml(c.id)}" data-action="restart">restart</button>
                <button class="suite-btn suite-btn-ghost" data-id="${escapeHtml(c.id)}" data-action="rm">rm</button>
            </td>
        </tr>
    `;
}

function renderPodmanError(err) {
    return `<div class="suite-card">
        <h3 class="suite-card-title">Podman unavailable</h3>
        <p class="suite-card-body suite-muted">${escapeHtml(err.message || String(err))}. Install podman to manage containers from this panel.</p>
        <p class="suite-muted">Arch: <code>pacman -S podman</code> · Debian: <code>apt install podman</code> · Fedora: <code>dnf install podman</code></p>
    </div>`;
}

// ── Utilities ───────────────────────────────────────────────────────

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
