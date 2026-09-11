#!/usr/bin/env python3
"""
SysDeck - Mining Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

v0.0.34 EXPANDED TO 1999 POWER-TOOL STYLE. Per user directive:
"themes and mining they need to be expanded for maximum ui
control. think 1999 power tool style here." The Mining Dashboard
panel surfaces every XMRig REST API knob:

  summary            — GET /1/summary (live hashrate, pool, threads)
  threads            — GET /1/summary → hashrate.threads[] detail
  pool-config-get    — GET /1/config → the pool section
  pool-config-set    — PUT /1/config with a new pool URL/username/pass
  threads-config-get — GET /1/config → cpu.threads section
  threads-config-set — PUT /1/config with new thread count
  algorithm-get      — GET /1/config → cpu.asm / randomx section
  algorithm-set      — PUT /1/config with a new algorithm preset
  pause              — POST /json_rpc method=paused (id 1)
  resume             — POST /json_rpc method=resumed (id 1)
  pause-worker <id>  — POST /json_rpc method=pause_worker
  resume-worker <id> — POST /json_rpc method=resume_worker
  start              — systemctl start xmrig.service (superuser)
  stop               — systemctl stop xmrig.service (superuser)
  restart            — systemctl restart xmrig.service (superuser)
  service-status     — systemctl is-active xmrig.service (read-only)

Cockpit way (v0.0.31+ pattern): the bridge runs systemctl / curl via
subprocess directly; the JS panel passes { superuser: 'try' } for
mutating ops so the cockpit bridge prompts the operator via polkit
for the org.sysdeck.system.modify action (shipped since v0.0.17 —
authorizes /usr/bin/systemctl, /usr/bin/hostnamectl, etc.).

XMRig is GPL-3.0 licensed by the XMRig project. This bridge helper
invokes its REST API over HTTP — the suite (MIT) and XMRig (GPL-3.0)
remain independent programs. No XMRig code is bundled.

Usage:
    python3 /usr/lib/sysdeck/bridge/mining.py summary
    python3 /usr/lib/sysdeck/bridge/mining.py pool-config-set monero.hero '$wallet' x
    python3 /usr/lib/sysdeck/bridge/mining.py threads-config-set 8
    python3 /usr/lib/sysdeck/bridge/mining.py pause-worker 1
"""

import json
import os
import shutil
import subprocess
import sys
import urllib.request
import urllib.error
from typing import Any


XMRIG_URL = "http://127.0.0.1:18088"
XMRIG_SERVICE = "xmrig.service"

# Algorithm presets the panel surfaces as a `<select>`. XMRig auto-detects
# by default; the operator can force a specific variant. The names here
# match XMRig's `--coin` / `--algo` flag values.
ALGORITHM_PRESETS: list[dict[str, str]] = [
    {"id": "auto",        "name": "Auto (default)",  "value": ""},
    {"id": "rx/0",       "name": "RandomX (Monero)",  "value": "rx/0"},
    {"id": "rx/wow",     "name": "RandomWOW (Wownero)", "value": "rx/wow"},
    {"id": "rx/arq",     "name": "RandomARQ (ArQmA)", "value": "rx/arq"},
    {"id": "rx/sfx",     "name": "RandomSFX (Safex)",  "value": "rx/sfx"},
    {"id": "argon2/chukwa", "name": "Chukwa-2 (TurtleCoin)", "value": "argon2/chukwa"},
    {"id": "argon2/wrkz",   "name": "WRKZ (WrkzCoin)",       "value": "argon2/wrkz"},
]


# ── HTTP helpers ─────────────────────────────────────────────────────


def _http_get(path: str, timeout: int = 3) -> dict[str, Any] | None:
    """GET <XMRIG_URL><path>, return parsed JSON or None on failure."""
    try:
        with urllib.request.urlopen(f"{XMRIG_URL}{path}", timeout=timeout) as r:
            return json.loads(r.read().decode())
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError, json.JSONDecodeError):
        return None


def _http_post_json(path: str, body: dict[str, Any], timeout: int = 3) -> dict[str, Any] | None:
    """POST JSON to <XMRIG_URL><path>, return parsed JSON or None on failure."""
    try:
        req = urllib.request.Request(
            f"{XMRIG_URL}{path}",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError, json.JSONDecodeError):
        return None


def _http_put_json(path: str, body: dict[str, Any], timeout: int = 3) -> dict[str, Any] | None:
    """PUT JSON to <XMRIG_URL><path>, return parsed JSON or None on failure."""
    try:
        req = urllib.request.Request(
            f"{XMRIG_URL}{path}",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError, json.JSONDecodeError):
        return None


def _is_xmrig_running() -> bool:
    """Quick connectivity check — GET /1/summary."""
    return _http_get("/1/summary") is not None


def _have(binary: str) -> bool:
    return shutil.which(binary) is not None


# ── Read-only subcommands ───────────────────────────────────────────


def cmd_summary(_args: list[str]) -> dict[str, Any] | None:
    """Return XMRig summary, or None if XMRig is not reachable."""
    return _http_get("/1/summary")


