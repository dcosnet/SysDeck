/*
 * SysDeck - Hardware Auth Panel
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * Lists smartcard reader slots via pkcs11-tool. Falls back to a hint
 * card when opensc / pcsc-lite is absent.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();
    const slots = await bridge.auth.smartcards();
    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Hardware Auth</h2>
            <p class="suite-panel-subtitle">PKCS#11 / pcsc-lite — ${slots.length} slots</p>
        </header>
        <div class="suite-card">
            <h3 class="suite-card-title">Smartcard Readers</h3>
            <div class="suite-card-body">
                ${slots.length
                    ? `<ul>${slots.map((s) => `<li class="suite-mono">${s.description}</li>`).join('')}</ul>`
                    : '<p class="suite-muted">No smartcard readers detected. Install <code>opensc</code> and <code>pcsc-lite</code>, then start <code>pcscd.service</code>.</p>'}
            </div>
        </div>
        <div class="suite-card">
            <h3 class="suite-card-title">Quick Actions</h3>
            <div class="suite-card-body suite-row">
                <button class="suite-btn" id="btn-list-certs">List Certificates</button>
                <button class="suite-btn" id="btn-reader-info">Reader Info</button>
            </div>
        </div>
    `;
    panel.querySelector('#btn-list-certs')?.addEventListener('click', async () => {
        try {
            const out = await bridge.spawn(['pkcs11-tool', '--list-objects', '--type', 'cert']);
            EventBus.emit('auth.list-certs', { count: (out.match(/Certificate/g) || []).length });
            alert(out);
        } catch (err) { alert(err.message || err); }
    });
    panel.querySelector('#btn-reader-info')?.addEventListener('click', async () => {
        try {
            const out = await bridge.spawn(['pcsc_scan']);
            alert(out);
        } catch (err) { alert(err.message || err); }
    });
}

function renderSkeleton() {
    return `<div class="suite-skeleton"><div class="suite-skeleton-line w-1/2"></div></div>`;
}
