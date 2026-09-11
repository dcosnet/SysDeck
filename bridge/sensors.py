#!/usr/bin/env python3
"""
SysDeck - Sensors Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Aggregates hardware sensor data from lm_sensors (`sensors -j`) and
the cockpit-sensors plugin (https://github.com/ocristopfer/cockpit-sensors)
into a structured JSON document.

cockpit-sensors is MIT licensed by ocristopfer. This bridge helper invokes
sensors as a separate process via subprocess — the suite (MIT) and
lm_sensors remain independent programs. No cockpit-sensors code is bundled;
the suite's panel provides its own rendering of the sensors data.

Usage:
    python3 -m sysdeck.bridge.sensors summary
    python3 -m sysdeck.bridge.sensors temps
    python3 -m sysdeck.bridge.sensors fans
    python3 -m sysdeck.bridge.sensors voltages
"""

import json
import subprocess
import sys
from typing import Any


SENSORS_LICENSE = "MIT (lm_sensors) + MIT (cockpit-sensors)"
SENSORS_AUTHOR = "ocristopfer (cockpit-sensors), lm_sensors project"
SENSORS_URL = "https://github.com/ocristopfer/cockpit-sensors"


def run_sensors(args: list[str]) -> str:
    """Run sensors with the given args, returning stdout."""
    return subprocess.run(
        ["sensors", *args], capture_output=True, text=True, check=True,
    ).stdout


def summary() -> dict[str, Any]:
    """Full sensor summary from `sensors -j`.

    Returns a nested dict: { adapter: { sensor: { field: value } } }
    """
    output = run_sensors(["-j"])
    return json.loads(output)


def temps() -> dict[str, Any]:
    """Temperature sensors only — filter for keys containing 'temp' or 'Core'."""
    data = summary()
    result: dict[str, Any] = {}
    for adapter, sensors in data.items():
        filtered = {
            key: val for key, val in sensors.items()
            if "temp" in key.lower() or "core" in key.lower() or "tctl" in key.lower()
        }
        if filtered:
            result[adapter] = filtered
    return result


def fans() -> dict[str, Any]:
    """Fan speed sensors only — filter for keys containing 'fan'."""
    data = summary()
    result: dict[str, Any] = {}
    for adapter, sensors in data.items():
        filtered = {
            key: val for key, val in sensors.items()
            if "fan" in key.lower()
        }
        if filtered:
            result[adapter] = filtered
    return result


def voltages() -> dict[str, Any]:
    """Voltage sensors only — filter for keys containing 'in' (lm_sensors convention)."""
    data = summary()
    result: dict[str, Any] = {}
    for adapter, sensors in data.items():
        filtered = {
            key: val for key, val in sensors.items()
            if key.startswith("in") or "vcore" in key.lower() or "vbat" in key.lower()
        }
        if filtered:
            result[adapter] = filtered
    return result


COMMANDS = {
    "summary": lambda _args: summary(),
    "temps": lambda _args: temps(),
    "fans": lambda _args: fans(),
    "voltages": lambda _args: voltages(),
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
