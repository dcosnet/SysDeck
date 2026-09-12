/*
 * SysDeck - Sensors Panel (v0.0.11)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * Hardware sensor readings from lm_sensors. Attributes the
 * cockpit-sensors plugin (MIT, ocristopfer) whose standalone plugin
 * lives at https://github.com/ocristopfer/cockpit-sensors.
 *
 * This panel invokes `sensors -j` via cockpit.spawn as a separate
 * process — no cockpit-sensors code is bundled.
 *
 * Shows temperature, fan speed, and voltage readings grouped by
 * hardware adapter.
 *
 * v0.1.4 SECURITY: adapter names and sensor keys come from `sensors -j`
 * output (driver-controlled chip labels — a malicious/things driver or
 * SMBus device controls them) and error messages from spawn — all now
 * escaped before innerHTML (0.3.0 audit).
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

    let data = {};
    try {
        data = await bridge.sensors.summary();
    } catch (err) {
        panel.innerHTML = renderError(err);
        return;
    }

    const temps = filterSensors(data, (key) => /temp|core|tctl/i.test(key));
    const fans = filterSensors(data, (key) => /fan/i.test(key));
    const voltages = filterSensors(data, (key) => /^in|vcore|vbat/i.test(key));

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Hardware Sensors</h2>
            <p class="suite-panel-subtitle">lm_sensors + cockpit-sensors integration</p>
            <span class="suite-badge info">MIT · ocristopfer</span>
        </header>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Temperatures</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-sensors-refresh">↻ Refresh</button>
            </div>
            <table class="suite-table">
                <thead><tr><th>Adapter</th><th>Sensor</th><th>Value</th><th>Critical</th></tr></thead>
                <tbody>
                    ${Object.entries(temps).flatMap(([adapter, sensors]) =>
                        Object.entries(sensors).map(([key, val]) => `<tr>
                            <td>${escapeHtml(adapter)}</td>
                            <td class="suite-table-mono">${escapeHtml(key)}</td>
                            <td>${escapeHtml(sensorVal(val, 'temp'))}°C</td>
                            <td class="suite-muted">${escapeHtml(sensorCrit(val))}</td>
                        </tr>`)
                    ).join('') || '<tr><td colspan="4" class="suite-muted">No temperature sensors.</td></tr>'}
                </tbody>
            </table>
        </div>
        <div class="suite-card">
            <h3 class="suite-card-title">Fan Speeds</h3>
            <table class="suite-table">
                <thead><tr><th>Adapter</th><th>Sensor</th><th>RPM</th></tr></thead>
                <tbody>
                    ${Object.entries(fans).flatMap(([adapter, sensors]) =>
                        Object.entries(sensors).map(([key, val]) => `<tr>
                            <td>${escapeHtml(adapter)}</td>
                            <td class="suite-table-mono">${escapeHtml(key)}</td>
                            <td>${escapeHtml(sensorVal(val, 'fan'))} RPM</td>
                        </tr>`)
                    ).join('') || '<tr><td colspan="3" class="suite-muted">No fan sensors.</td></tr>'}
                </tbody>
            </table>
        </div>
        <div class="suite-card">
            <h3 class="suite-card-title">Voltages</h3>
            <table class="suite-table">
                <thead><tr><th>Adapter</th><th>Sensor</th><th>Volts</th></tr></thead>
                <tbody>
                    ${Object.entries(voltages).flatMap(([adapter, sensors]) =>
                        Object.entries(sensors).map(([key, val]) => `<tr>
                            <td>${escapeHtml(adapter)}</td>
                            <td class="suite-table-mono">${escapeHtml(key)}</td>
                            <td>${escapeHtml(sensorVal(val, 'in'))} V</td>
                        </tr>`)
                    ).join('') || '<tr><td colspan="3" class="suite-muted">No voltage sensors.</td></tr>'}
                </tbody>
            </table>
        </div>
    `;

    panel.querySelector('#btn-sensors-refresh')?.addEventListener('click', () => {
        mount(panel, { bridge, EventBus });
    });
}

function filterSensors(data, predicate) {
    const result = {};
    Object.entries(data).forEach(([adapter, sensors]) => {
        const filtered = Object.fromEntries(
            Object.entries(sensors).filter(([key]) => predicate(key))
        );
        if (Object.keys(filtered).length > 0) result[adapter] = filtered;
    });
    return result;
}

function sensorVal(val, prefix) {
    if (typeof val === 'number') return val.toFixed(1);
    if (typeof val === 'object' && val !== null) {
        // lm_sensors JSON: { input: 45.0, crit: 100.0, max: 80.0 }
        const inputKey = Object.keys(val).find((k) => k.startsWith(prefix) && k.endsWith('_input')) || 'input';
        return (val[inputKey] ?? val.input ?? 0).toFixed(1);
    }
    return String(val);
}

function sensorCrit(val) {
    if (typeof val === 'object' && val !== null) {
        const critKey = Object.keys(val).find((k) => k.includes('crit'));
        if (critKey && val[critKey] != null) return val[critKey].toFixed(1) + '°C';
    }
    return '—';
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
        <h3 class="suite-card-title">Sensors unavailable</h3>
        <p class="suite-card-body suite-muted">${escapeHtml(err.message || err)}. Install lm_sensors (pacman -S lm_sensors) and ensure sensors-detect has been run.</p>
        <p class="suite-muted">cockpit-sensors (MIT) by ocristopfer — <a href="https://github.com/ocristopfer/cockpit-sensors">https://github.com/ocristopfer/cockpit-sensors</a></p>
    </div>`;
}
