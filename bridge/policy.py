#!/usr/bin/env python3
"""
SysDeck - Policy & Permissions Bridge
Author: Jeremy Anderson (https://dcos.net)

v0.0.32 NEW MODULE — modern policy management and permissions
manager for groups. The user directive:

  "modern policy management and permissions manager for groups.
   such as acl, cgroups, vlans, ebpf namespace separation and
   related policies. we can skip selinux its native. we can
   implement apparmor but its not default on my machine so make
   it optional for sure."

This bridge surfaces five concerns, each with its own subcommand
namespace. SELinux is skipped (the user has it natively). AppArmor
is optional — the bridge auto-detects whether it is compiled into
the kernel and active; if not, the apparmor subcommands return
{available: false, reason: "..."} and the panel renders an install
hint instead of an empty table.

Subcommands:
  summary               — one-shot overview of all five concerns
  acl-list <path>       — list POSIX ACLs on a file/dir (getfacl -p)
  acl-set <path> <entry> — add/replace one ACL entry (setfacl -m)
  acl-remove <path> <entry> — remove one ACL entry (setfacl -x)
  acl-default <path> <entry> — set default ACL for new files in dir
  cgroup-list            — list cgroups v2 unified hierarchy
  cgroup-show <path>     — show one cgroup's controllers + processes
  cgroup-procs <path>    — list PIDs in a cgroup
  cgroup-create <path>   — mkdir a new cgroup
  cgroup-move <pid> <path> — write a PID into a cgroup's cgroup.procs
  cgroup-set <path> <ctrl> <value> — write a control file
  vlan-list              — list VLANs on host interfaces (ip -d link)
  vlan-show <iface>      — show one interface's VLAN info
  vlan-create <iface> <vid> — create a VLAN on an interface
  vlan-delete <iface> <vid> — delete a VLAN
  ebpf-list              — list loaded BPF programs (bpftool prog show)
  ebpf-show <id>         — show one BPF program's metadata + maps
  ebpf-maps              — list BPF maps (bpftool map show)
  ebpf-pin <id> <path>   — pin a BPF program to a bpffs path
  ns-list                — list namespaces on the host (lsns)
  ns-show <nsid>         — show one namespace's processes
  apparmor-status        — show AppArmor enforcement state (aa-status)
  apparmor-profiles      — list loaded AppArmor profiles
  apparmor-enforce <profile> — switch a profile to enforce mode
  apparmor-complain <profile> — switch a profile to complain mode

Cockpit way (per v0.0.31 pattern): mutating ops run via subprocess
in this bridge; the JS panel passes { superuser: 'try' } to
cockpit.spawn so the cockpit bridge prompts the operator via polkit
for the org.sysdeck.policy.modify action (added in this release —
authorizes /usr/bin/setfacl, /usr/bin/getfacl, /bin/mkdir, /bin/mount,
/usr/bin/ip, /usr/sbin/ip, /usr/bin/vlan, /usr/bin/bpftool,
/usr/sbin/bpftool, /usr/bin/aa-enforce, /usr/bin/aa-complain,
/usr/bin/lsns). No `sudo` shell-out from JS — the bridge runs as
the cockpit user and gets root privileges via polkit when the
operator authenticates.

Usage:
    python3 /usr/lib/sysdeck/bridge/policy.py summary
    python3 /usr/lib/sysdeck/bridge/policy.py acl-list /var/www
    python3 /usr/lib/sysdeck/bridge/policy.py cgroup-list
    python3 /usr/lib/sysdeck/bridge/policy.py vlan-list
    python3 /usr/lib/sysdeck/bridge/policy.py ebpf-list
    python3 /usr/lib/sysdeck/bridge/policy.py apparmor-status
"""

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


# ── Subprocess helper ────────────────────────────────────────────────
#
# _run() never raises — every caller gets (rc, stdout, stderr) back.
# Failures are surfaced in the JSON response so the JS panel can show
# the operator what went wrong rather than the cockpit spawn channel
# throwing an unhandled exception.


def _run(cmd: list[str], timeout: int = 15) -> tuple[int, str, str]:
    """Run cmd, return (rc, stdout, stderr). Never raises."""
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, check=False, timeout=timeout,
        )
        return r.returncode, r.stdout or "", r.stderr or ""
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return 127, "", str(exc)


def _have(binary: str) -> bool:
    """True if binary is on PATH."""
    return shutil.which(binary) is not None


# ── ACLs ─────────────────────────────────────────────────────────────
#
# POSIX ACLs extend the traditional unix permission model with
# per-user and per-group entries. getfacl/setfacl are the standard
# tools (provided by the 'acl' package on Arch/Debian). On most
# modern filesystems (ext4, xfs, btrfs) ACLs are enabled by default.
#
# The bridge deliberately does NOT validate paths — setfacl will
# reject bad paths with a clear error message, which the bridge
# surfaces in the JSON response. Operators are responsible for
# typing correct paths; the panel can offer a path picker for
# common directories (/var/www, /home, /etc, etc.) but the bridge
# treats paths as opaque strings.

ACL_ENTRY_RE = re.compile(
    r"^(?P<kind>default:)?(?P<who>user|group|other|mask):(?:[^:]+:)?"  # default: | user: | group: | other: | mask:
    r"(?P<perms>[r-][w-][x-])$"
)


def _acl_binary() -> str:
    """Return 'getfacl' / 'setfacl' if available, else ''."""
    return shutil.which("getfacl") or shutil.which("setfacl") or ""


def cmd_acl_list(args: list[str]) -> dict[str, Any]:
    """List POSIX ACLs on a path (getfacl -p <path>)."""
    if not args:
        return {"error": "path required"}
    path = args[0]
    if not _have("getfacl"):
        return {"available": False, "reason": "getfacl not installed",
                "install": "pacman -S acl  # Arch\\napart install acl  # Debian"}
    if not os.path.exists(path):
        return {"error": f"path {path} does not exist"}
    rc, out, err = _run(["getfacl", "-p", path])
    # Parse the output into structured entries.
    entries: list[dict[str, str]] = []
    base_perms = ""
    for line in out.splitlines():
        if not line or line.startswith("#"):
            # Capture the file-level perms as a separate field.
            if line.startswith("# file:"):
                pass
            elif line.startswith("# owner:"):
                base_perms += f"owner={line.split(':', 1)[1].strip()} "
            elif line.startswith("# group:"):
                base_perms += f"group={line.split(':', 1)[1].strip()} "
            continue
        # Real ACL entry: user:foo:rwx, group:bar:r-x, mask::rwx, other::r--,
        # default:user:foo:rwx
        parts = line.split(":")
        if len(parts) >= 3:
            entry = {
                "raw": line,
                "default": parts[0] == "default",
                "kind": parts[1] if parts[0] != "default" else parts[1],
                "name": parts[2] if len(parts) > 3 else "",
                "perms": parts[-1],
            }
            entries.append(entry)
    return {
        "available": True,
        "path": path,
        "entries": entries,
        "base": base_perms.strip(),
        "raw": out,
        "stderr": err.strip(),
    }


def cmd_acl_set(args: list[str]) -> dict[str, Any]:
    """Add or replace an ACL entry on a path (setfacl -m)."""
    if len(args) < 2:
        return {"error": "usage: acl-set <path> <entry>  (e.g. acl-set /var/www group:www-data:rwx)"}
    path, entry = args[0], args[1]
    if not _have("setfacl"):
        return {"available": False, "reason": "setfacl not installed"}
    if not os.path.exists(path):
        return {"error": f"path {path} does not exist"}
    rc, out, err = _run(["setfacl", "-m", entry, path])
    return {
        "applied": rc == 0,
        "path": path,
        "entry": entry,
        "rc": rc,
        "stderr": err.strip(),
    }


