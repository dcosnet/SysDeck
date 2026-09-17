/*
 * SysDeck - Network Monitor Panel (v0.0.43)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * v0.0.43 REWRITE — IPTRAF-NG STYLE.
 *
 * The v0.0.10-v0.0.43 panel used `ss -tulpn` for a static socket list.
 * v0.0.43 recreates the iptraf-ng UI by reading the same kernel sources
 * iptraf-ng reads from directly — no iptraf-ng binary dependency, no
 * ncurses parsing.
 *
 * The panel has three sections (matching iptraf-ng's views):
 *   1. Interface Overview — live RX/TX rate cards (bytes/s, packets/s)
 *      per interface. Auto-refreshes every 5s. The traffic subcommand
 *      samples /proc/net/dev twice (1s apart) to compute live rates.
 *   2. IP Traffic Monitor — active TCP/UDP connections table (proto,
 *      state, local addr:port, remote addr:port, TX/RX queue). Reads
 *      /proc/net/tcp + /proc/net/udp directly.
 *   3. Protocol Statistics — IP/TCP/UDP/ICMP counters from
 *      /proc/net/snmp (InReceives, OutRequests, InDiscards, etc.).
 *
 * Data sources (same as iptraf-ng):
 *   /proc/net/dev    per-interface RX/TX byte + packet counters
 *   /proc/net/snmp   IP/TCP/UDP/ICMP protocol counters
 *   /proc/net/tcp    active TCP connections (state, local, remote)
 *   /proc/net/udp    active UDP sockets
 *
 * The traffic subcommand takes 1 second (samples /proc/net/dev twice,
 * 1s apart) — the panel shows a loading indicator during that window.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    // Load summary + connections + protocols in parallel (traffic is
    // slow — 1s — so we load it separately and show it when ready).
    const [summary, connections, protocols] = await Promise.all([
        safe(bridge.netsec.summary(), { total_interfaces: 0, total_connections: 0 }),
        safe(bridge.netsec.connections(), []),
        safe(bridge.netsec.protocols(), {}),
    ]);

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Network Monitor</h2>
            <p class="suite-panel-subtitle">
                ${summary.total_interfaces || 0} interfaces
                (${summary.interfaces_up || 0} active)
                · ${summary.total_connections || 0} connections
                · ESTABLISHED: ${summary.tcp_established || 0}
                · LISTEN: ${summary.tcp_listen || 0}
                · <button class="suite-btn suite-btn-ghost" id="btn-netsec-refresh" style="font-size:0.75rem;padding:2px 8px">↻ Refresh</button>
            </p>
        </header>

        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Interface Overview (live traffic)</h3>
                <span class="suite-muted suite-mono" id="netsec-traffic-status" style="font-size:0.8rem">sampling…</span>
            </div>
            <div id="netsec-traffic-host">
                <p class="suite-muted" style="padding:1rem">Sampling /proc/net/dev (1s window)…</p>
            </div>
        </div>

        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">IP Traffic Monitor (${connections.length} connections)</h3>
            </div>
            <div style="max-height:400px;overflow:auto">
                <table class="suite-table">
                    <thead>
                        <tr><th>Proto</th><th>State</th><th>Local</th><th>Remote</th><th>TxQ</th><th>RxQ</th></tr>
                    </thead>
                    <tbody>
                        ${connections.slice(0, 100).map((c) => `
                            <tr>
                                <td><span class="suite-badge ${c.proto === 'tcp' ? 'info' : ''}">${escapeHtml(c.proto)}</span></td>
                                <td><span class="suite-badge ${c.state === 'ESTABLISHED' ? 'success' : c.state === 'LISTEN' ? 'info' : ''}" style="font-size:0.7rem">${escapeHtml(c.state)}</span></td>
                                <td class="suite-table-mono">${escapeHtml(c.local_ip)}:${c.local_port}</td>
                                <td class="suite-table-mono ${c.remote_ip === '0.0.0.0' ? 'suite-muted' : ''}">${escapeHtml(c.remote_ip)}:${c.remote_port}</td>
                                <td class="suite-table-mono suite-muted">${c.tx_queue}</td>
                                <td class="suite-table-mono suite-muted">${c.rx_queue}</td>
                            </tr>
                        `).join('') || '<tr><td colspan="6" class="suite-muted">No active connections.</td></tr>'}
                    </tbody>
                </table>
            </div>
            ${connections.length > 100 ? `<p class="suite-muted" style="padding:0.5rem;font-size:0.8rem">Showing first 100 of ${connections.length} connections.</p>` : ''}
        </div>

        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Protocol Statistics</h3>
            </div>
            <div class="suite-card-body">
                ${renderProtocolStats(protocols)}
            </div>
        </div>
    `;

    // Load live traffic data asynchronously (1s sample window).
    loadTrafficData(panel, bridge);

    wireEvents(panel, { bridge, EventBus });
    EventBus.emit('netsec.loaded', {
        totalInterfaces: summary.total_interfaces,
        totalConnections: summary.total_connections,
    });
}

// ── Traffic data loader (async, 1s sample) ─────────────────────────

async function loadTrafficData(panel, bridge) {
    const host = panel.querySelector('#netsec-traffic-host');
    const status = panel.querySelector('#netsec-traffic-status');
    if (!host) return;
    try {
        const traffic = await bridge.netsec.traffic();
        status.textContent = `updated ${new Date().toLocaleTimeString()}`;
        host.innerHTML = renderTrafficCards(traffic);
    } catch (err) {
        status.textContent = 'error';
        host.innerHTML = `<p class="suite-muted" style="padding:1rem">Traffic sample failed: ${escapeHtml(err.message || err)}</p>`;
    }
}

function renderTrafficCards(traffic) {
    if (!traffic || !traffic.length) {
        return '<p class="suite-muted" style="padding:1rem">No network interfaces found.</p>';
    }
    return `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:0.75rem;padding:0.75rem">
            ${traffic.map((t) => {
                const rxKbps = (t.rx_bps / 1024).toFixed(1);
                const txKbps = (t.tx_bps / 1024).toFixed(1);
                const rxMbps = (t.rx_bps / (1024 * 1024)).toFixed(2);
                const txMbps = (t.tx_bps / (1024 * 1024)).toFixed(2);
                const rxRate = t.rx_bps > 1024 * 1024 ? `${rxMbps} Mbps` : `${rxKbps} KB/s`;
                const txRate = t.tx_bps > 1024 * 1024 ? `${txMbps} Mbps` : `${txKbps} KB/s`;
                const rxTotal = t.rx_bytes_total > 1024 * 1024 * 1024
                    ? `${(t.rx_bytes_total / (1024**3)).toFixed(1)} GB`
                    : t.rx_bytes_total > 1024 * 1024
                    ? `${(t.rx_bytes_total / (1024**2)).toFixed(1)} MB`
                    : `${(t.rx_bytes_total / 1024).toFixed(0)} KB`;
                const txTotal = t.tx_bytes_total > 1024 * 1024 * 1024
                    ? `${(t.tx_bytes_total / (1024**3)).toFixed(1)} GB`
                    : t.tx_bytes_total > 1024 * 1024
                    ? `${(t.tx_bytes_total / (1024**2)).toFixed(1)} MB`
                    : `${(t.tx_bytes_total / 1024).toFixed(0)} KB`;
                // Bar width relative to 1 Mbps max for visual scaling.
                const maxBps = 1024 * 1024;
                const rxBarW = Math.min(100, (t.rx_bps / maxBps) * 100);
                const txBarW = Math.min(100, (t.tx_bps / maxBps) * 100);
                return `
                    <div style="border:1px solid var(--sysdeck-border);border-radius:6px;padding:0.75rem">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
                            <strong class="suite-mono">${escapeHtml(t.iface)}</strong>
                            ${(t.rx_errs_total + t.tx_errs_total + t.rx_drop_total + t.tx_drop_total) > 0
                                ? '<span class="suite-badge danger" style="font-size:0.7rem">errors</span>'
                                : '<span class="suite-badge success" style="font-size:0.7rem">clean</span>'}
                        </div>
                        <div style="margin-bottom:0.4rem">
                            <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:0.15rem">
                                <span class="suite-muted">↓ RX</span>
                                <span class="suite-mono"><strong>${rxRate}</strong> · ${t.rx_pps} pps · total ${rxTotal}</span>
                            </div>
                            <div class="suite-progress-bar" style="height:4px">
                                <div class="suite-progress-fill" style="width:${rxBarW}%;background:var(--sysdeck-accent)"></div>
                            </div>
                        </div>
                        <div>
                            <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:0.15rem">
                                <span class="suite-muted">↑ TX</span>
                                <span class="suite-mono"><strong>${txRate}</strong> · ${t.tx_pps} pps · total ${txTotal}</span>
                            </div>
                            <div class="suite-progress-bar" style="height:4px">
                                <div class="suite-progress-fill" style="width:${txBarW}%;background:var(--sysdeck-accent-success, #28a745)"></div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function renderProtocolStats(protocols) {
    if (!protocols || protocols.error) {
        return '<p class="suite-muted">Protocol statistics unavailable.</p>';
    }
    const protos = ['ip', 'tcp', 'udp', 'icmp', 'icmp6'];
    const cards = protos.filter((p) => protocols[p]).map((p) => {
        const stats = protocols[p];
        const fields = Object.entries(stats).slice(0, 12).map(([k, v]) =>
            `<tr><td class="suite-muted">${escapeHtml(k)}</td><td class="suite-table-mono">${escapeHtml(String(v))}</td></tr>`
        ).join('');
        return `
            <div style="margin-bottom:1rem">
                <h4 class="suite-mono" style="text-transform:uppercase;color:var(--sysdeck-accent);margin-bottom:0.25rem">${escapeHtml(p)}</h4>
                <table class="suite-table" style="font-size:0.85rem">
                    <tbody>${fields}</tbody>
                </table>
            </div>
        `;
    }).join('');
    return cards || '<p class="suite-muted">No protocol data.</p>';
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }) {
    panel.querySelector('#btn-netsec-refresh')?.addEventListener('click', () => {
        mount(panel, { bridge, EventBus });
    });

    // Auto-refresh traffic every 5 seconds (the traffic subcommand
    // itself takes 1s to sample, so 5s gives a good balance between
    // freshness and load).
    if (panel._netsecTrafficInterval) clearInterval(panel._netsecTrafficInterval);
    panel._netsecTrafficInterval = setInterval(() => {
        loadTrafficData(panel, bridge);
    }, 5000);

    // Clean up interval when the panel is unmounted.
    // Cockpit doesn't have a native unmount hook, but we can detect
    // when the panel's DOM is removed via MutationObserver.
    const observer = new MutationObserver(() => {
        if (!document.body.contains(panel)) {
            clearInterval(panel._netsecTrafficInterval);
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
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
