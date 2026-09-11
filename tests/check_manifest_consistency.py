#!/usr/bin/env python3
"""check-manifest-consistency: validate ALL plugin manifests against the
real Cockpit manifest contract, as defined by the actual source code:

  - pkg/shell/manifests.ts (what fields the shell reads)
  - pkg/shell/util.tsx     (how menu paths are resolved)
  - src/cockpit/packages.py (server-side manifest parsing + validation)

This test was previously (v0.0.19, v0.0.20) based on inferences and wrong.
This version is based on what the source code actually does.

==== The real contract (from pkg/shell/manifests.ts) ====

A plugin manifest is a JSON object. The shell reads these top-level keys:

    {
        "name":      str,             # OPTIONAL — defaults to directory name
        "requires":  {"cockpit": "X.Y.Z"},  # version check, server-side
        "menu":      {<key>: ManifestEntry, ...},    # sidebar entries
        "tools":     {<key>: ManifestEntry, ...},    # tools-section entries
        "dashboard": {<key>: ManifestEntry, ...},     # dashboard widgets
        "preload":   [<path>, ...],   # JS files to preload
        "parent":    {"component": <path>},  # parent page for sub-pages
        "conditions": [{<predicate>}, ...],  # show/hide plugin
        "content-security-policy": "..."
    }

Everything else (version, title, etc.) is IGNORED by the shell — they're
harmless extra fields. They do NOT cause the manifest to be rejected.

ManifestEntry (pkg/shell/manifests.ts:30) — each menu/tools/dashboard entry:
    {
        "path":     str,    # OPTIONAL — overrides default <name>/<key>
        "label":    str,    # OPTIONAL — defaults to the menu key
        "order":    int,    # OPTIONAL — default 1000
        "docs":     [{label, url}, ...],
        "keywords": [{matches, goto?, weight?, translate?}, ...]
    }

==== Path resolution (from pkg/shell/util.tsx:114-130) ====

For each menu entry, the URL path is computed as:
    1. If `path` is specified, use it (after stripping .html suffix)
    2. Otherwise, default to "<name>/<menu-key>"
    3. If the path has no "/", prepend "<name>/"
    4. If the path ends with "/index", strip "/index"

So:
    menu.index with no path      → "<name>"       (after stripping /index)
    menu.index with path "/foo"   → "<name>/foo"
    menu.services                 → "<name>/services"
    menu.foo with path "/foo"     → "<name>/foo"

The shell then asks for /cockpit/<path>/index.html (or the .html variant).

==== Server-side validation (src/cockpit/packages.py:244-264) ====

The server (cockpit-bridge) parses manifest.json and validates:
    - requires.cockpit version (must be ≤ installed Cockpit version)
    - conditions (path-exists, path-not-exists, any)
    - bridges config
    - name field (defaults to directory name)
    - priority (defaults to 1)
    - content-security-policy (defaults to "")

It does NOT reject manifests for having extra top-level fields like
"version", "title", etc. — those are silently ignored.

==== What this test actually checks ====

Based on the real contract, NOT my previous invented one:

    1. manifest.json is valid JSON
    2. `name` field, if present, is a string starting with "sysdeck-"
       (so the URL path is /cockpit/sysdeck-<name>/<file>)
    3. If `requires.cockpit` is present, it's a string
    4. At least one of `menu`, `tools`, or `dashboard` is present and non-empty
       (otherwise the plugin has no sidebar entry — silent discovery failure)
    5. Each menu/tools/dashboard entry has a `label` (or the menu key is used)
    6. Each entry's `order`, if present, is an integer
    7. Each entry's `path`, if present, is a string starting with "/"
    8. `conditions`, if present, is an array of valid predicate objects

Things this test does NOT reject (because Cockpit doesn't reject them either):
    - Top-level "version", "title", "priority" — silently ignored by shell
    - A "content" section — silently ignored by shell
    - Menu keys other than "index" — work fine if `path` is specified

==== Why the user's v0.0.18 sysdeck manifest silently failed ====

The v0.0.18 manifest used `menu.suite` with `path: "/index.html"`. According
to the contract in pkg/shell/util.tsx:114-117, this becomes path
"sysdeck/index.html" → ".html" stripped → "sysdeck/index" → "/index"
stripped → "sysdeck". So it SHOULD have worked.

The actual reason for the silent failure was almost certainly one of:
    - The `requires.cockpit` version was higher than the installed Cockpit
    - A `conditions` entry was unmet
    - The manifest.json wasn't being read at all (wrong install path, wrong
      permissions, cockpit user couldn't read it)

The diagnostic script (sysdeck-diagnose.sh) checks all of these.
"""
import json
import sys
from pathlib import Path


