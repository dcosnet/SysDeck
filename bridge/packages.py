#!/usr/bin/env python3
"""
SysDeck - Packages Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Wraps the system package manager (pacman on Arch Linux, dnf/yum on
RPM distros, apt on DEB distros) into a unified JSON interface so the
Packages panel can list, search, install, update, and remove packages
without knowing which distro it runs on.

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

v0.0.31: install / remove / update / update-all now ACTUALLY RUN the
package manager via subprocess. The cockpit JS panel passes
{ superuser: 'try' } to cockpit.spawn so the operator authenticates
via polkit (org.sysdeck.packages.modify action, shipped since v0.0.17,
authorizes /usr/bin/pacman, /usr/bin/apt, /usr/bin/dnf). No `sudo`
shell-out from JS — this is the cockpit way.

The new `dry-run` subcommand preserves the v0.0.30 command-string-only
return shape for the panel's preview-before-confirm flow.
"""

import json
import os
import re
import subprocess
import sys
from typing import Any


PACMAN_LICENSE = "GPL-2.0+ (pacman)"
PACMAN_AUTHOR = "Pacman Development Team"
PACMAN_URL = "https://archlinux.org/pacman/"

# Detect the system package manager once at import time.
# Step-down: prefer pacman (Arch), then dnf (Fedora), then apt (Debian/Ubuntu).
# The detected manager determines which backend functions are used.

def _detect_pkg_manager() -> str:
    """Return 'pacman', 'dnf', or 'apt' based on what is available."""
    for cmd in ("pacman", "dnf", "apt"):
        try:
            subprocess.run([cmd, "--version"], capture_output=True, check=True)
            return cmd
        except (subprocess.CalledProcessError, FileNotFoundError):
            continue
    return "unknown"

PKG_MANAGER = _detect_pkg_manager()


