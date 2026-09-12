# API Endpoints Reference

This reference lists the HTTP surfaces implemented in the gateway as of the
current code review. It is derived from `apps/gateway/main.ts` and the
registered route files under `apps/gateway/routes/`.

## Conventions

- Public inference routes are served from the same origin as the control UI.
- `/api/*` routes are operator surfaces. If `FROSTY_ADMIN_TOKEN` is set, they
  require `Authorization: Bearer <token>`.
- Errors use the canonical envelope
  `{ "error": { "message", "type", "param", "code" } }` through the shared error
  helpers.
- Compatibility prefixes are rewritten before auth and governance. Verified
  aggregator prefixes include `/openai`, `/anthropic`, `/litellm`, `/langchain`,
  and `/pydanticai`.

## Health and metadata

| Method | Path           | Purpose                                  | Source                              |
| ------ | -------------- | ---------------------------------------- | ----------------------------------- |
| `GET`  | `/healthz`     | Liveness and version check               | `apps/gateway/main.ts`              |
| `GET`  | `/api/version` | Gateway version and Deno runtime version | `apps/gateway/main.ts`              |
| `GET`  | `/metrics`     | Prometheus metrics exposition            | `apps/gateway/routes/governance.ts` |

## Core inference

| Method | Path                        | Purpose                                 | Source                             |
| ------ | --------------------------- | --------------------------------------- | ---------------------------------- |
| `GET`  | `/v1/models`                | List configured model catalog           | `apps/gateway/routes/inference.ts` |
| `POST` | `/v1/chat/completions`      | Canonical chat-completion surface       | `apps/gateway/routes/inference.ts` |
| `POST` | `/v1/completions`           | Legacy text-completion surface          | `apps/gateway/routes/inference.ts` |
| `POST` | `/v1/count_tokens`          | Token counting on the canonical surface | `apps/gateway/routes/inference.ts` |
| `POST` | `/v1/responses`             | Agentic response loop with tool support | `apps/gateway/routes/inference.ts` |
| `POST` | `/v1/messages/count_tokens` | Anthropic-style token counting          | `apps/gateway/routes/compat.ts`    |
| `POST` | `/v1/messages`              | Anthropic Messages-compatible ingress   | `apps/gateway/routes/compat.ts`    |

## Advanced APIs

| Method   | Path                       | Purpose                                 | Source                            |
| -------- | -------------------------- | --------------------------------------- | --------------------------------- |
| `POST`   | `/v1/embeddings`           | Embedding generation                    | `apps/gateway/routes/advanced.ts` |
| `POST`   | `/v1/images/generations`   | Image generation                        | `apps/gateway/routes/advanced.ts` |
| `POST`   | `/v1/audio/speech`         | Text-to-speech                          | `apps/gateway/routes/advanced.ts` |
| `POST`   | `/v1/audio/transcriptions` | Speech-to-text / transcription          | `apps/gateway/routes/advanced.ts` |
| `POST`   | `/v1/files`                | Create or upload a provider-backed file | `apps/gateway/routes/advanced.ts` |
| `GET`    | `/v1/files`                | List provider-backed files              | `apps/gateway/routes/advanced.ts` |
| `GET`    | `/v1/files/:id`            | Retrieve file metadata                  | `apps/gateway/routes/advanced.ts` |
| `GET`    | `/v1/files/:id/content`    | Retrieve file content                   | `apps/gateway/routes/advanced.ts` |
| `DELETE` | `/v1/files/:id`            | Delete a provider-backed file           | `apps/gateway/routes/advanced.ts` |
| `POST`   | `/v1/batches`              | Create a provider-backed batch job      | `apps/gateway/routes/advanced.ts` |
| `GET`    | `/v1/batches`              | List batch jobs                         | `apps/gateway/routes/advanced.ts` |
| `GET`    | `/v1/batches/:id`          | Inspect one batch job                   | `apps/gateway/routes/advanced.ts` |
| `GET`    | `/v1/batches/:id/results`  | Fetch batch results                     | `apps/gateway/routes/advanced.ts` |
| `POST`   | `/v1/batches/:id/cancel`   | Cancel a batch job                      | `apps/gateway/routes/advanced.ts` |

## Compatibility and ingress surfaces

