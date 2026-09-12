/*
 * SysDeck - Hardware Auth Panel
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * Lists smartcard reader slots via pkcs11-tool. Falls back to a hint
 * card when opensc / pcsc-lite is absent.
 *
 * v0.1.4 SECURITY + FIX: reader descriptions are USB string
 * descriptors — attacker-controllable via a malicious device — and
 * are now escaped before landing in innerHTML (0.3.0 audit). The
 * Quick Actions used to call bridge.spawn(), which bridge.js never
 * exported (the buttons always threw); they now use the auth bridge's
 * certs/readers subcommands and render output via textContent.
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
                    ? `<ul>${slots.map((s) => `<li class="suite-mono">${escapeHtml(s.description)}</li>`).join('')}</ul>`
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
        <div class="suite-card" id="auth-output-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title" id="auth-output-title">Output</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-auth-output-close">✕</button>
            </div>
            <pre class="suite-card-body suite-mono" id="auth-output-pre" style="white-space:pre-wrap;overflow:auto;max-height:400px"></pre>
        </div>
    `;

    const outputCard = panel.querySelector('#auth-output-card');
    const outputPre = panel.querySelector('#auth-output-pre');
    const outputTitle = panel.querySelector('#auth-output-title');
    const showOutput = (title, text) => {
        if (!outputCard || !outputPre) return;
        outputCard.style.display = 'block';
        outputTitle.textContent = title;
        // textContent — raw pkcs11-tool output never parses as HTML.
        outputPre.textContent = text;
    };
    panel.querySelector('#btn-auth-output-close')?.addEventListener('click', () => {
        if (outputCard) outputCard.style.display = 'none';
    });

    panel.querySelector('#btn-list-certs')?.addEventListener('click', async () => {
        try {
            const r = await bridge.auth.certs();
            EventBus.emit('auth.list-certs', { count: r.count || 0 });
            showOutput('Certificates', r.available
                ? `${r.output}\n\n(${r.count} certificate object(s))`
                : `${r.reason}`);
        } catch (err) {
            showOutput('Certificates — error', String(err.message || err));
        }
    });
    panel.querySelector('#btn-reader-info')?.addEventListener('click', async () => {
        try {
            const readers = await bridge.auth.readers();
            showOutput('Reader Info', readers.length
                ? readers.map((r) => r.description).join('\n')
                : 'No smartcard-class USB devices found (lsusb).');
        } catch (err) {
            showOutput('Reader Info — error', String(err.message || err));
        }
    });
}

function renderSkeleton() {
    return `<div class="suite-skeleton"><div class="suite-skeleton-line w-1/2"></div></div>`;
}