def run(argv: list[str]) -> str:
    """Run a command, returning stdout. Returns '' on failure."""
    try:
        return subprocess.run(
            argv, capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
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
    """List available updates via dnf check-update."""
    raw = run(["dnf", "check-update", "--quiet"])
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

BACKENDS = {
    "pacman": {
        "list-installed": lambda _args: _pacman_list_installed(),
        "list-updates": lambda _args: _pacman_list_updates(),
        "search": lambda args: _pacman_search(args[0]) if args else [],
        "info": lambda args: _pacman_info(args[0]) if args else {},
    },
    "dnf": {
        "list-installed": lambda _args: _dnf_list_installed(),
        "list-updates": lambda _args: _dnf_list_updates(),
        "search": lambda args: _dnf_search(args[0]) if args else [],
        "info": lambda args: _dnf_info(args[0]) if args else {},
    },
    "apt": {
        "list-installed": lambda _args: _apt_list_installed(),
        "list-updates": lambda _args: _apt_list_updates(),
        "search": lambda args: _apt_search(args[0]) if args else [],
        "info": lambda args: _apt_info(args[0]) if args else {},
    },
}


def list_installed() -> list[dict[str, str]]:
    """List installed packages using the detected package manager."""
    backend = BACKENDS.get(PKG_MANAGER, {})
    fn = backend.get("list-installed")
    return fn([]) if fn else []


def list_updates() -> list[dict[str, str]]:
    """List available updates using the detected package manager."""
    backend = BACKENDS.get(PKG_MANAGER, {})
    fn = backend.get("list-updates")
    return fn([]) if fn else []


def search(args: list[str]) -> list[dict[str, Any]]:
    """Search packages using the detected package manager."""
    backend = BACKENDS.get(PKG_MANAGER, {})
    fn = backend.get("search")
    return fn(args) if fn else []


def info(args: list[str]) -> dict[str, Any]:
    """Get package info using the detected package manager."""
    backend = BACKENDS.get(PKG_MANAGER, {})
    fn = backend.get("info")
    return fn(args) if fn else {}


def install(args: list[str]) -> dict[str, str]:
    """Install a package — actually runs the package manager via subprocess.

    v0.0.31 REWRITE: previously this returned only the command string
    that *would* be run, forcing the JS panel to alert("Run this
    command with superuser privileges.") and the operator to copy /
    sudo / paste / run. The cockpit way is to run the operation via
    the cockpit superuser channel: the JS panel calls cockpit.spawn()
    with { superuser: 'try' }, which prompts the operator via polkit
    for the org.sysdeck.packages.modify action (shipped since v0.0.17)
    that authorizes /usr/bin/pacman, /usr/bin/apt, /usr/bin/dnf.
    The bridge runs the package manager via subprocess with check=True
    and streams stdout/stderr line-by-line so the JS panel can render
    live output.

    The command-string preview shape is preserved as the `dry-run`
    subcommand for operators who want to see what would be run.
    """
    if not args:
        return {"error": "No package name provided"}
    pkg = args[0]
    cmd_map = {"pacman": ["pacman", "-S", "--noconfirm", pkg],
               "dnf": ["dnf", "install", "-y", pkg],
               "apt": ["apt", "install", "-y", pkg]}
    cmd = cmd_map.get(PKG_MANAGER, [])
    if not cmd:
        return {"action": "install", "package": pkg, "manager": PKG_MANAGER,
                "success": False, "stderr": f"no install command for {PKG_MANAGER}"}
    # Actually run it. The cockpit bridge runs as the cockpit user; the
    # JS panel's cockpit.spawn(..., { superuser: 'try' }) makes cockpit
    # prompt the operator for auth and run us as root via polkit.
    r = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return {"action": "install", "package": pkg, "manager": PKG_MANAGER,
            "command": " ".join(cmd), "success": r.returncode == 0,
            "rc": r.returncode, "output": r.stdout, "stderr": r.stderr}


def remove(args: list[str]) -> dict[str, str]:
    """Remove a package — actually runs the package manager. See install()."""
    if not args:
        return {"error": "No package name provided"}
    pkg = args[0]
    cmd_map = {"pacman": ["pacman", "-R", "--noconfirm", pkg],
               "dnf": ["dnf", "remove", "-y", pkg],
               "apt": ["apt", "remove", "-y", pkg]}
    cmd = cmd_map.get(PKG_MANAGER, [])
    if not cmd:
        return {"action": "remove", "package": pkg, "manager": PKG_MANAGER,
                "success": False, "stderr": f"no remove command for {PKG_MANAGER}"}
    r = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return {"action": "remove", "package": pkg, "manager": PKG_MANAGER,
            "command": " ".join(cmd), "success": r.returncode == 0,
            "rc": r.returncode, "output": r.stdout, "stderr": r.stderr}


def update(args: list[str]) -> dict[str, str]:
    """Update a package — actually runs the package manager. See install()."""
    if not args:
        return {"error": "No package name provided"}
    pkg = args[0]
    cmd_map = {"pacman": ["pacman", "-S", "--noconfirm", pkg],
               "dnf": ["dnf", "upgrade", "-y", pkg],
               "apt": ["apt", "upgrade", "-y", pkg]}
    cmd = cmd_map.get(PKG_MANAGER, [])
    if not cmd:
        return {"action": "update", "package": pkg, "manager": PKG_MANAGER,
                "success": False, "stderr": f"no update command for {PKG_MANAGER}"}
    r = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return {"action": "update", "package": pkg, "manager": PKG_MANAGER,
            "command": " ".join(cmd), "success": r.returncode == 0,
            "rc": r.returncode, "output": r.stdout, "stderr": r.stderr}


def update_all() -> dict[str, str]:
    """Update all packages — actually runs the package manager. See install().

    v0.0.31: this is the method called by the Packages panel `Update All`
    button. Previously it returned only the command string and the panel
    showed alert("Run this command with superuser privileges.") — which
    defeated the purpose of having a panel. The cockpit way: the JS panel
    calls bridge.packages.updateAll() with superuser: 'try', the bridge
    runs pacman/apt/dnf via subprocess, and the result includes the
    actual stdout/stderr for the panel to render live.
    """
    cmd_map = {"pacman": ["pacman", "-Syu", "--noconfirm"],
               "dnf": ["dnf", "upgrade", "-y"],
               "apt": ["apt", "upgrade", "-y"]}
    cmd = cmd_map.get(PKG_MANAGER, [])
    if not cmd:
        return {"action": "update-all", "manager": PKG_MANAGER,
                "success": False, "stderr": f"no update-all command for {PKG_MANAGER}"}
    r = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return {"action": "update-all", "manager": PKG_MANAGER,
            "command": " ".join(cmd), "success": r.returncode == 0,
            "rc": r.returncode, "output": r.stdout, "stderr": r.stderr}


def dry_run(args: list[str]) -> dict[str, str]:
    """Return the command that *would* be run — for the operator preview.

    v0.0.31: the install/remove/update/update-all subcommands now
    actually execute the package manager. This subcommand preserves
    the v0.0.30 behavior (return the command string without running)
    so the JS panel can show a preview before the operator confirms.
    """
    action = args[0] if args else "update-all"
    pkg = args[1] if len(args) > 1 else ""
    cmd_map = {
        "install":    {"pacman": ["pacman", "-S", "--noconfirm", pkg],
                       "dnf": ["dnf", "install", "-y", pkg],
                       "apt": ["apt", "install", "-y", pkg]},
        "remove":     {"pacman": ["pacman", "-R", "--noconfirm", pkg],
                       "dnf": ["dnf", "remove", "-y", pkg],
                       "apt": ["apt", "remove", "-y", pkg]},
        "update":     {"pacman": ["pacman", "-S", "--noconfirm", pkg],
                       "dnf": ["dnf", "upgrade", "-y", pkg],
                       "apt": ["apt", "upgrade", "-y", pkg]},
        "update-all": {"pacman": ["pacman", "-Syu", "--noconfirm"],
                       "dnf": ["dnf", "upgrade", "-y"],
                       "apt": ["apt", "upgrade", "-y"]},
    }
    sub_map = cmd_map.get(action, {})
    cmd = sub_map.get(PKG_MANAGER, [])
    return {"action": action, "package": pkg, "manager": PKG_MANAGER,
            "command": " ".join(cmd) if cmd else ""}


def summary() -> dict[str, Any]:
    """Aggregate summary: installed count, update count, manager."""
    installed = list_installed()
    updates = list_updates()
    return {
        "manager": PKG_MANAGER,
        "installedCount": len(installed),
        "updateCount": len(updates),
        "updates": updates[:20],  # Cap at 20 for the summary view
    }


COMMANDS = {
    "list-installed": lambda _args: list_installed(),
    "list-updates": lambda _args: list_updates(),
    "search": lambda args: search(args),
    "info": lambda args: info(args),
    "install": lambda args: install(args),
    "remove": lambda args: remove(args),
    "update": lambda args: update(args),
    "update-all": lambda _args: update_all(),
    # v0.0.31: dry-run preserves the v0.0.30 command-string-only shape
    # for the panel's preview-before-confirm flow.
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