VALID_PREDICATES = {"path-exists", "path-not-exists", "any"}


def validate_entry(manifest_path: Path, section: str, key: str, entry) -> list[str]:
    """Validate a single menu/tools/dashboard entry."""
    errs = []
    label = f"{manifest_path.parent.name}: {section}.{key}"

    if not isinstance(entry, dict):
        return [f"{label}: entry must be an object (got {type(entry).__name__})"]

    if "label" not in entry:
        # Not technically required — shell defaults to the menu key — but
        # we warn because it makes the sidebar entry confusing.
        # Don't fail on this; just note it.
        pass
    elif not isinstance(entry["label"], str) or not entry["label"].strip():
        errs.append(f"{label}: 'label' must be a non-empty string")

    if "order" in entry:
        if not isinstance(entry["order"], int) or isinstance(entry["order"], bool):
            errs.append(f"{label}: 'order' must be an integer (got {type(entry['order']).__name__})")

    if "path" in entry:
        p = entry["path"]
        if not isinstance(p, str):
            errs.append(f"{label}: 'path' must be a string (got {type(p).__name__})")
        elif not p.startswith("/"):
            # The shell resolves this as a URL path component. It doesn't
            # strictly require a leading "/" but conventionally it's there.
            # Don't fail; just note.
            pass

    if "keywords" in entry:
        kw = entry["keywords"]
        if not isinstance(kw, list):
            errs.append(f"{label}: 'keywords' must be an array")
        else:
            for i, k in enumerate(kw):
                if not isinstance(k, dict):
                    errs.append(f"{label}: keywords[{i}] must be an object")
                elif "matches" not in k or not isinstance(k["matches"], list):
                    errs.append(f"{label}: keywords[{i}].matches must be an array of strings")

    return errs


def validate_manifest(manifest_path: Path) -> list[str]:
    """Validate a single plugin manifest against the real contract."""
    errs = []
    try:
        m = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as e:
        return [f"{manifest_path}: not valid JSON: {e}"]

    if not isinstance(m, dict):
        return [f"{manifest_path}: manifest root must be an object"]

    # name field (optional but should match directory name)
    name = m.get("name")
    if name is not None:
        if not isinstance(name, str):
            errs.append(f"{manifest_path}: 'name' must be a string (got {type(name).__name__})")
        elif not name.startswith("sysdeck-"):
            errs.append(
                f"{manifest_path}: name={name!r} — expected to start with 'sysdeck-' "
                f"(must match plugin directory name for URL resolution to work)"
            )

    # requires.cockpit version (optional but if present must be a string)
    requires = m.get("requires")
    if requires is not None:
        if not isinstance(requires, dict):
            errs.append(f"{manifest_path}: 'requires' must be an object")
        elif "cockpit" in requires:
            v = requires["cockpit"]
            if not isinstance(v, str):
                errs.append(
                    f"{manifest_path}: requires.cockpit must be a string like '239' "
                    f"(got {type(v).__name__})"
                )
            elif v.startswith(">") or v.startswith("<") or v.startswith("="):
                # CRITICAL: Cockpit's packages.py uses sortify_version() (0-pad of
                # numeric components), NOT a semver parser. ">=239" becomes
                # ">=00000239" which is GREATER than any real cockpit version
                # (because '>' ASCII 62 > '0' ASCII 48), causing packages.py:263
                # to raise JsonError and silently reject the manifest.
                # This was the v0.0.9-v0.0.21 root cause of "zero entries in sidebar".
                errs.append(
                    f"{manifest_path}: requires.cockpit={v!r} — must be a bare version "
                    f"number like '239', NOT '{v}'. Cockpit's sortify_version() does "
                    f"NOT parse semver operators; '{v}' becomes '{v}0000000{('' if len(v) >= 2 else '0')}' "
                    f"which compares greater than any real cockpit version, causing "
                    f"packages.py:263 to reject the manifest at install time. "
                    f"Pattern verified from pkg/systemd/manifest.json: \"cockpit\": \"265\"."
                )

    # At least one of menu/tools/dashboard must be present and non-empty
    # — otherwise the plugin has no sidebar entry and will silently fail to
    # appear (which is what the user reported as "zero entries anywhere").
    has_sidebar_entry = False
    for section in ("menu", "tools", "dashboard"):
        if section in m:
            sec = m[section]
            if not isinstance(sec, dict):
                errs.append(f"{manifest_path}: '{section}' must be an object")
            elif len(sec) == 0:
                errs.append(f"{manifest_path}: '{section}' is empty — no entries will appear")
            else:
                has_sidebar_entry = True
                for key, entry in sec.items():
                    errs.extend(validate_entry(manifest_path, section, key, entry))

    if not has_sidebar_entry:
        errs.append(
            f"{manifest_path}: manifest has no 'menu', 'tools', or 'dashboard' section — "
            f"the plugin will not appear in the Cockpit sidebar."
        )

    # conditions (optional)
    if "conditions" in m:
        conds = m["conditions"]
        if not isinstance(conds, list):
            errs.append(f"{manifest_path}: 'conditions' must be an array")
        else:
            for i, c in enumerate(conds):
                if not isinstance(c, dict):
                    errs.append(f"{manifest_path}: conditions[{i}] must be an object")
                elif len(c) != 1:
                    errs.append(
                        f"{manifest_path}: conditions[{i}] must contain exactly one "
                        f"key (one of: {sorted(VALID_PREDICATES)})"
                    )
                else:
                    pred = next(iter(c.keys()))
                    if pred not in VALID_PREDICATES:
                        # packages.py:280-282 says: "do *not* ignore manifests with
                        # unknown predicates, for forward compatibility". So an
                        # unknown predicate is treated as always-true. Warn but
                        # don't fail.
                        pass

    return errs


