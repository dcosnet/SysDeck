#!/usr/bin/env python3
"""SysDeck - Jellyfin Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Manages the Jellyfin media server as a systemd service and exposes
the built-in Jellyfin web UI for iframe embedding in the SysDeck
panel.

v0.0.35 directive: "next we will integrate a jellyfin management
module where it starts, stops, and loads the admin panel in the
module." Jellyfin ships a single systemd unit (jellyfin.service) on
every distro that packages it, and serves a full web UI on
http://127.0.0.1:8096. The bridge starts/stops the service via
systemctl; the panel iframes the running web UI — same pattern as
the v0.0.34 Glances integration (bridge/glances.py).

Subcommands:
  summary       — service status + version + port + library counts
  status        — service status only (active/sub/uptime)
  start         — systemctl start jellyfin.service
  stop          — systemctl stop jellyfin.service
  restart       — systemctl restart jellyfin.service
  web-status    — {running, port, url} for the iframe
  libraries     — best-effort library list from Jellyfin's HTTP API

Cockpit way (v0.0.31+ pattern): the bridge runs systemctl via
subprocess directly — no `sudo` shell-out. The JS panel passes
{ superuser: 'try' } to cockpit.spawn so the cockpit bridge prompts
the operator via polkit for the org.sysdeck.jellyfin.modify action
(added in v0.0.35).

Jellyfin is GPL-2.0 licensed by the Jellyfin contributors. This
bridge helper invokes it as a separate process via subprocess — the
suite (MIT) and Jellyfin (GPL-2.0) remain independent programs. No
Jellyfin code is bundled.

Usage:
    python3 /usr/lib/sysdeck/bridge/jellyfin.py summary
    python3 /usr/lib/sysdeck/bridge/jellyfin.py start
    python3 /usr/lib/sysdeck/bridge/jellyfin.py web-status
"""

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from typing import Any


JELLYFIN_LICENSE = "GPL-2.0"
JELLYFIN_URL = "https://jellyfin.org/"
JELLYFIN_SERVICE = "jellyfin.service"

# Default Jellyfin webserver port. The operator can override via
# /etc/jellyfin/networking.xml; this default matches Jellyfin's
# out-of-the-box config.
JELLYFIN_WEB_HOST = "127.0.0.1"
JELLYFIN_WEB_PORT = 8096

# Default URL the panel iframes. Jellyfin binds to 0.0.0.0 by default;
# the panel uses 127.0.0.1 to keep the iframe on the cockpit host.
JELLYFIN_WEB_URL = f"http://{JELLYFIN_WEB_HOST}:{JELLYFIN_WEB_PORT}"


def _have(binary: str) -> bool:
    """True if binary is on PATH."""
    return shutil.which(binary) is not None


def _systemctl_show(unit: str, props: list[str]) -> dict[str, str]:
    """Return a dict of {property: value} from systemctl show."""
    out = subprocess.run(
        ["systemctl", "show", unit, "--property=" + ",".join(props)],
        capture_output=True, text=True, timeout=5,
    ).stdout.strip()
    result = {}
    for line in out.splitlines():
        k, _, v = line.partition("=")
        if k:
            result[k] = v
    return result


def _service_status(unit: str) -> dict[str, Any]:
    """Return service state dict: {active, sub, status, uptime_seconds}."""
    props = _systemctl_show(unit, ["ActiveState", "SubState", "ActiveEnterTimestamp"])
    active = props.get("ActiveState", "unknown")
    sub = props.get("SubState", "unknown")
    uptime = 0
    ts = props.get("ActiveEnterTimestamp", "")
    if ts:
        try:
            dt = datetime.strptime(ts[:25], "%a %Y-%m-%d %H:%M:%S")
            uptime = int((datetime.now() - dt).total_seconds())
        except (ValueError, OSError):
            pass
    if active == "active":
        status = "running"
    elif active == "activating":
        status = "starting"
    elif active == "failed":
        status = "error"
    elif active in ("inactive", "deactivating"):
        status = "stopped"
    else:
        status = "unknown"
    return {"active": active, "sub": sub, "status": status, "uptime_seconds": uptime}


