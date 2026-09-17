#!/usr/bin/env python3
"""
SysDeck - Integrity Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Runs lynis audit system and parses the hardening index from the report.

Usage:
    python3 -m sysdeck.bridge.integrity score
    python3 -m sysdeck.bridge.integrity scan
"""

import json
import re
import subprocess
import sys
from typing import Any

HARDENING_RE = re.compile(r"Hardening index\s*:\s*(\d+)")


def score() -> int | None:
    """Return the latest hardening index, or None if lynis hasn't run."""
    try:
        with open("/var/log/lynis.log", encoding="utf-8") as f:
            log = f.read()
    except FileNotFoundError:
        return None
    m = HARDENING_RE.search(log)
    return int(m.group(1)) if m else None


def scan() -> dict[str, Any]:
    """Run a fresh lynis audit and return the parsed result."""
    # A lynis audit runs for minutes by design; 15 minutes is the hard
    # ceiling so a wedged audit cannot hang the bridge forever.
    try:
        subprocess.run(
            ["lynis", "audit", "system"], capture_output=True, text=True, check=True,
            timeout=900,
        )
    except subprocess.TimeoutExpired:
        return {"error": "lynis audit timed out after 900s", "score": None}
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        return {"error": str(exc), "score": None}
    return {"score": score()}


COMMANDS = {
    "score": lambda _args: score(),
    "scan": lambda _args: scan(),
}


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd = COMMANDS.get(argv[0])
    if not cmd:
        print(f"Unknown subcommand: {argv[0]}", file=sys.stderr)
        return 2
    print(json.dumps(cmd(argv[1:])))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