### Native or vendor-shaped ingress

| Method | Path                                               | Purpose                                    | Notes                                       |
| ------ | -------------------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| `POST` | `/genai/v1beta/models/:modelAction`                | Google GenAI-compatible ingress            | `apps/gateway/routes/compat_families.ts`    |
| `POST` | `/cohere/v2/chat`                                  | Cohere v2-compatible ingress               | `apps/gateway/routes/compat_families.ts`    |
| `POST` | `/openrouter/v1/chat/completions`                  | OpenRouter-shaped chat ingress             | `apps/gateway/routes/openrouter_ingress.ts` |
| `POST` | `/openrouter/v1/embeddings`                        | OpenRouter-shaped embeddings ingress       | `apps/gateway/routes/openrouter_ingress.ts` |
| `GET`  | `/openrouter/v1/models`                            | OpenRouter-shaped model listing            | `apps/gateway/routes/openrouter_ingress.ts` |
| `POST` | `/openai/deployments/:deployment/chat/completions` | Azure deployment-scoped chat ingress       | `apps/gateway/routes/azure_ingress.ts`      |
| `POST` | `/openai/deployments/:deployment/completions`      | Azure deployment-scoped legacy completions | `apps/gateway/routes/azure_ingress.ts`      |
| `POST` | `/openai/deployments/:deployment/embeddings`       | Azure deployment-scoped embeddings         | `apps/gateway/routes/azure_ingress.ts`      |

### Rewritten alias families

| Prefix or shape | Effective target                                         | Notes                                                            |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| `/openai/*`     | Canonical `/v1/*` surface                                | `/openai/deployments/*` is excluded and handled by Azure ingress |
| `/anthropic/*`  | Canonical `/v1/*` surface with dialect-aware translation | `apps/gateway/routes/compat_families.ts`                         |
| `/litellm/*`    | Aggregator alias family                                  | Rewrites before auth and governance                              |
| `/langchain/*`  | Aggregator alias family                                  | Rewrites before auth and governance                              |
| `/pydanticai/*` | Aggregator alias family                                  | Rewrites before auth and governance                              |

### Implemented 501 or intentionally deferred compatibility endpoints

| Method | Path                        | Behavior                                                        | Source                                      |
| ------ | --------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| `GET`  | `/openrouter/v1/generation` | Returns 501; Frosty keeps its own cost accounting               | `apps/gateway/routes/openrouter_ingress.ts` |
| `GET`  | `/openrouter/v1/key`        | Returns 501; Frosty does not proxy OpenRouter key introspection | `apps/gateway/routes/openrouter_ingress.ts` |
| `POST` | `/:agg(litellm              | langchain                                                       | pydanticai)/bedrock/:rest*`                 |
| `POST` | `/:agg(litellm              | langchain                                                       | pydanticai)/model/:rest*`                   |

## Operator API

### Providers and config

| Method   | Path                                  | Purpose                                        |
| -------- | ------------------------------------- | ---------------------------------------------- |
| `GET`    | `/api/providers`                      | List configured providers in browser-safe form |
| `POST`   | `/api/providers`                      | Create a provider account                      |
| `PUT`    | `/api/providers/:id`                  | Update a provider account                      |
| `DELETE` | `/api/providers/:id`                  | Delete a provider account                      |
| `POST`   | `/api/providers/:id/refresh-models`   | Refresh provider model list                    |
| `GET`    | `/api/providers/:id/available-models` | List provider models live (read-only)          |
| `GET`    | `/api/providers/health`               | Report provider health                         |
| `GET`    | `/api/config`                         | Fetch gateway config view                      |
| `PUT`    | `/api/config`                         | Persist gateway config updates                 |
| `GET`    | `/api/proxy-config`                   | Read gateway-wide proxy config                 |
| `PUT`    | `/api/proxy-config`                   | Upsert gateway-wide proxy config               |
| `DELETE` | `/api/proxy-config`                   | Remove gateway-wide proxy config               |
| `POST`   | `/api/config/reload`                  | Reload in-memory config from durable state     |
| `GET`    | `/api/config/export`                  | Export config payload                          |
| `POST`   | `/api/config/import`                  | Import config payload                          |

### Governance and pricing

