#!/usr/bin/env bash
# SysDeck master tarball builder
#
# Bundles into ONE distributable (sysdeck-<version>-master.tar.bz2):
#   /            — the cockpit edition (bridge/ + plugins/ + shared/ + docs)
#   /web         — the SysDeck Web Edition (this Next.js project)
#   /web/mini-services/fester — Fester, vendored + pre-integrated
#
# Preconditions:
#   - master-build/cockpit/ holds the staged + upgraded cockpit tree
#     (fester.py / fester.js / bridge.js upgraded, Makefile at 0.2.0)
#
# Output:
#   public/download/sysdeck-<version>-master.tar.bz2 (+ .sha256)
#   download/ (sandbox mirror)
set -euo pipefail

VERSION="0.2.0"
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
grep -q 'VERSION := 0.2.0' "$STAGE_PARENT/cockpit/Makefile" || {
    echo "FAIL: master-build/cockpit/Makefile is not bumped to 0.2.0"; exit 1; }

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
    next.config.ts postcss.config.mjs tailwind.config.ts tsconfig.json \
    components.json eslint.config.mjs Caddyfile \
    | tar -C "$STAGE/web" -xf -

# portable DATABASE_URL for the bundled copy (prisma resolves relative to
# prisma/schema.prisma → <web root>/db/custom.db)
printf 'DATABASE_URL=file:../db/custom.db\n' > "$STAGE/web/.env"

cat > "$STAGE/web/README.md" <<'EOF'
# SysDeck Web Edition

The browser-native rendition of SysDeck: 28 bridge modules behind one
console — real /proc + /sys collectors where the host allows, honest demo
datasets (clearly badged) where backends are absent, and the Fester DAG
orchestrator vendored as a dedicated service (`mini-services/fester`).

## Run (Bun)

    bun install
    bun run db:push                        # create + migrate db/custom.db (SQLite)
    (cd mini-services/fester && bun install)
    bun run dev                            # Next.js on :3000
    (cd mini-services/fester && bun run dev)   # fester service on :3010

Then open http://localhost:3000. The Fester panel proxies REST through
`/api/fester` and streams WebSocket events through the gateway
(`/?XTransformPort=3010`).

## Layout

- `src/lib/sysdeck/` — module registry + bridge dispatcher modules
- `src/app/api/bridge` — the bridge endpoint (POST {module, command, args})
- `src/app/api/fester` — server-side proxy to the fester service
- `src/app/api/release` — master-tarball release metadata
- `src/components/sysdeck/` — panels + shared UI primitives
- `mini-services/fester` — the vendored Fester service (own package, v0.2.1)

`db/custom.db` is created by `bun run db:push` using `DATABASE_URL` from
`.env`. The master tarball builder lives at `scripts/make-master-tarball.sh`
in the canonical development tree.
EOF

# ── 3. pack ────────────────────────────────────────────────────────────
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
