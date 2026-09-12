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

Sensor chain (same step-down the web bridge runs):
    `sensors -j` (lm-sensors)  →  raw /sys/class/hwmon + thermal zones  →
    honest empty. lm-sensors is the preferred rung (chip-level labels);
    sysfs is the dependency-free rung; a host with no readable sensors
    returns an empty document, never fabricated readings.

Usage:
    python3 -m sysdeck.bridge.sensors summary
    python3 -m sysdeck.bridge.sensors temps
    python3 -m sysdeck.bridge.sensors fans
    python3 -m sysdeck.bridge.sensors voltages
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


SENSORS_LICENSE = "MIT (lm_sensors) + MIT (cockpit-sensors)"
SENSORS_AUTHOR = "ocristopfer (cockpit-sensors), lm_sensors project"
SENSORS_URL = "https://github.com/ocristopfer/cockpit-sensors"

# Scrubbed child environment: parsed output stays locale-stable and no
# console process state leaks into children.
SCRUBBED_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}


def run_sensors(args: list[str]) -> str | None:
    """Run sensors with the given args, returning stdout; None when the
    binary is absent or fails (the caller steps down to sysfs)."""
    if not shutil.which("sensors"):
        return None
    try:
        r = subprocess.run(
            ["sensors", *args], capture_output=True, text=True, check=False,
            timeout=10, env=SCRUBBED_ENV,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    return r.stdout if r.returncode == 0 else None


# ── sysfs rung (what lm-sensors reads under the hood) ────────────────

_INPUT_RE = re.compile(r"^(temp|fan|in)(\d+)_input$")


def _read_str(path: Path) -> str | None:
    try:
        return path.read_text().strip() or None
    except OSError:
        return None


def _read_num(path: Path) -> float | None:
    raw = _read_str(path)
    if raw is None:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def sysfs_adapters() -> dict[str, dict[str, Any]]:
    """Raw /sys/class/hwmon readings in the sensors -j shape:
    { adapter: { sensor_key: {"input": v, ...} } }."""
    out: dict[str, dict[str, Any]] = {}
    hwmon_root = Path("/sys/class/hwmon")
    try:
        chips = sorted(hwmon_root.iterdir())
    except OSError:
        return out
    for chip in chips:
        name = _read_str(chip / "name") or chip.name
        adapter: dict[str, Any] = {}
        try:
            files = sorted(f.name for f in chip.iterdir())
        except OSError:
            continue
        for fname in files:
            m = _INPUT_RE.match(fname)
            if not m:
                continue
            kind, idx = m.group(1), m.group(2)
            raw = _read_num(chip / fname)
            if raw is None:
                continue
            label = _read_str(chip / f"{kind}{idx}_label") or f"{kind}{idx}"
            entry: dict[str, Any] = {}
            if kind == "temp":
                entry["temp1_input"] = round(raw / 1000.0, 1)
                crit = _read_num(chip / f"{kind}{idx}_crit")
                if crit is not None:
                    entry["temp1_crit"] = round(crit / 1000.0, 1)
            elif kind == "fan":
                entry["fan1_input"] = int(raw)
            else:
                entry["in0_input"] = round(raw / 1000.0, 3)
            adapter[label] = entry
        if adapter:
            out[name] = adapter
    return out


def thermal_zones() -> dict[str, dict[str, Any]]:
    """ACPI thermal zones as temperature adapters."""
    out: dict[str, dict[str, Any]] = {}
    root = Path("/sys/class/thermal")
    try:
        zones = sorted(z for z in root.iterdir() if z.name.startswith("thermal_zone"))
    except OSError:
        return out
    for z in zones:
        temp = _read_num(z / "temp")
        if temp is None:
            continue
        ztype = _read_str(z / "type") or z.name
        out[f"{ztype} (thermal_zone)"] = {ztype: {"temp1_input": round(temp / 1000.0, 1)}}
    return out


def summary() -> dict[str, Any]:
    """Full sensor summary.

    Chain: `sensors -j` → sysfs hwmon + thermal zones → honest empty.
    Returns a nested dict: { adapter: { sensor: { field: value } } }"""
    output = run_sensors(["-j"])
    if output is not None:
        try:
            data = json.loads(output)
            if data:
                return data
            # sensors present but no chips configured → sysfs rung, labeled
            sysfs = {**sysfs_adapters(), **thermal_zones()}
            return {"_note": "sensors -j returned no chips (run sensors-detect); showing raw sysfs readings", **sysfs}
        except json.JSONDecodeError:
            pass
    return {**sysfs_adapters(), **thermal_zones()}


def _filtered(predicate) -> dict[str, Any]:
    data = summary()
    result: dict[str, Any] = {}
    for adapter, sensors in data.items():
        filtered = {key: val for key, val in sensors.items() if predicate(key)}
        if filtered:
            result[adapter] = filtered
    return result


def temps() -> dict[str, Any]:
    """Temperature sensors only — filter for keys containing 'temp' or 'Core'."""
    return _filtered(
        lambda key: "temp" in key.lower() or "core" in key.lower() or "tctl" in key.lower()
    )


def fans() -> dict[str, Any]:
    """Fan speed sensors only — filter for keys containing 'fan'."""
    return _filtered(lambda key: "fan" in key.lower())


def voltages() -> dict[str, Any]:
    """Voltage sensors only — filter for keys containing 'in' (lm_sensors convention)."""
    return _filtered(
        lambda key: key.startswith("in") or "vcore" in key.lower() or "vbat" in key.lower()
    )


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
