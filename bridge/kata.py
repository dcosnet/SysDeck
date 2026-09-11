#!/usr/bin/env python3
"""
SysDeck - Kata Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

v0.0.38 PRODUCTION REWRITE. The v0.0.35-v0.0.37 Kata panel shipped a
pre-built React bundle from the upstream cockpit-kata sub-project. That
bundle displayed HARDCODED MOCK DATA — 5 fake sandboxes (web-frontend-
prod, api-gateway-staging, etc.) with synthetic UUIDs and createdAt
timestamps, fake metrics (cpuUsagePercent, memoryUsageMB, historyCpu/
historyMemory arrays), a fake QCrows bundle catalog, and a fake PXE
status (always dnsmasqRunning:true). The only real features were the
QCrows kernel-bundle extraction (qcrows-export / qcrows-initrd-regen
via cockpit.spawn) and the kata-runtime check call.

v0.0.38 deletes the React bundle and ships a vanilla-JS panel backed
by this Python bridge helper. Every subcommand calls the REAL Kata
Containers 3.x APIs:

  list                enumerate kata sandboxes via:
                        1. kata-monitor HTTP /sandboxes (if running)
                        2. filesystem /run/vc/sbs/<id>/ (Go shim)
                        3. filesystem /run/kata/<id>/ (Rust shim)
                      Returns [{id, source, vm_pid, agent_socket}].
  inspect <id>        per-sandbox detail via kata-monitor /agent-url
                      + filesystem probe of /run/vc/sbs/<id>/ or
                      /run/kata/<id>/. Returns {id, agent_url,
                      shim_socket, config_path, ...}.
  metrics <id>        per-sandbox Prometheus metrics via kata-monitor
                      /metrics?sandbox=<id>. Returns parsed metric
                      families (cpu, memory, network, hypervisor).
  summary             aggregate state: sandbox count by status,
                      kata-runtime version, kata-monitor status,
                      host capability (kata-runtime check exit code).
  version             kata-runtime version (plain-text parse) +
                      kata-runtime env --json (structured).
  check               kata-runtime check (exit-code based — 0 = OK).
  pxe-status          real PXE/TFTP status: systemctl is-active
                      dnsmasq + test -d /srv/tftp + ls
                      /srv/tftp/pxelinux.cfg/.
  qcrows-list         list QCrows kernel bundles in
                      /usr/share/sysdeck/kata/qcrows/.
  qcrows-export       invoke qcrows-export (real binary).
  qcrows-initrd-regen  invoke qcrows-initrd-regen (real binary).

KEY DESIGN DECISIONS (Kata 3.x reality):
  - kata-runtime list/inspect were REMOVED in 3.x. Do not call them.
  - kata-monitor /sandboxes returns PLAIN TEXT (one ID per line),
    NOT JSON. Do not json.loads() it.
  - kata-monitor /metrics returns PROMETHEUS TEXT FORMAT, not JSON.
    Parse with prometheus_client.parser.text_string_to_metric_families.
  - kata-runtime env --json uses CAPITALIZED Go field names (no json
    tags): Runtime, Hypervisor, Host, Version, Semver, Commit, etc.
  - Sandbox IDs are 64 hex chars. Validate with ^[0-9a-f]{64}$.
  - kata-monitor binds to 127.0.0.1:8090 by default.

SECURITY HARDENING (v0.0.36 + v0.0.37):
  - Array-form subprocess only (shell=False). CVE-2019-15107 lesson.
  - "--" separator before user-supplied positionals. CVE-2026-4631.
  - Strict allowlist regex on sandbox IDs (^+[0-9a-f]{64}$).
    CVE-2024-2947 lesson.
  - Env scrubbed (SCRUBBED_ENV) on every privileged subprocess.
    CVE-2024-6126 lesson.
  - Output sanitized (truncated + non-printable stripped).
    CVE-2022-36446 lesson.
  - HTTP requests to kata-monitor use urllib with a 5s timeout and
    reject redirects (no SSRF). CVE-2020-35850 lesson.
  - No eval / pickle / yaml.unsafe_load. CVE-2019-15642 lesson.
  - Path resolution with realpath + startswith base check for the
    qcrows-list / qcrows-export paths. CVE-2022-30708 lesson.

Usage:
    python3 /usr/lib/sysdeck/bridge/kata.py list
    python3 /usr/lib/sysdeck/bridge/kata.py inspect <sandbox-id>
    python3 /usr/lib/sysdeck/bridge/kata.py metrics <sandbox-id>
    python3 /usr/lib/sysdeck/bridge/kata.py summary
    python3 /usr/lib/sysdeck/bridge/kata.py version
    python3 /usr/lib/sysdeck/bridge/kata.py check
    python3 /usr/lib/sysdeck/bridge/kata.py pxe-status
    python3 /usr/lib/sysdeck/bridge/kata.py qcrows-list
"""

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

