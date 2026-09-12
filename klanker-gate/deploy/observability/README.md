# Frosty Gateway Observability

Optional, fully self-contained observability stack for the Frosty gateway.
It covers two signals:

- **Metrics:** the gateway exposes Prometheus text exposition at `GET /metrics`
  on port `8080`. This folder adds a scrape config, an importable dashboard, and
  Prometheus + Grafana, all auto-provisioned.
- **Traces:** the gateway exports OTLP/HTTP spans (including the `llm.call`
  `gen_ai.*` spans) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The collector
  stores them in **Tempo** for per-request drill-down *and* aggregates them with
  the **spanmetrics** connector into RED metrics (rate, errors, duration) that
  Prometheus scrapes. Both views live in the same Grafana.

Everything here is optional. The services are declared in the root
`docker-compose.yml` behind the **`observability` profile**; this folder holds
only the config files they mount. Nothing modifies the gateway image, and a
plain `docker compose up` starts the gateway alone with trace export off.

## Contents

| File | Purpose |
| ---- | ------- |
| `prometheus.yml` | Scrape config, 15s interval. Jobs `frosty-gateway` (`gateway:8080`), `otel-collector` (`otel-collector:8888`), `otel-spanmetrics` (`otel-collector:8889`). |
| `dashboards/frosty-gateway.json` | Gateway dashboard covering every `frosty_*` metric family (schemaVersion 39, `${DS_PROMETHEUS}` variable). |
| `dashboards/otel-collector.json` | Span RED metrics, `gen_ai.*` breakdowns, collector health, and scrape health. |
| `otel-collector-config.yaml` | Collector config: OTLP receivers (HTTP 4318 / gRPC 4317), the `spanmetrics` connector, exporters to Tempo + `prometheus` on 8889 + `debug`. Own telemetry on 8888. |
| `tempo.yaml` | Tempo config, shared by all five components: OTLP receiver, memberlist discovery, S3 storage. Its metrics_generator is off - the collector owns metrics. |
| `grafana-observer.sh` | Creates/updates the `frosty-observer` Grafana account (Editor). Idempotent; run by the `grafana-provision` container. |
| `provisioning/datasources/datasource.yml` | Auto-wires the Prometheus datasource (uid `prometheus`). |
| `provisioning/dashboards/dashboards.yml` | Dashboard provider that loads the JSON from `/etc/grafana/dashboards`. |

## Run the stack

Run this from the repository root (where `docker-compose.yml` lives):

```bash
docker compose --profile observability up -d
```

Metrics work immediately. **Traces additionally require**
`OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` in `.env` (or the
shell) so the gateway knows where to export; it is not defaulted, because
without this profile the collector host does not exist.

Then open:

- Grafana: <http://localhost:3000>. Anonymous visitors get read-only dashboards;
  the provisioned "Frosty Gateway Observability" is the home page. Explore (trace
  drill-down) needs a login - use `frosty-observer` / `frosty-observer`, or
  `admin` / `admin`.
- Prometheus: <http://localhost:9090> (check "Status -> Targets" to confirm all
  three targets - `frosty-gateway`, `otel-collector`, `otel-spanmetrics` - are
  `UP`).

Tear it all down (add `-v` to also drop the Prometheus and Grafana volumes):

```bash
docker compose --profile observability down
```

### Why it just works

All services live in one Compose project, so `prometheus`, `grafana`, and
`gateway` share the project's default network. Prometheus therefore reaches the
gateway over Docker DNS at `gateway:8080`, which is exactly the default target in
`prometheus.yml`. Grafana provisions the Prometheus datasource and this dashboard
on boot, so there are no manual import steps.

### Relative paths matter

Compose resolves relative bind-mount paths against the directory of the compose
file, which is why the mounts are written as `./deploy/observability/...` and why
the command above must be run from the repository root. If you invoke Compose
from elsewhere, pass `--project-directory /path/to/repo`.

## Traces (OpenTelemetry)