def cmd_threads(_args: list[str]) -> dict[str, Any]:
    """Return per-thread hashrate detail from the summary endpoint."""
    summary = _http_get("/1/summary")
    if summary is None:
        return {"available": False, "reason": "XMRig REST API not reachable",
                "hint": "Confirm XMRig is running with --http-host 127.0.0.1 --http-port 18088."}
    threads = (summary.get("hashrate") or {}).get("threads") or []
    return {
        "available": True,
        "threads": [{"index": i, "hashrate": h if isinstance(h, (int, float)) else (h[0] if isinstance(h, list) and h else 0)}
                     for i, h in enumerate(threads)],
        "thread_count": len(threads),
    }


def cmd_pool_config_get(_args: list[str]) -> dict[str, Any]:
    """Return the current pool configuration from /1/config."""
    cfg = _http_get("/1/config")
    if cfg is None:
        return {"available": False, "reason": "XMRig REST API not reachable"}
    pools = cfg.get("pools") or []
    return {
        "available": True,
        "pools": pools,
        "active_pool_index": 0,  # XMRig fails over to the next pool on disconnect
        "pool_count": len(pools),
    }


def cmd_threads_config_get(_args: list[str]) -> dict[str, Any]:
    """Return the current thread configuration from /1/config."""
    cfg = _http_get("/1/config")
    if cfg is None:
        return {"available": False, "reason": "XMRig REST API not reachable"}
    cpu = cfg.get("cpu") or {}
    return {
        "available": True,
        "thread_count": cpu.get("threads", 0),
        "hugepages": cpu.get("huge-pages", False),
        "hw_aes": cpu.get("hw-aes", True),
        "priority": cpu.get("priority"),
        "cpu_affinity": cpu.get("cpu-affinity"),
        "memory_pool": cpu.get("memory-pool"),
        "yield": cpu.get("yield"),
    }


def cmd_algorithm_get(_args: list[str]) -> dict[str, Any]:
    """Return the current algorithm + the preset list for the panel."""
    cfg = _http_get("/1/config")
    if cfg is None:
        return {"available": False, "reason": "XMRig REST API not reachable",
                "presets": ALGORITHM_PRESETS}
    cpu = cfg.get("cpu") or {}
    current = cpu.get("asm") or cpu.get("algo") or ""
    return {
        "available": True,
        "current": current,
        "presets": ALGORITHM_PRESETS,
    }


def cmd_service_status(_args: list[str]) -> dict[str, Any]:
    """Return the systemd service state (read-only)."""
    if not _have("systemctl"):
        return {"available": False, "reason": "systemctl not on PATH"}
    r = subprocess.run(["systemctl", "is-active", XMRIG_SERVICE],
                       capture_output=True, text=True, check=False, timeout=5)
    state = r.stdout.strip() or "unknown"
    return {
        "available": True,
        "service": XMRIG_SERVICE,
        "state": state,
        "active": state == "active",
    }


# ── Mutating subcommands ────────────────────────────────────────────


def cmd_pool_config_set(args: list[str]) -> dict[str, Any]:
    """Set the pool URL / username / password via PUT /1/config.

    Usage: pool-config-set <url> <username> [password]
    The bridge reads the current config, replaces the first pool entry,
    writes it back. The operator authenticates via polkit (the JS panel
    passes superuser:'try').
    """
    if len(args) < 2:
        return {"error": "usage: pool-config-set <url> <username> [password]"}
    url, username = args[0], args[1]
    password = args[2] if len(args) > 2 else "x"
    cfg = _http_get("/1/config")
    if cfg is None:
        return {"available": False, "reason": "XMRig REST API not reachable"}
    new_pool = {"url": url, "user": username, "pass": password, "rig-id": "", "nicehash": False, "keep-alive": True, "enabled": True}
    if not cfg.get("pools"):
        cfg["pools"] = [new_pool]
    else:
        cfg["pools"][0] = {**cfg["pools"][0], **new_pool}
    result = _http_put_json("/1/config", cfg)
    return {
        "set": result is not None,
        "url": url,
        "username": username,
        "password_set": password != "x",
        "raw": result,
    }


def cmd_threads_config_set(args: list[str]) -> dict[str, Any]:
    """Set the thread count via PUT /1/config."""
    if not args:
        return {"error": "usage: threads-config-set <count>"}
    try:
        count = int(args[0])
    except ValueError:
        return {"error": f"count must be numeric, got {args[0]}"}
    if count < 1 or count > 256:
        return {"error": f"count {count} out of range (1-256)"}
    cfg = _http_get("/1/config")
    if cfg is None:
        return {"available": False, "reason": "XMRig REST API not reachable"}
    cfg.setdefault("cpu", {})["threads"] = count
    result = _http_put_json("/1/config", cfg)
    return {"set": result is not None, "thread_count": count, "raw": result}


