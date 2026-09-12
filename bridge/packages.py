#!/usr/bin/env python3
"""
SysDeck - Packages Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Wraps the system package manager into a unified JSON interface so the
Packages panel can list, search, install, update, and remove packages
without knowing which distro it runs on. Ten backends, same step-down
on both editions (web console: web/src/lib/sysdeck/bridge/packages.ts):

    pacman (Arch) · emerge (Gentoo/Portage) · lunar (Lunar Linux) ·
    sorcery (SourceMage) · xbps (Void) · apk (Alpine) · zypper
    (openSUSE) · dnf / yum (RPM) · apt (Debian)

Every list/updates/search/info read hits the REAL package database of
the detected manager (dpkg-query, pacman -Q, rpm -qa, /var/db/pkg scan,
lvu/gaze state) — no fabricated rows, ever. Backends without an
update-preview subcommand (lunar) report that honestly instead of
inventing a count.

The package manager is invoked as a separate process via subprocess —
the suite (MIT) and the package manager remain independent programs.
No package-manager code is bundled.

Usage:
    python3 /usr/lib/sysdeck/bridge/packages.py list-installed
    python3 /usr/lib/sysdeck/bridge/packages.py list-updates
    python3 /usr/lib/sysdeck/bridge/packages.py search <term>
    python3 /usr/lib/sysdeck/bridge/packages.py info <name>
    python3 /usr/lib/sysdeck/bridge/packages.py install <name>
    python3 /usr/lib/sysdeck/bridge/packages.py remove <name>
    python3 /usr/lib/sysdeck/bridge/packages.py update <name>
    python3 /usr/lib/sysdeck/bridge/packages.py update-all
    python3 /usr/lib/sysdeck/bridge/packages.py dry-run <action> [name]
    python3 /usr/lib/sysdeck/bridge/packages.py summary

install / remove / update / update-all ACTUALLY RUN the package manager
via subprocess. The cockpit JS panel passes { superuser: 'try' } to
cockpit.spawn so the operator authenticates via polkit
(org.sysdeck.packages.modify, shipped since v0.0.17). No `sudo`
shell-out from JS — this is the cockpit way.

The `dry-run` subcommand returns the command string without running
it, for the panel's preview-before-confirm flow.
"""

import json
import os
import re
import shutil
import subprocess
import sys
from typing import Any

# Scrubbed child environment: parsed output stays locale-stable (LC_ALL=C)
# and no console process state leaks into children.
SCRUBBED_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}


PACMAN_LICENSE = "GPL-2.0+ (pacman)"
PACMAN_AUTHOR = "Pacman Development Team"
PACMAN_URL = "https://archlinux.org/pacman/"

# Detect the system package manager once at import time.
# Step-down, most specific first — identical order and corroboration
# rules to the web console's detectBackend(): pacman (Arch) → emerge
# (Gentoo, corroborated by the /var/db/pkg vdb) → lunar (Lunar) →
# sorcery (SourceMage) → xbps (Void, probed via xbps-query — Void
# ships no bare `xbps` binary) → apk (Alpine) → zypper (openSUSE) →
# dnf (Fedora) → yum (RHEL 7) → apt (Debian/Ubuntu). Binary presence
# is a shutil.which probe: no child process, no --version flag quirks.

EMERGE_PKG_DB = "/var/db/pkg"
LUNAR_STATE = "/var/state/lunar/packages"
SORCERY_STATE = "/var/state/sorcery/packages"

DETECT_PROBES: tuple[tuple[str, str], ...] = (
    ("pacman", "pacman"),
    ("emerge", "emerge"),
    ("lunar", "lunar"),
    ("sorcery", "sorcery"),
    ("xbps", "xbps-query"),
    ("apk", "apk"),
    ("zypper", "zypper"),
    ("dnf", "dnf"),
    ("yum", "yum"),
    ("apt", "apt"),
)


def _detect_pkg_manager() -> str:
    """Return the detected manager id ('pacman', 'emerge', 'lunar',
    'sorcery', 'xbps', 'apk', 'zypper', 'dnf', 'yum', 'apt') or
    'unknown' when no known package manager is installed."""
    for mgr, probe in DETECT_PROBES:
        if shutil.which(probe) is None:
            continue
        if mgr == "emerge" and not os.path.isdir(EMERGE_PKG_DB):
            # Corroboration: a Gentoo box always carries the vdb.
            continue
        return mgr
    return "unknown"


PKG_MANAGER = _detect_pkg_manager()