Spans go two places at once: **Tempo** keeps them for per-request drill-down, and
the **spanmetrics** connector aggregates them into RED metrics - **R**ate,
**E**rrors, **D**uration - which Prometheus scrapes. Both surface in the same
Grafana, so you can read the aggregate and then open the exact request behind it.

### The path a span takes

```text
                        +--> otlp/tempo --> tempo-distributor --> MinIO --> Grafana
gateway --OTLP--> otel-collector --+--> spanmetrics --> :8889 --> Prometheus --> Grafana
                        +--> debug -------> docker compose logs
```

1. You set `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` for the
   gateway (in `.env` or the shell). `docker-compose.yml` leaves it empty by
   default, so without this the gateway exports nothing.
2. The gateway sends OTLP/HTTP spans (service `frosty-gateway`, including the
   `llm.call` `gen_ai.*` spans emitted per upstream model call) to the
   `otel-collector` service on the shared Compose network.
3. The traces pipeline fans out. `otlp/tempo` ships the raw spans to
   `tempo-distributor:4317`, which routes them to an ingester that writes blocks
   to MinIO; `spanmetrics` turns them into
   `traces_span_metrics_calls_total` and
   `traces_span_metrics_duration_milliseconds`, promoting the span attributes
   listed under `dimensions` to metric labels; `debug` prints each span to the
   collector's stdout. The three are independent - Tempo being down cannot stop
   metrics.
4. The `prometheus` exporter publishes those metrics on `:8889`, which Prometheus
   scrapes as job `otel-spanmetrics`. The collector's own health metrics are on
   `:8888` (job `otel-collector`).

### The labels you get

| Label | From | Use |
| ----- | ---- | --- |
| `span_name`, `span_kind`, `status_code` | every span | rate / error rate / duration per operation |
| `gen_ai_provider_name` | `gen_ai.provider.name` | which upstream vendor |
| `frosty_metrics_model` | `frosty.metrics.model` (**bounded**) | per-model latency and volume |
| `gen_ai_response_finish_reason` | `gen_ai.response.finish_reason` | truncation (`length`) rate |
| `gen_ai_stream` | `gen_ai.stream` | streaming vs non-streaming split |

The **OpenTelemetry Collector** dashboard graphs all of these.

### Why the model label is bounded

Every `dimension` multiplies the Prometheus series count, and model ids are the
one unbounded dimension - a gateway fronting many models (or one that lets
callers name arbitrary models) would grow the series set without limit.

So the gateway emits **two** model attributes and the connector promotes only one:

| Attribute | Value | Promoted to a label? |
| --------- | ----- | -------------------- |
| `gen_ai.request.model` / `gen_ai.response.model` | the **real** model id, always | **No** - unbounded |
| `frosty.metrics.model` | the real id for the first `FROSTY_OTEL_MODEL_CARDINALITY_CAP` (default 11) distinct models, then `other` | **Yes** |

The consequence is the useful part: a call whose *metric* label folded to `other`
still shows its true model in the *trace*. Find them with
`{name="llm.call" && span.frosty.metrics.model="other"}` in Explore → Tempo.

The **Label cardinality guard** row on the collector dashboard shows how many
models have been dropped, the current distinct-label count, and the series count
per dimension - each panel carrying the full explanation in its tooltip.

### Drilling into a trace

Grafana → **Explore** → **Tempo** datasource, then TraceQL:

```
{name="llm.call"}                                                # every model call
{name="llm.call" && span.gen_ai.request.model="gpt-4o"}          # one model
{name="llm.call" && span.gen_ai.response.finish_reason="length"} # truncated replies
{duration > 5s}                                                  # slow calls
```

From a span, **Trace to metrics** jumps to its RED metrics in Prometheus.

### Confirming spans are flowing

- `docker compose logs -f otel-collector` - the `debug` exporter prints each span.
- `curl -s localhost:8889/metrics | grep traces_span_metrics` - the aggregated output.
- `curl -s localhost:8888/metrics | grep otelcol_receiver_accepted_spans` - a
  zero here means the gateway is not exporting, not that the collector is broken.

