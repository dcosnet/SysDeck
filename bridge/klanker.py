#!/usr/bin/env python3
"""
SysDeck - Klanker Bridge Helper (AI Gateway)
Author: Jeremy Anderson (https://dcos.net)

UPSTREAM ATTRIBUTION: this helper is a REST *client* of klanker-gate —
the "Frosty Deno" LLM gateway by TykoDev
(https://github.com/TykoDev/klanker-gate, Apache-2.0), which the master
tarball vendors unmodified at /klanker-gate. klanker-gate is NOT
SysDeck code and no upstream code is contained here — see
klanker-gate/ATTRIBUTION.md and THIRD_PARTY.md.

v0.3.0 NEW MODULE. Client of the vendored klanker-gate service — the
Frosty Deno LLM gateway (Deno 2 + TypeScript, REST on 127.0.0.1:8080) —
so sysdeck ships an operator view of the local inference gateway:
providers, virtual keys, request logs, spend/cost rollups, cache and
runtime topology, plus systemd service control.

This helper is a thin stdlib-only REST client (urllib.request + json,
4s timeout — no requests library, no curl dependency), the same
contract as bridge/fester.py. Every read subcommand prints the
service's JSON response; `status` merges the public /healthz and
/api/version probes and enriches them with the local connection
facts. HTTP error bodies (401 auth errors, 404s) are JSON on this
service and are surfaced verbatim. Connection failures are graceful:
{"ok": false, "error": ...} with a remediation hint, exit code 0 —
never a traceback.

Authentication: operator routes under /api/* take
`Authorization: Bearer <FROSTY_ADMIN_TOKEN>` when the gateway has one
configured. The token is read from KLANKER_ADMIN_TOKEN here and sent
as a header ONLY — it is never echoed in any output, never placed in
a URL, and journal output is scrubbed of its value defensively.

Subcommands:
  status               GET /healthz + /api/version, merged + enriched
  providers            GET /api/providers   (browser-safe list)
  models               GET /v1/models       (aggregated catalog)
  vkeys                GET /api/virtual-keys
  logs [--limit N]     GET /api/logs?limit=N (recent request ring,
                       default 25)
  analytics            GET /api/analytics   (rollups: requests, spend,
                       cache, latency; optional --window 1h|24h|7d)
  runtime              GET /api/runtime     (workers/cache/postgres)
  service <action>     systemctl start|stop|restart|status|enable|disable
                       klanker-gate.service
  journal [N]          journalctl -u klanker-gate -n N --no-pager
                       (default 40, sanitized)
  localstack            probe local AI backends (ollama, llama.cpp,
                       koboldcpp, lmstudio, sglang, vllm) + wiring recipes

Usage:
    python3 /usr/lib/sysdeck/bridge/klanker.py status
    python3 /usr/lib/sysdeck/bridge/klanker.py providers
    python3 /usr/lib/sysdeck/bridge/klanker.py logs --limit 50
    python3 /usr/lib/sysdeck/bridge/klanker.py service restart
    KLANKER_URL=http://10.0.0.5:8080 KLANKER_ADMIN_TOKEN=... \\
        python3 /usr/lib/sysdeck/bridge/klanker.py analytics
"""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# The vendored klanker-gate service binds REST here by default
# (apps/gateway/main.ts: PORT env, default 8080). Override with
# KLANKER_URL when it lives elsewhere.
KLANKER_URL = os.environ.get("KLANKER_URL", "http://127.0.0.1:8080").rstrip("/")

# Optional bearer token for the gateway's admin surface (/api/* takes
# Authorization: Bearer <FROSTY_ADMIN_TOKEN> when the operator set one).
# Header-only usage — NEVER printed, NEVER in a URL.
KLANKER_ADMIN_TOKEN = os.environ.get("KLANKER_ADMIN_TOKEN")

# The systemd unit the service subcommand wraps. The gateway itself
# ships no unit (docker-compose / `deno task gateway` are its native
# runners); operators who deploy it natively use this name, matching
# the fester-service convention.
KLANKER_SERVICE = "klanker-gate.service"

# Strict 4s timeout — the panel polls every 5s, so a hung request must
# never outlive one refresh cycle.
KLANKER_TIMEOUT = 4  # seconds

