#!/usr/bin/env python3
"""
SysDeck - Kata Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

ZERO-DEMO CONTRACT. Every subcommand calls the real Kata Containers
3.x APIs and reads the real host state — sandbox lists, metrics, bundle
catalogs, and PXE status are live data or honest unavailability, never
fabricated records:

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
  qcrows-list         list QCrows images in /usr/share/sysdeck/kata/qcrows/.
                      Format-aware per the cockpit-kata master spec
                      (qcrows-spec.md v0.2.0): each .qcrows/.qcrows.gz/
                      .tar.gz entry is opened IN MEMORY and its
                      metadata.toml + menu.toml are parsed, surfacing
                      {image, kernel, rootfs, hypervisors, menu} per
                      bundle.  Legacy non-QCrows tarballs degrade
                      gracefully to stat-only entries (qcrows: false).
  qcrows-inspect <f>  detailed single-image view: full metadata, menu,
                      member listing (name/size/mode), hash-file presence.
  qcrows-verify <f>   in-memory verification mirroring cockpit-kata's
                      qcrows-verify: required files, kernel binary
                      magic (bzImage "HdrS" @0x202 / ELF magic), kernel
                      config + required Kata options (warn), initrd
                      (warn), metadata format_version + hypervisors,
                      and a full sha256sum -c style hash walk.
                      Returns {ok, passed, failed, warnings, checks[]}.
                      (qcrows-export and qcrows-initrd-regen remain
                      operator binaries the bridge does not wrap.)

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
    python3 /usr/lib/sysdeck/bridge/kata.py qcrows-inspect <filename>
    python3 /usr/lib/sysdeck/bridge/kata.py qcrows-verify <filename>
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
# Real PXE/TFTP status straight from systemctl and /srv/tftp.


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


# ── QCrows format support (cockpit-kata master spec v0.2.0) ────────
#
# QCrows (cue-crows) is the in-house self-describing VM container image
# format for Kata Containers, master-implemented in cockpit-kata
# (qcrows-spec.md + qcrows-pack / qcrows-verify / qcrows-inspect).
# SysDeck is a *consumer*: it reads the real archives from
# /usr/share/sysdeck/kata/qcrows/ in memory (no extraction to disk —
# nothing executable is ever materialized from an image here) and
# mirrors the master tools' verification semantics.

QCROWS_FORMAT_VERSION = "0.2.0"
QCROWS_MAX_MEMBERS = 10_000          # tar-bomb guard (header count)
QCROWS_MAX_TEXT_MEMBER_BYTES = 1 << 20  # 1 MiB cap on parsed text members

# Required Kata kernel options (qcrows-verify warns when absent).
QCROWS_REQUIRED_KATA_OPTS = (
    "CONFIG_VSOCKETS", "CONFIG_VIRTIO", "CONFIG_VIRTIO_PCI",
    "CONFIG_DEVTMPFS", "CONFIG_DEVTMPFS_MOUNT",
)

_QCROWS_REQUIRED_FILES = ("metadata.toml", "menu.toml", "hashes.sha256")


def _qcrows_member_names(tf: Any) -> dict[str, Any]:
    """Map normalized member name → TarInfo for a QCrows archive.

    Members are stored "./"-prefixed by qcrows-pack; normalize both
    spellings.  Raises ValueError on tar-bomb-sized header counts.
    """
    members = tf.getmembers()
    if len(members) > QCROWS_MAX_MEMBERS:
        raise ValueError(f"too many tar members ({len(members)})")
    out: dict[str, Any] = {}
    for m in members:
        if not m.isfile():
            continue
        name = m.name
        if name.startswith("./"):
            name = name[2:]
        out[name] = m
    return out


def _qcrows_read_member(tf: Any, info: Any) -> bytes:
    """Read one member's bytes with the text-member size cap."""
    if info.size > QCROWS_MAX_TEXT_MEMBER_BYTES:
        raise ValueError(f"member {info.name!r} exceeds size cap")
    fh = tf.extractfile(info)
    if fh is None:
        return b""
    return fh.read()


