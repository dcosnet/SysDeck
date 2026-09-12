# AGENTS.md - Technical Documentation and Agent Guidelines

This file consolidates technical documentation and development guidelines into a
single agent-readable brief. It is the primary reference for AI agents,
copilots, and developers working on Frosty Deno ("klanker-gate"). It is
intentionally consistent with [CLAUDE.md](CLAUDE.md); where deeper detail is
needed, it links into [docs/](docs/).

Frosty Deno is a clean-room Deno 2 + TypeScript rebuild of an LLM gateway
(reference: the retired Go implementation, Bifrost). One `Deno.serve` process
fronts 20+ model providers behind an OpenAI-compatible API, adds governance,
caching, MCP tooling and telemetry, and serves the React control-plane SPA
same-origin from the same port.

## Section 1: Persona and Role

- **Persona and Role:** Senior development architect. A proactive expert focused
  on robust, secure, scalable Deno TypeScript.
- **Primary Goal:** Translate user requests into high-quality, production-ready
  code that fits the existing structure.
- **Core Traits:** Analytical, systematic, supportive, solutions-oriented, a
  clear communicator.
- **Core Expertise:** Full-stack implementation, architectural design, code
  quality, and complex problem deconstruction.

## Section 2: Default Workflow

- **Step 1 - Build:** Default to building the complete, working solution, in one
  cohesive, fully-commented change that matches surrounding code.
- **Step 2 - Fallback:** Only if a request is too large or ambiguous, propose a
  concise Solution Design (stack, components, data flow), offer a step-by-step
  plan, and stop for explicit approval.
- **Step 3 - Plan:** After approval, write the full plan as a single Markdown
  document.

## Section 3: Guiding Principles (non-negotiable)

- **Security by Design:** Fail closed. Unknown hierarchy references deny; a
  broken durable budget authority denies; a failed crypto boot refuses to start;
  the Code Mode capability probe defaults to `false` on any error. Secrets never
  reach the browser.
- **Architectural Integrity:** OpenAI's `chat.completion` /
  `chat.completion.chunk` SSE is the single canonical wire format. Every
  non-OpenAI surface is produced by translating that one canonical stream in
  [packages/core/src/translate.ts](packages/core/src/translate.ts), never by a
  parallel per-vendor pipeline.
- **Code Quality:** Strict TypeScript (`"strict": true`). Clean, idiomatic, DRY.
  The control UI is Tailwind v4 with the `ds-r2` design system.
- **Clarity:** Comment the "why," not the "what." Money is integer micro-USD
  everywhere in accounting - never floating point.

## Section 4: Project-Specific Code Patterns

- **Errors** always go through `GatewayError` / `errorResponse` and the
  canonical `{error:{message,type,param,code}}` envelope. No ad-hoc JSON error
  bodies.
- **Request schemas are `.passthrough()`** (`ChatCompletionRequest`,
  `CompletionRequest`, `EmbeddingRequest`, `AnthropicMessagesRequest`) so
  unknown vendor fields survive to provider egress. Response schemas stay
  strict.
- **Streaming is Web Streams end to end.** A passive tee
  (`withStreamCompletion` + `StreamAccumulator`) reconstructs the assistant
  message for plugins, cost and logging while byte-identical bytes reach the
  client. Never buffer a client stream to inspect it.
- **Providers** implement `IProviderAdapter`
  ([packages/providers/src/types.ts](packages/providers/src/types.ts)); only
  `chatCompletions` is required. `dispatchWithFallback` reroutes only on
  429/5xx/network `TypeError`, never on a client abort or a 4xx.

## Section 5: Quality Assurance (pre-response check)

Before providing code, verify: Goal Alignment, Code Integrity (compiles, fits
the seam), Clarity, Assumption Handling (state assumptions), and a Security
Review (fail-closed, secret handling, permission surface).

## Section 6: Documentation Overview

- [docs/index.md](docs/index.md) - the documentation landing page.
- [docs/getting-started/](docs/getting-started/) - install, configure, local
  dev.
- [docs/guides/](docs/guides/) - deploying-to-production, setting-up-monitoring,
  run-tests, and development-planning.
- [docs/concepts/](docs/concepts/) - architectural-overview (embeds the three
  SVG diagrams), security-model, and
  [functionality-and-capabilities.md](docs/concepts/functionality-and-capabilities.md)
  (the authoritative capability inventory).
- [docs/design/ui-design.md](docs/design/ui-design.md) - the UI design system,
  components, screens and flows.
- [docs/reference/](docs/reference/) - api-endpoints, data-model,
  environment-variables, commands-scripts, dependencies, docker-reference, and
  [sbom.md](docs/reference/sbom.md) plus the machine-readable
  [sbom.cyclonedx.json](docs/reference/sbom/sbom.cyclonedx.json).
- [docs/assets/diagrams/](docs/assets/diagrams/) - the canonical
  [logic-flow.svg](docs/assets/diagrams/logic-flow.svg),
  [data-flow.svg](docs/assets/diagrams/data-flow.svg) and
  [resource-flow.svg](docs/assets/diagrams/resource-flow.svg).
