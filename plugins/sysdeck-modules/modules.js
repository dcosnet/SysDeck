/*
 * SysDeck — 3rd-Party Modules Panel (v0.0.46)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * Catalog-driven installer for third-party Cockpit modules.
 *
 * DESIGN (per v0.0.46 directive): the license, developer/author,
 * 3rd-party module name, and a homepage link are rendered INLINE
 * in every catalog row. The Install button is a TRUE 1-click install
 * — clicking it is the operator's acceptance of the inline-displayed
 * license. No modal, no extra confirmation step.
 *
 * The bridge helper (modules3p.py) still refuses silent installs:
 * install() requires --accept-license=1. The JS always passes that
 * flag on every click, because the license is shown inline next to
 * the button — clicking Install IS the acceptance gesture.
 *
 * Flow:
 *   1. bridge.modules3p.status()              → renders rows
 *   2. operator clicks Install on a row
 *   3. bridge.modules3p.install(id, true)      → 1 click, runs as root via polkit
 *   4. bridge appends an audit record to /etc/cockpit/MODULE_LICENSES.log
 *   5. JS re-renders the catalog
 *
 * Uninstall follows the same pattern: 1 click, runs uninstall, audit.
 */

const LICENSE_SHORT_NAMES = {
    "MIT":        { cls: "success", note: "permissive — retains copyright + notice" },
    "LGPL-2.1":   { cls: "info",    note: "weak copyleft — derivatives of the library must stay LGPL" },
    "LGPL-2.1+":  { cls: "info",    note: "weak copyleft — or-later" },
    "GPL-2.0":    { cls: "warn",    note: "copyleft — derivative works must be GPL-2.0+" },
    "GPL-2.0+":   { cls: "warn",    note: "copyleft — or-later" },
    "GPL-3.0":    { cls: "warn",    note: "copyleft — derivative works must be GPL-3.0+" },
    "AGPL-3.0":   { cls: "warn",    note: "strong copyleft — network use triggers source disclosure" },
    "Apache-2.0": { cls: "success", note: "permissive — retains NOTICE file + patent grant" },
    "BSD-2-Clause": { cls: "success", note: "permissive — retains copyright + notice" },
    "BSD-3-Clause": { cls: "success", note: "permissive — retains copyright + notice + no endorsement" },
};

function licenseBadge(lic) {
    const meta = LICENSE_SHORT_NAMES[lic] || { cls: "info", note: "see upstream for terms" };
    return `<span class="sysdeck-badge ${meta.cls}" title="${esc(meta.note)}">${esc(lic)}</span>`;
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
}

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    let catalog = [];
    try {
        catalog = await bridge.modules3p.status();
    } catch (err) {
        panel.innerHTML = renderError("Catalog unavailable", err);
        return;
    }

    panel.innerHTML = renderShell(catalog);
    wireUp(panel, catalog, bridge);
}

function renderShell(catalog) {
    const categories = unique(catalog.map((m) => m.category)).sort();
    const total = catalog.length;
    const installed = catalog.filter((m) => m.installed).length;
    const missingDeps = catalog.filter((m) => m.missing_deps?.length > 0).length;

    return `
        <header>
            <h2 class="sysdeck-panel-title">3rd-Party Cockpit Modules</h2>
            <p class="sysdeck-panel-subtitle">
                Optional add-ons. License, developer, source, and homepage
                are shown inline next to each Install button — clicking
                Install is your acceptance of the displayed license.
            </p>
            <div class="modules-filter">
                <select id="modules-filter-category">
                    <option value="">All categories</option>
                    ${categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
                </select>
                <input id="modules-filter-search" type="text" placeholder="filter by name / author / license" />
                <span class="sysdeck-muted" style="margin-left:auto;font-size:0.82rem;">
                    ${installed}/${total} installed · ${missingDeps} with missing deps
                </span>
            </div>
        </header>

        <div id="modules-grid" class="modules-grid">
            ${catalog.map((m) => renderRow(m)).join("")}
        </div>

        <div class="sysdeck-card">
            <div class="sysdeck-card-header">
                <h3 class="sysdeck-card-title">License Audit Log</h3>
                <button class="sysdeck-btn sysdeck-btn-ghost" id="modules-audit-refresh">↻ Refresh</button>
            </div>
            <p class="sysdeck-muted" style="font-size:0.85rem;margin-top:0;">
                Append-only record at <code>/etc/cockpit/MODULE_LICENSES.log</code>.
                Every install / uninstall writes one JSON line with module id,
                license, author, source URL, action, and UTC timestamp.
            </p>
            <div id="modules-audit-body" class="modules-row">
                <p class="sysdeck-muted">Click Refresh to load.</p>
            </div>
        </div>

        <div class="sysdeck-card">
            <h3 class="sysdeck-card-title">Compliance Notes</h3>
            <p class="sysdeck-card-body" style="font-size:0.85rem;line-height:1.55;">
                SysDeck (MIT) invokes every upstream tool as a <b>separate
                process</b> via <code>cockpit.spawn</code> — no third-party
                code is bundled into the SysDeck tarball. Each module's
                license applies only to the module itself, not to SysDeck.
                For GPL-family modules (45Drives Navigator / File Sharing /
                ZFS Manager, cockpit-pacman) the invocation boundary is a
                subprocess call; you remain responsible for complying with
                each upstream license when distributing the combined system.
                See <code>THIRD_PARTY.md</code> for the full license
                compatibility matrix.
            </p>
        </div>
    `;
}