def run(argv: list[str], timeout: int = 60, ok_rcs: tuple[int, ...] = ()) -> str:
    """Run a command, returning stdout; '' on real failure.

    check=False + an explicit accept-set: dnf check-update exits 100
    when updates EXIST (and 0 when none do) — treating 100 as failure
    would fabricate an empty update list on every RPM host. Every child
    runs under the scrubbed env with a hard timeout."""
    try:
        r = subprocess.run(
            argv, capture_output=True, text=True, check=False,
            timeout=timeout, env=SCRUBBED_ENV,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ""
    if r.returncode == 0 or r.returncode in ok_rcs:
        return r.stdout
    return ""


# ── Pacman backend ──────────────────────────────────────────────────

def _pacman_list_installed() -> list[dict[str, str]]:
    """List installed packages via pacman -Q."""
    raw = run(["pacman", "-Q"])
    return [
        {"name": parts[0], "version": parts[1]}
        for line in raw.splitlines()
        if (parts := line.split()) and len(parts) >= 2
    ]


def _pacman_list_updates() -> list[dict[str, str]]:
    """List available updates via pacman -Qu."""
    raw = run(["pacman", "-Qu"])
    return [
        {"name": parts[0], "current": parts[1], "new": parts[2] if len(parts) > 2 else parts[1]}
        for line in raw.splitlines()
        if (parts := line.split()) and len(parts) >= 2
    ]


def _pacman_search(term: str) -> list[dict[str, str]]:
    """Search packages via pacman -Ss."""
    raw = run(["pacman", "-Ss", term])
    results: list[dict[str, str]] = []
    for line in raw.splitlines():
        # Format: "repo/name version [installed]"
        if line.startswith(" ") or not line.strip():
            continue
        parts = line.split()
        if len(parts) >= 2:
            name_ver = parts[0]
            installed = "[installed]" in line
            name = name_ver.split("/")[-1] if "/" in name_ver else name_ver
            results.append({"name": name, "version": parts[1], "installed": str(installed).lower()})
    return results


def _pacman_info(name: str) -> dict[str, Any]:
    """Package info via pacman -Si."""
    raw = run(["pacman", "-Si", name])
    info: dict[str, Any] = {"name": name}
    for line in raw.splitlines():
        if ":" in line:
            key, _, val = line.partition(":")
            info[key.strip().lower().replace(" ", "_")] = val.strip()
    return info


# ── DNF backend ─────────────────────────────────────────────────────

def _dnf_list_installed() -> list[dict[str, str]]:
    """List installed packages via dnf list installed."""
    raw = run(["dnf", "list", "installed", "--quiet"])
    return _parse_rpm_list(raw)


def _dnf_list_updates() -> list[dict[str, str]]:
    """List available updates via dnf check-update.

    dnf check-update exits 100 when updates exist (0 when none) — the
    100 is data, not failure."""
    raw = run(["dnf", "check-update", "--quiet"], timeout=120, ok_rcs=(100,))
    return _parse_rpm_update_list(raw)


def _dnf_search(term: str) -> list[dict[str, str]]:
    """Search packages via dnf search."""
    raw = run(["dnf", "search", term, "--quiet"])
    results: list[dict[str, str]] = []
    for line in raw.splitlines():
        if ":" in line and not line.startswith(" "):
            parts = line.split(":")
            if len(parts) >= 2:
                name_ver = parts[0].strip()
                name = name_ver.split(".")[0] if "." in name_ver else name_ver
                results.append({"name": name, "description": parts[1].strip()})
    return results


def _dnf_info(name: str) -> dict[str, Any]:
    """Package info via dnf info."""
    raw = run(["dnf", "info", name, "--quiet"])
    return _parse_rpm_info(raw, name)


# ── APT backend ─────────────────────────────────────────────────────

def _apt_list_installed() -> list[dict[str, str]]:
    """List installed packages via dpkg-query."""
    raw = run(["dpkg-query", "-W", "-f=${Package}\\t${Version}\\n"])
    return [
        {"name": parts[0], "version": parts[1]}
        for line in raw.splitlines()
        if (parts := line.split("\t")) and len(parts) >= 2
    ]


def _apt_list_updates() -> list[dict[str, str]]:
    """List available updates via apt list --upgradable."""
    raw = run(["apt", "list", "--upgradable", "-qq"])
    return [
        {"name": parts[0].split("/")[0], "new": parts[1]}
        for line in raw.splitlines()
        if (parts := line.split()) and len(parts) >= 2
    ]


def _apt_search(term: str) -> list[dict[str, str]]:
    """Search packages via apt search."""
    raw = run(["apt-cache", "search", term])
    results: list[dict[str, str]] = []
    for line in raw.splitlines():
        if " - " in line:
            name_desc = line.split(" - ", 1)
            name_ver = name_desc[0].split()
            if name_ver:
                results.append({"name": name_ver[0], "description": name_desc[1] if len(name_desc) > 1 else ""})
    return results


def _apt_info(name: str) -> dict[str, Any]:
    """Package info via apt show."""
    raw = run(["apt-cache", "show", name])
    return _parse_apt_info(raw, name)


# ── Shared helpers for the distro backends ──────────────────────────

_VER_TAIL_RE = re.compile(r"^[0-9][0-9a-zA-Z._+-]*[0-9a-zA-Z._+]$")


def _split_name_ver(atom: str) -> tuple[str, str]:
    """Tolerant name/version split for flat atoms.

    "gcc-13.2.1-r0" → ("gcc", "13.2.1-r0"); "linux-headers-6.1" →
    ("linux-headers", "6.1"). Rule: the earliest hyphen followed by a
    digit whose tail is version-shaped wins."""
    for i in range(len(atom)):
        if atom[i] != "-":
            continue
        tail = atom[i + 1:]
        if tail and tail[0].isdigit() and _VER_TAIL_RE.match(tail):
            return atom[:i], tail
    return atom, ""


def _parse_colon_blocks(raw: str) -> dict[str, str]:
    """Parse "Key: value" lines into a lowercase snake-key dict."""
    out: dict[str, str] = {}
    for line in raw.splitlines():
        if ":" in line:
            key, _, val = line.partition(":")
            k = key.strip().lower().replace(" ", "_").replace("-", "_")
            out[k] = val.strip()
    return out


def _rpm_db_list_installed() -> list[dict[str, str]]:
    """Installed rows straight from the rpm database — the zero-tooling
    source of truth shared by the zypper backend: name TAB version."""
    raw = run(["rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\n"], timeout=60)
    rows: list[dict[str, str]] = []
    for line in raw.splitlines():
        name, _, version = line.partition("\t")
        if name:
            rows.append({"name": name, "version": version, "installed": True})
    return rows


def _read_text(path: str) -> str:
    """Small text-file read; '' when absent/unreadable."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


# ── Zypper backend (openSUSE) ────────────────────────────────────────

def _zypper_list_installed() -> list[dict[str, str]]:
    """List installed packages from the rpm database."""
    return _rpm_db_list_installed()


def _zypper_table(raw: str, wanted: tuple[str, ...]) -> tuple[dict[str, int], list[list[str]]]:
    """Parse a zypper pipe-table by locating columns from its header row.

    zypper prefixes data tables with status/repository columns whose
    count varies by subcommand and zypper release; positional parsing
    breaks across those. The header row is the source of truth: find
    each wanted column's index there, then read the data rows."""
    header: dict[str, int] = {}
    data: list[list[str]] = []
    for line in raw.splitlines():
        if "|" not in line:
            continue
        cols = [c.strip() for c in line.split("|")]
        if not header:
            if all(w in cols for w in wanted):
                header = {w: cols.index(w) for w in wanted}
            continue
        # Separator rows ('-----+-----') and repeated header rows.
        if cols and all(c and set(c) <= {"-", "+"} for c in cols):
            continue
        if any(len(cols) > header[w] and cols[header[w]] == w for w in header):
            continue
        data.append(cols)
    return header, data


def _zypper_list_updates() -> list[dict[str, str]]:
    """List available updates via zypper -q list-updates.

    Output is pipe-separated with a header row (Repository/Name/Current/
    Available/Arch, plus a leading status column on some releases)."""
    raw = run(["zypper", "-q", "list-updates"], timeout=60)
    header, rows = _zypper_table(raw, ("Name", "Current", "Available"))
    out: list[dict[str, str]] = []
    for cols in rows:
        if len(cols) <= max(header.values()):
            continue
        name = cols[header["Name"]]
        if not name:
            continue
        out.append({"name": name,
                    "current": cols[header["Current"]],
                    "candidate": cols[header["Available"]]})
    return out


def _zypper_search(term: str) -> list[dict[str, Any]]:
    """Search packages via zypper -q se (columns: status, Name, Summary)."""
    raw = run(["zypper", "-q", "se", term], timeout=30)
    header, rows = _zypper_table(raw, ("Name", "Summary"))
    out: list[dict[str, Any]] = []
    i_name = header.get("Name", 1)
    for cols in rows:
        if len(cols) <= i_name:
            continue
        name = cols[i_name]
        if not name:
            continue
        out.append({"name": name, "version": "",
                    "description": cols[header["Summary"]],
                    "installed": cols[0] == "i"})
    return out


def _zypper_info(name: str) -> dict[str, Any]:
    """Package info via zypper -q info."""
    raw = run(["zypper", "-q", "info", name], timeout=20)
    if not raw.strip():
        return {}
    info = _parse_colon_blocks(raw)
    return {
        "name": name,
        "version": f"{info.get('version', '')}-{info.get('release', '')}",
        "status": "installed" if "installed" in info.get("status", "") else "not installed",
        "depends": info.get("depends_on", ""),
        "description": info.get("description", info.get("summary", "")),
        "maintainer": info.get("packager", ""),
    }


# ── apk backend (Alpine / postmarketOS) ──────────────────────────────

def _apk_list_installed() -> list[dict[str, str]]:
    """List installed packages via apk info -v (name-version lines)."""
    raw = run(["apk", "info", "-v"], timeout=30)
    rows: list[dict[str, str]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        name, version = _split_name_ver(line)
        if name:
            rows.append({"name": name, "version": version, "installed": True})
    rows.sort(key=lambda r: r["name"])
    return rows


def _apk_list_updates() -> list[dict[str, str]]:
    """List available updates via apk list --upgradable (fallback:
    apk version -l '<' on older apk)."""
    raw = run(["apk", "list", "--upgradable"], timeout=30)
    if not raw.strip():
        raw = run(["apk", "version", "-l", "<"], timeout=30)
    rows: list[dict[str, str]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("Installed") or line.startswith("Available"):
            continue
        toks = line.split()
        name, version = _split_name_ver(toks[0] if toks else "")
        if not name:
            continue
        cand = ""
        for t in toks[1:]:
            if t != "<" and not t.startswith("("):
                cand = t
                break
        rows.append({"name": name, "current": version, "candidate": cand})
    return rows


def _apk_search(term: str) -> list[dict[str, Any]]:
    """Search packages via apk search -v ('name-version - description')."""
    raw = run(["apk", "search", "-v", term], timeout=30)
    rows: list[dict[str, Any]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        head, _, desc = line.partition(" - ")
        name, version = _split_name_ver(head.strip())
        rows.append({"name": name, "version": version,
                     "description": desc.strip(), "installed": False})
    return rows


def _apk_info(name: str) -> dict[str, Any]:
    """Package info via apk info — installed packages only, hence the
    fixed status."""
    raw = run(["apk", "info", name], timeout=15)
    if not raw.strip():
        return {}
    info = _parse_colon_blocks(raw)
    return {
        "name": name,
        "version": info.get("version", ""),
        "status": "installed",
        "depends": info.get("depends", ""),
        "description": info.get("description",
                                raw.splitlines()[0] if raw.splitlines() else ""),
        "maintainer": info.get("maintainer", ""),
    }


# ── xbps backend (Void Linux) ────────────────────────────────────────

def _xbps_list_installed() -> list[dict[str, str]]:
    """List installed packages via xbps-query -l ('ii pkg-ver desc')."""
    raw = run(["xbps-query", "-l"], timeout=30)
    rows: list[dict[str, str]] = []
    for line in raw.splitlines():
        m = re.match(r"^ii\s+(\S+)\s+(.*)$", line)
        if not m:
            continue
        name, version = _split_name_ver(m.group(1))
        if name:
            rows.append({"name": name, "version": version, "installed": True})
    rows.sort(key=lambda r: r["name"])
    return rows


def _xbps_list_updates() -> list[dict[str, str]]:
    """List available updates via xbps-install -Sun."""
    raw = run(["xbps-install", "-Sun"], timeout=60)
    rows: list[dict[str, str]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        toks = line.split()
        name, version = _split_name_ver(toks[0] if toks else "")
        if not name:
            continue
        cand = toks[1] if len(toks) > 1 else ""
        if cand in ("xbps:", "delta:") and len(toks) > 2:
            cand = toks[2]
        rows.append({"name": name, "current": version, "candidate": cand})
    return rows


def _xbps_search(term: str) -> list[dict[str, Any]]:
    """Search packages via xbps-query -Rs ('[*] [repo/]name-ver - desc').

    The repository prefix is optional — plain 'name-ver' rows are the
    common form, so the parser accepts both."""
    raw = run(["xbps-query", "-Rs", term], timeout=30)
    rows: list[dict[str, Any]] = []
    for line in raw.splitlines():
        m = re.match(r"^\[\*\]\s+(?:\S+/)?(\S+)\s+-\s+(.*)$", line)
        if not m:
            continue
        name, version = _split_name_ver(m.group(1))
        rows.append({"name": name, "version": version,
                     "description": m.group(2), "installed": False})
    return rows


def _xbps_info(name: str) -> dict[str, Any]:
    """Package info via xbps-query -R (repository) falling back to the
    local db query."""
    raw = run(["xbps-query", "-R", name], timeout=15)
    if not raw.strip():
        raw = run(["xbps-query", name], timeout=15)
    if not raw.strip():
        return {}
    info = _parse_colon_blocks(raw)
    return {
        "name": name,
        "version": info.get("pkgver", info.get("version", "")),
        "status": "installed" if "install-date" in raw else "repository (not installed)",
        "depends": info.get("depends", info.get("run_depends", "")),
        "description": info.get("short_desc", ""),
        "maintainer": info.get("maintainer", ""),
    }


# ── emerge backend (Gentoo / Portage) ────────────────────────────────

def _emerge_list_installed() -> list[dict[str, str]]:
    """Installed set from the vdb itself: /var/db/pkg/<cat>/<name>-<ver>.

    Zero-dependency source of truth — no emerge invocation needed."""
    rows: list[dict[str, str]] = []
    try:
        cats = os.listdir(EMERGE_PKG_DB)
    except OSError:
        return rows
    for cat in cats:
        cdir = os.path.join(EMERGE_PKG_DB, cat)
        try:
            entries = os.listdir(cdir)
        except OSError:
            continue
        for pf in entries:
            leaf, version = _split_name_ver(pf)
            rows.append({"name": f"{cat}/{leaf}", "version": version, "installed": True})
    rows.sort(key=lambda r: r["name"])
    return rows


def _emerge_list_updates() -> list[dict[str, str]]:
    """Deep world update preview via emerge -p -u -D @world.

    Parses ' [ebuild     U     ] cat/pkg-1.2.3 [1.2.2]' lines. The
    atom is anchored AFTER the class bracket — portage pads the class
    field with spaces, so a regex that starts the atom before the
    bracket captures the bracket itself and drops every row."""
    raw = run(["emerge", "-p", "-u", "-D", "@world"], timeout=90)
    rows: list[dict[str, str]] = []
    for line in raw.splitlines():
        m = re.search(r"\[ebuild\s+U[^\]]*\]\s*(\S+)(?:\s+\[([^\]]+)\])?", line)
        if not m:
            continue
        atom = m.group(1)
        slash = atom.rfind("/")
        if slash < 0:
            continue
        leaf, version = _split_name_ver(atom[slash + 1:])
        rows.append({"name": f"{atom[:slash]}/{leaf}",
                     "current": m.group(2) or "", "candidate": version})
    return rows


def _emerge_search(term: str) -> list[dict[str, Any]]:
    """Search via emerge --search ('* cat/pkg' + 'Description:' lines)."""
    raw = run(["emerge", "--search", term], timeout=60)
    rows: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for line in raw.splitlines():
        m = re.match(r"^\*\s+(\S+)$", line)
        if m:
            if cur:
                rows.append(cur)
            cur = {"name": m.group(1), "version": "", "description": "", "installed": False}
            continue
        if cur and "Description:" in line:
            cur["description"] = line.split("Description:", 1)[1].strip()
        if cur and re.search(r"\[installed\]", line, re.IGNORECASE):
            cur["installed"] = True
    if cur:
        rows.append(cur)
    return rows


def _emerge_info(name: str) -> dict[str, Any]:
    """Real metadata from the installed package's /var/db/pkg entry.

    Accepts both 'cat/pkg' atoms and bare names (the latter scans every
    category for a matching leaf)."""
    slash = name.rfind("/")
    if slash > 0:
        candidates = [name[:slash]]
        leaf = name[slash + 1:]
    else:
        leaf = name
        candidates = []
        try:
            candidates = sorted(os.listdir(EMERGE_PKG_DB))
        except OSError:
            return {}
    for cat in candidates:
        cdir = os.path.join(EMERGE_PKG_DB, cat)
        try:
            entries = os.listdir(cdir)
        except OSError:
            continue
        for pf in entries:
            pf_leaf, version = _split_name_ver(pf)
            if pf_leaf != leaf:
                continue
            pdir = os.path.join(cdir, pf)
            desc = _read_text(os.path.join(pdir, "DESCRIPTION")).strip()
            if not (desc or version):
                continue
            return {
                "name": f"{cat}/{leaf}",
                "version": version,
                "status": "installed (from /var/db/pkg)",
                "depends": (_read_text(os.path.join(pdir, "RDEPEND"))
                            or _read_text(os.path.join(pdir, "PDEPEND"))).strip(),
                "description": desc,
                "maintainer": _read_text(os.path.join(pdir, "HOMEPAGE")).strip(),
            }
    return {}


# ── lunar backend (Lunar Linux) ──────────────────────────────────────

def _lunar_list_installed() -> list[dict[str, str]]:
    """Installed modules via lvu installed; the /var/state/lunar/packages
    file is the dependency-free fallback."""
    raw = run(["lvu", "installed"], timeout=30)
    if raw.strip():
        return [{"name": t[0], "version": t[1] if len(t) > 1 else "", "installed": True}
                for t in (line.strip().split() for line in raw.splitlines()) if t]
    rows: list[dict[str, str]] = []
    for line in _read_text(LUNAR_STATE).splitlines():
        line = line.strip()
        if not line:
            continue
        toks = line.split()
        rows.append({"name": toks[0], "version": toks[1] if len(toks) > 1 else "",
                     "installed": True})
    rows.sort(key=lambda r: r["name"])
    return rows


def _lunar_list_updates() -> list[dict[str, str]]:
    """lvu has no update-preview subcommand; `lunar update` performs the
    fetch + rebuild. Honest empty list — the summary carries the note
    explaining why, instead of fabricating a count."""
    return []


def _lunar_search(term: str) -> list[dict[str, Any]]:
    """Search modules via lvu search."""
    raw = run(["lvu", "search", term], timeout=30)
    rows: list[dict[str, Any]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        toks = line.split()
        rows.append({"name": toks[0], "version": "", "description": line, "installed": False})
    return rows


def _lunar_info(name: str) -> dict[str, Any]:
    """Module info via lvu details."""
    raw = run(["lvu", "details", name], timeout=15)
    if not raw.strip():
        return {}
    info = _parse_colon_blocks(raw)
    first = next((l.strip() for l in raw.splitlines() if l.strip()), "")
    return {
        "name": name,
        "version": info.get("version", ""),
        "status": "installed (lunar)",
        "depends": info.get("depends", ""),
        "description": info.get("description", first),
        "maintainer": info.get("maintainer", ""),
    }


# ── sorcery backend (SourceMage GNU/Linux) ──────────────────────────

def _sorcery_list_installed() -> list[dict[str, str]]:
    """Installed spells via gaze installed; the /var/state/sorcery/packages
    file is the dependency-free fallback."""
    raw = run(["gaze", "installed"], timeout=30)
    if raw.strip():
        return [{"name": t[0], "version": t[1] if len(t) > 1 else "", "installed": True}
                for t in (re.split(r"[\s:]+", line.strip()) for line in raw.splitlines()) if t]
    rows: list[dict[str, str]] = []
    for line in _read_text(SORCERY_STATE).splitlines():
        line = line.strip()
        if not line:
            continue
        toks = line.split()
        rows.append({"name": toks[0], "version": toks[1] if len(toks) > 1 else "",
                     "installed": True})
    rows.sort(key=lambda r: r["name"])
    return rows


def _sorcery_list_updates() -> list[dict[str, str]]:
    """Pending spell updates via sorcery queue."""
    raw = run(["sorcery", "queue"], timeout=60)
    rows: list[dict[str, str]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        toks = line.split()
        rows.append({"name": toks[0], "current": "",
                     "candidate": toks[1] if len(toks) > 1 else ""})
    return rows


def _sorcery_search(term: str) -> list[dict[str, Any]]:
    """Search spells via gaze search."""
    raw = run(["gaze", "search", term], timeout=30)
    rows: list[dict[str, Any]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        toks = re.split(r"[\s:]+", line)
        rows.append({"name": toks[0] if toks else "", "version": "",
                     "description": line, "installed": False})
    return rows


def _sorcery_info(name: str) -> dict[str, Any]:
    """Spell info via gaze what, falling back to gaze details."""
    for sub in ("what", "details"):
        raw = run(["gaze", sub, name], timeout=15)
        if not raw.strip():
            continue
        info = _parse_colon_blocks(raw)
        first = next((l.strip() for l in raw.splitlines() if l.strip()), "")
        return {
            "name": name,
            "version": info.get("version", info.get("spell_version", "")),
            "status": "installed (sorcery)",
            "depends": info.get("depends", ""),
            "description": info.get("description",
                                    info.get("short_description", first)),
            "maintainer": info.get("maintainer", ""),
        }
    return {}


# ── yum backend (RHEL 7 era RPM) ─────────────────────────────────────

def _yum_list_installed() -> list[dict[str, str]]:
    """List installed packages via yum list installed --quiet."""
    raw = run(["yum", "list", "installed", "--quiet"], timeout=120)
    return _parse_rpm_list(raw)


def _yum_list_updates() -> list[dict[str, str]]:
    """List available updates via yum check-update --quiet.

    yum check-update mirrors dnf: exit 100 when updates exist, 0 when
    none do — 100 is data here, not failure."""
    raw = run(["yum", "check-update", "--quiet"], timeout=120, ok_rcs=(100,))
    return _parse_rpm_update_list(raw)


def _yum_search(term: str) -> list[dict[str, Any]]:
    """Search packages via yum search."""
    raw = run(["yum", "search", term])
    return [{"name": parts[0], "description": " ".join(parts[1:])}
            for line in raw.splitlines()
            if (parts := line.split(" : ", 1)) and len(parts) == 2 and parts[0]]


def _yum_info(name: str) -> dict[str, Any]:
    """Package info via yum info."""
    raw = run(["yum", "info", name])
    return _parse_rpm_info(raw, name)


# ── Shared parsers ──────────────────────────────────────────────────

def _parse_rpm_list(raw: str) -> list[dict[str, str]]:
    """Parse 'name.arch  version  repo' tabular output."""
    results: list[dict[str, str]] = []
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) >= 2 and not line.startswith("Last"):
            name = parts[0].split(".")[0] if "." in parts[0] else parts[0]
            results.append({"name": name, "version": parts[1]})
    return results


def _parse_rpm_update_list(raw: str) -> list[dict[str, str]]:
    """Parse dnf check-update output."""
    results: list[dict[str, str]] = []
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) >= 2 and not line.startswith("Last") and not line.startswith(" "):
            name = parts[0].split(".")[0] if "." in parts[0] else parts[0]
            results.append({"name": name, "new": parts[1]})
    return results


def _parse_rpm_info(raw: str, name: str) -> dict[str, Any]:
    """Parse dnf info output into key-value pairs."""
    info: dict[str, Any] = {"name": name}
    for line in raw.splitlines():
        if ":" in line:
            key, _, val = line.partition(":")
            info[key.strip().lower().replace(" ", "_")] = val.strip()
    return info


def _parse_apt_info(raw: str, name: str) -> dict[str, Any]:
    """Parse apt-cache show output into key-value pairs."""
    info: dict[str, Any] = {"name": name}
    for line in raw.splitlines():
        if ":" in line:
            key, _, val = line.partition(":")
            info[key.strip().lower().replace("-", "_")] = val.strip()
    return info


# ── Dispatch table per package manager ──────────────────────────────

def _backend(mgr: str) -> dict[str, Any]:
    """Read-backend dispatch for one manager id."""
    table: dict[str, dict[str, Any]] = {
        "pacman": {
            "list-installed": lambda _args: _pacman_list_installed(),
            "list-updates": lambda _args: _pacman_list_updates(),
            "search": lambda args: _pacman_search(args[0]) if args else [],
            "info": lambda args: _pacman_info(args[0]) if args else {},
        },
        "emerge": {
            "list-installed": lambda _args: _emerge_list_installed(),
            "list-updates": lambda _args: _emerge_list_updates(),
            "search": lambda args: _emerge_search(args[0]) if args else [],
            "info": lambda args: _emerge_info(args[0]) if args else {},
        },
        "lunar": {
            "list-installed": lambda _args: _lunar_list_installed(),
            "list-updates": lambda _args: _lunar_list_updates(),
            "search": lambda args: _lunar_search(args[0]) if args else [],
            "info": lambda args: _lunar_info(args[0]) if args else {},
        },
        "sorcery": {
            "list-installed": lambda _args: _sorcery_list_installed(),
            "list-updates": lambda _args: _sorcery_list_updates(),
            "search": lambda args: _sorcery_search(args[0]) if args else [],
            "info": lambda args: _sorcery_info(args[0]) if args else {},
        },
        "xbps": {
            "list-installed": lambda _args: _xbps_list_installed(),
            "list-updates": lambda _args: _xbps_list_updates(),
            "search": lambda args: _xbps_search(args[0]) if args else [],
            "info": lambda args: _xbps_info(args[0]) if args else {},
        },
        "apk": {
            "list-installed": lambda _args: _apk_list_installed(),
            "list-updates": lambda _args: _apk_list_updates(),
            "search": lambda args: _apk_search(args[0]) if args else [],
            "info": lambda args: _apk_info(args[0]) if args else {},
        },
        "zypper": {
            "list-installed": lambda _args: _zypper_list_installed(),
            "list-updates": lambda _args: _zypper_list_updates(),
            "search": lambda args: _zypper_search(args[0]) if args else [],
            "info": lambda args: _zypper_info(args[0]) if args else {},
        },
        "dnf": {
            "list-installed": lambda _args: _dnf_list_installed(),
            "list-updates": lambda _args: _dnf_list_updates(),
            "search": lambda args: _dnf_search(args[0]) if args else [],
            "info": lambda args: _dnf_info(args[0]) if args else {},
        },
        "yum": {
            "list-installed": lambda _args: _yum_list_installed(),
            "list-updates": lambda _args: _yum_list_updates(),
            "search": lambda args: _yum_search(args[0]) if args else [],
            "info": lambda args: _yum_info(args[0]) if args else {},
        },
        "apt": {
            "list-installed": lambda _args: _apt_list_installed(),
            "list-updates": lambda _args: _apt_list_updates(),
            "search": lambda args: _apt_search(args[0]) if args else [],
            "info": lambda args: _apt_info(args[0]) if args else {},
        },
    }
    return table.get(mgr, {})


def list_installed() -> list[dict[str, str]]:
    """List installed packages using the detected package manager."""
    fn = _backend(PKG_MANAGER).get("list-installed")
    return fn([]) if fn else []


def list_updates() -> list[dict[str, str]]:
    """List available updates using the detected package manager."""
    fn = _backend(PKG_MANAGER).get("list-updates")
    return fn([]) if fn else []


def search(args: list[str]) -> list[dict[str, Any]]:
    """Search packages using the detected package manager."""
    fn = _backend(PKG_MANAGER).get("search")
    return fn(args) if fn else []


def info(args: list[str]) -> dict[str, Any]:
    """Get package info using the detected package manager."""
    fn = _backend(PKG_MANAGER).get("info")
    return fn(args) if fn else {}


def _pkg_name_ok(pkg: str) -> bool:
    """SECURITY: package names are passed to the system package
    manager as one argv element. A leading dash turns them into manager
    OPTIONS (pacman --config=…, dnf --setopt=…) and a URL makes dnf
    fetch a remote RPM — argument injection, not shell injection. One
    safe component: no leading dash, no whitespace/control chars, no
    URL scheme, bounded length."""
    return (
        isinstance(pkg, str)
        and 0 < len(pkg) <= 256
        and not pkg.startswith("-")
        and "://" not in pkg
        and not re.search(r"[\s\x00\x1b]", pkg)
    )


def _first_pkg_arg(args: list[str]) -> str | None:
    """Accept the shell convention `--` as an argv separator: callers
    may pass `packages.py install -- <pkgs…>`; the separator is skipped
    and the first package name wins."""
    for a in args:
        if a != "--":
            return a
    return None


# ── Mutation commands, one table for all ten managers ───────────────
# Each entry is the exact argv the real package manager receives;
# {pkg} is substituted with the validated package name. Actions a
# manager genuinely lacks (lunar single-module update) are absent from
# its row — the caller reports the honest refusal instead of running
# a command that does not exist.

MUTATION_CMDS: dict[str, dict[str, list[str]]] = {
    "install": {
        "pacman":  ["pacman", "-S", "--noconfirm", "{pkg}"],
        "emerge":  ["emerge", "{pkg}"],
        "lunar":   ["lin", "{pkg}"],
        "sorcery": ["cast", "{pkg}"],
        "xbps":    ["xbps-install", "-y", "{pkg}"],
        "apk":     ["apk", "add", "{pkg}"],
        "zypper":  ["zypper", "--non-interactive", "install", "{pkg}"],
        "dnf":     ["dnf", "install", "-y", "{pkg}"],
        "yum":     ["yum", "install", "-y", "{pkg}"],
        "apt":     ["apt", "install", "-y", "{pkg}"],
    },
    "remove": {
        "pacman":  ["pacman", "-R", "--noconfirm", "{pkg}"],
        "emerge":  ["emerge", "--unmerge", "{pkg}"],
        "lunar":   ["lrm", "{pkg}"],
        "sorcery": ["dispel", "{pkg}"],
        "xbps":    ["xbps-remove", "-y", "{pkg}"],
        "apk":     ["apk", "del", "{pkg}"],
        "zypper":  ["zypper", "--non-interactive", "remove", "{pkg}"],
        "dnf":     ["dnf", "remove", "-y", "{pkg}"],
        "yum":     ["yum", "remove", "-y", "{pkg}"],
        "apt":     ["apt", "remove", "-y", "{pkg}"],
    },
    "update": {
        "pacman":  ["pacman", "-S", "--noconfirm", "{pkg}"],
        "emerge":  ["emerge", "-u", "{pkg}"],
        "sorcery": ["cast", "{pkg}"],
        "xbps":    ["xbps-install", "-y", "{pkg}"],
        "apk":     ["apk", "upgrade", "{pkg}"],
        "zypper":  ["zypper", "--non-interactive", "update", "{pkg}"],
        "dnf":     ["dnf", "upgrade", "-y", "{pkg}"],
        "yum":     ["yum", "upgrade", "-y", "{pkg}"],
        "apt":     ["apt", "upgrade", "-y", "{pkg}"],
    },
    "update-all": {
        "pacman":  ["pacman", "-Syu", "--noconfirm"],
        "emerge":  ["emerge", "-u", "-D", "@world"],
        "lunar":   ["lunar", "update"],
        "sorcery": ["sorcery", "update"],
        "xbps":    ["xbps-install", "-Su", "-y"],
        "apk":     ["apk", "upgrade"],
        "zypper":  ["zypper", "--non-interactive", "update"],
        "dnf":     ["dnf", "upgrade", "-y"],
        "yum":     ["yum", "upgrade", "-y"],
        "apt":     ["apt", "upgrade", "-y"],
    },
}


def _mutation_cmd(action: str, pkg: str) -> list[str]:
    """Resolve the argv for one mutation under the detected manager.

    Returns [] when the action/manager pair is absent — the caller
    reports the honest refusal."""
    tmpl = MUTATION_CMDS.get(action, {}).get(PKG_MANAGER, [])
    return [tok.replace("{pkg}", pkg) for tok in tmpl]


def install(args: list[str]) -> dict[str, str]:
    """Install a package — actually runs the package manager via subprocess.

    The cockpit way is to run the operation via the cockpit superuser
    channel: the JS panel calls cockpit.spawn() with
    { superuser: 'try' }, which prompts the operator via polkit for
    the org.sysdeck.packages.modify action. The bridge runs the package
    manager via subprocess and returns stdout/stderr so the panel can
    render the live output.

    The `dry-run` subcommand carries the command-string preview for
    operators who want to see what would be run.
    """
    if not args:
        return {"error": "No package name provided"}
    pkg = _first_pkg_arg(args)
    if not pkg:
        return {"error": "No package name provided"}
    if not _pkg_name_ok(pkg):
        return {"error": f"invalid package name: {pkg!r}"}
    # _pkg_name_ok already rejects leading-dash/URL names (argument
    # injection), so no '--' end-of-options separator is needed here —
    # pacman in particular does not accept one.
    cmd = _mutation_cmd("install", pkg)
    if not cmd:
        return {"action": "install", "package": pkg, "manager": PKG_MANAGER,
                "success": False, "stderr": f"no install command for {PKG_MANAGER}"}
    # Actually run it. The cockpit bridge runs as the cockpit user; the
    # JS panel's cockpit.spawn(..., { superuser: 'try' }) makes cockpit
    # prompt the operator for auth and run us as root via polkit.
    r = subprocess.run(
        cmd, capture_output=True, text=True, check=False,
        timeout=600, env=SCRUBBED_ENV,
    )
    return {"action": "install", "package": pkg, "manager": PKG_MANAGER,
            "command": " ".join(cmd), "success": r.returncode == 0,
            "rc": r.returncode, "output": r.stdout, "stderr": r.stderr}


def remove(args: list[str]) -> dict[str, str]:
    """Remove a package — actually runs the package manager. See install()."""
    if not args:
        return {"error": "No package name provided"}
    pkg = _first_pkg_arg(args)
    if not pkg:
        return {"error": "No package name provided"}
    if not _pkg_name_ok(pkg):
        return {"error": f"invalid package name: {pkg!r}"}
    cmd = _mutation_cmd("remove", pkg)
    if not cmd:
        return {"action": "remove", "package": pkg, "manager": PKG_MANAGER,
                "success": False, "stderr": f"no remove command for {PKG_MANAGER}"}
    r = subprocess.run(
        cmd, capture_output=True, text=True, check=False,
        timeout=600, env=SCRUBBED_ENV,
    )
    return {"action": "remove", "package": pkg, "manager": PKG_MANAGER,
            "command": " ".join(cmd), "success": r.returncode == 0,
            "rc": r.returncode, "output": r.stdout, "stderr": r.stderr}


def update(args: list[str]) -> dict[str, str]:
    """Update a package — actually runs the package manager. See install()."""
    if not args:
        return {"error": "No package name provided"}
    pkg = _first_pkg_arg(args)
    if not pkg:
        return {"error": "No package name provided"}
    if not _pkg_name_ok(pkg):
        return {"error": f"invalid package name: {pkg!r}"}
    if PKG_MANAGER == "lunar":
        # Lunar rebuilds from source against the current moonbase; there
        # is no single-module update path distinct from install. Point
        # the operator at the real operation instead of approximating.
        return {"action": "update", "package": pkg, "manager": PKG_MANAGER,
                "success": False,
                "stderr": "lunar has no single-module update — run update-all (lunar update)"}
    cmd = _mutation_cmd("update", pkg)
    if not cmd:
        return {"action": "update", "package": pkg, "manager": PKG_MANAGER,
                "success": False, "stderr": f"no update command for {PKG_MANAGER}"}
    r = subprocess.run(
        cmd, capture_output=True, text=True, check=False,
        timeout=600, env=SCRUBBED_ENV,
    )
    return {"action": "update", "package": pkg, "manager": PKG_MANAGER,
            "command": " ".join(cmd), "success": r.returncode == 0,
            "rc": r.returncode, "output": r.stdout, "stderr": r.stderr}


def update_all() -> dict[str, str]:
    """Update all packages — actually runs the package manager.

    This is the method behind the Packages panel `Update All` button:
    the JS panel calls it with superuser: 'try', the bridge runs the
    real manager via subprocess, and the result carries the actual
    stdout/stderr for the panel to render live.
    """
    cmd = _mutation_cmd("update-all", "")
    if not cmd:
        return {"action": "update-all", "manager": PKG_MANAGER,
                "success": False, "stderr": f"no update-all command for {PKG_MANAGER}"}
    r = subprocess.run(
        cmd, capture_output=True, text=True, check=False,
        timeout=600, env=SCRUBBED_ENV,
    )
    return {"action": "update-all", "manager": PKG_MANAGER,
            "command": " ".join(cmd), "success": r.returncode == 0,
            "rc": r.returncode, "output": r.stdout, "stderr": r.stderr}


def dry_run(args: list[str]) -> dict[str, str]:
    """Return the command that *would* be run — for the operator preview.

    install/remove/update/update-all actually execute the package
    manager; this subcommand returns the command string without
    running it, so the JS panel can show a preview before the operator
    confirms.
    """
    action = args[0] if args else "update-all"
    pkg = args[1] if len(args) > 1 else ""
    cmd = _mutation_cmd(action, pkg)
    return {"action": action, "package": pkg, "manager": PKG_MANAGER,
            "command": " ".join(cmd) if cmd else ""}


def summary() -> dict[str, Any]:
    """Aggregate summary: installed count, update count, manager."""
    installed = list_installed()
    updates = list_updates()
    out: dict[str, Any] = {
        "manager": PKG_MANAGER,
        "installedCount": len(installed),
        "updateCount": len(updates),
        "updates": updates[:20],  # Cap at 20 for the summary view
    }
    if PKG_MANAGER == "lunar":
        out["updatesNote"] = ("lunar has no update-preview subcommand — "
                               "run lunar update to fetch + rebuild")
    return out


COMMANDS = {
    "list-installed": lambda _args: list_installed(),
    "list-updates": lambda _args: list_updates(),
    "search": lambda args: search(args),
    "info": lambda args: info(args),
    "install": lambda args: install(args),
    "remove": lambda args: remove(args),
    "update": lambda args: update(args),
    "update-all": lambda _args: update_all(),
    "dry-run": lambda args: dry_run(args),
    "summary": lambda _args: summary(),
}


def main(argv: list[str]) -> int:
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
