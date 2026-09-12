#!/bin/sh
# Grants the supervisor the one extra permission multi-process serving needs,
# and only when it is actually asked for.
#
# FROSTY_WORKERS>1 makes this process a supervisor that re-execs the Deno binary
# once per worker, which needs --allow-run. A blanket --allow-run on a gateway
# that fronts untrusted request bodies and ships a Code Mode executor is a real
# escalation, so it is SCOPED to the Deno executable and is absent entirely in
# the default single-process case. Children are spawned with the flag set in
# apps/gateway/cluster.ts, which does not include --allow-run: only the
# supervisor can spawn, and the supervisor serves no traffic and holds no state.
set -e

DENO_BIN="$(command -v deno)"

# Children re-exec Deno via apps/gateway/cluster.ts and must resolve modules
# the same way this process does, or they contend on the node_modules lock.
FROSTY_NODE_MODULES_DIR=none
export FROSTY_NODE_MODULES_DIR

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
  apps/gateway/main.ts
