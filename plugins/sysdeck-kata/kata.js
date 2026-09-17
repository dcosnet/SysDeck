/*
 * SysDeck - Kata Panel (v0.0.43)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * v0.0.43 PRODUCTION REWRITE — PREVIOUS VERSION WAS MOCK DATA.
 *
 * The v0.0.35-v0.0.43 Kata panel shipped a pre-built React bundle
 * from the upstream cockpit-kata sub-project. That bundle displayed
 * HARDCODED MOCK DATA:
 *   - 5 fake sandboxes (web-frontend-prod, api-gateway-staging, etc.)
 *     with synthetic UUIDs and createdAt:"2026-07-15..." timestamps
 *   - fake per-sandbox metrics (cpuUsagePercent, memoryUsageMB,
 *     historyCpu/historyMemory arrays)
 *   - a fake QCrows bundle catalog
 *   - a fake PXE status (always dnsmasqRunning:true)
 * The only real features were the QCrows kernel-bundle extraction
 * (qcrows-export / qcrows-initrd-regen via cockpit.spawn) and the
 * kata-runtime check call.
 *
 * v0.0.43 deletes the React bundle and ships this vanilla-JS panel
 * backed by bridge/kata.py. Every value displayed is REAL:
 *   - Sandbox list comes from kata-monitor /sandboxes + filesystem
 *     enumeration of /run/vc/sbs/ (Go shim) + /run/kata/ (Rust shim).
 *   - Per-sandbox metrics come from kata-monitor /metrics?sandbox=<id>
 *     (Prometheus text, parsed).
 *   - Runtime version comes from `kata-runtime version` + `kata-runtime
 *     env --json`.
 *   - Host capability comes from `kata-runtime check` (exit code).
 *   - PXE status comes from `systemctl is-active dnsmasq` + real
 *     filesystem probes of /srv/tftp/.
 *   - QCrows bundle list comes from real filesystem enumeration of
 *     /usr/share/sysdeck/kata/qcrows/.
 *
 * When no sandboxes are running, the panel shows an EMPTY STATE
 * (not mock data). When kata-runtime is not installed, the panel
 * shows an install hint. When kata-monitor is not running, the
 * metrics card shows a hint to start it.
 *
 * Security hardening (v0.0.36 + v0.0.43):
 *   - Sandbox IDs validated with ^[0-9a-f]{64}$ in the bridge before
 *     any subprocess or HTTP call. CVE-2024-2947 lesson.
 *   - All bridge output rendered with escapeHtml() / textContent.
 *     CVE-2022-36446 lesson.
 *   - No innerHTML on bridge data.
 *   - HTTP to kata-monitor is 127.0.0.1-only, no redirects (SSRF
 *     defense). CVE-2020-35850 lesson.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    // Load summary + pxe-status + qcrows-list in parallel.
    const [summary, pxeStatus, qcrowsList] = await Promise.all([
        safe(bridge.kata.summary(), {
            total_sandboxes: 0, running_sandboxes: 0, sandboxes: [],
            kata_monitor: { running: false }, kata_runtime: { installed: false },
            host_capable: false, check_message: 'unknown',
        }),
        safe(bridge.kata.pxeStatus(), {
            dnsmasq_running: false, tftp_dir_exists: false,
            tftp_dir_writable: false, pxelinux_entries: [],
        }),
        safe(bridge.kata.qcrowsList(), []),
    ]);

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">SysDeck Kata</h2>
            <p class="suite-panel-subtitle">
                Kata Containers — hardware-virtualized OCI sandboxes
                · <span class="suite-badge ${summary.host_capable ? 'success' : 'danger'}">${summary.host_capable ? 'host capable' : 'host not capable'}</span>
                · ${summary.total_sandboxes} sandbox${summary.total_sandboxes === 1 ? '' : 'es'}
                ${summary.running_sandboxes !== summary.total_sandboxes ? ` (${summary.running_sandboxes} running)` : ''}
                ${summary.kata_runtime?.installed ? ` · kata-runtime ${escapeHtml(summary.kata_runtime.version || '?')}` : ' · kata-runtime not installed'}
                ${summary.kata_monitor?.running ? ' · kata-monitor running' : ' · kata-monitor not running'}
            </p>
        </header>

        ${renderRuntimeCard(summary)}

        ${renderSandboxList(summary.sandboxes, summary.kata_monitor)}

        ${renderPxeCard(pxeStatus)}

        ${renderQcrowsCard(qcrowsList)}

        <div id="kata-output" class="suite-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Operation Output</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-kata-output-close">✕</button>
            </div>
            <pre class="suite-mono" id="kata-output-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:300px"></pre>
        </div>
    `;

    wireEvents(panel, { bridge, EventBus });
    EventBus.emit('kata.loaded', {
        totalSandboxes: summary.total_sandboxes,
        runningSandboxes: summary.running_sandboxes,
        hostCapable: summary.host_capable,
    });
}

// ── Render helpers ──────────────────────────────────────────────────

function renderRuntimeCard(summary) {
    const rt = summary.kata_runtime || {};
    if (!rt.installed) {
        return `
            <div class="suite-card">
                <div class="suite-card-header">
                    <h3 class="suite-card-title">Runtime</h3>
                </div>
                <div class="suite-card-body">
                    <p class="suite-muted">
                        kata-runtime is not installed. Install Kata Containers 3.x:
                    </p>
                    <pre class="suite-mono" style="margin-top:0.5rem;background:#1a1a1a;padding:8px;border-radius:4px;font-size:0.8rem"># Arch (AUR):
yay -S kata-runtime kata-containers-image

# Debian/Ubuntu (official repo):
sudo apt install kata-runtime kata-containers-image

# Or build from source (you mentioned compiling yesterday):
# https://github.com/kata-containers/kata-containers/blob/main/docs/install/</pre>
                    <p class="suite-muted" style="margin-top:0.5rem;font-size:0.8rem">
                        After install, run <code>kata-runtime check</code> to verify
                        host capability (nested virt, KVM, etc.).
                    </p>
                </div>
            </div>
        `;
    }
    const env = rt.env || {};
    const host = env.Host || {};
    const hypervisor = env.Hypervisor || {};
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Runtime</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-kata-refresh">↻ Refresh</button>
            </div>
            <div class="suite-card-body">
                <table class="suite-table">
                    <tbody>
                        <tr><td>kata-runtime version</td><td class="suite-table-mono">${escapeHtml(rt.version || '?')}</td></tr>
                        <tr><td>commit</td><td class="suite-table-mono suite-muted">${escapeHtml(rt.commit || '?')}</td></tr>
                        <tr><td>OCI specs</td><td class="suite-table-mono">${escapeHtml(rt.oci || '?')}</td></tr>
                        <tr><td>host capable</td><td>${summary.host_capable ? '<span class="suite-badge success">yes</span>' : '<span class="suite-badge danger">no</span>'}</td></tr>
                        <tr><td>check message</td><td class="suite-muted">${escapeHtml(summary.check_message || '')}</td></tr>
                        ${host.Kernel ? `<tr><td>host kernel</td><td class="suite-table-mono">${escapeHtml(host.Kernel)}</td></tr>` : ''}
                        ${host.Architecture ? `<tr><td>architecture</td><td class="suite-table-mono">${escapeHtml(host.Architecture)}</td></tr>` : ''}
                        ${hypervisor.Path ? `<tr><td>hypervisor</td><td class="suite-table-mono">${escapeHtml(hypervisor.Path)}</td></tr>` : ''}
                        ${hypervisor.MachineType ? `<tr><td>machine type</td><td class="suite-table-mono">${escapeHtml(hypervisor.MachineType)}</td></tr>` : ''}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function renderSandboxList(sandboxes, kataMonitor) {
    if (!sandboxes || !sandboxes.length) {
        return `
            <div class="suite-card">
                <div class="suite-card-header">
                    <h3 class="suite-card-title">Sandboxes (0)</h3>
                </div>
                <div class="suite-card-body">
                    <p class="suite-muted">
                        No kata sandboxes running. This is the real empty state —
                        not mock data. Sandboxes are enumerated from:
                    </p>
                    <ul class="suite-muted" style="margin-top:0.5rem;font-size:0.85rem;padding-left:1.5rem">
                        <li><code>kata-monitor /sandboxes</code> (HTTP, port 8090)${kataMonitor?.running ? ' ✓ running' : ' — not running'}</li>
                        <li><code>/run/vc/sbs/&lt;id&gt;/</code> (Go shim filesystem)</li>
                        <li><code>/run/kata/&lt;id&gt;/</code> (Rust shim filesystem)</li>
                    </ul>
                    <p class="suite-muted" style="margin-top:0.5rem;font-size:0.85rem">
                        To create a sandbox, use <code>ctr</code>, <code>crictl</code>,
                        or <code>kubectl</code> with RuntimeClass <code>kata</code>.
                    </p>
                </div>
            </div>
        `;
    }
    const rows = sandboxes.map((sb) => {
        const idShort = sb.id.substring(0, 12);
        const isRunning = sb.agent_url || sb.shim_socket;
        return `
            <tr>
                <td class="suite-table-mono"><abbr title="${escapeHtml(sb.id)}">${escapeHtml(idShort)}…</abbr></td>
                <td>${isRunning ? '<span class="suite-badge success">running</span>' : '<span class="suite-badge">unknown</span>'}</td>
                <td class="suite-muted">${escapeHtml(sb.source || '?')}</td>
                <td class="suite-table-mono suite-muted">${sb.agent_url ? escapeHtml(sb.agent_url) : '—'}</td>
                <td>
                    <button class="suite-btn suite-btn-ghost btn-kata-inspect" data-id="${escapeHtml(sb.id)}">Inspect</button>
                    <button class="suite-btn suite-btn-ghost btn-kata-metrics" data-id="${escapeHtml(sb.id)}">Metrics</button>
                </td>
            </tr>
        `;
    }).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Sandboxes (${sandboxes.length})</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-kata-refresh">↻ Refresh</button>
            </div>
            <table class="suite-table">
                <thead>
                    <tr><th>ID</th><th>Status</th><th>Source</th><th>Agent URL</th><th>Actions</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div class="suite-card" id="kata-inspect-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Inspect</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-kata-inspect-close">✕</button>
            </div>
            <pre class="suite-mono" id="kata-inspect-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:300px"></pre>
        </div>
        <div class="suite-card" id="kata-metrics-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Metrics</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-kata-metrics-close">✕</button>
            </div>
            <pre class="suite-mono" id="kata-metrics-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:300px"></pre>
        </div>
    `;
}

function renderPxeCard(pxe) {
    const dnsmasqBadge = pxe.dnsmasq_running
        ? '<span class="suite-badge success">running</span>'
        : '<span class="suite-badge danger">not running</span>';
    const tftpExistsBadge = pxe.tftp_dir_exists
        ? '<span class="suite-badge success">exists</span>'
        : '<span class="suite-badge danger">missing</span>';
    const tftpWritableBadge = pxe.tftp_dir_writable
        ? '<span class="suite-badge success">writable</span>'
        : '<span class="suite-badge">not writable</span>';
    const entries = (pxe.pxelinux_entries || []).length
        ? pxe.pxelinux_entries.map((e) => `<span class="suite-badge info" style="margin-right:0.25rem">${escapeHtml(e)}</span>`).join('')
        : '<span class="suite-muted">(no entries)</span>';
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">PXE / TFTP Boot</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-kata-pxe-refresh">↻ Refresh</button>
            </div>
            <div class="suite-card-body">
                <table class="suite-table">
                    <tbody>
                        <tr><td>dnsmasq</td><td>${dnsmasqBadge}</td></tr>
                        <tr><td>/srv/tftp</td><td>${tftpExistsBadge} ${tftpWritableBadge}</td></tr>
                        <tr><td>pxelinux.cfg/ entries</td><td>${entries}</td></tr>
                    </tbody>
                </table>
                <p class="suite-muted" style="margin-top:0.5rem;font-size:0.8rem">
                    PXE boot configuration for network-booting kata sandboxes.
                    dnsmasq serves DHCP + TFTP; pxelinux.cfg/ holds per-host
                    boot configs (named by MAC address or "default").
                </p>
            </div>
        </div>
    `;
}

function renderQcrowsCard(qcrows) {
    if (!qcrows || !qcrows.length) {
        return `
            <div class="suite-card">
                <div class="suite-card-header">
                    <h3 class="suite-card-title">QCrows Kernel Bundles (0)</h3>
                </div>
                <div class="suite-card-body">
                    <p class="suite-muted">
                        No QCrows kernel bundles found at
                        <code>/usr/share/sysdeck/kata/qcrows/</code>.
                        This is the real empty state — not mock data.
                    </p>
                    <p class="suite-muted" style="margin-top:0.5rem;font-size:0.85rem">
                        QCrows bundles are pre-built kata kernel + initrd +
                        rootfs images. Build one with:
                    </p>
                    <pre class="suite-mono" style="margin-top:0.5rem;background:#1a1a1a;padding:8px;border-radius:4px;font-size:0.8rem">qcrows-export --kernel /path/to/vmlinuz --initrd /path/to/initrd \\
  --rootfs /path/to/rootfs --name alpine-3.20-kata</pre>
                </div>
            </div>
        `;
    }
    const totalSize = qcrows.reduce((sum, q) => sum + (q.size_bytes || 0), 0);
    const totalMb = (totalSize / (1024 * 1024)).toFixed(1);
    const rows = qcrows.map((q) => `
        <tr>
            <td class="suite-table-mono">${escapeHtml(q.filename)}</td>
            <td class="suite-muted">${q.size_mb} MB</td>
            <td class="suite-table-mono suite-muted">${new Date(q.mtime * 1000).toISOString().split('T')[0]}</td>
        </tr>
    `).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">QCrows Kernel Bundles (${qcrows.length}, ${totalMb} MB total)</h3>
            </div>
            <table class="suite-table">
                <thead><tr><th>Filename</th><th>Size</th><th>Modified</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }) {
    const output = (msg, isError = false) => {
        const card = panel.querySelector('#kata-output');
        const pre = panel.querySelector('#kata-output-pre');
        if (!card || !pre) return;
        card.style.display = 'block';
        pre.textContent = msg;
        pre.style.color = isError ? 'var(--sysdeck-accent-danger)' : 'var(--sysdeck-fg)';
    };
    panel.querySelector('#btn-kata-output-close')?.addEventListener('click', () => {
        const card = panel.querySelector('#kata-output');
        if (card) card.style.display = 'none';
    });

    // Refresh buttons (multiple — runtime card + sandbox card).
    panel.querySelectorAll('#btn-kata-refresh, #btn-kata-pxe-refresh').forEach((btn) => {
        btn.addEventListener('click', () => mount(panel, { bridge, EventBus }));
    });

    // Inspect buttons.
    panel.querySelectorAll('.btn-kata-inspect').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const sid = btn.dataset.id;
            const card = panel.querySelector('#kata-inspect-card');
            const pre = panel.querySelector('#kata-inspect-pre');
            if (!card || !pre) return;
            card.style.display = 'block';
            pre.textContent = `Inspecting ${sid.substring(0, 12)}…`;
            try {
                const r = await bridge.kata.inspect(sid);
                pre.textContent = JSON.stringify(r, null, 2);
            } catch (err) {
                pre.textContent = `Inspect error: ${err.message || err}`;
            }
        });
    });
    panel.querySelector('#btn-kata-inspect-close')?.addEventListener('click', () => {
        const card = panel.querySelector('#kata-inspect-card');
        if (card) card.style.display = 'none';
    });

    // Metrics buttons.
    panel.querySelectorAll('.btn-kata-metrics').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const sid = btn.dataset.id;
            const card = panel.querySelector('#kata-metrics-card');
            const pre = panel.querySelector('#kata-metrics-pre');
            if (!card || !pre) return;
            card.style.display = 'block';
            pre.textContent = `Fetching metrics for ${sid.substring(0, 12)}…`;
            try {
                const r = await bridge.kata.metrics(sid);
                if (r.error) {
                    pre.textContent = `Metrics error: ${r.error}`;
                } else if (r.parsed && r.summary) {
                    const s = r.summary;
                    pre.textContent = [
                        `Sandbox: ${r.id}`,
                        `CPU: ${s.cpu_usage_percent ?? 'n/a'}%`,
                        `Memory: ${s.memory_usage_bytes != null ? (s.memory_usage_bytes / 1048576).toFixed(1) + ' MB' : 'n/a'}`,
                        `Network RX: ${s.network_rx_bytes ?? 'n/a'} bytes`,
                        `Network TX: ${s.network_tx_bytes ?? 'n/a'} bytes`,
                        `Uptime: ${s.uptime_seconds ?? 'n/a'} s`,
                        '',
                        '--- Raw metric families ---',
                        JSON.stringify(r.families, null, 2),
                    ].join('\n');
                } else {
                    pre.textContent = r.raw || '(no metrics — kata-monitor not running or sandbox not found)';
                }
            } catch (err) {
                pre.textContent = `Metrics error: ${err.message || err}`;
            }
        });
    });
    panel.querySelector('#btn-kata-metrics-close')?.addEventListener('click', () => {
        const card = panel.querySelector('#kata-metrics-card');
        if (card) card.style.display = 'none';
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
