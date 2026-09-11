#!/usr/bin/env python3
"""
SysDeck - Glances Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Aggregates system monitoring data from the Glances CLI
(https://github.com/nicolargo/glances) into a structured JSON document.

v0.0.34 INTEGRATES THE GLANCES BUILT-IN WEB UI. The user directive:
"glances is not integrated yet i just assumed you would integrate the
built in webui as a module." Glances ships a webserver via
`glances -w` (default port 61208, 127.0.0.1). The bridge starts that
webserver as a background process; the JS panel iframes the running
web UI at http://127.0.0.1:61208 — full Glances web UI (all graphs,
all sensors, all top processes, all history) without SysDeck
re-implementing any of it.

Subcommands:
  snapshot       — full system snapshot (kept from v0.0.11)
  cpu            — CPU metrics subset (kept)
  memory         — memory metrics subset (kept)
  network        — network metrics subset (kept)
  start-web      — start glances -w on 127.0.0.1:61208 (background)
                   writes the PID to /var/lib/sysdeck/glances/web.pid
  stop-web       — kill the background webserver (read PID file)
  web-status     — return {running, pid, port, url}
  web-port       — return the actual listening port (defaults to 61208)

Cockpit way (v0.0.31+ pattern): the bridge runs glances via subprocess
directly — no `sudo` shell-out. The JS panel passes { superuser: 'try' }
to cockpit.spawn so the cockpit bridge prompts the operator via polkit
for the org.sysdeck.system.manage action (shipped since v0.0.17 —
authorizes /usr/bin/systemctl, /usr/bin/hostnamectl, etc., and by
extension any system-level subprocess the bridge runs).

Glances is GPL-3.0 licensed by Nicolargo. This bridge helper invokes
it as a separate process via subprocess — the suite (MIT) and Glances
(GPL-3.0) remain independent programs. No Glances code is bundled.

Usage:
    python3 /usr/lib/sysdeck/bridge/glances.py snapshot
    python3 /usr/lib/sysdeck/bridge/glances.py start-web
    python3 /usr/lib/sysdeck/bridge/glances.py web-status
"""

import json
import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any


GLANCES_LICENSE = "GPL-3.0"
GLANCES_AUTHOR = "Nicolargo"
GLANCES_URL = "https://github.com/nicolargo/glances"

# Default Glances webserver port. The operator can override via the
# `--port` flag on start-web; this default matches `glances -w`'s own
# default.
GLANCES_WEB_HOST = "127.0.0.1"
GLANCES_WEB_PORT = 61208

# State directory for the background webserver's PID file. Created on
# first use; the cockpit superuser channel handles root perms.
STATE_DIR = Path("/var/lib/sysdeck/glances")
WEB_PID_FILE = STATE_DIR / "web.pid"


def _have(binary: str) -> bool:
    """True if binary is on PATH."""
    return shutil.which(binary) is not None


