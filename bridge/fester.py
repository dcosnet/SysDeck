#!/usr/bin/env python3
"""
SysDeck - Fester Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

REAL INTEGRATION against the vendored fester service (the same one
the Web Edition runs): web/mini-services/fester, a distributed DAG
build orchestrator speaking REST + WebSocket on 127.0.0.1:3010.

This helper is a thin stdlib-only REST client (urllib.request + json,
4s timeout — no requests library, no curl dependency). Every
subcommand prints the service's JSON response; `status` additionally
enriches the health payload with the local connection facts. HTTP
error bodies (409 cancel conflicts, 404 unknown builds, 400
validation) are JSON on this service and are surfaced verbatim.
Connection failures are graceful, like the other bridge helpers:
{"ok": false, "error": ...} with a remediation hint, exit code 0.

Subcommands:
  status        GET  /api/health  (+ port / transport / base_url)
  metrics       GET  /api/metrics
  builds        GET  /api/builds        (live builds + history)
  build <id>    GET  /api/builds/<id>
  nodes         GET  /api/nodes
  targets       GET  /api/targets       (project catalog)
  timeline <id> GET  /api/timeline/<id>
  sessions      GET  /api/sessions
  start-build --project <p> --targets <csv>
                [--no-cache] [--retries <0-3>] [--fail-action <a>]
                POST /api/build         → build_id
  cancel <id>   POST /api/builds/<id>/cancel
  replay <buildId> [--label <l>]
                POST /api/sessions      → session

Usage:
    python3 /usr/lib/sysdeck/bridge/fester.py status
    python3 /usr/lib/sysdeck/bridge/fester.py builds
    python3 /usr/lib/sysdeck/bridge/fester.py start-build \
        --project linux-tool --targets debian --no-cache --retries 2
    FESTER_URL=http://10.0.0.5:3010 \\
        python3 /usr/lib/sysdeck/bridge/fester.py status
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# The vendored fester service binds REST+WS here by default. Override
# with FESTER_URL when it lives elsewhere.
FESTER_URL = os.environ.get("FESTER_URL", "http://127.0.0.1:3010").rstrip("/")

# Strict 4s timeout — the panel polls every 5s, so a hung request must
# never outlive one refresh cycle.
FESTER_TIMEOUT = 4  # seconds

# Connection-level failure messages (callers print this and exit 0 —
# graceful, same contract as the other bridge helpers).
UNREACHABLE_MSG = (
    "fester service unreachable at {url} — start it with "
    "`make fester-start` or `bun run dev` in web/mini-services/fester, "
    "or set FESTER_URL"
)


def _unreachable() -> dict:
    """Return the graceful offline response (remediation hint included)."""
    return {"ok": False, "error": UNREACHABLE_MSG.format(url=FESTER_URL)}


def _base_port() -> int:
    """Port of the base URL (3010 for the default vendored service)."""
    try:
        return urllib.parse.urlparse(FESTER_URL).port or 3010
    except ValueError:
        return 3010


def _quote(value: str) -> str:
    """URL-path-encode a path segment (build/session ids)."""
    return urllib.parse.quote(str(value), safe="")


def _request(path: str, method: str = "GET", body: dict | None = None) -> dict:
    """One HTTP call against the fester service. Returns parsed JSON.

    HTTPError bodies are JSON on this service — surface them instead of
    crashing. Connection-level failures raise URLError/OSError; the
    _get/_post wrappers translate those into the graceful offline
    response.
    """
    url = FESTER_URL + path
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=FESTER_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        # 400/404/409 responses carry a JSON body — return it verbatim.
        try:
            raw = exc.read().decode("utf-8", errors="replace")
            if raw.strip():
                return json.loads(raw)
        except (OSError, ValueError):
            pass
        return {"ok": False, "error": f"HTTP {exc.code}: {exc.reason}"}
    try:
        return json.loads(raw) if raw.strip() else {"ok": False, "error": f"empty response from {url}"}
    except json.JSONDecodeError:
        return {"ok": False, "error": f"non-JSON response from {url}"}


def _get(path: str) -> dict:
    """GET <path> with graceful offline handling."""
    try:
        return _request(path)
    except (urllib.error.URLError, OSError, ValueError):
        return _unreachable()


def _post(path: str, body: dict) -> dict:
    """POST <path> with a JSON body, graceful offline handling."""
    try:
        return _request(path, method="POST", body=body)
    except (urllib.error.URLError, OSError, ValueError):
        return _unreachable()


# ── subcommands ──────────────────────────────────────────────────────


def cmd_status(_args: list[str]) -> dict:
    """GET /api/health, enriched with the local connection facts."""
    try:
        data = _request("/api/health")
    except (urllib.error.URLError, OSError, ValueError):
        return _unreachable()
    out = dict(data)
    out["port"] = _base_port()
    out["transport"] = "rest+ws"
    out["base_url"] = FESTER_URL
    return out


def cmd_build(args: list[str]) -> dict:
    """GET /api/builds/<id> — one build (live state or stored record)."""
    if not args:
        return {"ok": False, "error": "build id required: build <id>"}
    return _get(f"/api/builds/{_quote(args[0])}")


def cmd_timeline(args: list[str]) -> dict:
    """GET /api/timeline/<id> — the event journal for one build."""
    if not args:
        return {"ok": False, "error": "build id required: timeline <id>"}
    return _get(f"/api/timeline/{_quote(args[0])}")


def cmd_start_build(args: list[str]) -> dict:
    """POST /api/build — start a build, print the build_id response."""
    project = None
    targets: list[str] = []
    no_cache = False
    retries = 0
    retries_given = False
    fail_action = None

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--project" and i + 1 < len(args):
            project = args[i + 1]
            i += 2
        elif arg == "--targets" and i + 1 < len(args):
            targets = [t for t in args[i + 1].split(",") if t]
            i += 2
        elif arg == "--no-cache":
            no_cache = True
            i += 1
        elif arg == "--retries" and i + 1 < len(args):
            raw = args[i + 1]
            i += 2
            try:
                retries = int(raw)
            except ValueError:
                return {"ok": False, "error": f"retries must be an integer between 0 and 3: {raw!r}"}
            if not 0 <= retries <= 3:
                return {"ok": False, "error": f"retries must be an integer between 0 and 3: {retries}"}
            retries_given = True
        elif arg == "--fail-action" and i + 1 < len(args):
            fail_action = args[i + 1]
            i += 2
        else:
            return {"ok": False, "error": f"unknown argument: {arg}"}

    if not project:
        return {"ok": False, "error": "--project <p> is required"}
    if not targets:
        return {"ok": False, "error": "--targets <csv> is required (at least one target)"}

    body: dict = {"project": project, "targets": targets}
    if no_cache:
        body["noCache"] = True
    if retries_given:
        body["retries"] = retries
    if fail_action:
        body["failAction"] = fail_action
    return _post("/api/build", body)


def cmd_cancel(args: list[str]) -> dict:
    """POST /api/builds/<id>/cancel — 409-style JSON on non-running builds."""
    if not args:
        return {"ok": False, "error": "build id required: cancel <id>"}
    return _post(f"/api/builds/{_quote(args[0])}/cancel", {})


def cmd_replay(args: list[str]) -> dict:
    """POST /api/sessions — create a replay session for a finished build."""
    build_id = None
    label = None

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--label" and i + 1 < len(args):
            label = args[i + 1]
            i += 2
        elif build_id is None:
            build_id = arg
            i += 1
        else:
            return {"ok": False, "error": f"unknown argument: {arg}"}

    if not build_id:
        return {"ok": False, "error": "build id required: replay <buildId> [--label <l>]"}

    body: dict = {"buildId": build_id}
    if label is not None:
        body["label"] = label
    return _post("/api/sessions", body)


# ── dispatch table ───────────────────────────────────────────────────

COMMANDS = {
    "status":      lambda _args: cmd_status(_args),
    "metrics":     lambda _args: _get("/api/metrics"),
    "builds":      lambda _args: _get("/api/builds"),
    "build":       cmd_build,
    "nodes":       lambda _args: _get("/api/nodes"),
    "targets":     lambda _args: _get("/api/targets"),
    "timeline":    cmd_timeline,
    "sessions":    lambda _args: _get("/api/sessions"),
    "start-build": cmd_start_build,
    "cancel":      cmd_cancel,
    "replay":      cmd_replay,
}


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd = COMMANDS.get(argv[0])
    if not cmd:
        print(f"Unknown subcommand: {argv[0]}", file=sys.stderr)
        print(f"Available: {', '.join(sorted(COMMANDS))}", file=sys.stderr)
        return 2
    print(json.dumps(cmd(argv[1:]), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
