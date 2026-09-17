#!/usr/bin/env python3
"""
SysDeck - Prometheus Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Manages Prometheus monitoring, alerting, and the centralized log pipeline.
All SysDeck module logs are pushed to the Prometheus pushgateway for
centralized observability, metric scraping, and alert-driven responses.

Prometheus is Apache-2.0 licensed by the Prometheus Authors. This bridge
helper communicates with Prometheus via its HTTP API — no Prometheus code
is bundled.

Subcommands:
    summary       - Overall Prometheus status and config
    targets       - Scrape target health (up/down/duration)
    alerts        - Current firing and pending alerts
    rules         - Alerting and recording rules from loaded rule files
    config        - Full Prometheus configuration
    push-log      - Push a SysDeck log entry to the pushgateway
    log-summary   - Summary of log pipeline throughput
    restart       - Restart the Prometheus service unit
    reload        - Send SIGHUP for config reload (no restart)
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any

PROM_LICENSE = "Apache-2.0"
PROM_AUTHORS = "Prometheus Authors"
PROM_URL = "https://prometheus.io"

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

# Prometheus API endpoint from environment or default. Port 9090
# belongs to cockpit-ws on every SysDeck host, so Prometheus defaults
# to 9095 — same 909x range, clear of Pushgateway (9091), Alertmanager
# (9093), and Cockpit (9090). Operators running Prometheus on a custom
# port override it via PROMETHEUS_API_URL.
PROM_API_URL = os.environ.get("PROMETHEUS_API_URL", "http://localhost:9095")
# Pushgateway URL for log pipeline
PUSHGATEWAY_URL = os.environ.get("PROMETHEUS_PUSHGATEWAY_URL", "http://localhost:9091")
# SysDeck log persistence directory
LOG_DIR = Path("/var/lib/sysdeck/prometheus-logs")


def _systemd_status(unit: str) -> dict[str, Any]:
    """Check systemd unit active state and substate.

    v0.0.39 hardening: env scrubbed (SCRUBBED_ENV), output sanitized.
    """
    try:
        result = subprocess.run(
            ["systemctl", "show", unit,
             "--property=ActiveState,SubState,ActiveEnterTimestamp"],
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
            "since": props.get("ActiveEnterTimestamp", ""),
        }
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError):
        # Systemd unavailable: select default unknown state
        return {"active": "unknown", "sub": "unknown", "since": ""}


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject HTTP redirects — SSRF defense (CVE-2020-35850 lesson).

    v0.0.39: prevents an attacker-controlled Prometheus/Pushgateway
    from redirecting the bridge to an internal service (e.g. 169.254.169.254
    metadata endpoint, or other localhost services).
    """
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # raise HTTPError instead of following


def _is_localhost_url(url: str) -> bool:
    """Return True if url points to localhost/127.0.0.1 (SSRF defense)."""
    return (url.startswith("http://localhost:") or
            url.startswith("http://127.0.0.1:") or
            url.startswith("http://[::1]:"))


