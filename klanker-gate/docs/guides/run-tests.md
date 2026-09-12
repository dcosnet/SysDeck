# Run Tests

This guide maps the repository's actual test and validation surface.

## Fast paths

### Backend and shared logic

```bash
deno task check
deno task test
```

### Control UI

```bash
deno task check-ui
deno task test-ui
deno task build-ui
```

### Full gate

```bash
deno task test:all
```

`test:all` runs stages in dependency order and reports missing prerequisites as
`SKIP` rather than silently dropping them.

## What each command does

| Command               | What it covers                                       |
| --------------------- | ---------------------------------------------------- |
| `deno fmt --check`    | formatting                                           |
| `deno lint`           | lint rules                                           |
| `deno task check`     | backend type checking                                |
| `deno task test`      | unit, contract, integration, and e2e tests           |
| `deno task test:e2e`  | e2e HTTP and SPA-serving tests                       |
| `deno task test:live` | Docker-backed live PostgreSQL and vector-store tests |
| `deno task check-ui`  | UI TypeScript checks                                 |
| `deno task test-ui`   | UI Vitest suite                                      |
| `deno task build-ui`  | production UI bundle build                           |

## Browser harness

The browser harness is separate from the main Deno task graph.

Requirements:

- Node tooling with `npx`
- a running gateway at `FROSTY_BASE_URL` or `http://localhost:8080`

Run it manually:

```bash
cd tests/browser
npx playwright test
```

## Live-test prerequisites

`deno task test:live` requires Docker. The full-suite driver will mark it as
skipped when Docker is unavailable or the daemon is unreachable.

## Performance and regression tools

These are not part of the main gate but are shipped for performance work and
special checks:

- `deno task test:load`
- `deno task bench`
- `bash scripts/codemode_launch_matrix.sh`

## Recommended pre-merge sequence

For backend-heavy changes:

```bash
deno fmt --check
deno lint
deno task check
deno task test
```

For UI changes, add:

```bash
deno task check-ui
deno task test-ui
deno task build-ui
```

For broad or release-facing changes, finish with:

```bash
deno task test:all
```
