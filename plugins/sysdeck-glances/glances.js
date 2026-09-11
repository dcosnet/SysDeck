/*
 * SysDeck - Glances Panel (v0.0.47)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * v0.0.47 — DEFAULT-ON EMBEDDED WEBUI. Per user directive: "the glances
 * we should default to enabling the built in webui and embedding that
 * into our module instead it visually looks stunning in comparison to
 * ours." v0.0.34 added the webui integration but kept it opt-in (the
 * operator had to click "Start Web UI" each time they opened the panel)
 * and rendered the legacy SysDeck snapshot cards above the iframe.
 * v0.0.47 flips the default:
 *
 *   1. AUTO-START: when the panel mounts and glances is installed but
 *      the webserver isn't running, the panel calls
 *      bridge.glances.startWeb() automatically. The operator sees a
 *      "Starting Glances web UI …" stub for <1s, then the full Glances
 *      web UI loads in the iframe. No click required.
 *   2. EMBEDDED-FIRST LAYOUT: the iframe is now the primary view,
 *      sized to fill the viewport (min-height: calc(100vh - 200px)).
 *      The legacy snapshot cards (CPU / Memory / Swap / Network / Disk
 *      / Processes) are moved into a collapsed <details> at the bottom
 *      of the page so they don't push the iframe below the fold. The
 *      operator can still expand them for a quick numeric read, but
 *      the default view is the Glances web UI.
 *   3. STOP ON UNMOUNT (best-effort): when the panel is unmounted
 *      (operator navigates away), we don't stop the webserver — it's
 *      cheap to keep running and the operator may re-open the panel
 *      soon. The existing Stop button is still there for explicit
 *      shutdown. (If we wanted to be aggressive we could stop on
 *      pagehide, but that would slow re-entry.)
 *
 * v0.0.34 INTEGRATES THE GLANCES BUILT-IN WEB UI as a module.
 * The user directive: "glances is not integrated yet i just assumed
 * you would integrate the built in webui as a module." Glances ships
 * a webserver via `glances -w` (default 127.0.0.1:61208) that serves
 * the full Glances web UI — every chart, every sensor, every top
 * process, every history graph. SysDeck starts that webserver as a
 * background process via bridge.glances.startWeb() and iframes the
 * running web UI into this panel. No SysDeck-side reimplementation
 * of the Glances UI.
 *
 * Glances is GPL-3.0 licensed by Nicolargo. The bridge helper invokes
 * it as a separate process via subprocess — the suite (MIT) and
 * Glances (GPL-3.0) remain independent programs. No Glances code is
 * bundled.
 */