Trace export is entirely optional. It only turns on when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set on the gateway. A plain
`docker compose up` runs the gateway with no exporter and no collector.

## Changing the scrape target

The default target is `gateway:8080` for the shared Compose network. To scrape a
gateway running somewhere else, edit `prometheus.yml` and swap the target:

- `host.docker.internal:8080` when the gateway runs on your host and Prometheus
  runs inside Docker Desktop (macOS / Windows).
- `localhost:8080` when Prometheus and the gateway share the host network
  namespace (Linux `network_mode: host`) or both run natively without Docker.

After editing, reload Prometheus with `docker compose ... restart prometheus`
(or `curl -X POST http://localhost:9090/-/reload`, since lifecycle reload is
enabled).

## Importing the dashboards without this stack

If you already run Prometheus and Grafana elsewhere, import
`dashboards/frosty-gateway.json` and `dashboards/otel-collector.json` through the
Grafana UI ("Dashboards -> New -> Import"). Both use a `${DS_PROMETHEUS}`
datasource template variable rather than a hard-coded datasource, so pick your
Prometheus from the "Datasource" dropdown after import. Point your own Prometheus
at the gateway and collector using the same job settings as `prometheus.yml`.

## Metrics reference

The **Frosty Gateway Observability** dashboard covers every metric family the
gateway exposes at `/metrics` - all of the following have at least one panel:

| Metric | Type | Labels | Meaning |
| ------ | ---- | ------ | ------- |
| `frosty_requests_total` | counter | `route`, `status` | HTTP requests handled by the gateway, keyed by route and HTTP status code. |
| `frosty_request_duration_ms` | summary | `route`, `quantile` | Request latency in milliseconds. Quantiles are pre-computed and exposed as `quantile="0.50"`, `"0.95"`, and `"0.99"`. |
| `frosty_input_tokens_total` | counter | `provider`, `model` | Prompt (input) tokens sent to upstream LLM providers. |
| `frosty_output_tokens_total` | counter | `provider`, `model` | Completion (output) tokens returned by upstream LLM providers. |
| `frosty_llm_cost_usd_total` | counter (USD) | `provider`, `model` | Cumulative estimated spend in US dollars, per provider and model. |
| `frosty_cost_usd_total` | counter (USD) | none | Cumulative global spend in US dollars across everything. |
| `frosty_llm_requests_total` | counter | `provider`, `model`, `status_class` | Upstream LLM calls, grouped by outcome class (for example `2xx` / `4xx` / `5xx`). |
| `frosty_cache_events_total` | counter | `result` | Response-cache lookups, where `result` is `hit` or `miss`. |
| `frosty_stream_first_token_latency_ms` | histogram | `le` (`_bucket`/`_sum`/`_count`) | Time to first token on a streamed response. |
| `frosty_stream_inter_token_latency_ms` | histogram | `le` (`_bucket`/`_sum`/`_count`) | Gap between successive streamed tokens. |
| `frosty_counter` | counter | `name` | Generic named counters registered at runtime (plugin events, governance denials, sink failures, and so on). |

Span-derived metrics from the collector (job `otel-spanmetrics`), graphed by the
**OpenTelemetry Collector** dashboard:

| Metric | Type | Labels | Meaning |
| ------ | ---- | ------ | ------- |
| `traces_span_metrics_calls_total` | counter | `span_name`, `span_kind`, `status_code`, `gen_ai_*` | Span count - request rate and, filtered on `status_code`, error rate. |
| `traces_span_metrics_duration_milliseconds` | histogram | same + `le` | Span duration distribution. |

And the collector's own health (job `otel-collector`): `otelcol_receiver_accepted_spans`,
`otelcol_receiver_refused_spans`, `otelcol_exporter_sent_spans`,
`otelcol_exporter_send_failed_spans`, `otelcol_exporter_sent_metric_points`,
`otelcol_exporter_send_failed_metric_points`, `otelcol_processor_batch_*`.