def cmd_acl_remove(args: list[str]) -> dict[str, Any]:
    """Remove an ACL entry from a path (setfacl -x)."""
    if len(args) < 2:
        return {"error": "usage: acl-remove <path> <entry>"}
    path, entry = args[0], args[1]
    if not _have("setfacl"):
        return {"available": False, "reason": "setfacl not installed"}
    rc, _, err = _run(["setfacl", "-x", entry, path])
    return {
        "removed": rc == 0,
        "path": path,
        "entry": entry,
        "rc": rc,
        "stderr": err.strip(),
    }


def cmd_acl_default(args: list[str]) -> dict[str, Any]:
    """Set a default ACL on a directory (setfacl -d -m).

    Default ACLs are inherited by new files in the directory.
    """
    if len(args) < 2:
        return {"error": "usage: acl-default <path> <entry>  (e.g. acl-default /var/www group:www-data:r-x)"}
    path, entry = args[0], args[1]
    if not _have("setfacl"):
        return {"available": False, "reason": "setfacl not installed"}
    if not os.path.isdir(path):
        return {"error": f"path {path} is not a directory (default ACLs require a directory)"}
    rc, _, err = _run(["setfacl", "-d", "-m", entry, path])
    return {
        "applied": rc == 0,
        "path": path,
        "entry": entry,
        "rc": rc,
        "stderr": err.strip(),
    }


# ── cgroups v2 unified hierarchy ──────────────────────────────────
#
# cgroups v2 (the unified hierarchy) lives at /sys/fs/cgroup/. Each
# cgroup is a directory containing cgroup.procs, cgroup.controllers,
# and per-controller files (memory.max, cpu.weight, io.max, etc.).
#
# v0.0.32 expects the host to be running cgroups v2 (the default on
# Arch, Debian 12+, and Fedora 31+). If the host is on v1 only, the
# cgroup-list subcommand returns {available: false, reason: "cgroups
# v2 not mounted at /sys/fs/cgroup/"}.


CGROUP_ROOT = Path("/sys/fs/cgroup")


def _cgroup_v2_available() -> bool:
    """True if /sys/fs/cgroup/ is a cgroups v2 unified hierarchy."""
    return (CGROUP_ROOT / "cgroup.controllers").is_file()


def _walk_cgroups(root: Path, max_depth: int = 3, _depth: int = 0) -> list[dict[str, Any]]:
    """Walk cgroup tree under root, return list of {path, controllers, procs}."""
    out: list[dict[str, Any]] = []
    if not root.is_dir():
        return out
    controllers_file = root / "cgroup.controllers"
    controllers = ""
    if controllers_file.is_file():
        try:
            controllers = controllers_file.read_text(encoding="utf-8").strip()
        except (PermissionError, OSError):
            pass
    procs_file = root / "cgroup.procs"
    proc_count = 0
    if procs_file.is_file():
        try:
            proc_count = sum(1 for _ in procs_file.read_text(encoding="utf-8").splitlines() if _.strip())
        except (PermissionError, OSError):
            pass
    subtree = ""
    subtree_file = root / "cgroup.subtree_control"
    if subtree_file.is_file():
        try:
            subtree = subtree_file.read_text(encoding="utf-8").strip()
        except (PermissionError, OSError):
            pass
    out.append({
        "path": str(root),
        "name": root.name or "/",
        "controllers": controllers,
        "subtree_control": subtree,
        "proc_count": proc_count,
        "depth": _depth,
    })
    if _depth >= max_depth:
        return out
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        if child.name.startswith("cgroup."):
            continue
        out.extend(_walk_cgroups(child, max_depth, _depth + 1))
    return out


def cmd_cgroup_list(_args: list[str]) -> dict[str, Any]:
    """List cgroups v2 unified hierarchy."""
    if not _cgroup_v2_available():
        return {
            "available": False,
            "reason": "cgroups v2 not mounted at /sys/fs/cgroup/",
            "hint": "modern Arch/Debian/Fedora systems default to cgroups v2.",
        }
    return {
        "available": True,
        "root": str(CGROUP_ROOT),
        "cgroups": _walk_cgroups(CGROUP_ROOT, max_depth=3),
    }


def cmd_cgroup_show(args: list[str]) -> dict[str, Any]:
    """Show one cgroup's controllers + processes."""
    if not args:
        return {"error": "cgroup path required"}
    path = Path(args[0])
    if not path.is_dir():
        return {"error": f"{path} is not a directory"}
    info: dict[str, Any] = {"path": str(path), "name": path.name}
    for fname in ("cgroup.controllers", "cgroup.subtree_control",
                  "cgroup.procs", "memory.max", "memory.current",
                  "cpu.weight", "cpu.max", "io.max", "pids.max", "pids.current"):
        f = path / fname
        if f.is_file():
            try:
                val = f.read_text(encoding="utf-8").strip()
                info[fname.replace(".", "_")] = val
            except (PermissionError, OSError):
                pass
    # List processes (first 50 to cap response size).
    procs_file = path / "cgroup.procs"
    procs: list[dict[str, str]] = []
    if procs_file.is_file():
        try:
            for line in procs_file.read_text(encoding="utf-8").splitlines():
                pid = line.strip()
                if not pid:
                    continue
                # Get process name via /proc/<pid>/comm
                try:
                    comm = (Path("/proc") / pid / "comm").read_text(encoding="utf-8").strip()
                except (FileNotFoundError, PermissionError, OSError):
                    comm = ""
                procs.append({"pid": pid, "comm": comm})
                if len(procs) >= 50:
                    break
        except (PermissionError, OSError):
            pass
    info["processes"] = procs
    info["process_count_truncated"] = len(procs) >= 50
    return info


def cmd_cgroup_procs(args: list[str]) -> dict[str, Any]:
    """List PIDs in a cgroup (just the PIDs, no metadata)."""
    if not args:
        return {"error": "cgroup path required"}
    procs_file = Path(args[0]) / "cgroup.procs"
    if not procs_file.is_file():
        return {"error": f"{procs_file} not found"}
    try:
        pids = [p.strip() for p in procs_file.read_text(encoding="utf-8").splitlines() if p.strip()]
    except (PermissionError, OSError) as exc:
        return {"error": str(exc)}
    return {"path": args[0], "pids": pids, "count": len(pids)}


def cmd_cgroup_create(args: list[str]) -> dict[str, Any]:
    """Create a new cgroup by mkdir."""
    if not args:
        return {"error": "cgroup path required"}
    path = Path(args[0])
    if not _cgroup_v2_available():
        return {"available": False, "reason": "cgroups v2 not mounted"}
    if not str(path).startswith(str(CGROUP_ROOT)):
        return {"error": f"cgroup path must be under {CGROUP_ROOT}"}
    try:
        path.mkdir(parents=True, exist_ok=False)
        return {"created": True, "path": str(path)}
    except FileExistsError:
        return {"created": False, "error": f"{path} already exists"}
    except (PermissionError, OSError) as exc:
        return {"created": False, "error": str(exc),
                "hint": "run via cockpit superuser channel (polkit org.sysdeck.policy.modify)"}