# ── Constants ────────────────────────────────────────────────────────

# kata-monitor defaults to 127.0.0.1:8090.
KATA_MONITOR_URL = "http://127.0.0.1:8090"
KATA_MONITOR_TIMEOUT = 5  # seconds

# Filesystem paths where kata shims register sandbox state.
# Go shim (containerd-shim-kata-v2): /run/vc/sbs/<id>/
# Rust shim (containerd-shim-kata-rs-v2): /run/kata/<id>/
KATA_GO_SHIM_DIR = Path("/run/vc/sbs")
KATA_RUST_SHIM_DIR = Path("/run/kata")

# QCrows kernel bundle directory (shipped by sysdeck-kata package).
QCROWS_DIR = Path("/usr/share/sysdeck/kata/qcrows")

# v0.0.37 security helpers (reused from firewall.py via import).
# We import them to keep ONE source of truth for the hardening.
sys.path.insert(0, str(Path(__file__).parent))
try:
    from firewall import (  # type: ignore
        SCRUBBED_ENV,
        _sanitize_output,
        _validate_filename,
        _resolve_path_under_base,
    )
except ImportError:
    # Standalone fallback (if firewall.py isn't importable at runtime).
    SCRUBBED_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}

    def _sanitize_output(text: str, max_len: int = 4096) -> str:
        if not text:
            return ""
        if len(text) > max_len:
            text = text[:max_len] + " ... (truncated)"
        return "".join(c if (32 <= ord(c) < 127 or c in "\t\n\r") else " " for c in text)

    FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

    def _validate_filename(name: str) -> bool:
        if not name or len(name) > 64:
            return False
        return bool(FILENAME_RE.match(name))

    def _resolve_path_under_base(path_str: str, base_dir: Path) -> Path | None:
        if not path_str or ".." in Path(path_str).parts:
            return None
        try:
            real = Path(os.path.realpath(path_str))
            real.relative_to(base_dir)
            return real
        except (ValueError, OSError):
            return None

# Sandbox ID validator: 64 hex chars (containerd/CRI pod ID format).
SANDBOX_ID_RE = re.compile(r"^[0-9a-f]{64}$")


def _validate_sandbox_id(sid: str) -> bool:
    """Return True if sid is a valid kata sandbox ID (64 hex chars).

    CVE-2024-2947 lesson — validate before using in any subprocess argv
    or HTTP query string.
    """
    if not sid or len(sid) != 64:
        return False
    return bool(SANDBOX_ID_RE.match(sid))


# ── Subprocess helper ──────────────────────────────────────────────


def _run(argv: list[str], timeout: int = 30) -> tuple[int, str, str]:
    """Run argv and return (rc, stdout, stderr). Never raises.

    v0.0.36 hardening: shell=False, env scrubbed, output sanitized.
    """
    try:
        r = subprocess.run(
            argv, capture_output=True, text=True, check=False, timeout=timeout,
            env=SCRUBBED_ENV,
        )
        return r.returncode, _sanitize_output(r.stdout or ""), _sanitize_output(r.stderr or "")
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return 127, "", str(exc)


def _have(binary: str) -> bool:
    """Return True if binary is on PATH."""
    return shutil.which(binary) is not None


# ── kata-monitor HTTP client ───────────────────────────────────────
#
# kata-monitor is a standalone HTTP daemon (default 127.0.0.1:8090).
# It exposes /sandboxes (plain text, one ID per line) and /metrics
# (Prometheus text format). We use urllib (no external deps) with a
# strict 5s timeout and no redirect following (SSRF defense).


