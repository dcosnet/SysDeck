/*
 * SysDeck - Benchmark Panel (v0.0.11)
 * Author: Jeremy Anderson (https://dcos.net)
 *
 * System benchmarking via sysbench. Attributes the cockpit-benchmark
 * plugin (MIT, ealier) whose standalone plugin lives at
 * https://github.com/ealier/cockpit-benchmark.
 *
 * This panel invokes sysbench via cockpit.spawn as a separate process —
 * no cockpit-benchmark or sysbench code is bundled. sysbench is GPL-2.0
 * licensed; the suite (MIT) and sysbench remain independent programs.
 *
 * Shows available tests, run controls, and results history.
 */

export async function mount(panel, { bridge, EventBus }) {
    panel.innerHTML = renderSkeleton();

    let tests = [];
    try {
        tests = await bridge.benchmark.listTests();
    } catch (err) {
        panel.innerHTML = renderError(err);
        return;
    }

    panel.innerHTML = `
        <header>
            <h2 class="suite-panel-title">System Benchmark</h2>
            <p class="suite-panel-subtitle">sysbench + cockpit-benchmark integration</p>
            <span class="suite-badge info">MIT · ealier</span>
        </header>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Available Tests</h3>
                <button class="suite-btn suite-btn-ghost" id="btn-benchmark-refresh">↻ Refresh</button>
            </div>
            <table class="suite-table">
                <thead><tr><th>Test</th><th>Tool</th><th>Actions</th></tr></thead>
                <tbody>
                    ${tests.map((t) => `<tr>
                        <td class="suite-table-mono">${t.name}</td>
                        <td>${t.tool}</td>
                        <td><button class="suite-btn suite-btn-primary" data-test="${t.name}">Run</button></td>
                    </tr>`).join('') || '<tr><td colspan="3" class="suite-muted">No benchmarks available. Install sysbench.</td></tr>'}
                </tbody>
            </table>
        </div>
        <div class="suite-card">
            <div class="suite-card-header">
                <h3 class="suite-card-title">Quick Benchmarks</h3>
            </div>
            <div class="suite-row">
                <button class="suite-btn suite-btn-primary" id="btn-run-cpu">CPU Benchmark</button>
                <button class="suite-btn suite-btn-primary" id="btn-run-memory">Memory Benchmark</button>
                <button class="suite-btn suite-btn-primary" id="btn-run-io">File I/O Benchmark</button>
            </div>
            <div id="benchmark-results" class="suite-muted">No results yet. Click a benchmark to run.</div>
        </div>
    `;

    const resultsDiv = panel.querySelector('#benchmark-results');

    const runBench = async (name, resultFn) => {
        resultsDiv.innerHTML = `<em>Running ${name} benchmark...</em>`;
        try {
            const result = await resultFn();
            EventBus.emit('benchmark.run', { test: name, result });
            resultsDiv.innerHTML = `
                <h4>${name} Results</h4>
                <p>Events/sec: <strong>${result.events_per_sec ?? 'N/A'}</strong></p>
                <p>Avg latency: <strong>${result.latency_ms != null ? result.latency_ms.toFixed(2) + ' ms' : 'N/A'}</strong></p>
                <details><summary>Raw output</summary><pre>${result.raw || 'N/A'}</pre></details>
            `;
        } catch (err) {
            resultsDiv.innerHTML = `<span class="suite-badge warn">Error: ${err.message || err}</span>`;
        }
    };

    panel.querySelector('#btn-run-cpu')?.addEventListener('click', () => runBench('CPU', () => bridge.benchmark.runCpu()));
    panel.querySelector('#btn-run-memory')?.addEventListener('click', () => runBench('Memory', () => bridge.benchmark.runMemory()));
    panel.querySelector('#btn-run-io')?.addEventListener('click', () => runBench('File I/O', () => bridge.benchmark.runIo()));

    panel.querySelectorAll('[data-test]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const test = btn.dataset.test;
            btn.disabled = true;
            try {
                const result = await bridge.benchmark.runTest(test);
                EventBus.emit('benchmark.run', { test });
                resultsDiv.innerHTML = `<h4>${test} completed</h4><pre>${result}</pre>`;
            } catch (err) {
                resultsDiv.innerHTML = `<span class="suite-badge warn">${err.message || err}</span>`;
            }
            btn.disabled = false;
        });
    });

    panel.querySelector('#btn-benchmark-refresh')?.addEventListener('click', () => {
        mount(panel, { bridge, EventBus });
    });
}

function renderSkeleton() {
    return `<div class="suite-skeleton">
        <div class="suite-skeleton-line w-1/3"></div>
        <div class="suite-skeleton-line w-2/3"></div>
        <div class="suite-skeleton-line w-1/2"></div>
    </div>`;
}

function renderError(err) {
    return `<div class="suite-card">
        <h3 class="suite-card-title">Benchmark tools unavailable</h3>
        <p class="suite-card-body suite-muted">${err.message || err}. Install sysbench for system benchmarking.</p>
        <p class="suite-muted">cockpit-benchmark (MIT) by ealier — <a href="https://github.com/ealier/cockpit-benchmark">https://github.com/ealier/cockpit-benchmark</a></p>
        <p class="suite-muted">sysbench (GPL-2.0) — <a href="https://github.com/akopytov/sysbench">https://github.com/akopytov/sysbench</a></p>
    </div>`;
}
