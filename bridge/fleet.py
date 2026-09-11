#!/usr/bin/env python3
"""
SysDeck - Fleet Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Aggregates local host info (hostname, uptime, load, network addresses)
and the cockpit multi-host peer list (if /etc/cockpit/machines.d/ is
configured) into a single JSON document.

Usage:
    python3 -m sysdeck.bridge.fleet local
    python3 -m sysdeck.bridge.fleet peers
    python3 -m sysdeck.bridge.fleet summary
"""

import json
import os
import re
import subprocess
import sys
from typing import Any

# /etc/cockpit/machines.d/<host>.json schema (subset).
MACHINE_FILE_RE = re.compile(r"^(?P<host>\S+)\s+.*$")


def run(argv: list[str]) -> str:
    """Run a command, returning stdout. Returns '' on failure."""
    try:
        return subprocess.run(
            argv, capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def local_host() -> dict[str, Any]:
    """Aggregate hostname, uptime, load, and IP addresses."""
    uptime_raw = run(["uptime"]).strip()
    addresses = [a for a in run(["hostname", "-I"]).split() if a]
    hostname = run(["hostname"]).strip() or "unknown"

    # Parse load average from uptime output.
    # Typical: " 14:23:01 up 12 days,  3:45,  2 users,  load average: 0.42, 0.58, 0.61"
    load_match = re.search(r"load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)", uptime_raw)
    load = [float(load_match.group(i)) for i in (1, 2, 3)] if load_match else []

    return {
        "hostname": hostname,
        "uptime": uptime_raw,
        "addresses": addresses,
        "load": load,
    }


def peers() -> list[dict[str, str]]:
    """Parse /etc/cockpit/machines.d/*.json for peer host entries.

    Each file is a JSON document with a top-level "host" key. Files that
    fail to parse are skipped — the panel fails closed.
    """
    peer_dir = "/etc/cockpit/machines.d"
    if not os.path.isdir(peer_dir):
        return []

    peers_list: list[dict[str, str]] = []
    for entry in sorted(os.listdir(peer_dir)):
        if not entry.endswith(".json"):
            continue
        path = os.path.join(peer_dir, entry)
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        # Schema is flexible; pull common keys.
        peers_list.append({
            "host": data.get("host", ""),
            "address": data.get("address", data.get("host", "")),
            "label": data.get("label", data.get("host", "")),
            "visible": str(data.get("visible", "true")).lower(),
        })
    return peers_list


def summary() -> dict[str, Any]:
    """Local host info plus peer list."""
    return {
        "local": local_host(),
        "peers": peers(),
        "peerCount": len(peers()),
    }


COMMANDS = {
    "local": lambda _args: local_host(),
    "peers": lambda _args: peers(),
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