# Connection-level failure messages (callers print this and exit 0 —
# graceful, same contract as fester.py and the other bridge helpers).
UNREACHABLE_MSG = (
    "klanker-gate service unreachable at {url} — start it with "
    "`systemctl start klanker-gate` (arch/ packaging) or `deno task dev` "
    "in the vendored klanker-gate tree, or set KLANKER_URL"
)


def _unreachable() -> dict:
    """Return the graceful offline response (remediation hint included)."""
    return {"ok": False, "error": UNREACHABLE_MSG.format(url=KLANKER_URL)}


def _base_port() -> int:
    """Port of the base URL (8080 for the default vendored service)."""
    try:
        return urllib.parse.urlparse(KLANKER_URL).port or 8080
    except ValueError:
        return 8080


def _request(path: str) -> dict:
    """One HTTP GET against the gateway. Returns parsed JSON.

    HTTPError bodies are JSON on this service — surface them verbatim
    (a 401 "Missing or invalid admin token." is a fact the operator
    needs to see). Connection-level failures raise URLError/OSError;
    the _get wrapper translates those into the graceful offline
    response.
    """
    url = KLANKER_URL + path
    headers = {"Accept": "application/json"}
    if KLANKER_ADMIN_TOKEN:
        # Sent as a header only — the token value never appears in
        # `url`, in any error string, or in any printed JSON.
        headers["Authorization"] = f"Bearer {KLANKER_ADMIN_TOKEN}"
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=KLANKER_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
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


# ── subcommands ──────────────────────────────────────────────────────


def cmd_status(_args: list[str]) -> dict:
    """GET /healthz + /api/version, merged + enriched with local facts.

    Both probes are public (no admin token required). The merge keeps
    the gateway's own fields (status, version, timestamp) and layers:
      port       — port of the base URL (8080 default)
      base_url   — the URL this helper is talking to
      deno       — Deno runtime version from /api/version
      transport  — "rest"
      auth       — whether an admin token is configured HERE (boolean;
                   the token value itself is never reported)
    """
    try:
        data = _request("/healthz")
    except (urllib.error.URLError, OSError, ValueError):
        return _unreachable()
    if not isinstance(data, dict) or data.get("status") != "ok":
        # Non-healthy gateway (or an error body) — surface it verbatim.
        if isinstance(data, dict) and data.get("ok") is not False:
            data = dict(data)
            data.setdefault("status", "error")
        return data if isinstance(data, dict) else {"ok": False, "error": "non-object healthz response"}

    out = dict(data)
    # /api/version is best-effort — a healthy gateway always serves it,
    # but a failure here must not sink the status probe.
    version = _get("/api/version")
    if isinstance(version, dict) and version.get("ok") is not False:
        out["deno"] = version.get("deno")
        if version.get("version"):
            out["version"] = version["version"]
    out["ok"] = True
    out["port"] = _base_port()
    out["base_url"] = KLANKER_URL
    out["transport"] = "rest"
    out["auth"] = bool(KLANKER_ADMIN_TOKEN)
    return out


def cmd_logs(args: list[str]) -> dict:
    """GET /api/logs — the recent request ring, optionally limited.

    Usage: logs [--limit N]  (default 25, range 1-500)
    """
    limit = 25
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--limit" and i + 1 < len(args):
            raw = args[i + 1]
            i += 2
            try:
                limit = int(raw)
            except ValueError:
                return {"ok": False, "error": f"limit must be an integer between 1 and 500: {raw!r}"}
            if not 1 <= limit <= 500:
                return {"ok": False, "error": f"limit must be an integer between 1 and 500: {limit}"}
        else:
            return {"ok": False, "error": f"unknown argument: {arg}"}
    return _get(f"/api/logs?limit={limit}")


def cmd_analytics(args: list[str]) -> dict:
    """GET /api/analytics — rollups (requests, spend, cache, latency).

    Usage: analytics [--window 1h|24h|7d]  (default 24h)
    """
    window = "24h"
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--window" and i + 1 < len(args):
            window = args[i + 1]
            i += 2
            if window not in ("1h", "24h", "7d"):
                return {"ok": False, "error": f"window must be one of 1h, 24h, 7d: {window!r}"}
        else:
            return {"ok": False, "error": f"unknown argument: {arg}"}
    return _get(f"/api/analytics?window={window}")


