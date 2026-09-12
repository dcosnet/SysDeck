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
import re
import subprocess
import sys
from typing import Any

# Scrubbed child environment: parsed output stays locale-stable and no
# console process state leaks into children.
SCRUBBED_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}


def run(argv: list[str]) -> str:
    """Run a command and return stdout. Raises CalledProcessError on failure.

    Children run under the scrubbed env with a hard timeout (the suite's
    B1.2 subprocess posture)."""
    return subprocess.run(
        argv, capture_output=True, text=True, check=True,
        timeout=15, env=SCRUBBED_ENV,
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


_ID_RE = re.compile(r"^[a-f0-9]{6,64}$")


def inspect(container_id: str) -> dict[str, Any]:
    """Inspect a single container by ID prefix (validated; `--` guarded)."""
    if not _ID_RE.match(container_id or ""):
        return {"error": f"invalid container id: {container_id!r}"}
    try:
        raw = run(["podman", "inspect", "--", container_id])
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return {}
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
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
