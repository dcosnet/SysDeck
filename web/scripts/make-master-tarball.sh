#!/usr/bin/env bash
# SysDeck master tarball builder
#
# Bundles into ONE distributable (sysdeck-<version>-master.tar.bz2):
#   /            — the cockpit edition (bridge/ + plugins/ + shared/ + docs)
#   /web         — the SysDeck Web Edition (this Next.js project)
#   /web/mini-services/fester — Fester, vendored + pre-integrated
#   /klanker-gate — the Frosty Deno LLM gateway by TykoDev
#                  (https://github.com/TykoDev/klanker-gate, Apache-2.0 —
#                  NOT SysDeck code), vendored + pre-integrated
#                  (with arch/ packaging: PKGBUILD + systemd + runbook)
#
# Preconditions:
#   - master-build/cockpit/ holds the staged + upgraded cockpit tree
#     (fester.py / klanker.py / bridge.js upgraded, Makefile at 0.4.4)
#   - master-build/klanker-gate/ holds the vendored gateway tree + arch/
#
# Output:
#   public/download/sysdeck-<version>-master.tar.bz2 (+ .sha256)
#   download/ (sandbox mirror)
set -euo pipefail

VERSION="0.4.4"
NAME="sysdeck-${VERSION}-master"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_PARENT="$ROOT/master-build"
STAGE="$STAGE_PARENT/$NAME"
OUT_DIR="$ROOT/public/download"
OUT="$OUT_DIR/$NAME.tar.bz2"

echo ">>> Building $NAME"

# ── guards: the cockpit tree must be upgraded before packing ──────────
grep -q 'start-build' "$STAGE_PARENT/cockpit/bridge/fester.py" || {
    echo "FAIL: master-build/cockpit/bridge/fester.py is not upgraded (no start-build subcommand)"; exit 1; }
grep -q 'VERSION := 0.4.4' "$STAGE_PARENT/cockpit/Makefile" || {
    echo "FAIL: master-build/cockpit/Makefile is not bumped to 0.4.4"; exit 1; }
test -f "$STAGE_PARENT/cockpit/bridge/klanker.py" || {
    echo "FAIL: master-build/cockpit/bridge/klanker.py missing"; exit 1; }
grep -q '"journal"' "$STAGE_PARENT/cockpit/bridge/klanker.py" || {
    echo "FAIL: bridge/klanker.py lacks the journal subcommand"; exit 1; }
test -d "$STAGE_PARENT/cockpit/plugins/sysdeck-klanker" || {
    echo "FAIL: master-build/cockpit/plugins/sysdeck-klanker missing"; exit 1; }
test -f "$STAGE_PARENT/klanker-gate/arch/PKGBUILD" || {
    echo "FAIL: master-build/klanker-gate/arch/PKGBUILD missing (Arch packaging)"; exit 1; }
grep -q 'klanker' "$STAGE_PARENT/cockpit/shared/bridge.js" || {
    echo "FAIL: shared/bridge.js has no klanker surface"; exit 1; }

# klanker-gate upstream attribution (user directive: credit TykoDev —
# https://github.com/TykoDev/klanker-gate — it is not SysDeck code)
test -f "$STAGE_PARENT/klanker-gate/ATTRIBUTION.md" || {
    echo "FAIL: klanker-gate/ATTRIBUTION.md missing (upstream credit)"; exit 1; }
grep -q 'TykoDev/klanker-gate' "$STAGE_PARENT/klanker-gate/ATTRIBUTION.md" || {
    echo "FAIL: klanker-gate/ATTRIBUTION.md lacks the TykoDev source URL"; exit 1; }
grep -q 'TykoDev/klanker-gate' "$STAGE_PARENT/cockpit/THIRD_PARTY.md" || {
    echo "FAIL: THIRD_PARTY.md lacks the klanker-gate/TykoDev entry"; exit 1; }
grep -q 'TykoDev/klanker-gate' "$STAGE_PARENT/klanker-gate/arch/PKGBUILD" || {
    echo "FAIL: arch/PKGBUILD lacks upstream attribution (or wrong url=)"; exit 1; }
grep -q 'TykoDev/klanker-gate' "$STAGE_PARENT/cockpit/plugins/sysdeck-klanker/klanker.js" || {
    echo "FAIL: sysdeck-klanker panel lacks visible upstream attribution"; exit 1; }
