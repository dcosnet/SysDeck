#!/bin/sh
# klanker-gate run wrapper — the systemd ExecStart target.
#
# Mirrors deploy/docker-entrypoint.sh from the upstream tree (same logic,
# different filesystem layout): grants the supervisor the one extra
# permission multi-process serving needs, and only when it is asked for.
#
# FROSTY_WORKERS>1 makes this process a supervisor that re-execs the Deno
# binary once per worker, which needs --allow-run. A blanket --allow-run on
# a gateway that fronts untrusted request bodies and ships a Code Mode
# executor is a real escalation, so it is SCOPED to the Deno executable and
# is absent entirely in the default single-process case.
#
# The one-time `deno cache` warmup runs as the service user so the module
# cache lands in /var/lib/klanker-gate/.cache/deno (DENO_DIR via $HOME).
# First start needs network; later starts are served from the warm cache.

set -e

DENO_BIN="$(command -v deno)"
APP="/usr/share/klanker-gate"

# Children re-exec Deno and must resolve modules the same way this process
# does, or they contend on the node_modules lock.
FROSTY_NODE_MODULES_DIR=none
export FROSTY_NODE_MODULES_DIR

# Warm the module cache against the lockfile. Fails closed (a cold cache
# plus no network is a real error the journal should show, not a mystery
# module-not-found three lines later).
"$DENO_BIN" cache --node-modules-dir=none --frozen "$APP/apps/gateway/main.ts"

# --allow-write=data is relative to the working directory, which the unit
# pins to /var/lib/klanker-gate.
RUN_FLAG=""
if [ -n "${FROSTY_WORKERS}" ] && [ "${FROSTY_WORKERS}" -gt 1 ] 2>/dev/null; then
    RUN_FLAG="--allow-run=${DENO_BIN}"
fi

# shellcheck disable=SC2086 # RUN_FLAG is one optional argument or empty.
exec "${DENO_BIN}" run \
    --node-modules-dir=none \
    --unstable-net \
    --unstable-worker-options \
    --allow-net \
    --allow-env \
    --allow-read \
    --allow-write=data \
    ${RUN_FLAG} \
    "$APP/apps/gateway/main.ts"
