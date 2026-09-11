#!/usr/bin/env python3
"""SysDeck - Photos Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Manages self-hosted photo management backends as systemd services
and exposes the built-in admin web UI for iframe embedding in the
SysDeck panel.

v0.0.35 directive: "as well as a photo manager of equal quality.
with its own module." Following the Jellyfin pattern: start/stop/
restart the service via systemctl; the panel iframes the running
admin web UI. Equal quality means the photo manager module ships
with the same service-control + iframe-load shape as Jellyfin.

Multi-backend design — same shape as bridge/db.py: the operator
chooses the backend that's installed on the host. Each entry in
BACKEND_REGISTRY declares its systemd unit, web port, install hint,
and license. The bridge auto-detects which are installed; the
panel renders a backend card per installed one and an install
hint card per absent one.

Backends shipped:
  PhotoPrism         — single Go binary · MIT · port 2342
  Piwigo             — single PHP-FPM app · GPL-2.0 · port 80
  Lychee             — single PHP-FPM app · MIT · port 80
  Nextcloud-Memories — Nextcloud plugin · AGPL-3.0 · port 80
  LibrePhotos        — Django + React · MIT · port 3000

Excluded (intentionally, per the "equal quality" bar):
  Google Photos / iCloud / etc. — cloud-only, no systemd unit,
  no admin panel reachable from the host.

Subcommands:
  summary       — list all detected backends with status + port + url
  status <id>   — detailed status for one backend
  start <id>    — systemctl start <service>
  stop <id>     — systemctl stop <service>
  restart <id>  — systemctl restart <service>
  web-status <id> — {running, port, url} for iframe embedding

Cockpit way (v0.0.31+ pattern): the bridge runs systemctl via
subprocess directly — no `sudo` shell-out. The JS panel passes
{ superuser: 'try' } to cockpit.spawn so the cockpit bridge prompts
the operator via polkit for the org.sysdeck.photos.modify action
(added in v0.0.35).

Each backend is invoked as a separate process via subprocess —
the suite (MIT) and each backend (its own license) remain
independent programs. No backend code is bundled.

Usage:
    python3 /usr/lib/sysdeck/bridge/photos.py summary
    python3 /usr/lib/sysdeck/bridge/photos.py start photoprism
    python3 /usr/lib/sysdeck/bridge/photos.py web-status photoprism
"""

import json
import shutil
import subprocess
import sys
from datetime import datetime
from typing import Any


# ── Backend Registry ───────────────────────────────────────────────
# Each entry: (id, name, family, default_port, systemd_unit, cli_tool,
#              config_paths, web_path, license, homepage, install_hint)

BACKEND_REGISTRY = [
    (
        "photoprism", "PhotoPrism", "go-binary", 2342,
        "photoprism.service", "photoprism",
        ["/etc/photoprism/options.yml", "/var/lib/photoprism/"],
        "/", "MIT",
        "https://github.com/photoprism/photoprism",
        "Arch: yay -S photoprism  ·  Debian: docker run photoprism/photoprism  ·  Fedora: docker run photoprism/photoprism",
    ),
    (
        "piwigo", "Piwigo", "php-app", 80,
        "php-fpm.service", "piwigo",
        ["/etc/piwigo/", "/usr/share/webapps/piwigo/"],
        "/piwigo/", "GPL-2.0",
        "https://github.com/Piwigo/Piwigo",
        "Arch: yay -S piwigo  ·  Debian: install under /var/www/piwigo + apache2 + php-fpm  ·  Fedora: same",
    ),
    (
        "lychee", "Lychee", "php-app", 80,
        "php-fpm.service", "lychee",
        ["/etc/lychee/", "/usr/share/webapps/lychee/"],
        "/lychee/", "MIT",
        "https://github.com/LycheeOrg/Lychee",
        "Arch: yay -S lychee  ·  Debian: install under /var/www/lychee + apache2 + php-fpm",
    ),
    (
        "nextcloud-memories", "Nextcloud Memories", "nextcloud-plugin", 80,
        "php-fpm.service", "occ",
        ["/etc/webapps/nextcloud/", "/usr/share/webapps/nextcloud/"],
        "/nextcloud/index.php/apps/memories/", "AGPL-3.0",
        "https://github.com/pulsejet/memories",
        "Arch: pacman -S nextcloud + occ app:enable memories  ·  Debian: apt install nextcloud-server",
    ),
    (
        "librephotos", "LibrePhotos", "django-react", 3000,
        "librephotos.service", "librephotos",
        ["/etc/librephotos/", "/var/lib/librephotos/"],
        "/", "MIT",
        "https://github.com/LibrePhotos/librephotos",
        "Arch: yay -S librephotos  ·  Debian: docker run librephotos/librephotos  ·  Fedora: docker run librephotos/librephotos",
    ),
]


def _have(binary: str) -> bool:
    return shutil.which(binary) is not None


def _unit_loaded(unit: str) -> bool:
    if not unit:
        return False
    out = subprocess.run(
        ["systemctl", "list-unit-files", unit],
        capture_output=True, text=True, timeout=5,
    ).stdout
    return unit in out


