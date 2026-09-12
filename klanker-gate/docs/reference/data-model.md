# Data Model Reference

This document summarizes the durable and in-memory data shapes that define
Frosty Deno's configuration, governance, caching, logging, and operator
surfaces.

## Durable storage model

### PostgreSQL state store

`packages/config/src/store_postgres.ts` defines two generic durable tables:

| Object            | Shape                                                                                    | Purpose                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `frosty.state`    | `key_text text primary key`, `key_path text[]`, `value jsonb`, `updated_at timestamptz`  | Durable JSON document store for config, hierarchy, settings, logs, and related state |
| `frosty.counters` | `key_text text primary key`, `key_path text[]`, `value bigint`, `updated_at timestamptz` | Durable atomic counters for usage, cost, budgets, and shared rate-limit windows      |

State and counter namespaces are intentionally separate so additive counters
never masquerade as ordinary JSON documents.

### Cache and vector tables

| Object                                           | Purpose                                       | Source                                                      |
| ------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------- |
| `frosty.response_cache`                          | Cached response payloads with TTL support     | `packages/cache/src/pg_cache.ts`                            |
| `FROSTY_PG_TABLE` defaulting to `frosty_vectors` | pgvector embeddings for semantic cache lookup | `apps/gateway/context.ts`, `packages/cache/src/pgvector.ts` |

## Key-path conventions in `frosty.state`

The durable store is key-path driven. Important observed prefixes include:

| Prefix                          | Stored object family                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `['config', 'providers', <id>]` | Provider account configuration                                |
| `['config', 'settings']`        | Gateway config-level settings data                            |
| `['virtual_keys', ...]`         | Virtual-key state                                             |
| `['teams', ...]`                | Team hierarchy data                                           |
| `['customers', ...]`            | Customer hierarchy data                                       |
| `['settings', <group>]`         | Per-group operator override fragments                         |
| `['logs', ...]`                 | Durable log entries when log storage is enabled               |
| `['config', 'crypto', 'dek']`   | Wrapped data-encryption key record for encrypted config state |

## Configuration entities

### `ProviderAccountConfig`

Defined in `packages/contracts/src/config.ts`.

Major fields:

| Field                                                                       | Type       | Purpose                                                                                                         |
| --------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `id`                                                                        | `string`   | Stable provider account id                                                                                      |
| `type`                                                                      | enum       | Provider family such as `openai`, `anthropic`, `azure`, `bedrock`, `vertex`, `openai-compatible`, or `lmstudio` |
| `apiKey`                                                                    | `string?`  | Provider API key when that provider uses one                                                                    |
| `baseUrl`                                                                   | `string?`  | Upstream base URL                                                                                               |
| `endpoint`, `apiVersion`                                                    | `string?`  | Azure-specific routing values                                                                                   |
| `enabled`                                                                   | `boolean`  | Provider account enablement                                                                                     |
| `models`                                                                    | `string[]` | Advertised model catalog                                                                                        |
| `priority`, `weight`                                                        | `number`   | Fallback and weighted balancing hints                                                                           |
| `retry`                                                                     | object     | Provider retry policy                                                                                           |
| `aws*`                                                                      | strings    | Bedrock and S3 integration fields                                                                               |
| `projectId`, `location`, `serviceAccountJson`                               | strings    | Vertex AI configuration                                                                                         |
| `proxyUrl`                                                                  | `string?`  | Per-provider proxy endpoint                                                                                     |
| `network`, `proxy`, `performance`, `governance`, `betaHeaders`, `debugging` | objects    | Six grouped provider-control panels                                                                             |

Redacted browser-safe view:

- `ProviderAccountPublic` replaces secrets with presence markers such as
  `hasApiKey`, `hasCloudCredentials`, `hasProxy`, `hasProxyPassword`, and
  `hasCaCert`.
- Header values, proxy passwords, bypass rules, certificate PEM data, raw
  provider secrets, and stored cloud credentials do not reach the browser.

### `GatewayConfig` and `ConfigExport`

| Type            | Purpose                                                                   |
| --------------- | ------------------------------------------------------------------------- |
| `GatewayConfig` | Strict object with `defaultProvider` and `providers[]`                    |
| `ConfigExport`  | Versioned export payload containing `version`, `exportedAt`, and `config` |

## Governance entities

### `Budget`

Defined in `packages/governance/src/virtual_keys.ts`.