function renderRow(m) {
    const installLabel = m.installed ? "Reinstall" : "Install";
    const installBtn = `<button class="sysdeck-btn" data-action="install" data-id="${esc(m.id)}"
        title="1-click install. License: ${esc(m.license)} by ${esc(m.author)}.
Clicking Install is your acceptance of the ${esc(m.license)} license.">${installLabel}</button>`;
    const uninstallBtn = m.installed
        ? `<button class="sysdeck-btn sysdeck-btn-ghost" data-action="uninstall" data-id="${esc(m.id)}">Uninstall</button>`
        : "";
    const missingWarn = (m.missing_deps?.length > 0)
        ? `<span class="sysdeck-badge warn" title="Runtime deps missing on this host: ${m.missing_deps.map(esc).join(', ')}">${m.missing_deps.length} missing dep${m.missing_deps.length > 1 ? "s" : ""}</span>`
        : "";
    const installedBadge = m.installed
        ? `<span class="sysdeck-badge success">installed</span>`
        : `<span class="sysdeck-badge">not installed</span>`;
    const depList = m.depends?.length
        ? `<span class="pair">runtime deps: <b>${m.depends.map(esc).join(", ")}</b></span>`
        : "";

    // The license agreement, developer, source, and homepage are all
    // rendered INLINE in this row — visible right next to the Install
    // button. No modal is needed.
    return `
        <div class="sysdeck-card modules-row" data-id="${esc(m.id)}">
            <header>
                <h3>${esc(m.name)} <span class="sysdeck-muted" style="font-weight:normal;font-size:0.82rem;">(${esc(m.id)})</span></h3>
                <div class="meta">
                    ${installedBadge}
                    ${licenseBadge(m.license)}
                    ${missingWarn}
                </div>
            </header>
            <p class="blurb">${esc(m.blurb)}</p>
            <div class="meta">
                <span class="pair">developer: <b>${esc(m.author)}</b></span>
                <span class="pair">license: <b>${esc(m.license)}</b></span>
                <span class="pair">source: <a href="${esc(m.source)}" target="_blank" rel="noopener noreferrer">${esc(m.source)}</a></span>
                <span class="pair">homepage: <a href="${esc(m.homepage)}" target="_blank" rel="noopener noreferrer">visit ↗</a></span>
                <span class="pair">category: <b>${esc(m.category)}</b></span>
                ${depList}
            </div>
            <div class="actions">
                ${installBtn}
                ${uninstallBtn}
            </div>
            <div class="row-flash" data-row-flash></div>
        </div>
    `;
}

function unique(arr) {
    return Array.from(new Set(arr));
}

function renderSkeleton() {
    return `<div class="sysdeck-skeleton">
        <div class="sysdeck-skeleton-line w-1/3"></div>
        <div class="sysdeck-skeleton-line w-2/3"></div>
        <div class="sysdeck-skeleton-line w-1/2"></div>
        <div class="sysdeck-skeleton-line w-3/4"></div>
    </div>`;
}

function renderError(title, err) {
    return `<div class="sysdeck-card">
        <h3 class="sysdeck-card-title">${esc(title)}</h3>
        <p class="sysdeck-card-body sysdeck-muted">${esc(err.message || err)}.</p>
        <p class="sysdeck-muted">Run <code>python3 /usr/lib/sysdeck/bridge/modules3p.py status</code> on the host to debug.</p>
    </div>`;
}

