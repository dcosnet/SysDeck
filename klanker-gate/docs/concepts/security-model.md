# Security Model

This document describes the implemented security model, not an aspirational one.
It is derived from the current gateway runtime, route guards, config contracts,
logging behavior, and Code Mode controls.

## Security posture

The gateway is designed around a fail-closed bias in the places that would
otherwise create silent operator risk:

- the production bootstrap refuses to start without PostgreSQL,
- config encryption refuses to degrade silently once encrypted state exists,
- unknown governance hierarchy references deny requests,
- admin origin checks run before mutation bodies are parsed,
- Code Mode capability probing defaults to disabled on failure.

## Trust boundaries

### Public inference boundary

Inference callers reach `/v1/*` and related compatibility surfaces. They are
untrusted by default.

Controls on this boundary:

- request validation through shared schemas,
- virtual-key admission when governance is active,
- budget and rate-limit enforcement,
- provider/model allow-lists,
- canonical error responses instead of internal exceptions leaking through.

### Admin boundary

Operator routes live under `/api/*`.

Controls on this boundary:

- origin guard before body parsing,
- optional `FROSTY_ADMIN_TOKEN` bearer-token enforcement,
- same-origin control-plane UI,
- browser-safe redaction of provider and proxy secrets.

When `FROSTY_ADMIN_TOKEN` is unset, the code enters explicit local-admin mode.
That is convenient for local development, but it is not equivalent to an
authenticated deployment.

### Provider boundary

Upstream model providers are remote dependencies that can fail, reject input, or
behave inconsistently.

Controls on this boundary:

- provider adapters normalize responses into canonical shapes,
- fallback is restricted to retryable conditions,
- per-provider governance can skip exhausted accounts,
- provider-specific secrets are stored server-side and optionally encrypted at
  rest.

### MCP and Code Mode boundary

MCP client integration and Code Mode extend the gateway beyond pure HTTP
inference.

Controls on this boundary:

- stdio MCP transport is disabled unless explicitly enabled,
- Code Mode is gated both by configuration and by a worker-permission capability
  probe,
- the worker permission descriptor is deny-all by default,
- tool-run counts, concurrency, timeouts, and output sizes are bounded.

## Authentication and authorization model

The gateway does not implement human user accounts or classic role-based access
control. Instead, it enforces a small number of operational identities and
policy surfaces.

### Admin token

- Configured by `FROSTY_ADMIN_TOKEN`.
- Applied to `/api/*` requests by middleware.
- Stored by the control UI in browser session storage.
- Intended to protect configuration, settings, cache operations, runtime
  inspection, MCP management, and pricing/governance administration.

### Virtual keys

- Represent machine-facing bearer credentials for governed inference usage.
- Persisted as SHA-256 token hashes rather than raw tokens.
- Carry rate limits, token windows, request and cost budgets, team membership,
  and provider/model admission scope.

### Team and customer hierarchy

- Team and customer references roll usage and cost up the hierarchy.
- Unknown references deny rather than silently dropping hierarchy checks.

## Origin and request hardening

The admin origin guard is a meaningful part of the security model, not just a
convenience wrapper.

Observed protections:

- state-changing `/api/*` requests are checked before mutation body parsing,
- allowed hosts are bounded by env configuration plus localhost defaults,
- the guard is intended to reduce cross-site and DNS-rebinding abuse on operator
  surfaces.

## Secret handling

### In memory and at the API edge

- Provider secrets are loaded from environment variables or persisted
  configuration.
- Browser-facing views return redacted projections with `hasX` markers instead
  of raw values.
- Proxy credentials, CA certificate contents, cloud credentials, and API keys
  are deliberately hidden from the UI.

### At rest

- Config encryption is opt-in through `FROSTY_ENCRYPTION_KEY`.
- The implemented mechanism uses AES-256-GCM.
- Rotation support exists through `FROSTY_ENCRYPTION_KEY_OLD`.
- Once encrypted state exists, a missing or wrong key is a boot failure, not a
  warning.

### Logging and content capture

- Basic request logging is always on in memory.
- Durable log storage can be disabled, but defaults to PostgreSQL-backed
  persistence.
- Request and response content capture is off by default and must be explicitly
  enabled.
- Content capture redacts secret-looking keys before storing content.

## Deno permission model

The runtime permission set is part of the implementation contract.

Observed defaults:

- `--allow-net`
- `--allow-env`
- `--allow-read`
- `--allow-write=data`
- `--unstable-net`
- `--unstable-worker-options`

Scoped widening:

- `--allow-run=<deno-binary>` is added only for the supervisor path when
  multi-process worker fan-out is requested.
- stdio MCP additionally depends on runtime run permission.

This is one of the stronger implementation choices in the repo: worker spawning
and subprocess support are not assumed to be universally available just because
they are sometimes useful.

## Code Mode security model

Code Mode is explicitly layered behind more than one gate:

- app gate through `FROSTY_CODE_MODE`,
- boot-time capability probe for worker permission enforcement,
- deny-all worker permission descriptor,
- bounded execution parameters,
- a separate VFS metadata surface that can remain on while execution stays off.

The important practical point is that VFS visibility and execution authority are
not the same feature. The current code treats them separately.

## Cache and consistency implications

Security-relevant state can be cached locally, so the implementation includes
explicit invalidation behavior:

- config changes fan out across processes through PostgreSQL NOTIFY and a
  reconcile poll backstop,
- cache invalidation drops local L1 state on fanout events,
- shared rate-limit windows move to PostgreSQL when fleet-wide accuracy is
  requested.

The security consequence is that revocations and config changes are not left to
process restart timing.

## Known limits and current gaps

- There is no human-user account system, SSO surface, or fine-grained RBAC model
  in the shipped code.
- Some provider-panel fields are persisted and reflected to operators before
  their corresponding transport behavior is fully wired into runtime
  enforcement.
- Code Mode remains intentionally constrained and should not be documented as a
  general-purpose remote execution feature.
- Running without `FROSTY_ADMIN_TOKEN` leaves admin routes unprotected and is
  suitable only for trusted local environments.