// v0.0.47: how long to wait between calling startWeb() and re-checking
// web-status. Glances typically takes <1s on a warm start, but we give
// it a small grace period before re-rendering so the iframe doesn't
// load a half-up webserver.
const WEB_START_POLL_MS = 800;

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    let webStatus = await safe(bridge.glances.webStatus(), {});
    let snapshot = await safe(bridge.glances.snapshot(), {});

    // v0.0.47: AUTO-START. If glances is installed and the webserver
    // isn't running, start it automatically. The operator gets the
    // full Glances web UI on first paint instead of an empty iframe
    // and a "click here" prompt.
    if (webStatus?.available !== false && !webStatus?.running) {
        panel.innerHTML = renderStartingCard(webStatus);
        try {
            const startResp = await bridge.glances.startWeb();
            if (startResp?.started || startResp?.already_running) {
                // Poll web-status after a short grace period so the
                // webserver has time to bind the socket.
                await new Promise((r) => setTimeout(r, WEB_START_POLL_MS));
                webStatus = await safe(bridge.glances.webStatus(), webStatus);
                // Re-fetch the snapshot too — it's now backed by the
                // running webserver's data.
                snapshot = await safe(bridge.glances.snapshot(), snapshot);
            } else if (startResp?.error) {
                console.warn('glances.startWeb returned error:', startResp.error);
            }
        } catch (err) {
            console.warn('glances.startWeb threw:', err);
        }
    }

    const webRunning = webStatus?.running === true;
    const webUrl = webStatus?.url || 'http://127.0.0.1:61208';
    const glancesAvailable = webStatus?.available !== false;

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">System Monitor</h2>
            <p class="suite-panel-subtitle">
                Glances — real-time system overview
                · <span class="suite-badge info">GPL-3.0 · Nicolargo</span>
                ${webRunning
                    ? ` · <span class="suite-badge success">web UI running</span>`
                    : (glancesAvailable
                        ? ` · <span class="suite-badge">web UI stopped</span>`
                        : ` · <span class="suite-badge danger">glances not installed</span>`)}
                ${webRunning && webStatus?.pid ? ` · PID ${webStatus.pid}` : ''}
            </p>
        </header>

        ${renderWebControls(webStatus, webRunning, webUrl)}

        ${webRunning ? renderWebIframe(webUrl) : ''}

        ${!webRunning && glancesAvailable ? renderStartPrompt(webUrl) : ''}

        ${glancesAvailable ? renderLegacySnapshotDetails(snapshot) : ''}
    `;

    wireEvents(panel, { bridge, EventBus });
    EventBus.emit('glances.loaded', { webRunning, autoStarted: webRunning });
}

// ── Skeleton + starting states ──────────────────────────────────────

function renderSkeleton() {
    return `<div class="suite-skeleton">
        <div class="suite-skeleton-line w-1/3"></div>
        <div class="suite-skeleton-line w-2/3"></div>
        <div class="suite-skeleton-line w-1/2"></div>
    </div>`;
}

function renderStartingCard(webStatus) {
    // v0.0.47: shown while we're auto-starting the webserver.
    const url = webStatus?.url || 'http://127.0.0.1:61208';
    return `
        <header>
            <h2 class="suite-panel-title">System Monitor</h2>
            <p class="suite-panel-subtitle">
                Glances — real-time system overview
                · <span class="suite-badge info">GPL-3.0 · Nicolargo</span>
                · <span class="suite-badge">starting web UI…</span>
            </p>
        </header>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Starting Glances web UI…</h3>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted">
                    v0.0.47 auto-start: the panel is launching the
                    built-in Glances webserver at
                    <code>${escapeHtml(url)}</code> via
                    <code>glances -w --bind 127.0.0.1 --port 61208</code>.
                    The full web UI will appear here in a moment — every
                    chart, every sensor, every top process, every history
                    graph, without SysDeck re-implementing any of it.
                </p>
                <p class="suite-muted" style="margin-top:0.5rem;font-size:0.85rem">
                    If this takes more than a few seconds, click
                    <strong>↻ Refresh</strong> or check the cockpit bridge
                    log. The first start may be slow if glances needs to
                    warm its import cache.
                </p>
            </div>
        </div>
    `;
}

// ── Web UI controls ─────────────────────────────────────────────────

function renderWebControls(webStatus, webRunning, webUrl) {
    if (webStatus?.available === false) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Glances Web UI</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">
                        ${escapeHtml(webStatus.reason || 'Glances is not installed.')}
                    </p>
                    ${webStatus.install ? `<p class="suite-muted" style="margin-top:0.5rem"><code>${escapeHtml(webStatus.install)}</code></p>` : ''}
                    <p class="suite-muted" style="margin-top:0.5rem">
                        Glances is GPL-3.0 licensed by Nicolargo —
                        <a href="https://github.com/nicolargo/glances" style="color:var(--sysdeck-accent)">https://github.com/nicolargo/glances</a>
                    </p>
                </div>
            </div>
        `;
    }
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Glances Web UI</h3>
                <div class="suite-row" style="gap:0.5rem">
                    <button class="suite-btn ${webRunning ? '' : 'suite-btn-primary'}" id="btn-glances-start-web" ${webRunning ? 'disabled' : ''}>▶ Start Web UI</button>
                    <button class="suite-btn" id="btn-glances-stop-web" ${!webRunning ? 'disabled' : ''}>■ Stop Web UI</button>
                    <button class="suite-btn suite-btn-ghost" id="btn-glances-refresh">↻ Refresh</button>
                </div>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem">
                    ${webRunning
                        ? `Running at <code>${escapeHtml(webUrl)}</code>${webStatus.pid ? ` (PID ${webStatus.pid})` : ''}. The iframe below loads the full Glances web UI — every chart, every sensor, every top process, every history graph. No SysDeck-side reimplementation. v0.0.47 auto-starts this on panel mount; click Stop to disable.`
                        : `Stopped. v0.0.47 default is auto-start on panel mount — click <strong>▶ Start Web UI</strong> to launch it manually, or <strong>↻ Refresh</strong> to re-trigger the auto-start. The bridge runs <code>glances -w --bind 127.0.0.1 --port 61208</code> as a background process via the cockpit superuser channel.`}
                </p>
            </div>
        </div>
    `;
}

function renderWebIframe(webUrl) {
    // v0.0.47: iframe is now the primary view — sized to fill the
    // viewport. min-height uses calc(100vh - 200px) so the iframe
    // extends to just above the page footer, leaving room for the
    // controls card above and the legacy snapshot <details> below.
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Web UI — ${escapeHtml(webUrl)}</h3>
                <a href="${escapeHtml(webUrl)}" target="_blank" class="suite-btn suite-btn-ghost">↗ Open in new tab</a>
            </div>
            <iframe src="${escapeHtml(webUrl)}"
                    style="width:100%;min-height:calc(100vh - 200px);height:calc(100vh - 200px);border:1px solid var(--sysdeck-border);border-radius:6px;background:#1e1e1e;"
                    id="glances-iframe"
                    title="Glances Web UI"></iframe>
        </div>
    `;
}

