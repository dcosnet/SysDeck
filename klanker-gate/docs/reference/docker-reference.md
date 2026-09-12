# Docker Configuration Reference

This document describes the checked-in Dockerfiles and Compose assets that ship
with the repository.

## Prerequisites

- Docker Compose v2.20+ is required by the root `docker-compose.yml` because it
  uses `include:`.
- The repository does not declare formal CPU, memory, or disk minimums. No
  resource limits are set in the checked-in Compose file, so capacity planning
  remains an operator responsibility.
- Docker is mandatory only for containerized runs, live tests, and the
  observability profile. Local source-based development can run directly through
  Deno.

## Docker build

The `Dockerfile` is a two-stage Deno build:

1. `denoland/deno:2.9.3` builds the control UI inside the image.
2. `denoland/deno:alpine-2.9.3` serves the gateway and the built UI bundle at
   runtime.

The image exposes port `8080` and runs through `deploy/docker-entrypoint.sh`,
which mirrors the runtime permission contract and only adds scoped `--allow-run`
when `FROSTY_WORKERS>1` requires the supervisor process to spawn workers.

## Docker Compose services

| Service                | Image                                          | Ports                                              | Purpose                                                               | Volumes                                                         |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| `gateway`              | local build                                    | `8080:8080`                                        | Main API and same-origin control UI                                   | `frosty-data:/app/data`                                         |
| `postgres`             | `pgvector/pgvector:0.8.5-pg18`                 | `5432:5432`                                        | Required durable state, counters, response cache, and embedding index | `postgres-data:/var/lib/postgresql`                             |
| `pgbouncer`            | `edoburu/pgbouncer:v1.24.1-p1`                 | `6432:6432`                                        | Optional transaction pooler profile                                   | none                                                            |
| `prometheus`           | `prom/prometheus:v2.53.0`                      | `9090:9090`                                        | Optional metrics storage and scrape target                            | `prometheus-data:/prometheus` plus config bind mount            |
| `grafana`              | `grafana/grafana:11.1.0`                       | `3000:3000`                                        | Optional dashboard UI                                                 | `grafana-data:/var/lib/grafana` plus provisioning bind mounts   |
| `grafana-provision`    | `curlimages/curl:8.11.1`                       | none                                               | One-shot Grafana observer-account bootstrap                           | bind mount of `deploy/observability/grafana-observer.sh`        |
| `otel-collector`       | `otel/opentelemetry-collector-contrib:0.109.0` | `4318:4318`, `4317:4317`, `8888:8888`, `8889:8889` | OTLP intake and span-metrics fanout                                   | config bind mount                                               |
| `minio`                | `minio/minio:RELEASE.2025-09-07T16-13-09Z`     | `9000:9000`, `9001:9001`                           | S3-compatible trace storage backend for Tempo                         | host bind mount at `${FROSTY_TEMPO_STORAGE_PATH:-./data/tempo}` |
| `minio-init`           | `minio/mc:RELEASE.2025-08-13T08-35-41Z`        | none                                               | Creates the Tempo trace bucket, then exits                            | none                                                            |
| `tempo-distributor`    | `grafana/tempo:2.9.0`                          | none                                               | Receives traces from the collector                                    | config bind mount                                               |
| `tempo-ingester`       | `grafana/tempo:2.9.0`                          | none                                               | Tempo ingest and WAL handling                                         | `tempo-wal:/var/tempo` plus config bind mount                   |
| `tempo-querier`        | `grafana/tempo:2.9.0`                          | none                                               | Query backend for Tempo                                               | config bind mount                                               |
| `tempo-query-frontend` | `grafana/tempo:2.9.0`                          | `3200:3200`                                        | Tempo query API and readiness endpoint                                | config bind mount                                               |
| `tempo-compactor`      | `grafana/tempo:2.9.0`                          | none                                               | Tempo block compaction and retention work                             | config bind mount                                               |

## Environment variables for Docker

The `gateway` service forwards the full gateway env surface from `.env.example`
into the container. That includes provider credentials, PostgreSQL settings,
worker topology, caching, MCP, logging, observability, encryption, pricing sync,
HTTP client tuning, plugins, and Code Mode controls.

Additional Docker-specific variables used outside the gateway service:

