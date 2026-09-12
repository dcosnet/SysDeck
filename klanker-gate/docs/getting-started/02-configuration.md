# Configuration

This tutorial walks through the main configuration surfaces that control Frosty
Deno.

## 1. Understand the configuration layers

The gateway uses two configuration sources:

1. environment variables parsed at boot
2. persisted PostgreSQL-backed state loaded during `createDefaultContext()`

When the same provider id or config field exists in both places, the persisted
configuration wins.

## 2. Configure PostgreSQL first

The production path requires PostgreSQL.

Minimum setting:

```dotenv
FROSTY_PG_URL=postgres://frosty:frosty@localhost:5432/frosty
```

Add `FROSTY_PG_DIRECT_URL` when a transaction pooler sits in front of PostgreSQL
and you still need a direct LISTEN connection.

## 3. Configure at least one provider

Choose one provider family and fill in the matching env group.

Example with OpenAI:

```dotenv
OPENAI_API_KEY=sk-your-key
FROSTY_DEFAULT_PROVIDER=openai
```

Example with Azure OpenAI:

```dotenv
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_VERSION=2024-02-15-preview
AZURE_OPENAI_DEPLOYMENTS=gpt-4o-deployment
```

Example with a generic compatible endpoint:

```dotenv
OPENAI_COMPAT_BASE_URL=https://your-compatible-host/v1
OPENAI_COMPAT_API_KEY=...
OPENAI_COMPAT_DEFAULT_MODEL=your-default-model
```

## 4. Protect the admin surface

For any environment beyond trusted local development, set:

```dotenv
FROSTY_ADMIN_TOKEN=replace-me
FROSTY_ALLOWED_HOSTS=gw.example.com
```

`FROSTY_ADMIN_TOKEN` protects `/api/*` with a bearer token.
`FROSTY_ALLOWED_HOSTS` feeds the admin origin guard.

## 5. Decide which optional subsystems to enable

### Cache

```dotenv
FROSTY_CACHE=exact
```

Or semantic cache:

```dotenv
FROSTY_CACHE=semantic
FROSTY_VECTOR_STORE=pgvector
FROSTY_CACHE_EMBED_MODEL=text-embedding-3-small
```

### Durable logs and analytics

```dotenv
FROSTY_LOG_STORE=pg
FROSTY_LOG_STORE_MAX=5000
```

### Tracing

```dotenv
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

### Pricing sync

```dotenv
FROSTY_PRICING_SYNC=on
```

### Config encryption

```dotenv
FROSTY_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
```

## 6. Configure governance if you need enforced admission

Governance configuration is primarily managed through the admin API or control
UI after boot, but these env variables change the runtime behavior around it:

- `FROSTY_SHARED_RATE_LIMIT`
- `FROSTY_WORKERS`
- `FROSTY_CONFIG_RECONCILE_MS`

Set `FROSTY_SHARED_RATE_LIMIT=on` when you run multiple replicas or want the
fixed-window authority in PostgreSQL.

## 7. Persist operator configuration through the UI or `/api/*`

After boot, use:

- `#/providers`
- `#/virtual-keys`
- `#/teams`
- `#/customers`
- `#/pricing`
- `#/settings`

or the equivalent `/api/*` routes to persist additional configuration.

That is where you manage provider-account details that do not belong in env
alone, such as extra headers, proxy settings, and operator-set pricing
overrides.

## 8. Validate the result

Useful checks:

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/v1/models
curl -H "Authorization: Bearer $FROSTY_ADMIN_TOKEN" http://localhost:8080/api/providers
```

If the admin token is configured, the control UI will prompt for it and store it
in browser session storage.

Continue with [03-local-development.md](./03-local-development.md) for the
day-to-day development workflow.
