# Environment Variables Reference

This reference is derived from `.env.example`, `docker-compose.yml`,
`apps/gateway/context.ts`, and the route and helper modules that parse
environment values.

## Quick reference table

| Variable                            | Required    | Default                                      | Description                                                          |
| ----------------------------------- | ----------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `OPENAI_API_KEY`                    | Conditional | none                                         | Enables the first-party OpenAI provider                              |
| `ANTHROPIC_API_KEY`                 | Conditional | none                                         | Enables the first-party Anthropic provider                           |
| `AZURE_OPENAI_API_KEY`              | Conditional | none                                         | Azure OpenAI credential                                              |
| `AZURE_OPENAI_ENDPOINT`             | Conditional | none                                         | Azure OpenAI resource endpoint                                       |
| `AZURE_OPENAI_API_VERSION`          | Conditional | none                                         | Azure OpenAI API version                                             |
| `AZURE_OPENAI_DEPLOYMENTS`          | Conditional | none                                         | Comma-separated Azure deployment names                               |
| `GEMINI_API_KEY`                    | Conditional | none                                         | Enables the Gemini provider                                          |
| `OPENROUTER_API_KEY`                | Conditional | none                                         | Enables the OpenRouter provider                                      |
| `GROQ_API_KEY`                      | Conditional | none                                         | Enables the Groq provider                                            |
| `MISTRAL_API_KEY`                   | Conditional | none                                         | Enables the Mistral provider                                         |
| `XAI_API_KEY`                       | Conditional | none                                         | Enables the xAI provider                                             |
| `PERPLEXITY_API_KEY`                | Conditional | none                                         | Enables the Perplexity provider                                      |
| `CEREBRAS_API_KEY`                  | Conditional | none                                         | Enables the Cerebras provider                                        |
| `NEBIUS_API_KEY`                    | Conditional | none                                         | Enables the Nebius provider                                          |
| `PARASAIL_API_KEY`                  | Conditional | none                                         | Enables the Parasail provider                                        |
| `HF_TOKEN`                          | Conditional | none                                         | Enables Hugging Face access                                          |
| `COHERE_API_KEY`                    | Conditional | none                                         | Enables the Cohere provider                                          |
| `ELEVENLABS_API_KEY`                | Conditional | none                                         | Enables ElevenLabs text-to-speech                                    |
| `OLLAMA_BASE_URL`                   | Conditional | none                                         | Base URL for Ollama                                                  |
| `OLLAMA_MODELS`                     | Conditional | none                                         | Comma-separated Ollama models                                        |
| `AWS_REGION`                        | Conditional | `us-east-1`                                  | Bedrock region                                                       |
| `AWS_ACCESS_KEY_ID`                 | Conditional | none                                         | Bedrock access key id                                                |
| `AWS_SECRET_ACCESS_KEY`             | Conditional | none                                         | Bedrock secret key                                                   |
| `AWS_SESSION_TOKEN`                 | Conditional | none                                         | Optional Bedrock session token                                       |
| `BEDROCK_MODELS`                    | Conditional | none                                         | Comma-separated Bedrock models                                       |
| `VERTEX_PROJECT_ID`                 | Conditional | none                                         | Vertex AI project id                                                 |
| `VERTEX_LOCATION`                   | Conditional | `us-central1`                                | Vertex AI region                                                     |
| `VERTEX_SERVICE_ACCOUNT_JSON`       | Conditional | none                                         | One-line Vertex service account JSON                                 |
| `VERTEX_MODELS`                     | Conditional | `gemini-2.5-pro`                             | Comma-separated Vertex models                                        |
| `OPENAI_COMPAT_BASE_URL`            | Conditional | none                                         | Enables a generic OpenAI-compatible provider                         |
| `OPENAI_COMPAT_API_KEY`             | Conditional | none                                         | Credential for the generic OpenAI-compatible provider                |
| `OPENAI_COMPAT_DEFAULT_MODEL`       | Conditional | none                                         | Default model for the generic OpenAI-compatible provider             |
| `ANTHROPIC_COMPAT_BASE_URL`         | Conditional | none                                         | Enables a generic Anthropic-compatible provider                      |
| `ANTHROPIC_COMPAT_API_KEY`          | Conditional | none                                         | Credential for the generic Anthropic-compatible provider             |
| `ANTHROPIC_COMPAT_DEFAULT_MODEL`    | Conditional | none                                         | Default model for the generic Anthropic-compatible provider          |
| `LMSTUDIO_BASE_URL`                 | Conditional | `http://localhost:1234/v1`                   | Base URL for LM Studio                                               |
| `LMSTUDIO_API_KEY`                  | Conditional | none                                         | Optional LM Studio API key                                           |
| `LMSTUDIO_DEFAULT_MODEL`            | Conditional | none                                         | Default LM Studio model                                              |
| `PORT`                              | No          | `8080`                                       | Gateway listen port                                                  |
| `LOG_LEVEL`                         | No          | `info`                                       | Gateway log level                                                    |
| `FROSTY_DEFAULT_PROVIDER`           | No          | `openai`                                     | Default provider for bare model ids                                  |
| `FROSTY_PG_URL`                     | Yes         | none                                         | Primary PostgreSQL connection string                                 |
| `FROSTY_PG_DIRECT_URL`              | Conditional | none                                         | Session-stable PostgreSQL URL for LISTEN when a pooler sits in front |
| `FROSTY_PG_POOL_SIZE`               | No          | code default                                 | Per-process PostgreSQL pool size                                     |
| `FROSTY_PG_TABLE`                   | No          | `frosty_vectors`                             | pgvector table name                                                  |
| `FROSTY_WORKERS`                    | No          | single-process                               | Worker-process count                                                 |
| `FROSTY_SHARED_RATE_LIMIT`          | No          | `auto`                                       | Shared rate-limit authority mode                                     |
| `FROSTY_CONFIG_RECONCILE_MS`        | No          | `30000`                                      | Config poll backstop interval in milliseconds                        |
| `FROSTY_ADMIN_TOKEN`                | No          | none                                         | Optional bearer token for `/api/*`                                   |
| `FROSTY_ALLOWED_HOSTS`              | No          | localhost, `127.0.0.1`, `::1` always allowed | Additional admin-origin allow-list hosts                             |
| `FROSTY_CACHE`                      | No          | off                                          | Cache mode: unset, `exact`, or `semantic`                            |
| `FROSTY_CACHE_TTL_MS`               | No          | code default                                 | Cache TTL in milliseconds                                            |
| `FROSTY_CACHE_EMBED_MODEL`          | No          | `text-embedding-3-small`                     | Embedding model for semantic cache lookups                           |
| `FROSTY_VECTOR_STORE`               | No          | none                                         | Vector store implementation, currently `pgvector` when enabled       |
| `FROSTY_MCP_ALLOW_STDIO`            | No          | off                                          | Enables stdio MCP transports when combined with runtime permission   |
| `FROSTY_MCP_HEALTH_INTERVAL_MS`     | No          | on-demand only                               | Periodic MCP health-check interval                                   |
| `FROSTY_LOG_STORE`                  | No          | `pg`                                         | Durable log-store mode, `pg` or `off`                                |
| `FROSTY_LOG_STORE_MAX`              | No          | `5000`                                       | Stored-log cap                                                       |
| `FROSTY_LOG_EXCLUDE_PATHS`          | No          | `/healthz,/metrics,/favicon.ico`             | Paths excluded from the dashboard log trail                          |
| `FROSTY_EUR_RATE`                   | No          | `0.92`                                       | Operator display conversion rate from USD to EUR                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT`       | No          | off                                          | OTLP HTTP endpoint for traces                                        |
| `OTEL_FLUSH_INTERVAL_MS`            | No          | `5000`                                       | OTEL batch flush interval                                            |
| `FROSTY_OTEL_MODEL_CARDINALITY_CAP` | No          | `11`                                         | Distinct model-label cap for span-derived metrics                    |
| `FROSTY_PRICING_SYNC`               | No          | off                                          | Enables periodic LiteLLM pricing sync                                |
| `FROSTY_PRICING_SYNC_INTERVAL_MS`   | No          | `86400000`                                   | Pricing sync interval in milliseconds                                |
| `FROSTY_PRICING_URL`                | No          | LiteLLM upstream JSON URL                    | Source for pricing sync                                              |
| `FROSTY_ENCRYPTION_KEY`             | No          | off                                          | Opt-in config encryption key                                         |
| `FROSTY_ENCRYPTION_KEY_OLD`         | No          | none                                         | Previous encryption key used for rotation                            |
| `FROSTY_JSON_REPAIR`                | No          | off                                          | Enables the JSON-repair plugin                                       |
| `FROSTY_MOCKER`                     | No          | off                                          | Enables the mock-response plugin                                     |
| `FROSTY_MOCKER_CONFIG`              | Conditional | none                                         | Inline JSON or file path for mocker rules                            |
| `FROSTY_HTTP_TIMEOUT_MS`            | No          | `120000`                                     | Default provider HTTP timeout in milliseconds                        |
| `FROSTY_NO_PROXY`                   | No          | none                                         | Comma-separated proxy bypass rules                                   |
| `FROSTY_LOG_CONTENT`                | No          | off                                          | Enables request and response content capture in stored logs          |
| `FROSTY_CODE_MODE`                  | No          | `off`                                        | Enables Code Mode surfaces and capability probing                    |
| `FROSTY_CODE_MODE_VFS`              | No          | `on`                                         | Enables Code Mode VFS metadata surface                               |

## Categorized reference

### Provider credentials and provider catalogs

Variables:

- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`
- `GROQ_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `PERPLEXITY_API_KEY`,
  `CEREBRAS_API_KEY`, `NEBIUS_API_KEY`, `PARASAIL_API_KEY`, `HF_TOKEN`,
  `COHERE_API_KEY`, `ELEVENLABS_API_KEY`
- `OLLAMA_BASE_URL`, `OLLAMA_MODELS`

Notes:

- All are optional individually and only required when that provider is intended
  to boot automatically from env.
- Model lists use comma-separated values where present.
- Secrets in this category must never be committed to version control.
- Example: `OPENAI_API_KEY=sk-...`, `OLLAMA_BASE_URL=http://localhost:11434`,
  `OLLAMA_MODELS=llama3.1,codellama`.

