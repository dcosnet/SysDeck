#!/usr/bin/env python3
"""Smoke-test the modules3p bridge without touching the system."""
import json
import subprocess
import os
import sys

BRIDGE = os.path.join(os.path.dirname(__file__), "..", "bridge", "modules3p.py")
BRIDGE = os.path.abspath(BRIDGE)

def run(args):
    r = subprocess.run(["python3", BRIDGE, *args], capture_output=True, text=True)
    out = None
    if r.stdout:
        try:
            out = json.loads(r.stdout)
        except json.JSONDecodeError:
            out = r.stdout
    return r.returncode, out, r.stderr

failures = 0
checks = 0

# 1. catalog returns a list and each entry has the mandatory fields
rc, cat, _ = run(["catalog"])
assert rc == 0, f"catalog rc={rc}"
assert isinstance(cat, list) and len(cat) >= 10, f"catalog len={len(cat)}"
mandatory = {"id", "name", "blurb", "license", "author", "source", "category", "kind", "install_spec"}
for e in cat:
    checks += 1
    missing = mandatory - set(e.keys())
    assert not missing, f"entry {e.get('id')} missing fields: {missing}"
print(f"[ok] catalog: {len(cat)} entries, all have mandatory fields")

# 2. status returns installed/missing_deps booleans
rc, st, _ = run(["status"])
assert st is not None and isinstance(st, list), f"status returned non-list: {st}"
assert len(st) == len(cat), f"status len={len(st)} != catalog len={len(cat)}"
for e in st:
    checks += 1
    assert "installed" in e and "missing_deps" in e, f"status entry missing fields: {e}"
print(f"[ok] status: {len(st)} entries with installed + missing_deps")

# 3. preflight for every catalog entry
for e in cat:
    checks += 1
    rc, pf, _ = run(["preflight", e["id"]])
    assert rc == 0, f"preflight {e['id']} rc={rc} stderr={_}"
    assert pf["ok"], f"preflight {e['id']} not ok: {pf}"
    # The disclosure MUST contain license + author + source + install plan
    assert pf["license"] == e["license"], f"license mismatch for {e['id']}"
    assert pf["author"] == e["author"]
    assert pf["source"] == e["source"]
    assert isinstance(pf["install_plan"], list) and len(pf["install_plan"]) >= 1
    assert "credit_line" in pf and e["license"] in pf["credit_line"]
print(f"[ok] preflight: every catalog entry returns license + credit + install_plan BEFORE pull")

# 4. install WITHOUT --accept-license is refused for every entry
for e in cat:
    checks += 1
    rc, r, _ = run(["install", e["id"]])
    # rc=1 because ok=false, but the JSON should be valid
    try:
        d = json.loads(r) if isinstance(r, str) else r
    except Exception:
        d = None
    # Some entries might already be installed and return ok=true; that's fine.
    # We only care that NOT-installed entries refuse without --accept-license.
    if d and d.get("status") == "already-installed":
        continue
    assert d and d.get("ok") is False and d.get("error") == "license-not-accepted", \
        f"install {e['id']} without --accept-license should refuse; got: {d}"
print(f"[ok] install: every non-installed entry refuses without --accept-license=1")

# 5. unknown id returns ok=false
rc, r, _ = run(["preflight", "does-not-exist"])
checks += 1
assert r["ok"] is False and "unknown" in r["error"]
print(f"[ok] preflight: unknown id returns ok=false")

# 6. audit returns a list (path may not exist — that's fine)
rc, a, _ = run(["audit"])
checks += 1
assert a["ok"] and "records" in a and isinstance(a["records"], list)
print(f"[ok] audit: returns {len(a['records'])} records from {a['path']}")

print(f"\nALL {checks} CHECKS PASSED")
sys.exit(failures)