# ── systemd service control ─────────────────────────────────────────
#
# Same pattern as bridge/jellyfin.py / bridge/mining.py: plain
# subprocess.run(["systemctl", ...]) with capture_output, check=False,
# a timeout, and a structured result. No `sudo` shell-out — the JS
# panel's bridgeCmd already passes superuser:'try' so cockpit prompts
# via polkit.

SERVICE_ACTIONS = ("start", "stop", "restart", "status", "enable", "disable")


def _have(binary: str) -> bool:
    """True if binary is on PATH."""
    return shutil.which(binary) is not None


def _service_status() -> dict:
    """Read-only unit state: active/sub + enabled-at-boot."""
    if not _have("systemctl"):
        return {"ok": False, "error": "systemctl not on PATH"}
    try:
        r = subprocess.run(
            ["systemctl", "show", KLANKER_SERVICE,
             "--property=ActiveState,SubState,UnitFileState,ActiveEnterTimestamp"],
            capture_output=True, text=True, timeout=5,
        )
        props = dict(
            line.split("=", 1)
            for line in r.stdout.strip().splitlines()
            if "=" in line
        )
        active = props.get("ActiveState", "unknown")
        sub = props.get("SubState", "unknown")
        enabled = props.get("UnitFileState", "unknown")
        return {
            "ok": True,
            "service": KLANKER_SERVICE,
            "active": active,
            "sub": sub,
            "enabled": enabled,
            "running": active == "active",
        }
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return {"ok": False, "error": str(exc)}


def cmd_service(args: list[str]) -> dict:
    """systemctl wrapper for klanker-gate.service.

    Usage: service <start|stop|restart|status|enable|disable>
    """
    if not args:
        return {"ok": False, "error": "action required: service <start|stop|restart|status|enable|disable>"}
    action = args[0]
    if action not in SERVICE_ACTIONS:
        return {"ok": False, "error": f"unknown action: {action!r} (expected one of {', '.join(SERVICE_ACTIONS)})"}
    if len(args) > 1:
        return {"ok": False, "error": f"unknown argument: {args[1]}"}

    if action == "status":
        return _service_status()

    if not _have("systemctl"):
        return {"ok": False, "error": "systemctl not on PATH"}
    timeout = 30 if action == "restart" else 15
    try:
        r = subprocess.run(
            ["systemctl", action, KLANKER_SERVICE],
            capture_output=True, text=True, timeout=timeout,
        )
        return {
            "ok": r.returncode == 0,
            "action": action,
            "service": KLANKER_SERVICE,
            "rc": r.returncode,
            "output": (r.stdout or "").strip(),
            "stderr": (r.stderr or "").strip(),
        }
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return {"ok": False, "action": action, "service": KLANKER_SERVICE,
                "rc": 1, "stderr": str(exc)}


# ── journal ─────────────────────────────────────────────────────────
#
# journalctl tail, sanitized like the suite's other raw-output
# helpers (netsec/grafana _sanitize_output pattern): ANSI escapes and
# non-printable control chars are stripped, the output is capped, and
# — defensively — the admin token value is masked if it somehow ends
# up in a log line.

_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
_JOURNAL_MAX_CHARS = 32_768  # 32 KB cap — the panel renders it monospace


def _sanitize_journal(text: str) -> str:
    """Strip ANSI/control chars, cap length, mask the admin token."""
    if not text:
        return ""
    text = _ANSI_RE.sub("", text)
    text = "".join(c if (32 <= ord(c) < 127 or c in "\t\n\r") else " " for c in text)
    if KLANKER_ADMIN_TOKEN:
        # NEVER echo the token, even if the service logged it.
        text = text.replace(KLANKER_ADMIN_TOKEN, "***")
    if len(text) > _JOURNAL_MAX_CHARS:
        text = text[:_JOURNAL_MAX_CHARS] + " ... (truncated)"
    return text


