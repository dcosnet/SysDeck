/*
 * SysDeck - Image Builder Panel (v0.0.49)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * v0.0.49 PACKAGES FIELD. Both the Create Profile and Copy shipped
 * profile forms now include a Baseline packages textarea, a file
 * upload input (applist.txt), and a merge-mode toggle (append |
 * replace). The package list is written to the backend-specific
 * package file in the same operation as the scaffold/copy:
 *   mkosi      → [Packages] section of <name>.conf
 *   vmdb2      → bootstrap.include list in <name>.yaml
 *   archiso    → packages.x86_64 in the profile dir
 *   live-build → config/package-lists/sysdeck.list
 * Default mode is "replace" for Create (the scaffold's minimal
 * defaults are replaced by the operator's list) and "append" for
 * Copy (the baseline's packages are preserved, the operator's list
 * adds to them). The textarea is the source of truth — file uploads
 * populate the textarea via FileReader so the operator can review/
 * edit before submitting.
 *
 * v0.0.48 FIX: profile-create only supports mkosi/vmdb2 (single-file
 * specs). The v0.0.31 Create Profile dropdown fell back to `primary.id`
 * when neither was installed — on an archiso-only or live-build-only
 * host, the operator was funneled straight into the "profile-create
 * supports ('mkosi', 'vmdb2')" error. Fixed by (a) gating the Create
 * Profile form on a scaffoldable backend being installed and showing
 * an inline install hint otherwise, and (b) adding a new "Copy shipped
 * profile" form that calls the new bridge.builder.profileCopy() to
 * copy a shipped archiso/live-build profile tree into /etc/.
 *
 * v0.0.31 EXPANDED TO FULL-FEATURED. v0.0.30 was a status + profile
 * viewer: it could list installed backends (mkosi/vmdb2/archiso/
 * live-build) and walk their config dirs, but could not actually
 * build anything, could not create/edit profiles, could not show
 * build artifacts or logs.
 *
 * v0.0.31 adds:
 *   - Build button per profile — invokes the backend in the profile's
 *     directory via subprocess under the cockpit superuser channel
 *     (polkit org.sysdeck.builder.modify). The build runs synchronously
 *     and streams stdout+stderr to a log file under
 *     /var/lib/sysdeck/builder/logs/<build-id>.log.
 *   - Builds table — state (running / succeeded / failed), profile,
 *     backend, started, finished, duration, artifacts, with a
 *     View Log button per build.
 *   - Per-build log viewer — tails the build's log file (capped at
 *     1MB to avoid blowing up the JSON response for huge builds).
 *   - Artifacts card — lists image/ISO files produced by past builds
 *     under /var/lib/sysdeck/builder/artifacts/<profile>/.
 *   - Create Profile form — scaffolds a new mkosi.conf or vmdb2 YAML
 *     in /etc/mkosi/mkosi.conf.d/ or /etc/vmdb2/. The operator edits
 *     the scaffolded file before building. v0.0.48: only shown when a
 *     scaffoldable backend (mkosi/vmdb2) is installed; otherwise an
 *     inline hint is shown instead.
 *     v0.0.49: the form now includes a Baseline packages textarea +
 *     file upload + merge-mode toggle (append | replace). The package
 *     list is written to the backend-specific package file in the same
 *     operation as the scaffold.
 *   - Copy shipped profile form — (v0.0.48) copies a shipped archiso
 *     or live-build profile tree from /usr/share/ into /etc/ so the
 *     operator can edit it before building. The supported way to
 *     create profiles for the directory-based backends.
 *     v0.0.49: same Baseline packages textarea + file upload + merge-
 *     mode toggle as Create Profile. Default mode for Copy is append
 *     (preserves the baseline's packages); for Create it's replace.
 *   - Delete Profile button — removes operator-created profiles.
 *     Refuses to delete shipped profiles under /usr/share.
 *
 * v0.0.30 backend detection and profile discovery are preserved.
 * When no backend is installed, the panel still renders the install
 * hint with the exact pacman/apt command for the host distro.
 *
 * Bridge surface (see shared/bridge.js → bridge.builder):
 *   summary()      → {state, primary, backends, profiles, distro, ...}
 *   installHint()  → {primary, primary_cmd, iso, iso_cmd} per host distro
 *   build(profile, backend, options)  → {build_id, rc, success, ...}
 *   profileCreate(name, backend, base) → {created, path, ...}
 *   profileCopy(srcName, newName, backend) → {copied, path, ...}  // v0.0.48
 *   profileDelete(name, force)         → {deleted, ...}
 *   buildStatus()  → [{build_id, state, ...}, ...]
 *   buildLog(id)   → {build_id, log, path}
 *   artifacts(profile?) → {by_profile, artifacts}
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    const summary = await safe(bridge.builder.summary(), {
        state: 'unavailable',
        primary: null,
        backends: [],
        profiles: [],
        profileCount: 0,
        distro: 'unknown',
    });
    const builds = await safe(bridge.builder.buildStatus(), []);
    const artifacts = await safe(bridge.builder.artifacts(), { by_profile: {}, artifacts: 0 });

    const active = summary.state === 'active';
    const primary = summary.primary;
    const backends = summary.backends || [];
    const profiles = summary.profiles || [];
    const distro = summary.distro || 'unknown';

    // Group profiles by backend for the panel rendering.
    const byBackend = new Map();
    for (const p of profiles) {
        const key = p.backend || (primary ? primary.id : 'unknown');
        if (!byBackend.has(key)) byBackend.set(key, []);
        byBackend.get(key).push(p);
    }

    let hint = null;
    if (!active) {
        hint = await safe(bridge.builder.installHint(), null);
    }

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Image Builder</h2>
            <p class="suite-panel-subtitle">
                ${primary
                    ? `${escapeHtml(primary.id)} ${escapeHtml(primary.version || '')} — <span class="suite-badge success">${escapeHtml(summary.state)}</span>`
                    : `no backend installed — <span class="suite-badge danger">${escapeHtml(summary.state)}</span>`}
                · ${builds.length} build${builds.length === 1 ? '' : 's'} tracked
                · ${artifacts.artifacts || 0} artifact${(artifacts.artifacts || 0) === 1 ? '' : 's'}
            </p>
        </header>

        ${active
            ? renderBackends(backends, primary)
            : renderHint(hint, distro)}

        ${active ? renderProfiles(byBackend, primary, profiles.length, { bridge, EventBus }) : ''}

        ${active ? renderCreateProfile(backends, primary) : ''}

        ${active ? renderCopyProfile(profiles, primary) : ''}

        ${renderBuilds(builds)}

        <div class="suite-card" id="builder-log-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title" id="builder-log-title">Build Log</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-builder-log-close">✕</button>
            </div>
            <pre class="suite-mono" id="builder-log-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:400px"></pre>
        </div>

        ${active ? renderArtifacts(artifacts) : ''}
    `;

    wireEvents(panel, { bridge, EventBus });
    EventBus.emit('builder.loaded', { active, primary, buildCount: builds.length });
}

async function safe(p, fallback) {
    try {
        const v = await p;
        return v ?? fallback;
    } catch {
        return fallback;
    }
}

function renderBackends(backends, primary) {
    if (!backends.length) return '';
    return `
        <div class="suite-card">
            <h3 class="suite-card-title">Installed backends (${backends.length})</h3>
            <div class="suite-card-body">
                <ul class="suite-list">
                    ${backends.map(b => `
                        <li class="suite-mono">
                            <strong>${escapeHtml(b.id)}</strong>
                            ${b.version ? `<span class="suite-muted"> ${escapeHtml(b.version)}</span>` : ''}
                            ${b.id === (primary && primary.id) ? '<span class="suite-badge success">primary</span>' : ''}
                            <span class="suite-muted">(${escapeHtml(b.kind)})</span>
                        </li>
                    `).join('')}
                </ul>
            </div>
        </div>
    `;
}

function renderProfiles(byBackend, primary, total, _ctx) {
    if (!total) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Profiles (0)</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">
                        No build profiles found. Use the Create Profile form
                        below to scaffold a new <code>${primary ? primary.id : 'mkosi'}.conf</code>,
                        or drop one in <code>/etc/${primary ? primary.id : 'mkosi'}/</code>.
                    </p>
                </div>
            </div>
        `;
    }

    const cards = [];
    for (const [backendId, items] of byBackend) {
        cards.push(`
            <div class="suite-card">
                <h3 class="suite-card-title">${escapeHtml(backendId)} profiles (${items.length})</h3>
                <div class="suite-card-body">
                    <table class="suite-table">
                        <thead><tr><th>Name</th><th>Type</th><th>Path</th><th>Build</th><th>Packages</th></tr></thead>
                        <tbody>
                            ${items.map(p => `
                                <tr>
                                    <td class="suite-table-mono"><strong>${escapeHtml(p.name)}</strong></td>
                                    <td class="suite-muted">${escapeHtml(p.type)}</td>
                                    <td class="suite-table-mono suite-muted" style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.path)}</td>
                                    <td>
                                        <button class="suite-btn suite-btn-primary btn-builder-build"
                                                data-profile="${escapeHtml(p.name)}"
                                                data-backend="${escapeHtml(backendId)}">▶ Build</button>
                                    </td>
                                    <td>
                                        <button class="suite-btn suite-btn-ghost btn-builder-import"
                                                data-profile="${escapeHtml(p.name)}"
                                                title="Import this host's explicitly-installed packages into ${escapeHtml(p.name)}">⇩ Import host pkgs</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `);
    }
    return cards.join('');
}

function renderPackagesField(prefix, defaultMode) {
    // v0.0.49: shared package-list field used by both renderCreateProfile
    // and renderCopyProfile. Emits:
    //   - a <textarea> for inline paste (one package per line, # comments ok)
    //   - a file <input> that populates the textarea via FileReader
    //   - a merge-mode <select> (append | replace)
    // The `prefix` distinguishes element IDs so both forms can coexist
    // on the same page (e.g. "cp-create-" vs "cp-copy-"). The
    // `defaultMode` is the form's default — "replace" for Create (the
    // scaffold's minimal defaults are replaced by the operator's list),
    // "append" for Copy (the baseline's packages are preserved).
    //
    // The textarea is the source of truth: file uploads populate the
    // textarea so the operator can review/edit before submitting. The
    // submit handler reads the textarea value and passes it to the
    // bridge as a JSON-encoded string.
    return `
        <div style="margin-top:0.75rem;border-top:1px dashed #444;padding-top:0.5rem">
            <label class="suite-muted" style="font-size:0.85rem;display:block;margin-bottom:0.25rem">
                Baseline packages <span class="suite-muted">(optional — one per line, <code>#</code> comments allowed)</span>
            </label>
            <textarea class="suite-input" id="${prefix}-packages" rows="6"
                placeholder="linux&#10;linux-firmware&#10;base&#10;vim&#10;nginx&#10;# my baseline apps"
                style="width:100%;font-family:monospace;font-size:0.85rem"></textarea>
            <div class="suite-row" style="gap:0.5rem;margin-top:0.4rem;align-items:center;flex-wrap:wrap">
                <label class="suite-muted" style="font-size:0.8rem">
                    or upload <code>applist.txt</code>:
                    <input type="file" id="${prefix}-packages-file" accept=".txt,.list,.conf,text/plain"
                           style="font-size:0.8rem;display:inline-block;margin-left:0.25rem" />
                </label>
                <label class="suite-muted" style="font-size:0.8rem;margin-left:auto">
                    merge mode:
                    <select class="suite-input" id="${prefix}-mode" style="width:auto;display:inline-block;margin-left:0.25rem">
                        <option value="append" ${defaultMode === 'append' ? 'selected' : ''}>append (add to baseline)</option>
                        <option value="replace" ${defaultMode === 'replace' ? 'selected' : ''}>replace (overwrite)</option>
                    </select>
                </label>
            </div>
        </div>
    `;
}

function renderCreateProfile(backends, primary) {
    // v0.0.48: only mkosi and vmdb2 are scaffoldable via profile-create.
    // The previous code fell back to `primary.id` when neither was
    // installed, which on an archiso-only or live-build-only host
    // funneled the operator straight into the "profile-create supports
    // ('mkosi', 'vmdb2')" error. Now we render an inline hint instead.
    const scaffoldable = backends.filter(b => b.id === 'mkosi' || b.id === 'vmdb2');
    if (!scaffoldable.length) {
        const primaryId = primary ? primary.id : '(none)';
        return `
            <div class="suite-card">
                <div class="suite-card-header">
                    <h3 class="suite-card-title">Create Profile</h3>
                </div>
                <div class="suite-card-body">
                    <p class="suite-muted" style="font-size:0.85rem">
                        No scaffoldable backend is installed. <code>profile-create</code>
                        only supports <code>mkosi</code> and <code>vmdb2</code> (single-file
                        specs). This host's primary backend is
                        <code>${escapeHtml(primaryId)}</code>, which uses shipped
                        directory-based profiles — copy one with the form below
                        instead, or install a scaffoldable backend:
                    </p>
                    <ul class="suite-list" style="margin-top:0.5rem">
                        <li class="suite-mono"><strong>Arch:</strong> sudo pacman -S --needed mkosi</li>
                        <li class="suite-mono"><strong>Debian:</strong> sudo apt install -y vmdb2</li>
                    </ul>
                </div>
            </div>
        `;
    }
    const backendOptions = scaffoldable
        .map(b => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.id)}</option>`).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Create Profile</h3>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem">
                    Scaffolds a minimal profile in <code>/etc/&lt;backend&gt;/</code>.
                    Edit the scaffolded file before building. mkosi and vmdb2 only —
                    archiso / live-build use shipped profile dirs you should copy
                    via the "Copy shipped profile" form below.
                </p>
                <div class="suite-row" style="gap:0.5rem;margin-top:0.5rem">
                    <input type="text" class="suite-input" id="cp-name" placeholder="profile name (e.g. myarch)" style="flex:1" />
                    <select class="suite-input" id="cp-backend" style="width:120px">
                        ${backendOptions}
                    </select>
                    <button class="suite-btn suite-btn-primary" id="btn-builder-create">+ Create</button>
                </div>
                ${renderPackagesField('cp-create', 'replace')}
            </div>
        </div>
    `;
}

function renderCopyProfile(profiles, primary) {
    // v0.0.48: directory-based backends (archiso, live-build) ship
    // profile trees under /usr/share that the operator should copy
    // into /etc/ and edit. This form lists every shipped profile of
    // those backends discovered via profiles() and offers a one-click
    // copy via bridge.builder.profileCopy().
    const copyable = profiles.filter(p => p.backend === 'archiso' || p.backend === 'live-build');
    if (!copyable.length) {
        return `
            <div class="suite-card">
                <div class="suite-card-header">
                    <h3 class="suite-card-title">Copy shipped profile</h3>
                </div>
                <div class="suite-card-body">
                    <p class="suite-muted" style="font-size:0.85rem">
                        No shipped archiso / live-build profiles were discovered
                        on this host. Install one of the ISO backends to make
                        shipped baselines available:
                    </p>
                    <ul class="suite-list" style="margin-top:0.5rem">
                        <li class="suite-mono"><strong>Arch:</strong> sudo pacman -S --needed archiso</li>
                        <li class="suite-mono"><strong>Debian:</strong> sudo apt install -y live-build</li>
                    </ul>
                </div>
            </div>
        `;
    }
    // Group options by backend for clarity.
    const grouped = new Map();
    for (const p of copyable) {
        if (!grouped.has(p.backend)) grouped.set(p.backend, []);
        grouped.get(p.backend).push(p);
    }
    const optGroups = [...grouped.entries()].map(([backend, items]) => {
        const opts = items.map(p =>
            `<option value="${escapeHtml(p.name)}|${escapeHtml(p.backend)}">${escapeHtml(p.name)} (${escapeHtml(p.backend)})</option>`
        ).join('');
        return `<optgroup label="${escapeHtml(backend)}">${opts}</optgroup>`;
    }).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Copy shipped profile</h3>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem">
                    Copies a shipped <code>archiso</code> or <code>live-build</code>
                    profile tree from <code>/usr/share/</code> into
                    <code>/etc/</code> so you can edit it before building.
                    This is the supported way to create new profiles for the
                    directory-based backends (they cannot be scaffolded from
                    scratch — <code>profile-create</code> only handles the
                    single-file <code>mkosi</code>/<code>vmdb2</code> specs).
                </p>
                <div class="suite-row" style="gap:0.5rem;margin-top:0.5rem">
                    <select class="suite-input" id="cp-copy-src" style="flex:1">
                        ${optGroups}
                    </select>
                    <input type="text" class="suite-input" id="cp-copy-name" placeholder="new name (e.g. myarch)" style="flex:1" />
                    <button class="suite-btn suite-btn-primary" id="btn-builder-copy">⎘ Copy</button>
                </div>
                ${renderPackagesField('cp-copy', 'append')}
            </div>
        </div>
    `;
}

function renderBuilds(builds) {
    if (!builds || !builds.length) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Builds (0)</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">No builds run yet. Click ▶ Build on a profile above to start one.</p>
                </div>
            </div>
        `;
    }
    const rows = builds.map((b) => {
        const stateBadge = b.state === 'succeeded'
            ? '<span class="suite-badge success">succeeded</span>'
            : b.state === 'failed'
                ? '<span class="suite-badge danger">failed</span>'
                : '<span class="suite-badge warn">running</span>';
        const duration = b.duration_s != null ? `${b.duration_s.toFixed(1)}s` : '—';
        const artifacts = (b.artifacts || []).map(a => escapeHtml(a.name)).join(', ') || '—';
        return `
            <tr>
                <td class="suite-table-mono suite-muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(b.build_id)}</td>
                <td class="suite-table-mono">${escapeHtml(b.profile)}</td>
                <td class="suite-muted">${escapeHtml(b.backend)}</td>
                <td>${stateBadge}</td>
                <td class="suite-muted">${escapeHtml(b.started || '—')}</td>
                <td class="suite-muted">${escapeHtml(b.finished || '—')}</td>
                <td class="suite-muted">${duration}</td>
                <td class="suite-table-mono suite-muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${artifacts}</td>
                <td>
                    <button class="suite-btn suite-btn-ghost btn-builder-log" data-build-id="${escapeHtml(b.build_id)}">📜 Log</button>
                    <button class="suite-btn suite-btn-ghost btn-builder-delete" data-build-id="${escapeHtml(b.build_id)}" data-profile="${escapeHtml(b.profile)}" title="Delete build record">🗑</button>
                </td>
            </tr>
        `;
    }).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Builds (${builds.length})</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-builder-refresh">↻ Refresh</button>
            </div>
            <table class="suite-table">
                <thead><tr><th>Build ID</th><th>Profile</th><th>Backend</th><th>State</th><th>Started</th><th>Finished</th><th>Duration</th><th>Artifacts</th><th>Actions</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

function renderArtifacts(artifacts) {
    const byProfile = artifacts.by_profile || {};
    const profiles = Object.keys(byProfile);
    if (!profiles.length) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Artifacts (0)</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">No artifacts yet. Build outputs land under <code>/var/lib/sysdeck/builder/artifacts/&lt;profile&gt;/</code>.</p>
                </div>
            </div>
        `;
    }
    const cards = profiles.map((p) => {
        const files = byProfile[p] || [];
        if (!files.length) return '';
        const totalSize = files.reduce((s, f) => s + (f.size || 0), 0);
        return `
            <div class="suite-card">
                <div class="suite-card-header">
                    <h3 class="suite-card-title">${escapeHtml(p)} artifacts (${files.length}, ${formatSize(totalSize)})</h3>
                    <button class="suite-btn suite-btn-ghost btn-artifacts-clear"
                            data-profile="${escapeHtml(p)}"
                            title="Delete ALL artifacts for ${escapeHtml(p)}">🗑 Clear all</button>
                </div>
                <table class="suite-table">
                    <thead><tr><th>Name</th><th>Size</th><th>Modified</th><th>Actions</th></tr></thead>
                    <tbody>
                        ${files.map(f => `
                            <tr>
                                <td class="suite-table-mono">${escapeHtml(f.name)}</td>
                                <td class="suite-muted">${formatSize(f.size)}</td>
                                <td class="suite-muted">${escapeHtml(f.modified || '—')}</td>
                                <td>
                                    <button class="suite-btn suite-btn-ghost btn-artifact-download"
                                            data-profile="${escapeHtml(p)}"
                                            data-name="${escapeHtml(f.name)}"
                                            data-path="${escapeHtml(f.path)}"
                                            title="Download ${escapeHtml(f.name)}">⬇ Download</button>
                                    <button class="suite-btn suite-btn-ghost btn-artifact-delete"
                                            data-profile="${escapeHtml(p)}"
                                            data-name="${escapeHtml(f.name)}"
                                            title="Delete ${escapeHtml(f.name)}">🗑</button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }).join('');
    return cards;
}

function renderHint(hint, distro) {
    const fallback = `
        <div class="suite-card">
            <h3 class="suite-card-title">Install an image builder</h3>
            <div class="suite-card-body">
                <p class="suite-muted">
                    No image-builder backend was detected on this host.
                    Install one of the supported tools to enable this panel:
                </p>
                <ul class="suite-list">
                    <li class="suite-mono"><strong>Arch Linux:</strong> sudo pacman -S --needed mkosi</li>
                    <li class="suite-mono"><strong>Debian:</strong> sudo apt install -y vmdb2</li>
                </ul>
                <p class="suite-muted">
                    Detected distro: <code>${escapeHtml(distro)}</code>
                </p>
            </div>
        </div>
    `;
    if (!hint) return fallback;
    return `
        <div class="suite-card">
            <h3 class="suite-card-title">Install an image builder</h3>
            <div class="suite-card-body">
                <p class="suite-muted">
                    No image-builder backend was detected on this host.
                    For <strong>${escapeHtml(distro)}</strong>, the recommended
                    primary tool is <code>${escapeHtml(hint.primary)}</code>:
                </p>
                <pre class="suite-mono suite-cmd">${escapeHtml(hint.primary_cmd)}</pre>
                <p class="suite-muted">
                    For bootable ISOs, use <code>${escapeHtml(hint.iso)}</code>:
                </p>
                <pre class="suite-mono suite-cmd">${escapeHtml(hint.iso_cmd)}</pre>
            </div>
        </div>
    `;
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }) {
    const logCard = panel.querySelector('#builder-log-card');
    const logPre = panel.querySelector('#builder-log-pre');
    const logTitle = panel.querySelector('#builder-log-title');
    const showLog = (title, text) => {
        if (!logCard || !logPre) return;
        logCard.style.display = 'block';
        logTitle.textContent = title;
        logPre.textContent = text;
    };
    panel.querySelector('#btn-builder-log-close')?.addEventListener('click', () => {
        if (logCard) logCard.style.display = 'none';
    });

    // Build buttons (one per profile row).
    panel.querySelectorAll('.btn-builder-build').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const profile = btn.dataset.profile;
            const backend = btn.dataset.backend;
            btn.disabled = true;
            btn.textContent = '⏳ Building ...';
            showLog(`Build ${profile} (${backend})`, `Running ${backend} build via cockpit superuser channel...\n(cockpit will prompt for auth)\n\nThis may take several minutes. The build runs synchronously — you can navigate away and check the Builds table for status.`);
            try {
                const r = await bridge.builder.build(profile, backend);
                const lines = [];
                lines.push(`Build ID: ${r.build_id}`);
                lines.push(`Profile:  ${r.profile}`);
                lines.push(`Backend:  ${r.backend}`);
                lines.push(`State:    ${r.state}`);
                lines.push(`Exit:     ${r.rc}`);
                if (r.duration_s != null) lines.push(`Duration: ${r.duration_s.toFixed(1)}s`);
                if (r.artifacts && r.artifacts.length) {
                    lines.push('');
                    lines.push('Artifacts:');
                    for (const a of r.artifacts) lines.push(`  ${a.name}  (${formatSize(a.size)})`);
                }
                lines.push('');
                lines.push('Log path: ' + (r.log_path || '(unknown)'));
                // Fetch the full log.
                try {
                    const logResult = await bridge.builder.buildLog(r.build_id);
                    if (logResult.log) {
                        lines.push('');
                        lines.push('--- log ---');
                        lines.push(logResult.log);
                    }
                } catch (err) {
                    lines.push(`(log fetch failed: ${err.message || err})`);
                }
                showLog(`Build ${profile} — ${r.state}`, lines.join('\n'));
                EventBus.emit('builder.build-done', r);
                setTimeout(() => mount(panel, { bridge, EventBus }), 1000);
            } catch (err) {
                showLog(`Build ${profile} — error`, String(err.message || err));
            } finally {
                btn.disabled = false;
                btn.textContent = '▶ Build';
            }
        });
    });

    // v0.1.0: Import host pkgs buttons (one per profile row). Two-step:
    // first a dry-run preview so the operator sees the package count
    // and source distro before committing, then on confirm an actual
    // append-mode write. Append is the safe default — the profile's
    // existing baseline (kernel, systemd, openssh) is preserved and
    // the host's explicitly-installed packages are layered on top.
    panel.querySelectorAll('.btn-builder-import').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const profile = btn.dataset.profile;
            btn.disabled = true;
            btn.textContent = '⏳ Querying...';
            showLog(`Import host packages — ${profile}`, 'Querying host package manager via cockpit superuser channel...');
            try {
                // Step 1: dry-run preview.
                const preview = await bridge.builder.profileImportPackages(profile, 'append', true);
                if (preview.error) {
                    showLog(`Import host packages — ${profile} (error)`, `Host query failed:\n${preview.error}\n\nHint: ${preview.hint || 'ensure pacman/apt/dnf is installed on the host.'}`);
                    return;
                }
                const cnt = preview.package_count || 0;
                const src = preview.source || 'unknown';
                const distro = preview.host_distro || 'unknown';
                const truncated = preview.truncated
                    ? `\n(showing first 200 of ${cnt}; full list will be written on confirm)`
                    : '';
                const sample = (preview.packages || []).join('\n');
                // Step 2: confirm and write.
                const go = window.confirm(
                    `Import ${cnt} explicitly-installed packages from this host (${distro})\n` +
                    `into profile '${profile}' in APPEND mode?\n\n` +
                    `Source: ${src}\n\n` +
                    `Sample (first ${Math.min(cnt, 200)}):\n${sample}${truncated}`
                );
                if (!go) {
                    showLog(`Import host packages — ${profile} (cancelled)`, 'Operator cancelled. Profile file untouched.');
                    return;
                }
                btn.textContent = '⏳ Writing...';
                const r = await bridge.builder.profileImportPackages(profile, 'append', false);
                const lines = [];
                if (r.imported) {
                    lines.push(`Imported ${r.count || 0} packages from ${r.source} into '${r.profile}'.`);
                    lines.push(`Backend: ${r.backend}`);
                    lines.push(`Mode:    ${r.mode}`);
                    lines.push(`Path:    ${r.path}`);
                } else if (r.error) {
                    lines.push(`Import failed: ${r.error}`);
                }
                showLog(`Import host packages — ${profile} — ${r.imported ? 'done' : 'error'}`, lines.join('\n'));
                EventBus.emit('builder.import-done', r);
                setTimeout(() => mount(panel, { bridge, EventBus }), 1000);
            } catch (err) {
                showLog(`Import host packages — ${profile} — error`, String(err.message || err));
            } finally {
                btn.disabled = false;
                btn.textContent = '⇩ Import host pkgs';
            }
        });
    });

    // Create Profile form.
    panel.querySelector('#btn-builder-create')?.addEventListener('click', async () => {
        const nameInput = panel.querySelector('#cp-name');
        const backendSelect = panel.querySelector('#cp-backend');
        const name = nameInput?.value?.trim();
        const backend = backendSelect?.value;
        if (!name) { showLog('Create profile — error', 'Profile name required.'); return; }
        if (!backend) { showLog('Create profile — error', 'Backend selection required.'); return; }
        // v0.0.49: read optional package list + merge mode.
        const packagesText = panel.querySelector('#cp-create-packages')?.value || '';
        const mode = panel.querySelector('#cp-create-mode')?.value || 'replace';
        const pkgSummary = packagesText.trim()
            ? ` (${mode} mode, ${packagesText.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#')).length} packages)`
            : '';
        showLog('Create profile', `Scaffolding ${backend} profile '${name}'${pkgSummary} via cockpit superuser channel...`);
        try {
            const r = await bridge.builder.profileCreate(name, backend, null,
                packagesText.trim() || null, mode);
            if (r.created) {
                const lines = [
                    `Created ${r.backend} profile '${r.name}'.`,
                    '',
                    `Path: ${r.path}`,
                    `Template: ${r.template}`,
                ];
                if (r.packages) {
                    lines.push(`Packages: ${r.packages.count} (${r.packages.mode} mode)`);
                    lines.push(`Package file: ${r.packages.path}`);
                } else if (r.packages_error) {
                    lines.push(`Packages: ERROR — ${r.packages_error}`);
                }
                lines.push('', 'Edit the file(s) before building.');
                showLog('Create profile — success', lines.join('\n'));
                setTimeout(() => mount(panel, { bridge, EventBus }), 1200);
            } else {
                showLog('Create profile — failed', `Error: ${r.error || 'unknown'}\n\n${r.hint || ''}`);
            }
        } catch (err) {
            showLog('Create profile — error', String(err.message || err));
        }
    });

    // v0.0.48: Copy shipped profile form (archiso / live-build).
    panel.querySelector('#btn-builder-copy')?.addEventListener('click', async () => {
        const srcSelect = panel.querySelector('#cp-copy-src');
        const nameInput = panel.querySelector('#cp-copy-name');
        const newName = nameInput?.value?.trim();
        if (!newName) { showLog('Copy profile — error', 'New profile name required.'); return; }
        // The option value is "<src-name>|<backend>".
        const raw = srcSelect?.value || '';
        const sepIdx = raw.lastIndexOf('|');
        if (sepIdx < 0) { showLog('Copy profile — error', 'Select a source profile.'); return; }
        const srcName = raw.slice(0, sepIdx);
        const backend = raw.slice(sepIdx + 1);
        // v0.0.49: read optional package list + merge mode.
        const packagesText = panel.querySelector('#cp-copy-packages')?.value || '';
        const mode = panel.querySelector('#cp-copy-mode')?.value || 'append';
        const pkgSummary = packagesText.trim()
            ? ` (${mode} mode, ${packagesText.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#')).length} packages)`
            : '';
        showLog('Copy profile',
               `Copying ${backend} profile '${srcName}' → '${newName}'${pkgSummary} via cockpit superuser channel...`);
        try {
            const r = await bridge.builder.profileCopy(srcName, newName, backend,
                packagesText.trim() || null, mode);
            if (r.copied) {
                const lines = [
                    `Copied ${r.backend} profile '${r.source}' → '${r.name}'.`,
                    '',
                    `Source: ${r.source_path}`,
                    `Destination: ${r.path}`,
                ];
                if (r.packages) {
                    lines.push(`Packages: ${r.packages.count} (${r.packages.mode} mode)`);
                    lines.push(`Package file: ${r.packages.path}`);
                } else if (r.packages_error) {
                    lines.push(`Packages: ERROR — ${r.packages_error}`);
                }
                lines.push('', 'Edit the files in the destination directory before building.');
                showLog('Copy profile — success', lines.join('\n'));
                setTimeout(() => mount(panel, { bridge, EventBus }), 1200);
            } else {
                showLog('Copy profile — failed', `Error: ${r.error || 'unknown'}\n\n${r.hint || ''}`);
            }
        } catch (err) {
            showLog('Copy profile — error', String(err.message || err));
        }
    });

    // v0.0.49: file-upload handlers for both forms. When the operator
    // picks a file, read it as text and populate the corresponding
    // textarea. The textarea is the source of truth — the operator
    // can review/edit the uploaded content before submitting.
    const wireFileInput = (fileInputId, textareaId, logLabel) => {
        const fileInput = panel.querySelector(fileInputId);
        const textarea = panel.querySelector(textareaId);
        if (!fileInput || !textarea) return;
        fileInput.addEventListener('change', () => {
            const file = fileInput.files[0];
            if (!file) return;
            // 1 MB cap — anything larger is probably not a package list.
            if (file.size > 1_000_000) {
                showLog(logLabel, `File ${file.name} is ${formatSize(file.size)} — too large (1 MB cap).`);
                fileInput.value = '';
                return;
            }
            const reader = new FileReader();
            reader.onload = (ev) => {
                textarea.value = ev.target.result;
                showLog(logLabel, `Loaded ${file.name} (${formatSize(file.size)}) into the textarea — review and edit before submitting.`);
            };
            reader.onerror = () => {
                showLog(logLabel, `Failed to read ${file.name}: ${reader.error || 'unknown error'}`);
            };
            reader.readAsText(file);
        });
    };
    wireFileInput('#cp-create-packages-file', '#cp-create-packages', 'Create profile — file upload');
    wireFileInput('#cp-copy-packages-file', '#cp-copy-packages', 'Copy profile — file upload');

    // Per-build log buttons.
    panel.querySelectorAll('.btn-builder-log').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.buildId;
            showLog(`Build log — ${id}`, 'Loading log ...');
            try {
                const r = await bridge.builder.buildLog(id);
                if (r.log) showLog(`Build log — ${id}`, r.log);
                else showLog(`Build log — ${id}`, `Error: ${r.error || 'no log'}`);
            } catch (err) {
                showLog(`Build log — ${id}`, String(err.message || err));
            }
        });
    });

    // Refresh button.
    panel.querySelector('#btn-builder-refresh')?.addEventListener('click', () => {
        mount(panel, { bridge, EventBus });
    });

    // v0.1.3: artifact download buttons. Uses cockpit.spawn(["cat", path])
    // to read the file as binary, then creates a Blob + download link.
    // The file is read via the superuser channel so it works even when
    // the artifacts dir is root-owned.
    panel.querySelectorAll('.btn-artifact-download').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const profile = btn.dataset.profile;
            const name = btn.dataset.name;
            const path = btn.dataset.path;
            btn.disabled = true;
            btn.textContent = '⏳ ...';
            try {
                // cockpit.spawn returns a promise; in binary mode it
                // resolves to the full byte payload — the documented API,
                // not the low-level channel surface.
                const data = await cockpit.spawn(["cat", path], {
                    superuser: "try",
                    binary: true,
                });
                const blob = new Blob([data], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showLog(`Download — ${name}`, `Downloaded ${name} (${formatSize(blob.size)}).\nPath: ${path}`);
            } catch (err) {
                showLog(`Download — ${name} — error`, String(err.message || err));
            } finally {
                btn.disabled = false;
                btn.textContent = '⬇ Download';
            }
        });
    });

    // v0.1.3: artifact delete buttons (per-file).
    panel.querySelectorAll('.btn-artifact-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const profile = btn.dataset.profile;
            const name = btn.dataset.name;
            if (!window.confirm(`Delete artifact '${name}' from profile '${profile}'?`)) return;
            btn.disabled = true;
            try {
                const r = await bridge.builder.artifactDelete(profile, name);
                if (r.deleted) {
                    showLog(`Delete artifact — ${name}`, `Deleted ${name} (freed ${formatSize(r.size || 0)}).`);
                    setTimeout(() => mount(panel, { bridge, EventBus }), 500);
                } else {
                    showLog(`Delete artifact — ${name} — error`, r.error || 'unknown error');
                }
            } catch (err) {
                showLog(`Delete artifact — ${name} — error`, String(err.message || err));
            } finally {
                btn.disabled = false;
            }
        });
    });

    // v0.1.3: clear all artifacts for a profile.
    panel.querySelectorAll('.btn-artifacts-clear').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const profile = btn.dataset.profile;
            if (!window.confirm(`Delete ALL artifacts for profile '${profile}'?\nThis cannot be undone.`)) return;
            btn.disabled = true;
            try {
                const r = await bridge.builder.artifactsClear(profile);
                if (r.cleared) {
                    showLog(`Clear artifacts — ${profile}`,
                        `Cleared ${r.files_deleted} files (${formatSize(r.bytes_freed || 0)} freed).`);
                    setTimeout(() => mount(panel, { bridge, EventBus }), 500);
                } else {
                    showLog(`Clear artifacts — ${profile} — error`, r.error || 'unknown error');
                }
            } catch (err) {
                showLog(`Clear artifacts — ${profile} — error`, String(err.message || err));
            } finally {
                btn.disabled = false;
            }
        });
    });

    // v0.1.3: build delete buttons (removes state + log, optionally artifacts).
    panel.querySelectorAll('.btn-builder-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const buildId = btn.dataset.buildId;
            const profile = btn.dataset.profile;
            const deleteArtifacts = window.confirm(
                `Delete build record '${buildId}'?\n\n` +
                `Click OK to delete state + log files only.\n` +
                `Click Cancel to also delete the artifacts for profile '${profile}'.`
            );
            // If user clicked Cancel on the first confirm, ask again with
            // the "also delete artifacts" option.
            let withArtifacts = false;
            if (!deleteArtifacts) {
                withArtifacts = window.confirm(
                    `Also delete ALL artifacts for profile '${profile}'?\n\n` +
                    `Click OK to delete state + log + artifacts.\n` +
                    `Click Cancel to abort.`
                );
                if (!withArtifacts) return;
            }
            btn.disabled = true;
            try {
                const r = await bridge.builder.buildDelete(buildId, withArtifacts);
                if (r.deleted) {
                    const lines = [`Deleted build ${buildId}.`, 'Files removed:'];
                    (r.files || []).forEach(f => lines.push(`  ${f}`));
                    if (r.errors && r.errors.length) {
                        lines.push('', 'Errors:');
                        r.errors.forEach(e => lines.push(`  ${e}`));
                    }
                    showLog(`Delete build — ${buildId}`, lines.join('\n'));
                    setTimeout(() => mount(panel, { bridge, EventBus }), 500);
                } else {
                    showLog(`Delete build — ${buildId} — error`, r.error || 'unknown error');
                }
            } catch (err) {
                showLog(`Delete build — ${buildId} — error`, String(err.message || err));
            } finally {
                btn.disabled = false;
            }
        });
    });
}

// ── Utilities ───────────────────────────────────────────────────────

function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let sz = bytes;
    while (sz >= 1024 && i < units.length - 1) { sz /= 1024; i++; }
    return `${sz.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderSkeleton() {
    return `<div class="suite-skeleton"><div class="suite-skeleton-line w-1/3"></div></div>`;
}
