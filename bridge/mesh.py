#!/usr/bin/env python3
"""
SysDeck - Service Mesh Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Lists Kubernetes services via `kubectl get services`. Returns an empty
items list when kubectl is not installed or the cluster is unreachable
— the module JS handles that as "0 Kubernetes services".

Usage:
    python3 /usr/lib/sysdeck/bridge/mesh.py services
"""

import json
import subprocess
import sys


def services() -> dict:
    """Return Kubernetes services. Empty items list if kubectl absent or unreachable."""
    try:
        r = subprocess.run(
            ["kubectl", "get", "services", "-A", "-o", "json"],
            capture_output=True, text=True, check=True, timeout=10,
        )
        data = json.loads(r.stdout) if r.stdout.strip() else {}
        items = []
        for item in data.get("items", []):
            meta = item.get("metadata", {})
            spec = item.get("spec", {})
            items.append({
                "name": meta.get("name", ""),
                "namespace": meta.get("namespace", ""),
                "type": spec.get("type", ""),
                "clusterIP": spec.get("clusterIP", ""),
                "ports": [
                    f"{p.get('port')}/{p.get('protocol', 'TCP')}"
                    for p in spec.get("ports", [])
                ],
            })
        return {"items": items}
    except (FileNotFoundError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired, json.JSONDecodeError, OSError):
        return {"items": []}


COMMANDS = {
    "services": lambda _args: services(),
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