def _prom_api_get(path: str, timeout: int = 5) -> dict[str, Any]:
    """GET from Prometheus HTTP API, returning parsed JSON.

    v0.0.39 hardening:
      - NoRedirectHandler (SSRF defense — CVE-2020-35850).
      - 127.0.0.1-only URL check (SSRF defense).
      - 5s timeout (DoS defense).
    """
    url = f"{PROM_API_URL.rstrip('/')}/api/v1{path}"
    if not _is_localhost_url(url):
        return {"error": "refused", "message": f"non-localhost URL rejected: {url}"}
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        opener = urllib.request.build_opener(_NoRedirectHandler)
        with opener.open(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
            if data.get("status") == "success":
                return data.get("data", {})
            return {"error": data.get("errorType", ""), "message": data.get("error", "")}
    except urllib.error.HTTPError as e:
        return {"error": f"http_{e.code}", "message": e.reason}
    except urllib.error.URLError:
        # Prometheus unreachable: report connection failure
        return {"error": "connection_refused", "message": f"Cannot reach Prometheus at {url}"}
    except (ValueError, KeyError, TypeError) as exc:
        # API response structure unexpected: select error path
        return {"error": "request_failed", "message": str(exc)}


def _pushgateway_post(job: str, data: str, timeout: int = 5) -> bool:
    """POST metrics to Prometheus pushgateway.

    v0.0.39 hardening: NoRedirectHandler + 127.0.0.1-only (SSRF defense).
    """
    # Validate the job name (it enters the URL path).
    if not _validate_filename(job):
        return False
    url = f"{PUSHGATEWAY_URL.rstrip('/')}/metrics/job/{job}"
    if not _is_localhost_url(url):
        return False
    try:
        req = urllib.request.Request(url, data=data.encode(), method="POST")
        req.add_header("Content-Type", "text/plain")
        opener = urllib.request.build_opener(_NoRedirectHandler)
        with opener.open(req, timeout=timeout) as resp:
            return resp.status in (200, 202)
    except (urllib.error.HTTPError, urllib.error.URLError, ValueError, OSError):
        # Pushgateway unreachable: report push failure
        return False


def summary() -> dict[str, Any]:
    """Overall Prometheus status, version, targets, alerts, config."""
    status_info = _systemd_status("prometheus.service")
    if status_info["active"] != "active":
        return {
            "installed": _is_installed(),
            "version": "",
            "uptime": "",
            "status": "stopped" if _is_installed() else "uninstalled",
            "targetsTotal": 0, "targetsUp": 0, "targetsDown": 0,
            "activeAlerts": 0, "pendingAlerts": 0, "seriesCount": 0,
            "config": _default_config(),
        }

    # Query Prometheus API for runtime info
    build_info = _prom_api_get("/status/buildinfo")
    version = build_info.get("version", "") if isinstance(build_info, dict) else ""

    # Target stats
    targets_data = _prom_api_get("/targets")
    if not isinstance(targets_data, dict) or "activeTargets" not in targets_data:
        targets_total, targets_up, targets_down = 0, 0, 0
    else:
        active = targets_data["activeTargets"]
        targets_total = len(active)
        targets_up = sum(1 for t in active if t.get("health") == "up")
        targets_down = sum(1 for t in active if t.get("health") == "down")

    # Alert stats
    alerts_data = _prom_api_get("/alerts")
    if not isinstance(alerts_data, dict) or "alerts" not in alerts_data:
        active_alerts, pending_alerts = 0, 0
    else:
        alert_items = alerts_data["alerts"]
        active_alerts = sum(1 for a in alert_items if a.get("state", "") == "firing")
        pending_alerts = sum(1 for a in alert_items if a.get("state", "") == "pending")

    # Series count (approximate via /status/tsdb)
    tsdb_data = _prom_api_get("/status/tsdb")
    series_count = 0
    if isinstance(tsdb_data, dict):
        raw = tsdb_data.get("seriesCountByMetricName", [{}])
        series_count = len(raw) if isinstance(raw, list) else 0

    config_data = _prom_api_get("/status/config")
    if isinstance(config_data, dict) and "yaml" in config_data:
        config = _parse_config(config_data)
    else:
        config = _default_config()

    return {
        "installed": True,
        "version": version,
        "uptime": status_info.get("since", ""),
        "status": "running",
        "targetsTotal": targets_total,
        "targetsUp": targets_up,
        "targetsDown": targets_down,
        "activeAlerts": active_alerts,
        "pendingAlerts": pending_alerts,
        "seriesCount": series_count,
        "config": config,
    }


def _is_installed() -> bool:
    """Check if Prometheus binary or package exists."""
    # Probe standard paths and package manager registries
    for cmd in [
        ["/usr/bin/which", "prometheus"],
        ["systemctl", "list-unit-files", "prometheus.service"],
    ]:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
            if r.returncode == 0:
                return True
        except (subprocess.TimeoutExpired, OSError):
            # Probe target unavailable: continue to next probe
            pass
    return False


def _default_config() -> dict[str, Any]:
    """Provide default Prometheus configuration values."""
    return {
        "globalScrapeInterval": "15s",
        "globalEvaluationInterval": "15s",
        "retentionTime": "15d",
        "retentionSize": "0",
        "storagePath": "/var/lib/prometheus",
        "configPath": "/etc/prometheus/prometheus.yml",
        "webListenAddress": "127.0.0.1:9095",
        "logLevel": "info",
        "walCompression": True,
    }


def _parse_config(config_data: dict) -> dict[str, Any]:
    """Extract key config values from Prometheus /status/config response."""
    yaml_str = config_data.get("yaml", "")
    cfg = _default_config()

    # Dispatch table: YAML key to config field mapping
    key_dispatch = {
        "scrape_interval": "globalScrapeInterval",
        "evaluation_interval": "globalEvaluationInterval",
    }
    for line in yaml_str.splitlines():
        stripped = line.strip()
        if ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        field = key_dispatch.get(key.strip())
        if field:
            cfg[field] = value.strip()
    return cfg


def targets() -> list[dict[str, Any]]:
    """List all scrape targets with health status."""
    data = _prom_api_get("/targets")
    if not isinstance(data, dict) or "activeTargets" not in data:
        return []
    return [{
        "instance": t.get("labels", {}).get("instance", ""),
        "job": t.get("labels", {}).get("job", ""),
        "lastScrape": t.get("lastScrape", ""),
        "lastScrapeDuration": t.get("lastScrapeDuration", 0) / 1e6,
        "health": t.get("health", "unknown"),
        "labels": t.get("labels", {}),
        "scrapeUrl": t.get("scrapeUrl", ""),
    } for t in data["activeTargets"]]


def alerts() -> list[dict[str, Any]]:
    """List current firing and pending alerts from Prometheus."""
    data = _prom_api_get("/alerts")
    if not isinstance(data, dict) or "alerts" not in data:
        return []
    return [{
        "labels": a.get("labels", {}),
        "state": a.get("state", "inactive"),
        "activeAt": a.get("activeAt", ""),
        "value": a.get("value", 0),
        "annotation": a.get("annotations", {}).get(
            "summary", a.get("annotations", {}).get("description", "")
        ),
    } for a in data["alerts"]]


def rules() -> list[dict[str, Any]]:
    """List alerting and recording rules from loaded rule groups."""
    data = _prom_api_get("/rules")
    if not isinstance(data, dict) or "groups" not in data:
        return []
    return [{
        "name": g.get("name", ""),
        "path": g.get("file", ""),
        "groups": [{"name": g.get("name", ""), "rules": [{
            "group": g.get("name", ""),
            "name": r.get("name", ""),
            "severity": r.get("labels", {}).get("severity", "info"),
            "expr": r.get("query", ""),
            "for": r.get("duration", "0s"),
            "summary": r.get("annotations", {}).get("summary", ""),
            "state": r.get("state", "inactive"),
            "value": r.get("value", None),
        } for r in g.get("rules", [])]}],
    } for g in data["groups"]]


def config() -> dict[str, Any]:
    """Full Prometheus YAML configuration."""
    data = _prom_api_get("/status/config")
    if isinstance(data, dict):
        return {"yaml": data.get("yaml", ""), "parsed": _parse_config(data)}
    return {"yaml": "", "parsed": _default_config()}


def push_log(args: list[str]) -> dict[str, Any]:
    """Push a SysDeck log entry to the Prometheus pushgateway.

    Expects args: [module, level, message, metadata_json]
    The log is formatted as Prometheus metrics and pushed to the pushgateway
    under the 'sysdeck_logs' job.

    Metrics pushed:
      sysdeck_log_total{module,level} 1
      sysdeck_log_timestamp_seconds{module,level} <epoch>
    """
    if len(args) < 3:
        return {"error": "Usage: push-log <module> <level> <message> [metadata_json]"}

    module = args[0]
    level = args[1]
    message = args[2]
    try:
        metadata = json.loads(args[3]) if len(args) > 3 else {}
    except json.JSONDecodeError:
        # Metadata JSON malformed: reject push request
        return {"error": "metadata_json must be valid JSON"}

    # Filesystem contract: the module name becomes a filename under
    # LOG_DIR. Validate it like every other filename this suite writes —
    # no absolute paths, no traversal, no symlink tricks downstream.
    if not _validate_filename(module):
        return {"error": "invalid module name (max 64 chars of [A-Za-z0-9._-])"}

    ts = time.time()
    iso_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))

    # Build Prometheus exposition format. Label values are escaped
    # (backslash, quote, newline) per the exposition spec — raw values
    # must never inject metric lines into the pushgateway payload.
    def _esc(value: str) -> str:
        return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")

    mod_l, lvl_l, msg_l = _esc(module), _esc(level), _esc(message[:128])
    metrics = (
        '# TYPE sysdeck_log_total counter\n'
        f'sysdeck_log_total{{module="{mod_l}",level="{lvl_l}"}} 1\n'
        '# TYPE sysdeck_log_timestamp_seconds gauge\n'
        f'sysdeck_log_timestamp_seconds{{module="{mod_l}",level="{lvl_l}"}} {ts:.3f}\n'
        '# TYPE sysdeck_log_message_info gauge\n'
        f'sysdeck_log_message_info{{module="{mod_l}",level="{lvl_l}",msg="{msg_l}"}} 1\n'
    )

    pushed = _pushgateway_post("sysdeck_logs", metrics)

    # Persist to local audit log. Path stays inside LOG_DIR by
    # construction (validated module name, fixed directory).
    log_entry = {
        "module": module,
        "level": level,
        "message": message,
        "timestamp": iso_ts,
        "metadata": metadata,
        "pushedToPrometheus": pushed,
    }
    log_file = LOG_DIR / f"{module}.jsonl"
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry) + "\n")
    except OSError as exc:
        return {"pushed": pushed, "timestamp": iso_ts, "entry": log_entry,
                "persisted": False, "persistError": str(exc)}

    return {"pushed": pushed, "timestamp": iso_ts, "entry": log_entry, "persisted": True}


