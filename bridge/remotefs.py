#!/usr/bin/env python3
"""SysDeck - Remote FS Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Manages remote / distributed filesystem backends as systemd services
and surfaces cluster status from each backend's CLI tool. The bridge
auto-detects which backends are installed on the host; the panel
renders a card per detected backend with cluster status, pool/brick/
volume counts, and Start/Stop/Restart controls.

v0.0.35 directive: "then a remote fs manager such as ceph, and
others but not nfs or amanada fs." The backends included match
that directive — distributed / shared-storage filesystems with
their own cluster management surface:

Backends shipped:
  Ceph        — distributed object storage · LGPL-2.1 · ceph / cephfs
  GlusterFS   — scale-out network filesystem · GPL-2.0 · gluster
  MooseFS     — distributed fault-tolerant FS · GPL-2.0 · moosefs
  BeeGFS      — parallel cluster filesystem · BeeGFS EULA (free) · beegfs
  OrangeFS    — parallel FS (PVFS2 successor) · OpenSource · orangefs

Explicitly EXCLUDED per directive:
  NFS         — kernel-builtin, no admin panel beyond `nfsd` daemon;
                no cluster, no remote-FS-as-data-store semantics.
                Operators who need NFS use cockpit-nfs (separate plugin).
  Amanda      — backup system (AMANDA = Advanced Maryland Automatic
                Network Disk Archiver), NOT a remote/distributed
                filesystem. Operators who need backup use a dedicated
                backup solution.

Subcommands:
  summary       — list all detected backends with status + cluster info
  status <id>   — detailed status for one backend
  start <id>    — systemctl start <service>
  stop <id>     — systemctl stop <service>
  restart <id>  — systemctl restart <service>
  cluster-info <id> — backend-specific cluster status (ceph status,
                       gluster pool list, moosefs-cli info, etc.)

Cockpit way (v0.0.31+ pattern): the bridge runs systemctl via
subprocess directly — no `sudo` shell-out. The JS panel passes
{ superuser: 'try' } to cockpit.spawn so the cockpit bridge prompts
the operator via polkit for the org.sysdeck.remotefs.modify action
(added in v0.0.35).

Usage:
    python3 /usr/lib/sysdeck/bridge/remotefs.py summary
    python3 /usr/lib/sysdeck/bridge/remotefs.py start ceph
    python3 /usr/lib/sysdeck/bridge/remotefs.py cluster-info glusterfs
"""

import json
import shutil
import subprocess
import sys
from datetime import datetime
from typing import Any


# ── Backend Registry ───────────────────────────────────────────────
# Each entry: (id, name, family, default_port, systemd_unit, cli_tool,
#              config_paths, license, homepage, install_hint)

BACKEND_REGISTRY = [
    (
        "ceph", "Ceph", "object-storage", 6789,
        "ceph.target", "ceph",
        ["/etc/ceph/ceph.conf"],
        "LGPL-2.1",
        "https://ceph.io/",
        "Arch: pacman -S ceph  ·  Debian: apt install ceph  ·  Fedora: dnf install ceph",
    ),
    (
        "glusterfs", "GlusterFS", "scale-out-fs", 24007,
        "glusterd.service", "gluster",
        ["/etc/glusterfs/glusterd.vol"],
        "GPL-2.0",
        "https://www.gluster.org/",
        "Arch: pacman -S glusterfs  ·  Debian: apt install glusterfs-server  ·  Fedora: dnf install glusterfs-server",
    ),
    (
        "moosefs", "MooseFS", "distributed-fs", 9420,
        "moosefs-master.service", "moosefs-cli",
        ["/etc/mfs/mfsmaster.cfg"],
        "GPL-2.0",
        "https://moosefs.com/",
        "Arch: pacman -S moosefs  ·  Debian: apt install moosefs-master  ·  Fedora: dnf install moosefs-master",
    ),
    (
        "beegfs", "BeeGFS", "parallel-fs", 8008,
        "beegfs-meta.service", "beegfs-ctl",
        ["/etc/beegfs/beegfs-meta.conf"],
        "BeeGFS EULA (free)",
        "https://www.beegfs.io/",
        "Arch: yay -S beegfs  ·  Debian: apt install beegfs-meta  ·  Fedora: see beegfs.io docs",
    ),
    (
        "orangefs", "OrangeFS", "parallel-fs", 3334,
        "pvfs2-server.service", "pvfs2-server",
        ["/etc/orangefs/orangefs-server.conf"],
        "OpenSource (BSD-3)",
        "http://www.orangefs.org/",
        "Arch: yay -S orangefs  ·  Debian: apt install orangefs-server  ·  Fedora: dnf install orangefs-server",
    ),
]


# ── EXCLUDED backends — documented here so future contributors
# don't accidentally add them back.
EXCLUDED = {
    "nfs": "kernel-builtin; no cluster; no remote-FS-as-data-store semantics. Use cockpit-nfs.",
    "amanda": "backup system, not a remote/distributed filesystem. Use a dedicated backup solution.",
}


