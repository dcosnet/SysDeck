# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What this is

Frosty Deno ("klanker-gate") is a clean-room Deno 2 + TypeScript rebuild of an
LLM gateway (reference: the retired Go implementation, Bifrost). One
`Deno.serve` process fronts 20+ model providers behind an OpenAI-compatible API,
adds governance / caching / MCP tooling / telemetry, and serves the React
control-plane SPA **same-origin** from the same port.

## Commands

Run everything from the repo root. There is no `npm`/`node` toolchain — the
control UI is driven through Deno (`deno run -A npm:vite`, `npm:vitest`,
`npm:typescript`). Do not reintroduce an npm CLI step.

```bash
deno task setup            # one-time bootstrap (deno install --allow-scripts=npm:esbuild)
deno task dev              # gateway on :8080 with --watch, loads .env
deno task start            # same without --watch

# The full gate - run it yourself; nothing runs it for you:
deno task test:all         # every stage below, in order, one verdict
                           # (+ live and browser stages; skips are reported, never silent)

# Or the same checks one at a time:
deno fmt --check
deno lint
deno task check            # backend typecheck (deno check)
deno task test             # unit + contract + integration + e2e (ignores control-ui, tests/browser, tests/live)
deno task check-ui         # control-ui tsc --noEmit
deno task test-ui          # control-ui vitest (jsdom)
deno task build-ui         # control-ui production build -> apps/control-ui/dist
```

Single test / filter — pass the same unstable flags the task does:

```bash
deno test --unstable-net --unstable-worker-options -A tests/integration/cache_test.ts
deno test --unstable-net -A --filter "fallback" packages/providers/
```

Other suites: `deno task test:e2e`, `deno task test:live` (drives
`docker compose up -d --wait postgres` itself, so it needs a running Docker
daemon), `deno task test:load` (`scripts/load-bench.ts`), `deno task bench` (23
micro-benchmarks in six `*_bench.ts` files colocated next to the source they
measure). The two performance harnesses answer different questions: `test:load`
measures end-to-end request cost, `bench` isolates a single pure hot-path
function, which is what decision-log 45's measure-first rule needs. Neither is
part of `test:all`; both are recorded in
[docs/benchmark-report.md](docs/benchmark-report.md) (decision-log 78).
`tests/browser/` is a Node/Playwright harness with its own `package.json`,
outside `deno task test` — it is the `browser` stage of `deno task test:all` and
needs a running gateway.

The `test` task carries `--ignore=apps/control-ui,tests/browser,tests/live`.
`--ignore` _replaces_ the `test.exclude` list in `deno.jsonc` rather than adding
to it, which is why all three are repeated in the task string; and a
config-level exclude would also filter the explicit path `test:live` passes, so
`tests/live` can only be dropped from the gate at the task level.

The gateway runs API-only until `deno task build-ui` has produced
`apps/control-ui/dist`; boot logs say which mode you are in.

## Architecture

Read
[docs/concepts/architectural-overview.md](docs/concepts/architectural-overview.md)
for the full picture with diagrams. The parts that matter before you edit:

**OpenAI's wire format is the lingua franca.** Internally every response is a
canonical `chat.completion` / `chat.completion.chunk` SSE stream ending in
`data: [DONE]`. Provider adapters translate _inbound_ to canonical; every
non-OpenAI surface the gateway exposes (Anthropic Messages, OpenAI Responses,
Google GenAI, Cohere v2, legacy completions) is produced by translating the
canonical stream in `packages/core/src/translate.ts` — never by a second
parallel pipeline per vendor. This is what keeps provider count × surface count
from multiplying.

**The middleware onion order in [apps/gateway/main.ts](apps/gateway/main.ts) is
load-bearing.** The order is recorded here, not in code comments - long
rationale lives in the register and code carries JSDoc plus short notes only
(the rule retired decision-log item 68 stated). Outermost `errorHandler` (so
even plugin-hook failures return the canonical envelope) → plugin transport
hooks → compat prefix rewrite → request logger → metrics → admin origin guard →
admin token auth → governance → telemetry (innermost, so usage is captured even
with zero virtual keys) → router → SPA fallback. Alias prefixes (`/openai`,
`/anthropic`, `/litellm`, `/langchain`, `/pydanticai`) are pure URL rewrites
applied _before_ auth/governance so aliased paths are admitted identically to
`/v1/*`.