### Azure OpenAI, Bedrock, and Vertex AI

Variables:

- Azure: `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`,
  `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENTS`
- Bedrock: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_SESSION_TOKEN`, `BEDROCK_MODELS`
- Vertex: `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, `VERTEX_SERVICE_ACCOUNT_JSON`,
  `VERTEX_MODELS`

Notes:

- These groups are conditionally required as complete sets for their respective
  providers.
- `VERTEX_SERVICE_ACCOUNT_JSON` is expected as a single-line JSON string.
- `AZURE_OPENAI_DEPLOYMENTS`, `BEDROCK_MODELS`, and `VERTEX_MODELS` are
  comma-separated lists.
- All cloud credentials in this category should be treated as secrets.

### Generic compatible endpoints

Variables:

- `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY`,
  `OPENAI_COMPAT_DEFAULT_MODEL`
- `ANTHROPIC_COMPAT_BASE_URL`, `ANTHROPIC_COMPAT_API_KEY`,
  `ANTHROPIC_COMPAT_DEFAULT_MODEL`
- `LMSTUDIO_BASE_URL`, `LMSTUDIO_API_KEY`, `LMSTUDIO_DEFAULT_MODEL`

Notes:

- Each compatible endpoint stays off until its `*_BASE_URL` is set.
- `LMSTUDIO_BASE_URL` defaults to `http://localhost:1234/v1`.
- These variables let Frosty wrap third-party or local compatible servers as
  provider accounts.