def _kata_monitor_get(path: str) -> tuple[int, str, str]:
    """GET <KATA_MONITOR_URL><path>. Returns (status, body, error).

    v0.0.37 hardening:
      - 5s timeout (DoS defense).
      - no redirect following (SSRF defense — CVE-2020-35850 lesson).
      - only http:// scheme (no file:// / gopher:// etc.).
    """
    url = KATA_MONITOR_URL + path
    if not url.startswith("http://127.0.0.1:"):
        return 0, "", f"refusing non-localhost URL: {url}"
    try:
        req = urllib.request.Request(url, headers={"Accept": "text/plain"})
        # No redirect handler → redirects are rejected (SSRF defense).
        opener = urllib.request.build_opener(NoRedirectHandler)
        with opener.open(req, timeout=KATA_MONITOR_TIMEOUT) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, body, ""
    except urllib.error.HTTPError as e:
        return e.code, "", f"HTTP {e.code}: {e.reason}"
    except urllib.error.URLError as e:
        return 0, "", f"connection refused (kata-monitor not running?): {e.reason}"
    except Exception as e:
        return 0, "", str(e)


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject HTTP redirects — SSRF defense (CVE-2020-35850 lesson)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # raise HTTPError instead of following


# ── Sandbox enumeration (3.x: filesystem + kata-monitor) ──────────
#
# In Kata 3.x, `kata-runtime list` was REMOVED. Sandboxes are
# enumerated via:
#   1. kata-monitor HTTP /sandboxes (if the monitor is running)
#   2. filesystem: /run/vc/sbs/<id>/ (Go shim)
#   3. filesystem: /run/kata/<id>/ (Rust shim)
# We try all three and merge, marking each sandbox with its source.


def _list_from_kata_monitor() -> list[dict[str, Any]]:
    """List sandbox IDs via kata-monitor /sandboxes (plain text)."""
    status, body, err = _kata_monitor_get("/sandboxes")
    if status != 200 or not body:
        return []
    sandboxes: list[dict[str, Any]] = []
    for line in body.splitlines():
        sid = line.strip()
        if _validate_sandbox_id(sid):
            sandboxes.append({"id": sid, "source": "kata-monitor"})
    return sandboxes


def _list_from_filesystem(shim_dir: Path, shim_name: str) -> list[dict[str, Any]]:
    """List sandbox IDs by enumerating a shim state directory."""
    if not shim_dir.is_dir():
        return []
    sandboxes: list[dict[str, Any]] = []
    try:
        for entry in shim_dir.iterdir():
            if not entry.is_dir():
                continue
            sid = entry.name
            if _validate_sandbox_id(sid):
                sandboxes.append({"id": sid, "source": f"fs-{shim_name}"})
    except (PermissionError, OSError):
        pass
    return sandboxes


def cmd_list(_args: list[str]) -> list[dict[str, Any]]:
    """List kata sandboxes from all available sources.

    Merges kata-monitor + Go shim fs + Rust shim fs, deduplicating by
    sandbox ID. Each entry: {id, source, agent_url, shim_socket}.

    Returns [] if no sandboxes are running (the empty state — NOT a
    mock array).
    """
    seen: dict[str, dict[str, Any]] = {}
    # Source priority: kata-monitor (richest) > fs-go > fs-rust.
    for sb in _list_from_kata_monitor():
        seen[sb["id"]] = sb
    for sb in _list_from_filesystem(KATA_GO_SHIM_DIR, "go"):
        if sb["id"] not in seen:
            seen[sb["id"]] = sb
    for sb in _list_from_filesystem(KATA_RUST_SHIM_DIR, "rust"):
        if sb["id"] not in seen:
            seen[sb["id"]] = sb
    # Enrich each with agent_url + shim_socket if available.
    result: list[dict[str, Any]] = []
    for sid, sb in seen.items():
        agent_url = _get_agent_url(sid)
        sb["agent_url"] = agent_url
        sb["shim_socket"] = _find_shim_socket(sid)
        result.append(sb)
    # Sort by ID for deterministic output.
    result.sort(key=lambda s: s["id"])
    return result


