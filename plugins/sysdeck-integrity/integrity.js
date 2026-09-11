/*
 * SysDeck - Integrity Panel (v0.0.10)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * Calls lynis audit system via cockpit.spawn. Falls back gracefully
 * when lynis is absent — the trust score becomes null and the panel
 * shows an install hint.
 *
 * Uses the systemd dbus proxy to surface the integrity-scanner service
 * state without polling. The proxy fires 'changed' when the unit state
 * transitions; the panel re-fetches the trust score on that signal.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    const trust = await bridge.integrity.trustScore();

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Integrity Auditor</h2>
            <p class="suite-panel-subtitle">Lynis system audit</p>
        </header>
        <div class="suite-grid cols-3">
            <div class="suite-card">
                <h3 class="suite-card-title">Trust Score</h3>
                <div class="suite-card-body">
                    ${trust !== null
                        ? `<div style="font-size:48px;font-weight:700;color:${scoreColor(trust)}">${trust}<span style="font-size:18px;color:var(--suite-fg-muted)">/100</span></div>`
                        : '<p class="suite-muted">Lynis not installed.</p>'}
                </div>
            </div>
            <div class="suite-card">
                <h3 class="suite-card-title">Quick Actions</h3>
                <div class="suite-card-body suite-row">
                    <button class="suite-btn suite-btn-primary" id="btn-run-lynis">Run Full Audit</button>
                </div>
            </div>
            <div class="suite-card">
                <h3 class="suite-card-title">Scanner Status</h3>
                <div class="suite-card-body">
                    <div class="suite-row-between"><span>lynis</span><span class="suite-badge ${trust !== null ? 'success' : 'danger'}">${trust !== null ? 'ready' : 'missing'}</span></div>
                    <div class="suite-row-between" style="margin-top:8px"><span>rkhunter</span><span class="suite-badge info">deferred</span></div>
                    <div class="suite-row-between" style="margin-top:8px"><span>chkrootkit</span><span class="suite-badge info">deferred</span></div>
                </div>
            </div>
        </div>
    `;

    const runBtn = panel.querySelector('#btn-run-lynis');
    if (runBtn) {
        runBtn.addEventListener('click', async () => {
            runBtn.disabled = true;
            runBtn.textContent = 'Running audit…';
            try {
                await bridge.integrity.runLynis();
                EventBus.emit('integrity.scan.complete');
                mount(panel, { bridge, EventBus });
            } catch (err) {
                runBtn.textContent = 'Run Full Audit';
                runBtn.disabled = false;
                EventBus.emit('integrity.scan.error', { error: err.message });
            }
        });
    }

    // Subscribe to lynis.service state changes via the systemd dbus proxy.
    // On any transition, re-fetch the trust score so the panel reflects
    // the most recent audit result without manual refresh.
    if (panel._unsubscribeUnit) panel._unsubscribeUnit();
    try {
        if (bridge.dbusProxies?.systemd) {
            panel._unsubscribeUnit = bridge.dbusProxies.systemd.subscribeToUnit(
                'lynis.service',
                () => mount(panel, { bridge, EventBus }),
            );
        }
    } catch {
        // systemd proxy unavailable — manual refresh still works.
    }
}

const SCORE_COLORS = [
    { min: 90, color: 'var(--suite-accent-success)' },
    { min: 70, color: 'var(--suite-accent-warn)' },
    { min: 0,  color: 'var(--suite-accent-danger)' },
];

function scoreColor(score) {
    // Step-down: lookup table over if-ladder. First match wins.
    const entry = SCORE_COLORS.find((band) => score >= band.min);
    return entry?.color ?? 'var(--suite-accent-danger)';
}

function renderSkeleton() {
    return `<div class="suite-skeleton">
        <div class="suite-skeleton-line w-1/3"></div>
        <div class="suite-skeleton-line w-2/3"></div>
    </div>`;
}