### Core gateway and PostgreSQL

Variables:

- `PORT`, `LOG_LEVEL`, `FROSTY_DEFAULT_PROVIDER`
- `FROSTY_PG_URL`, `FROSTY_PG_DIRECT_URL`, `FROSTY_PG_POOL_SIZE`,
  `FROSTY_PG_TABLE`

Notes:

- `FROSTY_PG_URL` is effectively mandatory on the production path because
  PostgreSQL is a hard dependency.
- `FROSTY_PG_DIRECT_URL` matters when PgBouncer is used, because LISTEN needs a
  session-stable connection.
- `FROSTY_PG_TABLE` controls the pgvector table name used by the semantic cache.
- Example: `FROSTY_PG_URL=postgres://frosty:frosty@localhost:5432/frosty`.

### Worker topology and shared governance

Variables:

- `FROSTY_WORKERS`, `FROSTY_SHARED_RATE_LIMIT`, `FROSTY_CONFIG_RECONCILE_MS`

Notes:

- `FROSTY_WORKERS` values greater than 1 trigger the multi-process supervisor on
  supported operating systems.
- `FROSTY_SHARED_RATE_LIMIT` accepts `auto`, `on`, or `off`.
- `FROSTY_CONFIG_RECONCILE_MS` bounds staleness when LISTEN/NOTIFY is missed.