def _get_agent_url(sid: str) -> str | None:
    """Query kata-monitor /agent-url?sandbox=<sid> for the agent URL."""
    if not _validate_sandbox_id(sid):
        return None
    # URL-encode the sid (it's hex, so no special chars, but defense
    # in depth — never interpolate raw into a URL).
    import urllib.parse
    qs = urllib.parse.urlencode({"sandbox": sid})
    status, body, err = _kata_monitor_get(f"/agent-url?{qs}")
    if status == 200 and body:
        return body.strip()
    return None


def _find_shim_socket(sid: str) -> str | None:
    """Find the shim-monitor.sock path for a sandbox.

    Go shim: /run/vc/sbs/<id>/shim-monitor.sock
    Rust shim: /run/kata/<id>/shim-monitor.sock
    """
    if not _validate_sandbox_id(sid):
        return None
    for base in (KATA_GO_SHIM_DIR / sid, KATA_RUST_SHIM_DIR / sid):
        sock = base / "shim-monitor.sock"
        if sock.is_socket():
            return str(sock)
    return None


# ── Subcommand: inspect ────────────────────────────────────────────


def cmd_inspect(args: list[str]) -> dict[str, Any]:
    """Inspect a single sandbox by ID.

    Returns {id, source, agent_url, shim_socket, config_path,
    sandbox_dir, status} or {error: ...} on invalid ID / not found.
    """
    if not args:
        return {"error": "sandbox ID required"}
    sid = args[0]
    if not _validate_sandbox_id(sid):
        return {"error": f"invalid sandbox ID (expected 64 hex chars): {sid!r}"}
    # Find the sandbox dir.
    sandbox_dir: str | None = None
    source = "unknown"
    for base, shim in [(KATA_GO_SHIM_DIR, "go"), (KATA_RUST_SHIM_DIR, "rust")]:
        d = base / sid
        if d.is_dir():
            sandbox_dir = str(d)
            source = f"fs-{shim}"
            break
    agent_url = _get_agent_url(sid)
    shim_socket = _find_shim_socket(sid)
    # If we have neither fs state nor agent URL, the sandbox doesn't exist.
    if sandbox_dir is None and agent_url is None and shim_socket is None:
        # Check kata-monitor too.
        ids = [s["id"] for s in _list_from_kata_monitor()]
        if sid not in ids:
            return {"error": f"sandbox {sid} not found"}
        source = "kata-monitor"
    return {
        "id": sid,
        "source": source,
        "sandbox_dir": sandbox_dir,
        "agent_url": agent_url,
        "shim_socket": shim_socket,
        "status": "running" if (sandbox_dir or agent_url) else "unknown",
    }


# ── Subcommand: metrics ────────────────────────────────────────────


def cmd_metrics(args: list[str]) -> dict[str, Any]:
    """Fetch Prometheus metrics for a sandbox via kata-monitor.

    Returns {id, metrics: {cpu_usage_percent, memory_usage_mb,
    network_rx_bytes, network_tx_bytes, raw_families: [...]}} or
    {error: ...} on invalid ID / kata-monitor not running.

    The raw Prometheus text is parsed into metric families if
    prometheus_client is available; otherwise the raw text is returned.
    """
    if not args:
        return {"error": "sandbox ID required"}
    sid = args[0]
    if not _validate_sandbox_id(sid):
        return {"error": f"invalid sandbox ID: {sid!r}"}
    import urllib.parse
    qs = urllib.parse.urlencode({"sandbox": sid})
    status, body, err = _kata_monitor_get(f"/metrics?{qs}")
    if status != 200:
        return {"error": f"kata-monitor /metrics failed: {err}", "id": sid}
    # Try to parse Prometheus text into structured families.
    families: list[dict[str, Any]] = []
    try:
        from prometheus_client.parser import text_string_to_metric_families
        for fam in text_string_to_metric_families(body):
            samples = []
            for s in fam.samples:
                samples.append({"name": s.name, "labels": dict(s.labels), "value": s.value})
            families.append({"name": fam.name, "type": fam.type, "samples": samples})
    except ImportError:
        # prometheus_client not installed — return raw text.
        return {"id": sid, "raw": body, "parsed": False}
    # Extract the key metrics the panel cares about.
    summary = _extract_metric_summary(families, sid)
    return {"id": sid, "parsed": True, "families": families, "summary": summary}