function wireUp(panel, catalog, bridge) {
    const grid = panel.querySelector("#modules-grid");
    const filterCat = panel.querySelector("#modules-filter-category");
    const filterSearch = panel.querySelector("#modules-filter-search");

    function applyFilter() {
        const cat = filterCat.value;
        const q = filterSearch.value.trim().toLowerCase();
        grid.querySelectorAll(".modules-row").forEach((row) => {
            const m = catalog.find((x) => x.id === row.dataset.id);
            if (!m) return;
            const catOk = !cat || m.category === cat;
            const qOk = !q || [m.name, m.author, m.license, m.id, m.blurb]
                .some((s) => String(s).toLowerCase().includes(q));
            row.style.display = (catOk && qOk) ? "" : "none";
        });
    }
    filterCat.addEventListener("change", applyFilter);
    filterSearch.addEventListener("input", applyFilter);

    // 1-click install / uninstall — license was shown inline in the row,
    // so the click IS the operator's acceptance.
    grid.addEventListener("click", async (ev) => {
        const btn = ev.target.closest("button[data-action]");
        if (!btn) return;
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        const row = btn.closest(".modules-row");
        const flashBox = row?.querySelector("[data-row-flash]");
        const originalLabel = btn.textContent;

        if (action === "install") {
            btn.disabled = true;
            btn.textContent = "Installing…";
            showRowFlash(flashBox, `Pulling ${id} — see audit log. License shown inline above.`, "info");
            try {
                const r = await bridge.modules3p.install(id, /*acceptLicense=*/ true);
                if (r.ok) {
                    showRowFlash(flashBox,
                        `Installed ${r.name} — ${r.license} · ${r.author} · ${r.source}. Audit record appended.`,
                        "success");
                    await refresh(panel, bridge);
                } else {
                    showRowFlash(flashBox,
                        `Install failed: ${r.error || r.message || "unknown error"}`,
                        "danger");
                    btn.disabled = false;
                    btn.textContent = originalLabel;
                }
            } catch (e) {
                showRowFlash(flashBox, `Install error: ${e.message || e}`, "danger");
                btn.disabled = false;
                btn.textContent = originalLabel;
            }
        } else if (action === "uninstall") {
            btn.disabled = true;
            btn.textContent = "Removing…";
            showRowFlash(flashBox, `Removing ${id}…`, "info");
            try {
                const r = await bridge.modules3p.uninstall(id);
                if (r.ok) {
                    showRowFlash(flashBox, `Removed ${id}. Audit record appended.`, "success");
                    await refresh(panel, bridge);
                } else {
                    showRowFlash(flashBox,
                        `Uninstall failed: ${r.error || r.message || "unknown error"}`,
                        "danger");
                    btn.disabled = false;
                    btn.textContent = originalLabel;
                }
            } catch (e) {
                showRowFlash(flashBox, `Uninstall error: ${e.message || e}`, "danger");
                btn.disabled = false;
                btn.textContent = originalLabel;
            }
        }
    });

    panel.querySelector("#modules-audit-refresh")?.addEventListener("click", async () => {
        const body = panel.querySelector("#modules-audit-body");
        body.innerHTML = `<p class="sysdeck-muted">Loading…</p>`;
        try {
            const r = await bridge.modules3p.audit();
            body.innerHTML = renderAudit(r.records || []);
        } catch (e) {
            body.innerHTML = `<p class="sysdeck-muted">Failed: ${esc(e.message || e)}</p>`;
        }
    });
}

function showRowFlash(flashBox, msg, kind) {
    if (!flashBox) return;
    flashBox.innerHTML = `<span class="sysdeck-badge ${kind}" style="margin-top:0.4rem;">${esc(msg)}</span>`;
}

function renderAudit(records) {
    if (!records.length) {
        return `<p class="sysdeck-muted">No records yet — installs and uninstalls will appear here.</p>`;
    }
    return `<table class="sysdeck-table">
        <thead><tr><th>Time (UTC)</th><th>Module</th><th>License</th><th>Author</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>
            ${records.map((r) => r.raw
                ? `<tr><td colspan="6" class="sysdeck-muted">${esc(r.raw)}</td></tr>`
                : `<tr>
                    <td class="sysdeck-table-mono">${esc(r.ts || "")}</td>
                    <td>${esc(r.module || r.id || "")}</td>
                    <td>${esc(r.license || "")}</td>
                    <td>${esc(r.author || "")}</td>
                    <td><span class="sysdeck-badge ${actionClass(r.action)}">${esc(r.action || "")}</span></td>
                    <td class="sysdeck-table-mono">${esc(r.detail || "")}</td>
                </tr>`
            ).join("")}
        </tbody>
    </table>`;
}

function actionClass(action) {
    if (!action) return "";
    if (action.endsWith("-ok")) return "success";
    if (action.endsWith("-failed")) return "danger";
    return "";
}

async function refresh(panel, bridge) {
    let catalog = [];
    try {
        catalog = await bridge.modules3p.status();
    } catch (e) {
        // the catalog stays rendered; the failure is a banner, not a
        // replacement of the whole panel
        const flash = panel.querySelector('#modules-flash');
        if (flash) {
            flash.textContent = `Refresh failed: ${e.message || e}`;
            flash.style.display = 'block';
            setTimeout(() => { flash.style.display = 'none'; }, 4000);
        }
        return;
    }
    panel.innerHTML = renderShell(catalog);
    wireUp(panel, catalog, bridge);
}
