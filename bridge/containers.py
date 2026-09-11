#!/usr/bin/env python3
"""
SysDeck - Containers Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Aggregates podman container state with systemd unit status so the JS
panel can render a unified view in a single spawn call.

Usage:
    python3 -m sysdeck.bridge.containers list
    python3 -m sysdeck.bridge.containers inspect <id>
"""

import json
import subprocess
import sys
from typing import Any


def run(argv: list[str]) -> str:
    """Run a command and return stdout. Raises CalledProcessError on failure."""
    return subprocess.run(
        argv, capture_output=True, text=True, check=True,
    ).stdout


def list_containers() -> list[dict[str, Any]]:
    """Return containers with their matching systemd unit name (if any)."""
    try:
        raw = run(["podman", "ps", "-a", "--format", "json"])
        containers = json.loads(raw) if raw.strip() else []
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []

    # Step-down: enrich each container with its systemd scope unit.
    # cgroup name pattern: /machine.slice/libpod-<id>.scope
    return [
        {
            "id": c.get("Id", "")[:12],
            "name": c.get("Names", [""])[0],
            "image": c.get("Image", ""),
            "status": c.get("Status", ""),
            "state": c.get("State", ""),
            "systemdUnit": f"libpod-{c.get('Id', '')}.scope",
        }
        for c in containers
    ]


def inspect(container_id: str) -> dict[str, Any]:
    """Inspect a single container by ID prefix."""
    raw = run(["podman", "inspect", container_id])
    data = json.loads(raw)
    return data[0] if data else {}


COMMANDS = {
    "list": lambda _args: list_containers(),
    "inspect": lambda args: inspect(args[0]) if args else {},
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