| Method   | Path                      | Purpose                   |
| -------- | ------------------------- | ------------------------- |
| `GET`    | `/api/virtual-keys`       | List virtual keys         |
| `POST`   | `/api/virtual-keys`       | Create a virtual key      |
| `PUT`    | `/api/virtual-keys/:id`   | Update a virtual key      |
| `DELETE` | `/api/virtual-keys/:id`   | Delete a virtual key      |
| `GET`    | `/api/teams`              | List teams                |
| `POST`   | `/api/teams`              | Create a team             |
| `PUT`    | `/api/teams/:id`          | Update a team             |
| `DELETE` | `/api/teams/:id`          | Delete a team             |
| `GET`    | `/api/customers`          | List customers            |
| `POST`   | `/api/customers`          | Create a customer         |
| `PUT`    | `/api/customers/:id`      | Update a customer         |
| `DELETE` | `/api/customers/:id`      | Delete a customer         |
| `GET`    | `/api/pricing`            | Read pricing catalog      |
| `PUT`    | `/api/pricing`            | Persist pricing overrides |
| `POST`   | `/api/pricing/force-sync` | Trigger a pricing sync    |

### Logs, analytics, runtime, and catalog

| Method   | Path                         | Purpose                                            |
| -------- | ---------------------------- | -------------------------------------------------- |
| `GET`    | `/api/logs`                  | Read live in-memory request log ring               |
| `GET`    | `/api/logs/stored`           | Read durable stored logs                           |
| `GET`    | `/api/logs/stats`            | Aggregate log statistics                           |
| `GET`    | `/api/logs/dropped`          | Report ring-buffer evictions                       |
| `GET`    | `/api/logs/filterdata`       | Return filter metadata for the logs UI             |
| `POST`   | `/api/logs/recalculate-cost` | Recompute stored log costs                         |
| `DELETE` | `/api/logs/stored`           | Clear stored logs                                  |
| `GET`    | `/api/logs/stream`           | Stream live log entries                            |
| `GET`    | `/api/analytics`             | Return analytics rollups                           |
| `GET`    | `/api/runtime`               | Return runtime diagnostics and topology            |
| `GET`    | `/api/catalog`               | Return the model catalog and provider capabilities |
| `GET`    | `/api/plugins`               | List plugin metadata                               |

### Settings, cache, MCP, and Code Mode

| Method   | Path                          | Purpose                                       |
| -------- | ----------------------------- | --------------------------------------------- |
| `GET`    | `/api/settings`               | Read effective settings values and provenance |
| `PUT`    | `/api/settings`               | Persist partial settings overrides            |
| `GET`    | `/api/mcp/clients`            | List MCP clients                              |
| `POST`   | `/api/mcp/clients`            | Create an MCP client                          |
| `PUT`    | `/api/mcp/clients/:id`        | Update an MCP client                          |
| `DELETE` | `/api/mcp/clients/:id`        | Delete an MCP client                          |
| `POST`   | `/api/mcp/clients/:id/sync`   | Sync one MCP client                           |
| `POST`   | `/api/mcp/sync`               | Sync all MCP clients                          |
| `GET`    | `/api/mcp/tools`              | List aggregated MCP tools                     |
| `GET`    | `/api/mcp/health`             | Return MCP health state                       |
| `GET`    | `/api/mcp/codemode/vfs`       | Return Code Mode VFS metadata                 |
| `POST`   | `/api/mcp/codemode/run`       | Execute Code Mode run path                    |
| `DELETE` | `/api/cache`                  | Clear cache                                   |
| `DELETE` | `/api/cache/by-key`           | Clear cache by request shape                  |
| `DELETE` | `/api/cache/clear/:requestId` | Clear cache by request id                     |
| `GET`    | `/mcp`                        | MCP server discovery surface                  |
| `POST`   | `/mcp`                        | MCP server JSON-RPC surface                   |

## Notes for consumers

- The control UI talks only to same-origin routes and stores the admin token in
  browser session storage.
- Several provider-specific route families accept vendor-shaped inputs but still
  resolve against configured Frosty provider accounts rather than blindly
  proxying upstream credentials.
- Settings currently expose provenance and persistence behavior even where some
  fields are not yet wired into runtime enforcement. That is an implementation
  fact, not a documentation omission.
