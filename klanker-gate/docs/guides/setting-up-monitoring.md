# Setting Up Monitoring

This guide covers the monitoring and observability surface that ships with the
repository.

## 1. Start the observability profile

```bash
docker compose --profile observability up -d
```

This brings up:

- Prometheus
- Grafana
- OTEL Collector
- MinIO
- Tempo distributor, ingester, querier, query frontend, and compactor

## 2. Point the gateway at the collector

Set:

```dotenv
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

Optional tuning:

```dotenv
OTEL_FLUSH_INTERVAL_MS=5000
FROSTY_OTEL_MODEL_CARDINALITY_CAP=11
```

## 3. Start or restart the gateway

```bash
docker compose up -d gateway
```

## 4. Verify the surfaces

- Gateway health: `http://localhost:8080/healthz`
- Gateway metrics: `http://localhost:8080/metrics`
- Grafana: `http://localhost:3000`
- Prometheus: `http://localhost:9090`
- Tempo query frontend: `http://localhost:3200`
- MinIO console: `http://localhost:9001`

## 5. Understand what is captured

### Metrics

The gateway exposes Prometheus metrics from `/metrics`, including request,
cache, plugin, MCP, and cost-related counters and histograms.

### Traces

When OTLP is enabled, the gateway exports spans through the collector into
Tempo.

### Logs and analytics

Operator-visible log and analytics surfaces remain available from the gateway
itself:

- `/api/logs`
- `/api/logs/stored`
- `/api/analytics`
- `/api/runtime`

## 6. Storage considerations

- Prometheus uses the `prometheus-data` volume.
- Grafana uses the `grafana-data` volume.
- Tempo's WAL uses `tempo-wal`.
- Trace blocks are stored in MinIO, backed by
  `${FROSTY_TEMPO_STORAGE_PATH:-./data/tempo}`.

## 7. Troubleshooting monitoring

- No traces in Tempo: verify `OTEL_EXPORTER_OTLP_ENDPOINT` and check
  `otel-collector` logs.
- Metrics missing: check `GET /metrics` directly before blaming Prometheus.
- Grafana up but empty: confirm the observability profile is running and
  Prometheus is scraping successfully.
- MinIO issues: verify the bucket bootstrap step from `minio-init` completed
  successfully.