def _detect_version() -> str:
    """Best-effort Jellyfin version detection."""
    if _have("jellyfin"):
        out = subprocess.run(
            ["jellyfin", "--version"], capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        return out.splitlines()[0][:80] if out else ""
    # Read from /etc/jellyfin/jellyfin.db if installed (best-effort)
    return ""


def _detect_port() -> int:
    """Return the configured Jellyfin port (best-effort).

    Reads /etc/jellyfin/networking.xml if present; falls back to
    the default 8096.
    """
    try:
        with open("/etc/jellyfin/networking.xml", encoding="utf-8") as fh:
            for line in fh:
                if "<Port>" in line and "</Port>" in line:
                    port_str = line.split("<Port>")[1].split("</Port>")[0].strip()
                    return int(port_str)
    except (FileNotFoundError, ValueError, PermissionError, OSError):
        pass
    return JELLYFIN_WEB_PORT


def cmd_summary(_args: list[str]) -> dict[str, Any]:
    """Combined summary — service status + version + port + URL."""
    if not _have("jellyfin") and not _unit_loaded():
        return {
            "available": False,
            "reason": "jellyfin not installed",
            "install": (
                "Arch: pacman -S jellyfin  ·  "
                "Debian: apt install jellyfin  ·  "
                "Fedora: dnf install jellyfin"
            ),
            "license": JELLYFIN_LICENSE,
            "url": JELLYFIN_URL,
        }
    state = _service_status(JELLYFIN_SERVICE)
    port = _detect_port()
    return {
        "available": True,
        "service": JELLYFIN_SERVICE,
        "status": state["status"],
        "active": state["active"],
        "sub": state["sub"],
        "uptime_seconds": state["uptime_seconds"],
        "version": _detect_version(),
        "port": port,
        "url": f"http://{JELLYFIN_WEB_HOST}:{port}",
        "license": JELLYFIN_LICENSE,
        "homepage": JELLYFIN_URL,
    }


def _unit_loaded() -> bool:
    """True if the jellyfin.service unit is loaded on the host."""
    out = subprocess.run(
        ["systemctl", "list-unit-files", JELLYFIN_SERVICE],
        capture_output=True, text=True, timeout=5,
    ).stdout
    return JELLYFIN_SERVICE in out


def cmd_status(_args: list[str]) -> dict[str, Any]:
    """Detailed service status."""
    if not _have("jellyfin") and not _unit_loaded():
        return {"available": False, "reason": "jellyfin not installed"}
    return _service_status(JELLYFIN_SERVICE)


def _systemctl(action: str) -> dict[str, Any]:
    """Run systemctl <action> jellyfin.service and return the result."""
    if not _have("systemctl"):
        return {"rc": 127, "success": False, "stderr": "systemctl not found"}
    try:
        r = subprocess.run(
            ["systemctl", action, JELLYFIN_SERVICE],
            capture_output=True, text=True, timeout=30,
        )
        return {
            "action": action,
            "service": JELLYFIN_SERVICE,
            "rc": r.returncode,
            "success": r.returncode == 0,
            "output": (r.stdout or "").strip(),
            "stderr": (r.stderr or "").strip(),
        }
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return {"action": action, "service": JELLYFIN_SERVICE,
                "rc": 1, "success": False, "stderr": str(exc)}


def cmd_start(_args: list[str]) -> dict[str, Any]:
    return _systemctl("start")


def cmd_stop(_args: list[str]) -> dict[str, Any]:
    return _systemctl("stop")


def cmd_restart(_args: list[str]) -> dict[str, Any]:
    return _systemctl("restart")


def cmd_web_status(_args: list[str]) -> dict[str, Any]:
    """Return the Jellyfin web UI URL + running state for iframe embedding."""
    if not _have("jellyfin") and not _unit_loaded():
        return {
            "available": False,
            "reason": "jellyfin not installed",
            "install": (
                "Arch: pacman -S jellyfin  ·  "
                "Debian: apt install jellyfin  ·  "
                "Fedora: dnf install jellyfin"
            ),
            "license": JELLYFIN_LICENSE,
            "url": JELLYFIN_URL,
        }
    state = _service_status(JELLYFIN_SERVICE)
    port = _detect_port()
    return {
        "available": True,
        "running": state["status"] == "running",
        "status": state["status"],
        "port": port,
        "url": f"http://{JELLYFIN_WEB_HOST}:{port}",
        "license": JELLYFIN_LICENSE,
        "homepage": JELLYFIN_URL,
    }


def cmd_libraries(_args: list[str]) -> dict[str, Any]:
    """Best-effort library list via the Jellyfin HTTP API.

    Calls GET /Library/VirtualFolders on the local Jellyfin instance.
    Returns {libraries: [...], count: N} or {error: ...} if the API
    is unreachable or the operator has not yet completed initial
    setup (no admin user → 401).
    """
    import urllib.request
    import urllib.error
    port = _detect_port()
    url = f"http://{JELLYFIN_WEB_HOST}:{port}/Library/VirtualFolders"
    try:
        # Jellyfin's public API doesn't require auth for /Library/VirtualFolders
        # when called from localhost on default config — best-effort.
        req = urllib.request.Request(url, headers={
            "Accept": "application/json",
            "X-Emby-Authorization": 'MediaBrowser Client="SysDeck", Device="Cockpit", Version="0.0.35"',
        })
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        libs = [
            {
                "name": lib.get("Name", "?"),
                "type": lib.get("CollectionType", "mixed"),
                "paths": lib.get("Locations", []),
            }
            for lib in (data if isinstance(data, list) else [])
        ]
        return {"libraries": libs, "count": len(libs)}
    except urllib.error.HTTPError as exc:
        return {"error": f"HTTP {exc.code}: {exc.reason} — Jellyfin may need initial setup via the web UI first."}
    except urllib.error.URLError as exc:
        return {"error": f"Connection refused: {exc.reason} — Jellyfin may not be running."}
    except (ValueError, OSError, KeyError) as exc:
        return {"error": str(exc)}


COMMANDS = {
    "summary":     lambda args: cmd_summary(args),
    "status":      lambda args: cmd_status(args),
    "start":       lambda args: cmd_start(args),
    "stop":        lambda args: cmd_stop(args),
    "restart":     lambda args: cmd_restart(args),
    "web-status":  lambda args: cmd_web_status(args),
    "libraries":   lambda args: cmd_libraries(args),
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