def cmd_cgroup_move(args: list[str]) -> dict[str, Any]:
    """Move a PID into a cgroup (write to cgroup.procs)."""
    if len(args) < 2:
        return {"error": "usage: cgroup-move <pid> <cgroup-path>"}
    pid, cgrp = args[0], args[1]
    procs_file = Path(cgrp) / "cgroup.procs"
    if not procs_file.is_file():
        return {"error": f"{procs_file} not found"}
    try:
        with procs_file.open("a", encoding="utf-8") as fh:
            fh.write(pid + "\n")
        return {"moved": True, "pid": pid, "cgroup": cgrp}
    except (PermissionError, OSError) as exc:
        return {"moved": False, "error": str(exc),
                "hint": "run via cockpit superuser channel (polkit org.sysdeck.policy.modify)"}


def cmd_cgroup_set(args: list[str]) -> dict[str, Any]:
    """Write a value to a cgroup control file."""
    if len(args) < 3:
        return {"error": "usage: cgroup-set <path> <control-file> <value>"}
    path, control, value = args[0], args[1], args[2]
    # control is a filename like 'memory.max' or 'cpu.weight'
    target = Path(path) / control
    if not target.parent.is_dir():
        return {"error": f"cgroup {path} does not exist"}
    try:
        target.write_text(value, encoding="utf-8")
        return {"set": True, "path": str(target), "value": value}
    except (PermissionError, OSError) as exc:
        return {"set": False, "error": str(exc),
                "hint": "run via cockpit superuser channel (polkit org.sysdeck.policy.modify)"}


# ── VLANs ────────────────────────────────────────────────────────────
#
# VLANs are managed via the `ip` command (iproute2). The bridge uses
# `ip -d link show` to enumerate, `ip link add link <iface> name
# <iface>.<vid> type vlan id <vid>` to create, and `ip link del` to
# delete. iproute2 is universally installed on Arch/Debian/Fedora.

VLAN_RE = re.compile(r"vlan id (\d+) .* protocol (\S+)")


def cmd_vlan_list(_args: list[str]) -> dict[str, Any]:
    """List VLANs on host interfaces (ip -d link show)."""
    if not _have("ip"):
        return {"available": False, "reason": "ip (iproute2) not installed"}
    rc, out, _ = _run(["ip", "-d", "link", "show"])
    vlans: list[dict[str, Any]] = []
    current_iface = ""
    for line in out.splitlines():
        m = re.match(r"^\d+:\s+(\S+):", line)
        if m:
            current_iface = m.group(1).rstrip("@")
            # Check if this line itself contains vlan info.
            if "vlan id" in line:
                vm = VLAN_RE.search(line)
                if vm:
                    vlans.append({"interface": current_iface, "vid": int(vm.group(1)),
                                  "protocol": vm.group(2)})
        elif "vlan id" in line and current_iface:
            vm = VLAN_RE.search(line)
            if vm:
                vlans.append({"interface": current_iface, "vid": int(vm.group(1)),
                              "protocol": vm.group(2)})
    return {
        "available": True,
        "vlans": vlans,
        "count": len(vlans),
    }


def cmd_vlan_show(args: list[str]) -> dict[str, Any]:
    """Show one interface's VLAN info."""
    if not args:
        return {"error": "interface name required"}
    iface = args[0]
    if not _have("ip"):
        return {"available": False, "reason": "ip (iproute2) not installed"}
    rc, out, _ = _run(["ip", "-d", "link", "show", iface])
    return {
        "interface": iface,
        "raw": out,
        "is_vlan": "vlan id" in out,
    }


def cmd_vlan_create(args: list[str]) -> dict[str, Any]:
    """Create a VLAN on an interface."""
    if len(args) < 2:
        return {"error": "usage: vlan-create <iface> <vid>"}
    iface, vid = args[0], args[1]
    if not _have("ip"):
        return {"available": False, "reason": "ip (iproute2) not installed"}
    # Validate vid is 1-4094
    try:
        vid_n = int(vid)
        if vid_n < 1 or vid_n > 4094:
            return {"error": f"vid {vid} out of range (1-4094)"}
    except ValueError:
        return {"error": f"vid {vid} is not numeric"}
    subif = f"{iface}.{vid}"
    rc, _, err = _run(["ip", "link", "add", "link", iface, "name", subif,
                       "type", "vlan", "id", vid])
    if rc != 0:
        return {"created": False, "rc": rc, "stderr": err.strip(),
                "hint": "run via cockpit superuser channel (polkit org.sysdeck.policy.modify)"}
    # Bring up the sub-interface.
    _run(["ip", "link", "set", subif, "up"])
    return {"created": True, "interface": subif, "parent": iface, "vid": vid_n}


def cmd_vlan_delete(args: list[str]) -> dict[str, Any]:
    """Delete a VLAN sub-interface."""
    if len(args) < 2:
        return {"error": "usage: vlan-delete <iface> <vid>"}
    iface, vid = args[0], args[1]
    if not _have("ip"):
        return {"available": False, "reason": "ip (iproute2) not installed"}
    subif = f"{iface}.{vid}"
    rc, _, err = _run(["ip", "link", "del", subif])
    return {
        "deleted": rc == 0,
        "interface": subif,
        "rc": rc,
        "stderr": err.strip(),
    }


# ── eBPF + namespaces ───────────────────────────────────────────────
#
# eBPF programs are managed via bpftool (provided by 'bpftool' on Arch
# and 'linux-tools' / 'linux-tools-common' on Debian). Namespaces are
# enumerated via lsns (util-linux — universally installed).

def cmd_ebpf_list(_args: list[str]) -> dict[str, Any]:
    """List loaded BPF programs (bpftool prog show -j)."""
    bpftool = shutil.which("bpftool")
    if not bpftool:
        return {"available": False, "reason": "bpftool not installed",
                "install": "pacman -S bpftool  # Arch\\napart install linux-tools-common  # Debian"}
    # Try JSON output first (more structured).
    rc, out, err = _run([bpftool, "prog", "show", "-j"])
    if rc == 0 and out.strip():
        try:
            progs = json.loads(out)
            return {"available": True, "programs": progs, "format": "json"}
        except json.JSONDecodeError:
            pass
    # Fall back to plain text.
    rc2, out2, _ = _run([bpftool, "prog", "show"])
    return {"available": True, "raw": out2, "format": "text"}


def cmd_ebpf_show(args: list[str]) -> dict[str, Any]:
    """Show one BPF program's metadata + maps."""
    if not args:
        return {"error": "program id required"}
    pid = args[0]
    bpftool = shutil.which("bpftool")
    if not bpftool:
        return {"available": False, "reason": "bpftool not installed"}
    rc, out, _ = _run([bpftool, "prog", "show", "id", pid, "-j"])
    if rc == 0 and out.strip():
        try:
            info = json.loads(out)
            # Also fetch the program's maps.
            rc2, out2, _ = _run([bpftool, "prog", "show", "id", pid, "-m"])
            return {"available": True, "info": info, "maps_raw": out2}
        except json.JSONDecodeError:
            pass
    # Fall back to plain text.
    rc2, out2, _ = _run([bpftool, "prog", "show", "id", pid])
    return {"available": True, "raw": out2, "id": pid}


def cmd_ebpf_maps(_args: list[str]) -> dict[str, Any]:
    """List BPF maps (bpftool map show -j)."""
    bpftool = shutil.which("bpftool")
    if not bpftool:
        return {"available": False, "reason": "bpftool not installed"}
    rc, out, _ = _run([bpftool, "map", "show", "-j"])
    if rc == 0 and out.strip():
        try:
            maps = json.loads(out)
            return {"available": True, "maps": maps, "format": "json"}
        except json.JSONDecodeError:
            pass
    rc2, out2, _ = _run([bpftool, "map", "show"])
    return {"available": True, "raw": out2, "format": "text"}


