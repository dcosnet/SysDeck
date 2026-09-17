/*
 * SysDeck - Fester Panel (v0.2.0)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * v0.2.0 REAL INTEGRATION — replaces the v0.1.3 build-jobs stub (which
 * listed systemd units whose name contained "fester"/"build" and never
 * talked to an orchestrator). This panel is now a live client of the
 * vendored fester service — the distributed DAG build orchestrator
 * from web/mini-services/fester, REST + WebSocket on 127.0.0.1:3010 —
 * through bridge/fester.py:
 *
 *   status / metrics / builds / nodes / targets / sessions   read polls
 *   startBuild → POST /api/build                             (build_id)
 *   cancel     → POST /api/builds/<id>/cancel
 *   replay     → POST /api/sessions                          (session)
 *   timeline   → GET  /api/timeline/<id>
 *
 * Layout: service status card + stat grid, cluster nodes table,
 * builds table (live first, then history) with per-row Cancel /
 * Replay / Timeline actions, and a Start-a-Build form fed by the
 * project/target catalog. Auto-refreshes every 5s; the refresh loop
 * re-renders only the status/nodes/builds containers — the form is
 * rendered once, so its state survives every tick. If the service is
 * down the panel shows the bridge's error message verbatim (it carries
 * the remediation hint) and keeps retrying, flipping back online on
 * its own.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    const ctx = {
        panel,
        bridge,
        EventBus,
        laidOut: false,          // full layout rendered (vs offline card)
        expanded: new Set(),     // build ids whose timeline row is open
        firstRenderDone: false,
        targetsResp: null,       // project catalog for the start form
    };

    // The status probe decides online vs offline — its error message
    // carries the remediation hint, shown verbatim when offline.
    let status = null;
    let statusErr = null;
    try {
        status = await bridge.fester.status();
    } catch (err) {
        statusErr = err;
    }

    if (statusErr || !status || status.ok === false) {
        renderOffline(ctx, errMessage(statusErr, status));
        EventBus.emit('fester.offline', {});
    } else {
        await mountLayout(ctx, status);
    }

    // ── auto-refresh (5s) ─────────────────────────────────────────
    // Re-fetches status + metrics + builds + nodes and re-renders only
    // the status/nodes/builds containers. Also watches for the service
    // going away (→ offline card) or coming back (→ full layout).
    if (panel._festerInterval) clearInterval(panel._festerInterval);
    panel._festerInterval = setInterval(() => { poll(ctx); }, 5000);

    // Clean up the interval when the panel leaves the DOM
    // (house pattern from netsec.js).
    // one observer per panel: a re-mount releases the previous one
    // instead of stacking body-wide observers on every refresh
    if (panel.festerObserver) panel.festerObserver.disconnect();
    if (panel.festerObserver) panel.festerObserver.disconnect();
    panel.festerObserver = new MutationObserver(() => {
        if (!document.body.contains(panel)) {
            clearInterval(panel._festerInterval);
            panel.festerObserver.disconnect();
        }
    });
    panel.festerObserver.observe(document.body, { childList: true, subtree: true });
}

// ── refresh loop ────────────────────────────────────────────────────

async function poll(ctx) {
    let status = null;
    let statusErr = null;
    try {
        status = await ctx.bridge.fester.status();
    } catch (err) {
        statusErr = err;
    }
    const online = !statusErr && status && status.ok !== false;

    if (online && !ctx.laidOut) {
        // Service came back after an offline render — build the layout.
        await mountLayout(ctx, status);
        return;
    }
    if (!online && ctx.laidOut) {
        // Service dropped — swap to the offline card.
        renderOffline(ctx, errMessage(statusErr, status));
        ctx.EventBus.emit('fester.offline', {});
        return;
    }
    if (!online) return; // still offline — the card is already shown

    await refreshData(ctx, status);
}

async function refreshNow(ctx) {
    // Immediate re-fetch after a user action (start/cancel/manual).
    let status = null;
    let statusErr = null;
    try {
        status = await ctx.bridge.fester.status();
    } catch (err) {
        statusErr = err;
    }
    if (!statusErr && status && status.ok !== false && ctx.laidOut) {
        await refreshData(ctx, status);
    }
}

async function refreshData(ctx, status) {
    if (!ctx.laidOut) return;
    const { bridge, panel } = ctx;

    // Per-call try/catch: one failing endpoint must not sink the panel.
    const metricsResp = await safe(bridge.fester.metrics());
    const buildsResp = await safe(bridge.fester.builds());
    const nodesResp = await safe(bridge.fester.nodes());

    const statusEl = panel.querySelector('#fester-status');
    const nodesEl = panel.querySelector('#fester-nodes');
    const buildsEl = panel.querySelector('#fester-builds');
    if (statusEl) statusEl.innerHTML = renderStatus(status, metricsResp, nodesResp);
    if (nodesEl) nodesEl.innerHTML = renderNodes(nodesResp);
    if (buildsEl) buildsEl.innerHTML = renderBuilds(buildsResp);

    wireStatusAndRows(ctx);

    // Re-open timeline rows that were expanded before the re-render
    // (the events re-fetch keeps them live).
    await reopenExpanded(ctx);

    if (!ctx.firstRenderDone) {
        ctx.firstRenderDone = true;
        ctx.EventBus.emit('fester.loaded', { builds: countBuilds(buildsResp) });
    }
}

// ── layout ──────────────────────────────────────────────────────────

async function mountLayout(ctx, status) {
    const { panel, bridge } = ctx;
    ctx.laidOut = true;

    // Target catalog feeds the Start-a-Build form. Fetched once per
    // layout — the form is static for the panel's lifetime, which is
    // what preserves its state across refresh ticks.
    let targetsResp = null;
    let targetsErr = null;
    try {
        targetsResp = await bridge.fester.targets();
    } catch (err) {
        targetsErr = err;
    }
    ctx.targetsResp = targetsResp;

    const baseUrl = (status && status.base_url) || 'http://127.0.0.1:3010';
    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">SysDeck Fester</h2>
            <p class="suite-panel-subtitle">Distributed DAG build orchestration — vendored fester service (${escapeHtml(baseUrl)} · REST+WS)</p>
        </header>
        <div id="fester-status"></div>
        <div id="fester-nodes"></div>
        <div id="fester-builds"></div>
        <div id="fester-form">
            ${renderStartForm(targetsResp, targetsErr)}
        </div>
    `;

    wireStartForm(ctx);
    await refreshData(ctx, status);
}

function renderOffline(ctx, message) {
    ctx.laidOut = false;
    ctx.panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">SysDeck Fester</h2>
            <p class="suite-panel-subtitle">Distributed DAG build orchestration — vendored fester service (web/mini-services/fester · REST+WS)</p>
        </header>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Fester Service Offline</h3>
                <span class="suite-badge danger">offline</span>
            </div>
            <p class="suite-card-body suite-mono">${escapeHtml(message)}</p>
            <p class="suite-muted">Retrying every 5 seconds — the panel reconnects automatically when the service is back.</p>
        </div>
    `;
}

// ── status card + stat grid ─────────────────────────────────────────

function renderStatus(status, metricsResp, nodesResp) {
    const m = (metricsResp && metricsResp.ok !== false) ? metricsResp : null;
    const metrics = (m && m.metrics) || {};
    const builds = metrics.builds || {};
    const actions = metrics.actions || {};
    const nodesOk = nodesResp && nodesResp.ok !== false;
    const nodeCount = nodesOk && Array.isArray(nodesResp.nodes)
        ? nodesResp.nodes.length
        : (status && typeof status.nodes === 'number' ? status.nodes : 0);
    const stat = (v) => (m ? n(v) : '—');

    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Service</h3>
                <div class="suite-row" style="gap:0.5rem">
                    <span class="suite-badge success">online</span>
                    <button class="suite-btn suite-btn-ghost" id="btn-fester-refresh">↻ Refresh</button>
                </div>
            </div>
            <div class="suite-card-body">
                <div class="suite-row-between">
                    <span class="suite-muted">fester v${escapeHtml(status && status.version)}</span>
                    <span class="suite-muted suite-mono">${escapeHtml(status && status.base_url)} · ${escapeHtml(status && status.transport)} · clock ${escapeHtml(status && status.clock)}</span>
                </div>
                <div class="suite-row-between">
                    <span class="suite-muted">${nodeCount} cluster nodes</span>
                    <span class="suite-muted">up ${escapeHtml(fmtDuration(status && status.uptime_s))}</span>
                </div>
                ${m ? '' : `<p class="suite-muted">metrics unavailable${metricsResp && metricsResp.error ? ': ' + escapeHtml(metricsResp.error) : ''}</p>`}
            </div>
        </div>
        <div class="suite-grid cols-3">
            <div class="suite-card">
                <div class="suite-stat-value">${stat(builds.total)}</div>
                <div class="suite-stat-label">builds total</div>
            </div>
            <div class="suite-card">
                <div class="suite-stat-value ${n(builds.running) > 0 ? 'suite-warn' : ''}">${stat(builds.running)}</div>
                <div class="suite-stat-label">running</div>
            </div>
            <div class="suite-card">
                <div class="suite-stat-value">${stat(builds.succeeded)}</div>
                <div class="suite-stat-label">succeeded</div>
            </div>
            <div class="suite-card">
                <div class="suite-stat-value">${stat(builds.failed)}</div>
                <div class="suite-stat-label">failed</div>
            </div>
            <div class="suite-card">
                <div class="suite-stat-value">${m ? fmtNum(actions.cache_hit_rate, 1) + '%' : '—'}</div>
                <div class="suite-stat-label">cache-hit rate (${stat(actions.cache_hits)}/${stat(actions.total)} actions)</div>
            </div>
            <div class="suite-card">
                <div class="suite-stat-value">${nodesOk ? nodeCount : '—'}</div>
                <div class="suite-stat-label">cluster nodes</div>
            </div>
        </div>
    `;
}

// ── cluster nodes table ─────────────────────────────────────────────

function renderNodes(nodesResp) {
    const nodes = (nodesResp && Array.isArray(nodesResp.nodes)) ? nodesResp.nodes : null;
    if (!nodes) {
        const msg = (nodesResp && nodesResp.error)
            ? nodesResp.error
            : 'No cluster nodes registered.';
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Cluster Nodes</h3>
                <p class="suite-card-body suite-muted">${escapeHtml(msg)}</p>
            </div>`;
    }
    const rows = nodes.map((nd) => `<tr>
        <td class="suite-table-mono">${escapeHtml(nd.name)}</td>
        <td>${nodeStateBadge(nd.state)}</td>
        <td class="suite-mono">${fmtNum(nd.cpu_load, 1)}%</td>
        <td class="suite-mono">${fmtNum(nd.temp, 1)}°C</td>
        <td class="suite-mono">${n(nd.active_jobs)}/${n(nd.max_jobs)}</td>
    </tr>`).join('');
    return `
        <div class="suite-card">
            <h3 class="suite-card-title">Cluster Nodes</h3>
            <table class="suite-table">
                <thead><tr><th>Node</th><th>State</th><th>CPU load</th><th>Temp</th><th>Jobs (active/max)</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

function nodeStateBadge(state) {
    const s = String(state || '');
    const cls = s === 'online' ? 'suite-badge success'
        : s === 'degraded' ? 'suite-badge warn'
        : 'suite-badge';
    return `<span class="${cls}">${escapeHtml(s || '—')}</span>`;
}

// ── builds table ────────────────────────────────────────────────────

function renderBuilds(buildsResp) {
    if (!buildsResp || buildsResp.ok === false) {
        const msg = (buildsResp && buildsResp.error)
            ? buildsResp.error
            : 'build list unavailable';
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Builds</h3>
                <p class="suite-card-body suite-muted">${escapeHtml(msg)}</p>
            </div>`;
    }
    const live = Array.isArray(buildsResp.builds) ? buildsResp.builds : [];
    const history = Array.isArray(buildsResp.history) ? buildsResp.history : [];
    const seen = new Set(live.map((b) => String(b.build_id || '')));

    const rows = [
        ...live.map((b) => buildRow(b, true)),
        ...history
            .filter((b) => !seen.has(String(b.build_id || '')))
            .map((b) => buildRow(b, false)),
    ];

    return `
        <div class="suite-card">
            <h3 class="suite-card-title">Builds</h3>
            <table class="suite-table">
                <thead><tr>
                    <th>Build</th><th>Project</th><th>State</th><th>Actions</th>
                    <th>Cache hits</th><th>Critical path</th><th>Started</th><th></th>
                </tr></thead>
                <tbody>
                    ${rows.join('') || '<tr><td colspan="8" class="suite-muted">No builds yet — start one below.</td></tr>'}
                </tbody>
            </table>
            <p class="suite-muted">Live builds first, then history (${live.length} live · ${history.length} stored).</p>
        </div>`;
}

function buildRow(b, live) {
    const id = String(b.build_id || '');
    const state = String(b.state || '');
    const running = state === 'running' || state === 'queued';
    const done = live ? null : b.actions_done;
    const total = live ? b.actions : b.actions_total;
    const cacheHits = live ? null : b.cache_hits;
    const criticalMs = live ? null : b.critical_path_ms;

    const buttons = [
        running ? `<button class="suite-btn" data-fx="cancel" data-build="${escapeHtml(id)}">Cancel</button>` : '',
        !running ? `<button class="suite-btn" data-fx="replay" data-build="${escapeHtml(id)}">Replay</button>` : '',
        `<button class="suite-btn suite-btn-ghost" data-fx="timeline" data-build="${escapeHtml(id)}">Timeline</button>`,
    ].filter(Boolean).join(' ');

    return `<tr data-build="${escapeHtml(id)}">
        <td class="suite-table-mono">${escapeHtml(id)}</td>
        <td>${escapeHtml(b.project || '')}</td>
        <td>${stateBadge(state)}</td>
        <td class="suite-mono">${done == null ? '—' : n(done)}/${n(total)}</td>
        <td class="suite-mono">${cacheHits == null ? '—' : n(cacheHits)}</td>
        <td class="suite-mono">${criticalMs == null ? '—' : n(criticalMs) + ' ms'}</td>
        <td class="suite-muted">${escapeHtml(fmtTime(b.started_at))}</td>
        <td>
            <div class="suite-row" style="gap:0.35rem;flex-wrap:nowrap">${buttons}</div>
            <div class="suite-muted suite-mono" data-note="${escapeHtml(id)}" style="font-size:0.75rem;margin-top:0.25rem"></div>
        </td>
    </tr>`;
}

function stateBadge(state) {
    const s = String(state || '');
    const cls = (s === 'running' || s === 'queued') ? 'suite-badge warn'
        : s === 'succeeded' ? 'suite-badge success'
        : s === 'failed' ? 'suite-badge danger'
        : 'suite-badge'; // cancelled / unknown → neutral gray
    return `<span class="${cls}">${escapeHtml(s || '—')}</span>`;
}

// ── timeline expansion ──────────────────────────────────────────────

async function toggleTimeline(ctx, buildId) {
    if (ctx.expanded.has(buildId)) {
        ctx.expanded.delete(buildId);
        const row = findTimelineRow(ctx, buildId);
        if (row) row.remove();
        return;
    }
    ctx.expanded.add(buildId);
    await insertTimelineRow(ctx, buildId);
}

async function insertTimelineRow(ctx, buildId) {
    const buildRowEl = findBuildRow(ctx, buildId);
    if (!buildRowEl) return;
    const tr = document.createElement('tr');
    tr.setAttribute('data-timeline', buildId);
    tr.innerHTML = `<td colspan="8" class="suite-muted">loading timeline…</td>`;
    buildRowEl.after(tr);
    try {
        const resp = await ctx.bridge.fester.timeline(buildId);
        tr.innerHTML = timelineTd(resp);
    } catch (err) {
        tr.innerHTML = `<td colspan="8" class="suite-muted">${escapeHtml(errMessage(err, null))}</td>`;
    }
}

async function reopenExpanded(ctx) {
    for (const id of ctx.expanded) {
        if (!findBuildRow(ctx, id)) continue;
        await insertTimelineRow(ctx, id);
    }
}

function timelineTd(resp) {
    const events = (resp && Array.isArray(resp.events)) ? resp.events : [];
    if (!events.length) {
        return `<td colspan="8" class="suite-muted">No timeline events.</td>`;
    }
    const lines = events.slice(-15).map((ev) =>
        `<div class="suite-mono" style="font-size:0.8rem">${escapeHtml(fmtEvent(ev))}</div>`
    ).join('');
    return `<td colspan="8" style="padding:0.5rem 0.75rem;background:rgba(255,255,255,0.03)">${lines}</td>`;
}

function fmtEvent(ev) {
    let line = `#${n(ev.id)} ${fmtTimeShort(ev.ts)} ${String(ev.type || '?')}`;
    if (ev.state != null) line += `/${String(ev.state)}`;
    if (ev.action) line += ` — ${ev.action}`;
    return line;
}

// ── start-a-build form ──────────────────────────────────────────────

function renderStartForm(targetsResp, targetsErr) {
    const projects = (targetsResp && Array.isArray(targetsResp.projects)) ? targetsResp.projects : null;
    if (targetsErr || !projects) {
        const msg = targetsErr ? errMessage(targetsErr, null)
            : (targetsResp && targetsResp.error) || 'target catalog unavailable';
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Start a Build</h3>
                <p class="suite-card-body suite-muted">${escapeHtml(msg)}</p>
            </div>`;
    }
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Start a Build</h3>
                <span class="suite-muted">POST /api/build via bridge.fester.startBuild</span>
            </div>
            <div class="suite-card-body">
                <div class="suite-row-between" style="margin-bottom:0.5rem">
                    <label class="suite-muted" for="fester-project">Project</label>
                    <select class="suite-input" id="fester-project">
                        ${projects.map((p) =>
                            `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)} (${(p.targets || []).length} targets)</option>`
                        ).join('')}
                    </select>
                </div>
                <div class="suite-muted" style="margin-bottom:0.25rem">Targets</div>
                <div class="suite-row" id="fester-targets" style="margin-bottom:0.5rem"></div>
                <div class="suite-row" style="align-items:center;margin-bottom:0.75rem">
                    <label class="suite-row" style="gap:0.35rem;align-items:center">
                        <input type="checkbox" id="fester-nocache" />
                        <span>no-cache</span>
                    </label>
                    <label class="suite-row" style="gap:0.35rem;align-items:center">
                        <span>retries</span>
                        <select class="suite-input" id="fester-retries">
                            <option value="0">0</option>
                            <option value="1">1</option>
                            <option value="2">2</option>
                            <option value="3">3</option>
                        </select>
                    </label>
                </div>
                <button class="suite-btn suite-btn-primary" id="btn-fester-start">▶ Start Build</button>
                <div class="suite-muted suite-mono" id="fester-start-result" style="margin-top:0.5rem"></div>
            </div>
        </div>`;
}

function wireStartForm(ctx) {
    const { panel } = ctx;
    const select = panel.querySelector('#fester-project');
    const targetsBox = panel.querySelector('#fester-targets');
    if (!select || !targetsBox) return;

    const renderTargetOptions = () => {
        const name = select.value;
        const project = ((ctx.targetsResp && ctx.targetsResp.projects) || [])
            .find((p) => p.name === name);
        const list = (project && project.targets) || [];
        targetsBox.innerHTML = list.map((t) => `
            <label class="suite-row" style="gap:0.35rem;align-items:center;margin-right:0.75rem">
                <input type="checkbox" class="fester-target-cb" value="${escapeHtml(t.name)}" />
                <span>${escapeHtml(t.name)} <span class="suite-muted">${escapeHtml(t.system)}/${escapeHtml(t.arch)}</span></span>
            </label>`).join('') || '<span class="suite-muted">No targets for this project.</span>';
    };
    renderTargetOptions();
    select.addEventListener('change', renderTargetOptions);

    panel.querySelector('#btn-fester-start')?.addEventListener('click', async () => {
        const result = panel.querySelector('#fester-start-result');
        const btn = panel.querySelector('#btn-fester-start');
        const project = select.value;
        const targets = Array.from(panel.querySelectorAll('.fester-target-cb:checked'))
            .map((el) => el.value);
        const noCache = !!(panel.querySelector('#fester-nocache')?.checked);
        const retries = Number(panel.querySelector('#fester-retries')?.value || '0');

        if (!project || targets.length === 0) {
            if (result) result.textContent = 'Pick a project and at least one target.';
            return;
        }
        if (btn) btn.disabled = true;
        if (result) result.textContent = `starting ${project} (${targets.join(', ')})…`;
        try {
            const res = await ctx.bridge.fester.startBuild(project, targets, { noCache, retries });
            if (result) {
                result.textContent = (res && res.ok)
                    ? `started build ${res.build_id} (retries ${res.retries != null ? res.retries : 0})`
                    : `start failed: ${(res && res.error) || 'unknown error'}`;
            }
        } catch (err) {
            if (result) result.textContent = `start failed: ${errMessage(err, null)}`;
        }
        if (btn) btn.disabled = false;
        // Immediate refresh so the new build shows up right away.
        refreshNow(ctx);
    });
}

// ── row actions (cancel / replay / timeline) ────────────────────────

function wireStatusAndRows(ctx) {
    const { panel } = ctx;

    panel.querySelector('#btn-fester-refresh')?.addEventListener('click', () => {
        refreshNow(ctx);
    });

    panel.querySelectorAll('#fester-builds button[data-fx]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const fx = btn.getAttribute('data-fx');
            const id = btn.getAttribute('data-build');
            if (!id) return;
            if (fx === 'cancel') doCancel(ctx, id, btn);
            else if (fx === 'replay') doReplay(ctx, id, btn);
            else if (fx === 'timeline') toggleTimeline(ctx, id);
        });
    });
}

async function doCancel(ctx, buildId, btn) {
    btn.disabled = true;
    let res = null;
    let err = null;
    try {
        res = await ctx.bridge.fester.cancel(buildId);
    } catch (e) {
        err = e;
    }
    // A 409-style {ok:false, error:"build not running"} is surfaced
    // as-is — the bridge prints the service's JSON verbatim.
    const msg = err ? errMessage(err, null)
        : (res && res.ok) ? 'cancel requested'
        : `cancel failed: ${(res && res.error) || 'unknown error'}`;
    setRowNote(ctx, buildId, msg);
    refreshNow(ctx);
}

async function doReplay(ctx, buildId, btn) {
    btn.disabled = true;
    let res = null;
    let err = null;
    try {
        res = await ctx.bridge.fester.replay(buildId);
    } catch (e) {
        err = e;
    }
    let msg;
    if (err) {
        msg = `replay failed: ${errMessage(err, null)}`;
    } else if (res && res.ok) {
        const sid = res.session && res.session.session_id;
        msg = sid ? `session ${sid}` : 'session created';
    } else {
        msg = `replay failed: ${(res && res.error) || 'unknown error'}`;
    }
    setRowNote(ctx, buildId, msg);
    btn.disabled = false;
}

function setRowNote(ctx, buildId, msg) {
    ctx.panel.querySelectorAll('[data-note]').forEach((el) => {
        if (el.getAttribute('data-note') === buildId) el.textContent = msg;
    });
}

function findBuildRow(ctx, buildId) {
    let found = null;
    ctx.panel.querySelectorAll('#fester-builds tr[data-build]').forEach((el) => {
        if (el.getAttribute('data-build') === buildId) found = el;
    });
    return found;
}

function findTimelineRow(ctx, buildId) {
    let found = null;
    ctx.panel.querySelectorAll('#fester-builds tr[data-timeline]').forEach((el) => {
        if (el.getAttribute('data-timeline') === buildId) found = el;
    });
    return found;
}

// ── utilities ───────────────────────────────────────────────────────

async function safe(p) {
    try {
        const v = await p;
        return v ?? null;
    } catch {
        return null;
    }
}

function errMessage(err, resp) {
    if (resp && resp.error) return String(resp.error);
    if (err && err.message) return String(err.message);
    if (err) return String(err);
    return 'fester service unreachable';
}

function countBuilds(buildsResp) {
    if (!buildsResp || buildsResp.ok === false) return 0;
    const live = Array.isArray(buildsResp.builds) ? buildsResp.builds.length : 0;
    const hist = Array.isArray(buildsResp.history) ? buildsResp.history.length : 0;
    return live + hist;
}

function n(v) {
    const num = Number(v);
    return Number.isFinite(num) ? num : 0;
}

function fmtNum(v, digits) {
    const num = Number(v);
    return Number.isFinite(num) ? num.toFixed(digits) : '—';
}

function fmtTime(ts) {
    const num = Number(ts);
    if (!Number.isFinite(num) || num <= 0) return '—';
    return new Date(num * 1000).toLocaleString();
}

function fmtTimeShort(ts) {
    const num = Number(ts);
    if (!Number.isFinite(num) || num <= 0) return '--:--:--';
    return new Date(num * 1000).toLocaleTimeString();
}

function fmtDuration(s) {
    const num = Number(s);
    if (!Number.isFinite(num) || num < 0) return '—';
    const h = Math.floor(num / 3600);
    const m = Math.floor((num % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${Math.floor(num % 60)}s`;
    return `${Math.floor(num)}s`;
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderSkeleton() {
    return `<div class="suite-skeleton">
        <div class="suite-skeleton-line w-1/3"></div>
        <div class="suite-skeleton-line w-2/3"></div>
        <div class="suite-skeleton-line w-1/2"></div>
    </div>`;
}