## Dashboard panels

### Frosty Gateway Observability

| Panel | Query summary | Unit |
| ----- | ------------- | ---- |
| Request Volume | `rate(frosty_requests_total)` by route and status | reqps |
| Request Latency percentiles | `frosty_request_duration_ms` by quantile per route | ms |
| Input vs Output Tokens by Model | `rate(frosty_input_tokens_total)` vs `rate(frosty_output_tokens_total)` by model | short |
| LLM Cost Rate by Model | `rate(frosty_llm_cost_usd_total)` by provider and model | currencyUSD |
| Total Cost (USD) | `frosty_cost_usd_total` (cumulative global) | currencyUSD |
| Cache Hit Ratio | `rate(frosty_cache_events_total{result="hit"}) / rate(frosty_cache_events_total)` | percentunit |
| LLM Requests by Status Class | `rate(frosty_llm_requests_total)` by `status_class` | reqps |
| Cache Events by Result | `rate(frosty_cache_events_total)` by `result` | short |
| Time to First Token | `histogram_quantile` p50/p95/p99 + mean over `frosty_stream_first_token_latency_ms` | ms |
| Inter-Token Latency | same over `frosty_stream_inter_token_latency_ms` | ms |
| TTFT distribution | heatmap of `frosty_stream_first_token_latency_ms_bucket` | ms |
| Streamed responses | `rate(..._count)` for both stream histograms | reqps |
| Request Rate by Route | `rate(frosty_request_duration_ms_count)` by route | reqps |
| Internal Counters (events/s) | `rate(frosty_counter)` by `name` | cps |
| Internal Counters (totals) | `frosty_counter` by `name`, instant table | short |
| Token Throughput Total | `sum(rate(frosty_input_tokens_total))` vs output | short |

### OpenTelemetry Collector

| Panel | Query summary | Unit |
| ----- | ------------- | ---- |
| Span Rate by Operation | `rate(traces_span_metrics_calls_total)` by `span_name` | reqps |
| Span Error Rate | `STATUS_CODE_ERROR` share of calls, by `span_name` | percentunit |
| Span Duration percentiles | `histogram_quantile` p50/p95/p99 by `span_name` | ms |
| llm.call duration distribution | heatmap of the duration histogram for `span_name="llm.call"` | ms |
| llm.call Rate by Provider and Model | by `gen_ai_provider_name` / `gen_ai_request_model` | reqps |
| llm.call p95 Latency by Model | `histogram_quantile(0.95)` by `gen_ai_request_model` | ms |
| Finish Reasons | by `gen_ai_response_finish_reason`, stacked | reqps |
| Streaming vs Non-Streaming | by `gen_ai_stream`, stacked | reqps |
| Spans Accepted / Refused / Export Failures / Collector Up | `otelcol_*` and `up` stats | short |
| Receiver Throughput | accepted vs refused spans/s by transport | cps |
| Exporter Throughput | sent + failed spans and metric points by exporter | cps |
| Batch Processor Send Size | `otelcol_processor_batch_batch_send_size` percentiles | short |
| Batch Timeout Triggers & Cardinality | timeout-triggered sends and metadata cardinality | short |
| Target Up / Scrape Duration | `up` and `scrape_duration_seconds` for all three jobs | short / s |

Rate panels use Grafana's `$__rate_interval` so the window tracks the 15s scrape
interval automatically.

## Notes and caveats

- This stack is for local development and evaluation. Before production, add
  authentication and TLS in front of Grafana and Prometheus, set a real Grafana
  admin password, configure retention and `remote_write`, and add alerting. Watch
  spanmetrics label cardinality too: every `dimensions` entry multiplies the
  series count.
- The gateway does not need to be aware of this stack. Prometheus tolerates the
  target being down and will start scraping as soon as the gateway is reachable,
  so start order does not matter.
- Cost figures are estimates derived from token counts and per-model pricing, not
  billing-grade numbers.
