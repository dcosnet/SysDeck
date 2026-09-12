# Commands, Scripts & Tests Reference

This reference is derived from `deno.jsonc`, `apps/control-ui/deno.jsonc`,
`tests/browser/package.json`, and the scripts under `scripts/`.

## Backend commands

| Command             | Description                                                                                         | Usage Example                          |
| ------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Start dev server    | Runs the gateway with `.env` loaded and file watching enabled                                       | `deno task dev`                        |
| Start gateway       | Runs the gateway without watch mode                                                                 | `deno task start`                      |
| Bootstrap toolchain | Installs the `npm:esbuild` script dependency Deno expects for the UI build                          | `deno task setup`                      |
| Backend type check  | Runs `deno check` across gateway, packages, and non-browser tests                                   | `deno task check`                      |
| Format              | Runs `deno fmt`                                                                                     | `deno task fmt`                        |
| Lint                | Runs `deno lint`                                                                                    | `deno task lint`                       |
| Backend tests       | Runs unit, contract, integration, and e2e tests while ignoring control UI, browser, and live suites | `deno task test`                       |
| Full gate           | Runs the ordered full-suite driver                                                                  | `deno task test:all`                   |
| E2E tests           | Runs the e2e HTTP and UI-serving suite                                                              | `deno task test:e2e`                   |
| Live tests          | Runs Docker-backed PostgreSQL and vector-store live tests                                           | `deno task test:live`                  |
| Load benchmark      | Drives the gateway over real HTTP and reports throughput and latency                                | `deno task test:load`                  |
| Benchmarks          | Runs colocated micro-benchmarks                                                                     | `deno task bench`                      |
| KV migration        | Performs or previews Deno KV to PostgreSQL migration                                                | `deno task migrate:kv-pg -- --dry-run` |
| Docker image build  | Builds the gateway image                                                                            | `deno task docker:build`               |

## Frontend commands

The control UI is driven through Deno, not the npm CLI.

| Command                 | Description                     | Usage Example          |
| ----------------------- | ------------------------------- | ---------------------- |
| Start dev server        | Runs Vite through Deno          | `deno task dev-ui`     |
| Build production bundle | Runs TypeScript then Vite build | `deno task build-ui`   |
| Preview bundle          | Runs Vite preview through Deno  | `deno task preview-ui` |
| Type check              | Runs the UI TypeScript compiler | `deno task check-ui`   |
| UI unit tests           | Runs Vitest through Deno        | `deno task test-ui`    |

Equivalent workspace-member commands inside `apps/control-ui/deno.jsonc`:

- `deno task -f control-ui dev`
- `deno task -f control-ui build`
- `deno task -f control-ui preview`
- `deno task -f control-ui check`
- `deno task -f control-ui test`

## Docker commands

| Command                      | Description                                                         | Usage Example                                  |
| ---------------------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| Start gateway and PostgreSQL | Starts the default Compose path                                     | `docker compose up -d`                         |
| Start with PgBouncer         | Adds the transaction pooler profile                                 | `docker compose --profile pgbouncer up -d`     |
| Start observability stack    | Adds Grafana, Prometheus, OTEL Collector, MinIO, and Tempo services | `docker compose --profile observability up -d` |
| Build image                  | Builds the gateway container image                                  | `docker build -t frosty-gateway .`             |
| Follow logs                  | Streams container logs                                              | `docker compose logs -f gateway`               |
| Stop services                | Stops and removes containers                                        | `docker compose down`                          |
| Reset volumes                | Stops services and removes volumes                                  | `docker compose down -v`                       |

## Utility scripts

| Script                                     | Description                                                                                                              | Usage Example                                                                | Side Effects                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `scripts/full_suite.ts`                    | Ordered full validation driver across formatting, linting, type checks, tests, UI build, live tests, and browser harness | `deno task test:all -- --list`                                               | Executes checks and can skip stages when prerequisites are missing            |
| `scripts/migrate_kv_to_pg.ts`              | One-time Deno KV to PostgreSQL migration utility                                                                         | `deno task migrate:kv-pg -- --commit`                                        | Writes migrated state into PostgreSQL; never mutates the source KV file       |
| `scripts/load-bench.ts`                    | Tier-1 load benchmark against an in-process or external gateway                                                          | `deno task test:load`                                                        | Starts a mock upstream and optionally an in-process gateway                   |
| `scripts/codemode_worker_options_probe.ts` | Minimal out-of-process Code Mode worker-permission probe                                                                 | `deno run --allow-read --allow-env scripts/codemode_worker_options_probe.ts` | Exits non-zero when worker permission enforcement is missing                  |
| `scripts/codemode_launch_matrix.sh`        | Launch-matrix regression check around Code Mode worker options                                                           | `bash scripts/codemode_launch_matrix.sh`                                     | Runs several `deno run` permutations and inspects exit codes                  |
| `scripts/generate_sbom.ts`                 | Generates the human-readable and CycloneDX SBOM artifacts from checked-in manifests and lockfiles                        | `deno run -A scripts/generate_sbom.ts`                                       | Writes `docs/reference/sbom.md` and `docs/reference/sbom/sbom.cyclonedx.json` |

## Testing reference

### Backend and shared-code tests

- `deno task test` runs unit, contract, integration, and e2e suites while
  explicitly ignoring `apps/control-ui`, `tests/browser`, and `tests/live`.
- `deno test --unstable-net --unstable-worker-options --allow-net --allow-env --allow-read --allow-write --allow-run packages/`
  runs the per-package unit slice.
- `deno test --unstable-net --unstable-worker-options --allow-net --allow-env --allow-read --allow-write --allow-run tests/contract/`
  runs wire-format fidelity tests.
- `deno test --unstable-net --unstable-worker-options --allow-net --allow-env --allow-read --allow-write --allow-run tests/integration/ apps/gateway/`
  runs integration coverage.
- `deno task test:e2e` runs e2e coverage.

### UI and browser tests

- `deno task test-ui` runs the control UI Vitest suite.
- `npx playwright test` inside `tests/browser` runs the browser harness. The
  full-suite driver only runs it when an already-running gateway is reachable at
  `FROSTY_BASE_URL` or `http://localhost:8080`.

### Live and external-dependency tests

- `deno task test:live` needs Docker and will drive its own PostgreSQL-backed
  live environment.
- `deno task test:all` reports missing prerequisites as skipped stages instead
  of silently omitting them.

### Coverage and verification notes

- There is no dedicated coverage task in the checked-in Deno task surface.
- The repository's documented gate is `deno fmt --check`, `deno lint`,
  `deno task check`, `deno task test`, `deno task check-ui`,
  `deno task test-ui`, and `deno task build-ui`, with `deno task test:all` as
  the single-command orchestrator.
