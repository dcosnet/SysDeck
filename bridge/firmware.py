#!/usr/bin/env python3
"""
SysDeck - Firmware Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Aggregates fwupd device list with TPM 2.0 PCR registers into a single
JSON document so the JS panel can render both in one fetch.

Usage:
    python3 /usr/lib/sysdeck/bridge/firmware.py devices     # raw fwupdmgr output
    python3 /usr/lib/sysdeck/bridge/firmware.py summary     # devices + tpmPcr0 combined
"""

import json
import subprocess
import sys


def run(argv: list[str]) -> str:
    """Run a command, returning stdout. Returns '' on failure."""
    try:
        return subprocess.run(
            argv, capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def devices() -> dict:
    """Raw fwupdmgr device list as the JSON shape fwupd emits.

    Returns ``{"Devices": [...]}`` (capital D — matches fwupdmgr's own JSON
    schema, which is what the firmware.js panel reads via
    ``result.value?.Devices``). Returns ``{"Devices": []}`` when fwupdmgr
    is absent, fails, or emits invalid JSON, so the panel always gets a
    renderable shape.
    """
    fwupd_raw = run(["fwupdmgr", "get-devices", "--json"])
    try:
        parsed = json.loads(fwupd_raw) if fwupd_raw.strip() else {}
    except json.JSONDecodeError:
        parsed = {}
    # Normalize: callers expect the fwupdmgr "Devices" key. If fwupd
    # returned a different shape (older/newer versions, or an error blob),
    # fall back to an empty device list so the panel doesn't crash on
    # `undefined.map()`.
    if not isinstance(parsed, dict) or "Devices" not in parsed:
        return {"Devices": []}
    if not isinstance(parsed["Devices"], list):
        return {"Devices": []}
    return parsed


def summary() -> dict:
    """Return fwupd devices plus the first TPM PCR register.

    Kept for backwards compatibility with callers that fetch both pieces
    in one round-trip. New callers should prefer ``devices()`` (raw fwupd
    output, matches the panel's expected ``{Devices: [...]}`` shape) plus
    the bridge.js-side ``tpmInfo()`` direct ``tpm2_pcrread`` spawn.
    """
    fwupd = devices()
    tpm_pcr0 = run(["tpm2_pcrread", "sha256:0"]).strip() or "TPM2 tools not available"

    return {
        "devices": fwupd.get("Devices", []),
        "tpmPcr0": tpm_pcr0,
    }


COMMANDS = {
    "devices": lambda _args: devices(),
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