def cmd_algorithm_set(args: list[str]) -> dict[str, Any]:
    """Set the algorithm via PUT /1/config.

    Usage: algorithm-set <preset-id>. The preset-id must match one of
    ALGORITHM_PRESETS — the bridge looks up the XMRig algo string
    from there.
    """
    if not args:
        return {"error": "preset id required"}
    preset_id = args[0]
    preset = next((p for p in ALGORITHM_PRESETS if p["id"] == preset_id), None)
    if preset is None:
        return {"error": f"preset '{preset_id}' not found",
                "available_presets": [p["id"] for p in ALGORITHM_PRESETS]}
    cfg = _http_get("/1/config")
    if cfg is None:
        return {"available": False, "reason": "XMRig REST API not reachable"}
    if preset["value"]:
        cfg.setdefault("cpu", {})["asm"] = True
        cfg["cpu"]["asm"] = preset["value"]
    else:
        cfg.setdefault("cpu", {}).pop("asm", None)
    result = _http_put_json("/1/config", cfg)
    return {"set": result is not None, "preset": preset_id, "algo": preset["value"], "raw": result}


def cmd_pause(_args: list[str]) -> dict[str, Any]:
    """Pause all mining via XMRig JSON-RPC."""
    result = _http_post_json("/json_rpc", {"id": 1, "method": "paused"})
    return {"paused": result is not None, "raw": result}


def cmd_resume(_args: list[str]) -> dict[str, Any]:
    """Resume all mining via XMRig JSON-RPC."""
    result = _http_post_json("/json_rpc", {"id": 1, "method": "resumed"})
    return {"resumed": result is not None, "raw": result}


def cmd_pause_worker(args: list[str]) -> dict[str, Any]:
    """Pause one worker (thread) by index via XMRig JSON-RPC."""
    if not args:
        return {"error": "worker id required"}
    try:
        worker_id = int(args[0])
    except ValueError:
        return {"error": f"worker id must be numeric, got {args[0]}"}
    result = _http_post_json("/json_rpc", {"id": worker_id, "method": "pause_worker"})
    return {"paused": result is not None, "worker_id": worker_id, "raw": result}


def cmd_resume_worker(args: list[str]) -> dict[str, Any]:
    """Resume one worker (thread) by index via XMRig JSON-RPC."""
    if not args:
        return {"error": "worker id required"}
    try:
        worker_id = int(args[0])
    except ValueError:
        return {"error": f"worker id must be numeric, got {args[0]}"}
    result = _http_post_json("/json_rpc", {"id": worker_id, "method": "resume_worker"})
    return {"resumed": result is not None, "worker_id": worker_id, "raw": result}


def cmd_start(_args: list[str]) -> dict[str, Any]:
    """Start the xmrig systemd service."""
    if not _have("systemctl"):
        return {"available": False, "reason": "systemctl not on PATH"}
    r = subprocess.run(["systemctl", "start", XMRIG_SERVICE],
                       capture_output=True, text=True, check=False, timeout=15)
    return {"started": r.returncode == 0, "rc": r.returncode,
            "output": r.stdout, "stderr": r.stderr}


def cmd_stop(_args: list[str]) -> dict[str, Any]:
    """Stop the xmrig systemd service."""
    if not _have("systemctl"):
        return {"available": False, "reason": "systemctl not on PATH"}
    r = subprocess.run(["systemctl", "stop", XMRIG_SERVICE],
                       capture_output=True, text=True, check=False, timeout=15)
    return {"stopped": r.returncode == 0, "rc": r.returncode,
            "output": r.stdout, "stderr": r.stderr}


def cmd_restart(_args: list[str]) -> dict[str, Any]:
    """Restart the xmrig systemd service."""
    if not _have("systemctl"):
        return {"available": False, "reason": "systemctl not on PATH"}
    r = subprocess.run(["systemctl", "restart", XMRIG_SERVICE],
                       capture_output=True, text=True, check=False, timeout=30)
    return {"restarted": r.returncode == 0, "rc": r.returncode,
            "output": r.stdout, "stderr": r.stderr}


# ── Dispatch table ───────────────────────────────────────────────────

COMMANDS = {
    # Read-only:
    "summary":             lambda _args: cmd_summary([]),
    "threads":             lambda _args: cmd_threads([]),
    "pool-config-get":     lambda _args: cmd_pool_config_get([]),
    "threads-config-get":  lambda _args: cmd_threads_config_get([]),
    "algorithm-get":       lambda _args: cmd_algorithm_get([]),
    "service-status":      lambda _args: cmd_service_status([]),
    # Mutating (XMRig REST API):
    "pool-config-set":     lambda args: cmd_pool_config_set(args),
    "threads-config-set":  lambda args: cmd_threads_config_set(args),
    "algorithm-set":       lambda args: cmd_algorithm_set(args),
    "pause":               lambda _args: cmd_pause([]),
    "resume":              lambda _args: cmd_resume([]),
    "pause-worker":        lambda args: cmd_pause_worker(args),
    "resume-worker":       lambda args: cmd_resume_worker(args),
    # Mutating (systemd service control — polkit org.sysdeck.system.manage):
    "start":               lambda _args: cmd_start([]),
    "stop":                lambda _args: cmd_stop([]),
    "restart":             lambda _args: cmd_restart([]),
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
    result = cmd(argv[1:])
    if result is None:
        # None signals "XMRig not reachable" — emit null so the JS
        # panel can render the install hint.
        print("null")
    else:
        print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
