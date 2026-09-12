# Identified Functionality, Capabilities & Purpose

This document is the code-traceable inventory of what Frosty Deno actually does
in the current repository state.

## Application purpose statement

Frosty Deno is a Deno-native gateway for LLM traffic and operations. It provides
one HTTP surface for many model providers, adds governance and metering,
optionally caches responses, aggregates MCP tools, exposes a same-origin
operator control plane, and stores durable configuration and counters in
PostgreSQL.

Primary observed use cases:

- Send chat, completion, embedding, image, audio, file, or batch requests
  through one gateway surface instead of integrating each provider separately.
- Govern inference traffic with virtual keys, rate limits, request budgets, cost
  budgets, team hierarchy, and pricing metadata.
- Operate providers, settings, cache, logs, runtime diagnostics, and MCP clients
  through the same-origin control UI and `/api/*` endpoints.
- Run tool-aware and agentic workloads through MCP and the `/v1/responses` loop.

## Capability map

| #  | Feature                          | Capability                                                                 | Purpose                                  | Primary Users                | Implementation Location                                                                       |
| -- | -------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| 1  | Chat completions                 | OpenAI-compatible chat completions with stream and non-stream modes        | Core inference routing                   | API clients                  | `apps/gateway/routes/inference.ts`, `packages/providers/src/*`                                |
| 2  | Legacy completions               | OpenAI legacy text completions                                             | Backward compatibility                   | API clients                  | `apps/gateway/routes/inference.ts`                                                            |
| 3  | Anthropic Messages compatibility | Anthropic-style message ingress and token counting                         | Protocol compatibility                   | API clients                  | `apps/gateway/routes/compat.ts`, `apps/gateway/routes/compat_families.ts`                     |
| 4  | Responses loop                   | Tool-aware `/v1/responses` execution path                                  | Agentic workflows                        | API clients, agents          | `apps/gateway/routes/inference.ts`, `packages/core/src/*`                                     |
| 5  | Model catalog                    | List configured models and provider-backed catalog data                    | Discover available models                | API clients, operators       | `apps/gateway/routes/inference.ts`, `apps/gateway/routes/catalog.ts`                          |
| 6  | Embeddings                       | Embedding generation across supporting providers                           | Search, ranking, semantic cache          | API clients                  | `apps/gateway/routes/advanced.ts`                                                             |
| 7  | Image generation                 | Image generation surface                                                   | Multimodal generation                    | API clients                  | `apps/gateway/routes/advanced.ts`, `packages/providers/src/imagen.ts`                         |
| 8  | Speech synthesis                 | Text-to-speech output                                                      | Audio generation                         | API clients                  | `apps/gateway/routes/advanced.ts`, `packages/providers/src/audio.ts`                          |
| 9  | Transcription                    | Speech-to-text ingestion                                                   | Audio understanding                      | API clients                  | `apps/gateway/routes/advanced.ts`, `packages/providers/src/audio.ts`                          |
| 10 | Files API                        | Provider-backed file create, list, fetch, and delete                       | File-oriented provider workflows         | API clients, operators       | `apps/gateway/routes/advanced.ts`, provider advanced adapters                                 |
| 11 | Batches API                      | Provider-backed batch job create, list, inspect, cancel, and fetch results | Long-running inference jobs              | API clients, operators       | `apps/gateway/routes/advanced.ts`, provider advanced adapters                                 |
| 12 | Provider management              | CRUD provider accounts, refresh models, inspect health                     | Operate upstream accounts                | Operators                    | `apps/gateway/routes/admin.ts`, `packages/contracts/src/config.ts`, control UI provider views |
| 13 | Gateway config import/export     | Export, import, reload, and view config                                    | Backup and restore operator state        | Operators                    | `apps/gateway/routes/admin.ts`, `packages/config/src/service.ts`                              |
| 14 | Virtual keys                     | Create governed machine credentials with budgets and scopes                | Traffic control and attribution          | Operators                    | `apps/gateway/routes/governance.ts`, `packages/governance/src/virtual_keys.ts`                |
| 15 | Team and customer hierarchy      | Roll budgets and usage up the governance chain                             | Multi-tenant spend and usage control     | Operators                    | `apps/gateway/routes/governance.ts`, `packages/governance/src/hierarchy.ts`                   |
| 16 | Pricing catalog and sync         | Persist pricing overrides and optional upstream sync                       | Cost accounting and budget evaluation    | Operators                    | `apps/gateway/routes/governance.ts`, `packages/governance/src/pricing.ts`, `pricing_sync.ts`  |
| 17 | Settings API                     | Persist and expose effective operator settings with provenance             | Runtime tuning and operator visibility   | Operators                    | `apps/gateway/routes/settings.ts`, `packages/contracts/src/settings.ts`                       |
| 18 | Response cache                   | Exact and semantic cache with clear operations                             | Lower cost and repeated-response latency | Operators, API clients       | `packages/cache/src/*`, `apps/gateway/routes/extensions.ts`                                   |
| 19 | Logs and analytics               | Live logs, stored logs, analytics rollups, metrics, runtime gauges         | Observability and auditing               | Operators                    | `apps/gateway/routes/logs.ts`, `analytics.ts`, `runtime.ts`, `packages/telemetry/src/*`       |
| 20 | MCP client aggregation           | Manage MCP clients, sync tools, expose health                              | Centralized tool integration             | Operators, agents            | `apps/gateway/routes/extensions.ts`, `packages/mcp/src/*`                                     |
| 21 | MCP server surface               | Serve the gateway as an MCP endpoint                                       | Tool-serving interoperability            | Agents, external MCP clients | `apps/gateway/routes/mcpserver.ts`                                                            |
| 22 | Code Mode                        | VFS metadata surface and gated run surface                                 | Tool-oriented code execution workflows   | Operators, agents            | `apps/gateway/routes/codemode.ts`, `packages/mcp/src/codemode/*`                              |
| 23 | Same-origin control plane        | React operator UI for the gateway surface                                  | Browser-based operations                 | Operators                    | `apps/control-ui/src/*`, served by `apps/gateway/main.ts`                                     |