### Admin protection and origin control

Variables:

- `FROSTY_ADMIN_TOKEN`, `FROSTY_ALLOWED_HOSTS`

Notes:

- Leaving `FROSTY_ADMIN_TOKEN` unset results in local-admin mode.
- `FROSTY_ALLOWED_HOSTS` is a comma-separated host allow-list for the admin
  origin guard.
- Example: `FROSTY_ALLOWED_HOSTS=gw.example.com,admin.internal.example.com`.

### Cache and vector store

Variables:

- `FROSTY_CACHE`, `FROSTY_CACHE_TTL_MS`, `FROSTY_CACHE_EMBED_MODEL`,
  `FROSTY_VECTOR_STORE`

Notes:

- `FROSTY_CACHE` is unset for off, `exact` for exact-match caching, and
  `semantic` for embedding-assisted lookup.
- `FROSTY_VECTOR_STORE` is only relevant when semantic cache is on.
- `FROSTY_CACHE_EMBED_MODEL` must match a model id the configured provider can
  serve.

### MCP and Code Mode

Variables:

- `FROSTY_MCP_ALLOW_STDIO`, `FROSTY_MCP_HEALTH_INTERVAL_MS`
- `FROSTY_CODE_MODE`, `FROSTY_CODE_MODE_VFS`

Notes:

- `FROSTY_MCP_ALLOW_STDIO` only takes effect when the runtime also has
  `--allow-run` for the Deno binary.
- `FROSTY_CODE_MODE` defaults to `off` and remains additionally gated by the
  capability probe.
- `FROSTY_CODE_MODE_VFS` controls the VFS metadata surface and defaults to `on`
  in the example env.

### Logging, analytics display, and observability

Variables:

- `FROSTY_LOG_STORE`, `FROSTY_LOG_STORE_MAX`, `FROSTY_LOG_EXCLUDE_PATHS`,
  `FROSTY_EUR_RATE`, `FROSTY_LOG_CONTENT`
- `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_FLUSH_INTERVAL_MS`,
  `FROSTY_OTEL_MODEL_CARDINALITY_CAP`

Notes:

- `FROSTY_LOG_STORE=pg` keeps the durable PostgreSQL trail on; `off` disables
  it.
- `FROSTY_LOG_EXCLUDE_PATHS` accepts exact paths and `/prefix/*` patterns.
- `FROSTY_LOG_CONTENT` is privacy-sensitive and off by default.
- `OTEL_EXPORTER_OTLP_ENDPOINT` turns trace export on when set.