def log_summary() -> dict[str, Any]:
    """Summarize the SysDeck log pipeline: counts by module/level, push stats."""
    if not LOG_DIR.exists():
        return {
            "totalLogs": 0, "pushedToPrometheus": 0, "failedPushes": 0,
            "lastPushAt": "", "byModule": {}, "byLevel": {},
        }

    total = 0
    pushed = 0
    failed = 0
    last_push = ""
    by_module: dict[str, int] = {}
    by_level: dict[str, int] = {}

    for log_file in LOG_DIR.glob("*.jsonl"):
        with open(log_file) as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    total += 1
                    mod = entry.get("module", "unknown")
                    lvl = entry.get("level", "unknown")
                    by_module[mod] = by_module.get(mod, 0) + 1
                    by_level[lvl] = by_level.get(lvl, 0) + 1
                    if entry.get("pushedToPrometheus"):
                        pushed += 1
                        ts = entry.get("timestamp", "")
                        if ts > last_push:
                            last_push = ts
                    else:
                        failed += 1
                except json.JSONDecodeError:
                    # Malformed log entry: skip and continue
                    continue

    return {
        "totalLogs": total,
        "pushedToPrometheus": pushed,
        "failedPushes": failed,
        "lastPushAt": last_push,
        "byModule": by_module,
        "byLevel": by_level,
    }


def restart() -> dict[str, Any]:
    """Restart the Prometheus systemd service.

    v0.0.39 hardening: no sudo (cockpit superuser channel handles auth via
    polkit org.sysdeck.monitoring.modify). env scrubbed. check=False with
    structured error return. CVE-2022-0824 lesson — the bridge does not
    trust the UI; polkit gates the privileged verb.
    """
    try:
        r = subprocess.run(
            ["systemctl", "restart", "prometheus.service"],
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
    """Send SIGHUP to Prometheus for live config reload.

    v0.0.39 hardening: no sudo, env scrubbed, check=False.
    """
    try:
        r = subprocess.run(
            ["systemctl", "kill", "--signal=SIGHUP", "prometheus.service"],
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
    "targets": lambda _args: targets(),
    "alerts": lambda _args: alerts(),
    "rules": lambda _args: rules(),
    "config": lambda _args: config(),
    "push-log": lambda args: push_log(args),
    "log-summary": lambda _args: log_summary(),
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
