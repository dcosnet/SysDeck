/*
 * SysDeck - Firmware Panel
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * Uses fwupdmgr to enumerate firmware devices and tpm2_pcrread to dump
 * the first PCR register (boot chain proof). Both calls fail closed
 * with informative cards when the underlying tools are absent.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();
    const [devices, tpmPcr0] = await Promise.allSettled([
        bridge.firmware.devices(),
        bridge.firmware.tpmInfo(),
    ]);
    const deviceList = devices.value?.Devices ?? [];
    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Firmware Control</h2>
            <p class="suite-panel-subtitle">fwupd + TPM 2.0</p>
        </header>
        <div class="suite-card">
            <h3 class="suite-card-title">fwupd Devices (${deviceList.length})</h3>
            <table class="suite-table">
                <thead><tr><th>Name</th><th>Vendor</th><th>Version</th><th>Flags</th></tr></thead>
                <tbody>
                    ${deviceList.map((d) => `
                        <tr>
                            <td>${d.Name}</td>
                            <td class="suite-muted">${d.Vendor ?? '—'}</td>
                            <td class="suite-table-mono">${d.Version ?? '—'}</td>
                            <td class="suite-muted">${(d.Flags ?? []).join(', ') || '—'}</td>
                        </tr>
                    `).join('') || '<tr><td colspan="4" class="suite-muted">No fwupd devices.</td></tr>'}
                </tbody>
            </table>
        </div>
        <div class="suite-card">
            <h3 class="suite-card-title">TPM 2.0 — PCR 0 (SHA256)</h3>
            <pre class="suite-card-body suite-mono">${escapeHtml(tpmPcr0.value ?? 'tpm2-tools not installed')}</pre>
        </div>
    `;
    EventBus.emit('firmware.loaded', { deviceCount: deviceList.length });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function renderSkeleton() {
    return `<div class="suite-skeleton"><div class="suite-skeleton-line w-1/3"></div><div class="suite-skeleton-line w-2/3"></div></div>`;
}