def _have(binary: str) -> bool:
    return shutil.which(binary) is not None


_SYSTEMCTL = shutil.which("systemctl")


def _unit_loaded(unit: str) -> bool:
    if not unit or not _SYSTEMCTL:
        return False
    out = subprocess.run(
        ["systemctl", "list-unit-files", unit],
        capture_output=True, text=True, timeout=5,
    ).stdout
    return unit in out


def _systemctl_show(unit: str, props: list[str]) -> dict[str, str]:
    if not _SYSTEMCTL:
        return {}
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


def _detect_backend(entry) -> dict[str, Any]:
    (bid, name, family, port, unit, cli, configs, lic, homepage, install_hint) = entry

    cli_available = _have(cli) if cli else False
    unit_loaded = _unit_loaded(unit) if unit else False
    config_present = any(_path_exists(p) for p in configs)

    if unit_loaded:
        state = _service_status(unit)
        status = state["status"]
        active_state = state["active"]
        sub_state = state["sub"]
        uptime = state["uptime_seconds"]
    elif cli_available or config_present:
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
        "url": f"http://127.0.0.1:{port}" if port else "",
        "serviceUnit": unit,
        "cli": cli,
        "configPath": config_path,
        "license": lic,
        "homepage": homepage,
        "installHint": install_hint,
        "supported": True,
        "excluded": False,
    }


def _path_exists(p: str) -> bool:
    try:
        return bool(p) and __import__("os").path.exists(p)
    except (OSError, ValueError):
        return False


def cmd_summary() -> dict[str, Any]:
    backends = [_detect_backend(e) for e in BACKEND_REGISTRY]
    installed = [b for b in backends if b["status"] != "uninstalled"]
    running = [b for b in backends if b["status"] == "running"]
    return {
        "backends": backends,
        "totalBackends": len(backends),
        "installedCount": len(installed),
        "runningCount": len(running),
        "excluded": EXCLUDED,
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
    return _detect_backend(e)


def _systemctl(action: str, unit: str) -> dict[str, Any]:
    if not unit:
        return {"rc": 127, "success": False, "stderr": "no systemd unit for this backend"}
    if not _SYSTEMCTL:
        return {"rc": 127, "success": False, "stderr": "systemctl not present on this host (no systemd)"}
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


def cmd_cluster_info(bid: str) -> dict[str, Any]:
    """Backend-specific cluster status query.

    Each backend has its own CLI for cluster status:
      ceph       → ceph status (JSON via --format=json)
      glusterfs  → gluster pool list
      moosefs    → moosefs-cli info
      beegfs     → beegfs-ctl --listnodes
      orangefs   → pvfs2-server -m
    """
    e = _find_backend(bid)
    if not e:
        return {"error": f"Unknown backend: {bid}"}
    (bid2, name, family, port, unit, cli, configs, lic, homepage, install_hint) = e

    # One probe table, not five copy-pasted branches: each backend
    # maps to its argv; a CLI that is not installed is a state the panel
    # can render, not a traceback.
    probes: dict[str, list[str]] = {
        "ceph": ["ceph", "status", "--format=json"],
        "glusterfs": ["gluster", "pool", "list"],
        "moosefs": ["moosefs-cli", "info"],
        "beegfs": ["beegfs-ctl", "--listnodes"],
        "orangefs": ["pvfs2-server", "-m"],
    }
    argv = probes.get(bid2)
    if argv is None:
        return {"error": f"No cluster-info handler for {bid2}"}
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=15)
    except FileNotFoundError:
        return {"available": False,
                "reason": f"{argv[0]} is not installed",
                "install": install_hint or ""}
    except subprocess.TimeoutExpired:
        return {"available": False,
                "reason": f"{argv[0]} timed out after 15s"}

    if bid2 == "ceph":
        if out.returncode != 0:
            return {"error": out.stderr.strip() or f"ceph status returned {out.returncode}"}
        try:
            data = json.loads(out.stdout)
            return {
                "backend": bid2,
                "raw": data,
                "summary": {
                    "health": data.get("health", {}).get("status", "?"),
                    "fsid": data.get("fsid", "?"),
                    "monmap": data.get("monmap", {}).get("num_mons", 0),
                    "osdmap": data.get("osdmap", {}).get("osdmap", {}).get("num_osds", 0),
                    "pgmap": data.get("pgmap", {}).get("num_pgs", 0),
                },
                "rawText": out.stdout[:4000],
            }
        except json.JSONDecodeError:
            return {"backend": bid2, "rawText": out.stdout[:4000]}

    return {
        "backend": bid2,
        "rawText": out.stdout[:4000] if out.returncode == 0 else "",
        "stderr": out.stderr.strip() if out.returncode != 0 else "",
        "rc": out.returncode,
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
    elif cmd == "cluster-info":
        bid = argv[1] if len(argv) > 1 else ""
        print(json.dumps(cmd_cluster_info(bid), indent=2))
    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
