# Installation

This tutorial covers the shortest verified path to a working Frosty Deno
installation.

## Prerequisites

- Git
- Deno 2.9.x
- Docker and Docker Compose v2.20+ if you want PostgreSQL and optional
  observability through the shipped Compose assets

Notes:

- The main project does not use the npm CLI for the gateway or the control UI.
- PostgreSQL is a hard dependency for the production bootstrap path.
- Node and `npx` are only required for the separate `tests/browser` Playwright
  harness.

## 1. Clone the repository

```bash
git clone <your-repository-url> klanker-gate
cd klanker-gate
```

## 2. Bootstrap Deno-managed dependencies

```bash
deno task setup
```

This installs the `npm:esbuild` script dependency used by the control UI build.

## 3. Start PostgreSQL

The quickest path is the included Compose service:

```bash
docker compose up -d postgres
```

This gives you the default local connection used in `.env.example`:

```text
postgres://frosty:frosty@localhost:5432/frosty
```

## 4. Create your `.env`

Copy the checked-in example and edit it for your environment:

```bash
cp .env.example .env
```

At minimum, set:

- one provider credential such as `OPENAI_API_KEY`
- `FROSTY_PG_URL`

Optional but recommended for any non-local environment:

- `FROSTY_ADMIN_TOKEN`
- `FROSTY_ALLOWED_HOSTS`
- `FROSTY_ENCRYPTION_KEY`

## 5. Start the gateway

```bash
deno task dev
```

Verified behavior of this command:

- loads `.env`
- starts the gateway on `http://localhost:8080`
- watches the gateway files for reloads

If PostgreSQL is unreachable, the production bootstrap path fails closed instead
of starting with empty state.

## 6. Verify the install

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/v1/models
```

If you built the UI, `http://localhost:8080/` will serve the control plane from
the same origin as the API.

## 7. Build the control UI

The gateway serves API-only until the UI bundle exists.

```bash
deno task build-ui
```

After that, restart or keep the gateway running and visit:

```text
http://localhost:8080/
```

## What you have now

At this point you have:

- a running gateway on port 8080
- PostgreSQL-backed durable state
- at least one configured provider if you supplied credentials
- an optional same-origin operator UI if you built the control plane

Continue with [02-configuration.md](./02-configuration.md) to configure
providers, governance, logging, cache, and admin protection.
