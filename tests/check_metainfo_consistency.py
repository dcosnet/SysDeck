#!/usr/bin/env python3
"""check-metainfo-consistency: validate packaging/sysdeck.metainfo.xml
against the real cockpit apps page contract.

Verified from the cockpit source code:
  - pkg/apps/watch-appstream.py:237 — reads `launchable` elements with type=="cockpit-manifest"
  - pkg/apps/utils.tsx:152         — matches launchable.type == "cockpit-manifest"
  - src/appstream/org.cockpit_project.cockpit_*.xml.in — all use <launchable>,
    NOT <provides><cockpit-manifest>

Previous versions of this test (v0.0.17-v0.0.20) validated the WRONG element:
they required <provides><cockpit-manifest>NAME</cockpit-manifest></provides>,
which is silently ignored by the cockpit apps page. The metainfo would pass
validation but the plugin would never appear in Cockpit's Applications menu.

This version requires <launchable type="cockpit-manifest">NAME</launchable>
elements — one per plugin — matching what the apps page actually reads.
"""
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def main() -> int:
    metainfo_path = Path("packaging/sysdeck.metainfo.xml")
    try:
        root = ET.parse(metainfo_path).getroot()
    except FileNotFoundError:
        print(f"FAIL: {metainfo_path} not found")
        return 1
    except ET.ParseError as e:
        print(f"FAIL: cannot parse {metainfo_path}: {e}")
        return 1

    errors = []

    if root.tag != "component":
        errors.append(f"root tag is <{root.tag}>, expected <component>")

    id_el = root.find("id")
    if id_el is None or not (id_el.text or "").strip():
        errors.append("missing or empty <id>")
    name_el = root.find("name")
    if name_el is None or not (name_el.text or "").strip():
        errors.append("missing or empty <name>")
    summary_el = root.find("summary")
    if summary_el is None or not (summary_el.text or "").strip():
        errors.append("missing or empty <summary>")

    # The CORRECT way to register a plugin with cockpit's apps page.
    # Verified from src/appstream/org.cockpit_project.cockpit_*.xml.in
    # and pkg/apps/watch-appstream.py:237.
    launchables = root.findall("launchable")
    if not launchables:
        errors.append(
            "missing <launchable type=\"cockpit-manifest\">NAME</launchable> — "
            "this is what the cockpit apps page reads to link the AppStream "
            "component to the corresponding Cockpit plugin. Pattern verified "
            "from src/appstream/org.cockpit_project.cockpit_networkmanager.xml.in."
        )
    else:
        for i, launch in enumerate(launchables):
            ltype = launch.get("type")
            if ltype != "cockpit-manifest":
                errors.append(
                    f"launchable[{i}].type={ltype!r} — must be 'cockpit-manifest'"
                )
            text = (launch.text or "").strip()
            if not text:
                errors.append(f"launchable[{i}] has empty text — must be the plugin's `name`")

    # Warn if the old wrong pattern is present.
    provides = root.find("provides")
    if provides is not None:
        cm = provides.find("cockpit-manifest")
        if cm is not None:
            errors.append(
                f"<provides><cockpit-manifest> found — this element is silently "
                f"ignored by the cockpit apps page (verified from pkg/apps/utils.tsx:152, "
                f"which only reads launchable.type == 'cockpit-manifest'). "
                f"Remove <provides> and use <launchable type=\"cockpit-manifest\"> instead. "
                f"See src/appstream/org.cockpit_project.cockpit_*.xml.in for the pattern."
            )

    if errors:
        print(f"FAIL: {metainfo_path} has structural problems:")
        for e in errors:
            print(f"  - {e}")
        return 1

    print(f'    OK: {metainfo_path} has valid <component> structure')
    print(f'    OK: declares {len(launchables)} <launchable type="cockpit-manifest"> entries')
    return 0


if __name__ == "__main__":
    sys.exit(main())