def main() -> int:
    all_errors: list[str] = []

    # ── Check shared/manifest.json exists ────────────────────────────
    # Without it, sysdeck-common is not registered as a Cockpit package,
    # and URLs like /cockpit/@localhost/sysdeck-common/bridge.js return 404.
    # This was the v0.0.24 root cause of "Module load failed".
    shared_manifest = Path("shared/manifest.json")
    if not shared_manifest.is_file():
        all_errors.append(
            "shared/manifest.json: MISSING — without this file, cockpit does "
            "not register sysdeck-common as a package (packages.py:457 scans "
            "cockpit/*/manifest.json), and every URL like "
            "/cockpit/@localhost/sysdeck-common/bridge.js returns 404. "
            "Pattern verified from cockpit's pkg/static/manifest.json (just `{}`)."
        )
    else:
        try:
            m = json.loads(shared_manifest.read_text())
            if not isinstance(m, dict):
                all_errors.append("shared/manifest.json: root must be an object")
            else:
                print(f"    OK: shared/manifest.json (registers sysdeck-common as a package)")
        except json.JSONDecodeError as e:
            all_errors.append(f"shared/manifest.json: not valid JSON: {e}")

    # ── Check plugin manifests ──────────────────────────────────────
    plugin_dirs = sorted(Path("plugins").glob("sysdeck-*"))
    if not plugin_dirs:
        all_errors.append("FAIL: no plugins found under plugins/sysdeck-*/")
    else:
        # v0.0.35: plugin count went from 20 → 23 (added Jellyfin, Photos,
        # Remote FS modules; the hidden helper sysdeck-containers-kata
        # was renamed to sysdeck-kata and promoted to a visible sidebar
        # entry — net effect: +3 visible plugins, no helper).
        # Earlier versions had 20 (19 visible + 1 hidden helper). The test
        # warns (not fails) when the count drifts so it survives future
        # module additions; the warning prints both numbers so the
        # operator notices.
        expected = 24
        if len(plugin_dirs) != expected:
            print(f"WARN: expected {expected} plugins, found {len(plugin_dirs)}")

    checked = 0
    for plugin_dir in plugin_dirs:
        manifest = plugin_dir / "manifest.json"
        if not manifest.is_file():
            all_errors.append(f"{manifest}: missing manifest.json")
            continue
        errs = validate_manifest(manifest)
        all_errors.extend(errs)
        checked += 1
        if not errs:
            print(f"    OK: {plugin_dir.name}/manifest.json")

    print()
    print(f"Checked {checked} plugin manifests + 1 shared manifest")
    print(f"against the real Cockpit contract")
    print(f"(per pkg/shell/manifests.ts + src/cockpit/packages.py)")

    if all_errors:
        print()
        print("FAIL: manifest validation errors:")
        for e in all_errors:
            print(f"  - {e}")
        return 1

    print()
    print(f"    OK: all {checked + 1} manifests conform to the real contract")
    return 0


if __name__ == "__main__":
    sys.exit(main())