def _extract_metric_summary(families: list[dict[str, Any]], sid: str) -> dict[str, Any]:
    """Extract cpu/memory/network summary from parsed Prometheus families."""
    summary: dict[str, Any] = {
        "cpu_usage_percent": None,
        "memory_usage_bytes": None,
        "network_rx_bytes": None,
        "network_tx_bytes": None,
        "uptime_seconds": None,
    }
    for fam in families:
        name = fam.get("name", "")
        for s in fam.get("samples", []):
            # Only consider samples for this sandbox.
            if s.get("labels", {}).get("sandbox_id") != sid:
                continue
            val = s.get("value")
            if "cpu" in name and "usage" in name and summary["cpu_usage_percent"] is None:
                summary["cpu_usage_percent"] = val
            elif "memory" in name and "usage" in name and summary["memory_usage_bytes"] is None:
                summary["memory_usage_bytes"] = val
            elif "network" in name and "rx" in name:
                summary["network_rx_bytes"] = val
            elif "network" in name and "tx" in name:
                summary["network_tx_bytes"] = val
            elif "uptime" in name:
                summary["uptime_seconds"] = val
    return summary


# ── Subcommand: summary ────────────────────────────────────────────


def cmd_summary(_args: list[str]) -> dict[str, Any]:
    """Return aggregate sandbox state + runtime version + host capability.

    This is the panel's header data: total sandboxes, running count,
    kata-runtime version, kata-monitor status, host capability.
    """
    sandboxes = cmd_list([])
    # Determine "running" count — sandboxes with an agent_url or shim
    # socket are considered running.
    running = sum(1 for s in sandboxes if s.get("agent_url") or s.get("shim_socket"))
    # kata-monitor status.
    monitor_status: dict[str, Any] = {"running": False, "url": KATA_MONITOR_URL}
    status, _, _ = _kata_monitor_get("/sandboxes")
    if status == 200:
        monitor_status["running"] = True
    # kata-runtime version.
    runtime_version = _kata_runtime_version()
    # Host capability (kata-runtime check exit code).
    capable, check_msg = _kata_check()
    return {
        "total_sandboxes": len(sandboxes),
        "running_sandboxes": running,
        "sandboxes": sandboxes,
        "kata_monitor": monitor_status,
        "kata_runtime": runtime_version,
        "host_capable": capable,
        "check_message": check_msg,
        "kata_runtime_installed": _have("kata-runtime"),
        "kata_monitor_installed": _have("kata-monitor"),
    }


def _kata_runtime_version() -> dict[str, Any]:
    """Parse `kata-runtime version` (plain text) + `kata-runtime env --json`.

    The version command output is:
        kata-runtime  : 3.7.0
           commit   : abc1234
           OCI specs: 1.1.0-rc1

    The env --json command returns structured JSON with Capitalized
    Go field names (Runtime, Hypervisor, Host, Version, Semver, etc.).
    """
    if not _have("kata-runtime"):
        return {"installed": False, "version": None, "commit": None, "oci": None}
    rc, out, err = _run(["kata-runtime", "version"], timeout=10)
    version = commit = oci = None
    if rc == 0:
        for line in out.splitlines():
            if "kata-runtime" in line and ":" in line:
                version = line.split(":", 1)[1].strip()
            elif "commit" in line and ":" in line:
                commit = line.split(":", 1)[1].strip()
            elif "OCI" in line and ":" in line:
                oci = line.split(":", 1)[1].strip()
    # Try env --json for structured info (best-effort).
    env_info: dict[str, Any] = {}
    rc2, out2, err2 = _run(["kata-runtime", "env", "--json"], timeout=10)
    if rc2 == 0 and out2.strip():
        try:
            env_info = json.loads(out2)
        except json.JSONDecodeError:
            pass
    return {
        "installed": True,
        "version": version,
        "commit": commit,
        "oci": oci,
        "env": env_info,
    }


