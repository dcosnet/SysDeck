#!/bin/sh
# Create-or-update the `frosty-observer` Grafana account with the Editor role.
#
# Why an account and not a role: Grafana OSS cannot define custom RBAC roles -
# /api/access-control/roles is Enterprise-licensed and 404s here - so a
# pre-provisioned principal with a scoped basic role is the OSS equivalent.
# Anonymous access stays read-only Viewer; this account is what trace drill-down
# through Explore uses.
#
# Idempotent: safe to re-run, and re-running fixes a drifted role or password.
set -eu

API="${GF_URL:-http://grafana:3000}"
AUTH="${GF_ADMIN_USER}:${GF_ADMIN_PASSWORD}"
LOGIN="${GF_OBSERVER_USER}"
PASSWORD="${GF_OBSERVER_PASSWORD}"
ROLE="${GF_OBSERVER_ROLE:-Editor}"

api() {
  # $1 method, $2 path, $3 optional JSON body. Prints body, then HTTP code on
  # the last line so the caller can branch on it.
  if [ $# -ge 3 ]; then
    curl -sS -u "$AUTH" -X "$1" -H 'Content-Type: application/json' \
      -d "$3" -w '\n%{http_code}' "$API$2"
  else
    curl -sS -u "$AUTH" -X "$1" -w '\n%{http_code}' "$API$2"
  fi
}

code_of() { printf '%s' "$1" | tail -n 1; }
body_of() { printf '%s' "$1" | sed '$d'; }

# Grafana can accept connections a moment before its API is serving.
i=0
until [ "$(code_of "$(api GET /api/health)")" = "200" ]; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "grafana API never became ready" >&2; exit 1; }
  sleep 2
done

lookup=$(api GET "/api/users/lookup?loginOrEmail=$LOGIN")
if [ "$(code_of "$lookup")" = "200" ]; then
  id=$(body_of "$lookup" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  echo "grafana: '$LOGIN' exists (id=$id)"
  # Re-assert the password so a redeploy with new credentials converges.
  api PUT "/api/admin/users/$id/password" "{\"password\":\"$PASSWORD\"}" >/dev/null
else
  created=$(api POST /api/admin/users \
    "{\"name\":\"Frosty Observer\",\"login\":\"$LOGIN\",\"password\":\"$PASSWORD\"}")
  if [ "$(code_of "$created")" != "200" ]; then
    echo "grafana: failed to create '$LOGIN': $(body_of "$created")" >&2
    exit 1
  fi
  id=$(body_of "$created" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  echo "grafana: created '$LOGIN' (id=$id)"
fi

# Org role is what actually gates Explore, so assert it every run.
role=$(api PATCH "/api/org/users/$id" "{\"role\":\"$ROLE\"}")
if [ "$(code_of "$role")" != "200" ]; then
  echo "grafana: failed to set role $ROLE on '$LOGIN': $(body_of "$role")" >&2
  exit 1
fi
echo "grafana: '$LOGIN' has org role $ROLE - sign in to use Explore -> Tempo"
