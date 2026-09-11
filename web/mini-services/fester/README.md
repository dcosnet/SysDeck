# Fester — distributed DAG build orchestration

Fester is developed upstream as an **independent repository**. This copy is
the vendored snapshot **pre-integrated** into the SysDeck master tarball —
SysDeck ships with Fester wired in, no separate checkout required.

- Version: **0.2.1** (versioned independently from SysDeck 0.2.0)
- Runtime: Bun — `bun install && bun run dev` (hot reload)
- Transport: REST + raw WebSocket on **port 3010**
- Storage: SQLite timeline (`fester.db`, created and seeded on first boot)

## Architecture

| File | Role |
|---|---|
| `engine.ts` | PipelineEngine — DAG execution in topological waves, retries, CAS cache, BTC stamps, pause/step debugger |
| `scheduler.ts` | Weighted node scoring (cpu / temp / policy / instability) |
| `nodes.ts` | NodeStateRegistry + synthetic drift + the real local node |
| `events.ts` | EventBus + FesterEvent schema |
| `store.ts` | SQLite storage: builds / sessions / events / node states |
| `autopsy.ts` | Failure autopsy + propagation analysis |
| `cause.ts` | Causal graph builder |
| `api.ts` | REST surface (mirrors the upstream route table) |
| `clock.ts` | Engine tick loop |
| `targets.ts` | Project/target catalog |
| `seed.ts` | First-boot synthetic history (powers the replay views) |

## REST surface (abbreviated)

- `GET  /api/health` — service status
- `GET  /api/builds`, `GET /api/builds/{id}` — build list / detail
- `POST /api/build` — start a build `{project, targets[], noCache?, retries?}`
- `POST /api/builds/{id}/cancel`
- `GET  /api/targets` · `/api/nodes` · `/api/metrics` · `/api/policy`
- `GET  /api/timeline[/{id}]` · `POST/GET /api/sessions`
- `GET  /api/autopsy/{build}/{action}` · `/api/cause/{build}` · `/api/debugger/{build}`

WebSocket: connect to `ws://host:3010/` (or through a gateway at
`/?XTransformPort=3010`). Full broadcast by default;
`{"type":"subscribe","buildId":…}` for a single-build stream;
`{"type":"debugger","buildId":…,"command":"pause|resume|step"}` for the
interactive debugger.

## Integration points

- **SysDeck Web Edition** — server-side proxy `src/app/api/fester/route.ts`
  plus the Fester sub-app (`src/components/sysdeck/panels/festerPanel.tsx`).
- **SysDeck Cockpit Edition** — bridge helper `bridge/fester.py` talks to
  this service over REST (see the cockpit tree in the master tarball).
