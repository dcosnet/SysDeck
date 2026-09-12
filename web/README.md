# SysDeck — the standalone web console

SysDeck's browser-native front end: 30 bridge modules behind one
console, every one of them reading **real host state** — /proc and /sys
collectors, systemctl, lsblk, the host's real package manager, live
service APIs — with honest empty inventories (and install guidance)
where a backend is absent. Nothing is demo, mock, or seeded. You sign
in with your Unix account (the host PAM stack, exactly like Cockpit),
every installed Cockpit module loads into this console's navigation,
and every SysDeck module can likewise be loaded inside Cockpit — one
module catalog, two front ends. The Fester DAG orchestrator is vendored
as a dedicated service (`mini-services/fester`) and the klanker-gate LLM
gateway alongside with Arch packaging. klanker-gate ("Frosty Deno") is by TykoDev
(https://github.com/TykoDev/klanker-gate, Apache-2.0) — **not SysDeck
code**; see `../klanker-gate/ATTRIBUTION.md` and `../THIRD_PARTY.md`.

**This is a complete standalone application.** No Cockpit, no Python
bridge, no systemd, no root — one Next.js process serves the whole
console. This README is the full standalone runbook; the web console
ships the same content as the "Run without Cockpit" panel (system group,
right under Overview) with copy buttons on every command.

## 1. Prerequisites

- **Bun >= 1.1** — `pacman -S bun` on Arch, or
  `curl -fsSL https://bun.sh/install | bash` elsewhere.
  (Node-only hosts work too — see the node path in §3.)
- ~200 MB disk for dependencies, ~512 MB RAM. SQLite is bundled via
  Prisma — no database server.
- **Not required:** Cockpit, systemd, Docker, root. Runs as an
  unprivileged user on any Linux/BSD/macOS.

## 2. Quickstart — dev

From the extracted master tarball root, one command does everything
(install + migrate + fester + web):

    tar xjf sysdeck-0.4.3-master.tar.bz2
    cd sysdeck-0.4.3-master
    make web-dev        # bun install + db:push + fester + next dev :3000

Granular equivalent (what `make web-dev` does):

    cd sysdeck-0.4.3-master/web
    bun install                     # dependencies
    bun run db:push                 # create + migrate db/custom.db (SQLite)
    bun run dev                     # Next.js on :3000

    # optional — the Fester DAG orchestrator (own service, :3010):
    cd mini-services/fester
    bun install
    bun run dev                     # bun --hot index.ts

Open http://localhost:3000 — you'll get the **login screen**: sign in
with a **Unix account** (verified by the host PAM stack, the same
mechanism Cockpit uses; see §10 and `SYSDECK_AUTH_MODE` in §5). The
Fester panel proxies REST through
`/api/fester` (server-side) and streams live build events over
WebSocket through the port gateway (`/?XTransformPort=3010`). Without
the service running, the Fester panel says so — everything else works.

## 3. Production build

The build emits a self-contained standalone server
(`.next/standalone/` with static assets and public/ folded in):

    cd web
    bun install
    bun run build                   # next build + fold static/ & public/
    PORT=3000 HOSTNAME=0.0.0.0 bun run start

Node-only hosts:

    bun run build                    # or: npx next build
    PORT=3000 HOSTNAME=0.0.0.0 node .next/standalone/server.js

Run `bun run db:push` once before the first production start — the
SQLite file lives at `db/custom.db` (path from `DATABASE_URL` in
.env). Keep the bundle layout intact so `../db` resolves.

## 4. systemd services (Arch Linux)

Deploy the extracted bundle to `/opt/sysdeck` and run:

`/etc/systemd/system/sysdeck-web.service`

    [Unit]
    Description=SysDeck standalone web console (Next.js)
    After=network-online.target

    [Service]
    Type=simple
    User=sysdeck
    WorkingDirectory=/opt/sysdeck/web
    Environment=PORT=3000
    Environment=HOSTNAME=0.0.0.0
    Environment=NODE_ENV=production
    ExecStart=/usr/bin/bun run start
    Restart=on-failure
    RestartSec=3

    [Install]
    WantedBy=multi-user.target

`/etc/systemd/system/sysdeck-fester.service`

    [Unit]
    Description=SysDeck Fester — DAG build orchestration
    After=network-online.target sysdeck-web.service

    [Service]
    Type=simple
    User=sysdeck
    WorkingDirectory=/opt/sysdeck/web/mini-services/fester
    ExecStart=/usr/bin/bun index.ts
    Restart=on-failure
    RestartSec=3

    [Install]
    WantedBy=multi-user.target

Enable:

    sudo useradd -r -d /opt/sysdeck -s /usr/sbin/nologin sysdeck || true
    sudo systemctl enable --now sysdeck-web.service sysdeck-fester.service

## 5. Environment reference (.env in web/)

| variable             | default               | purpose                                        |
|----------------------|-----------------------|------------------------------------------------|
| `DATABASE_URL`       | `file:../db/custom.db`| SQLite file for theme, baselines, runs (Prisma)|
| `KLANKER_URL`        | —                     | AI Gateway panel → live gateway (e.g. http://127.0.0.1:8080) |
| `KLANKER_ADMIN_TOKEN`| —                     | admin token for that gateway (FROSTY_ADMIN_TOKEN) |
| `PORT` / `HOSTNAME`  | `3000` / `localhost`  | standalone server bind (use 0.0.0.0 for LAN)  |
| `SYSDECK_AUTH_MODE` | `pam` | unix login policy: `pam` (host PAM only — run as root), `pam+local` (PAM first, SdUser scrypt fallback), `local` (console accounts only) |
| `SYSDECK_PAM_SERVICE` | `sysdeck` | PAM stack to use; falls back to `login` when `/etc/pam.d/sysdeck` is absent |
| `SYSDECK_PYTHON` | `python3` | interpreter that runs `scripts/pam-auth.py` |
| `SYSDECK_PAM_TIMEOUT_MS` | `8000` | hard timeout for one PAM authentication |
| `SYSDECK_COCKPIT_SCAN` | — | extra cockpit module scan roots (colon-separated) for staged/DESTDIR trees — detection also always covers /usr/share/cockpit and /usr/local/share/cockpit |
| `SYSDECK_SESSION_SECURE` | off | set `1` to add the `Secure` cookie flag (front the console with TLS first) |
| `SYSDECK_MUTATIONS` | `admin` | mutation policy: `admin` gates mutating bridge commands behind an admin session (wheel/sudo/adm or uid 0) — reads stay open to every signed-in unix account; `any` restores the single-operator posture |
| `SYSDECK_TRUST_PROXY` | off | set `1` to honor `X-Forwarded-For` for rate-limit identity — only behind a trusted proxy; client-supplied headers are ignored by default |

With no `KLANKER_URL`, the AI Gateway panel renders honest empty
tables (they fill with LIVE data automatically when the gateway
answers).

## 6. Reverse proxy + WebSocket gateway

The bundled `Caddyfile` implements the port-gateway pattern: every
request carrying `?XTransformPort=<port>` is forwarded to that
localhost port (this is how the Fester event stream crosses the single
public port). Adapt the listener to your domain:

    sysdeck.example.com {
        @ws query XTransformPort=*
        handle @ws {
            reverse_proxy localhost:{query.XTransformPort}
        }
        handle {
            reverse_proxy 127.0.0.1:3000
        }
    }

nginx equivalent:

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;    # websocket (XTransformPort=3010)
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

## 7. Troubleshooting

- **PrismaClientInitializationError / "database not found"** — run
  `bun run db:push` in `web/`; check `DATABASE_URL` points at
  `db/custom.db` relative to the bundle layout.
- **Port 3000 already in use** — `PORT=3001 bun run dev`.
- **Panels show a DEMO badge** — expected: the host lacks that backend
  (docker/kubectl/pacman). Panels badged LIVE read real /proc, /sys,
  lsblk data.
- **Fester panel says service unreachable** — start it:
  `(cd mini-services/fester && bun run dev)`.
- **AI Gateway tables are empty** — set `KLANKER_URL` +
  `KLANKER_ADMIN_TOKEN` in `web/.env`, restart, or install the gateway
  via `../klanker-gate/arch/INSTALL-ARCH.md`.
- **Edits not appearing** — dev recompiles on save (check dev.log);
  production needs `bun run build` again.

## 8. Wiring the vendored services

- **Fester** — vendored at `mini-services/fester` (independent version
  0.2.1, own package). Start it as in §2; the panel connects on its own.
- **AI Gateway (klanker-gate)** — the `klanker-gate/` tree sits next to
  this `web/` directory in the master tarball: the Frosty Deno LLM
  gateway (Deno 2 + TypeScript, own version 0.9.0), with complete Arch
  packaging under `arch/` (PKGBUILD, hardened systemd unit, run wrapper,
  `INSTALL-ARCH.md` runbook). **Upstream credit:** klanker-gate is by
  TykoDev — https://github.com/TykoDev/klanker-gate (Apache-2.0) — and
  is not SysDeck code; it is vendored unmodified (SysDeck adds only
  `arch/`), see `../klanker-gate/ATTRIBUTION.md` and `../THIRD_PARTY.md`.
  Point the panel at a running gateway via `.env`:

      KLANKER_URL=http://127.0.0.1:8080
      KLANKER_ADMIN_TOKEN=<FROSTY_ADMIN_TOKEN>

- **Local stack (ollama · llama.cpp · koboldcpp · LM Studio · SGLang ·
  vLLM)** — the gateway is *not* SaaS-only: `ollama`/`lmstudio`/`sgl`
  are native keyless provider types, and llama-server/KoboldCpp/vLLM
  plug in via the generic `openai-compatible` type (base URL + optional
  key). No API key is required anywhere. The AI Gateway panel ships a
  **Local stack wiring** card that live-probes each backend's
  `/v1/models` from the host and shows the env + admin-API recipes with
  copy buttons. Env wiring:

      OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
      OLLAMA_MODELS=qwen3:14b,llama3.1:8b,nomic-embed-text
      LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
      OPENAI_COMPAT_BASE_URL=http://127.0.0.1:8081/v1

  Env registers ONE openai-compatible account — to run llama.cpp AND
  koboldcpp side by side, register each via the admin API
  (`POST /api/providers`, then `refresh-models` auto-discovers the
  catalog). Port note: llama-server defaults to :8080, the gateway's
  own port — run it on 8081 or move the gateway. Full recipes:
  QUICKSTART §10.1 in the bundle root.

## 9. Layout

- `src/lib/sysdeck/` — module registry + bridge dispatcher modules
- `src/app/api/bridge` — the bridge endpoint (POST {module, command, args})
- `src/app/api/fester` — server-side proxy to the fester service
- `src/app/api/release` — master-tarball release metadata
- `src/components/sysdeck/` — panels + shared UI primitives
- `mini-services/fester` — the vendored Fester service (own package, v0.2.1)

**Module toggles:** every sidebar module can be turned off (hover a row
→ power icon) and back on from the **Disabled (N)** section — hidden
from navigation and the ⌘K palette while off, persisted in SQLite
(`shell.disabled`), audited, and survives restarts. Overview is
protected. Switched away from the AI Gateway to another stack? Turn it
off in one click; its bridge commands stay available for scripts.

`db/custom.db` is created by `bun run db:push` using `DATABASE_URL` from
`.env`. The master tarball builder lives at `scripts/make-master-tarball.sh`
in the canonical development tree. The cockpit edition (bundle root,
`sudo make install`) remains available but is entirely optional; the two
front ends share one module catalog (every module ships both a web bridge
and a cockpit manifest). Since 0.3.0 the cockpit plugin pages wear this
console's skin
(`shared/sysdeck-web.css`), with `sudo make install-branding` theming the
Cockpit shell chrome to match (see ../QUICKSTART.md §12).

## 10. Security posture

This is a **single-operator console**: the web app, the fester service and
the AI Gateway panel assume the person at the machine is the operator. The
0.3.0 security audit shaped the shipped defaults around that contract:

- **Loopback binding by default.** `bun run dev` starts Next.js on
  `127.0.0.1:3000` and the fester service binds `127.0.0.1:3010` — no
  LAN exposure without an explicit act (change the bind, add a reverse
  proxy, forward the port). The production `start` script pins
  `HOSTNAME=127.0.0.1` the same way.
- **Unix-account login (since 0.4.0), the Cockpit way.** The username
  + password pair is verified by the **host's PAM stack**
  (`scripts/pam-auth.py`, a stdlib ctypes client of libpam; service
  `sysdeck` when `/etc/pam.d/sysdeck` exists, else the stock `login`
  stack; credentials over stdin, never argv). Success buys an
  HMAC-signed HttpOnly session cookie **bound to the username**
  (`v2.<exp>.<userB64>.<hmac>`, 12h). The page server-renders a login
  screen until the cookie verifies, every `/api/*` route answers 401
  until signed in, and the fester service verifies the identical token
  on its REST + WebSocket surface straight from the shared SQLite
  secret — no unauthenticated path into the console's data.
- **Auth modes + root.** pam_unix needs root to verify *arbitrary*
  users (non-root only gets the invoking uid via `unix_chkpwd`), so:
  run the service as root (like cockpit-ws) for any-account login
  (`SYSDECK_AUTH_MODE=pam`, the default), or run unprivileged with
  `pam+local` — PAM first, then the `SdUser` scrypt table managed by
  `bun scripts/manage-users.mjs list|add|passwd|disable|enable|remove`.
  Failures rate limit per-IP **and** per-username (5/min each), wrong
  user and wrong password look identical, and a wedged PAM helper
  fails CLOSED. 0.3.1 v1 tokens still verify as legacy sessions so
  upgrades don't log anyone out. Still LAN-side posture: loopback binds
  stay the outer boundary (see ../QUICKSTART.md §10.4).
- **Guards stay layered under the login.** The bridge endpoint
  allowlists every module+command, caps request bodies at 256 KB,
  applies a per-IP rate limit, and returns generic errors (full detail
  goes to the server log, not the response).
- **SQL is parameterized everywhere** (Prisma on the app, bound
  parameters in fester's bun:sqlite); **no bridge command passes
  client strings to a shell** — the one spawn helper uses fixed argv
  arrays; **no filesystem path is built from client input** — every
  path is a hardcoded constant.
- **Secrets stay server-side.** `KLANKER_ADMIN_TOKEN` exists only in
  `.env` and the `Authorization` header; it is never echoed to any
  panel, response or log.
- If you DO expose the console (reverse proxy, tailscale, etc.), put
  authentication in front of it first — the bridge can mutate system
  state (netsec bans, service ports, module toggles) and it trusts
  whoever can reach it.
