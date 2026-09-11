#!/usr/bin/env python3
"""
tests/check_bridge_subcommands.py

Cross-checks shared/bridge.js's exposed `bridge.<module>.<method>()` calls
against the actual COMMANDS dict declared in each bridge/<module>.py helper.

This guard exists because of the v0.0.27 bug where:
  - bridge.js exposed `bridge.firmware.devices()` calling
    `python3 firmware.py devices`, but firmware.py only implemented
    `summary`. Every firmware plugin page crashed.
  - bridge.js exposed `bridge.benchmark.runTest(name)` calling
    `python3 benchmark.py run-test <name>`, but benchmark.py had no
    `run-test` subcommand. Clicking "Run" on any test in the Available
    Tests table errored out.

Both bugs shipped through `make check` because the existing guards
(manifest consistency, metainfo consistency, Makefile recipes, version
sync, broken-import patterns) never cross-referenced the JS bridge
surface against the Python helper surfaces. This script does that.

Strategy:
  1. Parse shared/bridge.js with a regex that finds every
     `bridgeCmd("<module>", ["<subcommand>", ...])` call.
  2. For each <module>, parse bridge/<module>.py with the ast module
     and extract the keys of its COMMANDS dict (or, for helpers without
     a COMMANDS dict, fall back to scanning main()'s argv[0] checks).
  3. Verify every subcommand the JS expects actually exists in the
     Python helper's dispatch table.

Exits non-zero with a clear message naming the bad file + call on failure.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRIDGE_JS = ROOT / "shared" / "bridge.js"
BRIDGE_DIR = ROOT / "bridge"


def extract_bridge_cmd_calls(js_source: str) -> list[tuple[str, str, int]]:
    """Return [(module, subcommand, line_no), ...] for every bridgeCmd() call.

    The bridge.js bridgeCmd helper signature is:

        bridgeCmd(module, args = [], options = {})

    where args is an array literal whose first element is a string literal
    naming the subcommand. Examples we want to match:

        bridgeCmd("containers", ["list"])
        bridgeCmd("firewall", ["ruleset"])
        bridgeCmd("packages", ["search", q])
        bridgeCmd("benchmark", ["run-test", name], { superuser: true })

    We deliberately only match the first-array-element string literal — if
    a future bridge.js author computes the subcommand dynamically, we can't
    statically verify it, and we just skip that call (rather than failing).
    """
    pattern = re.compile(
        r'bridgeCmd\(\s*'                       # bridgeCmd(
        r'["\']([^"\']+)["\']\s*,\s*'            # "module"
        r'\[\s*["\']([^"\']+)["\']'              # ["subcommand"
        , re.MULTILINE
    )
    calls: list[tuple[str, str, int]] = []
    for match in pattern.finditer(js_source):
        line_no = js_source.count('\n', 0, match.start()) + 1
        calls.append((match.group(1), match.group(2), line_no))
    return calls


def extract_python_commands(py_path: Path) -> tuple[set[str], str]:
    """Return (subcommand_set, source_kind) for a bridge/<module>.py file.

    source_kind is one of:
      'COMMANDS dict'   — module has a COMMANDS = {...} dict at module level
      'main argv'       — module's main() does explicit argv[0] == "..." checks
      'none'            — neither; we can't statically determine subcommands
    """
    source = py_path.read_text(encoding="utf-8")
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        print(f"FAIL: {py_path.name}: Python syntax error: {exc}",
              file=sys.stderr)
        sys.exit(1)

    # Look for a top-level `COMMANDS = { ... }` assignment.
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if getattr(target, 'id', None) == 'COMMANDS':
                    if isinstance(node.value, ast.Dict):
                        keys: set[str] = set()
                        for k in node.value.keys:
                            if isinstance(k, ast.Constant) and isinstance(k.value, str):
                                keys.add(k.value)
                        return keys, 'COMMANDS dict'
                    if isinstance(node.value, ast.Call):
                        # Dynamic — can't statically extract.
                        return set(), 'none'

    # Fall back: scan main()'s body for `if argv[0] == "X":` patterns.
    subcommands: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare):
            # Match: argv[0] == "summary"
            if (isinstance(node.left, ast.Subscript)
                    and isinstance(node.left.value, ast.Name)
                    and node.left.value.id == 'argv'
                    and len(node.ops) == 1
                    and isinstance(node.ops[0], ast.Eq)
                    and len(node.comparators) == 1
                    and isinstance(node.comparators[0], ast.Constant)
                    and isinstance(node.comparators[0].value, str)):
                subcommands.add(node.comparators[0].value)
    if subcommands:
        return subcommands, 'main argv'
    return set(), 'none'


def main() -> int:
    if not BRIDGE_JS.is_file():
        print(f"FAIL: {BRIDGE_JS} not found", file=sys.stderr)
        return 1

    js_source = BRIDGE_JS.read_text(encoding="utf-8")
    calls = extract_bridge_cmd_calls(js_source)
    if not calls:
        print("FAIL: no bridgeCmd() calls found in shared/bridge.js — "
              "the bridge surface is empty or the regex is stale.",
              file=sys.stderr)
        return 1

    # Build module → set(subcommands) map from the Python side.
    py_subcommands: dict[str, tuple[set[str], str]] = {}
    for py_file in sorted(BRIDGE_DIR.glob("*.py")):
        if py_file.name == "__init__.py":
            continue
        subs, kind = extract_python_commands(py_file)
        py_subcommands[py_file.stem] = (subs, kind)

    failures: list[str] = []
    checked = 0
    for module, subcommand, line_no in sorted(set(calls)):
        py_path = BRIDGE_DIR / f"{module}.py"
        if not py_path.is_file():
            failures.append(
                f"shared/bridge.js:{line_no}: bridgeCmd(\"{module}\", "
                f"[\"{subcommand}\", ...]) — no bridge/{module}.py file exists."
            )
            continue
        subs, kind = py_subcommands.get(module, (set(), 'none'))
        if kind == 'none':
            # Helper has no static dispatch table (e.g. db.py, hwalert.py).
            # We can't verify the call — skip rather than fail.
            continue
        if subcommand not in subs:
            failures.append(
                f"shared/bridge.js:{line_no}: bridgeCmd(\"{module}\", "
                f"[\"{subcommand}\", ...]) — bridge/{module}.py does not "
                f"expose a \"{subcommand}\" subcommand. Its COMMANDS dict "
                f"has: {sorted(subs) or '(empty)'}."
            )
        checked += 1

    if failures:
        print("FAIL: bridge.js calls Python subcommands that don't exist:",
              file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        print(file=sys.stderr)
        print("To fix: either add the missing subcommand to the Python "
              "helper's COMMANDS dict, or change the bridge.js call to use "
              "a subcommand that exists.", file=sys.stderr)
        return 1

    print(f"OK: {checked} bridge.js calls verified against Python "
          f"COMMANDS dicts across {len(py_subcommands)} bridge modules.")
    print("    All bridgeCmd() subcommands resolve to a real Python "
          "dispatch entry.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