**`AppContext` ([apps/gateway/context.ts](apps/gateway/context.ts)) is the
composition root.** `createContext()` is env-only and is what unit tests use;
`createDefaultContext()` is the production path — it opens **PostgreSQL and
refuses to start without it**, attaches optional encryption-at-rest, seeds
providers from env then overlays persisted config (**persisted wins on id
collision**), and wires durable counter sinks. Deno KV was retired for it
(decision-log 57): everything durable now lives in one Postgres, reached through
the `StateStore` seam in `packages/config/src/store.ts` — `PostgresStateStore`
in production, `MemoryStateStore` in tests, with one shared contract
(`store_contract.ts`) run against both so they cannot drift. Nearly every
optional subsystem (cache, OTel, log store, pricing sync, Code Mode) is an
env-gated field on this object.

**Package layout.** `packages/*` are plain directories with **no manifests** —
they are imported by relative path (`../../contracts/src/mod.ts`), not by a
workspace alias. Only `apps/control-ui` is a Deno workspace member. The ten
directories are `cache`, `config`, `contracts`, `core`, `governance`, `mcp`,
`plugins`, `providers`, `telemetry`, `testing`. Only `contracts`, `core`,
`providers`, and `testing` have `src/mod.ts` barrels; the rest are imported
file-by-file. Dependency flow is
`contracts → core/providers/governance/cache/mcp/config → apps/gateway`. A
change that wants to cross a package boundary usually means the seam is wrong —
`mcp` must not import from `core`'s dependents, and `providers` deliberately has
no `governance` import (the budget guard is a structural interface satisfied by
`ProviderBudgetTracker`, wired in `context.ts`).

**Providers.** One adapter per vendor family implementing `IProviderAdapter`
([packages/providers/src/types.ts](packages/providers/src/types.ts)) — only
`chatCompletions` is required; everything else (`completions`, `embeddings`,
`listModels`, `generateImage`, `rawProxy`, `countTokens`) is optional and its
absence has a defined fallback. `ProviderManager.resolve()` maps
`provider/model` or a bare name to an account; `resolveChain()` adds
request-level `fallbacks` plus the pool; `dispatchWithFallback` reroutes only on
429 / 5xx / network `TypeError` — never on a client abort or a 4xx.

**Streaming** is Web Streams end to end. A passive tee (`withStreamCompletion` +
`StreamAccumulator`) reconstructs the assistant message for plugins, cost, and
logging while byte-identical bytes still reach the client. Never buffer a client
stream to inspect it. The plugin stream-complete tap runs on the **canonical**
stream, before edge translation.

## Conventions that will bite you

- **Errors** always go through `GatewayError` / `errorResponse` and the
  canonical `{error:{message,type,param,code}}` envelope. No ad-hoc JSON error
  bodies.
- **Request schemas are `.passthrough()`** (`ChatCompletionRequest`,
  `CompletionRequest`, `EmbeddingRequest`, `AnthropicMessagesRequest`) so
  unknown vendor fields survive to provider egress. Do not "tidy" this into
  `.strict()`. Everything else uses bare `z.object()`, which _strips_ unknown
  keys rather than rejecting them. The two `.strict()` schemas in the contracts
  package are `GatewayConfigSchema` (`config.ts`) and `ModelPriceSchema`
  (`pricing.ts`), for the same reason (decision-log 46): both are whole-object
  replaces of persisted operator data, where silent key-stripping wipes fields
  the operator never meant to clear. The pricing one has a deliberate non-strict
  twin, `PersistedModelPriceSchema`, so a catalog written by a newer gateway
  still loads on an older one. Two response families are deliberately
  `.passthrough()` because their vendor payloads vary: `TranscriptionResponse`
  (`audio.ts`) and the file/batch family (`file_batch.ts`).
- **Money is integer micro-USD** everywhere in accounting. No floating-point
  accumulation.
- **Fail closed.** Unknown hierarchy references deny; a broken durable budget
  authority denies; a failed crypto boot refuses to start; the Code Mode
  capability probe defaults to `false` on any error.
- **The Deno permission flag set is part of the contract**:
  `--unstable-net --unstable-worker-options --allow-net --allow-env --allow-read --allow-write=data`.
  Needing more is a design escalation — see [permissions.md](permissions.md).
  `--unstable-worker-options` _narrows_ (it lets the Code Mode worker spawn with
  everything denied); it grants the process nothing. `--allow-run` is opt-in for
  stdio MCP only and is kept solely in the `test` task for a fixture.
- **Secrets never reach the browser.** The admin API returns redacted views with
  `hasX` presence markers. Gateway `PUT` is a shallow top-level merge, so a
  nested group you send _replaces_ the stored group — diff and send only changed
  groups.