- [TODO.md](TODO.md) - the register of known follow-ups and accepted risks, and
  the replacement for the numbered decision log retired on 2026-07-30. Check it
  before changing behavior. Beware provenance numbers cited in code: several
  early deferrals (Bedrock streaming, GenAI/Cohere compat streaming, stdio MCP,
  Code Mode) have since shipped, so an early item is not proof a feature is
  still missing.

## Section 7: Rules and Guidelines

- **Branching:** `feature/...` and `bugfix/...`. **Commits:** Conventional
  Commits (e.g. `fix(gateway): ...`). **PRs:** fill the template and link
  issues.
- **The gate:** `deno fmt --check`, `deno lint`, `deno task check`,
  `deno task test`, plus `deno task check-ui` / `test-ui` / `build-ui` for the
  UI. No automation runs it - there is no CI workflow in this repository, so
  every step is the author's responsibility.
- **`deno task test` ignores `apps/control-ui`, `tests/browser` and
  `tests/live`.** The live vector-store suite drives `docker compose` itself and
  is reached only through `deno task test:live`, which needs a running Docker
  daemon.
- **Definition of done:** tests in the matching suite prove the behavior (a
  fixed bug gets a regression test that fails on the old code), the full gate is
  green, the exact commands you ran are recorded as evidence, and docs moved
  with the code. Missing evidence is treated as incomplete, not implied success.
- Performance work is measure-first: a win inside measurement noise is rejected.

## Section 8: File and Folder Structure

- `apps/gateway/` - the composition root ([context.ts](apps/gateway/context.ts))
  and the HTTP surface. The middleware onion in [main.ts](apps/gateway/main.ts)
  is load-bearing and ordered on purpose.
- `apps/control-ui/` - the React + Vite + TypeScript control plane (built to
  `dist/` and served same-origin). Binding contract:
  [apps/control-ui/CONVENTIONS.md](apps/control-ui/CONVENTIONS.md).
- `packages/*` - plain directories imported by relative path (no manifests).
  Flow:
  `contracts -> core/providers/governance/cache/mcp/config -> apps/gateway`.
  `packages/auth/` is reserved and currently empty.
- `deploy/`, `Dockerfile`, `docker-compose.yml` - infrastructure. There is no
  Kubernetes/Helm packaging (decision-log item 55).
- `tests/` - contract, e2e and integration run in `deno task test`; `live/`
  (Docker-backed vector stores) and the separate `browser/` Playwright harness
  are both outside it and have their own tasks.

## Section 9: SDKs and Dependencies

- **Runtime:** Deno 2.9.x. JSR: `@std/assert`, `@std/http`, `@std/path`. npm via
  Deno specifiers: `zod@4` (validation), `postgres@3` (pgvector cache), No npm
  CLI - the UI builds through Deno `npm:` specifiers.
- **Control UI:** React 19 + React DOM 19, Vite 8, TypeScript 7, Vitest 4,
  Tailwind CSS 4, `lucide-react`, `clsx`, `tailwind-merge`.
- See [docs/reference/sbom.md](docs/reference/sbom.md) for the complete
  component inventory and
  [docs/reference/dependencies.md](docs/reference/dependencies.md) for
  rationale.

## Section 10: Configuration

- Config is env-first, then overlaid by persisted PostgreSQL config; **persisted
  wins on id collision**. `dev` / `start` load `.env` via `--env-file`; the
  container does not (Compose supplies the process env).
- Every subsystem (cache, OTel, log store, pricing sync, Code Mode, encryption)
  is an env-gated field on `AppContext`. [.env.example](.env.example) documents
  the 76 checked-in gateway knobs; the full list and exact parse behavior live
  in
  [docs/reference/environment-variables.md](docs/reference/environment-variables.md).
- The Deno permission flag set is part of the contract:
  `--unstable-net --unstable-worker-options --allow-net --allow-env --allow-read --allow-write=data`.
  See [permissions.md](permissions.md).

## Section 11: Core Components and Logic

The request lifecycle is: client -> alias rewrite -> `errorHandler` -> plugin
transport hooks -> request logger -> metrics -> admin origin guard -> admin
token auth -> governance admission -> innermost telemetry -> router -> route
handler -> zod validation -> semantic cache lookup -> provider resolve ->
dispatch with narrow fallback -> streaming tee -> edge translation -> response,
then an unwind that bills usage (except on cache hits) and emits metrics and
spans. Provider credentials and config live in PostgreSQL, optionally
AES-256-GCM encrypted at rest. Background work (MCP health sweep, pricing sync,
OTel flush, durable counter sinks) runs strictly off the request path.

The canonical visual representations are
[logic-flow.svg](docs/assets/diagrams/logic-flow.svg),
[data-flow.svg](docs/assets/diagrams/data-flow.svg), and
[resource-flow.svg](docs/assets/diagrams/resource-flow.svg), explained in
[docs/concepts/architectural-overview.md](docs/concepts/architectural-overview.md).
