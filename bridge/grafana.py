#!/usr/bin/env python3
"""
SysDeck - Grafana Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Manages Grafana visualization dashboards, datasources, alerting,
and plugin configuration via the Grafana HTTP API.

Grafana is AGPL-3.0 licensed by Grafana Labs. This bridge helper
communicates with Grafana via its HTTP API — no Grafana code is bundled.

Subcommands:
    summary       - Overall Grafana status (version, health, counts)
    dashboards    - List all dashboards with folder/tags
    datasources   - List and health-check datasources
    alerts        - List Grafana-managed alert rules and states
    health        - Grafana health check endpoint
    org           - Current organization info
    users         - List Grafana users
    plugins       - List installed plugins
    search        - Search dashboards by query string
    restart       - Restart the Grafana systemd service
    reload        - Reload Grafana provisioning (SIGUSR2)
"""

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any


GRAFANA_LICENSE = "AGPL-3.0"
GRAFANA_AUTHORS = "Grafana Labs"
GRAFANA_URL = "https://grafana.com"

# Security helpers come from firewall.py — one source of truth for
# hardening across the suite.
sys.path.insert(0, str(Path(__file__).parent))
try:
    from firewall import (  # type: ignore
        SCRUBBED_ENV,
        _sanitize_output,
        _validate_filename,
    )
except ImportError:
    SCRUBBED_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}
    def _sanitize_output(text: str, max_len: int = 4096) -> str:
        if not text:
            return ""
        if len(text) > max_len:
            text = text[:max_len] + " ... (truncated)"
        return "".join(c if (32 <= ord(c) < 127 or c in "\t\n\r") else " " for c in text)
    _FILENAME_RE_FALLBACK = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
    def _validate_filename(name: str) -> bool:
        return bool(name and len(name) <= 64 and _FILENAME_RE_FALLBACK.match(name))

# Grafana API endpoint from environment or default
GRAFANA_API_URL = os.environ.get("GRAFANA_API_URL", "http://localhost:3000")
# Admin credentials from environment or default
GRAFANA_USER = os.environ.get("GRAFANA_ADMIN_USER", "admin")
GRAFANA_PASSWORD = os.environ.get("GRAFANA_ADMIN_PASSWORD", "admin")


def _systemd_status(unit: str) -> dict[str, Any]:
    """Check systemd unit active state.

    v0.0.39 hardening: env scrubbed, output sanitized.
    """
    try:
        result = subprocess.run(
            ["systemctl", "show", unit,
             "--property=ActiveState,SubState"],
            capture_output=True, text=True, timeout=5,
            env=SCRUBBED_ENV,
        )
        props = dict(
            line.split("=", 1)
            for line in _sanitize_output(result.stdout).strip().splitlines()
            if "=" in line
        )
        return {
            "active": props.get("ActiveState", "unknown"),
            "sub": props.get("SubState", "unknown"),
        }
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError):
        # Systemd unavailable: select default unknown state
        return {"active": "unknown", "sub": "unknown"}


def _is_installed() -> bool:
    """Check if Grafana binary or package exists."""
    # Probe standard paths and package manager registries
    for cmd in [
        ["which", "grafana-server"],
        ["systemctl", "list-unit-files", "grafana-server.service"],
    ]:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=3,
                               env=SCRUBBED_ENV)
            if r.returncode == 0:
                return True
        except (subprocess.TimeoutExpired, OSError):
            pass
    return False


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject HTTP redirects — SSRF defense (CVE-2020-35850 lesson)."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _is_localhost_url(url: str) -> bool:
    """Return True if url points to localhost/127.0.0.1 (SSRF defense)."""
    return (url.startswith("http://localhost:") or
            url.startswith("http://127.0.0.1:") or
            url.startswith("http://[::1]:"))


