#!/usr/bin/env python3
"""
SysDeck - Benchmark Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Wraps system benchmark operations using sysbench and phoronix-test-suite,
with attribution to the cockpit-benchmark plugin
(https://github.com/ealier/cockpit-benchmark) which is MIT licensed
by ealier.

This bridge helper invokes benchmark tools as separate processes — the
suite (MIT) and sysbench (GPL-2.0) / phoronix-test-suite (GPL-3.0)
remain independent programs. No cockpit-benchmark code is bundled.

Usage:
    python3 -m sysdeck.bridge.benchmark list-tests
    python3 -m sysdeck.bridge.benchmark run-cpu
    python3 -m sysdeck.bridge.benchmark run-memory
    python3 -m sysdeck.bridge.benchmark run-io
    python3 -m sysdeck.bridge.benchmark phoronix-list
"""

import json
import re
import subprocess
import sys
from typing import Any


BENCHMARK_LICENSE = "MIT (cockpit-benchmark) + GPL-2.0 (sysbench)"
BENCHMARK_AUTHOR = "ealier (cockpit-benchmark), sysbench project"
BENCHMARK_URL = "https://github.com/ealier/cockpit-benchmark"


def run(argv: list[str]) -> str:
    """Run a command, returning stdout. Returns '' on failure."""
    try:
        return subprocess.run(
            argv, capture_output=True, text=True, check=True, timeout=300,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return ""


def list_tests() -> list[dict[str, str]]:
    """List available sysbench tests."""
    raw = run(["sysbench", "--help"])
    # Parse available test names from sysbench --help output.
    tests: list[dict[str, str]] = []
    known_tests = ["cpu", "memory", "fileio", "threads", "oltp_read_only", "oltp_write_only"]
    for name in known_tests:
        if name in raw:
            tests.append({"name": name, "tool": "sysbench"})
    return tests


def run_cpu() -> dict[str, Any]:
    """Run sysbench CPU benchmark and return structured results."""
    raw = run(["sysbench", "cpu", "run"])
    return _parse_sysbench(raw)


def run_memory() -> dict[str, Any]:
    """Run sysbench memory benchmark and return structured results."""
    raw = run(["sysbench", "memory", "run"])
    return _parse_sysbench(raw)


def run_io() -> dict[str, Any]:
    """Run sysbench file I/O benchmark and return structured results."""
    # Prepare test files first.
    run(["sysbench", "fileio", "prepare"])
    raw = run(["sysbench", "fileio", "run"])
    run(["sysbench", "fileio", "cleanup"])
    return _parse_sysbench(raw)


def run_test(args: list[str]) -> dict[str, Any]:
    """Run an arbitrary sysbench test by name.

    The benchmark.js panel lists tests returned by ``list-tests`` (cpu,
    memory, fileio, threads, oltp_read_only, oltp_write_only) and renders
    a "Run" button next to each. Clicking the button calls this helper
    with the test name as the first argument.

    Returns the parsed sysbench result (same shape as ``run_cpu`` etc.):
    ``{"raw": <str>, "events_per_sec": <float|None>, "latency_ms": <float|None>}``.
    On failure (sysbench absent or the test name unknown), the captured
    stderr is surfaced via the ``raw`` field so the panel can render a
    useful message instead of an opaque empty result.
    """
    if not args:
        return {
            "raw": "",
            "events_per_sec": None,
            "latency_ms": None,
            "error": "no test name provided",
        }
    test_name = args[0]
    # v0.1.4 SECURITY: the test name is passed to `sysbench <name> run`
    # as one argv element — a leading dash makes it an OPTION (e.g.
    # --config=…), so validate it as a plain identifier (the sysbench
    # builtin test vocabulary is cpu/memory/threads/mutex/fileio/oltp_*).
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", test_name) or test_name.startswith("-"):
        return {"raw": "", "events_per_sec": None, "latency_ms": None,
                "error": f"invalid sysbench test name: {test_name!r}"}
    # Some sysbench tests (fileio) require a prepare step before run.
    # We deliberately keep this simple — for arbitrary test names, just
    # invoke ``sysbench <name> run``. If the user wants fileio with
    # prepare/cleanup, they should use the dedicated run-io button.
    proc = subprocess.run(
        ["sysbench", test_name, "run"],
        capture_output=True, text=True, timeout=300,
    )
    raw = proc.stdout if proc.returncode == 0 else (
        proc.stdout + ("\n--- stderr ---\n" + proc.stderr if proc.stderr else "")
    )
    parsed = _parse_sysbench(raw)
    if proc.returncode != 0:
        parsed["error"] = f"sysbench exited {proc.returncode}"
    return parsed


def phoronix_list() -> list[dict[str, str]]:
    """List available Phoronix Test Suite benchmarks."""
    raw = run(["phoronix-test-suite", "list-tests"])
    return [
        {"name": line.strip(), "tool": "phoronix-test-suite"}
        for line in raw.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ][:20]  # Cap at 20 entries for display.


def _parse_sysbench(output: str) -> dict[str, Any]:
    """Parse sysbench text output into structured data."""
    result: dict[str, Any] = {"raw": output, "events_per_sec": None, "latency_ms": None}
    for line in output.splitlines():
        if "events per second:" in line.lower():
            try:
                result["events_per_sec"] = float(line.split(":")[-1].strip())
            except ValueError:
                pass
        if "avg:" in line.lower() and "latency_ms" not in result:
            parts = line.split()
            for i, p in enumerate(parts):
                if p == "avg:" and i + 1 < len(parts):
                    try:
                        result["latency_ms"] = float(parts[i + 1])
                    except ValueError:
                        pass
    return result


COMMANDS = {
    "list-tests": lambda _args: list_tests(),
    "run-cpu": lambda _args: run_cpu(),
    "run-memory": lambda _args: run_memory(),
    "run-io": lambda _args: run_io(),
    "run-test": lambda args: run_test(args),
    "phoronix-list": lambda _args: phoronix_list(),
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
