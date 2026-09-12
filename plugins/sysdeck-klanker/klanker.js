/*
 * SysDeck - AI Gateway (klanker) Panel (v0.3.0)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * UPSTREAM ATTRIBUTION: this panel is a client of klanker-gate — the
 * "Frosty Deno" LLM gateway by TykoDev
 * (https://github.com/TykoDev/klanker-gate, Apache-2.0, vendored
 * unmodified at ../klanker-gate in the master tarball). klanker-gate
 * is NOT SysDeck code — see klanker-gate/ATTRIBUTION.md and
 * THIRD_PARTY.md. Zero upstream code is contained here.
 *
 * v0.3.0 NEW MODULE — operator view of the vendored klanker-gate
 * service (master-build/klanker-gate): the Frosty Deno LLM gateway,
 * REST on 127.0.0.1:8080, through bridge/klanker.py:
 *
 *   status / providers / models / vkeys / runtime   read polls
 *   logs (limit)      → GET /api/logs?limit=N       (request ring)
 *   analytics         → GET /api/analytics          (24h rollups)
 *   service (action)  → systemctl klanker-gate.service
 *   journal (n)       → journalctl -u klanker-gate -n N
 *   localstack        → probes ollama/llama.cpp/koboldcpp/lmstudio/
 *                       sglang/vllm on this host + wiring recipes (the
 *                       gateway is NOT SaaS-only — all-local stacks are
 *                       first-class: 5 keyless provider types upstream)
 *
 * Layout: gateway status card + stat grid (providers, keys, requests,
 * spend, cache hit rate, avg latency), providers table, virtual keys
 * table, recent requests table, model catalog, service control card
 * with a journal viewer. Auto-refreshes every 5s; the refresh loop
 * re-renders only the data containers — the service/journal cards are
 * rendered once, so their state survives every tick. Upstream money
 * is integer micro-USD everywhere; this panel divides by 1e6 and shows
 * $X.XXXX. If the gateway is down the panel shows the bridge's error
 * message verbatim (it carries the remediation hint) and keeps
 * retrying, flipping back online on its own.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    const ctx = {
        panel,
        bridge,
        EventBus,
        laidOut: false,          // full layout rendered (vs offline card)
        firstRenderDone: false,
        logsLimit: 25,           // recent-requests ring size
    };

    // The status probe decides online vs offline — its error message
    // carries the remediation hint, shown verbatim when offline.
    let status = null;
    let statusErr = null;
    try {
        status = await bridge.klanker.status();
    } catch (err) {
        statusErr = err;
    }

    if (statusErr || !status || status.ok === false) {
        renderOffline(ctx, errMessage(statusErr, status));
        EventBus.emit('klanker.offline', {});
    } else {
        await mountLayout(ctx, status);
    }

    // ── auto-refresh (5s) ─────────────────────────────────────────
    // Re-fetches status + runtime + analytics + providers + vkeys +
    // logs and re-renders only the data containers. Also watches for
    // the gateway going away (→ offline card) or coming back (→ full
    // layout).
    if (panel._klankerInterval) clearInterval(panel._klankerInterval);
    panel._klankerInterval = setInterval(() => { poll(ctx); }, 5000);

    // Clean up the interval when the panel leaves the DOM
    // (house pattern from netsec.js / fester.js).
    const observer = new MutationObserver(() => {
        if (!document.body.contains(panel)) {
            clearInterval(panel._klankerInterval);
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

// ── refresh loop ────────────────────────────────────────────────────

async function poll(ctx) {
    let status = null;
    let statusErr = null;
    try {
        status = await ctx.bridge.klanker.status();
    } catch (err) {
        statusErr = err;
    }
    const online = !statusErr && status && status.ok !== false;

    if (online && !ctx.laidOut) {
        // Gateway came back after an offline render — build the layout.
        await mountLayout(ctx, status);
        return;
    }
    if (!online && ctx.laidOut) {
        // Gateway dropped — swap to the offline card.
        renderOffline(ctx, errMessage(statusErr, status));
        ctx.EventBus.emit('klanker.offline', {});
        return;
    }
    if (!online) return; // still offline — the card is already shown

    await refreshData(ctx, status);
}

async function refreshNow(ctx) {
    // Immediate re-fetch after a user action (service control/manual).
    let status = null;
    let statusErr = null;
    try {
        status = await ctx.bridge.klanker.status();
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
    const runtimeResp = await safe(bridge.klanker.runtime());
    const analyticsResp = await safe(bridge.klanker.analytics());
    const providersResp = await safe(bridge.klanker.providers());
    const vkeysResp = await safe(bridge.klanker.vkeys());
    const logsResp = await safe(bridge.klanker.logs(ctx.logsLimit));

    const statusEl = panel.querySelector('#klanker-status');
    const providersEl = panel.querySelector('#klanker-providers');
    const vkeysEl = panel.querySelector('#klanker-vkeys');
    const logsEl = panel.querySelector('#klanker-logs');
    if (statusEl) statusEl.innerHTML = renderStatus(status, runtimeResp, analyticsResp, providersResp, vkeysResp, logsResp);
    if (providersEl) providersEl.innerHTML = renderProviders(providersResp, logsResp);
    if (vkeysEl) vkeysEl.innerHTML = renderVkeys(vkeysResp, analyticsResp);
    if (logsEl) logsEl.innerHTML = renderLogs(logsResp);

    wireStatus(ctx);

    if (!ctx.firstRenderDone) {
        ctx.firstRenderDone = true;
        const totals = analyticsTotals(analyticsResp);
        ctx.EventBus.emit('klanker.loaded', { requests: totals.requests });
    }
}

// The model catalog is fetched once per layout (it changes only when
// the operator edits provider configs — not on the 5s poll).
let modelsRespCache = null;

async function fetchModels(ctx) {
    modelsRespCache = await safe(ctx.bridge.klanker.models());
    const modelsEl = ctx.panel.querySelector('#klanker-models');
    if (modelsEl) modelsEl.innerHTML = renderModels(modelsRespCache);
}

// ── layout ──────────────────────────────────────────────────────────

async function mountLayout(ctx, status) {
    const { panel } = ctx;
    ctx.laidOut = true;

    const baseUrl = (status && status.base_url) || 'http://127.0.0.1:8080';
    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">SysDeck AI Gateway</h2>
            <p class="suite-panel-subtitle">klanker-gate — Frosty Deno LLM gateway · local stack (ollama · llama.cpp · koboldcpp) + providers, vkeys, spend &amp; runtime (${escapeHtml(baseUrl)} · REST)</p>
        </header>
        <div id="klanker-status"></div>
        <div id="klanker-providers"></div>
        <div id="klanker-vkeys"></div>
        <div id="klanker-logs"></div>
        <div id="klanker-models"></div>
        <div id="klanker-localstack"></div>
        ${renderServiceCard()}
        ${renderJournalCard()}
        <p class="suite-muted" style="font-size:0.8rem">
            Gateway configured via <code>KLANKER_URL</code> / <code>KLANKER_ADMIN_TOKEN</code> env
            (admin token is sent as a bearer header only — never displayed).
        </p>
        <p class="suite-muted" style="font-size:0.8rem">
            Upstream: klanker-gate (“Frosty Deno”) by TykoDev —
            <a href="https://github.com/TykoDev/klanker-gate" target="_blank" rel="noopener">github.com/TykoDev/klanker-gate</a>
            · Apache-2.0 · vendored unmodified (SysDeck adds only the <code>arch/</code> packaging).
        </p>
    `;

    wireServiceCard(ctx);
    wireJournalCard(ctx);
    await fetchModels(ctx);
    fetchLocalStack(ctx);
    await refreshUnitState(ctx);
    await refreshData(ctx, status);
}

function renderOffline(ctx, message) {
    ctx.laidOut = false;
    modelsRespCache = null;
    ctx.panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">SysDeck AI Gateway</h2>
            <p class="suite-panel-subtitle">klanker-gate — Frosty Deno LLM gateway (master-build/klanker-gate · REST)</p>
        </header>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">AI Gateway Offline</h3>
                <span class="suite-badge danger">offline</span>
            </div>
            <p class="suite-card-body suite-mono">${escapeHtml(message)}</p>
            <p class="suite-muted">Retrying every 5 seconds — the panel reconnects automatically when the gateway is back.</p>
        </div>
        <p class="suite-muted" style="font-size:0.8rem">
            Upstream: klanker-gate (“Frosty Deno”) by TykoDev —
            <a href="https://github.com/TykoDev/klanker-gate" target="_blank" rel="noopener">github.com/TykoDev/klanker-gate</a>
            · Apache-2.0 · vendored unmodified (SysDeck adds only the <code>arch/</code> packaging).
        </p>
    `;
}

// ── status card + stat grid ─────────────────────────────────────────

function renderStatus(status, runtimeResp, analyticsResp, providersResp, vkeysResp, logsResp) {
    const runtime = (runtimeResp && runtimeResp.ok !== false && !runtimeResp.error)
        ? runtimeResp : null;
    const analytics = analyticsTotals(analyticsResp);
    const aOk = analyticsResp && analyticsResp.ok !== false && !analyticsResp.error;
    const providers = listProviders(providersResp);
    const vkeys = listVkeys(vkeysResp);

    const workers = (runtime && runtime.workers) || {};
    const cache = (runtime && runtime.cache) || {};
    const process = (runtime && runtime.process) || {};

    // Avg latency over the recent request ring (honest: labeled "recent").
    const logs = listLogs(logsResp);
    let latencySum = 0, latencyN = 0;
    for (const r of logs) {
        if (Number.isFinite(Number(r.durationMs))) { latencySum += Number(r.durationMs); latencyN++; }
    }
    const avgLatency = latencyN > 0 ? latencySum / latencyN : null;

    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Gateway</h3>
                <div class="suite-row" style="gap:0.5rem">
                    <span class="suite-badge success">online</span>
                    <button class="suite-btn suite-btn-ghost" id="btn-klanker-refresh">↻ Refresh</button>
                </div>
            </div>
            <div class="suite-card-body">
                <div class="suite-row-between">
                    <span class="suite-muted">klanker-gate v${escapeHtml(status && status.version)}${process.denoVersion ? ' · Deno ' + escapeHtml(process.denoVersion) : ''}</span>
                    <span class="suite-muted suite-mono">${escapeHtml(status && status.base_url)} · ${escapeHtml(status && status.transport)}${status && status.auth ? ' · admin auth' : ' · open admin'}</span>
                </div>
                <div class="suite-row-between">
                    <span class="suite-muted">workers ${workers.effective != null ? n(workers.effective) : '—'}/${workers.configured != null ? n(workers.configured) : '—'} effective/configured${workers.platform ? ' · ' + escapeHtml(workers.platform) : ''}</span>
                    <span class="suite-muted">up ${escapeHtml(fmtDuration(process.uptimeSeconds))}</span>
                </div>
                <div class="suite-row-between">
                    <span class="suite-muted">cache ${escapeHtml(cache.mode || '—')}${cache.sharedTier ? ' · shared L2' : ''}${Number.isFinite(Number(cache.localEntries)) ? ' · ' + n(cache.localEntries) + ' L1 entries' : ''}</span>
                    <span class="suite-muted">${(workers.reason ? escapeHtml(workers.reason) : '')}</span>
                </div>
                ${runtime ? '' : `<p class="suite-muted">runtime view unavailable${runtimeResp && runtimeResp.error ? ': ' + escapeHtml(runtimeResp.error) : ''}</p>`}
            </div>
        </div>
        <div class="suite-grid cols-3">
            <div class="suite-card">
                <div class="suite-stat-value">${providers != null ? providers.length : '—'}</div>
                <div class="suite-stat-label">providers</div>
            </div>
            <div class="suite-card">
                <div class="suite-stat-value">${vkeys != null ? vkeys.length : '—'}</div>
                <div class="suite-stat-label">virtual keys</div>
            </div>
            <div class="suite-card">
                <div class="suite-stat-value">${aOk ? n(analytics.requests) : '—'}</div>
                <div class="suite-stat-label">requests 24h</div>
            </div>
            <div class="suite-card">
                <div class="suite-stat-value">${aOk ? fmtUsd(analytics.costMicroUsd) : '—'}</div>
                <div class="suite-stat-label">spend 24h</div>
            </div>
            <div class="suite-card">
                <div class="suite-stat-value">${aOk ? fmtHitRate(analytics.cacheHits, analytics.cacheMisses) : '—'}</div>
                <div class="suite-stat-label">cache hit rate</div>
            </div>
            <div class="suite-card">
                <div class="suite-stat-value">${avgLatency != null ? fmtMs(avgLatency) : '—'}</div>
                <div class="suite-stat-label">avg latency (recent)</div>
            </div>
        </div>
    `;
}

// ── providers table ─────────────────────────────────────────────────

function renderProviders(providersResp, logsResp) {
    const providers = listProviders(providersResp);
    if (providers == null) {
        const msg = (providersResp && providersResp.error)
            ? providersResp.error
            : 'provider list unavailable';
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Providers</h3>
                <p class="suite-card-body suite-muted">${escapeHtml(msg)}</p>
            </div>`;
    }

    // Per-provider average latency over the recent request ring.
    const sums = new Map();
    for (const r of listLogs(logsResp)) {
        if (!r.provider) continue;
        const dur = Number(r.durationMs);
        if (!Number.isFinite(dur)) continue;
        const e = sums.get(r.provider) || { total: 0, n: 0 };
        e.total += dur; e.n += 1;
        sums.set(r.provider, e);
    }

    const rows = providers.map((p) => {
        const models = Array.isArray(p.models) ? p.models.length : 0;
        const enabled = p.enabled !== false;
        const hasCreds = !!(p.hasApiKey || p.hasCloudCredentials);
        const dot = enabled ? (hasCreds ? 'ok' : 'warn') : 'off';
        const dotTitle = enabled
            ? (hasCreds ? 'enabled with credentials' : 'enabled but no credentials configured')
            : 'disabled';
        const s = sums.get(p.id);
        const latency = s && s.n > 0 ? fmtMs(s.total / s.n) : '—';
        return `<tr>
            <td>${healthDot(dot, dotTitle)}</td>
            <td class="suite-table-mono">${escapeHtml(p.id)}</td>
            <td>${escapeHtml(p.type || '—')}</td>
            <td class="suite-mono">${n(models)}</td>
            <td>${enabled ? '<span class="suite-badge success">enabled</span>' : '<span class="suite-badge">disabled</span>'}</td>
            <td class="suite-mono">${latency}</td>
        </tr>`;
    }).join('');

    return `
        <div class="suite-card">
            <h3 class="suite-card-title">Providers</h3>
            <table class="suite-table">
                <thead><tr><th></th><th>Name</th><th>Kind</th><th>Models</th><th>Status</th><th>Latency (recent)</th></tr></thead>
                <tbody>
                    ${rows || '<tr><td colspan="6" class="suite-muted">No providers configured — add one via the gateway admin UI.</td></tr>'}
                </tbody>
            </table>
            <p class="suite-muted">Health dot: green = enabled with credentials · amber = enabled without credentials · gray = disabled. Latency is the mean request duration over the recent ring below.</p>
        </div>`;
}

function healthDot(state, title) {
    const color = state === 'ok' ? 'var(--sysdeck-accent-success)'
        : state === 'warn' ? 'var(--sysdeck-accent-warn)'
        : 'var(--sysdeck-muted)';
    return `<span title="${escapeHtml(title || '')}" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}"></span>`;
}

// ── virtual keys table ──────────────────────────────────────────────

function renderVkeys(vkeysResp, analyticsResp) {
    const vkeys = listVkeys(vkeysResp);
    if (vkeys == null) {
        const msg = (vkeysResp && vkeysResp.error)
            ? vkeysResp.error
            : 'virtual key list unavailable';
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Virtual Keys</h3>
                <p class="suite-card-body suite-muted">${escapeHtml(msg)}</p>
            </div>`;
    }

    // 24h attribution join from the analytics rollup (by virtual key).
    const byKey = new Map();
    if (analyticsResp && analyticsResp.ok !== false && Array.isArray(analyticsResp.byVirtualKey)) {
        for (const v of analyticsResp.byVirtualKey) {
            if (v && v.virtualKeyId != null) byKey.set(String(v.virtualKeyId), v);
        }
    }

    const rows = vkeys.map((k) => {
        const stats = byKey.get(String(k.id));
        const scope = k.teamId
            ? `team ${escapeHtml(k.teamId)}`
            : (k.allowedProviders || k.allowedModels)
                ? `${n((k.allowedProviders || []).length)} providers · ${n((k.allowedModels || []).length)} models`
                : 'unrestricted';
        const rl = k.rateLimit
            ? `${n(k.rateLimit.maxRequests)} / ${fmtWindowMs(k.rateLimit.windowMs)}`
            : '—';
        return `<tr>
            <td>${escapeHtml(k.name || k.id)}${k.tokenHint ? ` <span class="suite-muted suite-mono">…${escapeHtml(k.tokenHint)}</span>` : ''}</td>
            <td class="suite-muted">${scope}</td>
            <td class="suite-mono">${stats ? n(stats.requests) : '—'}</td>
            <td class="suite-mono">${stats ? n(stats.totalTokens) : '—'}</td>
            <td class="suite-mono">${stats ? fmtUsd(stats.costMicroUsd) : '—'}</td>
            <td class="suite-mono">${rl}</td>
            <td>${k.enabled !== false ? '<span class="suite-badge success">enabled</span>' : '<span class="suite-badge">disabled</span>'}</td>
        </tr>`;
    }).join('');

    return `
        <div class="suite-card">
            <h3 class="suite-card-title">Virtual Keys</h3>
            <table class="suite-table">
                <thead><tr><th>Key</th><th>Team / scope</th><th>Requests 24h</th><th>Tokens 24h</th><th>Cost 24h</th><th>Rate limit</th><th>State</th></tr></thead>
                <tbody>
                    ${rows || '<tr><td colspan="7" class="suite-muted">No virtual keys — create one via the gateway admin UI.</td></tr>'}
                </tbody>
            </table>
            <p class="suite-muted">Requests / tokens / cost columns come from the 24h analytics rollup; they show — when the gateway has no keyed traffic yet. Token values are never stored or shown — only the last-4 hint.</p>
        </div>`;
}

// ── recent requests table ───────────────────────────────────────────

function renderLogs(logsResp) {
    const logs = listLogs(logsResp);
    if (logs == null) {
        const msg = (logsResp && logsResp.error)
            ? logsResp.error
            : 'request log unavailable';
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Recent Requests</h3>
                <p class="suite-card-body suite-muted">${escapeHtml(msg)}</p>
            </div>`;
    }

    const rows = logs.map((r) => {
        const tokens = (r.promptTokens != null || r.completionTokens != null)
            ? `${n(r.promptTokens)} / ${n(r.completionTokens)}`
            : '—';
        const cost = r.costMicroUsd != null ? fmtUsd(r.costMicroUsd) : '—';
        const cache = r.cacheHit === true ? '<span class="suite-badge info">hit</span>'
            : r.cacheHit === false ? '<span class="suite-badge">miss</span>'
            : '—';
        return `<tr>
            <td class="suite-muted">${escapeHtml(fmtIsoTime(r.ts))}</td>
            <td class="suite-table-mono">${escapeHtml(r.model || '—')}</td>
            <td class="suite-table-mono">${escapeHtml(r.provider || '—')}</td>
            <td class="suite-mono">${tokens}</td>
            <td class="suite-mono">${cost}</td>
            <td class="suite-mono">${Number.isFinite(Number(r.durationMs)) ? fmtMs(r.durationMs) : '—'}</td>
            <td class="suite-mono">${statusBadge(r.status)}</td>
            <td>${cache}</td>
        </tr>`;
    }).join('');

    return `
        <div class="suite-card">
            <h3 class="suite-card-title">Recent Requests</h3>
            <table class="suite-table">
                <thead><tr><th>Time</th><th>Model</th><th>Provider</th><th>Tokens in/out</th><th>Cost</th><th>Latency</th><th>Status</th><th>Cache</th></tr></thead>
                <tbody>
                    ${rows || '<tr><td colspan="8" class="suite-muted">No requests recorded yet.</td></tr>'}
                </tbody>
            </table>
            <p class="suite-muted">Last ${logs.length} requests from the gateway's in-memory ring (FROSTY_LOG_STORE=pg enables the durable audit trail). Costs are micro-USD upstream, shown here in USD.</p>
        </div>`;
}

// ── model catalog ───────────────────────────────────────────────────

function renderModels(modelsResp) {
    if (!modelsResp) return '';
    if (modelsResp.ok === false || modelsResp.error) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Model Catalog</h3>
                <p class="suite-card-body suite-muted">${escapeHtml(modelsResp.error || 'model catalog unavailable')}</p>
            </div>`;
    }
    const data = Array.isArray(modelsResp.data) ? modelsResp.data : [];
    const rows = data.map((m) => `<tr>
        <td class="suite-table-mono">${escapeHtml(m.id)}</td>
        <td class="suite-table-mono">${escapeHtml(m.owned_by || '—')}</td>
    </tr>`).join('');
    return `
        <div class="suite-card">
            <h3 class="suite-card-title">Model Catalog</h3>
            <table class="suite-table">
                <thead><tr><th>Model</th><th>Provider</th></tr></thead>
                <tbody>
                    ${rows || '<tr><td colspan="2" class="suite-muted">No models enabled — add provider accounts with models.</td></tr>'}
                </tbody>
            </table>
            <p class="suite-muted">GET /v1/models — the aggregated enabled set, ids prefixed <code>account/model</code>.</p>
        </div>`;
}

// ── local stack wiring card (probed; independent of the gateway) ────

function renderLocalStackLoading() {
    return `
        <div class="suite-card">
            <h3 class="suite-card-title">Local stack wiring</h3>
            <p class="suite-card-body suite-muted">probing local AI backends (0.4s timeout each)…</p>
        </div>`;
}

function renderLocalStackError(message) {
    return `
        <div class="suite-card">
            <h3 class="suite-card-title">Local stack wiring</h3>
            <p class="suite-card-body suite-mono">${escapeHtml(message)}</p>
        </div>`;
}

function renderLocalStack(data) {
    const backends = Array.isArray(data.backends) ? data.backends : [];
    const reachable = Number(data.reachable) || 0;
    const envLines = backends.filter((b) => b.env_wiring).map((b) => b.env_wiring).join('\n');
    const rows = backends.map((b) => {
        const up = !!b.reachable;
        return `<tr>
            <td>${healthDot(up ? 'ok' : 'off', up ? 'answered /v1/models' : 'no answer on this host')}</td>
            <td class="suite-table-mono" title="${escapeHtml(b.note || '')}">${escapeHtml(b.name)}</td>
            <td>${escapeHtml(b.provider_type)}</td>
            <td class="suite-mono suite-table-mono">${escapeHtml(b.base_url)}</td>
            <td class="suite-mono">${up ? 'up · ' + n(b.latency_ms) + 'ms' : 'offline'}</td>
            <td class="suite-muted">${escapeHtml(b.caps)}</td>
        </tr>`;
    }).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Local stack wiring</h3>
                <div class="suite-row" style="gap:0.5rem">
                    <span class="suite-badge ${reachable > 0 ? 'success' : ''}">${reachable}/${n(data.count)} reachable</span>
                    <button class="suite-btn" id="btn-klanker-reprobe">↻ Re-probe</button>
                </div>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted">klanker-gate is <strong>not SaaS-only</strong>: ollama, LM Studio and SGLang are native keyless provider types; llama.cpp (llama-server), KoboldCpp and vLLM plug in through the generic <code>openai-compatible</code> type — the whole inference stack can run local, keyless, zero marginal cost. Rows are live probes of each backend's <code>/v1/models</code> from this host.</p>
                <table class="suite-table">
                    <thead><tr><th></th><th>Backend</th><th>Provider type</th><th>Base URL (probed)</th><th>Status</th><th>Capabilities</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                <div class="suite-row" style="gap:0.75rem;flex-wrap:wrap;margin-top:0.75rem">
                    <div style="flex:1;min-width:260px">
                        <div class="suite-row-between" style="margin-bottom:0.25rem">
                            <span class="suite-muted">env wiring (gateway .env)</span>
                            <button class="suite-btn klanker-copy-btn" data-code="${escapeHtml(envLines)}">copy</button>
                        </div>
                        <pre class="suite-mono suite-muted" style="white-space:pre-wrap;font-size:0.75rem;max-height:8rem;overflow:auto">${escapeHtml(envLines)}</pre>
                    </div>
                    <div style="flex:1;min-width:260px">
                        <div class="suite-row-between" style="margin-bottom:0.25rem">
                            <span class="suite-muted">admin API — llama.cpp + koboldcpp accounts</span>
                            <button class="suite-btn klanker-copy-btn" data-code="${escapeHtml(data.admin_register_example || '')}">copy</button>
                        </div>
                        <pre class="suite-mono suite-muted" style="white-space:pre-wrap;font-size:0.75rem;max-height:8rem;overflow:auto">${escapeHtml(data.admin_register_example || '')}</pre>
                    </div>
                </div>
                <p class="suite-muted" style="font-size:0.75rem">Env registers one account per type; to run llama.cpp <em>and</em> koboldcpp side by side, register each via POST /api/providers, then refresh-models auto-discovers its catalog. Port note: llama-server defaults to :8080 — the gateway's own port — so run it elsewhere (8081 here) or move the gateway.</p>
            </div>
        </div>`;
}

async function fetchLocalStack(ctx) {
    const el = ctx.panel.querySelector('#klanker-localstack');
    if (!el) return;
    el.innerHTML = renderLocalStackLoading();
    let res = null;
    let err = null;
    try {
        res = await ctx.bridge.klanker.localstack();
    } catch (e) {
        err = e;
    }
    if (err || !res || res.ok === false) {
        el.innerHTML = renderLocalStackError(errMessage(err, res));
        return;
    }
    el.innerHTML = renderLocalStack(res);
    wireLocalStackCard(ctx);
}

function wireLocalStackCard(ctx) {
    const { panel } = ctx;
    panel.querySelector('#btn-klanker-reprobe')?.addEventListener('click', () => {
        fetchLocalStack(ctx);
    });
    panel.querySelectorAll('.klanker-copy-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const code = btn.getAttribute('data-code') || '';
            try {
                await navigator.clipboard.writeText(code);
                const label = btn.textContent;
                btn.textContent = 'copied';
                setTimeout(() => { btn.textContent = label; }, 1600);
            } catch (e) {
                btn.textContent = 'select & copy';
            }
        });
    });
}

// ── service control card ────────────────────────────────────────────

function renderServiceCard() {
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Service — <code>klanker-gate.service</code></h3>
                <div class="suite-row" style="gap:0.5rem">
                    <button class="suite-btn" id="btn-klanker-start">▶ Start</button>
                    <button class="suite-btn" id="btn-klanker-stop">■ Stop</button>
                    <button class="suite-btn" id="btn-klanker-restart">↻ Restart</button>
                </div>
            </div>
            <div class="suite-card-body">
                <div class="suite-row-between">
                    <span class="suite-muted">systemd unit: <span class="suite-mono" id="klanker-unit-state">…</span></span>
                    <span class="suite-muted">Actions run via systemctl through the cockpit superuser channel.</span>
                </div>
                <div class="suite-muted suite-mono" id="klanker-service-result" style="margin-top:0.5rem"></div>
            </div>
        </div>`;
}

function wireServiceCard(ctx) {
    const { panel } = ctx;

    panel.querySelector('#btn-klanker-start')?.addEventListener('click', () => {
        doService(ctx, 'start');
    });
    panel.querySelector('#btn-klanker-stop')?.addEventListener('click', () => {
        // Destructive action — confirm first (house pattern from
        // builder.js import confirm).
        const go = window.confirm(
            'Stop the klanker-gate service?\n\n' +
            'All in-flight inference requests will be dropped and the\n' +
            'gateway will stop serving until started again.'
        );
        if (go) doService(ctx, 'stop');
    });
    panel.querySelector('#btn-klanker-restart')?.addEventListener('click', () => {
        doService(ctx, 'restart');
    });
}

async function doService(ctx, action) {
    const result = ctx.panel.querySelector('#klanker-service-result');
    const buttons = ['start', 'stop', 'restart'].map((a) =>
        ctx.panel.querySelector(`#btn-klanker-${a}`));
    buttons.forEach((b) => { if (b) b.disabled = true; });
    if (result) result.textContent = `${action} requested…`;
    let res = null;
    let err = null;
    try {
        res = await ctx.bridge.klanker.service(action);
    } catch (e) {
        err = e;
    }
    const msg = err ? `${action} failed: ${errMessage(err, null)}`
        : (res && res.ok) ? `${action} ok`
        : `${action} failed: ${(res && (res.stderr || res.error)) || 'unknown error'}`;
    if (result) result.textContent = msg;
    buttons.forEach((b) => { if (b) b.disabled = false; });
    // Refresh the unit state + data right away so the panel reflects
    // the new service reality immediately.
    await refreshUnitState(ctx);
    refreshNow(ctx);
}

async function refreshUnitState(ctx) {
    const el = ctx.panel.querySelector('#klanker-unit-state');
    if (!el) return;
    let res = null;
    try {
        res = await ctx.bridge.klanker.service('status');
    } catch {
        res = null;
    }
    if (res && res.ok) {
        el.textContent = `${res.active || 'unknown'} (${res.sub || 'unknown'}) · ${res.enabled || 'unknown'} at boot`;
    } else {
        el.textContent = (res && res.error) ? res.error : 'unknown';
    }
}

// ── journal viewer ──────────────────────────────────────────────────

function renderJournalCard() {
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Journal — <code>klanker-gate</code></h3>
                <div class="suite-row" style="gap:0.5rem">
                    <select class="suite-input" id="klanker-journal-lines">
                        <option value="40" selected>40 lines</option>
                        <option value="100">100 lines</option>
                        <option value="200">200 lines</option>
                    </select>
                    <button class="suite-btn suite-btn-ghost" id="btn-klanker-journal">↻ Load journal</button>
                </div>
            </div>
            <pre class="suite-mono" id="klanker-journal-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:360px;min-height:60px;color:var(--sysdeck-muted)">(journal not loaded yet)</pre>
        </div>`;
}

function wireJournalCard(ctx) {
    const { panel } = ctx;
    panel.querySelector('#btn-klanker-journal')?.addEventListener('click', () => {
        loadJournal(ctx);
    });
    // Load once on layout so the viewer has content immediately.
    loadJournal(ctx);
}

async function loadJournal(ctx) {
    const pre = ctx.panel.querySelector('#klanker-journal-pre');
    if (!pre) return;
    const select = ctx.panel.querySelector('#klanker-journal-lines');
    const lines = Number(select?.value || '40');
    pre.textContent = `loading journal (${lines} lines)…`;
    let res = null;
    let err = null;
    try {
        res = await ctx.bridge.klanker.journal(lines);
    } catch (e) {
        err = e;
    }
    if (err) {
        pre.textContent = `journal failed: ${errMessage(err, null)}`;
        return;
    }
    if (res && res.ok) {
        pre.textContent = res.log || '(no journal entries)';
    } else {
        pre.textContent = `journal failed: ${(res && (res.stderr || res.error)) || 'unknown error'}`;
    }
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
    return 'klanker-gate service unreachable';
}

function listProviders(resp) {
    if (!resp || resp.ok === false || resp.error) return null;
    return Array.isArray(resp.providers) ? resp.providers : [];
}

function listVkeys(resp) {
    if (!resp || resp.ok === false || resp.error) return null;
    return Array.isArray(resp.virtualKeys) ? resp.virtualKeys : [];
}

function listLogs(resp) {
    if (!resp || resp.ok === false || resp.error) return null;
    return Array.isArray(resp.logs) ? resp.logs : [];
}

function analyticsTotals(resp) {
    if (!resp || resp.ok === false || resp.error || !resp.totals) {
        return { requests: 0, costMicroUsd: 0, cacheHits: 0, cacheMisses: 0 };
    }
    return resp.totals;
}

function wireStatus(ctx) {
    const { panel } = ctx;
    panel.querySelector('#btn-klanker-refresh')?.addEventListener('click', () => {
        refreshNow(ctx);
    });
}

function n(v) {
    const num = Number(v);
    return Number.isFinite(num) ? num : 0;
}

function fmtNum(v, digits) {
    const num = Number(v);
    return Number.isFinite(num) ? num.toFixed(digits) : '—';
}

/** micro-USD (the repo-wide cost unit) → "$X.XXXX". */
function fmtUsd(microUsd) {
    const num = Number(microUsd);
    if (!Number.isFinite(num)) return '—';
    return '$' + (num / 1e6).toFixed(4);
}