def cmd_ebpf_pin(args: list[str]) -> dict[str, Any]:
    """Pin a BPF program to a bpffs path (bpftool prog pin)."""
    if len(args) < 2:
        return {"error": "usage: ebpf-pin <prog-id> <path>"}
    prog_id, pin_path = args[0], args[1]
    bpftool = shutil.which("bpftool")
    if not bpftool:
        return {"available": False, "reason": "bpftool not installed"}
    # bpffs typically mounted at /sys/fs/bpf/.
    rc, _, err = _run([bpftool, "prog", "pin", "id", prog_id, pin_path])
    return {
        "pinned": rc == 0,
        "prog_id": prog_id,
        "path": pin_path,
        "rc": rc,
        "stderr": err.strip(),
    }


def cmd_ns_list(_args: list[str]) -> dict[str, Any]:
    """List namespaces on the host (lsns -J)."""
    lsns = shutil.which("lsns")
    if not lsns:
        return {"available": False, "reason": "lsns (util-linux) not installed"}
    rc, out, _ = _run([lsns, "-J"])
    if rc == 0 and out.strip():
        try:
            data = json.loads(out)
            return {"available": True, "namespaces": data.get("namespaces", []),
                    "format": "json"}
        except json.JSONDecodeError:
            pass
    rc2, out2, _ = _run([lsns])
    return {"available": True, "raw": out2, "format": "text"}


def cmd_ns_show(args: list[str]) -> dict[str, Any]:
    """Show one namespace's processes (lsns -p <nsid>)."""
    if not args:
        return {"error": "namespace id required"}
    nsid = args[0]
    lsns = shutil.which("lsns")
    if not lsns:
        return {"available": False, "reason": "lsns (util-linux) not installed"}
    rc, out, _ = _run([lsns, "-J", "-t", nsid])
    if rc == 0 and out.strip():
        try:
            data = json.loads(out)
            return {"available": True, "info": data, "format": "json"}
        except json.JSONDecodeError:
            pass
    rc2, out2, _ = _run([lsns, "-t", nsid])
    return {"available": True, "raw": out2, "format": "text"}


# ── AppArmor (optional) ──────────────────────────────────────────────
#
# AppArmor is a Linux MAC (mandatory access control) system. The
# user said "we can implement apparmor but its not default on my
# machine so make it optional for sure." The bridge auto-detects
# AppArmor via /sys/kernel/security/apparmor/. If the directory
# doesn't exist, apparmor-status returns {available: false, reason:
# "AppArmor not compiled into kernel"} and the panel renders an
# install hint. aa-status is the canonical probe; aa-enforce and
# aa-complain switch profile modes.


def _apparmor_available() -> bool:
    """True if AppArmor is compiled into the kernel and active."""
    return Path("/sys/kernel/security/apparmor").is_dir()


def cmd_apparmor_status(_args: list[str]) -> dict[str, Any]:
    """Show AppArmor enforcement state (aa-status --json)."""
    if not _apparmor_available():
        return {
            "available": False,
            "reason": "AppArmor not compiled into kernel (or securityfs not mounted)",
            "install_arch": "AppArmor is built into the kernel; the 'apparmor' package provides userspace tools (aa-status, aa-enforce, aa-complain)",
            "install_debian": "apt install apparmor apparmor-utils",
            "note": "AppArmor is optional in SysDeck — the panel renders an install hint when absent.",
        }
    aa_status = shutil.which("aa-status")
    if not aa_status:
        return {
            "available": True,
            "kernel_active": True,
            "reason": "AppArmor kernel is active but aa-status not installed (install apparmor-utils)",
            "install_arch": "pacman -S apparmor",
            "install_debian": "apt install apparmor-utils",
        }
    rc, out, err = _run([aa_status, "--json"])
    if rc == 0 and out.strip():
        try:
            return {"available": True, "kernel_active": True, "status": json.loads(out)}
        except json.JSONDecodeError:
            pass
    # Fall back to plain text.
    rc2, out2, _ = _run([aa_status])
    return {"available": True, "kernel_active": True, "raw": out2}


def cmd_apparmor_profiles(_args: list[str]) -> dict[str, Any]:
    """List loaded AppArmor profiles."""
    if not _apparmor_available():
        return {"available": False, "reason": "AppArmor not compiled into kernel"}
    aa_status = shutil.which("aa-status")
    if not aa_status:
        return {"available": True, "reason": "aa-status not installed"}
    rc, out, _ = _run([aa_status, "--json"])
    if rc == 0 and out.strip():
        try:
            data = json.loads(out)
            profiles = data.get("profiles", {})
            return {"available": True, "profiles": profiles}
        except json.JSONDecodeError:
            pass
    rc2, out2, _ = _run([aa_status, "--profiled"])
    return {"available": True, "raw": out2}


def cmd_apparmor_enforce(args: list[str]) -> dict[str, Any]:
    """Switch a profile to enforce mode."""
    if not args:
        return {"error": "profile name required"}
    profile = args[0]
    if not _apparmor_available():
        return {"available": False, "reason": "AppArmor not compiled into kernel"}
    aa_enforce = shutil.which("aa-enforce")
    if not aa_enforce:
        return {"available": True, "reason": "aa-enforce not installed (install apparmor-utils)"}
    rc, out, err = _run([aa_enforce, profile])
    return {
        "enforced": rc == 0,
        "profile": profile,
        "rc": rc,
        "output": out.strip(),
        "stderr": err.strip(),
    }


def cmd_apparmor_complain(args: list[str]) -> dict[str, Any]:
    """Switch a profile to complain mode."""
    if not args:
        return {"error": "profile name required"}
    profile = args[0]
    if not _apparmor_available():
        return {"available": False, "reason": "AppArmor not compiled into kernel"}
    aa_complain = shutil.which("aa-complain")
    if not aa_complain:
        return {"available": True, "reason": "aa-complain not installed (install apparmor-utils)"}
    rc, out, err = _run([aa_complain, profile])
    return {
        "complain": rc == 0,
        "profile": profile,
        "rc": rc,
        "output": out.strip(),
        "stderr": err.strip(),
    }


# ── Linux Security Modules (LSMs) — beyond AppArmor ───────────────
#
# v0.0.33 expands the policy module with the rest of the modern Linux
# LSM stack per user directive: "lets now add smack, tomoyo, yama and
# others as well to the same policy module."
#
# The kernel exposes the active LSM stack at /sys/kernel/security/lsm
# as a comma-separated list (e.g. "lockdown,capability,yama,...").
# Each LSM has its own management surface:
#
#   Smack       /sys/kernel/security/smack/ + userspace tools
#               (smackload, smackcipsos, smackcipso) — Tizen / IoT
#   Tomoyo      /sys/kernel/security/tomoyo/ + userspace (tomoyo-* )
#   Yama        /proc/sys/kernel/yama/ptrace_scope (read+write)
#   LoadPin     /sys/kernel/security/loadpin/ — no userspace config
#   Lockdown    /sys/kernel/security/lockdown — UEFI secure boot mode
#   BPF-LSM     the bpf LSM hook stack; programs visible via bpftool
#   Landlock    /sys/kernel/security/landlock/ + libcapLandlock rules
#
# File capabilities (setcap/getcap) are managed separately — they
# predate the LSM stack but compose with it for fine-grained
# privilege delegation. They are part of the "policy & permissions"
# umbrella even though they are not strictly an LSM.

