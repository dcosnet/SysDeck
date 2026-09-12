"""
SysDeck - Python Bridge Helpers
Author: Jeremy Anderson (https://dcos.net)

This package contains helper scripts invoked from the JS bridge client
via cockpit.spawn. Each module is standalone and runnable as a CLI:

    python3 /usr/lib/sysdeck/bridge/containers.py list

(v0.0.26+ invocation: absolute path, no PYTHONPATH, no -m flag.
 The earlier `python3 -m sysdeck.bridge.containers` pattern was broken —
 it required a nested Python package layout (sysdeck/bridge/containers.py)
 that the Makefile install target never produced. bridge.js calls each
 helper by absolute path.)

The helpers exist for operations that are too complex for a single CLI
call — e.g. cross-referencing podman and systemd, or aggregating TPM
PCR banks into a single JSON document.
"""

import os
import subprocess
from typing import Literal

__version__ = "0.4.1"
__author__ = "Jeremy Anderson"
__url__ = "https://dcos.net"


# ── Distro detection ────────────────────────────────────────────────
#
# Step-down: check /etc/os-release (standard across all modern distros),
# then fall back to checking which package manager is available.
# Returns a normalized distro identifier for use in dispatch tables.

DistroId = Literal["arch", "debian", "fedora", "rhel", "unknown"]


def detect_distro() -> DistroId:
    """Detect the running Linux distribution.

    Priority order:
      1. Parse /etc/os-release ID/ID_LIKE fields.
      2. Fall back to package-manager presence (pacman → arch,
         apt → debian, dnf → fedora).

    Returns one of: 'arch', 'debian', 'fedora', 'rhel', 'unknown'.
    """
    # Try /etc/os-release first (present on all modern distros).
    try:
        with open("/etc/os-release", encoding="utf-8") as fh:
            os_release = dict(
                line.split("=", 1) if "=" in line else ("", "")
                for line in fh
                if "=" in line
            )
        dist_id = os_release.get("ID", "").strip().strip('"').lower()
        id_like = os_release.get("ID_LIKE", "").strip().strip('"').lower()

        # Direct match on ID.
        id_map = {"arch": "arch", "archlinux": "arch",
                  "debian": "debian", "ubuntu": "debian", "linuxmint": "debian", "pop": "debian",
                  "fedora": "fedora", "rhel": "rhel", "centos": "rhel", "rocky": "rhel", "alma": "rhel"}
        if dist_id in id_map:
            return id_map[dist_id]

        # Fall back to ID_LIKE.
        for like in id_like.split():
            if like in id_map:
                return id_map[like]
    except (FileNotFoundError, PermissionError):
        pass

    # Fall back to package manager presence.
    for cmd, distro in [("pacman", "arch"), ("apt", "debian"), ("dnf", "fedora")]:
        try:
            subprocess.run([cmd, "--version"], capture_output=True, check=True)
            return distro
        except (subprocess.CalledProcessError, FileNotFoundError):
            continue

    return "unknown"


# Detect once at import time — shared across all bridge modules.
DISTRO: DistroId = detect_distro()


# ── Package manager detection ───────────────────────────────────────
#
# Returns the command name for the system's package manager.
# Arch → pacman, Debian → apt, Fedora/RHEL → dnf.

PkgManager = Literal["pacman", "apt", "dnf", "unknown"]


def detect_pkg_manager() -> PkgManager:
    """Detect the system package manager based on distro."""
    pkg_map: dict[DistroId, PkgManager] = {
        "arch": "pacman",
        "debian": "apt",
        "fedora": "dnf",
        "rhel": "dnf",
    }
    return pkg_map.get(DISTRO, "unknown")


PKG_MANAGER: PkgManager = detect_pkg_manager()


# ── Service management ──────────────────────────────────────────────
#
# All three target distros use systemd, so this is uniform.
# Kept here for documentation and future extension (e.g. openrc on Artix).

def service_cmd(action: str, unit: str) -> list[str]:
    """Build a systemctl command. All supported distros use systemd."""
    return ["systemctl", action, unit]
