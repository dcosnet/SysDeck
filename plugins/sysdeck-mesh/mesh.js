/*
 * SysDeck - Service Mesh Panel
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * Queries Kubernetes services via `kubectl get svc -A -o json`. Renders
 * the service list with namespaces. Falls back to a hint card when
 * kubectl is absent or the cluster is unreachable.
 *
 * v0.1.4 FIX + SECURITY: the table used to read svc.metadata.* /
 * svc.spec.*, but bridge/mesh.py returns a FLATTENED shape
 * {name, namespace, type, clusterIP, ports} — any populated cluster
 * threw a TypeError and the panel died. Names/namespace values come
 * from kubectl output and are now escaped too (0.3.0 audit).
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
    const data = await bridge.mesh.services();
    const items = data?.items ?? [];
    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">Service Mesh</h2>
            <p class="suite-panel-subtitle">${items.length} Kubernetes services</p>
        </header>
        <div class="suite-card">
            <table class="suite-table">
                <thead><tr><th>Namespace</th><th>Service</th><th>Type</th><th>Cluster IP</th><th>Ports</th></tr></thead>
                <tbody>
                    ${items.map((svc) => `
                        <tr>
                            <td><span class="suite-badge info">${escapeHtml(svc.namespace)}</span></td>
                            <td>${escapeHtml(svc.name)}</td>
                            <td class="suite-muted">${escapeHtml(svc.type ?? '—')}</td>
                            <td class="suite-table-mono">${escapeHtml(svc.clusterIP ?? '—')}</td>
                            <td class="suite-table-mono suite-muted">${escapeHtml((svc.ports ?? []).join(', ') || '—')}</td>
                        </tr>
                    `).join('') || '<tr><td colspan="5" class="suite-muted">No services. Confirm kubectl is installed and kubeconfig is reachable.</td></tr>'}
                </tbody>
            </table>
        </div>
    `;
    EventBus.emit('mesh.loaded', { serviceCount: items.length });
}

function renderSkeleton() {
    return `<div class="suite-skeleton"><div class="suite-skeleton-line w-1/2"></div></div>`;
}