## Functional domains

### Inference and compatibility

What it does:

- Accepts canonical and compatibility-route inference traffic and dispatches it
  to configured providers.

Why it exists:

- Lets clients talk to one gateway rather than many provider SDKs and HTTP
  contracts.

How it is implemented:

- Route registration in `inference.ts`, `compat.ts`, `compat_families.ts`,
  `azure_ingress.ts`, and `openrouter_ingress.ts`
- Provider adapters in `packages/providers/src/*`
- Canonical translation and stream handling in `packages/core/src/*`

Entry points:

- `/v1/*`, `/genai/*`, `/cohere/*`, `/openrouter/*`, `/openai/deployments/*`,
  and alias prefixes such as `/openai/*` and `/anthropic/*`

### Provider operations

What it does:

- Stores, redacts, reloads, and health-checks provider accounts.

Why it exists:

- Makes upstream-account management an operator concern rather than a code-edit
  concern.

How it is implemented:

- `packages/contracts/src/config.ts`
- `packages/config/src/service.ts`
- `apps/gateway/routes/admin.ts`
- provider-management screens in `apps/control-ui/src/views/ProvidersView.tsx`

Entry points:

- `/api/providers*`, `/api/config*`, `/api/proxy-config`

### Governance and pricing

What it does:

- Admits or denies requests, meters usage, and rolls spend up through a
  hierarchy.

Why it exists:

- Provides quota, attribution, and cost control for multi-tenant inference
  traffic.

How it is implemented:

- `VirtualKeyManager`, `GovernanceHierarchy`, `ProviderBudgetTracker`,
  `PricingCatalog`, `SharedRateLimiter`

Entry points:

