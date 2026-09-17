#!/usr/bin/env python3
"""
SysDeck - Vault Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Lists LUKS-encrypted block devices via `lsblk -J`. Returns an empty list
when no LUKS volumes are present or lsblk is unavailable — the module
JS handles that as "no LUKS volumes".

Usage:
    python3 /usr/lib/sysdeck/bridge/vault.py list-luks
"""

import json
import subprocess
import sys


def list_luks() -> list:
    """Return LUKS-encrypted block devices. Empty list if none or lsblk absent."""
    try:
        r = subprocess.run(
            ["lsblk", "-o", "NAME,FSTYPE,MOUNTPOINT,SIZE,TYPE", "-J"],
            capture_output=True, text=True, check=True, timeout=20,
        )
        data = json.loads(r.stdout) if r.stdout.strip() else {}
        devices = []
        for blk in data.get("blockdevices", []):
            def walk(node):
                if node.get("fstype") == "crypto_LUKS":
                    devices.append({
                        "name": node.get("name", ""),
                        "size": node.get("size", ""),
                        "mountpoint": node.get("mountpoint") or "",
                        "type": node.get("type", ""),
                    })
                for child in node.get("children", []) or []:
                    walk(child)
            walk(blk)
        return devices
    except (FileNotFoundError, subprocess.CalledProcessError, json.JSONDecodeError, OSError):
        return []


COMMANDS = {
    "list-luks": lambda _args: list_luks(),
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
