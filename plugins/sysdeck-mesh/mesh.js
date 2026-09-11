/*
 * SysDeck - Service Mesh Panel
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * Queries Kubernetes services via `kubectl get svc -A -o json`. Renders
 * the service list with namespaces. Falls back to a hint card when
 * kubectl is absent or the cluster is unreachable.
 */

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
                            <td><span class="suite-badge info">${svc.metadata.namespace}</span></td>
                            <td>${svc.metadata.name}</td>
                            <td class="suite-muted">${svc.spec.type ?? '—'}</td>
                            <td class="suite-table-mono">${svc.spec.clusterIP ?? '—'}</td>
                            <td class="suite-table-mono suite-muted">${(svc.spec.ports ?? []).map((p) => `${p.port}/${p.protocol}`).join(', ') || '—'}</td>
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