- `/api/virtual-keys*`, `/api/teams*`, `/api/customers*`, `/api/pricing*`,
  governance middleware on inference routes

### Cache and invalidation

What it does:

- Returns cached responses when possible and keeps cache state coherent across
  processes.

Why it exists:

- Lowers repeated-request latency and upstream cost.

How it is implemented:

- `SemanticCache`, `PgCacheStore`, `PgVectorStore`, `InvalidationBus`

Entry points:

- cache use is implicit on eligible inference routes; cache clearing is exposed
  through `/api/cache*`

### MCP and Code Mode

What it does:

- Aggregates external MCP tools and exposes Frosty as an MCP server, with a
  separate Code Mode surface.

Why it exists:

- Supports tool-oriented agent workflows and structured execution paths.

How it is implemented:

- `packages/mcp/src/registry.ts`, `monitor.ts`, `codemode/*`

Entry points:

- `/api/mcp*`, `/mcp`, `/api/mcp/codemode/*`

### Observability and runtime diagnostics

What it does:

- Tracks logs, metrics, traces, analytics, runtime concurrency, and stored-log
  analytics.

Why it exists:

- Gives operators visibility into behavior, failures, and cost.

How it is implemented:

- `packages/telemetry/src/*`, `apps/gateway/routes/logs.ts`, `analytics.ts`,
  `runtime.ts`

Entry points:

- `/api/logs*`, `/api/analytics`, `/api/runtime`, `/metrics`

### Operator UI

What it does:

- Presents the provider, governance, settings, logs, dashboard, and runtime
  surfaces in a browser.

Why it exists:

- Keeps operator workflows on the same origin and the same data contract as the
  gateway.

How it is implemented:

- React views under `apps/control-ui/src/views/*` and reusable UI/domain
  components under `apps/control-ui/src/components/*`

Entry points:

- hash-routed UI views such as `#/providers`, `#/dashboard`, `#/logs`,
  `#/settings`, `#/virtual-keys`, `#/extensions`

## User roles and permissions matrix

The shipped code exposes operational identities rather than human user accounts.

| Role               | Capability                                             | Access Level |
| ------------------ | ------------------------------------------------------ | ------------ |
| Anonymous client   | `GET /healthz`, `GET /api/version`                     | Read         |
| Anonymous client   | Public inference routes without governance credentials | Write        |
| Virtual-key client | Governed inference routes with valid bearer key        | Write        |
| Virtual-key client | `/api/*` operator routes                               | None         |
| Virtual-key client | Stored logs and pricing administration                 | None         |
| Admin operator     | Provider CRUD and config import/export                 | Admin        |
| Admin operator     | Virtual-key, team, and customer administration         | Admin        |
| Admin operator     | Pricing, settings, and cache operations                | Admin        |
| Admin operator     | Runtime, logs, and analytics inspection                | Read         |
| Admin operator     | MCP client management and Code Mode inspection         | Admin        |
| MCP peer           | `/mcp` server surface                                  | Write        |

Assignment and enforcement:

- Admin capability is enforced by `adminAuthMiddleware` when
  `FROSTY_ADMIN_TOKEN` is configured.
- Virtual-key capability is enforced by governance middleware and
  `VirtualKeyManager` on inference routes.
- Team and customer chain enforcement is performed by `GovernanceHierarchy`.

## Feature traceability