def _qcrows_parse_toml(text: str) -> dict[str, Any]:
    """Parse the flat QCrows TOML shape into a nested dict.

    Supports exactly what qcrows-pack emits: ``[ section ]`` headers
    (dotted sections become nested dicts), ``key = "str"``,
    ``key = true/false``, ``key = 123``, ``key = [ "a", "b" ]``.
    Unknown lines and # comments are skipped.  Section-aware by
    design — cockpit-kata's qcrows-inspect greps first-matches, which
    mis-attributes kernel fields to initrd/rootfs rows; this parser
    does not.
    """
    root: dict[str, Any] = {}
    current: dict[str, Any] = root
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip().strip('"')
            current = root
            for part in section.split("."):
                part = part.strip().strip('"')
                current = current.setdefault(part, {})
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().strip('"')
        value = value.strip()
        # Strip trailing comments outside quotes (qcrows-pack emits
        # none, but hand-edited metadata may carry them).
        if value.startswith('"'):
            end = value.find('"', 1)
            current[key] = value[1:end] if end > 0 else value[1:]
        elif value.startswith("["):
            try:
                current[key] = json.loads(value.replace("'", '"'))
            except ValueError:
                current[key] = [
                    v.strip().strip('"')
                    for v in value.strip("[]").split(",") if v.strip()
                ]
        elif value in ("true", "false"):
            current[key] = value == "true"
        else:
            try:
                current[key] = int(value)
            except ValueError:
                current[key] = value
    return root


def _qcrows_kernel_magic_ok(blob: bytes) -> tuple[bool, str]:
    """Classify a kernel binary by magic — the in-memory equivalent of
    qcrows-verify's `file | grep (ELF|Linux.*boot)` check.

    Returns (ok, kind) where kind is "elf" | "bzimage" | "unknown".
    """
    if blob[:4] == b"\x7fELF":
        return True, "elf"
    if len(blob) >= 0x206 and blob[0x202:0x206] == b"HdrS":
        return True, "bzimage"
    return False, "unknown"


def _qcrows_image_info(path: Path) -> dict[str, Any]:
    """Read one QCrows archive's self-description, in memory.

    Returns {qcrows: bool, format_version, image, kernel, rootfs,
    initrd, hypervisors, menu, members, error?}.  Non-QCrows tarballs
    (no metadata.toml) return qcrows: false; unreadable archives
    return qcrows: false with an error note — never a raise.
    """
    import tarfile
    info: dict[str, Any] = {"qcrows": False}
    try:
        with tarfile.open(path, "r:*") as tf:
            members = _qcrows_member_names(tf)
            info["members"] = len(members)
            if "metadata.toml" not in members:
                info["error"] = "no metadata.toml (not a QCrows image)"
                return info
            meta_text = _qcrows_read_member(
                tf, members["metadata.toml"],
            ).decode("utf-8", errors="replace")
            meta = _qcrows_parse_toml(meta_text)
            info["qcrows"] = True
            info["format_version"] = meta.get("qcrows", {}).get(
                "format_version",
            )
            image = meta.get("image", {})
            info["image"] = {
                k: image.get(k)
                for k in ("name", "version", "description", "arch",
                          "os", "created_at")
            }
            info["hypervisors"] = image.get(
                "compatibility", {},
            ).get("hypervisors", [])
            info["kernel"] = meta.get("kernel", {})
            info["rootfs"] = meta.get("rootfs", {})
            info["initrd"] = meta.get("initrd", {})
            info["has_boot_params"] = "boot-params.conf" in members
            info["has_kernel_config"] = "kernel/config" in members
            kernel_fmt = "vmlinux" if (
                info["kernel"].get("format") == "vmlinux"
                or "kernel/vmlinux" in members
            ) else "vmlinuz"
            info["kernel_binary_present"] = (
                f"kernel/{kernel_fmt}" in members
            )
            if "menu.toml" in members:
                menu = _qcrows_parse_toml(_qcrows_read_member(
                    tf, members["menu.toml"],
                ).decode("utf-8", errors="replace"))
                info["menu"] = {
                    "label": menu.get("menu", {}).get("label"),
                    "category": menu.get("menu", {}).get("category"),
                }
            else:
                info["menu"] = {}
    except (tarfile.TarError, ValueError, OSError) as exc:
        info["qcrows"] = False
        info["members"] = 0
        info["error"] = _sanitize_output(str(exc), 200)
    return info


def _qcrows_resolve(args: list[str]) -> Path | None:
    """Resolve a user-supplied bundle filename safely under QCROWS_DIR.

    Filename validation + realpath containment — the same hardening
    the qcrows-list path applies.  Returns None (and the caller
    reports the error) on any traversal / invalid name.
    """
    if not args or not _validate_filename(args[0]):
        return None
    return _resolve_path_under_base(str(QCROWS_DIR / args[0]), QCROWS_DIR)