grep -q 'TykoDev/klanker-gate' "$STAGE_PARENT/cockpit/bridge/klanker.py" || {
    echo "FAIL: bridge/klanker.py lacks the upstream attribution header"; exit 1; }
grep -q 'TykoDev/klanker-gate' "$ROOT/src/components/sysdeck/panels/klankerPanel.tsx" || {
    echo "FAIL: web klankerPanel.tsx lacks visible upstream attribution"; exit 1; }
grep -q 'TykoDev/klanker-gate' "$ROOT/src/lib/sysdeck/bridge/klanker.ts" || {
    echo "FAIL: web bridge/klanker.ts lacks the upstream attribution header"; exit 1; }

# local-stack support (klanker localstack + Local stack wiring cards)
grep -q '"localstack"' "$STAGE_PARENT/cockpit/bridge/klanker.py" || {
    echo "FAIL: bridge/klanker.py lacks the localstack subcommand"; exit 1; }
grep -q 'localstack' "$STAGE_PARENT/cockpit/plugins/sysdeck-klanker/klanker.js" || {
    echo "FAIL: sysdeck-klanker panel lacks the local stack card"; exit 1; }
grep -q 'localstack' "$STAGE_PARENT/cockpit/shared/bridge.js" || {
    echo "FAIL: shared/bridge.js lacks the klanker.localstack method"; exit 1; }
grep -q 'localstack' "$ROOT/src/lib/sysdeck/bridge/klanker.ts" || {
    echo "FAIL: web bridge klanker.ts lacks the localstack command"; exit 1; }
grep -q 'Local stack wiring' "$ROOT/src/components/sysdeck/panels/klankerPanel.tsx" || {
    echo "FAIL: web klankerPanel.tsx lacks the Local stack wiring card"; exit 1; }
grep -q '10.1' "$STAGE_PARENT/cockpit/QUICKSTART.md" || {
    echo "FAIL: QUICKSTART lacks the local-stack section (10.1)"; exit 1; }

# module visibility toggles (shell bridge + sidebar power controls)
test -f "$ROOT/src/lib/sysdeck/bridge/shell.ts" || {
    echo "FAIL: web shell.ts (module-toggle bridge) missing"; exit 1; }
grep -q 'setToggle' "$ROOT/src/lib/sysdeck/bridge/shell.ts" || {
    echo "FAIL: shell.ts lacks the setToggle command"; exit 1; }
grep -q 'setToggle' "$ROOT/src/components/sysdeck/shell.tsx" || {
    echo "FAIL: web shell (components/sysdeck/shell.tsx) lacks module toggle wiring"; exit 1; }
grep -q '10.2' "$STAGE_PARENT/cockpit/QUICKSTART.md" || {
    echo "FAIL: QUICKSTART lacks the module-toggles section (10.2)"; exit 1; }

# 0.3.0 security audit fixes — cockpit bridge (fail-closed guards)
grep -q '_cgroup_path_ok' "$STAGE_PARENT/cockpit/bridge/policy.py" || {
    echo "FAIL: bridge/policy.py lacks the cgroup path bound guard (C-1)"; exit 1; }
grep -q '_CGROUP_CTRL_RE' "$STAGE_PARENT/cockpit/bridge/policy.py" || {
    echo "FAIL: bridge/policy.py lacks the cgroup control-name allowlist"; exit 1; }
grep -q '_valid_id' "$STAGE_PARENT/cockpit/bridge/builder.py" || {
    echo "FAIL: bridge/builder.py lacks the build-id/profile validation (C-2/H-1)"; exit 1; }
grep -q 'refusing to clear' "$STAGE_PARENT/cockpit/bridge/builder.py" || {
    echo "FAIL: bridge/builder.py artifacts-clear lacks the rmtree guard (C-2)"; exit 1; }
if grep -q 'sudo", "sh", "-c' "$STAGE_PARENT/cockpit/bridge/hwalert.py"; then {
    echo "FAIL: bridge/hwalert.py still contains the sudo sh -c injection (H-2)"; exit 1; }; fi
grep -q '_device_path_ok' "$STAGE_PARENT/cockpit/bridge/hwalert.py" || {
    echo "FAIL: bridge/hwalert.py lacks the device path guard (H-2)"; exit 1; }