function fmtHitRate(hits, misses) {
    const h = Number(hits), m = Number(misses);
    if (!Number.isFinite(h) || !Number.isFinite(m) || (h + m) === 0) return '—';
    return ((h / (h + m)) * 100).toFixed(1) + '%';
}

function fmtMs(v) {
    const num = Number(v);
    if (!Number.isFinite(num)) return '—';
    if (num >= 1000) return (num / 1000).toFixed(2) + ' s';
    return Math.round(num) + ' ms';
}

function fmtWindowMs(ms) {
    const num = Number(ms);
    if (!Number.isFinite(num) || num <= 0) return '—';
    if (num % 86_400_000 === 0) return (num / 86_400_000) + 'd';
    if (num % 3_600_000 === 0) return (num / 3_600_000) + 'h';
    if (num % 60_000 === 0) return (num / 60_000) + 'm';
    if (num % 1000 === 0) return (num / 1000) + 's';
    return num + ' ms';
}

function fmtIsoTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleTimeString();
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

function statusBadge(status) {
    const num = Number(status);
    if (!Number.isFinite(num)) return '<span class="suite-badge">—</span>';
    const cls = num >= 200 && num < 300 ? 'suite-badge success'
        : num >= 400 ? 'suite-badge danger'
        : 'suite-badge warn';
    return `<span class="${cls}">${num}</span>`;
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