# ── Subcommand: qcrows-list ────────────────────────────────────────
#
# Format-aware per the cockpit-kata master spec: every archive in the
# bundle dir is opened in memory and its self-description surfaced.
# Legacy non-QCrows tarballs degrade to stat-only entries.


def cmd_qcrows_list(_args: list[str]) -> list[dict[str, Any]]:
    """List QCrows images in /usr/share/sysdeck/kata/qcrows/.

    Each entry: {filename, path, size_bytes, size_mb, mtime, qcrows,
    format_version?, image?, kernel?, rootfs?, hypervisors?, menu?,
    error?}.  Returns [] if the directory doesn't exist (empty state,
    NOT mock).
    """
    if not QCROWS_DIR.is_dir():
        return []
    bundles: list[dict[str, Any]] = []
    try:
        for entry in sorted(QCROWS_DIR.iterdir()):
            if not entry.is_file():
                continue
            if not entry.name.endswith((".qcrows", ".qcrows.gz", ".tar.gz", ".tgz")):
                continue
            stat = entry.stat()
            record: dict[str, Any] = {
                "filename": entry.name,
                "path": str(entry),
                "size_bytes": stat.st_size,
                "size_mb": round(stat.st_size / (1024 * 1024), 2),
                "mtime": stat.st_mtime,
            }
            record.update(_qcrows_image_info(entry))
            bundles.append(record)
    except (PermissionError, OSError):
        pass
    return bundles


# ── Subcommand: qcrows-inspect ─────────────────────────────────────


def cmd_qcrows_inspect(args: list[str]) -> dict[str, Any]:
    """Detailed view of one QCrows image in the bundle directory.

    Returns the qcrows-list record plus the full member listing
    (name, size, mode) and build provenance.  {error: ...} on an
    invalid filename, traversal attempt, or unreadable archive.
    """
    resolved = _qcrows_resolve(args)
    if resolved is None or not resolved.is_file():
        return {"error": f"bundle not found under {QCROWS_DIR}: {args[0] if args else ''!r}"}
    import tarfile
    result = _qcrows_image_info(resolved)
    result["filename"] = resolved.name
    result["path"] = str(resolved)
    try:
        with tarfile.open(resolved, "r:*") as tf:
            members = _qcrows_member_names(tf)
            result["members_list"] = [
                {"name": name, "size": m.size, "mode": oct(m.mode)}
                for name, m in sorted(members.items())
            ]
            if "build.toml" in members:
                build = _qcrows_parse_toml(_qcrows_read_member(
                    tf, members["build.toml"],
                ).decode("utf-8", errors="replace"))
                result["build"] = build.get("build", {})
    except (tarfile.TarError, ValueError, OSError) as exc:
        result["error"] = _sanitize_output(str(exc), 200)
    return result


# ── Subcommand: qcrows-verify ──────────────────────────────────────
#
# In-memory mirror of cockpit-kata's qcrows-verify: nothing is
# extracted to disk, no `file` subprocess is spawned (kernel magic is
# checked on bytes), and the hash walk streams members.


