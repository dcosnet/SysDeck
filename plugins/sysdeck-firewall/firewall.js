/*
 * SysDeck - Firewall Panel (v0.0.45)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * v0.0.45 TRADEMARK SCRUB. Wording-only release — no functional changes.
 * Per user directive: "you cannot say smoothwall and ipfire where merged
 * into our fw script either. you can say logic derived from or influenced
 * by these projects." Every reference to Smoothwall Express or IPFire now
 * uses "takes influence from" / "logic derived from" instead of "merged"
 * or "shipped". The sysdeck-fw backend, the 7 firewall templates, and the
 * v0.0.44 service/port editor are unchanged. All 141 unit tests pass.
 *
 * v0.0.47 — SERVICE/PORT EDITOR MOVED TO ITS OWN SIDEBAR ENTRY.
 * Per user directive: "we should move the service/ports editor to its
 * own module entry for ease of access." The editor card that lived at
 * the bottom of this panel since v0.0.44 has been lifted out into a
 * first-class plugin — sysdeck-services at order 45. The bridge surface
 * (bridge.firewall.services / service-info / set-service-port /
 * restart-service) is unchanged; a new bridge.services proxy was added
 * to bridge.js so the new panel has a clean API. The services() Promise
 * in the parallel load below was removed because this panel no longer
 * needs the inventory — it lives in the new Services panel. The
 * renderServicePortEditor() function and the .btn-svc-save / .btn-svc-
 * restart wireEvents handlers were removed from this file.
 *
 * v0.0.44 PUBLIC-SERVER VARIANTS + SERVICE/PORT EDITOR.
 *
 *   - Three new public-server templates ship in this release:
 *     remote-admin.sh (SSH + Cockpit), public-webserver.sh
 *     (Caddy + Varnish + MariaDB), ai-llm.sh (Ollama + OpenWebUI
 *     + Hermes + Odysseus). They appear in the existing Templates
 *     card when the 'custom' backend is active — no new UI surface
 *     needed for selection.
 *   - Service/Port Editor card — runs bridge.firewall.services() to
 *     enumerate listening TCP ports on the host and cross-reference
 *     against the SERVICES_REGISTRY (ssh, cockpit, caddy, varnish,
 *     mariadb, ollama, openwebui, hermes, odysseus). Each registered
 *     service shows: current port from its config file, the listening
 *     ports actually active, the systemd unit, and an editable port
 *     input. Clicking Save edits the config file atomically (tmpfile
 *     + fsync + rename) and runs `systemctl restart` on the service.
 *     Unmapped listeners (ports with no matching registry entry) are
 *     shown in a separate block so the operator can spot services
 *     the editor doesn't yet know about.
 *
 * v0.0.31 REWRITE — PREVIOUS VERSION WAS READ-ONLY.
 *
 * The v0.0.30 panel could only list active nftables rules. v0.0.31
 * turns it into a full firewall manager:
 *
 *   - Template selector — operator picks from installed templates
 *     under /usr/share/sysdeck/firewall/templates/ (vps-webserver.sh,
 *     no-services.sh, plus any operator-dropped *.sh). Each template
 *     is shown with its description and detected services.
 *   - Apply / Stop / Restart buttons — invoke the template's start /
 *     stop / restart action via the bridge under the cockpit
 *     superuser channel (polkit). No `sudo` shell-out from JS.
 *   - Service detection preview — runs the template's `detect`
 *     action and renders the inventory (OS, interface, services
 *     detected) before applying.
 *   - Live ban-list table — ssh_abuse / port_scanners / connlimit_abuse
 *     sets with per-IP Unban buttons and a Clear All button.
 *   - Active ruleset table — refreshed after each mutating operation
 *     so the operator sees the new state immediately.
 *
 * v0.0.36 BACKEND DROPDOWN + SECURITY CARD.
 *
 *   - Backend selector — operator picks between custom / cilium /
 *     sysdeck-fw. The bridge probes availability (cilium
 *     installed? nftables installed? kernel BPF features?) and shows
 *     an install hint if missing. The "Install" button triggers
 *     bridge.firewall.installBackend (delegates to packages module).
 *   - Cilium-specific sections — when cilium is the active backend,
 *     the panel renders Cilium Status / Endpoints / Policy cards in
 *     place of the nftables ruleset table.
 *   - Security Card — renders the CVE-derived hardening checklist
 *     (bridge.firewall.securityHardening). Documents the lessons
 *     applied from Webmin, Cockpit, Ajenti, ISPConfig, Virtualmin,
 *     cPanel, Plesk, CyberPanel, aaPanel, CloudPanel, HestiaCP,
 *     VestaCP, Froxlor, InterWorx, BrainyCP, DirectAdmin, CWP CVE
 *     disclosures. Full table in docs/SECURITY-HARDENING.md.
 *   - Excluded backends info — explains why UFW, fwbuilder, iptables-
 *     legacy, iptables-nft, Shorewall, Smoothwall Express (trademark),
 *     and IPFire (trademark) are not in the dropdown. We took influence
 *     from Smoothwall Express and IPFire for the sysdeck-fw backend;
 *     we do not ship templates called "smoothwall" or "ipfire".
 *
 * Mutating ops go through bridge.firewall.apply / stop / restart / ban /
 * unban / clearBans / switchBackend / installBackend / ciliumPolicyApply,
 * which pass { superuser: 'try' } to cockpit.spawn. The cockpit bridge
 * prompts the operator for auth via polkit; the org.sysdeck.firewall.modify
 * action (shipped since v0.0.17, extended in v0.0.36 to authorize cilium
 * + cilium-agent + helm) authorizes the binaries. This is the "cockpit
 * way" per user directive v0.0.31.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    // v0.0.47: services inventory no longer loaded here — the editor
    // moved to its own sidebar entry (sysdeck-services at order 45).
    const [backendsResp, templates, status, rules, chains, hardening] = await Promise.all([
        safe(bridge.firewall.backends(), { active: 'custom', backends: [], excluded: [] }),
        safe(bridge.firewall.templates(), []),
        safe(bridge.firewall.status(), { state: 'unavailable', bans: {} }),
        safe(bridge.firewall.listRules(), []),
        safe(bridge.firewall.listChains(), []),
        safe(bridge.firewall.securityHardening(), { applied: [], cves_reviewed: [] }),
    ]);
    const activeBackend = backendsResp?.active || 'custom';
    const backends = backendsResp?.backends || [];
    const excluded = backendsResp?.excluded || [];
    const activeTemplate = status?.active_template || null;
    const state = status?.state || 'unavailable';
    const bans = status?.bans || {};
    const bannedIpCount = status?.banned_ip_count || 0;
    const isCilium = activeBackend === 'cilium';

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Firewall Control</h2>
            <p class="suite-panel-subtitle">
                <span class="suite-badge ${isCilium ? 'info' : 'success'}">${escapeHtml(activeBackend)}</span>
                · ${isCilium ? 'eBPF datapath' : 'nftables'}
                · <span class="suite-badge ${state === 'running' ? 'success' : 'danger'}">${state}</span>
                ${!isCilium ? ` · ${chains.length} chains · ${rules.length} rules` : ''}
                · ${bannedIpCount} banned IP${bannedIpCount === 1 ? '' : 's'}
                ${activeTemplate ? ` · active: <code>${escapeHtml(activeTemplate)}</code>` : ''}
            </p>
        </header>

        ${renderBackendSelector(backends, excluded, activeBackend, templates, activeTemplate)}

        ${isCilium ? await renderCiliumSections(bridge) : ''}

        ${!isCilium ? renderTemplateSelector(templates, activeTemplate, state, activeBackend, backends) : ''}

        ${renderControls(state, isCilium, activeBackend, backends)}

        ${renderDetectionSection()}

        ${!isCilium ? renderBans(bans, bannedIpCount) : ''}

        ${!isCilium ? renderRuleset(rules, chains) : ''}

        ${renderSecurityCard(hardening)}

        ${renderServicesLinkCard()}

        <div id="fw-output" class="suite-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Operation Output</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-fw-output-close">✕</button>
            </div>
            <pre class="suite-mono" id="fw-output-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:300px"></pre>
        </div>
    `;

    // v0.0.43: Store backends data for getSelectedTemplate() to access
    // (the Apply button handler needs to know which backend is active
    // to determine which template to apply).
    window.__sysdeckFirewallBackends = backends;
    window.__sysdeckFirewallActiveBackend = activeBackend;

    wireEvents(panel, { bridge, EventBus });
    EventBus.emit('firewall.loaded', {
        ruleCount: rules.length, state, bannedIpCount, activeBackend,
    });
}

// ── Render helpers ──────────────────────────────────────────────────

function renderBackendSelector(backends, excluded, activeBackend, templates, activeTemplate) {
    if (!backends || !backends.length) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Firewall Backend</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">
                        No firewall backends available. This indicates a
                        broken install — re-install the <code>sysdeck</code>
                        package.
                    </p>
                </div>
            </div>
        `;
    }
    // v0.0.43: Find the active backend object to determine whether it
    // has its own template (cilium → cilium, sysdeck-fw → sysdeck-fw).
    // If it does, the template selector is hidden — the backend IS the
    // template. Only 'custom' shows the template selector.
    const activeBackendObj = backends.find((b) => b.id === activeBackend) || backends[0];
    const backendHasTemplate = activeBackendObj && activeBackendObj.template;
    const options = backends.map((b) => {
        const isActive = b.id === activeBackend;
        const installed = b.available?.installed;
        const techBadge = b.ebpf
            ? '<span class="suite-badge info" style="margin-left:0.5rem">eBPF</span>'
            : '<span class="suite-badge" style="margin-left:0.5rem">nftables</span>';
        const statusBadge = installed
            ? '<span class="suite-badge success" style="margin-left:0.25rem">installed</span>'
            : '<span class="suite-badge danger" style="margin-left:0.25rem">not installed</span>';
        return `
            <label class="suite-template-card ${isActive ? 'active' : ''}" style="display:block;padding:0.75rem;border:1px solid var(--sysdeck-border);border-radius:6px;margin-bottom:0.5rem;cursor:pointer;${isActive ? 'border-color:var(--sysdeck-accent);background:rgba(6,102,204,0.08);' : ''}">
                <input type="radio" name="fw-backend" value="${escapeHtml(b.id)}" ${isActive ? 'checked' : ''} style="margin-right:0.5rem" />
                <strong>${escapeHtml(b.name)}</strong>
                ${techBadge}
                ${statusBadge}
                ${isActive ? '<span class="suite-badge success" style="margin-left:0.5rem">active</span>' : ''}
                <div class="suite-muted" style="margin-top:0.25rem">${escapeHtml(b.description || '')}</div>
                ${!installed && b.available?.install_hint
                    ? `<pre class="suite-mono" style="margin-top:0.5rem;background:#1a1a1a;padding:6px;border-radius:4px;font-size:0.75rem;white-space:pre-wrap">${escapeHtml(b.available.install_hint)}</pre>`
                    : ''}
                ${!installed && b.install_packages && b.install_packages.length
                    ? `<button class="suite-btn suite-btn-ghost btn-fw-install-backend" data-backend="${escapeHtml(b.id)}" style="margin-top:0.5rem">Install via packages module</button>`
                    : ''}
            </label>
        `;
    }).join('');
    const excludedItems = excluded.map((e) => `
        <li><code>${escapeHtml(e.id)}</code> — ${escapeHtml(e.reason)}</li>
    `).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Firewall Backend (${backends.length})</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-fw-switch-backend">Switch Backend</button>
            </div>
            <div class="suite-card-body">
                ${options}
                <p class="suite-muted" style="margin-top:0.5rem;font-size:0.8rem">
                    Switching backend stops the previous backend cleanly
                    before applying the new one.
                    ${backendHasTemplate
                        ? `The <strong>${escapeHtml(activeBackendObj.name)}</strong> backend uses its own template (<code>${escapeHtml(activeBackendObj.template)}</code>) — no template selection needed.`
                        : 'The <strong>custom</strong> backend lets you pick from the basic nftables templates below.'}
                </p>
                ${excluded.length ? `
                    <details style="margin-top:0.75rem">
                        <summary class="suite-muted" style="cursor:pointer;font-size:0.8rem">
                            Excluded backends (${excluded.length}) — click to expand
                        </summary>
                        <ul class="suite-muted" style="margin-top:0.5rem;font-size:0.8rem;padding-left:1.5rem">
                            ${excludedItems}
                        </ul>
                    </details>
                ` : ''}
            </div>
        </div>
    `;
}

async function renderCiliumSections(bridge) {
    // Fetch Cilium status + endpoints + policy in parallel.
    const [statusResp, endpointsResp, policyResp] = await Promise.all([
        safe(bridge.firewall.ciliumStatus(), { installed: false, output: '', stderr: '' }),
        safe(bridge.firewall.ciliumEndpoints(), { installed: false, endpoints: [] }),
        safe(bridge.firewall.ciliumPolicy(), { installed: false, policies: [] }),
    ]);
    const installed = statusResp?.installed || false;
    if (!installed) {
        return `
            <div class="suite-card">
                <div class="suite-card-header">
                    <h3 class="suite-card-title">Cilium eBPF Backend</h3>
                </div>
                <div class="suite-card-body">
                    <p class="suite-muted">
                        cilium-cli is not installed. Use the "Install via
                        packages module" button on the backend card above,
                        or install manually:
                    </p>
                    <pre class="suite-mono" style="margin-top:0.5rem;background:#1a1a1a;padding:8px;border-radius:4px;font-size:0.8rem">sudo pacman -S cilium-cli      # Arch
sudo apt install cilium-cli    # Debian
helm repo add cilium https://helm.cilium.io/
helm install cilium cilium/cilium -n kube-system</pre>
                </div>
            </div>
        `;
    }
    const endpointCount = Array.isArray(endpointsResp?.endpoints) ? endpointsResp.endpoints.length : 0;
    const policyCount = Array.isArray(policyResp?.policies) ? policyResp.policies.length : 0;
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Cilium Status</h3>
            </div>
            <div class="suite-card-body">
                <pre class="suite-mono" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:200px">${escapeHtml(statusResp?.output || statusResp?.stderr || '(no output)')}</pre>
            </div>
        </div>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Cilium Endpoints (${endpointCount})</h3>
            </div>
            <div class="suite-card-body">
                <pre class="suite-mono" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:200px">${escapeHtml(JSON.stringify(endpointsResp?.endpoints || [], null, 2))}</pre>
            </div>
        </div>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Cilium Policies (${policyCount})</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-fw-cilium-apply-policy">Apply Default Policy</button>
            </div>
            <div class="suite-card-body">
                <pre class="suite-mono" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:200px">${escapeHtml(JSON.stringify(policyResp?.policies || [], null, 2))}</pre>
            </div>
        </div>
    `;
}

function renderServicesLinkCard() {
    // v0.0.47: the Service / Port Editor moved to its own sidebar entry
    // (sysdeck-services at order 45). This card is a signpost — it tells
    // the operator where to find the editor and what it does. Keeping
    // a stub here preserves the workflow for operators who used to
    // scroll to the bottom of the Firewall panel for port edits.
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Service / Port Editor</h3>
                <span class="suite-badge info">moved</span>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="margin-bottom:0.5rem;font-size:0.9rem">
                    The service/port editor has been promoted to its own
                    sidebar entry — <strong>Service / Ports</strong> at
                    order 45 — for ease of access. It enumerates every
                    listening TCP socket on the host via
                    <code>ss -tlnp</code> (with a
                    <code>/proc/net/tcp</code> fallback), cross-references
                    against the <code>SERVICES_REGISTRY</code> in
                    <code>bridge/firewall.py</code>, and lets you edit
                    the port in the service's config file with an atomic
                    write + <code>systemctl restart</code>.
                </p>
                <p class="suite-muted" style="font-size:0.85rem">
                    Click <strong>Service / Ports</strong> in the sidebar
                    to open the editor. The bridge surface
                    (<code>bridge.firewall.services</code> /
                    <code>service-info</code> /
                    <code>set-service-port</code> /
                    <code>restart-service</code>) is unchanged from
                    v0.0.44; a new <code>bridge.services</code> proxy
                    was added in v0.0.47 so the new panel has a clean
                    API surface.
                </p>
            </div>
        </div>
    `;
}

function renderSecurityCard(hardening) {
    if (!hardening || !hardening.applied || !hardening.applied.length) {
        return '';
    }
    const rows = hardening.applied.map((h) => `
        <tr>
            <td class="suite-table-mono">${escapeHtml(h.id || '')}</td>
            <td><strong>${escapeHtml(h.title || '')}</strong><div class="suite-muted" style="font-size:0.8rem">${escapeHtml(h.detail || '')}</div></td>
            <td class="suite-table-mono suite-muted">${escapeHtml(h.cve || '')}</td>
        </tr>
    `).join('');
    const cveBadges = (hardening.cves_reviewed || []).slice(0, 12).map((cve) =>
        `<span class="suite-badge" style="margin-right:0.25rem;font-size:0.7rem">${escapeHtml(cve)}</span>`
    ).join('');
    const moreCount = (hardening.cves_reviewed || []).length - 12;
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Security Hardening (v0.0.36)</h3>
                <span class="suite-muted" style="font-size:0.8rem">${hardening.applied.length} lessons applied</span>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="margin-bottom:0.5rem;font-size:0.85rem">
                    Each hardening item maps to a real CVE disclosure in
                    Webmin, Cockpit, Ajenti, ISPConfig, or Virtualmin.
                    Full checklist in <code>docs/SECURITY-HARDENING.md</code>.
                </p>
                <table class="suite-table">
                    <thead><tr><th>ID</th><th>Hardening</th><th>CVE</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                <div style="margin-top:0.75rem">
                    <span class="suite-muted" style="font-size:0.8rem">CVEs reviewed: </span>
                    ${cveBadges}
                    ${moreCount > 0 ? `<span class="suite-muted" style="font-size:0.8rem">+ ${moreCount} more</span>` : ''}
                </div>
            </div>
        </div>
    `;
}

function renderTemplateSelector(templates, activeTemplate, state, activeBackend, backends) {
    // v0.0.43: If the active backend has its own template (cilium → cilium,
    // sysdeck-fw → sysdeck-fw), DON'T render the template selector at all —
    // the backend IS the template. This fixes the v0.0.36 logic flaw where
    // two independent lists (backend + template) didn't coordinate.
    const activeBackendObj = backends?.find((b) => b.id === activeBackend);
    if (activeBackendObj?.template) {
        return '';  // backend has its own template — selector not needed
    }
    // For the 'custom' backend, filter templates to show ONLY the basic
    // nftables templates (vps-webserver, no-services). Exclude cilium +
    // sysdeck-fw — those are backend-specific and would conflict if applied
    // while the custom backend is active.
    const backendTemplates = new Set(
        (backends || [])
            .filter((b) => b.template)  // backends with their own template
            .map((b) => b.template)
    );
    const filteredTemplates = (templates || []).filter((t) =>
        !backendTemplates.has(t.name)
    );
    if (!filteredTemplates.length) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Templates</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">
                        No firewall templates found under
                        <code>/usr/share/sysdeck/firewall/templates/</code>.
                        Install the <code>sysdeck</code> package to ship the
                        default templates (vps-webserver.sh, no-services.sh),
                        or drop your own <code>*.sh</code> file there.
                    </p>
                </div>
            </div>
        `;
    }
    const items = filteredTemplates.map((t) => {
        const isActive = t.name === activeTemplate;
        return `
            <label class="suite-template-card ${isActive ? 'active' : ''}" style="display:block;padding:0.75rem;border:1px solid var(--sysdeck-border);border-radius:6px;margin-bottom:0.5rem;cursor:pointer;${isActive ? 'border-color:var(--sysdeck-accent);background:rgba(6,102,204,0.08);' : ''}">
                <input type="radio" name="fw-template" value="${escapeHtml(t.name)}" ${isActive ? 'checked' : ''} style="margin-right:0.5rem" />
                <strong>${escapeHtml(t.name)}</strong>
                ${isActive ? '<span class="suite-badge success" style="margin-left:0.5rem">active</span>' : ''}
                <div class="suite-muted" style="margin-top:0.25rem">${escapeHtml(t.description || '')}</div>
                ${t.services && t.services.length ? `<div class="suite-muted" style="margin-top:0.25rem">Services: ${t.services.map((s) => `<span class="suite-badge info" style="margin-right:0.25rem">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
                ${t.distros && t.distros.length ? `<div class="suite-muted" style="margin-top:0.25rem">Distros: ${t.distros.map((d) => `<span class="suite-badge" style="margin-right:0.25rem">${escapeHtml(d)}</span>`).join('')}</div>` : ''}
            </label>
        `;
    }).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Templates (${filteredTemplates.length})</h3>
            </div>
            <div class="suite-card-body">
                ${items}
            </div>
        </div>
    `;
}

function renderControls(state, isCilium, activeBackend, backends) {
    const isRunning = state === 'running';
    // v0.0.43: backend-aware Apply button label.
    let applyLabel;
    if (isCilium) {
        applyLabel = '▶ Apply Cilium Policy';
    } else {
        const backend = backends?.find((b) => b.id === activeBackend);
        if (backend?.template) {
            applyLabel = `▶ Apply ${backend.template}`;
        } else {
            applyLabel = '▶ Apply Template';
        }
    }
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Controls</h3>
            </div>
            <div class="suite-card-body">
                <div class="suite-row" style="gap:0.5rem">
                    <button class="suite-btn suite-btn-primary" id="btn-fw-apply" ${isRunning ? 'disabled' : ''}>${escapeHtml(applyLabel)}</button>
                    <button class="suite-btn" id="btn-fw-restart" ${!isRunning ? 'disabled' : ''}>↻ Restart</button>
                    <button class="suite-btn" id="btn-fw-stop" ${!isRunning ? 'disabled' : ''}>■ Stop</button>
                    <button class="suite-btn suite-btn-ghost" id="btn-fw-detect">🔎 Detect Services</button>
                    <button class="suite-btn suite-btn-ghost" id="btn-fw-check">✓ Validate</button>
                    <button class="suite-btn suite-btn-ghost" id="btn-fw-refresh">↻ Refresh</button>
                </div>
                <p class="suite-muted" style="margin-top:0.5rem;font-size:0.8rem">
                    Apply / Restart / Stop prompt for the cockpit superuser
                    password via polkit. The
                    <code>org.sysdeck.firewall.modify</code> action authorizes
                    <code>/usr/bin/nft</code>${isCilium ? ', <code>/usr/bin/cilium</code>, <code>/usr/bin/cilium-agent</code>, <code>/usr/bin/helm</code>' : ''}.
                </p>
            </div>
        </div>
    `;
}

function renderDetectionSection() {
    return `
        <div class="suite-card" id="fw-detect-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Service Detection</h3>
            </div>
            <pre class="suite-mono" id="fw-detect-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:300px"></pre>
        </div>
    `;
}

function renderBans(bans, total) {
    const sets = Object.keys(bans);
    if (!sets.length) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Banned IPs (0)</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">No ban sets available — firewall is not running.</p>
                </div>
            </div>
        `;
    }
    const allBanned = new Set();
    for (const set of sets) {
        for (const ip of (bans[set] || [])) allBanned.add(ip);
    }
    const banRows = [...allBanned].map((ip) => {
        const setsWithIp = sets.filter((s) => (bans[s] || []).includes(ip));
        return `
            <tr>
                <td class="suite-table-mono">${escapeHtml(ip)}</td>
                <td>${setsWithIp.map((s) => `<span class="suite-badge info" style="margin-right:0.25rem">${escapeHtml(s)}</span>`).join('')}</td>
                <td><button class="suite-btn suite-btn-ghost btn-fw-unban" data-ip="${escapeHtml(ip)}">Unban</button></td>
            </tr>
        `;
    }).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Banned IPs (${allBanned.size})</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-fw-clear-bans" ${!allBanned.size ? 'disabled' : ''}>Clear All</button>
            </div>
            <table class="suite-table">
                <thead><tr><th>IP</th><th>In sets</th><th>Action</th></tr></thead>
                <tbody>
                    ${banRows || '<tr><td colspan="3" class="suite-muted">No banned IPs.</td></tr>'}
                </tbody>
            </table>
            <p class="suite-muted" style="margin-top:0.5rem;font-size:0.8rem">
                Ban sets: <code>${sets.join(', ')}</code>.
                ssh_abuse = SSH brute-force ban (1h timeout),
                port_scanners = port scan detection (1h timeout),
                connlimit_abuse = connection rate limit exceeded (10m timeout).
            </p>
        </div>
    `;
}

function renderRuleset(rules, chains) {
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Active Ruleset</h3>
                <span class="suite-muted" style="font-size:0.8rem">${rules.length} rules in ${chains.length} chains</span>
            </div>
            <table class="suite-table">
                <thead>
                    <tr><th>Chain</th><th>Rule</th><th>Handle</th></tr>
                </thead>
                <tbody>
                    ${rules.slice(0, 100).map((r) => `
                        <tr>
                            <td><span class="suite-badge info">${escapeHtml(r.chain)}</span></td>
                            <td class="suite-table-mono">${escapeHtml(r.spec)}</td>
                            <td class="suite-table-mono suite-muted">${r.handle}</td>
                        </tr>
                    `).join('') || '<tr><td colspan="3" class="suite-muted">No rules — firewall is not running.</td></tr>'}
                </tbody>
            </table>
            ${rules.length > 100 ? `<p class="suite-muted">Showing first 100 of ${rules.length} rules.</p>` : ''}
        </div>
    `;
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }) {
    const output = (msg, isError = false) => {
        const card = panel.querySelector('#fw-output');
        const pre = panel.querySelector('#fw-output-pre');
        if (!card || !pre) return;
        card.style.display = 'block';
        pre.textContent = msg;
        pre.style.color = isError ? 'var(--sysdeck-accent-danger)' : 'var(--sysdeck-fg)';
    };
    panel.querySelector('#btn-fw-output-close')?.addEventListener('click', () => {
        const card = panel.querySelector('#fw-output');
        if (card) card.style.display = 'none';
    });

    const getSelectedTemplate = () => {
        // v0.0.43: The template to apply depends on the active backend.
        // If the backend has its own template (cilium → cilium, sysdeck-fw
        // → sysdeck-fw), use that — the template selector is hidden.
        // If the backend is 'custom', use the operator's selection from
        // the template radio buttons.
        const backendsResp = window.__sysdeckFirewallBackends;
        const activeBackend = window.__sysdeckFirewallActiveBackend;
        if (backendsResp && activeBackend) {
            const backend = backendsResp.find((b) => b.id === activeBackend);
            if (backend?.template) return backend.template;
        }
        // 'custom' backend — use the radio button selection.
        const checked = panel.querySelector('input[name="fw-template"]:checked');
        if (checked) return checked.value;
        // If only one template, return it.
        const only = panel.querySelector('input[name="fw-template"]');
        return only ? only.value : null;
    };

    const getSelectedBackend = () => {
        const checked = panel.querySelector('input[name="fw-backend"]:checked');
        return checked ? checked.value : null;
    };

    // v0.0.36: backend dropdown — switch backend (stops old, applies new).
    panel.querySelector('#btn-fw-switch-backend')?.addEventListener('click', async () => {
        const backend = getSelectedBackend();
        if (!backend) { output('Select a backend first.', true); return; }
        output(`Switching firewall backend to ${backend} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.firewall.switchBackend(backend);
            const steps = (r.steps || []).map((s) =>
                `  [${s.step}] rc=${s.rc} ${s.output ? '· ' + s.output.split('\n')[0] : ''}${s.stderr ? ' · stderr: ' + s.stderr.split('\n')[0] : ''}`
            ).join('\n');
            output(r.switched
                ? `Backend switched: ${r.previous} → ${r.current}\n\nSteps:\n${steps}\n\nAvailable: ${JSON.stringify(r.available)}`
                : `Backend switch FAILED: ${JSON.stringify(r, null, 2)}`,
                !r.switched);
            if (r.switched) setTimeout(() => mount(panel, { bridge, EventBus }), 1200);
        } catch (err) { output(`Switch-backend error: ${err.message || err}`, true); }
    });

    // v0.0.36: install backend deps (delegates to packages module).
    panel.querySelectorAll('.btn-fw-install-backend').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const backend = btn.dataset.backend;
            if (!backend) return;
            output(`Installing packages for backend ${backend} ... (cockpit will prompt for auth)`);
            try {
                const r = await bridge.firewall.installBackend(backend);
                output(r.installed
                    ? `Backend ${backend} installed.\nPackages: ${(r.packages || []).join(', ')}\n\n${r.output || ''}`
                    : `Install FAILED.\n\nstderr: ${r.stderr || '(empty)'}\n\nstdout: ${r.output || '(empty)'}`,
                    !r.installed);
                if (r.installed) setTimeout(() => mount(panel, { bridge, EventBus }), 800);
            } catch (err) { output(`Install-backend error: ${err.message || err}`, true); }
        });
    });

    // v0.0.36: apply Cilium default policy.
    panel.querySelector('#btn-fw-cilium-apply-policy')?.addEventListener('click', async () => {
        output('Applying Cilium default policy ... (cockpit will prompt for auth)');
        try {
            const r = await bridge.firewall.ciliumPolicyApply('cilium-default.yaml');
            output(r.applied
                ? `Cilium policy applied: ${r.policy}\n\n${r.output || ''}`
                : `Cilium policy apply FAILED.\n\nstderr: ${r.stderr || '(empty)'}\n\nstdout: ${r.output || '(empty)'}`,
                !r.applied);
            if (r.applied) setTimeout(() => mount(panel, { bridge, EventBus }), 800);
        } catch (err) { output(`Cilium-policy-apply error: ${err.message || err}`, true); }
    });

    panel.querySelector('#btn-fw-apply')?.addEventListener('click', async () => {
        const template = getSelectedTemplate();
        if (!template) { output('Select a template first.', true); return; }
        output(`Applying template ${template} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.firewall.apply(template);
            const msg = r.success
                ? `Template ${r.template} applied successfully.\n\n${r.output || ''}`
                : `Apply FAILED (rc=${r.rc}).\n\nstderr: ${r.stderr || '(empty)'}\n\nstdout: ${r.output || '(empty)'}`;
            output(msg, !r.success);
            if (r.success) setTimeout(() => mount(panel, { bridge, EventBus }), 800);
        } catch (err) { output(`Apply error: ${err.message || err}`, true); }
    });

    panel.querySelector('#btn-fw-restart')?.addEventListener('click', async () => {
        output('Restarting firewall ... (cockpit will prompt for auth)');
        try {
            const r = await bridge.firewall.restart();
            const ok = r.restarted;
            output(ok
                ? `Firewall restarted (template: ${r.template || 'none'}).\n\n${JSON.stringify(r.apply_result || {}, null, 2)}`
                : `Restart did not complete: ${JSON.stringify(r, null, 2)}`,
                !ok);
            if (ok) setTimeout(() => mount(panel, { bridge, EventBus }), 800);
        } catch (err) { output(`Restart error: ${err.message || err}`, true); }
    });

    panel.querySelector('#btn-fw-stop')?.addEventListener('click', async () => {
        output('Stopping firewall ... (cockpit will prompt for auth)');
        try {
            const r = await bridge.firewall.stop();
            output(r.stopped
                ? `Firewall stopped (method: ${r.method}).\n\n${r.output || ''}`
                : `Stop FAILED.\n\nstderr: ${r.stderr || '(empty)'}`,
                !r.stopped);
            if (r.stopped) setTimeout(() => mount(panel, { bridge, EventBus }), 800);
        } catch (err) { output(`Stop error: ${err.message || err}`, true); }
    });

    panel.querySelector('#btn-fw-detect')?.addEventListener('click', async () => {
        const card = panel.querySelector('#fw-detect-card');
        const pre = panel.querySelector('#fw-detect-pre');
        if (!card || !pre) return;
        card.style.display = 'block';
        pre.textContent = 'Running service detection ...';
        try {
            const r = await bridge.firewall.detect();
            pre.textContent = r.output || `(no output)\n\nstderr: ${r.stderr || ''}`;
            EventBus.emit('firewall.detected', { template: r.active_template });
        } catch (err) {
            pre.textContent = `Detect error: ${err.message || err}`;
        }
    });

    panel.querySelector('#btn-fw-check')?.addEventListener('click', async () => {
        output('Validating ruleset ...');
        try {
            const r = await bridge.firewall.check();
            output(r.valid
                ? 'Ruleset is valid.'
                : `Validation FAILED.\n\nstderr: ${r.stderr || '(empty)'}`,
                !r.valid);
        } catch (err) { output(`Check error: ${err.message || err}`, true); }
    });

    panel.querySelector('#btn-fw-clear-bans')?.addEventListener('click', async () => {
        output('Clearing all ban lists ... (cockpit will prompt for auth)');
        try {
            const r = await bridge.firewall.clearBans();
            output(r.cleared
                ? 'All ban lists cleared.'
                : `Clear-bans partial failure: ${JSON.stringify(r.sets)}`,
                !r.cleared);
            if (r.cleared) setTimeout(() => mount(panel, { bridge, EventBus }), 800);
        } catch (err) { output(`Clear-bans error: ${err.message || err}`, true); }
    });

    panel.querySelectorAll('.btn-fw-unban').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const ip = btn.dataset.ip;
            output(`Unbanning ${ip} ... (cockpit will prompt for auth)`);
            try {
                const r = await bridge.firewall.unban(ip);
                output(r.unbanned
                    ? `${ip} unbanned from sets: ${Object.entries(r.sets).filter(([k, v]) => v).map(([k]) => k).join(', ') || '(was not in any set)'}`
                    : `${ip} was not found in any ban set.`,
                    !r.unbanned);
                setTimeout(() => mount(panel, { bridge, EventBus }), 800);
            } catch (err) { output(`Unban error: ${err.message || err}`, true); }
        });
    });

    panel.querySelector('#btn-fw-refresh')?.addEventListener('click', () => {
        mount(panel, { bridge, EventBus });
    });

    // v0.0.47: the .btn-svc-save / .btn-svc-restart handlers and the
    // .svc-port-input wiring were removed from this file — the entire
    // Service / Port Editor card moved to the new sysdeck-services
    // plugin at sidebar order 45. See plugins/sysdeck-services/services.js.

    // systemd unit subscription (kept from v0.0.30 — best-effort).
    if (panel._unsubscribeUnit) panel._unsubscribeUnit();
    try {
        if (bridge.dbusProxies?.systemd) {
            panel._unsubscribeUnit = bridge.dbusProxies.systemd.subscribeToUnit(
                'nftables.service',
                () => mount(panel, { bridge, EventBus }),
            );
        }
    } catch {
        // systemd proxy unavailable — manual refresh still works.
    }
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