- **Code Mode is default-off** (`FROSTY_CODE_MODE`) behind two independent
  gates. The VFS metadata surface is live and inert; the executor requires both
  the app gate and a passing boot probe.
- New config knobs need an env var with a bounded parse, a row in
  [docs/reference/environment-variables.md](docs/reference/environment-variables.md),
  and `.env.example` coverage.
- **Comments are JSDoc plus short notes.** Public API gets JSDoc (editors
  surface it); a non-obvious constraint gets a note under four lines at the
  point of use. Long rationale goes in [TODO.md](TODO.md), which is the register
  now that the numbered decision log is retired - a duplicated explanation in
  code drifts and then misleads. Cite it by **stable key**
  (`TODO.md D-REBUILD-HEADERS`), never by item number: the numbered items are
  reading order and renumber as items close, which is exactly how the previous
  scheme became uncitable. Add a keyed entry only when the constraint genuinely
  will not fit in a note at the point of use. Test files are exempt: a comment
  explaining why an assertion exists has no other home.
- Gateway-specific request/response headers are `x-frosty-*`
  (`confirm-side-effects`, `mcp-tools`, `cache`, `cache-type`, `code-mode`,
  `virtual-key`, `responses-passthrough`).

## Before you change behavior

The numbered decision log that recorded every deliberate divergence from the Go
original was **retired on 2026-07-30**; [TODO.md](TODO.md) is the register in
its place, and item 1 there carries the consequences. Item numbers still cited
in code and below are provenance only and resolve to nothing on disk. Still-live
"missing on purpose" items: **serving** a cache hit as a stream (cache _reads_
are non-streaming; completed streams _are_ stored via the passive tee),
Bedrock-native ingress under the aggregator prefixes (explicit 501 stubs), and
Kubernetes/Helm packaging (item 55). Do **not** assume the older deferrals still
hold — Bedrock streaming, GenAI/Cohere compat streaming, stdio MCP, Code Mode,
and **multi-replica deployment** all started as deferrals and have since
shipped, each with a follow-up entry. Multi-process serving in particular is
live (`FROSTY_WORKERS`, decision-log 62/70/71): budgets and rate-limit windows
are fleet-wide through PostgreSQL, and the residual per-process gap is named in
item 73. Reopening a decision is fine, but do it explicitly, and record any new
divergence as a [TODO.md](TODO.md) item with its mechanism, evidence, "done
means" and reopen trigger.

Definition of done per
[docs/guides/development-planning.md](docs/guides/development-planning.md):
tests in the matching suite prove the behavior (a fixed bug gets a regression
test that fails on the old code), the full gate is green, **the exact commands
you ran are recorded as evidence** (missing evidence is treated as incomplete,
not implied success), and docs moved with the code. Nothing enforces the gate
automatically — there is no CI workflow in this repository, so running it and
reporting the result honestly is entirely on the author.

Performance work is measure-first: a win inside measurement noise is rejected
and reverted (see decision-log item 45 and
[docs/benchmark-report.md](docs/benchmark-report.md)).

## Control UI

[apps/control-ui/CONVENTIONS.md](apps/control-ui/CONVENTIONS.md) is the binding
contract for the SPA — design system `ds-r2`, tokens in `src/styles/tokens.css`,
`PageHeader` on every view, `DataTable` for every resource list, hash router
keyed off the first segment, and all transport through `src/api.ts` (no `fetch`
in views). Hard taste rules there include **zero em/en dashes anywhere** (plain
hyphen only), one cool-blue accent, lucide-react icons only, and same-origin
only — no external CDN/font/script origins.

## Related

`AGENTS.md` holds the shorter agent-facing brief. `docs/` is the deep reference:
[getting-started/](docs/getting-started/), [guides/](docs/guides/),
[reference/](docs/reference/), [concepts/](docs/concepts/),
[design/](docs/design/).

Four pages carry more ground truth than the rest and are worth reading before a
non-trivial change:

- [docs/concepts/functionality-and-capabilities.md](docs/concepts/functionality-and-capabilities.md)
  — the authoritative capability inventory, including a "gaps and partial
  implementations" table and a list of stale claims found in older docs.
- [TODO.md](TODO.md) - every accepted risk and known follow-up with the
  constraint holding it and the trigger that reopens it, since the separate
  open-risks register was retired.
- [docs/reference/sbom.md](docs/reference/sbom.md) plus
  [sbom.cyclonedx.json](docs/reference/sbom/sbom.cyclonedx.json) — the
  component-level bill of materials.
- [docs/assets/diagrams/](docs/assets/diagrams/) — the canonical
  `logic-flow.svg`, `data-flow.svg`, `resource-flow.svg`.
