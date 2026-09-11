/*
 * SysDeck - Databases Panel (v0.0.33)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * DB Control module — unified control for SQL / NoSQL / vector /
 * time-series / graph / embedded / cloud / AI database engines.
 * The bridge helper bridge/db.py surfaces 32+ engines with
 * summary / status / start / stop / restart / connections / query
 * subcommands.
 *
 * The cockpit-way pattern (v0.0.31+): the bridge runs systemctl
 * directly via subprocess; the JS panel passes { superuser: 'try' }
 * to cockpit.spawn so the cockpit bridge prompts the operator via
 * polkit for the org.sysdeck.db.modify action.
 *
 * The panel surfaces:
 *   - Summary card: total engines, running count, total data size,
 *     total memory, total connections.
 *   - Engines table: per-engine id, name, family, status, version,
 *     port, size, memory, connections, with Start/Stop/Restart
 *     buttons per row.
 *   - Query runner: SQL-family engines only — input a SQL string
 *     and execute against the selected engine.
 *   - Connections viewer: list active TCP connections to an engine.
 *
 * Bridge surface (see shared/bridge.js → bridge.db):
 *   summary()              → {engines, totalEngines, runningCount, ...}
 *   status(id)             → single-engine detail dict
 *   start(id)              → {action, engine, rc, success, output, stderr}
 *   stop(id)               → same shape
 *   restart(id)            → same shape
 *   connections(id)        → {connections, count}
 *   query(id, sql)         → {output, engine, query}
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    let summary = {};
    try {
        summary = await bridge.db.summary();
    } catch (err) {
        panel.innerHTML = renderError(err);
        return;
    }

    const engines = summary.engines || [];
    const running = engines.filter((e) => e.status === 'running');
    const totalSize = summary.totalSizeMB || 0;
    const totalMem = summary.totalMemoryMB || 0;
    const totalConn = summary.totalConnections || 0;

    // Group engines by family for cleaner rendering.
    const byFamily = new Map();
    for (const e of engines) {
        if (!byFamily.has(e.family)) byFamily.set(e.family, []);
        byFamily.get(e.family).push(e);
    }

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Database Control</h2>
            <p class="suite-panel-subtitle">
                ${summary.totalEngines || engines.length} engines across ${byFamily.size} families
                · ${running.length} running
                · ${(totalSize / 1024).toFixed(1)} GB data
                · ${(totalMem / 1024).toFixed(1)} GB memory
                · ${totalConn} connections
            </p>
        </header>

        <div class="suite-row">
            <div class="suite-card suite-col-3">
                <h3 class="suite-card-title">Engines</h3>
                <div class="suite-stat-value">${summary.totalEngines || engines.length}</div>
                <div class="suite-stat-label">total (${byFamily.size} families)</div>
            </div>
            <div class="suite-card suite-col-3">
                <h3 class="suite-card-title">Running</h3>
                <div class="suite-stat-value ${running.length ? 'suite-warn' : ''}">${running.length}</div>
                <div class="suite-stat-label">${running.length ? 'active services' : 'all stopped'}</div>
            </div>
            <div class="suite-card suite-col-3">
                <h3 class="suite-card-title">Data size</h3>
                <div class="suite-stat-value">${(totalSize / 1024).toFixed(1)}</div>
                <div class="suite-stat-label">GB across all engines</div>
            </div>
        </div>

        ${renderEnginesTable(engines, byFamily)}

        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Run SQL Query</h3>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem">
                    SQL-family engines only (postgresql, mysql/mariadb, sqlite, cockroachdb, clickhouse, duckdb).
                    The query is run via the engine's CLI client (<code>psql -tAc</code>, <code>mysql -e</code>, etc.).
                </p>
                <div class="suite-row" style="gap:0.5rem;margin-bottom:0.5rem">
                    <select class="suite-input" id="db-query-engine" style="width:200px">
                        ${engines.filter((e) => e.family === 'sql' || ['clickhouse', 'duckdb', 'timescaledb'].includes(e.id)).map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)}</option>`).join('') || '<option value="">(no SQL engines detected)</option>'}
                    </select>
                    <button class="suite-btn suite-btn-primary" id="btn-db-query">Execute</button>
                    <button class="suite-btn suite-btn-ghost" id="btn-db-connections">List Connections</button>
                </div>
                <textarea class="suite-input" id="db-query-sql" rows="3" placeholder="SELECT * FROM users LIMIT 10;" style="width:100%;font-family:monospace"></textarea>
            </div>
        </div>

        <div class="suite-card" id="db-output-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title" id="db-output-title">Output</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-db-output-close">✕</button>
            </div>
            <pre class="suite-mono" id="db-output-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:400px"></pre>
        </div>

        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Engine Detail</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-db-refresh">↻ Refresh</button>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem">
                    Click ▶/■/↻ on a row above to start / stop / restart an engine.
                    Click 🔍 to view the engine's full status (version, port, data dir,
                    config path, log path, connections, memory).
                </p>
            </div>
        </div>
    `;

    wireEvents(panel, { bridge, EventBus });
    EventBus.emit('db.loaded', { engineCount: engines.length, running: running.length });
}

// ── Render helpers ───────────────────────────────────────────────────

function renderEnginesTable(engines, byFamily) {
    if (!engines.length) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Engines (0)</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">No database engines detected on this host.</p>
                </div>
            </div>
        `;
    }
    // Render a table per family for clearer grouping.
    const cards = [];
    for (const [family, items] of byFamily) {
        const running = items.filter((e) => e.status === 'running').length;
        cards.push(`
            <div class="suite-card">
                <div class="suite-card-header">
                    <h3 class="suite-card-title">${escapeHtml(family)} (${items.length})</h3>
                    <span class="suite-muted" style="font-size:0.85rem">${running} running</span>
                </div>
                <table class="suite-table">
                    <thead><tr><th>Engine</th><th>Status</th><th>Version</th><th>Port</th><th>Size</th><th>Mem</th><th>Conns</th><th>Actions</th></tr></thead>
                    <tbody>
                        ${items.map((e) => `
                            <tr>
                                <td class="suite-table-mono"><strong>${escapeHtml(e.name)}</strong><div class="suite-muted" style="font-size:0.75rem">${escapeHtml(e.id)}</div></td>
                                <td>${statusBadge(e.status)}</td>
                                <td class="suite-muted suite-mono" style="font-size:0.8rem">${escapeHtml((e.version || '').slice(0, 30))}</td>
                                <td class="suite-table-mono">${e.port || '—'}</td>
                                <td class="suite-muted">${formatSize(e.sizeMB)}</td>
                                <td class="suite-muted">${formatSize(e.memoryMB)}</td>
                                <td class="suite-table-mono">${e.connections || 0}</td>
                                <td>
                                    <div class="suite-row" style="gap:0.25rem">
                                        <button class="suite-btn suite-btn-ghost btn-db-start" data-id="${escapeHtml(e.id)}" ${e.status !== 'stopped' ? 'disabled' : ''}>▶</button>
                                        <button class="suite-btn suite-btn-ghost btn-db-stop" data-id="${escapeHtml(e.id)}" ${e.status !== 'running' ? 'disabled' : ''}>■</button>
                                        <button class="suite-btn suite-btn-ghost btn-db-restart" data-id="${escapeHtml(e.id)}" ${e.status !== 'running' ? 'disabled' : ''}>↻</button>
                                        <button class="suite-btn suite-btn-ghost btn-db-status" data-id="${escapeHtml(e.id)}">🔍</button>
                                    </div>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `);
    }
    return cards.join('');
}

function statusBadge(status) {
    const map = {
        'running':     '<span class="suite-badge success">running</span>',
        'starting':    '<span class="suite-badge warn">starting</span>',
        'stopped':     '<span class="suite-badge">stopped</span>',
        'error':       '<span class="suite-badge danger">error</span>',
        'uninstalled': '<span class="suite-badge">uninstalled</span>',
    };
    return map[status] || `<span class="suite-badge">${escapeHtml(status)}</span>`;
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }) {
    const outputCard = panel.querySelector('#db-output-card');
    const outputPre = panel.querySelector('#db-output-pre');
    const outputTitle = panel.querySelector('#db-output-title');
    const showOutput = (title, text, isError = false) => {
        if (!outputCard || !outputPre) return;
        outputCard.style.display = 'block';
        outputTitle.textContent = title;
        outputPre.textContent = text;
        outputPre.style.color = isError ? 'var(--sysdeck-accent-danger)' : 'var(--sysdeck-fg)';
    };
    panel.querySelector('#btn-db-output-close')?.addEventListener('click', () => {
        if (outputCard) outputCard.style.display = 'none';
    });

    const startStopRestart = async (btn, method, label) => {
        const id = btn.dataset.id;
        if (!id) return;
        btn.disabled = true;
        showOutput(`${label} ${id}`, `${label} engine ${id} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.db[method](id);
            const ok = r.success ?? (r.rc === 0);
            showOutput(`${label} ${id} — ${ok ? 'success' : 'failed'}`,
                       `rc=${r.rc}\nsuccess=${ok}\noutput: ${r.output || '(empty)'}\nstderr: ${r.stderr || '(empty)'}`,
                       !ok);
            if (ok) setTimeout(() => mount(panel, { bridge, EventBus }), 1200);
        } catch (err) {
            showOutput(`${label} ${id} — error`, String(err.message || err), true);
        } finally {
            setTimeout(() => { btn.disabled = false; }, 1200);
        }
    };

    panel.querySelectorAll('.btn-db-start').forEach((btn) => {
        btn.addEventListener('click', () => startStopRestart(btn, 'start', 'Start'));
    });
    panel.querySelectorAll('.btn-db-stop').forEach((btn) => {
        btn.addEventListener('click', () => startStopRestart(btn, 'stop', 'Stop'));
    });
    panel.querySelectorAll('.btn-db-restart').forEach((btn) => {
        btn.addEventListener('click', () => startStopRestart(btn, 'restart', 'Restart'));
    });

    panel.querySelectorAll('.btn-db-status').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            showOutput(`Status: ${id}`, 'Loading ...');
            try {
                const r = await bridge.db.status(id);
                if (r.error) { showOutput(`Status: ${id} — error`, r.error, true); return; }
                showOutput(`Status: ${id}`, JSON.stringify(r, null, 2));
            } catch (err) { showOutput(`Status: ${id} — error`, String(err.message || err), true); }
        });
    });

    panel.querySelector('#btn-db-query')?.addEventListener('click', async () => {
        const engineId = panel.querySelector('#db-query-engine')?.value;
        const sql = panel.querySelector('#db-query-sql')?.value?.trim();
        if (!engineId) { showOutput('Query', 'Select an engine first.', true); return; }
        if (!sql) { showOutput('Query', 'Enter a SQL query first.', true); return; }
        showOutput(`Query: ${engineId}`, `Running query on ${engineId} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.db.query(engineId, sql);
            if (r.error) {
                showOutput(`Query: ${engineId} — error`, r.error, true);
            } else {
                showOutput(`Query: ${engineId}`, `query: ${r.query || sql}\n\noutput:\n${r.output || '(empty)'}`);
            }
        } catch (err) { showOutput(`Query: ${engineId} — error`, String(err.message || err), true); }
    });

    panel.querySelector('#btn-db-connections')?.addEventListener('click', async () => {
        const engineId = panel.querySelector('#db-query-engine')?.value;
        if (!engineId) { showOutput('Connections', 'Select an engine first.', true); return; }
        showOutput(`Connections: ${engineId}`, 'Loading ...');
        try {
            const r = await bridge.db.connections(engineId);
            if (r.error) { showOutput(`Connections: ${engineId} — error`, r.error, true); return; }
            const lines = [`count: ${r.count}`];
            for (const c of (r.connections || [])) lines.push(c);
            showOutput(`Connections: ${engineId}`, lines.join('\n'));
        } catch (err) { showOutput(`Connections: ${engineId} — error`, String(err.message || err), true); }
    });

    panel.querySelector('#btn-db-refresh')?.addEventListener('click', () => {
        mount(panel, { bridge, EventBus });
    });
}

// ── Utilities ───────────────────────────────────────────────────────

function formatSize(mb) {
    if (!mb) return '0 MB';
    if (mb < 1024) return `${mb} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
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
        <h3 class="suite-card-title">Database bridge unavailable</h3>
        <p class="suite-card-body suite-muted">${err.message || err}. Ensure the bridge helper is installed at /usr/lib/sysdeck/bridge/db.py.</p>
    </div>`;
}
