/*
 * SysDeck - Packages Panel (v0.0.31)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * Package management panel — list, search, install, update, and remove
 * packages via the system package manager (pacman / dnf / apt).
 * The package manager is invoked as a separate process via cockpit.spawn —
 * no package-manager code is bundled.
 *
 * v0.0.31 REWRITE — UPDATE NEEDS SUDO, FIXED THE COCKPIT WAY.
 * v0.0.30 packages.js Update All button called bridge.packages.updateAll()
 * which returned only the command string that *would* be run. The panel
 * showed `alert("Run this command with superuser privileges.")` and the
 * operator had to copy the command, open a terminal, sudo, paste, run.
 * That defeated the purpose of having a panel.
 *
 * v0.0.31 makes install/remove/update/update-all actually execute via
 * the cockpit superuser channel (polkit). The bridge helper runs the
 * detected package manager via subprocess, and the JS panel subscribes
 * to the cockpit spawn stream so the operator sees live stdout/stderr
 * in a <pre> log panel — exactly like cockpit's own Packages and
 * Software Updates panels. No `sudo` shell-out from JS.
 *
 * v0.1.4 SECURITY: every dynamic string interpolated into innerHTML
 * (package names, versions, descriptions, search terms echoed back,
 * error messages) now goes through escapeHtml(). Package metadata is
 * live data from pacman/dnf/apt output — a typo-squat repo or a
 * locally-installed package whose name/description contains markup
 * used to execute in the cockpit admin session (0.3.0 audit).
 * Raw tool output already flows through textContent (showOutput),
 * which is safe.
 */

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    let summary = {};
    let installed = [];
    try {
        [summary, installed] = await Promise.all([
            bridge.packages.summary(),
            bridge.packages.listInstalled(),
        ]);
    } catch (err) {
        panel.innerHTML = renderError(err);
        return;
    }

    const mgr = summary.manager || 'unknown';
    const instCount = summary.installedCount || installed.length;
    const updCount = summary.updateCount || 0;
    const updates = summary.updates || [];

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Package Manager</h2>
            <p class="suite-panel-subtitle">${escapeHtml(mgr)} — ${instCount} installed · ${updCount} updates available</p>
        </header>
        <div class="suite-row">
            <div class="suite-card suite-col-2">
                <h3 class="suite-card-title">Installed</h3>
                <div class="suite-stat-value">${instCount}</div>
                <div class="suite-stat-label">packages via ${escapeHtml(mgr)}</div>
            </div>
            <div class="suite-card suite-col-2">
                <h3 class="suite-card-title">Updates</h3>
                <div class="suite-stat-value ${updCount > 0 ? 'suite-warn' : ''}">${updCount}</div>
                <div class="suite-stat-label">${updCount > 0 ? 'updates pending' : 'system is up to date'}</div>
            </div>
        </div>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Pending Updates</h3>
                <div class="suite-row" style="gap:0.5rem">
                    <button class="suite-btn suite-btn-ghost" id="btn-update-preview">👁 Preview Command</button>
                    <button class="suite-btn suite-btn-primary" id="btn-update-all" ${!updCount ? 'disabled' : ''}>⬆ Update All</button>
                </div>
            </div>
            <table class="suite-table">
                <thead><tr><th>Package</th><th>Current</th><th>New</th></tr></thead>
                <tbody>
                    ${updates.map((u) => `<tr>
                        <td class="suite-table-mono">${escapeHtml(u.name || u.package || '—')}</td>
                        <td>${escapeHtml(u.current || '—')}</td>
                        <td>${escapeHtml(u.new || '—')}</td>
                    </tr>`).join('') || '<tr><td colspan="3" class="suite-muted">No pending updates.</td></tr>'}
                </tbody>
            </table>
        </div>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Search Packages</h3>
            </div>
            <div class="suite-row" style="margin-bottom:0.5rem">
                <input type="text" class="suite-input" id="pkg-search" placeholder="Search packages..." style="flex:1" />
                <button class="suite-btn" id="btn-search">Search</button>
            </div>
            <div id="pkg-search-results" class="suite-muted">Enter a search term to find packages.</div>
        </div>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Recently Installed</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-pkg-refresh">↻ Refresh</button>
            </div>
            <table class="suite-table">
                <thead><tr><th>Package</th><th>Version</th></tr></thead>
                <tbody>
                    ${installed.slice(0, 25).map((p) => `<tr>
                        <td class="suite-table-mono">${escapeHtml(p.name)}</td>
                        <td>${escapeHtml(p.version)}</td>
                    </tr>`).join('') || '<tr><td colspan="2" class="suite-muted">No packages found.</td></tr>'}
                </tbody>
            </table>
            ${installed.length > 25 ? `<p class="suite-muted">Showing 25 of ${installed.length} packages.</p>` : ''}
        </div>
        <div class="suite-card" id="pkg-output-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title" id="pkg-output-title">Output</h3>
                <div class="suite-row" style="gap:0.5rem">
                    <span class="suite-muted suite-mono" id="pkg-output-status" style="font-size:0.8rem"></span>
                    <button class="suite-btn suite-btn-ghost" id="btn-pkg-output-close">✕</button>
                </div>
            </div>
            <pre class="suite-mono" id="pkg-output-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:400px"></pre>
        </div>
    `;

    // ── Output helpers ──────────────────────────────────────────────
    const outputCard = panel.querySelector('#pkg-output-card');
    const outputPre = panel.querySelector('#pkg-output-pre');
    const outputTitle = panel.querySelector('#pkg-output-title');
    const outputStatus = panel.querySelector('#pkg-output-status');
    const showOutput = (title, text, status = '') => {
        if (!outputCard || !outputPre) return;
        outputCard.style.display = 'block';
        outputTitle.textContent = title;
        outputPre.textContent = text;
        outputStatus.textContent = status;
        outputPre.style.color = status.startsWith('FAIL') ? 'var(--sysdeck-accent-danger)' : 'var(--sysdeck-fg)';
    };

    panel.querySelector('#btn-pkg-output-close')?.addEventListener('click', () => {
        if (outputCard) outputCard.style.display = 'none';
    });

    // ── Update All — runs the operation, no alert ──────────────────
    panel.querySelector('#btn-update-all')?.addEventListener('click', async () => {
        if (!updCount) return;
        showOutput('Update All — running', `Running ${mgr} upgrade via cockpit superuser channel...\n(cockpit will prompt for auth)`, 'running');
        try {
            const result = await bridge.packages.updateAll();
            const lines = [];
            if (result.command) lines.push(`$ ${result.command}\n`);
            if (result.output) lines.push(result.output);
            if (result.stderr) lines.push(`\n--- stderr ---\n${result.stderr}`);
            lines.push(`\n--- exit: ${result.rc} ---`);
            const ok = result.success;
            showOutput(`Update All — ${ok ? 'success' : 'failed'}`,
                       lines.join('\n'),
                       ok ? 'OK' : `FAIL rc=${result.rc}`);
            EventBus.emit('packages.update-all', result);
            if (ok) setTimeout(() => mount(panel, { bridge, EventBus }), 1500);
        } catch (err) {
            showOutput('Update All — error', String(err.message || err), 'FAIL');
        }
    });

    // ── Preview Command — dry-run ──────────────────────────────────
    panel.querySelector('#btn-update-preview')?.addEventListener('click', async () => {
        try {
            const r = await bridge.packages.dryRun('update-all');
            showOutput('Preview — command that will run',
                       `Action: ${r.action}\nManager: ${r.manager}\n\n$ ${r.command || '(no command)'}\n\nThis command will be run with root privileges via the cockpit superuser channel (polkit org.sysdeck.packages.modify).`,
                       'preview');
        } catch (err) {
            showOutput('Preview — error', String(err.message || err), 'FAIL');
        }
    });

    // ── Search ──────────────────────────────────────────────────────
    panel.querySelector('#btn-search')?.addEventListener('click', async () => {
        const term = panel.querySelector('#pkg-search')?.value?.trim();
        if (!term) return;
        const resultsDiv = panel.querySelector('#pkg-search-results');
        if (resultsDiv) resultsDiv.textContent = 'Searching...';
        try {
            const results = await bridge.packages.search(term);
            if (resultsDiv) {
                resultsDiv.innerHTML = results.length
                    ? `<table class="suite-table"><thead><tr><th>Package</th><th>Version</th></tr></thead><tbody>${results.slice(0, 20).map((r) => `<tr><td class="suite-table-mono">${escapeHtml(r.name)}</td><td>${escapeHtml(r.version || r.description || '—')}</td></tr>`).join('')}</tbody></table>`
                    : 'No packages found.';
            }
        } catch (err) {
            if (resultsDiv) resultsDiv.textContent = `Search failed: ${err.message || err}`;
        }
    });

    panel.querySelector('#btn-pkg-refresh')?.addEventListener('click', () => {
        mount(panel, { bridge, EventBus });
    });
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
        <h3 class="suite-card-title">Package manager unavailable</h3>
        <p class="suite-card-body suite-muted">${escapeHtml(err.message || err)}. Ensure pacman, dnf, or apt is installed.</p>
    </div>`;
}