### Pricing sync, encryption, plugins, and HTTP client tuning

Variables:

- `FROSTY_PRICING_SYNC`, `FROSTY_PRICING_SYNC_INTERVAL_MS`, `FROSTY_PRICING_URL`
- `FROSTY_ENCRYPTION_KEY`, `FROSTY_ENCRYPTION_KEY_OLD`
- `FROSTY_JSON_REPAIR`, `FROSTY_MOCKER`, `FROSTY_MOCKER_CONFIG`
- `FROSTY_HTTP_TIMEOUT_MS`, `FROSTY_NO_PROXY`

Notes:

- `FROSTY_PRICING_SYNC` is opt-in and off by default.
- `FROSTY_ENCRYPTION_KEY` enables AES-256-GCM encryption-at-rest behavior and
  becomes effectively mandatory for subsequent boots once encrypted data exists.
- `FROSTY_MOCKER_CONFIG` accepts inline JSON or a file path.
- `FROSTY_NO_PROXY` is a comma-separated bypass list.

## Example configurations

### Minimal development setup

```dotenv
OPENAI_API_KEY=sk-your-key
PORT=8080
FROSTY_DEFAULT_PROVIDER=openai
FROSTY_PG_URL=postgres://frosty:frosty@localhost:5432/frosty
FROSTY_LOG_STORE=pg
```

### Docker Compose development

```dotenv
PORT=8080
OPENAI_API_KEY=sk-your-key
FROSTY_DEFAULT_PROVIDER=openai
FROSTY_PG_URL=postgres://frosty:frosty@postgres:5432/frosty
FROSTY_LOG_STORE=pg
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

### Production-oriented example

```dotenv
PORT=8080
OPENAI_API_KEY=sk-your-key
FROSTY_DEFAULT_PROVIDER=openai
FROSTY_PG_URL=postgres://user:pass@db.internal:5432/frosty
FROSTY_PG_DIRECT_URL=postgres://user:pass@db.internal:5432/frosty
FROSTY_ADMIN_TOKEN=replace-me
FROSTY_ALLOWED_HOSTS=gw.example.com
FROSTY_LOG_STORE=pg
FROSTY_SHARED_RATE_LIMIT=on
FROSTY_ENCRYPTION_KEY=base64-encoded-32-byte-key
```

## Security best practices

- Never commit provider keys, cloud credentials, admin tokens, or encryption
  keys.
- Prefer environment injection from a secret store or deployment platform rather
  than a committed `.env` file.
- Rotate `FROSTY_ADMIN_TOKEN`, provider API keys, and `FROSTY_ENCRYPTION_KEY`
  according to your operational policy.
- Treat `FROSTY_LOG_CONTENT` as a privacy-sensitive switch and leave it off
  unless content capture is explicitly required.
- Do not embed credentials in proxy URLs; the provider-config schema separates
  proxy credentials from proxy URL fields for that reason.

## Troubleshooting

- If the gateway refuses to boot, verify `FROSTY_PG_URL` connectivity first.
  PostgreSQL is a hard dependency on the production path.
- If config changes do not appear across replicas, check `FROSTY_PG_DIRECT_URL`
  and `FROSTY_CONFIG_RECONCILE_MS`.
- If semantic cache lookups never hit, verify `FROSTY_CACHE=semantic`,
  `FROSTY_VECTOR_STORE=pgvector`, and `FROSTY_CACHE_EMBED_MODEL` against
  `GET /v1/models`.
- If admin writes are rejected cross-origin, check `FROSTY_ALLOWED_HOSTS` and
  confirm the request is targeting `/api/*` from an allowed host.
- If trace export is missing, verify `OTEL_EXPORTER_OTLP_ENDPOINT` and the
  observability profile services.
- If encrypted config becomes unreadable, confirm `FROSTY_ENCRYPTION_KEY` is
  still present and, during rotation, that `FROSTY_ENCRYPTION_KEY_OLD` matches
  the previous key.