SECURITY_FS = Path("/sys/kernel/security")
LSM_LIST_FILE = SECURITY_FS / "lsm"

# Lookup table for the per-LSM kernel probe — each entry is
# (id, pretty_name, sub_dir_under_security_fs). Each probe just checks
# whether the directory exists. The user-facing summary iterates over
# this table; the per-LSM command functions do the deeper probing.
#
# PEP 868: dict-of-tuples is a typed, static lookup; replacing nested
# ifs with this table keeps cyclomatic complexity low and makes
# adding a new LSM a one-line change.
LSM_PROBES: list[tuple[str, str, str]] = [
    ("smack",     "Smack",         "smack"),
    ("tomoyo",    "TOMOYO",        "tomoyo"),
    ("yama",      "Yama",          "yama"),         # also /proc/sys/kernel/yama
    ("loadpin",   "LoadPin",       "loadpin"),
    ("lockdown",  "Lockdown",      "lockdown"),
    ("landlock",  "Landlock",      "landlock"),
    ("bpf",       "BPF-LSM",       "bpf"),         # programs via bpftool
    ("apparmor",  "AppArmor",      "apparmor"),
    ("capability","Capabilities",  "capability"),
]


def _read_lsm_stack() -> list[str]:
    """Read /sys/kernel/security/lsm and return the active LSM list.

    The file is a comma-separated list of LSM names in the order the
    kernel stacked them. Returns [] if the file is unreadable (older
    kernels or securityfs not mounted).
    """
    try:
        return [s for s in LSM_LIST_FILE.read_text(encoding="utf-8").strip().split(",") if s]
    except (FileNotFoundError, PermissionError, OSError):
        return []


def _lsm_dir_active(sub: str) -> bool:
    """True if the LSM's securityfs directory exists."""
    return (SECURITY_FS / sub).is_dir()


# ── LSM stack summary ────────────────────────────────────────────────


def cmd_lsm_status(_args: list[str]) -> dict[str, Any]:
    """Top-level LSM framework status — what is the kernel stacking?

    Reads /sys/kernel/security/lsm and cross-references the per-LSM
    probes. Each entry is {id, name, active_in_kernel, dir_present}.
    The panel renders this as the LSM capability matrix.
    """
    stack = _read_lsm_stack()
    entries = [
        {
            "id": lsm_id,
            "name": pretty,
            "active_in_stack": lsm_id in stack,
            "dir_present": _lsm_dir_active(sub),
            "path": str(SECURITY_FS / sub),
        }
        for lsm_id, pretty, sub in LSM_PROBES
    ]
    return {
        "lsm_list_file": str(LSM_LIST_FILE),
        "active_stack": stack,
        "active_count": len(stack),
        "entries": entries,
        "selinux": {
            "skipped": True,
            "reason": "SELinux is native to the host distro — not managed by SysDeck.",
        },
    }


# ── Smack ────────────────────────────────────────────────────────────
#
# Smack (Simplified Mandatory Access Control Kernel) is the LSM used
# by Tizen, AGL (Automotive Grade Linux), and embedded systems. It
# labels processes and objects with simple text labels and enforces
# access rules between them. Userspace tools: smackload (load rules),
# smackcipsos (manage CIPSO mappings), smackcipso. The smack library
# is libsmack; the kernel side ships in mainline since 2.6.30.

SMACK_DIR = SECURITY_FS / "smack"


def cmd_smack_status(_args: list[str]) -> dict[str, Any]:
    """Smack enforcement state — read /sys/kernel/security/smack/."""
    if not SMACK_DIR.is_dir():
        return {
            "available": False,
            "reason": "Smack directory not present at /sys/kernel/security/smack/",
            "install_arch": "Smack is built into the kernel; enable with the kernel cmdline 'security=smack' or 'lsm=...,smack'",
            "install_debian": "Smack is built into the kernel; enable with the kernel cmdline 'security=smack' or 'lsm=...,smack'",
            "note": "Smack is optional in SysDeck — the panel renders an enable hint when absent.",
        }
    info: dict[str, Any] = {"available": True, "path": str(SMACK_DIR)}
    # Lookup table: (filename, key_in_response). Iterated in one pass;
    # failures are silently skipped because some files only exist when
    # specific Smack features are enabled.
    for fname, key in SMACK_FILE_MAP:
        p = SMACK_DIR / fname
        if not p.is_file():
            continue
        try:
            info[key] = p.read_text(encoding="utf-8").strip()
        except (PermissionError, OSError):
            continue
    info["smackload"] = _have("smackload")
    info["smackcipsos"] = _have("smackcipsos")
    return info


# Smack securityfs files of interest, mapped to the JSON key in the
# response. Pulled out as a module-level constant so the loop body
# stays simple and the table is easy to extend.
SMACK_FILE_MAP: list[tuple[str, str]] = [
    ("logging", "logging"),
    ("load", "load"),
    ("load2", "load2"),
    ("revoke-subject", "revoke_subject"),
    ("change-rule", "change_rule"),
    ("onlycap", "onlycap"),
    ("cipso2", "cipso2"),
    ("access2", "access2"),
    ("access", "access"),
    ("mapped", "mapped"),
    ("network-queue-length", "net_queue_len"),
    ("ptrace", "ptrace"),
]


def cmd_smack_labels(_args: list[str]) -> dict[str, Any]:
    """List Smack labels in use on the host.

    Walks /proc/<pid>/attr/current for every running PID. The set
    is deduplicated. Each entry is {label, pids: [...]}.
    """
    if not SMACK_DIR.is_dir():
        return {"available": False, "reason": "Smack not active"}
    labels: dict[str, list[str]] = {}
    proc = Path("/proc")
    for pid_dir in proc.iterdir():
        if not pid_dir.name.isdigit():
            continue
        attr = pid_dir / "attr" / "current"
        try:
            label = attr.read_text(encoding="utf-8").strip("\x00").strip()
        except (FileNotFoundError, PermissionError, OSError):
            continue
        if not label:
            continue
        labels.setdefault(label, []).append(pid_dir.name)
    return {
        "available": True,
        "labels": [{"label": k, "pid_count": len(v), "pids": v[:50]} for k, v in sorted(labels.items())],
        "label_count": len(labels),
    }


def cmd_smack_load(args: list[str]) -> dict[str, Any]:
    """Load Smack access rules from a file (smackload <rules-file>).

    Reads a smack rule file (one rule per line) and writes it to
    /sys/kernel/security/smack/load. Rules use the format:
        subject object access [flags]
    where access is one of the 12-char masks (rwxat...) or '-'
    """
    if not args:
        return {"error": "rules file path required"}
    rules_file = Path(args[0])
    if not rules_file.is_file():
        return {"error": f"{rules_file} is not a file"}
    if not SMACK_DIR.is_dir():
        return {"available": False, "reason": "Smack not active"}
    load_target = SMACK_DIR / "load"
    try:
        load_target.write_text(rules_file.read_text(encoding="utf-8"), encoding="utf-8")
        return {"loaded": True, "rules_file": str(rules_file), "target": str(load_target)}
    except (PermissionError, OSError) as exc:
        return {"loaded": False, "error": str(exc),
                "hint": "run via cockpit superuser channel (polkit org.sysdeck.policy.modify)"}


