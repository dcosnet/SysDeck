# klanker-gate — Upstream Security Review (SysDeck 0.3.0 audit)

**Reviewed:** vendored klanker-gate 0.9.0 ("Frosty Deno"), commit as shipped in
sysdeck-0.3.0-master.tar.bz2 — Deno 2 + TypeScript monorepo.
**Reviewed by:** the SysDeck project, as part of the 0.3.0 full-codebase
security audit (SysDeck's own cockpit/web code was audited and fixed in the
same pass; this file documents what we found in **upstream code**).
**Scope:** apps/gateway (routes, main), packages/{config,core,providers,
governance,cache,mcp,telemetry}, apps/control-ui, Dockerfile, docker-compose,
deploy/, deno.jsonc, scripts/.
**Not modified:** per the vendoring contract (ATTRIBUTION.md), SysDeck ships
this tree **unmodified** — zero source changes. Mitigations for the findings
below are applied at SysDeck's packaging layer (`arch/`), documented per
finding. This file is also written so the findings can travel upstream:
everything below is intended to be actionable for TykoDev.

**Threat model used:** an attacker on the same LAN as the host; an attacker
holding one virtual key; a malicious configured provider; XSS in the Control
UI. A single-operator loopback deployment is the *easy* case; we also judged
the default fresh-install posture for a host where the operator just runs
`docker compose up` or `deno run` without reading the env reference.

---

## Findings (ordered by severity)

### U-1 — CRITICAL — Admin API is fully unauthenticated when FROSTY_ADMIN_TOKEN is unset

`apps/gateway/routes/admin.ts:380-381`:

```ts
if (!adminToken) {
  return await next(req); // explicit local-admin mode
```

With `FROSTY_ADMIN_TOKEN` unset (the default in `.env.example` — blank), every
`/api/*` route (settings, provider CRUD incl. API keys, virtual-key creation,
logs, cache clear, `/api/config/export?include_secrets=true`) is open to
whoever can reach the port. Combined with U-2 (bind), that is the whole
control plane on the LAN. The origin guard (origin-guard.ts) only constrains
browser-shaped requests (Host/Origin headers) and is trivially satisfied by
`Host: localhost` on a direct connection.

**Suggested upstream fix:** generate a random admin token at first boot and
print it once to the journal (like the vkey-at-creation flow), or refuse to
serve `/api/*` off-loopback in no-token mode.

**SysDeck packaging mitigation:** `arch/klanker-gate.service` ships an
`ExecStartPre` guard that fails closed when the token is empty (opt-out via
documented drop-in); `arch/env.example` documents the requirement.

### U-2 — CRITICAL — Gateway binds all interfaces by default

`apps/gateway/main.ts:224-227`:

```ts
Deno.serve(
  isWorkerChild() ? { port, reusePort: true } : { port },
  createHandler(ctx),
);
```

No `hostname` option anywhere; Deno defaults to `0.0.0.0`. The boot log even
prints `http://localhost:${port}` (main.ts:203), which understates the real
binding. Docker publishing (`docker-compose.yml:19`, `"8080:8080"`) inherits
the same all-interfaces posture.

**Suggested upstream fix:** default `hostname: "127.0.0.1"`, make it
overridable via `HOST`/`FROSTY_BIND` env (a one-line change in main.ts), and
print the true binding in the boot log.

**SysDeck packaging mitigation:** documented (INSTALL-ARCH.md §9) with a
firewall one-liner; the token guard above closes the worst consequence. The
bind itself cannot be changed from the packaging layer without modifying
upstream source, which the vendoring contract forbids.

### U-3 — CRITICAL — Inference endpoints are open while zero virtual keys exist

`apps/gateway/routes/governance.ts:501-506`:

```ts
if (!governed || !ctx.virtualKeys.active()) {
  return await next(req); // no keys yet → open access by design
}
```

Until the operator creates the first vkey, `/v1/*` (and `/genai/`, `/cohere/`,
`/mcp`, `/openrouter/*`) answer to anyone who can reach the port — an open
proxy onto the operator's provider spend. Keyless-while-keyless is a
chicken-and-egg convenience, but the window is the fresh-install window,
exactly when the operator has not read the docs yet.

**Suggested upstream fix:** require a vkey (or loopback peer) whenever any
provider account carries credentials; alternatively gate `/mcp` tools/call
behind the admin token.

**SysDeck packaging mitigation:** none possible without source changes —
documented here + INSTALL-ARCH.md §9 tells operators to create a vkey
immediately.

### U-4 — HIGH — Docker Compose publishes Postgres with default credentials

`deploy/vector-stores/docker-compose.yml:23-27` publishes `5432:5432` with
`POSTGRES_USER: frosty / POSTGRES_PASSWORD: frosty`; the root compose defaults
`FROSTY_PG_URL` to those credentials. All durable state (provider accounts,
virtual keys, governance, logs) becomes LAN-writable.

**Suggested upstream fix:** drop the host port publish (compose networking
suffices for the app) or bind `127.0.0.1:5432:5432` and require a generated
password. Same pattern for the observability profile defaults
(`GF_SECURITY_ADMIN_PASSWORD:-admin`, MinIO `tempo`/`tempo-secret`,
ports 3000/9001/9090 on all interfaces).