grep -q '_engine_registered' "$STAGE_PARENT/cockpit/bridge/db.py" || {
    echo "FAIL: bridge/db.py start/stop/restart lack the registry check (M-1)"; exit 1; }
grep -q 'read-only queries only' "$STAGE_PARENT/cockpit/bridge/db.py" || {
    echo "FAIL: bridge/db.py query lacks the read-only guard (M-2)"; exit 1; }
grep -q 'refusing to set' "$STAGE_PARENT/cockpit/bridge/themes.py" || {
    echo "FAIL: bridge/themes.py set lacks the INI-injection guard (M-6)"; exit 1; }
grep -q '_pkg_name_ok' "$STAGE_PARENT/cockpit/bridge/packages.py" || {
    echo "FAIL: bridge/packages.py lacks package-name validation (L-1)"; exit 1; }
grep -q 'invalid sysbench test name' "$STAGE_PARENT/cockpit/bridge/benchmark.py" || {
    echo "FAIL: bridge/benchmark.py lacks the test-name guard (L-1)"; exit 1; }
grep -q 'invalid package name' "$STAGE_PARENT/cockpit/bridge/firewall.py" || {
    echo "FAIL: bridge/firewall.py lacks package-name validation"; exit 1; }

# 0.3.0 security audit fixes — cockpit panels (XSS escaping + CSP)
# (grep exits 1 on a clean tree — absorb it so pipefail doesn't kill the build)
unsafe_eval_manifests=$({ grep -rl "unsafe-eval" "$STAGE_PARENT"/cockpit/plugins/*/manifest.json 2>/dev/null || true; } | wc -l)
test "$unsafe_eval_manifests" -eq 0 || {
    echo "FAIL: $unsafe_eval_manifests plugin manifests still ship unsafe-eval (M-5)"; exit 1; }
for panel in packages benchmark auth sensors vault firmware mesh; do
    grep -q 'function escapeHtml' "$STAGE_PARENT/cockpit/plugins/sysdeck-$panel/$panel.js" || {
        echo "FAIL: sysdeck-$panel panel lacks escapeHtml (H-3/H-4 XSS)"; exit 1; }
done
if grep -qP 'target="_blank"(?! rel=)' "$STAGE_PARENT"/cockpit/plugins/*/[a-z]*.js 2>/dev/null; then {
    echo "FAIL: a plugin still has target=_blank without rel=noopener (L-4)"; exit 1; }; fi

# 0.3.0 security audit fixes — web edition (loopback binding + DoS guards)
grep -q '127.0.0.1' "$ROOT/package.json" || {
    echo "FAIL: web package.json does not bind loopback"; exit 1; }
grep -q "hostname: '127.0.0.1'" "$ROOT/mini-services/fester/index.ts" || {
    echo "FAIL: fester service does not bind loopback"; exit 1; }
grep -q 'rateLimited' "$ROOT/src/app/api/bridge/route.ts" || {
    echo "FAIL: bridge route lacks rate limiting"; exit 1; }
grep -q 'MAX_BODY_BYTES' "$ROOT/src/app/api/bridge/route.ts" || {
    echo "FAIL: bridge route lacks the body-size cap"; exit 1; }

# v0.4.0 unix login — PAM helper + SdUser local accounts + user-bound session v2
test -f "$ROOT/src/lib/sysdeck/session.ts" || {
    echo "FAIL: web session lib (src/lib/sysdeck/session.ts) missing"; exit 1; }
grep -q 'requireSession' "$ROOT/src/app/api/bridge/route.ts" || {
    echo "FAIL: bridge route lacks the session gate"; exit 1; }
grep -q 'requireSession' "$ROOT/src/app/api/fester/route.ts" || {
    echo "FAIL: fester proxy route lacks the session gate"; exit 1; }
grep -q 'requireSession' "$ROOT/src/app/api/release/route.ts" || {
    echo "FAIL: release route lacks the session gate"; exit 1; }
test -f "$ROOT/src/app/api/auth/login/route.ts" || {
    echo "FAIL: login route (src/app/api/auth/login) missing"; exit 1; }
grep -q 'currentSession' "$ROOT/src/app/page.tsx" || {
    echo "FAIL: page.tsx lacks the server-side session gate"; exit 1; }
grep -q 'LoginScreen' "$ROOT/src/app/page.tsx" || {
    echo "FAIL: page.tsx does not render the login screen"; exit 1; }
grep -q "sessionOk" "$ROOT/mini-services/fester/index.ts" || {
    echo "FAIL: fester service lacks the shared-secret session check"; exit 1; }
grep -q 'SYSDECK_AUTH_MODE' "$STAGE_PARENT/cockpit/QUICKSTART.md" || {
    echo "FAIL: QUICKSTART lacks the 10.4 unix-login section"; exit 1; }
grep -q 'SYSDECK_SESSION_SECURE' "$ROOT/src/lib/sysdeck/session.ts" || {
    echo "FAIL: session lib lacks the session-cookie surface"; exit 1; }

# 0.3.0 security audit — klanker-gate upstream findings + arch mitigations
test -f "$STAGE_PARENT/klanker-gate/arch/SECURITY-UPSTREAM.md" || {
    echo "FAIL: klanker-gate/arch/SECURITY-UPSTREAM.md (upstream advisory) missing"; exit 1; }
grep -q 'U-1' "$STAGE_PARENT/klanker-gate/arch/SECURITY-UPSTREAM.md" || {
    echo "FAIL: SECURITY-UPSTREAM.md lacks the findings table"; exit 1; }
grep -q 'ExecStartPre' "$STAGE_PARENT/klanker-gate/arch/klanker-gate.service" || {
    echo "FAIL: klanker-gate.service lacks the fail-closed token guard (U-1)"; exit 1; }
grep -q 'SECURITY-UPSTREAM.md' "$STAGE_PARENT/klanker-gate/arch/PKGBUILD" || {
    echo "FAIL: PKGBUILD does not install SECURITY-UPSTREAM.md"; exit 1; }
grep -q 'REQUIRED' "$STAGE_PARENT/klanker-gate/arch/env.example" || {
    echo "FAIL: env.example does not mark FROSTY_ADMIN_TOKEN required"; exit 1; }
grep -q '## 9. Security notes' "$STAGE_PARENT/klanker-gate/arch/INSTALL-ARCH.md" || {
    echo "FAIL: INSTALL-ARCH.md lacks the security section"; exit 1; }

# v0.3.0 additions — the web-edition skin for cockpit + the runbook
test -f "$STAGE_PARENT/cockpit/shared/sysdeck-web.css" || {
    echo "FAIL: shared/sysdeck-web.css (web-edition skin) missing"; exit 1; }
test -f "$STAGE_PARENT/cockpit/shared/branding.css" || {
    echo "FAIL: shared/branding.css (cockpit shell skin) missing"; exit 1; }
grep -q 'sysdeck-web.css' "$STAGE_PARENT/cockpit/Makefile" || {
    echo "FAIL: Makefile does not install the web-edition skin"; exit 1; }
grep -q 'install-branding:' "$STAGE_PARENT/cockpit/Makefile" || {
    echo "FAIL: Makefile lacks install-branding"; exit 1; }
skins=0
for f in "$STAGE_PARENT"/cockpit/plugins/*/index.html; do
    grep -q 'sysdeck-common/sysdeck-web.css' "$f" || {
        echo "FAIL: $(basename "$(dirname "$f")")/index.html does not link the skin"; exit 1; }
    skins=$((skins+1))
done
test "$skins" -ge 27 || { echo "FAIL: only $skins plugin pages link the skin"; exit 1; }
test -f "$ROOT/src/components/sysdeck/panels/runbookPanel.tsx" || {
    echo "FAIL: web edition runbookPanel.tsx missing"; exit 1; }
grep -q "id: 'runbook'" "$ROOT/src/lib/sysdeck/registry.ts" || {
    echo "FAIL: web edition registry lacks the runbook module"; exit 1; }

rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT_DIR" "$ROOT/download"

# ── 1. cockpit edition (staged + upgraded tree) ────────────────────────
tar -C "$STAGE_PARENT/cockpit" -cf - \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='*.tar.bz2' \
    . | tar -C "$STAGE" -xf -

# ── 2. web edition (this project; no build output, no node_modules) ───
mkdir -p "$STAGE/web" "$STAGE/web/db"
tar -C "$ROOT" -cf - \
    --exclude='node_modules' \
    --exclude='.next' \
    --exclude='dev.log' \
    --exclude='server.log' \
    --exclude='worklog.md' \
    --exclude='worklog-*.md' \
    --exclude='tool-results' \
    --exclude='upload' \
    --exclude='download' \
    --exclude='master-build' \
    --exclude='public/download' \
    --exclude='.git' \
    --exclude='.zscripts' \
    --exclude='skills' \
    --exclude='examples' \
    --exclude='tests' \
    --exclude='tsconfig.tsbuildinfo' \
    --exclude='mini-services/fester/fester.db' \
    --exclude='mini-services/fester/fester.db-shm' \
    --exclude='mini-services/fester/fester.db-wal' \
    --exclude='mini-services/fester/node_modules' \
    src prisma public mini-services scripts package.json bun.lock \
    next.config.ts postcss.config.mjs tsconfig.json \
    components.json eslint.config.mjs Caddyfile \
    | tar -C "$STAGE/web" -xf -

# portable DATABASE_URL for the bundled copy (prisma resolves relative to
# prisma/schema.prisma → <web root>/db/custom.db); KLANKER_URL keeps the
# AI Gateway panel pointed at the gateway (vendored at ../klanker-gate,
# or the Arch-packaged systemd service on the operator's host).
printf 'DATABASE_URL=file:../db/custom.db\n# unix-account login (cockpit-style, v0.4.0+):\n#   pam        — host PAM only (the cockpit default posture; run the\n#                service as root so any unix account can sign in)\n#   pam+local  — PAM first, SdUser local accounts as fallback (works\n#                unprivileged — unix_chkpwd only serves the invoking uid)\n#   local      — SdUser console accounts only\nSYSDECK_AUTH_MODE=pam+local\n# SYSDECK_PAM_SERVICE=sysdeck   # ship /etc/pam.d/sysdeck to tailor the stack\n# SYSDECK_PYTHON=python3\n# cockpit module detection (v0.4.1): extra scan roots beyond\n# /usr/share/cockpit and /usr/local/share/cockpit (colon-separated)\n#SYSDECK_COCKPIT_SCAN=/path/to/staged/cockpit\n# KLANKER_URL=http://127.0.0.1:8080\n# KLANKER_ADMIN_TOKEN=\n# SYSDECK_SESSION_SECURE=1  # add the Secure cookie flag when fronted by TLS\n# mutation authorization (v0.4.3): 'admin' gates mutating bridge commands\n# behind an admin session (wheel/sudo/adm or uid 0); 'any' restores the\n# single-operator posture\n#SYSDECK_MUTATIONS=admin\n# X-Forwarded-For defines rate-limit identity only behind a trusted proxy\n#SYSDECK_TRUST_PROXY=1\n' > "$STAGE/web/.env"

cat > "$STAGE/web/README.md" <<'EOF'
# SysDeck — the standalone web console

SysDeck's browser-native front end: 31 bridge modules behind one
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

    tar xjf sysdeck-0.4.4-master.tar.bz2
    cd sysdeck-0.4.4-master
    make web-dev        # bun install + db:push + fester + next dev :3000

Granular equivalent (what `make web-dev` does):

    cd sysdeck-0.4.4-master/web
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
  stay the outer boundary (see ../QUICKSTART.md §2).
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
EOF

# ── 3. klanker-gate (vendored gateway + Arch packaging) ───────────────
mkdir -p "$STAGE/klanker-gate"
tar -C "$STAGE_PARENT/klanker-gate" -cf - \
    --exclude='.git' \
    . | tar -C "$STAGE/klanker-gate" -xf -

# ── 4. pack ───────────────────────────────────────────────────────────
tar -cjf "$OUT" -C "$STAGE_PARENT" "$NAME"
SHA="$(sha256sum "$OUT" | cut -d' ' -f1)"
SIZE="$(stat -c %s "$OUT")"
printf '%s  %s\n' "$SHA" "$NAME.tar.bz2" > "$OUT.sha256"

# sandbox mirror + summary
cp -f "$OUT" "$OUT.sha256" "$ROOT/download/"

FILES="$(tar -tjf "$OUT" | wc -l)"
echo ">>> $OUT"
echo "    files: $FILES   size: $SIZE bytes"
echo "    sha256: $SHA"
