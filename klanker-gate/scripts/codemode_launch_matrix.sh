#!/usr/bin/env bash
# AT-M1-3 (out-of-process launch matrix) — MINOR-1 regression check.
#
# CANNOT be a `deno test`: the flag-absent case aborts the process (exit 70),
# uncatchable. This runs `codemode_worker_options_probe.ts` (a minimal deny-all
# Worker spawn, NOT the full gateway boot) under the launch grid and asserts the
# exit codes match the design's empirical findings (§1.2 B/C/E). Run from the
# repository root:  bash scripts/codemode_launch_matrix.sh
set -u
PROBE="scripts/codemode_worker_options_probe.ts"
fail=0

expect() { # <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then
    echo "PASS: $1 (exit $3)"
  else
    echo "FAIL: $1 (expected exit $2, got $3)"
    fail=1
  fi
}

echo "== (1) config present, NO CLI unstable flag => boots, descriptor enforced =="
deno run --allow-read --allow-env "$PROBE"; expect "config-only spawns (no abort)" 0 $?

echo "== (2) --no-config => exit 70 abort (documented residual, fail-STOPPED) =="
deno run --no-config --allow-read --allow-env "$PROBE"; expect "--no-config aborts (residual locked)" 70 $?

echo "== (3) config + redundant CLI flags => idempotent, still boots =="
deno run --unstable-kv --unstable-worker-options --allow-read --allow-env "$PROBE"
expect "config + CLI flags idempotent" 0 $?

# NOTE: a full-gateway boot smoke test (deno run apps/gateway/main.ts with
# FROSTY_CODE_MODE=on -> boots + probe renders a verdict; --no-config -> exit 70;
# and a `deno compile` binary launched with zero flags -> boots) is a release-time
# manual step: it binds a port and runs forever, so it is not automated here.

if [ "$fail" = "0" ]; then echo "AT-M1-3: ALL PASS"; else echo "AT-M1-3: FAILURES"; fi
exit $fail
