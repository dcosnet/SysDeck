# Local Development Environment

This guide covers the full local-development workflow for Frosty Deno.

## Development prerequisites

### Required software

- Deno 2.9.x
- Git
- Docker and Docker Compose v2.20+ if you want the shipped PostgreSQL service or
  the observability profile

### Conditionally required software

- Node and `npx` only for the Playwright browser harness under `tests/browser`

### Recommended editor setup

The repository does not enforce an IDE choice, but the codebase is easiest to
work with in VS Code or another editor with strong TypeScript and Deno support.

Recommended, not required:

- Deno extension for VS Code
- Tailwind CSS IntelliSense for token-driven UI work
- Playwright extension if you work on `tests/browser`

## Backend development

### Dependency setup

```bash
deno task setup
```

### Database initialization

The production path creates its own PostgreSQL schema and tables if they do not
exist. For local development, the usual setup is:

```bash
docker compose up -d postgres
```

If you are migrating from an older Deno KV-based deployment, use:

```bash
deno task migrate:kv-pg -- --dry-run
deno task migrate:kv-pg -- --commit
```

### Start the backend with reload

```bash
deno task dev
```

This is the hot-reload path for gateway work.

### Useful backend checks

```bash
deno task check
deno task test
deno task test:e2e
```

### Debugging tips

- `GET /healthz` and `GET /api/version` confirm boot success and runtime
  version.
- `GET /api/runtime` exposes process-topology and concurrency information once
  the gateway is up.
- Boot failures are intentionally terse and usually point to PostgreSQL or
  encryption-key problems first.

## Frontend development

### UI dev server

```bash
deno task dev-ui
```

This runs Vite through Deno. There is no separate npm-based `npm run dev`
workflow in the checked-in project.

### UI type check and tests

```bash
deno task check-ui
deno task test-ui
```

### Production bundle build

```bash
deno task build-ui
```

### Frontend environment notes

- The control UI talks to same-origin `/api/*` routes.
- There is no separate frontend env file checked into `apps/control-ui`.
- The UI relies on the gateway for auth, config, logs, governance, and runtime
  data.

### Browser DevTools

The UI uses a hand-rolled hash router and a same-origin API client. Browser
DevTools are most useful for:

- verifying `#/...` route changes,
- checking `/api/*` responses,
- confirming token storage behavior in `sessionStorage` and UI preferences in
  `localStorage`.

## Full-stack development

### Same-origin full stack

Build the UI once, then run the gateway:

```bash
deno task build-ui
deno task dev
```

This is the closest path to the shipped runtime topology.

### Split development workflow

Run the gateway and the UI dev server separately when actively working on the
control plane:

```bash
deno task dev
deno task dev-ui
```

### Common development tasks

- Provider and route work: `deno task check`, `deno task test`
- UI work: `deno task check-ui`, `deno task test-ui`, `deno task build-ui`
- End-to-end verification: `deno task test:e2e`
- Full validation sweep: `deno task test:all`

## Troubleshooting

### Common issues

- PostgreSQL unreachable: the production bootstrap fails closed; verify
  `FROSTY_PG_URL` and the `postgres` container first.
- Control UI not served by the gateway: run `deno task build-ui` so
  `apps/control-ui/dist` exists.
- Browser harness skips in the full suite: install Node tooling with `npx`
  available and start a gateway reachable at `FROSTY_BASE_URL` or
  `http://localhost:8080`.
- Multi-process mode not activating: check `FROSTY_WORKERS`, platform support,
  and whether the runtime has scoped run permission.

### Logs and diagnostics

- Gateway process logs: terminal output or `docker compose logs -f gateway`
- Live log trail: `GET /api/logs`
- Stored log trail: `GET /api/logs/stored`
- Metrics: `GET /metrics`
- Runtime summary: `GET /api/runtime`

### Profiling and performance

- Use `deno task test:load` for end-to-end gateway-over-HTTP throughput and
  latency measurements.
- Use `deno task bench` for colocated micro-benchmarks.
- Use `docs/benchmark-report.md` as the repository's checked-in performance
  context.
