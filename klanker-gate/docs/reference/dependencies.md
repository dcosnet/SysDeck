# Package Dependencies Reference

This project is Deno-first. It does not define Python runtime dependencies and
it does not use an npm CLI workflow for the main gateway or control UI. npm
packages are resolved through Deno and pinned in `deno.lock`.

For the complete component inventory, including all transitive packages and
container images, see [sbom.md](./sbom.md).

## Backend dependencies (Deno / JSR / npm)

### Core runtime dependencies

| Package     | Version | Purpose                                                               | Documentation Link                   |
| ----------- | ------- | --------------------------------------------------------------------- | ------------------------------------ |
| `@std/http` | `1.1.2` | Static-file serving and HTTP helpers used by the gateway              | https://jsr.io/@std/http             |
| `@std/path` | `1.1.6` | Path and file-URL handling, including UI bundle discovery             | https://jsr.io/@std/path             |
| `zod`       | `4.4.3` | Shared request, response, config, and settings validation             | https://zod.dev                      |
| `postgres`  | `3.4.9` | PostgreSQL client for durable state, counters, logs, and cache tables | https://github.com/porsager/postgres |

### Development and test dependencies

| Package       | Version  | Purpose                               | Documentation Link         |
| ------------- | -------- | ------------------------------------- | -------------------------- |
| `@std/assert` | `1.0.19` | Assertions across the Deno test suite | https://jsr.io/@std/assert |

## Frontend dependencies (npm via Deno)

### Runtime dependencies

| Package          | Version  | Purpose                                                 | Documentation Link                        |
| ---------------- | -------- | ------------------------------------------------------- | ----------------------------------------- |
| `react`          | `19.2.8` | Control-plane UI rendering                              | https://react.dev                         |
| `react-dom`      | `19.2.8` | React DOM renderer                                      | https://react.dev/reference/react-dom     |
| `lucide-react`   | `1.25.0` | Icon set used across the UI                             | https://lucide.dev                        |
| `clsx`           | `2.1.1`  | Conditional class composition                           | https://github.com/lukeed/clsx            |
| `tailwind-merge` | `3.6.0`  | Tailwind class conflict resolution in component helpers | https://github.com/dcastil/tailwind-merge |

### Development dependencies

| Package                       | Version   | Purpose                                                           | Documentation Link                                           |
| ----------------------------- | --------- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `tailwindcss`                 | `4.3.3`   | Token-driven utility CSS engine                                   | https://tailwindcss.com                                      |
| `@tailwindcss/vite`           | `4.3.3`   | Tailwind Vite integration                                         | https://tailwindcss.com/docs/installation/using-vite         |
| `vite`                        | `8.1.5`   | UI dev server and build tool                                      | https://vite.dev                                             |
| `@vitejs/plugin-react`        | `6.0.4`   | React integration for Vite                                        | https://github.com/vitejs/vite-plugin-react                  |
| `typescript`                  | `7.0.2`   | UI type checking and build-time compilation                       | https://www.typescriptlang.org                               |
| `vitest`                      | `4.1.10`  | UI unit test runner                                               | https://vitest.dev                                           |
| `jsdom`                       | `29.1.1`  | DOM environment for UI tests                                      | https://github.com/jsdom/jsdom                               |
| `@testing-library/react`      | `16.3.2`  | React component testing utilities                                 | https://testing-library.com/docs/react-testing-library/intro |
| `@testing-library/user-event` | `14.6.1`  | High-level user interaction helpers for tests                     | https://testing-library.com/docs/user-event/intro            |
| `@testing-library/jest-dom`   | `7.0.0`   | Extended DOM assertions for tests                                 | https://github.com/testing-library/jest-dom                  |
| `@types/react`                | `19.2.17` | React type definitions                                            | https://www.npmjs.com/package/@types/react                   |
| `@types/react-dom`            | `19.2.3`  | React DOM type definitions                                        | https://www.npmjs.com/package/@types/react-dom               |
| `zod`                         | `4.4.3`   | Shared schema work inside the UI toolchain as well as the gateway | https://zod.dev                                              |

### Browser harness dependency

| Package            | Version Source                                        | Purpose                                         | Documentation Link     |
| ------------------ | ----------------------------------------------------- | ----------------------------------------------- | ---------------------- |
| `@playwright/test` | Declared as `^1.45.0` in `tests/browser/package.json` | Browser smoke testing against a running gateway | https://playwright.dev |

The browser harness does not ship its own lockfile in this repository, so the
declared range is the only version information available from checked-in
manifests.

## Version compatibility matrix

| Surface           | Verified version source                   | Notes                                                 |
| ----------------- | ----------------------------------------- | ----------------------------------------------------- |
| Deno runtime      | `2.9.x` comments and pinned Docker images | The runtime image and build stage both pin Deno 2.9.3 |
| TypeScript        | `7.0.2`                                   | Used through Deno task commands for the UI            |
| React             | `19.2.8`                                  | Pinned in the lockfile                                |
| Vite              | `8.1.5`                                   | Pinned in the lockfile                                |
| PostgreSQL client | `3.4.9`                                   | Pinned in the lockfile                                |
| Tailwind CSS      | `4.3.3`                                   | Pinned in the lockfile                                |

Known compatibility constraints derived from the repo:

- The main project intentionally does not use an npm CLI step.
- `tests/browser` is a separate Node-based harness and expects `npx` on `PATH`.
- Docker Compose comments require Compose v2.20+ because the root file uses
  `include:`.

## Dependency update guidelines

- Regenerate the lockfile-backed artifacts after any dependency change. At
  minimum rerun `deno task check`, `deno task test`, `deno task check-ui`,
  `deno task test-ui`, and `deno task build-ui`.
- Regenerate the SBOM with `deno run -A scripts/generate_sbom.ts` after
  dependency updates.
- Review `docs/reference/sbom.md` for new direct or transitive components before
  release.
- Treat changes to Docker image tags as dependency updates and recheck the
  observability and PostgreSQL profiles.
- For the browser harness, update `tests/browser/package.json` and then rerun
  `npm audit --prefix tests/browser` because it is the only part of the repo
  that still depends on a Node-native test command.