def _systemctl_show(unit: str, props: list[str]) -> dict[str, str]:
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
    if not unit:
        return {"status": "uninstalled", "active": "", "sub": "", "uptime_seconds": 0}
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


def detect_backend(entry) -> dict[str, Any]:
    (bid, name, family, port, unit, cli, configs, web_path,
     lic, homepage, install_hint) = entry

    cli_available = _have(cli) if cli else False
    unit_loaded = _unit_loaded(unit) if unit else False

    if unit_loaded:
        state = _service_status(unit)
        status = state["status"]
        active_state = state["active"]
        sub_state = state["sub"]
        uptime = state["uptime_seconds"]
    elif cli_available:
        status = "stopped"
        active_state = ""
        sub_state = ""
        uptime = 0
    elif any(_path_exists(p) for p in configs):
        # Config dir present but service not registered — best-effort.
        status = "stopped"
        active_state = ""
        sub_state = ""
        uptime = 0
    else:
        status = "uninstalled"
        active_state = ""
        sub_state = ""
        uptime = 0

    config_path = next((p for p in configs if _path_exists(p)), "")

    return {
        "id": bid,
        "name": name,
        "family": family,
        "status": status,
        "active": active_state,
        "sub": sub_state,
        "uptime_seconds": uptime,
        "port": port,
        "webPath": web_path,
        "url": f"http://127.0.0.1:{port}{web_path}",
        "serviceUnit": unit,
        "cli": cli,
        "configPath": config_path,
        "license": lic,
        "homepage": homepage,
        "installHint": install_hint,
        "supported": True,
    }


def _path_exists(p: str) -> bool:
    try:
        return bool(p) and __import__("os").path.exists(p)
    except (OSError, ValueError):
        return False


def cmd_summary() -> dict[str, Any]:
    backends = [detect_backend(e) for e in BACKEND_REGISTRY]
    installed = [b for b in backends if b["status"] != "uninstalled"]
    running = [b for b in backends if b["status"] == "running"]
    return {
        "backends": backends,
        "totalBackends": len(backends),
        "installedCount": len(installed),
        "runningCount": len(running),
    }


def _find_backend(bid: str):
    for e in BACKEND_REGISTRY:
        if e[0] == bid:
            return e
    return None


def cmd_status(bid: str) -> dict[str, Any]:
    e = _find_backend(bid)
    if not e:
        return {"error": f"Unknown backend: {bid}"}
    return detect_backend(e)


def _systemctl(action: str, unit: str) -> dict[str, Any]:
    if not unit:
        return {"rc": 127, "success": False, "stderr": f"no systemd unit for this backend"}
    try:
        r = subprocess.run(
            ["systemctl", action, unit],
            capture_output=True, text=True, timeout=30,
        )
        return {
            "action": action,
            "service": unit,
            "rc": r.returncode,
            "success": r.returncode == 0,
            "output": (r.stdout or "").strip(),
            "stderr": (r.stderr or "").strip(),
        }
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return {"action": action, "service": unit, "rc": 1,
                "success": False, "stderr": str(exc)}


def cmd_start(bid: str) -> dict[str, Any]:
    e = _find_backend(bid)
    if not e:
        return {"error": f"Unknown backend: {bid}"}
    return _systemctl("start", e[4])


def cmd_stop(bid: str) -> dict[str, Any]:
    e = _find_backend(bid)
    if not e:
        return {"error": f"Unknown backend: {bid}"}
    return _systemctl("stop", e[4])


def cmd_restart(bid: str) -> dict[str, Any]:
    e = _find_backend(bid)
    if not e:
        return {"error": f"Unknown backend: {bid}"}
    return _systemctl("restart", e[4])


def cmd_web_status(bid: str) -> dict[str, Any]:
    e = _find_backend(bid)
    if not e:
        return {"error": f"Unknown backend: {bid}"}
    (bid2, name, family, port, unit, cli, configs, web_path,
     lic, homepage, install_hint) = e
    state = _service_status(unit) if unit else {"status": "uninstalled"}
    return {
        "id": bid2,
        "name": name,
        "running": state["status"] == "running",
        "status": state["status"],
        "port": port,
        "webPath": web_path,
        "url": f"http://127.0.0.1:{port}{web_path}",
        "license": lic,
        "homepage": homepage,
        "installHint": install_hint,
    }


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0

    cmd = argv[0]
    if cmd == "summary":
        print(json.dumps(cmd_summary(), indent=2))
    elif cmd == "status":
        bid = argv[1] if len(argv) > 1 else ""
        print(json.dumps(cmd_status(bid), indent=2))
    elif cmd == "start":
        bid = argv[1] if len(argv) > 1 else ""
        print(json.dumps(cmd_start(bid), indent=2))
    elif cmd == "stop":
        bid = argv[1] if len(argv) > 1 else ""
        print(json.dumps(cmd_stop(bid), indent=2))
    elif cmd == "restart":
        bid = argv[1] if len(argv) > 1 else ""
        print(json.dumps(cmd_restart(bid), indent=2))
    elif cmd == "web-status":
        bid = argv[1] if len(argv) > 1 else ""
        print(json.dumps(cmd_web_status(bid), indent=2))
    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