# ── TOMOYO ──────────────────────────────────────────────────────────
#
# TOMOYO Linux focuses on process-behavior analysis: it learns what
# a process should do and enforces it. Userspace tools: tomoyo-init,
# tomoyo-set-profile, tomoyo-set-exception, tomoyo-save-policy, etc.
# Kernel-side lives at /sys/kernel/security/tomoyo/.

TOMOYO_DIR = SECURITY_FS / "tomoyo"

# TOMOYO control files surfaced by the status subcommand. Pulled out
# as a module-level constant so the file list is easy to extend.
TOMOYO_FILES: tuple[str, ...] = (
    "profile", "exception_policy", "domain_policy", "manager",
    "query", "grant_log", "reject_log", "status", "version",
)


def cmd_tomoyo_status(_args: list[str]) -> dict[str, Any]:
    """TOMOYO enforcement state — read /sys/kernel/security/tomoyo/."""
    if not TOMOYO_DIR.is_dir():
        return {
            "available": False,
            "reason": "TOMOYO directory not present at /sys/kernel/security/tomoyo/",
            "install_arch": "TOMOYO is built into the kernel; enable with 'security=tomoyo' or 'lsm=...,tomoyo' on the kernel cmdline",
            "install_debian": "TOMOYO is built into the kernel; enable with 'security=tomoyo' or 'lsm=...,tomoyo' on the kernel cmdline",
            "note": "TOMOYO is optional in SysDeck — the panel renders an enable hint when absent.",
        }
    info: dict[str, Any] = {"available": True, "path": str(TOMOYO_DIR)}
    # Probe TOMOYO's standard control files — single pass over the
    # TOMOYO_FILES lookup table; each value is truncated to 500 chars
    # to keep the JSON response small.
    for f in TOMOYO_FILES:
        p = TOMOYO_DIR / f
        if not p.is_file():
            continue
        try:
            val = p.read_text(encoding="utf-8").strip()
            info[f] = val[:500] if len(val) > 500 else val
        except (PermissionError, OSError):
            continue
    info["tomoyo_tools"] = _have("tomoyo-setprofile") or _have("tomoyo-set-profile")
    return info


def cmd_tomoyo_profiles(_args: list[str]) -> dict[str, Any]:
    """List TOMOYO profiles (read /sys/kernel/security/tomoyo/profile)."""
    if not TOMOYO_DIR.is_dir():
        return {"available": False, "reason": "TOMOYO not active"}
    p = TOMOYO_DIR / "profile"
    if not p.is_file():
        return {"available": False, "reason": "profile file not present"}
    try:
        raw = p.read_text(encoding="utf-8")
    except (PermissionError, OSError) as exc:
        return {"available": True, "error": str(exc)}
    return {"available": True, "raw": raw, "profiles": raw.splitlines()}


def cmd_tomoyo_save_policy(args: list[str]) -> dict[str, Any]:
    """Save TOMOYO policy snapshot to a file.

    TOMOYO exposes its policy as text files under /sys/kernel/security/
    tomoyo/. This command reads each one and writes the snapshot to
    the operator's chosen path.
    """
    if not args:
        return {"error": "output file path required"}
    if not TOMOYO_DIR.is_dir():
        return {"available": False, "reason": "TOMOYO not active"}
    out_path = Path(args[0])
    snapshot: list[str] = []
    for f in ("profile", "exception_policy", "domain_policy", "manager"):
        src = TOMOYO_DIR / f
        if not src.is_file():
            continue
        try:
            snapshot.append(f"# === {f} ===")
            snapshot.append(src.read_text(encoding="utf-8"))
        except (PermissionError, OSError) as exc:
            snapshot.append(f"# {f}: read failed: {exc}")
    try:
        out_path.write_text("\n".join(snapshot), encoding="utf-8")
        return {"saved": True, "path": str(out_path), "size": len("\n".join(snapshot))}
    except (PermissionError, OSError) as exc:
        return {"saved": False, "error": str(exc)}


# ── Yama ─────────────────────────────────────────────────────────────
#
# Yama is a small LSM that only does ptrace-scope restrictions. The
# only knob is /proc/sys/kernel/yama/ptrace_scope — a 0-3 integer:
#   0 = disabled (any process can ptrace any same-uid process)
#   1 = restricted ptrace (default on most distros)
#   2 = admin-only ptrace
#   3 = no ptrace at all

YAMA_SCOPE_FILE = Path("/proc/sys/kernel/yama/ptrace_scope")

YAMA_SCOPE_NAMES: dict[int, str] = {
    0: "disabled",
    1: "restricted (default)",
    2: "admin-only",
    3: "no-ptrace",
}


def cmd_yama_status(_args: list[str]) -> dict[str, Any]:
    """Yama ptrace-scope status — read /proc/sys/kernel/yama/ptrace_scope."""
    if not YAMA_SCOPE_FILE.is_file():
        return {
            "available": False,
            "reason": "Yama not active on this kernel",
            "note": "Yama is built into the kernel; enable with 'lsm=...,yama' on the kernel cmdline.",
        }
    try:
        raw = YAMA_SCOPE_FILE.read_text(encoding="utf-8").strip()
    except (PermissionError, OSError) as exc:
        return {"available": True, "error": str(exc)}
    try:
        scope = int(raw)
    except ValueError:
        scope = -1
    return {
        "available": True,
        "scope": scope,
        "scope_name": YAMA_SCOPE_NAMES.get(scope, "unknown"),
        "file": str(YAMA_SCOPE_FILE),
    }


def cmd_yama_set_scope(args: list[str]) -> dict[str, Any]:
    """Set Yama ptrace scope (write to /proc/sys/kernel/yama/ptrace_scope)."""
    if not args:
        return {"error": "scope value required (0=disabled, 1=restricted, 2=admin-only, 3=no-ptrace)"}
    try:
        scope = int(args[0])
    except ValueError:
        return {"error": f"scope must be numeric 0-3, got {args[0]}"}
    if scope not in YAMA_SCOPE_NAMES:
        return {"error": f"scope {scope} out of range (0-3)"}
    if not YAMA_SCOPE_FILE.is_file():
        return {"available": False, "reason": "Yama not active on this kernel"}
    try:
        YAMA_SCOPE_FILE.write_text(str(scope), encoding="utf-8")
        return {
            "set": True,
            "scope": scope,
            "scope_name": YAMA_SCOPE_NAMES[scope],
            "file": str(YAMA_SCOPE_FILE),
        }
    except (PermissionError, OSError) as exc:
        return {"set": False, "error": str(exc),
                "hint": "run via cockpit superuser channel (polkit org.sysdeck.policy.modify)"}


# ── LoadPin ──────────────────────────────────────────────────────────
#
# LoadPin ensures that all kernel-loaded modules come from a single
# pinned filesystem (typically the root fs). It has no userspace
# management tool — the only knob is whether it is enabled.

LOADPIN_DIR = SECURITY_FS / "loadpin"


def cmd_loadpin_status(_args: list[str]) -> dict[str, Any]:
    """LoadPin status — read /sys/kernel/security/loadpin/."""
    if not LOADPIN_DIR.is_dir():
        return {
            "available": False,
            "reason": "LoadPin directory not present at /sys/kernel/security/loadpin/",
            "note": "LoadPin is built into the kernel; enable with 'lsm=...,loadpin' on the kernel cmdline.",
        }
    info: dict[str, Any] = {"available": True, "path": str(LOADPIN_DIR)}
    # LoadPin exposes a 'enforce' file (0/1) when active.
    enforce_file = LOADPIN_DIR / "enforce"
    if enforce_file.is_file():
        try:
            info["enforce"] = enforce_file.read_text(encoding="utf-8").strip()
        except (PermissionError, OSError):
            pass
    # LoadPin also exposes a 'exclude' list file.
    exclude_file = LOADPIN_DIR / "exclude"
    if exclude_file.is_file():
        try:
            info["exclude"] = exclude_file.read_text(encoding="utf-8").strip()
        except (PermissionError, OSError):
            pass
    return info