| Feature                          | API endpoints                               | UI routes                          | Persistence                                                  | Test coverage                                                                                             |
| -------------------------------- | ------------------------------------------- | ---------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Chat completions                 | `/v1/chat/completions`                      | none direct                        | optional logs, counters, cache                               | `tests/contract/golden_chat_test.ts`, `tests/integration/*`                                               |
| Legacy completions               | `/v1/completions`                           | none direct                        | optional logs and counters                                   | covered by route and integration tests in gateway and compat suites                                       |
| Anthropic Messages compatibility | `/v1/messages`, `/v1/messages/count_tokens` | none direct                        | optional logs and counters                                   | `tests/integration/anthropic_ingress_test.ts`, streaming and contract suites                              |
| Responses loop                   | `/v1/responses`                             | none direct                        | optional logs and counters                                   | `tests/contract/responses_agent_test.ts`                                                                  |
| Embeddings                       | `/v1/embeddings`                            | none direct                        | optional logs and counters                                   | advanced API tests and integration suites                                                                 |
| Images                           | `/v1/images/generations`                    | none direct                        | optional logs and counters                                   | advanced API tests                                                                                        |
| Speech                           | `/v1/audio/speech`                          | none direct                        | optional logs and counters                                   | advanced API tests                                                                                        |
| Transcriptions                   | `/v1/audio/transcriptions`                  | none direct                        | optional logs and counters                                   | advanced API tests                                                                                        |
| Files                            | `/v1/files*`                                | none direct                        | provider-side file storage plus gateway logs/counters        | advanced API tests                                                                                        |
| Batches                          | `/v1/batches*`                              | none direct                        | provider-side batch state plus gateway logs/counters         | advanced API tests                                                                                        |
| Provider management              | `/api/providers*`, `/api/config*`           | `#/providers`, `#/settings/config` | `frosty.state` config keys                                   | `apps/gateway/routes/admin_test.ts`, `ProvidersView.test.tsx`, integration suites                         |
| Virtual keys                     | `/api/virtual-keys*`                        | `#/virtual-keys`                   | `frosty.state` plus `frosty.counters`                        | `packages/governance/src/virtual_keys_test.ts`, `VirtualKeysView.test.tsx`, governance integration suites |
| Teams and customers              | `/api/teams*`, `/api/customers*`            | `#/teams`, `#/customers`           | `frosty.state` plus `frosty.counters`                        | hierarchy and governance integration suites                                                               |
| Pricing                          | `/api/pricing*`                             | `#/pricing`                        | pricing records in durable state                             | pricing tests and integration suites                                                                      |
| Settings                         | `/api/settings`                             | `#/settings/*`                     | `['settings', <group>]` overrides in `frosty.state`          | `tests/contract/settings_contract_test.ts`, `SettingsView.test.tsx`, settings integration suites          |
| Cache                            | implicit on inference routes, `/api/cache*` | `#/settings/caching`               | `frosty.response_cache`, pgvector table, invalidation events | `tests/integration/cache_test.ts`, cache package tests                                                    |
| Logs and analytics               | `/api/logs*`, `/api/analytics`, `/metrics`  | `#/logs`, `#/dashboard`            | in-memory `LogBus`, optional stored logs, counters           | log, analytics, observability, and dashboard tests                                                        |
| Runtime diagnostics              | `/api/runtime`                              | `#/status`                         | in-memory gauges and state projections                       | `tests/integration/runtime_api_test.ts`, `StatusView.test.tsx`                                            |
| MCP management                   | `/api/mcp*`                                 | `#/extensions`                     | MCP client config in durable state                           | MCP integration suites and extensions UI paths                                                            |
| MCP server surface               | `/mcp`                                      | none direct                        | request handling only                                        | MCP transport and plugin integration suites                                                               |
| Code Mode                        | `/api/mcp/codemode/*`                       | settings-side Code Mode preview    | no independent durable store beyond config state             | Code Mode route and executor tests                                                                        |

No major capability reviewed here was found to be completely untested, but
coverage density varies. Provider-specific advanced capabilities rely heavily on
integration and route-level tests rather than UI tests.

## External integrations

