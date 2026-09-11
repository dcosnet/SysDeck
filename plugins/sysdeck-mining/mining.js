/*
 * SysDeck - Mining Dashboard Panel (v0.0.34)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * v0.0.34 EXPANDED TO 1999 POWER-TOOL STYLE. Per user directive:
 * "themes and mining they need to be expanded for maximum ui
 * control. think 1999 power tool style here." The Mining Dashboard
 * panel surfaces every XMRig REST API knob:
 *
 *   - Summary stats         total hashrate, pool URL, uptime.
 *   - Per-thread hashrate   table of thread index → hashrate, with
 *                            pause/resume buttons per worker.
 *   - Pool configuration    form to set pool URL / username /
 *                            password via PUT /1/config.
 *   - Thread configuration  number input for thread count, write via
 *                            PUT /1/config.
 *   - Algorithm picker      select dropdown with 7 algorithm presets
 *                            (RandomX, RandomWOW, RandomARQ, etc.)
 *   - Service controls      start / stop / restart xmrig.service via
 *                            systemctl under the cockpit superuser
 *                            channel (polkit org.sysdeck.system.modify).
 *   - Pause / resume all    instant pause/resume of all workers
 *                            via XMRig JSON-RPC.
 *
 * Mutating ops run via the cockpit superuser channel. No `sudo`
 * shell-out from JS. XMRig is GPL-3.0 licensed by the XMRig project.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    // Fire all the read-only calls in parallel.
    const [summary, threads, poolCfg, threadsCfg, algoCfg, svcStatus] = await Promise.all([
        safe(bridge.mining.workers(), null),
        safe(bridge.mining.threads(), {}),
        safe(bridge.mining.poolConfigGet(), {}),
        safe(bridge.mining.threadsConfigGet(), {}),
        safe(bridge.mining.algorithmGet(), {}),
        safe(bridge.mining.serviceStatus(), {}),
    ]);

    if (!summary) {
        panel.innerHTML = renderXmrigUnreachable(svcStatus);
        wireServiceControls(panel, { bridge, EventBus });
        return;
    }

    const hashrate = summary.hashrate?.total?.[0] ?? 0;
    const poolUrl = summary.pool?.url ?? '—';
    const uptime = summary.uptime ?? 0;
    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Mining Dashboard</h2>
            <p class="suite-panel-subtitle">
                XMRig v${escapeHtml(summary.version ?? '—')}
                · <span class="suite-badge ${svcStatus?.active ? 'success' : 'warn'}">${escapeHtml(svcStatus?.state || '?')}</span>
                · ${threads.thread_count ?? 0} threads
                · ${formatHashrate(hashrate)}
            </p>
        </header>

        ${renderSummaryStats(hashrate, poolUrl, uptime, summary)}

        ${renderServiceControls(svcStatus)}

        ${renderAllControls()}

        ${renderPerThreadTable(threads)}

        ${renderPoolConfigForm(poolCfg)}

        ${renderThreadsConfigForm(threadsCfg)}

        ${renderAlgorithmPicker(algoCfg)}

        <div class="suite-card" id="mining-output-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title" id="mining-output-title">Operation Output</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-mining-output-close">✕</button>
            </div>
            <pre class="suite-mono" id="mining-output-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:400px"></pre>
        </div>
    `;

    wireEvents(panel, { bridge, EventBus });
    EventBus.emit('mining.loaded', { hashrate, threadCount: threads.thread_count });
}

// ── Summary stats ───────────────────────────────────────────────────

function renderSummaryStats(hashrate, poolUrl, uptime, summary) {
    return `
        <div class="suite-grid cols-3">
            <div class="suite-card">
                <h3 class="suite-card-title">Total Hashrate</h3>
                <div class="suite-stat-value" style="color:var(--sysdeck-accent)">
                    ${formatHashrate(hashrate).split(' ')[0]}<span style="font-size:14px;color:var(--sysdeck-muted)"> ${formatHashrate(hashrate).split(' ').slice(1).join(' ')}</span>
                </div>
            </div>
            <div class="suite-card">
                <h3 class="suite-card-title">Pool</h3>
                <div class="suite-card-body suite-mono">${escapeHtml(poolUrl)}</div>
            </div>
            <div class="suite-card">
                <h3 class="suite-card-title">Uptime</h3>
                <div class="suite-card-body suite-mono">${formatUptime(uptime)}</div>
            </div>
        </div>
        <div class="suite-card">
            <p class="suite-muted" style="font-size:0.85rem">
                ${summary.results?.times_full ?? 0} accepted shares · ${summary.results?.times_rejected ?? 0} rejected ·
                pool latency ${summary.results?.best_time ?? '—'}s ·
                diff ${summary.results?.diff_current ?? '—'}
            </p>
        </div>
    `;
}

// ── Service controls ────────────────────────────────────────────────

function renderServiceControls(svcStatus) {
    const active = svcStatus?.active === true;
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">xmrig.service</h3>
                <span class="suite-badge ${active ? 'success' : 'warn'}">${escapeHtml(svcStatus?.state || 'unknown')}</span>
            </div>
            <div class="suite-card-body">
                <div class="suite-row" style="gap:0.5rem">
                    <button class="suite-btn ${active ? '' : 'suite-btn-primary'}" id="btn-mining-start" ${active ? 'disabled' : ''}>▶ Start</button>
                    <button class="suite-btn" id="btn-mining-stop" ${!active ? 'disabled' : ''}>■ Stop</button>
                    <button class="suite-btn" id="btn-mining-restart" ${!active ? 'disabled' : ''}>↻ Restart</button>
                    <button class="suite-btn suite-btn-ghost" id="btn-mining-refresh">↻ Refresh</button>
                </div>
                <p class="suite-muted" style="font-size:0.85rem;margin-top:0.5rem">
                    Start / Stop / Restart run <code>systemctl</code> on <code>xmrig.service</code> via the cockpit
                    superuser channel (polkit <code>org.sysdeck.system.modify</code>). No <code>sudo</code> shell-out.
                </p>
            </div>
        </div>
    `;
}

// ── All-workers controls (pause / resume) ──────────────────────────

function renderAllControls() {
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">All Workers</h3>
            </div>
            <div class="suite-card-body">
                <div class="suite-row" style="gap:0.5rem">
                    <button class="suite-btn" id="btn-mining-pause-all">⏸ Pause all</button>
                    <button class="suite-btn suite-btn-primary" id="btn-mining-resume-all">▶ Resume all</button>
                </div>
                <p class="suite-muted" style="font-size:0.85rem;margin-top:0.5rem">
                    Pause/Resume calls the XMRig JSON-RPC <code>paused</code> / <code>resumed</code> methods — no
                    service restart required. The workers stop hashing immediately and resume on the same pool.
                </p>
            </div>
        </div>
    `;
}

// ── Per-thread hashrate table ───────────────────────────────────────

function renderPerThreadTable(threads) {
    if (!threads?.available) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Per-Thread Hashrate</h3>
                <p class="suite-muted">${escapeHtml(threads?.reason || 'XMRig REST API not reachable')}</p>
            </div>
        `;
    }
    const list = threads.threads || [];
    const max = Math.max(1, ...list.map((t) => t.hashrate || 0));
    const rows = list.map((t) => {
        const pct = max > 0 ? Math.round((t.hashrate / max) * 100) : 0;
        return `
            <tr>
                <td class="suite-table-mono">#${t.index}</td>
                <td class="suite-mono">${formatHashrate(t.hashrate)}</td>
                <td>
                    <div class="suite-progress" style="width:200px">
                        <div class="suite-progress-bar" style="width:${pct}%"></div>
                    </div>
                </td>
                <td>
                    <button class="suite-btn suite-btn-ghost btn-pause-worker" data-id="${t.index}">⏸</button>
                    <button class="suite-btn suite-btn-ghost btn-resume-worker" data-id="${t.index}">▶</button>
                </td>
            </tr>
        `;
    }).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Per-Thread Hashrate (${list.length})</h3>
            </div>
            <table class="suite-table">
                <thead><tr><th>Thread</th><th>Hashrate</th><th>Share of max</th><th>Actions</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="4" class="suite-muted">No thread data.</td></tr>'}</tbody>
            </table>
        </div>
    `;
}

// ── Pool configuration form ────────────────────────────────────────

function renderPoolConfigForm(poolCfg) {
    if (!poolCfg?.available) {
        return `<div class="suite-card"><p class="suite-muted">Pool config unreachable.</p></div>`;
    }
    const current = (poolCfg.pools || [])[0] || {};
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Pool Configuration</h3>
            </div>
            <div class="suite-card-body">
                <div class="suite-row" style="gap:0.5rem">
                    <input type="text" class="suite-input" id="mining-pool-url" placeholder="pool URL (e.g. monero.hero.hashvault.pro:3333)" value="${escapeHtml(current.url || '')}" style="flex:3" />
                    <input type="text" class="suite-input" id="mining-pool-user" placeholder="wallet address" value="${escapeHtml(current.user || '')}" style="flex:2" />
                    <input type="password" class="suite-input" id="mining-pool-pass" placeholder="password (or 'x')" value="${escapeHtml(current.pass || '')}" style="flex:1" />
                    <button class="suite-btn suite-btn-primary" id="btn-mining-pool-set">Apply</button>
                </div>
                <p class="suite-muted" style="font-size:0.85rem;margin-top:0.5rem">
                    Applies via PUT /1/config — XMRig reloads the config live without restarting the daemon.
                </p>
            </div>
        </div>
    `;
}

// ── Thread count form ───────────────────────────────────────────────

function renderThreadsConfigForm(threadsCfg) {
    if (!threadsCfg?.available) {
        return `<div class="suite-card"><p class="suite-muted">Threads config unreachable.</p></div>`;
    }
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Thread Count</h3>
            </div>
            <div class="suite-card-body">
                <div class="suite-row" style="gap:0.5rem">
                    <input type="number" class="suite-input" id="mining-threads-count" min="1" max="256" value="${threadsCfg.thread_count ?? 1}" style="width:120px" />
                    <button class="suite-btn suite-btn-primary" id="btn-mining-threads-set">Apply</button>
                </div>
                <p class="suite-muted" style="font-size:0.85rem;margin-top:0.5rem">
                    Current: ${threadsCfg.thread_count ?? '?'} threads · hugepages: ${threadsCfg.hugepages ? 'on' : 'off'} ·
                    hw-aes: ${threadsCfg.hw_aes ? 'on' : 'off'} · priority: ${threadsCfg.priority ?? 'default'}.
                    Changing the count triggers a live reload — XMRig re-spawns the worker threads without a service restart.
                </p>
            </div>
        </div>
    `;
}

// ── Algorithm picker ───────────────────────────────────────────────

function renderAlgorithmPicker(algoCfg) {
    if (!algoCfg?.available) {
        return `<div class="suite-card"><p class="suite-muted">Algorithm config unreachable.</p></div>`;
    }
    const presets = algoCfg.presets || [];
    const current = algoCfg.current || '';
    const options = presets.map((p) =>
        `<option value="${escapeHtml(p.id)}" ${p.value === current ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
    ).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Algorithm</h3>
                <span class="suite-badge info">current: ${escapeHtml(current || 'auto')}</span>
            </div>
            <div class="suite-card-body">
                <div class="suite-row" style="gap:0.5rem">
                    <select class="suite-input" id="mining-algo-select" style="flex:1">${options}</select>
                    <button class="suite-btn suite-btn-primary" id="btn-mining-algo-set">Apply</button>
                </div>
                <p class="suite-muted" style="font-size:0.85rem;margin-top:0.5rem">
                    Force a specific RandomX variant if the auto-detect picks the wrong one. Applies via PUT /1/config.
                </p>
            </div>
        </div>
    `;
}

// ── XMRig unreachable card ─────────────────────────────────────────

function renderXmrigUnreachable(svcStatus) {
    return `
        <header>
            <h2 class="suite-panel-title">Mining Dashboard</h2>
            <p class="suite-panel-subtitle">
                XMRig REST API
                · <span class="suite-badge ${svcStatus?.active ? 'success' : 'danger'}">${escapeHtml(svcStatus?.state || 'not running')}</span>
            </p>
        </header>
        <div class="suite-card">
            <h3 class="suite-card-title">XMRig Unavailable</h3>
            <div class="suite-card-body">
                <p class="suite-muted">
                    The XMRig REST API at <code>http://127.0.0.1:18088</code> is not reachable.
                    Start <code>xmrig.service</code> below, or install XMRig if absent.
                </p>
                <p class="suite-muted" style="margin-top:0.5rem">
                    Arch: <code>pacman -S xmrig</code> · Debian: <code>apt install xmrig</code> · Fedora: build from source (no official package).
                    XMRig needs <code>--http-host 127.0.0.1 --http-port 18088</code> in its systemd unit
                    for the REST API to be reachable.
                </p>
            </div>
        </div>
        ${renderServiceControls(svcStatus)}
    `;
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }) {
    const outputCard = panel.querySelector('#mining-output-card');
    const outputPre = panel.querySelector('#mining-output-pre');
    const outputTitle = panel.querySelector('#mining-output-title');
    const showOutput = (title, text, isError = false) => {
        if (!outputCard || !outputPre) return;
        outputCard.style.display = 'block';
        outputTitle.textContent = title;
        outputPre.textContent = text;
        outputPre.style.color = isError ? 'var(--sysdeck-accent-danger)' : 'var(--sysdeck-fg)';
    };
    panel.querySelector('#btn-mining-output-close')?.addEventListener('click', () => {
        if (outputCard) outputCard.style.display = 'none';
    });

    // Service controls.
    const serviceOp = async (op, label, okKey) => {
        showOutput(`${label} xmrig.service`, `${label} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.mining[op]();
            const ok = r[okKey] ?? (r.rc === 0);
            showOutput(`${label} xmrig.service — ${ok ? 'success' : 'failed'}`,
                       `rc=${r.rc}\noutput: ${r.output || '(empty)'}\nstderr: ${r.stderr || '(empty)'}`,
                       !ok);
            if (ok) setTimeout(() => mount(panel, { bridge, EventBus }), 1000);
        } catch (err) {
            showOutput(`${label} xmrig.service — error`, String(err.message || err), true);
        }
    };
    panel.querySelector('#btn-mining-start')?.addEventListener('click', () => serviceOp('start', 'Start', 'started'));
    panel.querySelector('#btn-mining-stop')?.addEventListener('click', () => serviceOp('stop', 'Stop', 'stopped'));
    panel.querySelector('#btn-mining-restart')?.addEventListener('click', () => serviceOp('restart', 'Restart', 'restarted'));
    panel.querySelector('#btn-mining-refresh')?.addEventListener('click', () => mount(panel, { bridge, EventBus }));

    // All-workers controls.
    panel.querySelector('#btn-mining-pause-all')?.addEventListener('click', async () => {
        showOutput('Pause all', 'Pausing all workers via XMRig JSON-RPC ...');
        try {
            const r = await bridge.mining.pause();
            showOutput(`Pause all — ${r.paused ? 'success' : 'failed'}`, JSON.stringify(r, null, 2), !r.paused);
        } catch (err) { showOutput('Pause all — error', String(err.message || err), true); }
    });
    panel.querySelector('#btn-mining-resume-all')?.addEventListener('click', async () => {
        showOutput('Resume all', 'Resuming all workers via XMRig JSON-RPC ...');
        try {
            const r = await bridge.mining.resume();
            showOutput(`Resume all — ${r.resumed ? 'success' : 'failed'}`, JSON.stringify(r, null, 2), !r.resumed);
        } catch (err) { showOutput('Resume all — error', String(err.message || err), true); }
    });

    // Per-worker pause/resume.
    panel.querySelectorAll('.btn-pause-worker').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = parseInt(btn.dataset.id, 10);
            showOutput(`Pause worker ${id}`, `Pausing worker ${id} ...`);
            try {
                const r = await bridge.mining.pauseWorker(id);
                showOutput(`Pause worker ${id} — ${r.paused ? 'success' : 'failed'}`, JSON.stringify(r, null, 2), !r.paused);
            } catch (err) { showOutput(`Pause worker ${id} — error`, String(err.message || err), true); }
        });
    });
    panel.querySelectorAll('.btn-resume-worker').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = parseInt(btn.dataset.id, 10);
            showOutput(`Resume worker ${id}`, `Resuming worker ${id} ...`);
            try {
                const r = await bridge.mining.resumeWorker(id);
                showOutput(`Resume worker ${id} — ${r.resumed ? 'success' : 'failed'}`, JSON.stringify(r, null, 2), !r.resumed);
            } catch (err) { showOutput(`Resume worker ${id} — error`, String(err.message || err), true); }
        });
    });

    // Pool config.
    panel.querySelector('#btn-mining-pool-set')?.addEventListener('click', async () => {
        const url = panel.querySelector('#mining-pool-url')?.value?.trim();
        const user = panel.querySelector('#mining-pool-user')?.value?.trim();
        const pass = panel.querySelector('#mining-pool-pass')?.value?.trim() || 'x';
        if (!url || !user) {
            showOutput('Set pool', 'Pool URL and wallet address are both required.', true);
            return;
        }
        showOutput('Set pool', `PUT /1/config — pool.url=${url} pool.user=${user} ...`);
        try {
            const r = await bridge.mining.poolConfigSet(url, user, pass);
            showOutput(`Set pool — ${r.set ? 'success' : 'failed'}`, JSON.stringify(r, null, 2), !r.set);
            if (r.set) setTimeout(() => mount(panel, { bridge, EventBus }), 1000);
        } catch (err) { showOutput('Set pool — error', String(err.message || err), true); }
    });

    // Threads config.
    panel.querySelector('#btn-mining-threads-set')?.addEventListener('click', async () => {
        const count = panel.querySelector('#mining-threads-count')?.value;
        if (!count) { showOutput('Set threads', 'Enter a thread count.', true); return; }
        showOutput('Set threads', `PUT /1/config — cpu.threads=${count} ...`);
        try {
            const r = await bridge.mining.threadsConfigSet(count);
            showOutput(`Set threads — ${r.set ? 'success' : 'failed'}`, JSON.stringify(r, null, 2), !r.set);
            if (r.set) setTimeout(() => mount(panel, { bridge, EventBus }), 1000);
        } catch (err) { showOutput('Set threads — error', String(err.message || err), true); }
    });

    // Algorithm.
    panel.querySelector('#btn-mining-algo-set')?.addEventListener('click', async () => {
        const id = panel.querySelector('#mining-algo-select')?.value;
        if (!id) { showOutput('Set algorithm', 'Select an algorithm preset.', true); return; }
        showOutput('Set algorithm', `PUT /1/config — cpu.asm=${id} ...`);
        try {
            const r = await bridge.mining.algorithmSet(id);
            showOutput(`Set algorithm — ${r.set ? 'success' : 'failed'}`, JSON.stringify(r, null, 2), !r.set);
            if (r.set) setTimeout(() => mount(panel, { bridge, EventBus }), 1000);
        } catch (err) { showOutput('Set algorithm — error', String(err.message || err), true); }
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

function formatHashrate(h) {
    if (!h || h <= 0) return '0 H/s';
    if (h >= 1000) return `${(h / 1000).toFixed(2)} kH/s`;
    if (h >= 1) return `${h.toFixed(1)} H/s`;
    return `${h.toFixed(3)} H/s`;
}

function formatUptime(s) {
    if (!s) return '—';
    const min = Math.floor(s / 60);
    if (min < 60) return `${min} min`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ${min % 60}m`;
    const d = Math.floor(hr / 24);
    return `${d}d ${hr % 24}h`;
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderSkeleton() {
    return `<div class="suite-skeleton"><div class="suite-skeleton-line w-1/3"></div></div>`;
}
