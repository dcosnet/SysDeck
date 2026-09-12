# Deploying to Production

This guide describes the production deployment shape the repository actually
ships: Docker, Docker Compose, PostgreSQL, and optional observability services.

## 1. Prepare the production environment

You need:

- a reachable PostgreSQL instance or the shipped `postgres` service
- one or more provider credentials
- an admin token for `/api/*`
- optional config-encryption key if you want persisted secrets encrypted at rest

Recommended baseline env settings:

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
FROSTY_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
```

## 2. Build or pull the gateway image

```bash
docker build -t frosty-gateway .
```

The image already includes the built UI bundle because the Dockerfile runs the
UI build in its first stage.

## 3. Start the default production stack

```bash
docker compose up -d
```

This starts:

- `gateway`
- `postgres`

Add the PgBouncer profile only when you need a transaction pool in front of
PostgreSQL:

```bash
docker compose --profile pgbouncer up -d
```

## 4. Enable observability when needed

Start the observability profile and point the gateway at the OTLP endpoint:

```bash
docker compose --profile observability up -d
```

```dotenv
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

## 5. Scale carefully

The checked-in Compose file defines one `gateway` service, but the gateway
itself supports multi-process fan-out via `FROSTY_WORKERS`.

Use that when:

- the host OS is Linux or macOS,
- you want multiple worker processes sharing port 8080,
- your connection budget can support `workers x pool-size` PostgreSQL usage.

If you scale out to multiple containers or replicas, set:

```dotenv
FROSTY_SHARED_RATE_LIMIT=on
```

That keeps fixed-window governance authoritative across replicas rather than per
process.

## 6. Health and rollout checks

Useful production checks:

```bash
curl http://localhost:8080/healthz
curl -H "Authorization: Bearer <token>" http://localhost:8080/api/runtime
curl http://localhost:8080/metrics
```

Health checks are already defined in Compose for gateway, PostgreSQL, PgBouncer,
Grafana, and MinIO.

## 7. Backup priorities

Back up these first:

1. `postgres-data` or the external PostgreSQL database
2. the MinIO trace-storage path if you keep observability history
3. Prometheus and Grafana volumes only if you need retained observability state

`frosty-data` is scratch space, not the primary durable state.

## 8. What this guide does not assume

- no Kubernetes or Helm packaging is shipped in the repository
- no CI/CD workflow is checked in to automate the gate
- no managed secret-store integration is wired directly into the Compose assets

If you build those layers around Frosty, document them separately from the
repository's shipped deployment surface.