| Variable                    | Used By                               | Purpose                           |
| --------------------------- | ------------------------------------- | --------------------------------- |
| `GF_ADMIN_USER`             | `grafana`, `grafana-provision`        | Grafana admin username            |
| `GF_ADMIN_PASSWORD`         | `grafana`, `grafana-provision`        | Grafana admin password            |
| `GF_OBSERVER_USER`          | `grafana-provision`                   | Observer account username         |
| `GF_OBSERVER_PASSWORD`      | `grafana-provision`                   | Observer account password         |
| `TEMPO_S3_ACCESS_KEY`       | `minio`, `minio-init`, Tempo services | MinIO access key                  |
| `TEMPO_S3_SECRET_KEY`       | `minio`, `minio-init`, Tempo services | MinIO secret key                  |
| `TEMPO_S3_BUCKET`           | `minio-init`, Tempo services          | Tempo trace bucket name           |
| `TEMPO_BLOCK_RETENTION`     | Tempo services                        | Block retention period            |
| `FROSTY_TEMPO_STORAGE_PATH` | `minio` bind mount                    | Host path for MinIO trace storage |

See [environment-variables.md](./environment-variables.md) for the full gateway
env reference.

## Volume mounts

| Volume or mount                              | Used By                | Purpose                                 |
| -------------------------------------------- | ---------------------- | --------------------------------------- |
| `frosty-data`                                | `gateway`              | Process-local scratch under `/app/data` |
| `postgres-data`                              | `postgres`             | Durable PostgreSQL data                 |
| `prometheus-data`                            | `prometheus`           | Prometheus TSDB storage                 |
| `grafana-data`                               | `grafana`              | Grafana state and provisioned metadata  |
| `tempo-wal`                                  | `tempo-ingester`       | Tempo write-ahead log                   |
| `${FROSTY_TEMPO_STORAGE_PATH:-./data/tempo}` | `minio`                | Host bind mount for Tempo trace blocks  |
| `./deploy/observability/...`                 | observability services | Provisioned configs and dashboards      |

## Network configuration

- The gateway serves public traffic on port `8080`.
- PostgreSQL is exposed on `5432` and is a hard dependency for production boot.
- PgBouncer, when enabled, is exposed on `6432`, but the session-stable LISTEN
  connection must still target PostgreSQL directly.
- The observability profile exposes Grafana on `3000`, Prometheus on `9090`,
  OTLP on `4318` and `4317`, MinIO on `9000` and `9001`, and Tempo query
  frontend on `3200`.

## Common operations

### Building images

- Build the gateway image: `docker build -t frosty-gateway .`
- Build and start the default Compose stack: `docker compose up -d --build`

### Starting and stopping services

- Start the default stack: `docker compose up -d`
- Add PgBouncer: `docker compose --profile pgbouncer up -d`
- Add observability: `docker compose --profile observability up -d`
- Stop everything: `docker compose down`
- Reset volumes: `docker compose down -v`

### Viewing logs

- Gateway logs: `docker compose logs -f gateway`
- PostgreSQL logs: `docker compose logs -f postgres`
- Observability logs:
  `docker compose --profile observability logs -f grafana prometheus otel-collector`

### Debugging containers

- Gateway shell: `docker compose exec gateway sh`
- PostgreSQL shell: `docker compose exec postgres sh`
- Compose status: `docker compose ps`

## Data persistence and backup

- PostgreSQL is the system's durable source of truth for config, counters, logs,
  and cache metadata.
- `postgres-data` is the most critical volume to back up.
- `frosty-data` holds process-local scratch only.
- Tempo trace blocks live in the MinIO bind mount path and the ingester WAL
  volume.
- Prometheus and Grafana volumes matter only if you need observability history
  preserved.

## Production considerations

- Health checks are defined for `gateway`, `postgres`, `pgbouncer`, `grafana`,
  and `minio`.
- The checked-in Compose assets do not define CPU or memory limits.
- Secrets are injected through environment variables; the repository does not
  ship a separate secret manager integration for Compose.
- The gateway process can run multi-worker on Linux and macOS when
  `FROSTY_WORKERS>1`, but the Compose topology itself remains one gateway
  container unless the operator scales it externally.
- Kubernetes and Helm packaging are not present in the repository and should not
  be documented as shipped deployment targets.