# ── Lockdown ────────────────────────────────────────────────────────
#
# Lockdown is the UEFI secure-boot kernel lockdown mode. It has four
# states (none, integrity, confidentiality, none-confidentiality —
# depending on kernel version). Exposed at /sys/kernel/security/
# lockdown.

LOCKDOWN_DIR = SECURITY_FS / "lockdown"


def cmd_lockdown_status(_args: list[str]) -> dict[str, Any]:
    """Lockdown mode status — read /sys/kernel/security/lockdown."""
    if not LOCKDOWN_DIR.is_dir():
        return {
            "available": False,
            "reason": "Lockdown directory not present at /sys/kernel/security/lockdown/",
            "note": "Lockdown is enabled by UEFI secure boot; the file appears only when the kernel was built with CONFIG_SECURITY_LOCKDOWN_LSM.",
        }
    info: dict[str, Any] = {"available": True, "path": str(LOCKDOWN_DIR)}
    for f in LOCKDOWN_DIR.iterdir():
        if not f.is_file():
            continue
        try:
            info[f.name] = f.read_text(encoding="utf-8").strip()
        except (PermissionError, OSError):
            continue
    return info


# ── BPF-LSM ──────────────────────────────────────────────────────────
#
# The BPF LSM is a stackable hook framework: programs attached to
# security_hook_fname() hooks at runtime. Programs are loaded via
# libbpf's bpf_attach_btf_id, and queried via bpftool. The kernel
# exposes the active hooks under /sys/kernel/security/bpf/.

BPFLSM_DIR = SECURITY_FS / "bpf"


def cmd_bpflsm_status(_args: list[str]) -> dict[str, Any]:
    """BPF-LSM status — directory presence + bpftool prog listing (BPF_PROG_TYPE_LSM)."""
    info: dict[str, Any] = {
        "available": (BPFLSM_DIR.is_dir() or _have("bpftool")),
        "dir_present": BPFLSM_DIR.is_dir(),
        "dir_path": str(BPFLSM_DIR),
        "bpftool": _have("bpftool"),
    }
    # If bpftool is present, list BPF_PROG_TYPE_LSM programs.
    bpftool = shutil.which("bpftool")
    if not bpftool:
        return info
    rc, out, _ = _run([bpftool, "prog", "show", "-j"])
    if rc != 0 or not out.strip():
        return info
    try:
        progs = json.loads(out)
    except json.JSONDecodeError:
        return info
    # Filter to LSM-typed programs (bpftool's "type" field is "lsm").
    lsm_progs = [p for p in progs if isinstance(p, dict) and p.get("type") == "lsm"]
    info["lsm_program_count"] = len(lsm_progs)
    info["lsm_programs"] = lsm_progs[:50]  # cap to avoid huge responses
    return info


# ── Landlock ─────────────────────────────────────────────────────────
#
# Landlock is the modern unprivileged sandboxing LSM (Linux 5.13+).
# Each process can voluntarily restrict itself with a Landlock
# ruleset (filesystem paths, TCP bind/connect, etc.). The kernel
# exposes /sys/kernel/security/landlock/. The rulesets are per-
# process and best enumerated via /proc/<pid>/status's "Landlock"
# line.

LANDLOCK_DIR = SECURITY_FS / "landlock"


def cmd_landlock_status(_args: list[str]) -> dict[str, Any]:
    """Landlock status — directory presence + per-process ruleset summary."""
    info: dict[str, Any] = {
        "available": LANDLOCK_DIR.is_dir(),
        "dir_present": LANDLOCK_DIR.is_dir(),
        "dir_path": str(LANDLOCK_DIR),
    }
    if not LANDLOCK_DIR.is_dir():
        info["reason"] = "Landlock not active — requires Linux 5.13+ and 'lsm=...,landlock' on the kernel cmdline."
        return info
    # Walk /proc/<pid>/status looking for a "Landlock:" line.
    rulesets: list[dict[str, Any]] = []
    proc = Path("/proc")
    for pid_dir in proc.iterdir():
        if not pid_dir.name.isdigit():
            continue
        status = pid_dir / "status"
        try:
            for line in status.read_text(encoding="utf-8").splitlines():
                if line.startswith("Landlock:"):
                    val = line.split(":", 1)[1].strip()
                    if val and val != "0":
                        comm = (pid_dir / "comm").read_text(encoding="utf-8").strip()
                        rulesets.append({"pid": pid_dir.name, "comm": comm, "landlock": val})
                    break
        except (FileNotFoundError, PermissionError, OSError):
            continue
    info["processes_with_rulesets"] = len(rulesets)
    info["rulesets"] = rulesets[:50]
    return info


# ── File capabilities (setcap / getcap) ────────────────────────────
#
# File capabilities predate the LSM stack but compose with it for
# fine-grained privilege delegation. They allow binaries to hold
# specific capabilities without needing to run as root.
#
#   getcap -r /            # find all binaries with caps (recursive)
#   getcap <path>           # show caps on one file
#   setcap 'cap_net_bind+ep' <path>  # grant cap_net_bind to a binary
#   setcap -r <path>        # remove all caps from a file

CAP_TOOLS = ("setcap", "getcap")


def cmd_filecaps_list(_args: list[str]) -> dict[str, Any]:
    """List binaries on the system that have file capabilities.

    Runs `getcap -r /` to walk the root filesystem. The output is
    capped at 200 entries to avoid blowing up the JSON response on
    huge filesystems.
    """
    getcap = shutil.which("getcap")
    if not getcap:
        return {
            "available": False,
            "reason": "getcap not installed",
            "install": "pacman -S libcap  # Arch\\napart install libcap-bin  # Debian",
        }
    rc, out, err = _run([getcap, "-r", "/"], timeout=30)
    if rc != 0:
        return {"available": True, "error": err or "getcap failed", "rc": rc}
    # Output format: "/path/to/binary cap_name,cap_other=ep"
    entries = []
    for line in out.splitlines():
        if not line.strip():
            continue
        path, _, caps = line.partition(" ")
        entries.append({"path": path, "caps": caps.strip()})
        if len(entries) >= 200:
            break
    return {
        "available": True,
        "entries": entries,
        "count": len(entries),
        "truncated": len(entries) >= 200,
    }


def cmd_filecaps_show(args: list[str]) -> dict[str, Any]:
    """Show file capabilities on a single path (getcap <path>)."""
    if not args:
        return {"error": "path required"}
    getcap = shutil.which("getcap")
    if not getcap:
        return {"available": False, "reason": "getcap not installed"}
    path = args[0]
    rc, out, err = _run([getcap, path])
    return {
        "available": True,
        "path": path,
        "caps": out.strip(),
        "rc": rc,
        "stderr": err.strip(),
    }