**SysDeck packaging mitigation:** not applicable (SysDeck's arch package uses
the host postgres, no compose); documented for compose users.

### U-5 — MEDIUM — `/mcp` JSON-RPC bypasses the admin-token middleware

`routes/admin.ts:386-388` — `adminAuthMiddleware` matches only `/api/*` and
`/metrics`; `POST /mcp` (routes/mcpserver.ts) is governed solely by the
virtual-key check (U-3). With a token set but no vkeys, an unauthenticated
LAN client can drive MCP `tools/call` (outbound fetches; the side-effect gate
is a client-set header, mcpserver.ts:86). With vkeys active this is closed.

**Suggested upstream fix:** include `/mcp` in the admin-token surface.

### U-6 — MEDIUM — Security settings in the Control UI are cosmetic

`routes/settings.ts:29-38` documents it itself: "security settings are
persist + reflect only, and none is wired into adminAuthMiddleware" — an
operator toggling `passwordProtect` in the UI gets zero protection.

**Suggested upstream fix:** wire the switches to the middleware or remove
them from the settings page.

### U-7 — MEDIUM — Admin-token comparison is not constant-time

`routes/admin.ts:392-393` uses `auth !== \`Bearer ${adminToken}\`` (plain
string compare). Theoretical LAN timing oracle; the vkey path already does
SHA-256-then-compare (virtual_keys.ts:14-16) — the admin token should match
its own house style.

### U-8 — LOW — Provider `baseUrl` accepts any URL scheme

`packages/contracts/src/config.ts:268` (`baseUrl: z.string().optional()`) +
`packages/providers/src/openai.ts:68` (concatenated into the fetch URL). Deno
`fetch` will follow `file://`, and `169.254.169.254` (cloud metadata) is not
blocked. Admin-only configuration, so this is by-design SSRF surface for a
gateway — but a scheme/host guard on upsert (mirror the
`assertHttpsUrl`/link-local guard that pricing_sync.ts:79 already implements)
would harden it. Same note for `packages/mcp/src/client.ts:14`.

### U-9 — LOW — Upstream response headers are forwarded with a denylist

`routes/helpers.ts:144-150` copies upstream headers to the client, filtering
only 3 framing headers. A malicious configured provider can set `Set-Cookie`
(and arbitrary headers) against the gateway origin. An allowlist would be
tighter.

### U-10 — INFO — Unauthenticated version disclosure; log URL verbosity

`/healthz` and `/api/version` disclose the Deno/V8 versions without auth
(main.ts:62-76). `core/middleware.ts:65,71` logs full request URLs (query
strings) to stdout — gateway auth is header-based, so no secret leak today,
but query-token schemes would land in the journal.

---

## What upstream does well (kept as-is, for the record)

1. **Crypto layer (packages/config/src/crypto.ts):** AES-256-GCM envelope
   encryption with AAD bound to (KV path, field path, version), PBKDF2-SHA256
   at 600k iterations, non-extractable DEK, boot canary, fail-closed on key
   mismatch. All randomness via `crypto.getRandomValues`.
2. **Virtual-key hygiene:** 24-byte CSPRNG tokens, SHA-256-hashed at rest,
   raw token stripped from persistence and shown exactly once at creation.
3. **Request admission chain:** origin/DNS-rebind guard → admin token →
   governance → telemetry, applied before any handler; 25 MB body cap
   enforced pre-parse (helpers.ts:21); provider views redacted
   (`redactProviderAccount`) so keys never echo back.
4. **Log discipline:** request logs carry method/path/status/model/tokens/
   cost only; content capture is opt-in (`FROSTY_LOG_CONTENT`) with deep
   secret-redaction regexes (logbus.ts).
5. **Code Mode sandbox:** untrusted code executes in a deny-all-permissions
   Worker with an empirical boot probe (worker.ts:140 `new Function` is the
   only eval-shaped call in the tree, and it lives inside that sandbox).
6. **Control UI:** token in sessionStorage (not localStorage), same-origin
   relative-path fetches, React auto-escaping (a test asserts `<script>` is
   escaped), no markdown/HTML rendering of API data.
7. **Nothing phones home:** the only outbound telemetry is OTLP export,
   enabled solely when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; the LiteLLM
   pricing sync is default-off, env-only URL, https-enforced, byte-capped.

## SysDeck-side mitigations shipped alongside this file

| Finding | Mitigation in `arch/` |
| --- | --- |
| U-1 | `klanker-gate.service` ExecStartPre fails closed without a token (opt-out drop-in documented) |
| U-2 | `INSTALL-ARCH.md` §9: firewall/loopback guidance (bind itself is upstream code — unchanged) |
| U-3 | `INSTALL-ARCH.md` §9: "create a vkey immediately" runbook step |
| U-4 | documented for compose users (arch package uses host postgres) |
| U-5..U-10 | documented; no packaging-layer lever without source changes |

The SysDeck klanker panels (cockpit + web) never send or store the admin
token anywhere except the `Authorization` header of calls to the gateway, and
never echo it back — that contract is unchanged by this audit.