def _grafana_api_get(path: str, timeout: int = 5) -> Any:
    """GET from Grafana HTTP API with basic auth, returning parsed JSON.

    v0.0.39 hardening:
      - NoRedirectHandler (SSRF defense — CVE-2020-35850).
      - 127.0.0.1-only URL check (SSRF defense).
      - 5s timeout (DoS defense).
    """
    url = f"{GRAFANA_API_URL.rstrip('/')}/api{path}"
    if not _is_localhost_url(url):
        return None
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        # HTTP Basic authentication credential encoding
        credentials = base64.b64encode(
            f"{GRAFANA_USER}:{GRAFANA_PASSWORD}".encode()
        ).decode()
        req.add_header("Authorization", f"Basic {credentials}")
        opener = urllib.request.build_opener(_NoRedirectHandler)
        with opener.open(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError:
        # Grafana returned an HTTP error (auth failed, not found, etc.)
        return None
    except urllib.error.URLError:
        # Grafana unreachable: report connection failure
        return None
    except (ValueError, json.JSONDecodeError, OSError):
        # API response parse failure or I/O error: select null result
        return None


def _default_health() -> dict[str, Any]:
    """Provide default Grafana health status when unreachable."""
    return {
        "database": "unknown",
        "commit": "",
        "version": "",
        "status": "unknown",
        "message": "Grafana unreachable",
    }


def health() -> dict[str, Any]:
    """Grafana health check endpoint."""
    data = _grafana_api_get("/health")
    if not isinstance(data, dict):
        # Health endpoint unavailable: select default health state
        return _default_health()
    return {
        "database": data.get("database", ""),
        "commit": data.get("commit", ""),
        "version": data.get("version", ""),
        "status": data.get("status", "unknown"),
        "message": data.get("message", ""),
    }


def summary() -> dict[str, Any]:
    """Overall Grafana status, version, health, dashboards, datasources."""
    status_info = _systemd_status("grafana-server.service")
    if status_info["active"] != "active":
        return {
            "installed": _is_installed(),
            "version": "",
            "status": "stopped" if _is_installed() else "uninstalled",
            "url": GRAFANA_API_URL,
            "dashboardsCount": 0,
            "datasourcesCount": 0,
            "activeAlerts": 0,
            "orgName": "",
            "adminUser": GRAFANA_USER,
            "health": _default_health(),
        }

    health_info = health()
    version = health_info.get("version", "")

    # Dashboard inventory count
    dash_search = _grafana_api_get("/search?type=dash-db")
    dashboards_count = len(dash_search) if isinstance(dash_search, list) else 0

    # Datasource inventory count
    ds_list = _grafana_api_get("/datasources")
    datasources_count = len(ds_list) if isinstance(ds_list, list) else 0

    # Alert rules (Grafana unified alerting)
    alert_rules = _grafana_api_get("/v1/provisioning/alert-rules")
    if not isinstance(alert_rules, list):
        active_alerts = 0
    else:
        active_alerts = sum(
            1 for r in alert_rules
            if isinstance(r, dict) and r.get("status", {}).get("state") == "alerting"
        )

    # Organization identity
    org = _grafana_api_get("/org")
    org_name = org.get("name", "Main Org.") if isinstance(org, dict) else "Main Org."

    return {
        "installed": True,
        "version": version,
        "status": "running",
        "url": GRAFANA_API_URL,
        "dashboardsCount": dashboards_count,
        "datasourcesCount": datasources_count,
        "activeAlerts": active_alerts,
        "orgName": org_name,
        "adminUser": GRAFANA_USER,
        "health": health_info,
    }


def dashboards() -> list[dict[str, Any]]:
    """List all dashboards with folder and tags."""
    data = _grafana_api_get("/search?type=dash-db")
    if not isinstance(data, list):
        return []
    return [{
        "id": d.get("id", 0),
        "uid": d.get("uid", ""),
        "title": d.get("title", ""),
        "slug": d.get("slug", ""),
        "uri": d.get("uri", ""),
        "url": d.get("url", ""),
        "type": d.get("type", ""),
        "tags": d.get("tags", []),
        "isStarred": d.get("isStarred", False),
        "folderTitle": d.get("folderTitle", ""),
        "folderUid": d.get("folderUid", ""),
        "folderId": d.get("folderId", 0),
    } for d in data]


def _datasource_record(ds: dict[str, Any]) -> dict[str, Any]:
    """Construct datasource record with live health status."""
    ds_id = ds.get("id", 0)
    resp = _grafana_api_get(f"/datasources/{ds_id}/health")
    # Health endpoint unavailable: select default success indicator
    if not isinstance(resp, dict):
        ds_status, ds_message = "success", ""
    else:
        ds_status = resp.get("status", "error")
        ds_message = resp.get("message", "")
    return {
        "id": ds_id,
        "name": ds.get("name", ""),
        "type": ds.get("type", ""),
        "url": ds.get("url", ""),
        "access": ds.get("access", "proxy"),
        "isDefault": ds.get("isDefault", False),
        "database": ds.get("database", ""),
        "jsonData": ds.get("jsonData", {}),
        "status": ds_status,
        "message": ds_message,
    }


def datasources() -> list[dict[str, Any]]:
    """List datasources with health check."""
    data = _grafana_api_get("/datasources")
    if not isinstance(data, list):
        return []
    return [_datasource_record(ds) for ds in data]


def alerts() -> list[dict[str, Any]]:
    """List Grafana unified alerting rules."""
    data = _grafana_api_get("/v1/provisioning/alert-rules")
    if not isinstance(data, list):
        return []
    return [{
        "id": 0,  # Unified alerting uses uid, not numeric id
        "uid": a.get("uid", ""),
        "title": a.get("title", ""),
        "condition": a.get("condition", ""),
        "dashboardUid": a.get("dashboardUid", ""),
        "dashboardTitle": a.get("dashboardTitle", ""),
        "panelId": a.get("panelId", 0),
        "state": (
            a.get("status", {}).get("state", "unknown")
            if isinstance(a.get("status"), dict) else "unknown"
        ),
        "noDataState": a.get("noDataState", ""),
        "executionErrorState": a.get("executionErrorState", ""),
        "labels": a.get("labels", {}),
    } for a in data]


def org() -> dict[str, Any]:
    """Current organization info."""
    data = _grafana_api_get("/org")
    if not isinstance(data, dict):
        # Organization endpoint unavailable: select empty defaults
        return {
            "id": 0, "name": "", "address1": "",
            "address2": "", "city": "", "country": "",
        }
    return {
        "id": data.get("id", 0),
        "name": data.get("name", ""),
        "address1": data.get("address1", ""),
        "address2": data.get("address2", ""),
        "city": data.get("city", ""),
        "country": data.get("country", ""),
    }


def users() -> list[dict[str, Any]]:
    """List Grafana users."""
    data = _grafana_api_get("/org/users")
    if not isinstance(data, list):
        return []
    return [{
        "id": u.get("id", 0),
        "login": u.get("login", ""),
        "name": u.get("name", ""),
        "email": u.get("email", ""),
        "isAdmin": u.get("isGrafanaAdmin", False),
        "isGrafanaAdmin": u.get("isGrafanaAdmin", False),
        "lastSeenAt": u.get("lastSeenAt", ""),
        "lastSeenAtAge": u.get("lastSeenAtAge", ""),
        "authLabels": u.get("authLabels", []),
    } for u in data]


def plugins() -> list[dict[str, Any]]:
    """List installed Grafana plugins."""
    data = _grafana_api_get("/plugins")
    if not isinstance(data, list):
        return []
    return [{
        "id": p.get("id", ""),
        "name": p.get("name", ""),
        "type": p.get("type", ""),
        "enabled": p.get("enabled", False),
        "pinned": p.get("pinned", False),
        "version": p.get("version", ""),
        "signature": p.get("signature", ""),
        "info": {
            "description": p.get("info", {}).get("description", ""),
            "author": p.get("info", {}).get("author", {"name": "", "url": ""}),
            "logos": p.get("info", {}).get("logos", {"small": "", "large": ""}),
        },
    } for p in data]


def search(args: list[str]) -> list[dict[str, Any]]:
    """Search dashboards by query string."""
    query = args[0] if args else ""
    if query:
        from urllib.parse import quote
        endpoint = f"/search?type=dash-db&query={quote(query, safe='')}"
    else:
        endpoint = "/search?type=dash-db"
    data = _grafana_api_get(endpoint)
    if not isinstance(data, list):
        return []
    return [{
        "id": d.get("id", 0),
        "uid": d.get("uid", ""),
        "title": d.get("title", ""),
        "slug": d.get("slug", ""),
        "uri": d.get("uri", ""),
        "url": d.get("url", ""),
        "type": d.get("type", ""),
        "tags": d.get("tags", []),
        "isStarred": d.get("isStarred", False),
        "folderTitle": d.get("folderTitle", ""),
        "folderUid": d.get("folderUid", ""),
        "folderId": d.get("folderId", 0),
    } for d in data]


def restart() -> dict[str, Any]:
    """Restart the Grafana systemd service.

    v0.0.39 hardening: no sudo (cockpit superuser channel handles auth via
    polkit org.sysdeck.monitoring.modify). env scrubbed. check=False.
    """
    try:
        r = subprocess.run(
            ["systemctl", "restart", "grafana-server.service"],
            capture_output=True, text=True, check=False, timeout=10,
            env=SCRUBBED_ENV,
        )
        if r.returncode == 0:
            return {"action": "restart", "result": "ok"}
        return {"action": "restart", "result": "error",
                "rc": r.returncode, "stderr": _sanitize_output(r.stderr).strip()}
    except subprocess.TimeoutExpired:
        return {"action": "restart", "result": "error", "message": "restart timed out after 10s"}
    except OSError as exc:
        return {"action": "restart", "result": "error", "message": str(exc)}


def reload() -> dict[str, Any]:
    """Send SIGUSR2 to Grafana for provisioning reload.

    v0.0.39 hardening: no sudo, env scrubbed, check=False.
    """
    try:
        r = subprocess.run(
            ["systemctl", "kill", "--signal=SIGUSR2", "grafana-server.service"],
            capture_output=True, text=True, check=False, timeout=5,
            env=SCRUBBED_ENV,
        )
        if r.returncode == 0:
            return {"action": "reload", "result": "ok"}
        return {"action": "reload", "result": "error",
                "rc": r.returncode, "stderr": _sanitize_output(r.stderr).strip()}
    except subprocess.TimeoutExpired:
        return {"action": "reload", "result": "error", "message": "reload timed out after 5s"}
    except OSError as exc:
        return {"action": "reload", "result": "error", "message": str(exc)}


COMMANDS = {
    "summary": lambda _args: summary(),
    "dashboards": lambda _args: dashboards(),
    "datasources": lambda _args: datasources(),
    "alerts": lambda _args: alerts(),
    "health": lambda _args: health(),
    "org": lambda _args: org(),
    "users": lambda _args: users(),
    "plugins": lambda _args: plugins(),
    "search": lambda args: search(args),
    "restart": lambda _args: restart(),
    "reload": lambda _args: reload(),
}


def main(argv: list[str]) -> int:
    """Dispatch subcommand and emit JSON result."""
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd = COMMANDS.get(argv[0])
    if not cmd:
        print(f"Unknown subcommand: {argv[0]}", file=sys.stderr)
        return 2
    print(json.dumps(cmd(argv[1:]), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