def cmd_journal(args: list[str]) -> dict:
    """journalctl -u klanker-gate -n N --no-pager (default 40 lines).

    Usage: journal [N]  (range 1-1000)
    """
    lines = 40
    if args:
        try:
            lines = int(args[0])
        except ValueError:
            return {"ok": False, "error": f"line count must be an integer between 1 and 1000: {args[0]!r}"}
        if not 1 <= lines <= 1000:
            return {"ok": False, "error": f"line count must be an integer between 1 and 1000: {lines}"}
    if len(args) > 1:
        return {"ok": False, "error": f"unknown argument: {args[1]}"}

    if not _have("journalctl"):
        return {"ok": False, "error": "journalctl not on PATH"}
    try:
        r = subprocess.run(
            ["journalctl", "-u", "klanker-gate",
             "-n", str(lines), "--no-pager"],
            capture_output=True, text=True, timeout=10,
        )
        log = _sanitize_journal(r.stdout or "")
        return {
            "ok": r.returncode == 0,
            "service": "klanker-gate",
            "lines": lines,
            "count": log.count("\n") + 1 if log else 0,
            "log": log,
            "stderr": (r.stderr or "").strip(),
        }
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return {"ok": False, "error": str(exc)}


# ── local stack wiring (probed) ──────────────────────────────────────

# The gateway is NOT SaaS-only: ollama / lmstudio / sglang are native
# keyless provider types upstream (packages/contracts/src/provider-
# registry.ts), and llama.cpp (llama-server) / koboldcpp / vLLM / TGI /
# any OpenAI-wire server plug in through the generic "openai-compatible"
# type. This catalog mirrors the web edition's LOCAL_BACKENDS and the
# upstream defaults (packages/providers/src/openai_compat.ts).
LOCAL_BACKENDS = [
    {
        "id": "ollama",
        "name": "Ollama",
        "provider_type": "ollama",
        "base_url": "http://127.0.0.1:11434/v1",
        "auth": "none",
        "caps": "streaming, tools, embeddings",
        "env_wiring": "OLLAMA_BASE_URL=http://127.0.0.1:11434/v1\n"
        "OLLAMA_MODELS=qwen3:14b,llama3.1:8b,nomic-embed-text",
        "note": "native provider type — keyless local daemon",
    },
    {
        "id": "llamacpp",
        "name": "llama.cpp (llama-server)",
        "provider_type": "openai-compatible",
        "base_url": "http://127.0.0.1:8081/v1",
        "auth": "key optional",
        "caps": "streaming, tools",
        "env_wiring": "OPENAI_COMPAT_BASE_URL=http://127.0.0.1:8081/v1\n"
        "OPENAI_COMPAT_DEFAULT_MODEL=qwen2.5-coder-7b",
        "note": "llama-server DEFAULTS TO :8080 — the gateway's own port. "
        "Run it elsewhere (8081 here) or move the gateway",
    },
    {
        "id": "koboldcpp",
        "name": "KoboldCpp",
        "provider_type": "openai-compatible",
        "base_url": "http://127.0.0.1:5001/v1",
        "auth": "key optional",
        "caps": "streaming, tools",
        "env_wiring": "OPENAI_COMPAT_BASE_URL=http://127.0.0.1:5001/v1",
        "note": "koboldcpp serves the OpenAI wire on its main port",
    },
    {
        "id": "lmstudio",
        "name": "LM Studio",
        "provider_type": "lmstudio",
        "base_url": "http://127.0.0.1:1234/v1",
        "auth": "none",
        "caps": "streaming, tools, embeddings",
        "env_wiring": "LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1",
        "note": "native provider type",
    },
    {
        "id": "sglang",
        "name": "SGLang",
        "provider_type": "sgl",
        "base_url": "http://127.0.0.1:30000/v1",
        "auth": "none",
        "caps": "streaming, tools, embeddings",
        "env_wiring": None,
        "note": "native provider type — self-hosted serving framework",
    },
    {
        "id": "vllm",
        "name": "vLLM",
        "provider_type": "openai-compatible",
        "base_url": "http://127.0.0.1:8000/v1",
        "auth": "key optional",
        "caps": "streaming, tools",
        "env_wiring": "OPENAI_COMPAT_BASE_URL=http://127.0.0.1:8000/v1",
        "note": "via the generic openai-compatible account",
    },
]

