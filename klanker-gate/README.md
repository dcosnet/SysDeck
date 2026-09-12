# Frosty Deno LLM Gateway

[![Deno](https://img.shields.io/badge/Deno-2.9-white?logo=deno&logoColor=black)](https://deno.com)
[![Version](https://img.shields.io/badge/version-0.9.0-blue.svg)](CHANGELOG.md)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![API](https://img.shields.io/badge/API-OpenAI--compatible-green.svg)](docs/reference/api-endpoints.md)

Frosty Deno is a clean-room Deno 2 + TypeScript LLM gateway with a same-origin
React control plane. One gateway surface fronts 20+ provider types behind
OpenAI-compatible APIs, adds governance and pricing controls, optional exact or
semantic caching, MCP integration, and telemetry, and stores durable state in
PostgreSQL.

## Overview

This repository is for teams that want one operational surface for many model
providers instead of many separate SDKs, credential stores, budget systems, and
observability paths. Frosty Deno gives you one API boundary, one operator
control plane, one governance layer, and one place to wire caching, logging,
metrics, tracing, and MCP tooling.

## Key features

- One gateway surface for chat, completions, embeddings, images, audio, files,
  batches, and provider-specific compatibility families.
- Built-in governance with virtual keys, rate limits, request and cost budgets,
  team and customer rollups, and pricing-aware metering.
- Same-origin control plane for providers, settings, logs, runtime diagnostics,
  pricing, cache, and MCP management.
- Optional exact and semantic cache backed by PostgreSQL and pgvector.
- Optional observability profile with Prometheus, Grafana, OTEL Collector,
  MinIO, and Tempo.

## Getting started

Prerequisites:

- Deno 2.9.x
- Docker and Docker Compose v2.20+ if you want the shipped PostgreSQL service

Fastest verified local path:

```bash
git clone <your-repository-url> klanker-gate
cd klanker-gate
deno task setup
cp .env.example .env
docker compose up -d postgres
deno task dev
```

At minimum, set one provider credential and `FROSTY_PG_URL` in `.env`.

Useful checks:

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/v1/models
```

Build the control UI when you want the same-origin operator interface:

```bash
deno task build-ui
```

## Documentation

Start with [docs/index.md](docs/index.md).

- Tutorials: [docs/getting-started/](docs/getting-started/)
- Guides: [docs/guides/](docs/guides/)
- Concepts: [docs/concepts/](docs/concepts/)
- Design: [docs/design/ui-design.md](docs/design/ui-design.md)
- Reference: [docs/reference/](docs/reference/)

## Contributing

Contribution workflow, setup, and validation expectations are documented in
[CONTRIBUTING.md](CONTRIBUTING.md) and [CONDUCT.md](CONDUCT.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