function renderStartPrompt(webUrl) {
    // Shown when the webserver isn't running and didn't auto-start
    // (e.g. glances is installed but startWeb returned an error).
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Web UI not running</h3>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted">
                    The auto-start didn't bring up the Glances webserver.
                    Click <strong>▶ Start Web UI</strong> above to try
                    again, or <strong>↻ Refresh</strong> to re-run the
                    auto-start sequence. Expected URL:
                    <code>${escapeHtml(webUrl)}</code>.
                </p>
            </div>
        </div>
    `;
}

// ── Legacy snapshot (collapsed <details>) ───────────────────────────

function renderLegacySnapshotDetails(snapshot) {
    // v0.0.47: the snapshot cards are kept (they're a useful numeric
    // read) but moved into a collapsed <details> so the iframe is the
    // primary view. The operator can expand for the SysDeck-rendered
    // CPU/Memory/Swap/Network/Disk/Processes summary.
    return `
        <details class="suite-card" style="margin-top:0.75rem">
            <summary class="suite-card-header" style="cursor:pointer;list-style:none">
                <h3 class="suite-card-title" style="display:inline">Legacy SysDeck Snapshot (collapsed — iframe above is the primary view)</h3>
            </summary>
            <div class="suite-card-body">
                ${renderSnapshotCards(snapshot)}
            </div>
        </details>
    `;
}

function renderSnapshotCards(snapshot) {
    const cpu = snapshot.cpu || {};
    const mem = snapshot.mem || {};
    const swap = snapshot.memswap || {};
    const network = snapshot.network || {};
    const fs = snapshot.fs || {};
    const procs = snapshot.processcount || {};
    return `
        <div class="suite-row">
            <div class="suite-card suite-col-3">
                <h3 class="suite-card-title">CPU</h3>
                <div class="suite-stat-value">${(cpu.total || 0).toFixed(1)}%</div>
                <div class="suite-stat-label">user: ${(cpu.user || 0).toFixed(1)}% · system: ${(cpu.system || 0).toFixed(1)}% · idle: ${(cpu.idle || 0).toFixed(1)}%</div>
                <div class="suite-progress"><div class="suite-progress-bar" style="width:${Math.min(cpu.total || 0, 100)}%"></div></div>
            </div>
            <div class="suite-card suite-col-3">
                <h3 class="suite-card-title">Memory</h3>
                <div class="suite-stat-value">${(mem.percent || 0).toFixed(1)}%</div>
                <div class="suite-stat-label">${fmtMB(mem.used || 0)} / ${fmtMB(mem.total || 0)}</div>
                <div class="suite-progress"><div class="suite-progress-bar" style="width:${Math.min(mem.percent || 0, 100)}%"></div></div>
            </div>
            <div class="suite-card suite-col-3">
                <h3 class="suite-card-title">Swap</h3>
                <div class="suite-stat-value">${(swap.percent || 0).toFixed(1)}%</div>
                <div class="suite-stat-label">${fmtMB(swap.used || 0)} / ${fmtMB(swap.total || 0)}</div>
                <div class="suite-progress"><div class="suite-progress-bar" style="width:${Math.min(swap.percent || 0, 100)}%"></div></div>
            </div>
        </div>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Network Interfaces</h3>
            </div>
            <table class="suite-table">
                <thead><tr><th>Interface</th><th>Rx/s</th><th>Tx/s</th><th>Rx Err</th><th>Tx Err</th></tr></thead>
                <tbody>
                    ${Object.entries(network).map(([iface, n]) => `<tr>
                        <td class="suite-table-mono">${escapeHtml(iface)}</td>
                        <td>${fmtKB(n.rx || 0)}/s</td>
                        <td>${fmtKB(n.tx || 0)}/s</td>
                        <td>${n.rx_errors || 0}</td>
                        <td>${n.tx_errors || 0}</td>
                    </tr>`).join('') || '<tr><td colspan="5" class="suite-muted">No network data.</td></tr>'}
                </tbody>
            </table>
        </div>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Disk I/O</h3>
            </div>
            <table class="suite-table">
                <thead><tr><th>Device</th><th>Read/s</th><th>Write/s</th></tr></thead>
                <tbody>
                    ${Object.entries(fs).map(([dev, d]) => `<tr>
                        <td class="suite-table-mono">${escapeHtml(dev)}</td>
                        <td>${fmtKB(d.r_bytes_ps || 0)}/s</td>
                        <td>${fmtKB(d.w_bytes_ps || 0)}/s</td>
                    </tr>`).join('') || '<tr><td colspan="3" class="suite-muted">No disk data.</td></tr>'}
                </tbody>
            </table>
        </div>
        <div class="suite-card">
            <p class="suite-muted">Processes: ${procs.total || 0} total · ${procs.running || 0} running · ${procs.sleeping || 0} sleeping · ${procs.thread || 0} threads</p>
        </div>
    `;
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }) {
    panel.querySelector('#btn-glances-start-web')?.addEventListener('click', async () => {
        const btn = panel.querySelector('#btn-glances-start-web');
        if (btn) { btn.disabled = true; btn.textContent = 'Starting ...'; }
        try {
            const r = await bridge.glances.startWeb();
            if (r.started || r.already_running) {
                // Give the webserver a moment to bind before re-mount.
                await new Promise((res) => setTimeout(res, WEB_START_POLL_MS));
                mount(panel, { bridge, EventBus });
            } else {
                if (btn) { btn.disabled = false; btn.textContent = '▶ Start Web UI'; }
                alert(`Failed to start Glances web UI:\n${r.error || r.reason || 'unknown'}`);
            }
        } catch (err) {
            if (btn) { btn.disabled = false; btn.textContent = '▶ Start Web UI'; }
            alert(`Start error: ${err.message || err}`);
        }
    });

    panel.querySelector('#btn-glances-stop-web')?.addEventListener('click', async () => {
        const btn = panel.querySelector('#btn-glances-stop-web');
        if (btn) { btn.disabled = true; }
        try {
            await bridge.glances.stopWeb();
            setTimeout(() => mount(panel, { bridge, EventBus }), 500);
        } catch (err) {
            if (btn) { btn.disabled = false; }
            alert(`Stop error: ${err.message || err}`);
        }
    });

    panel.querySelector('#btn-glances-refresh')?.addEventListener('click', () => {
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

function fmtMB(kb) { return (kb / 1024).toFixed(1) + ' MB'; }
function fmtKB(bytes) { return (bytes / 1024).toFixed(1) + ' KB'; }

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
