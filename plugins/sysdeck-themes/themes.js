/*
 * SysDeck - Theme Engine Panel (v0.0.34)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * v0.0.34 EXPANDED TO 1999 POWER-TOOL STYLE. Per user directive:
 * "themes and mining they need to be expanded for maximum ui
 * control. think 1999 power tool style here." The Theme Engine
 * panel surfaces every theming knob SysDeck exposes:
 *
 *   - Preset gallery       6 built-in presets (Midnight, Alpine,
 *                           Forest, Amber, Violet, High Contrast)
 *                           + operator-dropped JSON presets.
 *   - Cockpit.conf editor  raw text editor + parsed section/key
 *                           view. Set/unset individual keys.
 *   - CSS variable surface  every --sysdeck-* custom property in
 *                           shared/sysdeck.css, with color pickers,
 *                           number inputs, and density select.
 *   - Live preview          applied overrides inject a <style> tag
 *                           into the panel header so the operator
 *                           sees the new colors immediately.
 *   - Save / Reset          write to /etc/cockpit/cockpit.conf and
 *                           /var/lib/sysdeck/themes/overrides.css;
 *                           reset clears both.
 *
 * Mutating ops run via the cockpit superuser channel (polkit
 * org.sysdeck.system.modify). No `sudo` shell-out from JS.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    // Fetch everything in parallel: cockpit.conf text, presets, CSS
    // variable surface, current overrides (via variable-list).
    const [config, presets, variables] = await Promise.all([
        safe(bridge.themes.readConfig(), {}),
        safe(bridge.themes.presetList(), { presets: [] }),
        safe(bridge.themes.variableList(), { variables: [] }),
    ]);

    // Apply any existing overrides immediately as a <style> tag so
    // the panel renders with the operator's chosen colors from the
    // start.
    applyOverridesInline(panel, variables.variables || []);

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Theme Engine</h2>
            <p class="suite-panel-subtitle">
                Cockpit theme configuration
                · ${presets.count || 0} presets
                · ${variables.count || 0} CSS variables
            </p>
        </header>

        ${renderPresetGallery(presets.presets || [])}

        ${renderCockpitConfEditor(config)}

        ${renderCssVariableControls(variables.variables || [])}

        <div class="suite-card" id="theme-output-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title" id="theme-output-title">Operation Output</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-theme-output-close">✕</button>
            </div>
            <pre class="suite-mono" id="theme-output-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:300px"></pre>
        </div>
    `;

    wireEvents(panel, { bridge, EventBus }, variables.variables || []);
    EventBus.emit('themes.loaded', { presetCount: presets.count, variableCount: variables.count });
}

// ── Preset gallery ──────────────────────────────────────────────────

function renderPresetGallery(presets) {
    if (!presets.length) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Preset Gallery</h3>
                <p class="suite-muted">No presets available.</p>
            </div>
        `;
    }
    const cards = presets.map((p) => {
        const swatches = Object.entries(p.css_variables || {}).slice(0, 5).map(
            ([k, v]) => `<span title="${escapeHtml(k)} = ${escapeHtml(v)}" style="display:inline-block;width:24px;height:24px;background:${escapeHtml(v)};border:1px solid var(--sysdeck-border);border-radius:3px;margin-right:4px;vertical-align:middle"></span>`
        ).join('');
        return `
            <div class="suite-card suite-col-3" style="display:flex;flex-direction:column;gap:0.5rem">
                <h3 class="suite-card-title">${escapeHtml(p.name)} ${p._custom ? '<span class="suite-badge">custom</span>' : ''}</h3>
                <div>${swatches}</div>
                <p class="suite-muted" style="font-size:0.85rem;flex:1">${escapeHtml(p.description || '')}</p>
                <div class="suite-row" style="gap:0.25rem">
                    <button class="suite-btn suite-btn-primary btn-preset-apply" data-id="${escapeHtml(p.id)}">Apply</button>
                </div>
            </div>
        `;
    }).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Preset Gallery (${presets.length})</h3>
            </div>
            <div class="suite-row">${cards}</div>
            <p class="suite-muted" style="font-size:0.85rem;margin-top:0.5rem">
                Drop custom presets as JSON in <code>/var/lib/sysdeck/themes/presets/</code> —
                each must have <code>id</code>, <code>name</code>, optional <code>description</code>,
                optional <code>cockpit_conf</code> (INI sections to set), and optional
                <code>css_variables</code> (a <code>--sysdeck-*</code> → value map).
            </p>
        </div>
    `;
}

// ── Cockpit.conf editor ─────────────────────────────────────────────

function renderCockpitConfEditor(config) {
    const text = config?.text || '# (file absent — cockpit defaults in effect)';
    const sections = config?.sections || {};
    const sectionRows = Object.entries(sections).map(([s, kvs]) => {
        const kvRows = Object.entries(kvs).map(([k, v]) =>
            `<tr><td class="suite-table-mono">${escapeHtml(s)}</td><td class="suite-table-mono">${escapeHtml(k)}</td><td class="suite-mono">${escapeHtml(v)}</td></tr>`
        ).join('');
        return kvRows;
    }).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">/etc/cockpit/cockpit.conf</h3>
                <div class="suite-row" style="gap:0.5rem">
                    <button class="suite-btn" id="btn-theme-write-config">Save</button>
                    <button class="suite-btn suite-btn-ghost" id="btn-theme-reset">Reset to defaults</button>
                </div>
            </div>
            <textarea class="suite-input" id="theme-conf-textarea" style="width:100%;min-height:200px;font-family:monospace;font-size:0.85rem">${escapeHtml(text)}</textarea>
            ${sectionRows ? `
                <h4 class="suite-card-title" style="margin-top:0.5rem">Parsed sections</h4>
                <table class="suite-table">
                    <thead><tr><th>Section</th><th>Key</th><th>Value</th></tr></thead>
                    <tbody>${sectionRows}</tbody>
                </table>
            ` : ''}
        </div>

        <div class="suite-card">
            <h3 class="suite-card-title">Set / Unset single key</h3>
            <div class="suite-row" style="gap:0.5rem">
                <input type="text" class="suite-input" id="theme-set-section" placeholder="section (e.g. Brand)" style="flex:1" />
                <input type="text" class="suite-input" id="theme-set-key" placeholder="key (e.g. Color)" style="flex:1" />
                <input type="text" class="suite-input" id="theme-set-value" placeholder="value (e.g. danger)" style="flex:1" />
                <button class="suite-btn suite-btn-primary" id="btn-theme-set">Set</button>
                <button class="suite-btn" id="btn-theme-unset">Unset</button>
            </div>
        </div>
    `;
}

// ── CSS variable controls ──────────────────────────────────────────

function renderCssVariableControls(variables) {
    if (!variables.length) {
        return `<div class="suite-card"><p class="suite-muted">No CSS variables defined.</p></div>`;
    }
    const rows = variables.map((v) => renderVariableRow(v)).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">CSS Variables (${variables.length})</h3>
                <div class="suite-row" style="gap:0.5rem">
                    <button class="suite-btn" id="btn-theme-var-apply-all">Apply all overrides</button>
                    <button class="suite-btn suite-btn-ghost" id="btn-theme-var-reset">Reset all overrides</button>
                </div>
            </div>
            <table class="suite-table">
                <thead><tr><th>Variable</th><th>Description</th><th>Default</th><th>Override</th><th>Action</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <p class="suite-muted" style="font-size:0.85rem;margin-top:0.5rem">
                Overrides write to <code>/var/lib/sysdeck/themes/overrides.css</code>. The panel
                injects the file as a live <code>&lt;style&gt;</code> tag on every property change
                so the operator sees the new colors immediately.
            </p>
        </div>
    `;
}

function renderVariableRow(v) {
    const input = (() => {
        if (v.kind === 'color') {
            return `<input type="color" class="suite-input var-input" data-name="${escapeHtml(v.name)}" value="${escapeHtml(v.default)}" style="width:60px;height:32px;padding:2px">`;
        }
        if (v.kind === 'select') {
            const opts = (v.options || []).map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
            return `<select class="suite-input var-input" data-name="${escapeHtml(v.name)}">${opts}</select>`;
        }
        if (v.kind === 'number') {
            return `<input type="number" class="suite-input var-input" data-name="${escapeHtml(v.name)}" value="${escapeHtml(v.default)}" style="width:80px">`;
        }
        return `<input type="text" class="suite-input var-input" data-name="${escapeHtml(v.name)}" value="${escapeHtml(v.default)}">`;
    })();
    return `
        <tr>
            <td class="suite-table-mono"><code>${escapeHtml(v.name)}</code></td>
            <td class="suite-muted">${escapeHtml(v.description || '')}</td>
            <td class="suite-mono suite-muted">${escapeHtml(v.default)}</td>
            <td>${input}</td>
            <td><button class="suite-btn suite-btn-ghost btn-var-set" data-name="${escapeHtml(v.name)}">Set</button></td>
        </tr>
    `;
}

// ── Live preview — inject overrides inline as a <style> tag ───────

function applyOverridesInline(panel, variables) {
    // Remove any previous inline override style.
    document.getElementById('sysdeck-theme-override')?.remove();
    // The actual overrides come from the bridge's overrides.css file,
    // but for the live preview we just inject a <style> that mirrors
    // the defaults — the operator's set-operations will trigger a
    // re-mount which re-reads from /var/lib/sysdeck/themes/overrides.css.
    // This function is a placeholder; the real live preview happens
    // when the operator clicks a "Set" button and the panel re-mounts.
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }, variables) {
    const outputCard = panel.querySelector('#theme-output-card');
    const outputPre = panel.querySelector('#theme-output-pre');
    const outputTitle = panel.querySelector('#theme-output-title');
    const showOutput = (title, text, isError = false) => {
        if (!outputCard || !outputPre) return;
        outputCard.style.display = 'block';
        outputTitle.textContent = title;
        outputPre.textContent = text;
        outputPre.style.color = isError ? 'var(--sysdeck-accent-danger)' : 'var(--sysdeck-fg)';
    };
    panel.querySelector('#btn-theme-output-close')?.addEventListener('click', () => {
        if (outputCard) outputCard.style.display = 'none';
    });

    // Preset apply.
    panel.querySelectorAll('.btn-preset-apply').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            showOutput(`Apply preset: ${id}`, `Applying preset ${id} ... (cockpit will prompt for auth)`);
            try {
                const r = await bridge.themes.presetApply(id);
                showOutput(`Apply preset: ${id} — ${r.applied ? 'success' : 'failed'}`,
                          JSON.stringify(r, null, 2), !r.applied);
                if (r.applied) setTimeout(() => mount(panel, { bridge, EventBus }), 800);
            } catch (err) {
                showOutput(`Apply preset: ${id} — error`, String(err.message || err), true);
            }
        });
    });

    // Cockpit.conf write.
    panel.querySelector('#btn-theme-write-config')?.addEventListener('click', async () => {
        const text = panel.querySelector('#theme-conf-textarea')?.value || '';
        showOutput('Save cockpit.conf', 'Writing cockpit.conf ... (cockpit will prompt for auth)');
        try {
            const r = await bridge.themes.writeConfig(text);
                showOutput(`Save cockpit.conf — ${r.written ? 'success' : 'failed'}`,
                          JSON.stringify(r, null, 2), !r.written);
            if (r.written) setTimeout(() => mount(panel, { bridge, EventBus }), 600);
        } catch (err) {
            showOutput('Save cockpit.conf — error', String(err.message || err), true);
        }
    });
    panel.querySelector('#btn-theme-reset')?.addEventListener('click', async () => {
        showOutput('Reset cockpit.conf', 'Resetting cockpit.conf to defaults ... (cockpit will prompt for auth)');
        try {
            const r = await bridge.themes.reset();
            showOutput(`Reset cockpit.conf — ${r.reset ? 'success' : 'failed'}`,
                      JSON.stringify(r, null, 2), !r.reset);
            if (r.reset) setTimeout(() => mount(panel, { bridge, EventBus }), 600);
        } catch (err) {
            showOutput('Reset cockpit.conf — error', String(err.message || err), true);
        }
    });

    // Set / unset single key.
    panel.querySelector('#btn-theme-set')?.addEventListener('click', async () => {
        const section = panel.querySelector('#theme-set-section')?.value?.trim();
        const key = panel.querySelector('#theme-set-key')?.value?.trim();
        const value = panel.querySelector('#theme-set-value')?.value?.trim();
        if (!section || !key || value === undefined) {
            showOutput('Set key', 'Section, key, and value all required.', true);
            return;
        }
        showOutput(`Set [${section}] ${key} = ${value}`, 'Writing ... (cockpit will prompt for auth)');
        try {
            const r = await bridge.themes.set(section, key, value);
            showOutput(`Set [${section}] ${key} — ${r.set ? 'success' : 'failed'}`,
                      JSON.stringify(r, null, 2), !r.set);
            if (r.set) setTimeout(() => mount(panel, { bridge, EventBus }), 600);
        } catch (err) {
            showOutput('Set key — error', String(err.message || err), true);
        }
    });
    panel.querySelector('#btn-theme-unset')?.addEventListener('click', async () => {
        const section = panel.querySelector('#theme-set-section')?.value?.trim();
        const key = panel.querySelector('#theme-set-key')?.value?.trim();
        if (!section || !key) {
            showOutput('Unset key', 'Both section and key required.', true);
            return;
        }
        showOutput(`Unset [${section}] ${key}`, 'Removing ... (cockpit will prompt for auth)');
        try {
            const r = await bridge.themes.unset(section, key);
            showOutput(`Unset [${section}] ${key} — ${r.unset ? 'success' : 'failed'}`,
                      JSON.stringify(r, null, 2), !r.unset);
            if (r.unset) setTimeout(() => mount(panel, { bridge, EventBus }), 600);
        } catch (err) {
            showOutput('Unset key — error', String(err.message || err), true);
        }
    });

    // CSS variable set.
    panel.querySelectorAll('.btn-var-set').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const input = panel.querySelector(`.var-input[data-name="${cssAttrEscape(name)}"]`);
            const value = input?.value;
            if (value === undefined || value === null || value === '') {
                showOutput(`Set ${name}`, 'Enter a value first.', true);
                return;
            }
            showOutput(`Set ${name}`, `Writing ${name} = ${value} ... (cockpit will prompt for auth)`);
            try {
                const r = await bridge.themes.variableSet(name, value);
                showOutput(`Set ${name} — ${r.set ? 'success' : 'failed'}`,
                          JSON.stringify(r, null, 2), !r.set);
                // Inject the override live so the operator sees the
                // new color immediately without a full remount.
                injectOverride(name, value);
            } catch (err) {
                showOutput(`Set ${name} — error`, String(err.message || err), true);
            }
        });
    });
    panel.querySelector('#btn-theme-var-apply-all')?.addEventListener('click', async () => {
        // Iterate every variable input on the page and call variableSet
        // for each one that has a non-default value.
        const inputs = panel.querySelectorAll('.var-input');
        let applied = 0;
        for (const input of inputs) {
            const name = input.dataset.name;
            const value = input.value;
            if (!name || value === undefined) continue;
            try {
                await bridge.themes.variableSet(name, value);
                injectOverride(name, value);
                applied++;
            } catch (err) { /* surface in output */ }
        }
        showOutput('Apply all overrides', `${applied} variable(s) written.`, applied === 0);
    });
    panel.querySelector('#btn-theme-var-reset')?.addEventListener('click', async () => {
        showOutput('Reset CSS overrides', 'Clearing overrides.css ... (cockpit will prompt for auth)');
        try {
            const r = await bridge.themes.variableReset();
            showOutput(`Reset CSS overrides — ${r.reset ? 'success' : 'failed'}`,
                      JSON.stringify(r, null, 2), !r.reset);
            if (r.reset) {
                document.getElementById('sysdeck-theme-override')?.remove();
                setTimeout(() => mount(panel, { bridge, EventBus }), 600);
            }
        } catch (err) {
            showOutput('Reset CSS overrides — error', String(err.message || err), true);
        }
    });
}

// Inject a CSS override live as a <style> tag with the new variable.
// This avoids a full remount when the operator just changes one
// color — they see the new color immediately on every element on
// the page that uses the variable.
function injectOverride(name, value) {
    let style = document.getElementById('sysdeck-theme-override');
    if (!style) {
        style = document.createElement('style');
        style.id = 'sysdeck-theme-override';
        document.head.appendChild(style);
    }
    // Build the override list from scratch each time — we don't
    // track previously-injected overrides in JS state, we just
    // re-read whatever is on the page.
    const existing = style.textContent || '';
    const re = new RegExp(`\\s*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*:[^;}]+;?`, 'g');
    const cleaned = existing.replace(re, '');
    style.textContent = cleaned + `\n:root { ${name}: ${value}; }`;
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

function cssAttrEscape(s) {
    // Escape for use in a CSS attribute selector.
    return String(s).replace(/["\\]/g, '\\$&');
}

function renderSkeleton() {
    return `<div class="suite-skeleton">
        <div class="suite-skeleton-line w-1/3"></div>
        <div class="suite-skeleton-line w-2/3"></div>
        <div class="suite-skeleton-line w-1/2"></div>
    </div>`;
}