| Integration                                                        | Purpose                                                               | Implementation location                                                   | Data exchanged                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| OpenAI API                                                         | Chat, embeddings, images, audio, files                                | `packages/providers/src/openai.ts` and related routes                     | prompts, messages, usage, media payloads              |
| Anthropic API                                                      | Messages, tool use, files, batches                                    | `packages/providers/src/anthropic*.ts`                                    | messages, tool calls, file and batch payloads         |
| Azure OpenAI                                                       | Azure deployment-scoped inference and advanced APIs                   | `packages/providers/src/azure.ts`, `apps/gateway/routes/azure_ingress.ts` | deployment-scoped requests and responses              |
| Gemini / Vertex                                                    | Google model access and Imagen support                                | `packages/providers/src/gemini*.ts`, `vertex.ts`                          | prompts, embeddings, image requests, auth data        |
| OpenRouter                                                         | OpenRouter-shaped ingress and provider access                         | `packages/providers/src/openai_compat.ts`, `openrouter_ingress.ts`        | chat and embeddings payloads                          |
| Bedrock and S3                                                     | Bedrock inference and file/batch support                              | `packages/providers/src/bedrock*.ts`, `s3.ts`, `sigv4.ts`                 | signed requests, file objects, batch payloads         |
| Cohere                                                             | Cohere-compatible chat ingress                                        | `packages/providers/src/cohere.ts`, `compat_families.ts`                  | chat payloads                                         |
| ElevenLabs                                                         | Text-to-speech                                                        | `packages/providers/src/elevenlabs.ts`                                    | text and audio data                                   |
| Hugging Face                                                       | model inference, images, embeddings, audio                            | `packages/providers/src/huggingface.ts`                                   | model and media payloads                              |
| Ollama                                                             | local provider support                                                | `packages/providers/src/openai_compat.ts` via LM-compatible setup         | local HTTP model payloads                             |
| Groq, Mistral, xAI, Perplexity, Cerebras, Nebius, SGLang, Parasail | additional provider-account types                                     | provider manager plus OpenAI-wire or dedicated adapters                   | standard inference payloads                           |
| Generic OpenAI-compatible endpoint                                 | arbitrary compatible upstream                                         | `packages/providers/src/openai_compat.ts`                                 | compatible OpenAI payloads                            |
| Generic Anthropic-compatible endpoint                              | arbitrary compatible upstream                                         | Anthropic compatibility path                                              | compatible Anthropic payloads                         |
| MCP servers                                                        | tool aggregation and remote tool calls                                | `packages/mcp/src/client.ts`, `registry.ts`                               | JSON-RPC requests, tool metadata, tool outputs        |
| PostgreSQL / pgvector                                              | durable state, counters, cache, embeddings, invalidation coordination | `packages/config/src/*`, `packages/cache/src/*`                           | config documents, counters, cached responses, vectors |
| LiteLLM price catalog                                              | optional pricing metadata sync                                        | `packages/governance/src/pricing_sync.ts`                                 | pricing JSON                                          |
| OTLP collector                                                     | optional tracing export                                               | `packages/telemetry/src/otel.ts`                                          | spans and span-derived metrics                        |

## Non-functional capabilities

Implemented cross-cutting capabilities:

- Exact and semantic caching
- Rate limiting and budget enforcement
- Multi-process clustering on supported platforms
- Durable and in-memory request logging
- Prometheus metrics and OTLP tracing
- Same-origin SPA serving
- Optional encryption at rest for persisted secrets
- Provider fallback and load-balancing policy
- Background health monitoring and configuration reconciliation

## Gaps and partial implementations

| Area                                               | Status                                        | Evidence                                             |
| -------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| OpenRouter native `GET /generation` and `GET /key` | Explicit 501                                  | `apps/gateway/routes/openrouter_ingress.ts`          |
| Aggregator-path Bedrock native ingress             | Explicit 501                                  | `apps/gateway/routes/compat_families.ts`             |
| Some provider-panel config fields                  | Persisted and surfaced but not fully enforced | field comments in `packages/contracts/src/config.ts` |
| Cache-hit streaming                                | Not implemented by design                     | cache package behavior and route flow                |
| Code Mode executor                                 | Gated and intentionally constrained           | `packages/mcp/src/codemode/*` and env defaults       |
| Kubernetes and Helm packaging                      | Not present in the repo                       | deployment assets are Docker and Compose only        |
