/*
 * SysDeck - Policy & Permissions Panel (v0.0.32)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * NEW MODULE in v0.0.32 — modern policy management and permissions
 * manager for groups. Per user directive:
 *
 *   "modern policy management and permissions manager for groups.
 *    such as acl, cgroups, vlans, ebpf namespace separation and
 *    related policies. we can skip selinux its native. we can
 *    implement apparmor but its not default on my machine so make
 *    it optional for sure."
 *
 * The panel surfaces five concerns, each with its own card:
 *
 *   1. ACL manager        — list/set/remove/default POSIX ACLs on
 *                            any path. Path picker + entry form.
 *   2. Cgroup viewer      — cgroups v2 unified hierarchy tree.
 *                            Per-cgroup process list, controllers,
 *                            and control file editor (memory.max,
 *                            cpu.weight, etc.). Move PID into cgroup.
 *   3. VLAN manager        — list/create/delete 802.1Q VLANs on
 *                            host interfaces via `ip link`.
 *   4. eBPF programs       — list loaded BPF programs (bpftool),
 *                            list BPF maps, pin a program to bpffs.
 *   5. Namespace separation — lsns output, with per-namespace
 *                            process list.
 *
 * AppArmor is rendered as an OPTIONAL sixth card: the bridge auto-
 * detects whether AppArmor is compiled into the kernel. If absent,
 * the card shows an install hint instead of an empty table.
 *
 * SELinux is intentionally skipped per user directive — it is
 * native to the host distro and SysDeck does not try to manage it.
 *
 * Mutating operations (acl-set, acl-remove, acl-default, cgroup-
 * create, cgroup-move, cgroup-set, vlan-create, vlan-delete,
 * ebpf-pin, apparmor-enforce, apparmor-complain) go through
 * bridge.policy.<op>() which passes { superuser: 'try' } to
 * cockpit.spawn. The cockpit bridge prompts the operator via
 * polkit for the org.sysdeck.policy.modify action (added in
 * v0.0.32 — authorizes /usr/bin/setfacl, /bin/mkdir, /bin/mount,
 * /usr/bin/ip, /usr/sbin/ip, /usr/bin/bpftool, /usr/sbin/bpftool,
 * /usr/bin/aa-enforce, /usr/bin/aa-complain, /usr/bin/lsns).
 * No `sudo` shell-out from JS — this is the cockpit way.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    const summary = await safe(bridge.policy.summary(), {});
    const cgroups = summary?.cgroups?.available
        ? await safe(bridge.policy.cgroupList(), { cgroups: [] })
        : { available: false };
    const vlans = await safe(bridge.policy.vlanList(), { vlans: [] });
    const ebpf = summary?.ebpf?.available
        ? await safe(bridge.policy.ebpfList(), {})
        : { available: false };
    const ns = summary?.namespaces?.available
        ? await safe(bridge.policy.nsList(), {})
        : { available: false };
    const apparmor = await safe(bridge.policy.apparmorStatus(), {});

    // v0.0.33: additional LSMs — fetch in parallel. Each is optional;
    // the bridge returns { available: false, reason: ... } when absent.
    // The render functions tolerate that shape and show an enable hint.
    const [lsm, smack, tomoyo, yama, loadpin, lockdown, bpflsm, landlock, filecaps] = await Promise.all([
        safe(bridge.policy.lsmStatus(), { entries: [] }),
        safe(bridge.policy.smackStatus(), {}),
        safe(bridge.policy.tomoyoStatus(), {}),
        safe(bridge.policy.yamaStatus(), {}),
        safe(bridge.policy.loadpinStatus(), {}),
        safe(bridge.policy.lockdownStatus(), {}),
        safe(bridge.policy.bpflsmStatus(), {}),
        safe(bridge.policy.landlockStatus(), {}),
        safe(bridge.policy.filecapsList(), { entries: [] }),
    ]);

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Policy & Permissions</h2>
            <p class="suite-panel-subtitle">
                ACLs · cgroups v2 · VLANs · eBPF · namespaces · filecaps
                · LSMs: ${renderActiveLsmBadges(lsm)}
                · SELinux skipped (native)
            </p>
        </header>

        ${renderAvailability(summary, lsm)}

        ${renderLsmStackCard(lsm)}

        ${renderAclCard()}

        ${renderCgroupsCard(cgroups, summary?.cgroups)}

        ${renderVlansCard(vlans, summary?.vlans)}

        ${renderEbpfCard(ebpf, summary?.ebpf)}

        ${renderNsCard(ns, summary?.namespaces)}

        ${renderFilecapsCard(filecaps)}

        ${renderApparmorCard(apparmor)}

        ${renderSmackCard(smack)}

        ${renderTomoyoCard(tomoyo)}

        ${renderYamaCard(yama)}

        ${renderLoadpinCard(loadpin)}

        ${renderLockdownCard(lockdown)}

        ${renderBpflsmCard(bpflsm)}

        ${renderLandlockCard(landlock)}

        <div class="suite-card" id="policy-output-card" style="display:none">
            <div class="suite-card-header">
                <h3 class="suite-card-title" id="policy-output-title">Operation Output</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-policy-output-close">✕</button>
            </div>
            <pre class="suite-mono" id="policy-output-pre" style="white-space:pre-wrap;background:#1a1a1a;padding:8px;border-radius:4px;overflow:auto;max-height:400px"></pre>
        </div>
    `;

    wireEvents(panel, { bridge, EventBus });
    EventBus.emit('policy.loaded', { summary });
}

// ── Render helpers ───────────────────────────────────────────────────

// Lookup table for the capability-matrix rows. PEP 868 / MISRA:
// stable, declarative — adding a concern is one line. The probe
// lambdas are invoked during the .map() iteration below, replacing
// the previous hand-built rows array.
function _availabilityRows(summary, lsm) {
    const lsmConcerns = (lsm?.entries || []).map((e) => [
        e.name,
        e.active_in_stack && e.dir_present,
        `kernel cmdline: lsm=...,${e.id}`,
    ]);
    return [
        ['ACLs (getfacl/setfacl)', summary?.acl?.available, 'pacman -S acl  /  apt install acl'],
        ['cgroups v2',              summary?.cgroups?.available, 'default on Arch/Debian 12+/Fedora 31+'],
        ['VLANs (ip)',              summary?.vlans?.available, 'iproute2 — universally installed'],
        ['eBPF (bpftool)',          summary?.ebpf?.available, 'pacman -S bpftool  /  apt install linux-tools-common'],
        ['Namespaces (lsns)',       summary?.namespaces?.available, 'util-linux — universally installed'],
        ['File caps (setcap/getcap)', summary?.filecaps?.available ?? false, 'pacman -S libcap  /  apt install libcap-bin'],
        ...lsmConcerns,
        ['SELinux',                 false, 'skipped per user directive (native to host distro)'],
    ];
}

function renderAvailability(summary, lsm) {
    if (!summary) return '';
    const rows = _availabilityRows(summary, lsm);
    const badge = (name, available) => available
        ? '<span class="suite-badge success">yes</span>'
        : (name === 'SELinux' ? '<span class="suite-badge">skipped</span>' : '<span class="suite-badge danger">no</span>');
    return `
        <div class="suite-card">
            <h3 class="suite-card-title">Capability Matrix</h3>
            <table class="suite-table">
                <thead><tr><th>Concern</th><th>Available</th><th>Install hint</th></tr></thead>
                <tbody>
                    ${rows.map((r) => `
                        <tr>
                            <td>${escapeHtml(r[0])}</td>
                            <td>${badge(r[0], r[1])}</td>
                            <td class="suite-muted suite-mono">${escapeHtml(r[2])}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// Quick inline badges for the panel subtitle — shows the active LSM
// stack at a glance (e.g. "lockdown,capability,yama" → 3 badges).
function renderActiveLsmBadges(lsm) {
    const stack = lsm?.active_stack || [];
    if (!stack.length) return '<span class="suite-muted">(none active)</span>';
    return stack.map((s) => `<span class="suite-badge info">${escapeHtml(s)}</span>`).join(' ');
}

function renderLsmStackCard(lsm) {
    if (!lsm || !lsm.entries || !lsm.entries.length) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">LSM Stack</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">
                        Could not probe the kernel LSM stack
                        (<code>${escapeHtml(lsm?.lsm_list_file || '/sys/kernel/security/lsm')}</code>
                        unreadable). securityfs may not be mounted.
                    </p>
                </div>
            </div>
        `;
    }
    const rows = lsm.entries.map((e) => `
        <tr>
            <td class="suite-table-mono"><strong>${escapeHtml(e.name)}</strong></td>
            <td class="suite-muted suite-mono">${escapeHtml(e.id)}</td>
            <td>${e.active_in_stack ? '<span class="suite-badge success">in stack</span>' : '<span class="suite-badge">inactive</span>'}</td>
            <td>${e.dir_present ? '<span class="suite-badge success">yes</span>' : '<span class="suite-badge danger">no</span>'}</td>
            <td class="suite-table-mono suite-muted">${escapeHtml(e.path)}</td>
        </tr>
    `).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">LSM Stack (${lsm.active_count || 0} active)</h3>
            </div>
            <table class="suite-table">
                <thead><tr><th>Name</th><th>ID</th><th>In stack</th><th>securityfs</th><th>Path</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <p class="suite-muted" style="font-size:0.85rem;margin-top:0.5rem">
                The active stack file is <code>${escapeHtml(lsm.lsm_list_file || '')}</code>.
                Set the order at boot via the <code>lsm=...</code> kernel cmdline.
            </p>
        </div>
    `;
}

function renderFilecapsCard(filecaps) {
    if (!filecaps || filecaps.available === false) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">File Capabilities</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">
                        ${escapeHtml(filecaps?.reason || 'getcap not installed')}
                        ${filecaps?.install ? `<br><code>${escapeHtml(filecaps.install)}</code>` : ''}
                    </p>
                </div>
            </div>
        `;
    }
    const entries = filecaps.entries || [];
    const rows = entries.slice(0, 50).map((e) => `
        <tr>
            <td class="suite-table-mono">${escapeHtml(e.path)}</td>
            <td class="suite-mono">${escapeHtml(e.caps)}</td>
        </tr>
    `).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">File Capabilities (${filecaps.count || 0})</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-filecaps-refresh">↻ Refresh</button>
            </div>
            <table class="suite-table">
                <thead><tr><th>Path</th><th>Caps</th></tr></thead>
                <tbody>
                    ${rows || '<tr><td colspan="2" class="suite-muted">No binaries with file caps.</td></tr>'}
                </tbody>
            </table>
            ${entries.length > 50 || filecaps.truncated ? `<p class="suite-muted">Showing 50 of ${filecaps.count || 0} entries${filecaps.truncated ? ' (truncated)' : ''}.</p>` : ''}

            <div class="suite-card-body" style="margin-top:0.5rem">
                <div class="suite-row" style="gap:0.5rem">
                    <input type="text" class="suite-input" id="filecaps-set-caps" placeholder="caps (e.g. cap_net_bind_service+ep)" style="flex:1" />
                    <input type="text" class="suite-input" id="filecaps-set-path" placeholder="path (e.g. /usr/bin/python3)" style="flex:2" />
                    <button class="suite-btn suite-btn-primary" id="btn-filecaps-set">setcap</button>
                </div>
                <div class="suite-row" style="gap:0.5rem;margin-top:0.5rem">
                    <input type="text" class="suite-input" id="filecaps-show-path" placeholder="path to inspect" style="flex:1" />
                    <button class="suite-btn" id="btn-filecaps-show">getcap</button>
                    <button class="suite-btn" id="btn-filecaps-remove">remove caps</button>
                </div>
            </div>
        </div>
    `;
}

// ── Per-LSM cards (v0.0.33) ────────────────────────────────────────
//
// All eight new LSM cards follow the same shape:
//   1. If unavailable, render an enable hint with the kernel cmdline
//      that activates the LSM. Decisive language — no "this is
//      pending" or "to be implemented".
//   2. If available, render the live state + any management controls
//      the LSM supports.
//
// The shape is uniform so the panel reads consistently across all
// LSMs even though each has its own surface.

function renderSmackCard(smack) {
    if (!smack || smack.available === false) {
        return renderLsmHintCard('Smack', smack, 'security=smack  /  lsm=...,smack');
    }
    const keys = Object.entries(smack)
        .filter(([k]) => k !== 'available' && k !== 'path')
        .map(([k, v]) => `<tr><td class="suite-table-mono">${escapeHtml(k)}</td><td class="suite-mono suite-muted">${escapeHtml(String(v).slice(0, 200))}</td></tr>`)
        .join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Smack</h3>
                <span class="suite-badge success">active</span>
            </div>
            <table class="suite-table"><tbody>${keys}</tbody></table>
            <div class="suite-card-body" style="margin-top:0.5rem">
                <div class="suite-row" style="gap:0.5rem">
                    <input type="text" class="suite-input" id="smack-load-file" placeholder="rules file (e.g. /etc/smack/accesses)" style="flex:1" />
                    <button class="suite-btn" id="btn-smack-load">smackload</button>
                    <button class="suite-btn suite-btn-ghost" id="btn-smack-labels">List labels</button>
                </div>
            </div>
        </div>
    `;
}

function renderTomoyoCard(tomoyo) {
    if (!tomoyo || tomoyo.available === false) {
        return renderLsmHintCard('TOMOYO', tomoyo, 'security=tomoyo  /  lsm=...,tomoyo');
    }
    const keys = Object.entries(tomoyo)
        .filter(([k]) => k !== 'available' && k !== 'path')
        .map(([k, v]) => `<tr><td class="suite-table-mono">${escapeHtml(k)}</td><td class="suite-mono suite-muted" style="max-width:400px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(String(v).slice(0, 200))}</td></tr>`)
        .join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">TOMOYO</h3>
                <span class="suite-badge success">active</span>
            </div>
            <table class="suite-table"><tbody>${keys}</tbody></table>
            <div class="suite-card-body" style="margin-top:0.5rem">
                <div class="suite-row" style="gap:0.5rem">
                    <input type="text" class="suite-input" id="tomoyo-save-path" placeholder="/tmp/tomoyo-snapshot" style="flex:1" />
                    <button class="suite-btn" id="btn-tomoyo-save">Save snapshot</button>
                    <button class="suite-btn suite-btn-ghost" id="btn-tomoyo-profiles">View profiles</button>
                </div>
            </div>
        </div>
    `;
}

function renderYamaCard(yama) {
    if (!yama || yama.available === false) {
        return renderLsmHintCard('Yama', yama, 'lsm=...,yama');
    }
    const scope = yama.scope ?? -1;
    const scopeName = yama.scope_name || 'unknown';
    const scopeOptions = [
        ['0', 'disabled (any ptrace)'],
        ['1', 'restricted ptrace (default)'],
        ['2', 'admin-only ptrace'],
        ['3', 'no ptrace at all'],
    ].map(([v, label]) => `<option value="${v}" ${parseInt(v, 10) === scope ? 'selected' : ''}>${v} — ${escapeHtml(label)}</option>`).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Yama (ptrace scope)</h3>
                <span class="suite-badge success">active</span>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem">
                    Current scope: <strong>${scope}</strong> (${escapeHtml(scopeName)})
                    — file: <code>${escapeHtml(yama.file || '')}</code>
                </p>
                <div class="suite-row" style="gap:0.5rem;margin-top:0.5rem">
                    <select class="suite-input" id="yama-scope-select" style="flex:1">${scopeOptions}</select>
                    <button class="suite-btn suite-btn-primary" id="btn-yama-set">Set scope</button>
                </div>
            </div>
        </div>
    `;
}

function renderLoadpinCard(loadpin) {
    if (!loadpin || loadpin.available === false) {
        return renderLsmHintCard('LoadPin', loadpin, 'lsm=...,loadpin');
    }
    const keys = Object.entries(loadpin)
        .filter(([k]) => k !== 'available' && k !== 'path')
        .map(([k, v]) => `<tr><td class="suite-table-mono">${escapeHtml(k)}</td><td class="suite-mono suite-muted">${escapeHtml(String(v).slice(0, 200))}</td></tr>`)
        .join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">LoadPin</h3>
                <span class="suite-badge success">active</span>
            </div>
            <table class="suite-table"><tbody>${keys}</tbody></table>
            <p class="suite-muted" style="font-size:0.85rem;margin-top:0.5rem">
                LoadPin has no userspace management surface beyond the kernel
                cmdline. Pinning is automatic once enabled.
            </p>
        </div>
    `;
}

function renderLockdownCard(lockdown) {
    if (!lockdown || lockdown.available === false) {
        return renderLsmHintCard('Lockdown', lockdown, 'UEFI secure boot enables this; no userspace toggle.');
    }
    const keys = Object.entries(lockdown)
        .filter(([k]) => k !== 'available' && k !== 'path')
        .map(([k, v]) => `<tr><td class="suite-table-mono">${escapeHtml(k)}</td><td class="suite-mono suite-muted">${escapeHtml(String(v).slice(0, 200))}</td></tr>`)
        .join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Lockdown (UEFI secure boot)</h3>
                <span class="suite-badge success">active</span>
            </div>
            <table class="suite-table"><tbody>${keys}</tbody></table>
        </div>
    `;
}

function renderBpflsmCard(bpflsm) {
    if (!bpflsm || bpflsm.available === false) {
        return renderLsmHintCard('BPF-LSM', bpflsm, 'lsm=...,bpf');
    }
    const progs = bpflsm.lsm_programs || [];
    const rows = progs.slice(0, 30).map((p) => {
        const id = p.id ?? '?';
        const name = p.name ?? '(unnamed)';
        return `<tr><td class="suite-table-mono">${id}</td><td class="suite-mono">${escapeHtml(String(name))}</td></tr>`;
    }).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">BPF-LSM</h3>
                <span class="suite-badge success">active</span>
                <span class="suite-badge" style="margin-left:0.25rem">${bpflsm.lsm_program_count || 0} programs</span>
            </div>
            <table class="suite-table">
                <thead><tr><th>ID</th><th>Name</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="2" class="suite-muted">No BPF-LSM programs loaded.</td></tr>'}</tbody>
            </table>
            <p class="suite-muted" style="font-size:0.85rem;margin-top:0.5rem">
                BPF-LSM programs are loaded via libbpf and queried via <code>bpftool</code>.
                The eBPF card above shows the same programs under their full BPF list.
            </p>
        </div>
    `;
}

function renderLandlockCard(landlock) {
    if (!landlock || landlock.available === false) {
        return renderLsmHintCard('Landlock', landlock, 'lsm=...,landlock (requires Linux 5.13+)');
    }
    const rulesets = landlock.rulesets || [];
    const rows = rulesets.map((r) => `
        <tr>
            <td class="suite-table-mono">${escapeHtml(r.pid)}</td>
            <td class="suite-mono">${escapeHtml(r.comm)}</td>
            <td class="suite-muted suite-mono">${escapeHtml(r.landlock)}</td>
        </tr>
    `).join('');
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Landlock</h3>
                <span class="suite-badge success">active</span>
                <span class="suite-badge" style="margin-left:0.25rem">${landlock.processes_with_rulesets || 0} sandboxed</span>
            </div>
            <table class="suite-table">
                <thead><tr><th>PID</th><th>Command</th><th>Ruleset</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="3" class="suite-muted">No processes currently sandboxed by Landlock.</td></tr>'}</tbody>
            </table>
        </div>
    `;
}

// Common shape for the "LSM not active" cards. Avoids duplicating
// the same install-hint scaffolding across every LSM card.
function renderLsmHintCard(name, data, hint) {
    return `
        <div class="suite-card">
            <h3 class="suite-card-title">${escapeHtml(name)}</h3>
            <div class="suite-card-body">
                <p class="suite-muted">
                    ${escapeHtml(data?.reason || `${name} is not active on this kernel.`)}
                </p>
                ${data?.install_arch ? `<p class="suite-muted" style="margin-top:0.5rem">Arch: <code>${escapeHtml(data.install_arch)}</code></p>` : ''}
                ${data?.install_debian ? `<p class="suite-muted">Debian: <code>${escapeHtml(data.install_debian)}</code></p>` : ''}
                <p class="suite-muted" style="margin-top:0.5rem">
                    To enable: <code>${escapeHtml(hint)}</code> on the kernel cmdline.
                    ${data?.note ? `<br>${escapeHtml(data.note)}` : ''}
                </p>
            </div>
        </div>
    `;
}

function renderAclCard() {
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">ACL Manager</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-acl-list">List ACLs</button>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem">
                    POSIX ACLs extend the unix permission model with per-user and per-group entries.
                    Format: <code>user:alice:rwx</code>, <code>group:devs:r-x</code>, <code>mask::rwx</code>,
                    <code>default:group:www-data:r-x</code> (for directories — inherited by new files).
                </p>
                <div class="suite-row" style="gap:0.5rem;margin-top:0.5rem">
                    <input type="text" class="suite-input" id="acl-path" placeholder="path (e.g. /var/www or /etc/nginx)" style="flex:2" />
                    <input type="text" class="suite-input" id="acl-entry" placeholder="entry (e.g. group:www-data:rwx)" style="flex:2" />
                </div>
                <div class="suite-row" style="gap:0.5rem;margin-top:0.5rem">
                    <button class="suite-btn suite-btn-primary" id="btn-acl-set">setfacl -m</button>
                    <button class="suite-btn" id="btn-acl-remove">setfacl -x</button>
                    <button class="suite-btn" id="btn-acl-default">set default ACL</button>
                </div>
                <div id="acl-output" class="suite-muted" style="margin-top:0.5rem">Click "List ACLs" to see entries on the path above.</div>
            </div>
        </div>
    `;
}

function renderCgroupsCard(cgroups, summary) {
    if (!summary?.available) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">cgroups v2</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">
                        cgroups v2 not mounted at <code>/sys/fs/cgroup/</code>. Modern Arch/Debian/Fedora
                        systems default to cgroups v2 — if you see this on a recent kernel, your host
                        may be running the v1 hierarchy only.
                    </p>
                </div>
            </div>
        `;
    }
    const groups = cgroups?.cgroups || [];
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">cgroups v2 (${groups.length})</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-cg-refresh">↻ Refresh</button>
            </div>
            <div class="suite-card-body">
                <table class="suite-table">
                    <thead><tr><th>Path</th><th>Controllers</th><th>Procs</th><th>Subtree</th></tr></thead>
                    <tbody>
                        ${groups.slice(0, 50).map((g) => `
                            <tr>
                                <td class="suite-table-mono">${escapeHtml(g.path)}</td>
                                <td class="suite-muted suite-mono" style="font-size:0.8rem">${escapeHtml(g.controllers || '(none)')}</td>
                                <td>${g.proc_count || 0}</td>
                                <td class="suite-muted suite-mono" style="font-size:0.8rem">${escapeHtml(g.subtree_control || '(none)')}</td>
                            </tr>
                        `).join('') || '<tr><td colspan="4" class="suite-muted">No cgroups under /sys/fs/cgroup/.</td></tr>'}
                    </tbody>
                </table>
                ${groups.length > 50 ? `<p class="suite-muted">Showing 50 of ${groups.length} cgroups.</p>` : ''}
            </div>
        </div>

        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">cgroup: show / set</h3>
            </div>
            <div class="suite-card-body">
                <div class="suite-row" style="gap:0.5rem;margin-bottom:0.5rem">
                    <input type="text" class="suite-input" id="cg-path" placeholder="cgroup path (e.g. /sys/fs/cgroup/system.slice/nginx.service)" style="flex:3" />
                    <button class="suite-btn suite-btn-primary" id="btn-cg-show">Show</button>
                </div>
                <div id="cg-detail" class="suite-muted" style="margin-top:0.5rem">Enter a cgroup path and click Show.</div>
            </div>
        </div>

        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">cgroup: create / move</h3>
            </div>
            <div class="suite-card-body">
                <div class="suite-row" style="gap:0.5rem;margin-bottom:0.5rem">
                    <input type="text" class="suite-input" id="cg-create-path" placeholder="new cgroup path" style="flex:3" />
                    <button class="suite-btn" id="btn-cg-create">mkdir</button>
                </div>
                <div class="suite-row" style="gap:0.5rem;margin-bottom:0.5rem">
                    <input type="text" class="suite-input" id="cg-move-pid" placeholder="PID" style="flex:1" />
                    <input type="text" class="suite-input" id="cg-move-target" placeholder="target cgroup path" style="flex:2" />
                    <button class="suite-btn" id="btn-cg-move">move</button>
                </div>
                <div class="suite-row" style="gap:0.5rem">
                    <input type="text" class="suite-input" id="cg-set-path" placeholder="cgroup path" style="flex:1" />
                    <input type="text" class="suite-input" id="cg-set-ctrl" placeholder="control file (e.g. memory.max)" style="flex:1" />
                    <input type="text" class="suite-input" id="cg-set-val" placeholder="value (e.g. 1G, max, 100)" style="flex:1" />
                    <button class="suite-btn" id="btn-cg-set">write</button>
                </div>
            </div>
        </div>
    `;
}

function renderVlansCard(vlans, summary) {
    if (!summary?.available) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">VLANs</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">iproute2 not installed — VLANs cannot be managed from this panel.</p>
                </div>
            </div>
        `;
    }
    const list = vlans?.vlans || [];
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">VLANs (${list.length})</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-vlan-refresh">↻ Refresh</button>
            </div>
            <table class="suite-table">
                <thead><tr><th>Interface</th><th>VID</th><th>Protocol</th></tr></thead>
                <tbody>
                    ${list.map((v) => `
                        <tr>
                            <td class="suite-table-mono">${escapeHtml(v.interface)}</td>
                            <td class="suite-table-mono">${v.vid}</td>
                            <td class="suite-muted">${escapeHtml(v.protocol || '802.1Q')}</td>
                        </tr>
                    `).join('') || '<tr><td colspan="3" class="suite-muted">No VLANs configured.</td></tr>'}
                </tbody>
            </table>
        </div>

        <div class="suite-card">
            <h3 class="suite-card-title">VLAN: create / delete</h3>
            <div class="suite-card-body">
                <div class="suite-row" style="gap:0.5rem;margin-bottom:0.5rem">
                    <input type="text" class="suite-input" id="vlan-create-iface" placeholder="parent iface (e.g. eth0)" style="flex:1" />
                    <input type="text" class="suite-input" id="vlan-create-vid" placeholder="VID (1-4094)" style="flex:1" />
                    <button class="suite-btn suite-btn-primary" id="btn-vlan-create">Create</button>
                </div>
                <div class="suite-row" style="gap:0.5rem">
                    <input type="text" class="suite-input" id="vlan-del-iface" placeholder="parent iface" style="flex:1" />
                    <input type="text" class="suite-input" id="vlan-del-vid" placeholder="VID" style="flex:1" />
                    <button class="suite-btn" id="btn-vlan-delete">Delete</button>
                </div>
            </div>
        </div>
    `;
}

function renderEbpfCard(ebpf, summary) {
    if (!summary?.available) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">eBPF programs</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">bpftool not installed. Install:</p>
                    <pre class="suite-mono suite-cmd">pacman -S bpftool        # Arch
apt install linux-tools-common  # Debian</pre>
                </div>
            </div>
        `;
    }
    let progCount = 0;
    let progList = [];
    if (Array.isArray(ebpf?.programs)) {
        progList = ebpf.programs;
        progCount = progList.length;
    }
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">eBPF programs (${progCount})</h3>
                <div class="suite-row" style="gap:0.5rem">
                    <button class="suite-btn suite-btn-ghost" id="btn-ebpf-maps">Maps</button>
                    <button class="suite-btn suite-btn-ghost" id="btn-ebpf-refresh">↻</button>
                </div>
            </div>
            <table class="suite-table">
                <thead><tr><th>ID</th><th>Type</th><th>Name</th><th>Load time</th></tr></thead>
                <tbody>
                    ${progList.slice(0, 30).map((p) => {
                        const id = p.id ?? p.get('id') ?? '?';
                        const type = p.type ?? p.get('type') ?? '?';
                        const name = p.name ?? p.get('name') ?? '(unnamed)';
                        const loaded = p.loaded_at ?? p.get('loaded_at') ?? '';
                        return `<tr>
                            <td class="suite-table-mono">${id}</td>
                            <td class="suite-muted">${escapeHtml(String(type))}</td>
                            <td class="suite-table-mono">${escapeHtml(String(name))}</td>
                            <td class="suite-muted suite-mono" style="font-size:0.8rem">${escapeHtml(String(loaded))}</td>
                        </tr>`;
                    }).join('') || '<tr><td colspan="4" class="suite-muted">No BPF programs loaded.</td></tr>'}
                </tbody>
            </table>
        </div>

        <div class="suite-card">
            <h3 class="suite-card-title">eBPF: pin program to bpffs</h3>
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem">
                    Pinning a program to <code>/sys/fs/bpf/</code> makes it persistent until unmounted.
                </p>
                <div class="suite-row" style="gap:0.5rem">
                    <input type="text" class="suite-input" id="ebpf-pin-id" placeholder="program id" style="flex:1" />
                    <input type="text" class="suite-input" id="ebpf-pin-path" placeholder="/sys/fs/bpf/myprog" style="flex:2" />
                    <button class="suite-btn suite-btn-primary" id="btn-ebpf-pin">Pin</button>
                </div>
            </div>
        </div>
    `;
}

function renderNsCard(ns, summary) {
    if (!summary?.available) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">Namespaces</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">lsns (util-linux) not installed.</p>
                </div>
            </div>
        `;
    }
    const namespaces = ns?.namespaces || [];
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Namespaces (${namespaces.length})</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-ns-refresh">↻ Refresh</button>
            </div>
            <table class="suite-table">
                <thead><tr><th>NS</th><th>Type</th><th>NProcs</th><th>PID</th><th>Command</th><th>Path</th></tr></thead>
                <tbody>
                    ${namespaces.slice(0, 50).map((n) => `
                        <tr>
                            <td class="suite-table-mono">${escapeHtml(String(n.id ?? n.ns ?? '?'))}</td>
                            <td>${escapeHtml(n.type || '?')}</td>
                            <td>${n.nprocs || 0}</td>
                            <td class="suite-table-mono">${escapeHtml(String(n.pid ?? '?'))}</td>
                            <td class="suite-muted suite-mono">${escapeHtml(n.command || '')}</td>
                            <td class="suite-muted suite-mono" style="font-size:0.8rem">${escapeHtml(n.path || '')}</td>
                        </tr>
                    `).join('') || '<tr><td colspan="6" class="suite-muted">No namespaces.</td></tr>'}
                </tbody>
            </table>
            ${namespaces.length > 50 ? `<p class="suite-muted">Showing 50 of ${namespaces.length} namespaces.</p>` : ''}
        </div>
    `;
}

function renderApparmorCard(apparmor) {
    if (!apparmor) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">AppArmor (optional)</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">Probing AppArmor status ...</p>
                </div>
            </div>
        `;
    }
    if (!apparmor.available) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">AppArmor (optional — not present)</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">
                        ${escapeHtml(apparmor.reason || 'AppArmor is not active on this host.')}
                    </p>
                    ${apparmor.install_arch ? `<p class="suite-muted" style="margin-top:0.5rem">Arch: <code>${escapeHtml(apparmor.install_arch)}</code></p>` : ''}
                    ${apparmor.install_debian ? `<p class="suite-muted">Debian: <code>${escapeHtml(apparmor.install_debian)}</code></p>` : ''}
                    <p class="suite-muted" style="margin-top:0.5rem;font-size:0.85rem">
                        ${escapeHtml(apparmor.note || 'AppArmor is optional in SysDeck — the panel renders an install hint when absent.')}
                    </p>
                </div>
            </div>
        `;
    }
    if (apparmor.reason && apparmor.reason.includes("not installed")) {
        return `
            <div class="suite-card">
                <h3 class="suite-card-title">AppArmor (kernel active, userspace missing)</h3>
                <div class="suite-card-body">
                    <p class="suite-muted">${escapeHtml(apparmor.reason)}</p>
                    ${apparmor.install_arch ? `<p class="suite-muted">Arch: <code>${escapeHtml(apparmor.install_arch)}</code></p>` : ''}
                    ${apparmor.install_debian ? `<p class="suite-muted">Debian: <code>${escapeHtml(apparmor.install_debian)}</code></p>` : ''}
                </div>
            </div>
        `;
    }
    const status = apparmor.status || {};
    const profiles = status.profiles || {};
    const mode = status.mode || 'unknown';
    return `
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">AppArmor</h3>
                <span class="suite-badge success">kernel active</span>
                <span class="suite-badge" style="margin-left:0.25rem">mode: ${escapeHtml(mode)}</span>
            </div>
            <div class="suite-card-body">
                <p class="suite-muted" style="font-size:0.85rem">
                    AppArmor is optional in SysDeck. Enforce mode blocks; Complain mode logs violations
                    without blocking. Switch profiles below via aa-enforce / aa-complain.
                </p>
                <div class="suite-row" style="gap:0.5rem;margin-top:0.5rem">
                    <input type="text" class="suite-input" id="aa-profile" placeholder="profile name (e.g. /usr/bin/curl)" style="flex:2" />
                    <button class="suite-btn" id="btn-aa-enforce">aa-enforce</button>
                    <button class="suite-btn" id="btn-aa-complain">aa-complain</button>
                </div>
                <details style="margin-top:0.5rem">
                    <summary class="suite-muted" style="cursor:pointer">Loaded profiles (${(profiles.enforce || []).length + (profiles.complain || []).length + (profiles.audit || [])})</summary>
                    <pre class="suite-mono" style="white-space:pre-wrap;margin-top:0.5rem;background:#1a1a1a;padding:8px;border-radius:4px;max-height:300px;overflow:auto">${escapeHtml(JSON.stringify(profiles, null, 2))}</pre>
                </details>
            </div>
        </div>
    `;
}

// ── Event wiring ────────────────────────────────────────────────────

function wireEvents(panel, { bridge, EventBus }) {
    const outputCard = panel.querySelector('#policy-output-card');
    const outputPre = panel.querySelector('#policy-output-pre');
    const outputTitle = panel.querySelector('#policy-output-title');
    const showOutput = (title, text, isError = false) => {
        if (!outputCard || !outputPre) return;
        outputCard.style.display = 'block';
        outputTitle.textContent = title;
        outputPre.textContent = text;
        outputPre.style.color = isError ? 'var(--sysdeck-accent-danger)' : 'var(--sysdeck-fg)';
    };
    panel.querySelector('#btn-policy-output-close')?.addEventListener('click', () => {
        if (outputCard) outputCard.style.display = 'none';
    });

    // ── ACL ────────────────────────────────────────────────────────
    panel.querySelector('#btn-acl-list')?.addEventListener('click', async () => {
        const path = panel.querySelector('#acl-path')?.value?.trim();
        if (!path) { showOutput('ACL list', 'Enter a path first.', true); return; }
        showOutput(`ACLs on ${path}`, 'Loading ...');
        try {
            const r = await bridge.policy.aclList(path);
            const out = panel.querySelector('#acl-output');
            if (r.error) { showOutput(`ACL list — error`, r.error, true); return; }
            if (r.available === false) {
                showOutput('ACLs unavailable', r.reason + '\n\nInstall: ' + (r.install || '(see docs)'), true);
                return;
            }
            const lines = [];
            lines.push('Base: ' + (r.base || '(unknown)'));
            lines.push('Entries:');
            for (const e of (r.entries || [])) {
                lines.push(`  ${e.default ? 'default:' : ''}${e.kind}:${e.name || ''}:${e.perms}`);
            }
            lines.push('');
            lines.push('--- raw getfacl output ---');
            lines.push(r.raw || '(empty)');
            showOutput(`ACLs on ${path} (${(r.entries || []).length} entries)`, lines.join('\n'));
            if (out) out.innerHTML = `${(r.entries || []).length} entries — see output below.`;
        } catch (err) { showOutput('ACL list — error', String(err.message || err), true); }
    });

    const aclSet = async (op, label) => {
        const path = panel.querySelector('#acl-path')?.value?.trim();
        const entry = panel.querySelector('#acl-entry')?.value?.trim();
        if (!path || !entry) { showOutput(label, 'Both path and entry are required.', true); return; }
        showOutput(label, `Running setfacl on ${path} ... (cockpit will prompt for auth)`);
        try {
            const r = await op(path, entry);
            const ok = r.applied !== undefined ? r.applied : (r.removed !== undefined ? r.removed : false);
            showOutput(`${label} — ${ok ? 'success' : 'failed'}`,
                      `${ok ? 'OK' : 'FAILED'} rc=${r.rc ?? 'n/a'}\n\nstderr: ${r.stderr || '(empty)'}`,
                      !ok);
        } catch (err) { showOutput(`${label} — error`, String(err.message || err), true); }
    };
    panel.querySelector('#btn-acl-set')?.addEventListener('click', () => aclSet(bridge.policy.aclSet, 'setfacl -m'));
    panel.querySelector('#btn-acl-remove')?.addEventListener('click', () => aclSet(bridge.policy.aclRemove, 'setfacl -x'));
    panel.querySelector('#btn-acl-default')?.addEventListener('click', () => aclSet(bridge.policy.aclDefault, 'setfacl -d -m'));

    // ── cgroups ────────────────────────────────────────────────────
    panel.querySelector('#btn-cg-refresh')?.addEventListener('click', () => mount(panel, { bridge, EventBus }));
    panel.querySelector('#btn-cg-show')?.addEventListener('click', async () => {
        const path = panel.querySelector('#cg-path')?.value?.trim();
        if (!path) { showOutput('cgroup show', 'Path required.', true); return; }
        showOutput(`cgroup ${path}`, 'Loading ...');
        try {
            const r = await bridge.policy.cgroupShow(path);
            if (r.error) { showOutput('cgroup show — error', r.error, true); return; }
            const lines = [];
            for (const [k, v] of Object.entries(r)) {
                if (k === 'processes') continue;
                lines.push(`${k}: ${v}`);
            }
            lines.push('');
            lines.push(`Processes (${r.processes?.length || 0}${r.process_count_truncated ? ' — truncated to 50' : ''}):`);
            for (const p of (r.processes || [])) lines.push(`  ${p.pid}  ${p.comm}`);
            showOutput(`cgroup ${path}`, lines.join('\n'));
        } catch (err) { showOutput('cgroup show — error', String(err.message || err), true); }
    });
    panel.querySelector('#btn-cg-create')?.addEventListener('click', async () => {
        const path = panel.querySelector('#cg-create-path')?.value?.trim();
        if (!path) { showOutput('cgroup create', 'Path required.', true); return; }
        showOutput('cgroup create', `Creating ${path} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.policy.cgroupCreate(path);
            showOutput(`cgroup create — ${r.created ? 'success' : 'failed'}`,
                      JSON.stringify(r, null, 2), !r.created);
            if (r.created) setTimeout(() => mount(panel, { bridge, EventBus }), 800);
        } catch (err) { showOutput('cgroup create — error', String(err.message || err), true); }
    });
    panel.querySelector('#btn-cg-move')?.addEventListener('click', async () => {
        const pid = panel.querySelector('#cg-move-pid')?.value?.trim();
        const target = panel.querySelector('#cg-move-target')?.value?.trim();
        if (!pid || !target) { showOutput('cgroup move', 'Both PID and target required.', true); return; }
        showOutput('cgroup move', `Moving PID ${pid} to ${target} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.policy.cgroupMove(pid, target);
            showOutput(`cgroup move — ${r.moved ? 'success' : 'failed'}`,
                      JSON.stringify(r, null, 2), !r.moved);
        } catch (err) { showOutput('cgroup move — error', String(err.message || err), true); }
    });
    panel.querySelector('#btn-cg-set')?.addEventListener('click', async () => {
        const path = panel.querySelector('#cg-set-path')?.value?.trim();
        const ctrl = panel.querySelector('#cg-set-ctrl')?.value?.trim();
        const val = panel.querySelector('#cg-set-val')?.value?.trim();
        if (!path || !ctrl || !val) { showOutput('cgroup set', 'Path, control file, and value all required.', true); return; }
        showOutput('cgroup set', `Writing ${val} to ${path}/${ctrl} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.policy.cgroupSet(path, ctrl, val);
            showOutput(`cgroup set — ${r.set ? 'success' : 'failed'}`,
                      JSON.stringify(r, null, 2), !r.set);
        } catch (err) { showOutput('cgroup set — error', String(err.message || err), true); }
    });

    // ── VLANs ──────────────────────────────────────────────────────
    panel.querySelector('#btn-vlan-refresh')?.addEventListener('click', () => mount(panel, { bridge, EventBus }));
    panel.querySelector('#btn-vlan-create')?.addEventListener('click', async () => {
        const iface = panel.querySelector('#vlan-create-iface')?.value?.trim();
        const vid = panel.querySelector('#vlan-create-vid')?.value?.trim();
        if (!iface || !vid) { showOutput('vlan create', 'Both iface and VID required.', true); return; }
        showOutput('vlan create', `Creating ${iface}.${vid} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.policy.vlanCreate(iface, vid);
            showOutput(`vlan create — ${r.created ? 'success' : 'failed'}`,
                      JSON.stringify(r, null, 2), !r.created);
            if (r.created) setTimeout(() => mount(panel, { bridge, EventBus }), 800);
        } catch (err) { showOutput('vlan create — error', String(err.message || err), true); }
    });
    panel.querySelector('#btn-vlan-delete')?.addEventListener('click', async () => {
        const iface = panel.querySelector('#vlan-del-iface')?.value?.trim();
        const vid = panel.querySelector('#vlan-del-vid')?.value?.trim();
        if (!iface || !vid) { showOutput('vlan delete', 'Both iface and VID required.', true); return; }
        showOutput('vlan delete', `Deleting ${iface}.${vid} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.policy.vlanDelete(iface, vid);
            showOutput(`vlan delete — ${r.deleted ? 'success' : 'failed'}`,
                      JSON.stringify(r, null, 2), !r.deleted);
            if (r.deleted) setTimeout(() => mount(panel, { bridge, EventBus }), 800);
        } catch (err) { showOutput('vlan delete — error', String(err.message || err), true); }
    });

    // ── eBPF ───────────────────────────────────────────────────────
    panel.querySelector('#btn-ebpf-refresh')?.addEventListener('click', () => mount(panel, { bridge, EventBus }));
    panel.querySelector('#btn-ebpf-maps')?.addEventListener('click', async () => {
        showOutput('eBPF maps', 'Loading ...');
        try {
            const r = await bridge.policy.ebpfMaps();
            showOutput('eBPF maps', JSON.stringify(r, null, 2).slice(0, 50000));
        } catch (err) { showOutput('eBPF maps — error', String(err.message || err), true); }
    });
    panel.querySelector('#btn-ebpf-pin')?.addEventListener('click', async () => {
        const id = panel.querySelector('#ebpf-pin-id')?.value?.trim();
        const path = panel.querySelector('#ebpf-pin-path')?.value?.trim();
        if (!id || !path) { showOutput('eBPF pin', 'Both program id and path required.', true); return; }
        showOutput('eBPF pin', `Pinning prog ${id} to ${path} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.policy.ebpfPin(id, path);
            showOutput(`eBPF pin — ${r.pinned ? 'success' : 'failed'}`,
                      JSON.stringify(r, null, 2), !r.pinned);
        } catch (err) { showOutput('eBPF pin — error', String(err.message || err), true); }
    });

    // ── Namespaces ─────────────────────────────────────────────────
    panel.querySelector('#btn-ns-refresh')?.addEventListener('click', () => mount(panel, { bridge, EventBus }));

    // ── AppArmor ───────────────────────────────────────────────────
    panel.querySelector('#btn-aa-enforce')?.addEventListener('click', async () => {
        const profile = panel.querySelector('#aa-profile')?.value?.trim();
        if (!profile) { showOutput('aa-enforce', 'Profile name required.', true); return; }
        showOutput('aa-enforce', `Switching ${profile} to enforce ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.policy.apparmorEnforce(profile);
            showOutput(`aa-enforce — ${r.enforced ? 'success' : 'failed'}`,
                      `output: ${r.output || '(empty)'}\nstderr: ${r.stderr || '(empty)'}`,
                      !r.enforced);
        } catch (err) { showOutput('aa-enforce — error', String(err.message || err), true); }
    });
    panel.querySelector('#btn-aa-complain')?.addEventListener('click', async () => {
        const profile = panel.querySelector('#aa-profile')?.value?.trim();
        if (!profile) { showOutput('aa-complain', 'Profile name required.', true); return; }
        showOutput('aa-complain', `Switching ${profile} to complain ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.policy.apparmorComplain(profile);
            showOutput(`aa-complain — ${r.complain ? 'success' : 'failed'}`,
                      `output: ${r.output || '(empty)'}\nstderr: ${r.stderr || '(empty)'}`,
                      !r.complain);
        } catch (err) { showOutput('aa-complain — error', String(err.message || err), true); }
    });

    // ── v0.0.33 LSM event wiring ───────────────────────────────────
    panel.querySelector('#btn-smack-load')?.addEventListener('click', async () => {
        const f = panel.querySelector('#smack-load-file')?.value?.trim();
        if (!f) { showOutput('smackload', 'Rules file path required.', true); return; }
        showOutput('smackload', `Loading Smack rules from ${f} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.policy.smackLoad(f);
            showOutput(`smackload — ${r.loaded ? 'success' : 'failed'}`,
                      JSON.stringify(r, null, 2), !r.loaded);
        } catch (err) { showOutput('smackload — error', String(err.message || err), true); }
    });
    panel.querySelector('#btn-smack-labels')?.addEventListener('click', async () => {
        showOutput('Smack labels', 'Loading ...');
        try {
            const r = await bridge.policy.smackLabels();
            showOutput(`Smack labels (${r.label_count || 0})`,
                      JSON.stringify(r, null, 2).slice(0, 50000));
        } catch (err) { showOutput('Smack labels — error', String(err.message || err), true); }
    });

    panel.querySelector('#btn-tomoyo-save')?.addEventListener('click', async () => {
        const p = panel.querySelector('#tomoyo-save-path')?.value?.trim();
        if (!p) { showOutput('tomoyo-save', 'Output path required.', true); return; }
        showOutput('tomoyo-save', `Saving TOMOYO snapshot to ${p} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.policy.tomoyoSavePolicy(p);
            showOutput(`tomoyo-save — ${r.saved ? 'success' : 'failed'}`,
                      JSON.stringify(r, null, 2), !r.saved);
        } catch (err) { showOutput('tomoyo-save — error', String(err.message || err), true); }
    });
    panel.querySelector('#btn-tomoyo-profiles')?.addEventListener('click', async () => {
        showOutput('TOMOYO profiles', 'Loading ...');
        try {
            const r = await bridge.policy.tomoyoProfiles();
            showOutput('TOMOYO profiles', JSON.stringify(r, null, 2).slice(0, 50000));
        } catch (err) { showOutput('TOMOYO profiles — error', String(err.message || err), true); }
    });

    panel.querySelector('#btn-yama-set')?.addEventListener('click', async () => {
        const scope = panel.querySelector('#yama-scope-select')?.value;
        if (scope === undefined || scope === null) { showOutput('yama-set', 'Select a scope value.', true); return; }
        showOutput('yama-set', `Setting ptrace scope to ${scope} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.policy.yamaSetScope(parseInt(scope, 10));
            showOutput(`yama-set — ${r.set ? 'success' : 'failed'}`,
                      `scope=${r.scope}\nname=${r.scope_name || 'unknown'}\nfile=${r.file || ''}`,
                      !r.set);
        } catch (err) { showOutput('yama-set — error', String(err.message || err), true); }
    });

    panel.querySelector('#btn-filecaps-refresh')?.addEventListener('click', () => mount(panel, { bridge, EventBus }));
    panel.querySelector('#btn-filecaps-set')?.addEventListener('click', async () => {
        const caps = panel.querySelector('#filecaps-set-caps')?.value?.trim();
        const path = panel.querySelector('#filecaps-set-path')?.value?.trim();
        if (!caps || !path) { showOutput('setcap', 'Both caps and path required.', true); return; }
        showOutput('setcap', `setcap ${caps} ${path} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.policy.filecapsSet(caps, path);
            showOutput(`setcap — ${r.set ? 'success' : 'failed'}`,
                      `rc=${r.rc}\nstderr: ${r.stderr || '(empty)'}`,
                      !r.set);
            if (r.set) setTimeout(() => mount(panel, { bridge, EventBus }), 800);
        } catch (err) { showOutput('setcap — error', String(err.message || err), true); }
    });
    panel.querySelector('#btn-filecaps-show')?.addEventListener('click', async () => {
        const path = panel.querySelector('#filecaps-show-path')?.value?.trim();
        if (!path) { showOutput('getcap', 'Path required.', true); return; }
        showOutput(`getcap ${path}`, 'Loading ...');
        try {
            const r = await bridge.policy.filecapsShow(path);
            showOutput(`getcap ${path}`, `caps: ${r.caps || '(none)'}\nrc=${r.rc}\nstderr: ${r.stderr || ''}`);
        } catch (err) { showOutput('getcap — error', String(err.message || err), true); }
    });
    panel.querySelector('#btn-filecaps-remove')?.addEventListener('click', async () => {
        const path = panel.querySelector('#filecaps-show-path')?.value?.trim();
        if (!path) { showOutput('setcap -r', 'Path required.', true); return; }
        showOutput('setcap -r', `Removing caps from ${path} ... (cockpit will prompt for auth)`);
        try {
            const r = await bridge.policy.filecapsRemove(path);
            showOutput(`setcap -r — ${r.removed ? 'success' : 'failed'}`,
                      `rc=${r.rc}\nstderr: ${r.stderr || '(empty)'}`,
                      !r.removed);
            if (r.removed) setTimeout(() => mount(panel, { bridge, EventBus }), 800);
        } catch (err) { showOutput('setcap -r — error', String(err.message || err), true); }
    });
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

function renderSkeleton() {
    return `<div class="suite-skeleton">
        <div class="suite-skeleton-line w-1/3"></div>
        <div class="suite-skeleton-line w-2/3"></div>
        <div class="suite-skeleton-line w-1/2"></div>
    </div>`;
}