| Field             | Purpose                                    |
| ----------------- | ------------------------------------------ |
| `maxRequests`     | Request-count budget ceiling               |
| `maxCostUsd`      | Dollar-cost budget ceiling                 |
| `resetIntervalMs` | Optional server-timed fixed reset interval |

### `VirtualKey`

Defined in `packages/governance/src/virtual_keys.ts`.

| Field                               | Purpose                                                               |
| ----------------------------------- | --------------------------------------------------------------------- |
| `id`, `name`, `description`         | Stable identifier and operator label                                  |
| `token`                             | Raw bearer token accepted transiently on creation or legacy migration |
| `tokenHash`                         | Persisted SHA-256 hex token hash                                      |
| `tokenHint`                         | Non-secret last-four-character hint for UI display                    |
| `enabled`                           | Key enablement                                                        |
| `rateLimit`                         | Request-based fixed window                                            |
| `tokenLimit`                        | Token-metered fixed window                                            |
| `budget`                            | Request and/or cost budget                                            |
| `allowedProviders`, `allowedModels` | Admission scope restrictions                                          |
| `usedRequests`, `usedCostMicroUsd`  | Accrued metering data                                                 |
| `teamId`                            | Optional team membership                                              |

Public browser-safe projections drop the raw token and its hash and add a
derived `usedCostUsd` field.

### `Team` and `Customer`

Defined in `packages/governance/src/hierarchy.ts`.

| Type       | Key fields                                                                          | Purpose                                                     |
| ---------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `Team`     | `id`, `name`, `enabled`, `customerId`, `budget`, `usedRequests`, `usedCostMicroUsd` | Mid-level hierarchy node collecting usage from virtual keys |
| `Customer` | `id`, `name`, `enabled`, `budget`, `usedRequests`, `usedCostMicroUsd`               | Top-level hierarchy node collecting usage from teams        |

Unknown references fail closed during chain validation.

## Settings model

Defined in `packages/contracts/src/settings.ts` and
`apps/gateway/routes/settings.ts`.

Settings groups:

| Group           | Purpose                                                |
| --------------- | ------------------------------------------------------ |
| `security`      | Auth and route-protection-related operator settings    |
| `compatibility` | Request translation and unsupported-parameter handling |
| `performance`   | Request-body and pool-size tuning                      |
| `caching`       | Cache enablement and tuning                            |
| `mcp`           | MCP tool and external-client settings                  |

Important settings response characteristics:

- `GET /api/settings` returns effective values plus per-field provenance in
  `sources`.
- Provenance values are `default`, `env`, or `override`.
- Persisted overrides are stored by group under `['settings', <group>]`.
- `security.hasPassword` is derived metadata; the password itself is not
  returned.
- Runtime enforcement is exposed separately through an `enforcement` map because
  not every persisted setting is wired live.

## MCP data shapes

Observed browser-facing MCP view types in `apps/control-ui/src/api.ts`:

| Type             | Purpose                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `MCPClientView`  | Browser-safe MCP client record with `headerNames`, `hasCommand`, `hasUrlCredentials`, and `toolCount` |
| `MCPClientInput` | UI write shape for MCP client creation and updates                                                    |
| `MCPToolView`    | Aggregated tool metadata including `clientId` and optional annotations                                |
| `MCPHealthView`  | Per-client health summary                                                                             |

## Telemetry and log model

### `LogEntry`

Defined in `packages/telemetry/src/logbus.ts`.

| Field family                                          | Purpose                                               |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `ts`, `level`, `message`                              | Base log metadata                                     |
| `requestId`, `method`, `path`, `status`, `durationMs` | HTTP request identification and timing                |
| `provider`, `model`                                   | Resolved inference target                             |
| `promptTokens`, `completionTokens`, `totalTokens`     | Usage accounting                                      |
| `costMicroUsd`                                        | Cost in the repo-wide integer micro-USD unit          |
| `content`                                             | Opt-in captured request/response content when enabled |

Request and response content capture is disabled by default and redacts
secret-looking keys before persistence.

## UI-facing transport shapes

The control UI imports shared contracts directly and adds view-specific wrapper
shapes in `apps/control-ui/src/api.ts`, including:

- `GatewayConfigView`
- `VersionInfo`
- `AnalyticsRollup`, `AnalyticsTotals`, `AnalyticsBucket`, `AnalyticsModelRow`,
  `AnalyticsProviderRow`
- `StoredLogsResult`

Those client-side view types are projections over gateway responses, not
independent persistence models.
