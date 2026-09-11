/*
 * SysDeck - Encryption Vault Panel
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * Lists LUKS-encrypted block devices via `lsblk -J`. The bridge parser
 * filters to fstype=crypto_LUKS and surfaces device name + size.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();
    let luks = [];
    try {
        luks = await bridge.vault.listLuks();
    } catch (err) {
        panel.innerHTML = renderError(err);
        return;
    }
    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Encryption Vault</h2>
            <p class="suite-panel-subtitle">${luks.length} LUKS volumes detected</p>
        </header>
        <div class="suite-card">
            <table class="suite-table">
                <thead><tr><th>Device</th><th>FSType</th><th>Mountpoint</th><th>Size</th></tr></thead>
                <tbody>
                    ${luks.map((d) => `
                        <tr>
                            <td class="suite-table-mono">${d.name}</td>
                            <td><span class="suite-badge warn">${d.fstype}</span></td>
                            <td class="suite-muted">${d.mountpoint ?? '—'}</td>
                            <td class="suite-table-mono">${d.size ?? '—'}</td>
                        </tr>
                    `).join('') || '<tr><td colspan="4" class="suite-muted">No LUKS volumes found.</td></tr>'}
                </tbody>
            </table>
        </div>
    `;
    EventBus.emit('vault.loaded', { luksCount: luks.length });
}

function renderSkeleton() {
    return `<div class="suite-skeleton"><div class="suite-skeleton-line w-1/2"></div></div>`;
}

function renderError(err) {
    return `<div class="suite-card"><h3 class="suite-card-title">lsblk unavailable</h3><p class="suite-card-body suite-muted">${err.message || err}.</p></div>`;
}