def cmd_qcrows_verify(args: list[str]) -> dict[str, Any]:
    """Verify one QCrows image against the master spec's checks.

    Checks (mirroring qcrows-verify):
      1. required files (metadata.toml, menu.toml, hashes.sha256)
      2. rootfs present (rootfs.tar.*)
      3. kernel binary present + magic (bzImage/ELF)
      4. kernel/config present + required Kata options (warn only)
      5. initrd present (warn only)
      6. metadata format_version + hypervisors declared
      7. every hashes.sha256 entry matches the member bytes

    Returns {ok, passed, failed, warnings, checks: [{name, passed,
    detail}]} or {error: ...} for bad filenames / unreadable archives.
    """
    import hashlib
    import tarfile

    resolved = _qcrows_resolve(args)
    if resolved is None or not resolved.is_file():
        return {"error": f"bundle not found under {QCROWS_DIR}: {args[0] if args else ''!r}"}

    checks: list[dict[str, Any]] = []
    warnings: list[str] = []

    def check(name: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "passed": passed, "detail": detail})

    try:
        with tarfile.open(resolved, "r:*") as tf:
            members = _qcrows_member_names(tf)

            # 1. required files
            for req in _QCROWS_REQUIRED_FILES:
                check(f"{req} present", req in members,
                      "found" if req in members else "missing (required)")
            # 2. rootfs
            rootfs = next(
                (n for n in members if n.startswith("rootfs.tar")), None,
            )
            check("rootfs found", rootfs is not None,
                  rootfs or "no rootfs.tar.* member")
            # 3. kernel binary + magic
            kernel_member = next(
                (n for n in ("kernel/vmlinuz", "kernel/vmlinux")
                 if n in members), None,
            )
            magic_kind = "unknown"
            if kernel_member:
                # bzImage magic "HdrS" sits at 0x202 — read past it.
                blob = tf.extractfile(members[kernel_member]).read(0x206 + 4)
                ok_magic, magic_kind = _qcrows_kernel_magic_ok(blob)
                check("kernel binary format valid", ok_magic,
                      f"{kernel_member} ({magic_kind})")
            else:
                check("kernel binary found", False,
                      "kernel/vmlinuz|vmlinux missing (required in v0.2+)")
            # 4. kernel config + Kata options (config presence is a hard
            # check; option shortfalls are WARNINGS only — mirroring
            # qcrows-verify, which still exits 0 on them)
            if "kernel/config" in members:
                check("kernel/config found", True, "kernel/config")
                cfg_text = _qcrows_read_member(
                    tf, members["kernel/config"],
                ).decode("utf-8", errors="replace")
                missing = [
                    opt for opt in QCROWS_REQUIRED_KATA_OPTS
                    if f"{opt}=y" not in cfg_text
                ]
                if missing:
                    warnings.append(
                        "required Kata options missing: " + ", ".join(missing),
                    )
            else:
                check("kernel/config found", False,
                      "kernel/config missing (required in v0.2+)")
            # 5. initrd (warn)
            has_initrd = any(
                n in members for n in (
                    "initrd.img", "initrd.cpio.gz", "initrd.cpio.lz4",
                    "initrd.cpio.xz", "initrd.cramfs",
                )
            )
            if not has_initrd:
                warnings.append(
                    "no initrd found (one of initrd/cramfs is recommended)",
                )
            # 6. metadata fields
            if "metadata.toml" in members:
                meta = _qcrows_parse_toml(_qcrows_read_member(
                    tf, members["metadata.toml"],
                ).decode("utf-8", errors="replace"))
                fmt_ver = meta.get("qcrows", {}).get("format_version")
                check("metadata format_version", fmt_ver is not None,
                      str(fmt_ver or "missing"))
                hypers = meta.get("image", {}).get(
                    "compatibility", {},
                ).get("hypervisors", [])
                check("hypervisor compatibility declared", bool(hypers),
                      ", ".join(map(str, hypers)) or "not declared")
            # 7. hash walk (sha256sum -c semantics, in memory)
            if "hashes.sha256" in members:
                hash_text = _qcrows_read_member(
                    tf, members["hashes.sha256"],
                ).decode("utf-8", errors="replace")
                passed_n = 0
                failed: list[str] = []
                for line in hash_text.splitlines():
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    m = re.match(r"^([0-9a-f]{64})[ *]{2}(.+)$", line)
                    if not m:
                        failed.append(f"unparseable line: {line[:60]}")
                        continue
                    expect, rel = m.group(1), m.group(2).strip()
                    rel = rel[2:] if rel.startswith("./") else rel
                    if rel not in members:
                        failed.append(f"{rel}: no such member")
                        continue
                    h = hashlib.sha256()
                    fh = tf.extractfile(members[rel])
                    for chunk in iter(
                        lambda: fh.read(1024 * 1024), b"",
                    ):
                        h.update(chunk)
                    if h.hexdigest() != expect:
                        failed.append(f"{rel}: checksum mismatch")
                    else:
                        passed_n += 1
                check("SHA-256 checksums", not failed,
                      f"{passed_n} verified" if not failed else
                      "; ".join(failed[:5]))
            else:
                check("SHA-256 checksums", False,
                      "hashes.sha256 missing — cannot verify integrity")
    except (tarfile.TarError, ValueError, OSError) as exc:
        return {"error": _sanitize_output(str(exc), 200)}

    passed = sum(1 for c in checks if c["passed"])
    failed = len(checks) - passed
    return {
        "ok": failed == 0,
        "passed": passed,
        "failed": failed,
        "warnings": warnings,
        "checks": checks,
    }


# ── Dispatch table ─────────────────────────────────────────────────

COMMANDS = {
    "list":            cmd_list,
    "inspect":         cmd_inspect,
    "metrics":         cmd_metrics,
    "summary":         cmd_summary,
    "version":         cmd_version,
    "check":           cmd_check,
    "pxe-status":      cmd_pxe_status,
    "qcrows-list":     cmd_qcrows_list,
    "qcrows-inspect":  cmd_qcrows_inspect,
    "qcrows-verify":   cmd_qcrows_verify,
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