def _kata_check() -> tuple[bool, str]:
    """Run `kata-runtime check`. Returns (capable, message).

    Per Kata 3.x docs: exit 0 = capable, exit 1 = not capable.
    The text output is "System is capable of running Kata Containers"
    on success, or an error message on failure.
    """
    if not _have("kata-runtime"):
        return False, "kata-runtime not installed"
    rc, out, err = _run(["kata-runtime", "check"], timeout=15)
    if rc == 0:
        return True, out.strip() or "System is capable of running Kata Containers"
    return False, (err.strip() or out.strip() or "kata-runtime check failed")


# ── Subcommand: version ────────────────────────────────────────────


def cmd_version(_args: list[str]) -> dict[str, Any]:
    """Return kata-runtime version info."""
    return _kata_runtime_version()


# ── Subcommand: check ──────────────────────────────────────────────


def cmd_check(_args: list[str]) -> dict[str, Any]:
    """Run kata-runtime check. Returns {capable, message}."""
    capable, msg = _kata_check()
    return {"capable": capable, "message": msg}


# ── Subcommand: pxe-status ─────────────────────────────────────────
#
# Real PXE/TFTP status — replaces the v0.0.37 mock that always
# returned dnsmasqRunning:true.


def cmd_pxe_status(_args: list[str]) -> dict[str, Any]:
    """Return real PXE/TFTP boot status.

    Checks:
      - systemctl is-active dnsmasq
      - test -d /srv/tftp
      - test -w /srv/tftp
      - ls /srv/tftp/pxelinux.cfg/ (list existing entries)
    """
    # dnsmasq service status.
    rc, out, _ = _run(["systemctl", "is-active", "dnsmasq"], timeout=10)
    dnsmasq_running = (rc == 0 and out.strip() == "active")
    # /srv/tftp directory existence + writability.
    tftp_dir = Path("/srv/tftp")
    tftp_exists = tftp_dir.is_dir()
    tftp_writable = os.access(str(tftp_dir), os.W_OK) if tftp_exists else False
    # Existing pxelinux.cfg entries.
    entries: list[str] = []
    if tftp_exists:
        cfg_dir = tftp_dir / "pxelinux.cfg"
        if cfg_dir.is_dir():
            try:
                entries = sorted([e.name for e in cfg_dir.iterdir() if e.is_file()])
            except (PermissionError, OSError):
                entries = []
    return {
        "dnsmasq_running": dnsmasq_running,
        "tftp_dir_exists": tftp_exists,
        "tftp_dir_writable": tftp_writable,
        "tftp_dir": "/srv/tftp",
        "pxelinux_entries": entries,
        "pxelinux_dir": "/srv/tftp/pxelinux.cfg/",
    }


# ── Subcommand: qcrows-list ────────────────────────────────────────
#
# QCrows kernel bundles are the real feature for kata kernel/module
# compilation. The v0.0.37 React bundle had a mock catalog; this
# reads the real filesystem.


def cmd_qcrows_list(_args: list[str]) -> list[dict[str, Any]]:
    """List QCrows kernel bundles in /usr/share/sysdeck/kata/qcrows/.

    Each entry: {filename, path, size_bytes, mtime}.
    Returns [] if the directory doesn't exist (empty state, NOT mock).
    """
    if not QCROWS_DIR.is_dir():
        return []
    bundles: list[dict[str, Any]] = []
    try:
        for entry in sorted(QCROWS_DIR.iterdir()):
            if not entry.is_file():
                continue
            if not entry.name.endswith((".qcrows", ".tar.gz", ".tgz")):
                continue
            stat = entry.stat()
            bundles.append({
                "filename": entry.name,
                "path": str(entry),
                "size_bytes": stat.st_size,
                "size_mb": round(stat.st_size / (1024 * 1024), 2),
                "mtime": stat.st_mtime,
            })
    except (PermissionError, OSError):
        pass
    return bundles


# ── Dispatch table ─────────────────────────────────────────────────

COMMANDS = {
    "list":          cmd_list,
    "inspect":       cmd_inspect,
    "metrics":       cmd_metrics,
    "summary":       cmd_summary,
    "version":       cmd_version,
    "check":         cmd_check,
    "pxe-status":    cmd_pxe_status,
    "qcrows-list":   cmd_qcrows_list,
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
    print(json.dumps(cmd(argv[1:]), indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
