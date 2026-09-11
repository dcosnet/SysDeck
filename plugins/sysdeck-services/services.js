/*
 * SysDeck - Service / Port Editor Panel (v0.0.47)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * v0.0.47 — PROMOTED TO ITS OWN SIDEBAR ENTRY. Per user directive:
 * "we should move the service/ports editor to its own module entry
 * for ease of access." The editor previously lived as a card at the
 * bottom of the Firewall panel (v0.0.44); v0.0.47 lifts it into a
 * first-class sidebar entry at order 45 so the operator can manage
 * service ports without scrolling past the firewall ruleset table.
 *
 * The bridge surface is `bridge.services.*` — a thin proxy (added in
 * v0.0.47) over the existing firewall.py subcommands: services,
 * service-info, set-service-port, restart-service. No new bridge
 * helper file was needed; the SERVICES_REGISTRY, atomic-write logic,
 * and CONFIG_BASE_DIRS allowlist remain in bridge/firewall.py as the
 * single source of truth.
 *
 * Panel layout:
 *   - Header (counts: N services, M editable, K listeners)
 *   - Filter row (search box + show-only-editable toggle + refresh)
 *   - Services table — one row per SERVICES_REGISTRY entry:
 *       · Service (name + id + editable/restartable badges)
 *       · Port (editable input + Save & Restart button + ↻ Restart button)
 *       · Config port (the value parsed from the config file)
 *       · Default (upstream default port)
 *       · Listening (ports actually bound on the host)
 *       · Process / PID (from ss -tlnp)
 *       · Config file (the resolved path under /etc/ or /usr/share/sysdeck/)
 *   - Unmapped listeners card — ports that didn't match any registry
 *     entry. The operator can spot services the editor doesn't yet
 *     know about and request a SERVICES_REGISTRY entry.
 *   - Operation output card — shows the result of the last Save /
 *     Restart action (success message or stderr).
 *
 * Security (unchanged from v0.0.44 — the bridge helper enforces all
 * of this; the JS just renders the response):
 *   - service_id validated against SERVICES_REGISTRY (CVE-2024-2947
 *     — attacker cannot trick the bridge into editing /etc/shadow).
 *   - Port validated with strict integer regex 1..65535,
 *     `re.fullmatch` to reject trailing newlines (CVE-2019-15107).
 *   - Config path resolved with `os.path.realpath` + base-dir
 *     allowlist (/etc/ or /usr/share/sysdeck/ — CVE-2022-30708
 *     symlink-escape defense).
 *   - Port substitution uses a strict per-service regex (NOT
 *     freeform sed) so only the port digits are replaced.
 *   - systemctl invoked with `shell=False`, list argv, env scrubbed
 *     (CVE-2024-6126).
 *   - Atomic write via tmpfile + fsync + rename defeats partial-write
 *     corruption.
 *   - The `org.sysdeck.firewall.modify` polkit action (shipped since
 *     v0.0.17) already authorizes /usr/bin/systemctl — no polkit
 *     changes required.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    const servicesResp = await safe(
        bridge.services.list(),
        { services: [], unmapped_listeners: [], listener_count: 0 },
    );

    panel.innerHTML = renderPanel(servicesResp);
    wireEvents(panel, { bridge, EventBus });

    EventBus.emit('services.loaded', {
        serviceCount: (servicesResp?.services || []).length,
        listenerCount: servicesResp?.listener_count || 0,
    });
}

// ── Panel render ────────────────────────────────────────────────────

function renderPanel(servicesResp) {
    const services = servicesResp?.services || [];
    const unmapped = servicesResp?.unmapped_listeners || [];
    const listenerCount = servicesResp?.listener_count || 0;
    const editableCount = services.filter((s) => s.editable).length;

    return `
        <header>
            <h2 class="suite-panel-title">Service / Port Editor</h2>
            <p class="suite-panel-subtitle">
                <span class="suite-badge info">${services.length} services</span>
                · <span class="suite-badge success">${editableCount} editable</span>
                · <span class="suite-badge">${listenerCount} listeners</span>
                · <span class="suite-muted">bridge.firewall.services()</span>
            </p>
        </header>

        ${renderIntroCard(services, listenerCount)}

        ${services.length ? renderFilterRow() : ''}

        ${services.length
            ? renderServicesTable(services)
            : renderServicesEmpty()}

        ${unmapped.length ? renderUnmappedListeners(unmapped) : ''}

        ${renderNotesCard()}

        <div id="svc-output" class="suite-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Operation Output</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-svc-output-close">✕</button>
            </div>
            <pre class="suite-mono" id="svc-output-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:300px"></pre>
        </div>
    `;
}

function renderIntroCard(services, listenerCount) {
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">What this panel does</h3>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="margin-bottom:0.5rem;font-size:0.9rem">
                    The bridge enumerates every listening TCP socket on the host
                    (<code>ss -tlnp</code>, falling back to <code>/proc/net/tcp</code>
                    if unavailable) and cross-references it against the
                    <code>SERVICES_REGISTRY</code> in <code>bridge/firewall.py</code>
                    — currently ${services.length} registered services covering
                    SSH, Cockpit, Caddy, Varnish, MariaDB, Ollama, OpenWebUI,
                    Hermes, and Odysseus. Each row shows the port parsed from
                    the service's config file alongside any listening sockets
                    that match it. Edit the port in the input and click
                    <strong>Save &amp; Restart</strong> — the bridge writes
                    the new port to the config file atomically (tmpfile +
                    fsync + rename) and runs <code>systemctl restart</code>
                    on the service. ${listenerCount} listening sockets
                    detected on this host.
                </p>
            </div>
        </div>
    `;
}

function renderFilterRow() {
    return `
        <div class="suite-card">
            <div class="suite-card-body">
                <div class="suite-row" style="gap:0.5rem;align-items:center;flex-wrap:wrap">
                    <input type="text" id="svc-filter" class="suite-input"
                           placeholder="Filter by name, id, port, or process…"
                           style="flex:1;min-width:200px" />
                    <label class="suite-muted" style="font-size:0.85rem;display:flex;align-items:center;gap:0.25rem">
                        <input type="checkbox" id="svc-only-editable" /> Show only editable
                    </label>
                    <button class="suite-btn suite-btn-ghost" id="btn-svc-refresh">↻ Refresh</button>
                </div>
            </div>
        </div>
    `;
}

function renderServicesTable(services) {
    const rows = services.map((s) => renderServiceRow(s)).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Registered Services (${services.length})</h3>
            </div>
            <div class="suite-card-body">
                <table class="suite-table" id="svc-table">
                    <thead>
                        <tr>
                            <th>Service</th>
                            <th>Port (editable)</th>
                            <th>Config port</th>
                            <th>Default</th>
                            <th>Listening</th>
                            <th>Process</th>
                            <th>PID</th>
                            <th>Config file</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `;
}

function renderServiceRow(s) {
    const listening = (s.listening_ports || []).join(', ') || '—';
    const processes = (s.processes || []).join(', ') || '—';
    const pids = (s.pids || []).join(', ') || '—';
    const editableBadge = s.editable
        ? '<span class="suite-badge success" style="margin-left:0.5rem">editable</span>'
        : '<span class="suite-badge" style="margin-left:0.5rem">no config</span>';
    const restartBadge = s.restart_supported
        ? '<span class="suite-badge info" style="margin-left:0.25rem">restartable</span>'
        : '<span class="suite-badge" style="margin-left:0.25rem">no unit</span>';
    const portValue = s.current_port_in_config ?? s.default_port;
    const portInput = s.editable
        ? `<input type="number" min="1" max="65535" value="${escapeHtml(String(portValue))}" class="suite-input svc-port-input" data-service-id="${escapeHtml(s.id)}" style="width:6rem" />`
        : `<code class="suite-mono">${escapeHtml(String(portValue))}</code> <span class="suite-muted">(default, not detected in config)</span>`;
    const saveBtn = s.editable
        ? `<button class="suite-btn suite-btn-primary btn-svc-save" data-service-id="${escapeHtml(s.id)}" style="margin-left:0.5rem">Save &amp; Restart</button>`
        : '';
    const restartBtn = s.restart_supported
        ? `<button class="suite-btn suite-btn-ghost btn-svc-restart" data-service-id="${escapeHtml(s.id)}" style="margin-left:0.25rem">↻ Restart</button>`
        : '';
    const configCell = s.config_file
        ? `<code class="suite-mono" style="font-size:0.8rem">${escapeHtml(s.config_file)}</code>`
        : '<span class="suite-muted">—</span>';
    const description = s.description ? `<div class="suite-muted" style="font-size:0.75rem;margin-top:0.15rem">${escapeHtml(s.description)}</div>` : '';
    return `
        <tr class="svc-row" data-service-id="${escapeHtml(s.id)}"
            data-search-text="${escapeHtml((s.name + ' ' + s.id + ' ' + listening + ' ' + processes + ' ' + (s.current_port_in_config ?? '') + ' ' + s.default_port).toLowerCase())}"
            data-editable="${s.editable ? '1' : '0'}">
            <td>
                <strong>${escapeHtml(s.name)}</strong>
                <div class="suite-muted" style="font-size:0.8rem">${escapeHtml(s.id)}</div>
                ${editableBadge}${restartBadge}
                ${description}
            </td>
            <td>${portInput}${saveBtn}${restartBtn}</td>
            <td class="suite-table-mono">${escapeHtml(String(s.current_port_in_config ?? '—'))}</td>
            <td class="suite-table-mono">${escapeHtml(String(s.default_port))}</td>
            <td class="suite-table-mono">${escapeHtml(listening)}</td>
            <td class="suite-table-mono suite-muted">${escapeHtml(processes)}</td>
            <td class="suite-table-mono suite-muted">${escapeHtml(pids)}</td>
            <td>${configCell}</td>
        </tr>
    `;
}

function renderServicesEmpty() {
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Registered Services</h3>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted">
                    No services detected. This usually means the
                    <code>bridge/firewall.py services</code> subcommand
                    failed — check the cockpit bridge log. Listening-
                    socket enumeration requires <code>ss</code>
                    (iproute2) or readable <code>/proc/net/tcp</code>.
                </p>
            </div>
        </div>
    `;
}

function renderUnmappedListeners(unmapped) {
    const rows = unmapped.map((l) => `
        <tr>
            <td class="suite-table-mono">${escapeHtml(String(l.port))}</td>
            <td class="suite-table-mono">${escapeHtml(l.proto || '—')}</td>
            <td class="suite-table-mono suite-muted">${escapeHtml(l.process || '—')}</td>
            <td class="suite-table-mono suite-muted">${escapeHtml(String(l.pid || '—'))}</td>
        </tr>
    `).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Unmapped Listeners (${unmapped.length})</h3>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="margin-bottom:0.5rem;font-size:0.85rem">
                    These listening sockets did not match any service in the
                    <code>SERVICES_REGISTRY</code>. To add support for a new
                    service, add an entry to <code>SERVICES_REGISTRY</code>
                    in <code>bridge/firewall.py</code> with its config file
                    paths and port-extraction regex.
                </p>
                <table class="suite-table">
                    <thead>
                        <tr><th>Port</th><th>Proto</th><th>Process</th><th>PID</th></tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `;
}

function renderNotesCard() {
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Notes &amp; Security</h3>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem">
                    <strong>Save &amp; Restart</strong> prompts for the cockpit
                    superuser password via polkit. The
                    <code>org.sysdeck.firewall.modify</code> action authorizes
                    <code>/usr/bin/systemctl</code>. Config-file writes are
                    atomic — the bridge writes to a sibling <code>.tmp</code>
                    file, fsyncs, then renames over the original. Edits are
                    restricted to files under <code>/etc/</code> or
                    <code>/usr/share/sysdeck/</code> (symlink-escape attacks
                    rejected via <code>os.path.realpath</code> + base-dir
                    allowlist). Port substitution uses a strict per-service
                    regex (NOT freeform sed) so only the port digits are
                    replaced — comments and other content on the line are
                    preserved.
                </p>
                <p class="suite-muted" style="margin-top:0.5rem;font-size:0.8rem">
                    This panel proxies to <code>bridge.services.*</code>
                    (added in v0.0.47), which in turn calls the existing
                    <code>bridge.firewall.services</code> /
                    <code>service-info</code> /
                    <code>set-service-port</code> /
                    <code>restart-service</code> subcommands. The
                    <code>SERVICES_REGISTRY</code> and atomic-write logic
                    remain in <code>bridge/firewall.py</code> as the single
                    source of truth.
                </p>
            </div>
        </div>
    `;
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }) {
    const output = (msg, isError = false) => {
        const card = panel.querySelector('#svc-output');
        const pre = panel.querySelector('#svc-output-pre');
        if (!card || !pre) return;
        card.style.display = 'block';
        pre.textContent = msg;
        pre.style.color = isError ? 'var(--sysdeck-accent-danger)' : 'var(--sysdeck-fg)';
    };

    panel.querySelector('#btn-svc-output-close')?.addEventListener('click', () => {
        const card = panel.querySelector('#svc-output');
        if (card) card.style.display = 'none';
    });

    // Filter box: live-filter the services table by name/id/port/process.
    panel.querySelector('#svc-filter')?.addEventListener('input', (ev) => {
        const q = String(ev.target.value || '').toLowerCase().trim();
        const onlyEditable = panel.querySelector('#svc-only-editable')?.checked || false;
        panel.querySelectorAll('.svc-row').forEach((row) => {
            const text = row.dataset.searchText || '';
            const editable = row.dataset.editable === '1';
            const matchesText = !q || text.includes(q);
            const matchesEditable = !onlyEditable || editable;
            row.style.display = (matchesText && matchesEditable) ? '' : 'none';
        });
    });

    // Show-only-editable toggle: re-apply the filter.
    panel.querySelector('#svc-only-editable')?.addEventListener('change', () => {
        panel.querySelector('#svc-filter')?.dispatchEvent(new Event('input'));
    });

    // Refresh button: re-mount the panel.
    panel.querySelector('#btn-svc-refresh')?.addEventListener('click', () => {
        mount(panel, { bridge, EventBus });
    });

    // Save & Restart: read the port from the sibling input, validate
    // client-side, then call bridge.services.setPort(id, port).
    panel.querySelectorAll('.btn-svc-save').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const sid = btn.dataset.serviceId;
            if (!sid) return;
            const input = panel.querySelector(`.svc-port-input[data-service-id="${CSS.escape(sid)}"]`);
            if (!input) { output(`Could not find port input for ${sid}`, true); return; }
            const portStr = String(input.value || '').trim();
            const port = Number.parseInt(portStr, 10);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                output(`Invalid port '${portStr}' for ${sid}. Must be 1..65535.`, true);
                return;
            }
            output(`Setting ${sid} port to ${port} ... (cockpit will prompt for auth)`);
            try {
                const r = await bridge.services.setPort(sid, port);
                if (r.error) {
                    output(`Save FAILED for ${sid}: ${r.error}`, true);
                    return;
                }
                const msg = r.restarted
                    ? `${r.name}: port ${r.old_port} → ${r.new_port} (config: ${r.config_file})\nService restarted via ${r.restart_method}.`
                    : `${r.name}: port ${r.old_port} → ${r.new_port} (config: ${r.config_file})\n⚠ Service restart FAILED (rc=${r.restart_rc}): ${r.restart_stderr || '(no stderr)'}`;
                output(msg, !r.restarted);
                if (r.new_port) setTimeout(() => mount(panel, { bridge, EventBus }), 1200);
            } catch (err) { output(`Save error: ${err.message || err}`, true); }
        });
    });

    // Restart-only: useful when the operator edited the config by hand.
    panel.querySelectorAll('.btn-svc-restart').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const sid = btn.dataset.serviceId;
            if (!sid) return;
            output(`Restarting ${sid} ... (cockpit will prompt for auth)`);
            try {
                const r = await bridge.services.restart(sid);
                if (r.error) {
                    output(`Restart FAILED for ${sid}: ${r.error}`, true);
                    return;
                }
                output(r.restarted
                    ? `${r.name} restarted via ${r.restart_method}.`
                    : `${r.name} restart FAILED (rc=${r.restart_rc}): ${r.restart_stderr || '(no stderr)'}`,
                    !r.restarted);
            } catch (err) { output(`Restart error: ${err.message || err}`, true); }
        });
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