# Probes run in parallel threads (0.4s timeout each) so the whole
# subcommand answers in well under the 4s bridge budget.
LOCAL_PROBE_TIMEOUT = 0.4


def _probe_one(backend: dict) -> dict:
    """GET <base_url>/models with a 0.4s timeout; offline = reachable:False."""
    url = backend["base_url"].rstrip("/") + "/models"
    req = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=LOCAL_PROBE_TIMEOUT) as resp:
            ok = 200 <= resp.status < 300
    except (urllib.error.URLError, OSError, ValueError):
        ok = False
    out = dict(backend)
    out["reachable"] = ok
    out["latency_ms"] = round((time.monotonic() - started) * 1000) if ok else None
    return out


def cmd_localstack(_args: list[str]) -> dict:
    """Probe the local AI-stack backends from this host and return the
    wiring recipes (provider type, base URL, env / admin-API examples).

    Always LIVE — the probes do not involve the gateway at all: green
    means that local daemon answered /v1/models on this machine. This
    is the wiring aid for an all-local inference stack (ollama,
    llama.cpp, koboldcpp, LM Studio, SGLang, vLLM).
    """
    workers = []
    threads = []
    for backend in LOCAL_BACKENDS:
        worker = {"backend": backend, "result": None}
        workers.append(worker)

        def run(b=backend, w=worker):
            w["result"] = _probe_one(b)

        thread = threading.Thread(target=run)
        thread.start()
        threads.append(thread)
    for thread in threads:
        thread.join(timeout=LOCAL_PROBE_TIMEOUT + 0.2)

    backends = [w["result"] or {**w["backend"], "reachable": False, "latency_ms": None} for w in workers]
    reachable = sum(1 for b in backends if b.get("reachable"))
    token_note = "$KLANKER_ADMIN_TOKEN"
    example_lines = [
        f"curl -s {KLANKER_URL}/api/providers -H 'Authorization: Bearer {token_note}' "
        "-H 'content-type: application/json' "
        "-d '{\"id\":\"llama-server\",\"type\":\"openai-compatible\","
        "\"baseUrl\":\"http://127.0.0.1:8081/v1\",\"enabled\":true,"
        "\"models\":[\"qwen2.5-coder-7b\"]}'",
        f"curl -s {KLANKER_URL}/api/providers -H 'Authorization: Bearer {token_note}' "
        "-H 'content-type: application/json' "
        "-d '{\"id\":\"koboldcpp\",\"type\":\"openai-compatible\","
        "\"baseUrl\":\"http://127.0.0.1:5001/v1\",\"enabled\":true,"
        "\"models\":[\"mistral-nemo-12b\"]}'",
        "# auto-discover the model catalog after registering:",
        f"curl -s -X POST {KLANKER_URL}/api/providers/llama-server/refresh-models "
        f"-H 'Authorization: Bearer {token_note}'",
    ]
    return {
        "ok": True,
        "source": "live",
        "backends": backends,
        "count": len(backends),
        "reachable": reachable,
        "base_url": KLANKER_URL,
        "admin_register_example": "\n".join(example_lines),
        "note": (
            f"probed from this host (0.4s timeout each): {reachable}/{len(backends)} "
            "local backends answered /v1/models. ollama + lmstudio register via env; "
            "llama.cpp + koboldcpp + vllm register as openai-compatible accounts "
            "(env registers ONE such account — use POST /api/providers for several). "
            "Port note: llama-server defaults to :8080, the gateway's own port"
        ),
    }


# ── dispatch table ───────────────────────────────────────────────────

COMMANDS = {
    "status":     lambda _args: cmd_status(_args),
    "providers":  lambda _args: _get("/api/providers"),
    "models":     lambda _args: _get("/v1/models"),
    "vkeys":      lambda _args: _get("/api/virtual-keys"),
    "logs":       cmd_logs,
    "analytics":  cmd_analytics,
    "runtime":    lambda _args: _get("/api/runtime"),
    "service":    cmd_service,
    "journal":    cmd_journal,
    "localstack": cmd_localstack,
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