def _ensure_state_dir() -> None:
    """Create the state dir. Best-effort; polkit handles root perms."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
    except (PermissionError, OSError):
        pass


def _read_pid() -> int | None:
    """Return the PID of the running glances webserver, or None."""
    try:
        return int(WEB_PID_FILE.read_text(encoding="utf-8").strip())
    except (FileNotFoundError, ValueError, PermissionError, OSError):
        return None


def _write_pid(pid: int | None) -> None:
    """Record the webserver PID (or clear it if pid is None)."""
    try:
        _ensure_state_dir()
        if pid is None:
            WEB_PID_FILE.unlink(missing_ok=True)
        else:
            WEB_PID_FILE.write_text(str(pid), encoding="utf-8")
    except (PermissionError, OSError):
        pass


def _is_pid_alive(pid: int) -> bool:
    """Return True if a process with the given PID exists.

    Uses os.kill(pid, 0) — signal 0 is a no-op that returns successfully
    if the process exists and the caller has permission to signal it,
    or raises ProcessLookupError / PermissionError otherwise.
    """
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False
    except OSError:
        return False


def run_glances(args: list[str]) -> str:
    """Run glances with the given args, returning stdout."""
    return subprocess.run(
        ["glances", *args], capture_output=True, text=True, check=True,
    ).stdout


def snapshot() -> dict[str, Any]:
    """Full system snapshot from glances JSON export.

    Calls: glances --time 1 --quiet --export json --once
    Returns the parsed JSON document.
    """
    output = run_glances(["--time", "1", "--quiet", "--export", "json", "--once"])
    lines = output.strip().splitlines()
    if not lines:
        return {}
    return json.loads(lines[-1])


def cpu() -> dict[str, Any]:
    """CPU metrics subset from a glances snapshot."""
    data = snapshot()
    return data.get("cpu", {})


def memory() -> dict[str, Any]:
    """Memory metrics subset from a glances snapshot."""
    data = snapshot()
    return {
        "mem": data.get("mem", {}),
        "memswap": data.get("memswap", {}),
    }


def network() -> dict[str, Any]:
    """Network interface metrics subset from a glances snapshot."""
    data = snapshot()
    return data.get("network", {})


# ── Web UI management ────────────────────────────────────────────────
#
# Glances ships a built-in webserver (`glances -w`) that serves a full
# web UI at http://127.0.0.1:61208 — the operator gets every chart,
# every sensor, every top process, and the history grapher without
# SysDeck re-implementing any of it. The bridge starts the webserver as
# a background process via subprocess.Popen, records the PID, and the
# JS panel iframes the URL.


def cmd_start_web(args: list[str]) -> dict[str, Any]:
    """Start the Glances built-in webserver (`glances -w`) in the background.

    Optional args: [port] — overrides the default 61208.
    The bridge runs `glances -w --bind 127.0.0.1 --port <port>` detached,
    writes the child PID to /var/lib/sysdeck/glances/web.pid, and returns
    immediately. The JS panel polls web-status to detect when the
    webserver is up (typically <1s on a warm start).
    """
    if not _have("glances"):
        return {
            "available": False,
            "reason": "glances not installed",
            "install": "pip install glances  # or: pacman -S glances / apt install glances / dnf install glances",
        }
    port = GLANCES_WEB_PORT
    if args:
        try:
            port = int(args[0])
        except ValueError:
            return {"error": f"port must be numeric, got {args[0]}"}
    # If a PID is already on file and alive, don't start a second one.
    existing_pid = _read_pid()
    if existing_pid is not None and _is_pid_alive(existing_pid):
        return {
            "started": False,
            "already_running": True,
            "pid": existing_pid,
            "port": port,
            "url": f"http://{GLANCES_WEB_HOST}:{port}",
        }
    # Detach: open stdout/stderr to /dev/null, start in new session so
    # the child survives the bridge process exiting, record the PID.
    try:
        _ensure_state_dir()
        proc = subprocess.Popen(
            ["glances", "-w", "--bind", GLANCES_WEB_HOST, "--port", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except (FileNotFoundError, OSError) as exc:
        return {"started": False, "error": str(exc)}
    _write_pid(proc.pid)
    return {
        "started": True,
        "pid": proc.pid,
        "port": port,
        "url": f"http://{GLANCES_WEB_HOST}:{port}",
    }


def cmd_stop_web(_args: list[str]) -> dict[str, Any]:
    """Stop the background Glances webserver."""
    pid = _read_pid()
    if pid is None:
        return {"stopped": False, "reason": "no PID file — webserver not started"}
    if not _is_pid_alive(pid):
        _write_pid(None)
        return {"stopped": True, "reason": "process was already dead (PID file cleared)"}
    try:
        # SIGTERM first — graceful shutdown. The glances webserver
        # handles SIGTERM cleanly and exits within ~1s.
        os.kill(pid, signal.SIGTERM)
        _write_pid(None)
        return {"stopped": True, "pid": pid}
    except (ProcessLookupError, PermissionError, OSError) as exc:
        return {"stopped": False, "pid": pid, "error": str(exc)}


def cmd_web_status(_args: list[str]) -> dict[str, Any]:
    """Return whether the Glances webserver is running + its URL."""
    if not _have("glances"):
        return {
            "available": False,
            "reason": "glances not installed",
            "install": "pip install glances  # or: pacman -S glances / apt install glances",
        }
    pid = _read_pid()
    if pid is None:
        return {
            "available": True,
            "running": False,
            "url": f"http://{GLANCES_WEB_HOST}:{GLANCES_WEB_PORT}",
            "hint": "Click Start Web UI to launch the built-in Glances webserver.",
        }
    if not _is_pid_alive(pid):
        _write_pid(None)
        return {
            "available": True,
            "running": False,
            "url": f"http://{GLANCES_WEB_HOST}:{GLANCES_WEB_PORT}",
            "hint": "Previous webserver process died — restart it.",
        }
    return {
        "available": True,
        "running": True,
        "pid": pid,
        "port": GLANCES_WEB_PORT,
        "url": f"http://{GLANCES_WEB_HOST}:{GLANCES_WEB_PORT}",
    }


COMMANDS = {
    # v0.0.11 read-only snapshot subcommands (kept):
    "snapshot":    lambda _args: snapshot(),
    "cpu":         lambda _args: cpu(),
    "memory":      lambda _args: memory(),
    "network":     lambda _args: network(),
    # v0.0.34 web UI integration:
    "start-web":   lambda args: cmd_start_web(args),
    "stop-web":    lambda args: cmd_stop_web(args),
    "web-status":  lambda _args: cmd_web_status([]),
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