def cmd_filecaps_set(args: list[str]) -> dict[str, Any]:
    """Set file capabilities on a path (setcap '<caps>' <path>)."""
    if len(args) < 2:
        return {"error": "usage: filecaps-set <caps> <path>  (e.g. 'cap_net_bind_service+ep' /usr/bin/python3)"}
    caps, path = args[0], args[1]
    setcap = shutil.which("setcap")
    if not setcap:
        return {"available": False, "reason": "setcap not installed"}
    rc, out, err = _run([setcap, caps, path])
    return {
        "set": rc == 0,
        "caps": caps,
        "path": path,
        "rc": rc,
        "stderr": err.strip(),
        "output": out.strip(),
    }


def cmd_filecaps_remove(args: list[str]) -> dict[str, Any]:
    """Remove all file capabilities from a path (setcap -r <path>)."""
    if not args:
        return {"error": "path required"}
    path = args[0]
    setcap = shutil.which("setcap")
    if not setcap:
        return {"available": False, "reason": "setcap not installed"}
    rc, out, err = _run([setcap, "-r", path])
    return {
        "removed": rc == 0,
        "path": path,
        "rc": rc,
        "stderr": err.strip(),
    }


# ── Summary ──────────────────────────────────────────────────────────
#
# v0.0.33 refactor: the summary command previously hand-built the
# per-concern dict with nested ifs. The dict now iterates over a
# lookup table (LSM_PROBES) for the LSM family, and a static table
# (NON_LSM_CONCERNS) for the non-LSM concerns (ACLs, cgroups, VLANs,
# eBPF, namespaces). The lookup-table pattern means a new concern
# is a one-line addition to a table, not a new code path.


# Non-LSM concerns, expressed as a static table for the summary
# iteration. Each entry: (id, probe_fn) — the probe_fn returns a
# {available: bool, ...} dict to embed in the summary.
def _probe_acl() -> dict[str, Any]:
    return {
        "available": _have("getfacl") and _have("setfacl"),
        "binaries": {"getfacl": _have("getfacl"), "setfacl": _have("setfacl")},
    }


def _probe_cgroups() -> dict[str, Any]:
    return {"available": _cgroup_v2_available(), "root": str(CGROUP_ROOT)}


def _probe_vlans() -> dict[str, Any]:
    return {"available": _have("ip")}


def _probe_ebpf() -> dict[str, Any]:
    return {"available": _have("bpftool"), "bpftool_path": shutil.which("bpftool") or ""}


def _probe_namespaces() -> dict[str, Any]:
    return {"available": _have("lsns"), "lsns_path": shutil.which("lsns") or ""}


# PEP 868: list-of-tuples keeps the order stable and the type clear.
NON_LSM_CONCERNS: list[tuple[str, str, callable]] = [
    ("acl",        "ACLs",        _probe_acl),
    ("cgroups",    "cgroups v2",  _probe_cgroups),
    ("vlans",      "VLANs",       _probe_vlans),
    ("ebpf",       "eBPF",        _probe_ebpf),
    ("namespaces", "Namespaces",  _probe_namespaces),
]


def cmd_summary(_args: list[str]) -> dict[str, Any]:
    """One-shot overview of all policy & permissions concerns.

    Iterates over the LSM_PROBES table and the NON_LSM_CONCERNS table
    to build the full capability matrix in one pass. Adding a new
    concern is a one-line addition to either table — no nested ifs,
    no new code paths.
    """
    stack = _read_lsm_stack()
    lsm_summary = {
        lsm_id: {
            "name": pretty,
            "active_in_stack": lsm_id in stack,
            "dir_present": _lsm_dir_active(sub),
        }
        for lsm_id, pretty, sub in LSM_PROBES
    }
    non_lsm_summary = {
        cid: {**probe_fn(), "name": pretty}
        for cid, pretty, probe_fn in NON_LSM_CONCERNS
    }
    return {
        "lsms": lsm_summary,
        "lsm_stack": stack,
        "lsm_stack_file": str(LSM_LIST_FILE),
        "concerns": non_lsm_summary,
        "selinux": {
            "skipped": True,
            "reason": "SELinux is native to the host distro — not managed by SysDeck.",
        },
    }


# ── Dispatch table ───────────────────────────────────────────────────

COMMANDS = {
    # summary
    "summary":              lambda _args: cmd_summary([]),

    # ACLs
    "acl-list":             lambda args: cmd_acl_list(args),
    "acl-set":              lambda args: cmd_acl_set(args),
    "acl-remove":           lambda args: cmd_acl_remove(args),
    "acl-default":          lambda args: cmd_acl_default(args),

    # cgroups v2
    "cgroup-list":          lambda _args: cmd_cgroup_list([]),
    "cgroup-show":          lambda args: cmd_cgroup_show(args),
    "cgroup-procs":         lambda args: cmd_cgroup_procs(args),
    "cgroup-create":        lambda args: cmd_cgroup_create(args),
    "cgroup-move":          lambda args: cmd_cgroup_move(args),
    "cgroup-set":           lambda args: cmd_cgroup_set(args),

    # VLANs
    "vlan-list":            lambda _args: cmd_vlan_list([]),
    "vlan-show":            lambda args: cmd_vlan_show(args),
    "vlan-create":          lambda args: cmd_vlan_create(args),
    "vlan-delete":          lambda args: cmd_vlan_delete(args),

    # eBPF
    "ebpf-list":            lambda _args: cmd_ebpf_list([]),
    "ebpf-show":            lambda args: cmd_ebpf_show(args),
    "ebpf-maps":            lambda _args: cmd_ebpf_maps([]),
    "ebpf-pin":             lambda args: cmd_ebpf_pin(args),

    # namespaces
    "ns-list":              lambda _args: cmd_ns_list([]),
    "ns-show":              lambda args: cmd_ns_show(args),

    # AppArmor (optional — the v0.0.32 LSM)
    "apparmor-status":      lambda _args: cmd_apparmor_status([]),
    "apparmor-profiles":   lambda _args: cmd_apparmor_profiles([]),
    "apparmor-enforce":     lambda args: cmd_apparmor_enforce(args),
    "apparmor-complain":    lambda args: cmd_apparmor_complain(args),

    # v0.0.33: additional LSMs — Smack, TOMOYO, Yama, LoadPin,
    # Lockdown, BPF-LSM, Landlock + file capabilities. Each is
    # optional; the bridge auto-detects whether the LSM is compiled
    # into the kernel and the panel renders an install/enable hint
    # when absent.
    "lsm-status":           lambda _args: cmd_lsm_status([]),
    "smack-status":         lambda _args: cmd_smack_status([]),
    "smack-labels":         lambda _args: cmd_smack_labels([]),
    "smack-load":           lambda args: cmd_smack_load(args),
    "tomoyo-status":        lambda _args: cmd_tomoyo_status([]),
    "tomoyo-profiles":     lambda _args: cmd_tomoyo_profiles([]),
    "tomoyo-save-policy":   lambda args: cmd_tomoyo_save_policy(args),
    "yama-status":          lambda _args: cmd_yama_status([]),
    "yama-set-scope":       lambda args: cmd_yama_set_scope(args),
    "loadpin-status":       lambda _args: cmd_loadpin_status([]),
    "lockdown-status":      lambda _args: cmd_lockdown_status([]),
    "bpflsm-status":        lambda _args: cmd_bpflsm_status([]),
    "landlock-status":      lambda _args: cmd_landlock_status([]),
    "filecaps-list":        lambda _args: cmd_filecaps_list([]),
    "filecaps-show":        lambda args: cmd_filecaps_show(args),
    "filecaps-set":         lambda args: cmd_filecaps_set(args),
    "filecaps-remove":      lambda args: cmd_filecaps_remove(args),
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
