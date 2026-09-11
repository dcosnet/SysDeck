/*
 * SysDeck - Fleet Compute Panel (v0.0.10)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * Subscribes to the bridge metrics tap for live CPU + memory samples.
 * The tap is a cockpit.metrics channel that emits derive samples at
 * the bridge's update interval; no polling required.
 *
 * Also surfaces the local host uptime via `uptime` and peer-host
 * guidance via the cockpit multi-host dashboard contract.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();
    const [uptime] = await Promise.allSettled([bridge.fleet.uptime()]);
    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Fleet Compute</h2>
            <p class="suite-panel-subtitle">Local host (fleet-of-one)</p>
        </header>
        <div class="suite-grid cols-2">
            <div class="suite-card">
                <h3 class="suite-card-title">Uptime</h3>
                <div class="suite-card-body suite-mono">${escapeHtml(uptime.value ?? 'unavailable')}</div>
            </div>
            <div class="suite-card">
                <h3 class="suite-card-title">Live CPU / Memory</h3>
                <div class="suite-card-body">
                    <div class="suite-row-between">
                        <span>CPU user</span>
                        <span class="suite-mono" id="fleet-cpu-user">—</span>
                    </div>
                    <div class="suite-progress-bar" style="margin-top:4px">
                        <div class="suite-progress-fill" id="fleet-cpu-bar" style="width:0%"></div>
                    </div>
                    <div class="suite-row-between" style="margin-top:12px">
                        <span>Memory used</span>
                        <span class="suite-mono" id="fleet-mem-used">—</span>
                    </div>
                    <div class="suite-progress-bar" style="margin-top:4px">
                        <div class="suite-progress-fill" id="fleet-mem-bar" style="width:0%"></div>
                    </div>
                </div>
            </div>
        </div>
        <div class="suite-card">
            <h3 class="suite-card-title">Peer Hosts</h3>
            <div class="suite-card-body suite-muted">
                Multi-host dashboard not enabled. Configure <code>/etc/cockpit/machines.d/</code> to surface peer hosts.
            </div>
        </div>
    `;

    // Subscribe to the live metrics tap. The unsubscribe function is
    // stashed on the panel so a re-mount can clean up.
    if (panel._unsubscribeMetrics) panel._unsubscribeMetrics();
    try {
        panel._unsubscribeMetrics = bridge.fleet.subscribeLoadAvg((samples) => {
            if (!Array.isArray(samples)) return;
            const [cpuUser, _cpuSys, memUsed, memTotal] = samples;
            if (typeof cpuUser === 'number') {
                const cpuEl = panel.querySelector('#fleet-cpu-user');
                const cpuBar = panel.querySelector('#fleet-cpu-bar');
                if (cpuEl) cpuEl.textContent = `${cpuUser.toFixed(1)}%`;
                if (cpuBar) cpuBar.style.width = `${Math.min(cpuUser, 100)}%`;
            }
            if (typeof memUsed === 'number' && typeof memTotal === 'number' && memTotal > 0) {
                const pct = (memUsed / memTotal) * 100;
                const memEl = panel.querySelector('#fleet-mem-used');
                const memBar = panel.querySelector('#fleet-mem-bar');
                if (memEl) memEl.textContent = `${formatBytes(memUsed)} / ${formatBytes(memTotal)}`;
                if (memBar) {
                    memBar.style.width = `${pct.toFixed(1)}%`;
                    memBar.classList.toggle('warn', pct > 75);
                    memBar.classList.toggle('danger', pct > 90);
                }
            }
        });
    } catch {
        // Metrics channel unavailable — bars stay at 0%.
    }

    EventBus.emit('fleet.loaded');
}

function formatBytes(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function renderSkeleton() {
    return `<div class="suite-skeleton"><div class="suite-skeleton-line w-1/3"></div></div>`;
}
