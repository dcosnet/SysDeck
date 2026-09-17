#!/usr/bin/env python3
"""
SysDeck - Theme Engine Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

1999 POWER-TOOL STYLE: maximum UI control over every theme surface.
The Theme Engine panel surfaces
the full set of cockpit.conf theming knobs plus a preset gallery
and live-preview CSS-variable overrides.

Subcommands:
  read-config            — read /etc/cockpit/cockpit.conf as text
  write-config <text>    — write the full cockpit.conf text (superuser)
  get <section> [key]    — get one section or one key from cockpit.conf
  set <section> <key> <value> — set one key (superuser)
  unset <section> <key>  — remove one key (superuser)
  reset                  — delete cockpit.conf entirely (superuser)
                           (cockpit falls back to its built-in defaults)
  preset-list            — return the built-in preset gallery
  preset-apply <id>      — apply one preset (writes cockpit.conf)
  variable-list          — return the SysDeck CSS variable surface
                           (the --sysdeck-* custom properties in
                           shared/sysdeck.css that the panel can
                           override live via CSS-variable setter)
  variable-get <name>    — read a CSS variable's current value
                           (from /var/lib/sysdeck/themes/overrides.css)
  variable-set <name> <value> — write a CSS variable override
                           (writes to /var/lib/sysdeck/themes/
                           overrides.css; the panel injects the file
                           as a <link> at runtime)
  variable-reset         — clear all CSS variable overrides

Cockpit way: the bridge runs subprocess directly; the JS panel passes
{ superuser: 'try' } for mutating ops so the cockpit bridge prompts
via polkit for the org.sysdeck.system.manage action (shipped since
v0.0.17 — authorizes /usr/bin/systemctl, /usr/bin/hostnamectl, etc.).

Cockpit's theming surface is /etc/cockpit/cockpit.conf's [Brand],
[Theme], [OAuth], [Session], [LogFilter], [HealthConfig], and
[PrettyEnv] sections — see `man cockpit.conf`. SysDeck's own theming
surface is the CSS variables in shared/sysdeck.css — those can be
overridden live without a server round-trip via the variable-*
subcommands.

Usage:
    python3 /usr/lib/sysdeck/bridge/themes.py read-config
    python3 /usr/lib/sysdeck/bridge/themes.py set Brand Color red
    python3 /usr/lib/sysdeck/bridge/themes.py preset-apply midnight
    python3 /usr/lib/sysdeck/bridge/themes.py variable-set --sysdeck-bg '#1a1a2a'
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


COCKPIT_CONF = Path("/etc/cockpit/cockpit.conf")
SYSDECK_THEME_DIR = Path("/var/lib/sysdeck/themes")
SYSDECK_OVERRIDES_FILE = SYSDECK_THEME_DIR / "overrides.css"

# Built-in preset gallery. Each entry is a complete cockpit.conf
# [Brand]/[Theme] snippet plus a set of CSS variable overrides.
# Operators can drop additional presets as JSON files into
# /var/lib/sysdeck/themes/presets/*.json — the preset-list subcommand
# discovers them automatically.
PRESETS: list[dict[str, Any]] = [
    {
        "id": "midnight",
        "name": "Midnight",
        "description": "Deep dark blue palette, soft cyan accent. Easy on the eyes at 3am.",
        "cockpit_conf": {"Brand": {"Color": "danger"}, "Theme": {"style": "dark"}},
        "css_variables": {
            "--sysdeck-bg": "#0f0f1a",
            "--sysdeck-fg": "#e0e0e0",
            "--sysdeck-accent": "#06c",
            "--sysdeck-card-bg": "#1a1a2a",
        },
    },
    {
        "id": "alpine",
        "name": "Alpine",
        "description": "Cool white-on-grey. Default-style with sharper contrast.",
        "cockpit_conf": {"Theme": {"style": "light"}},
        "css_variables": {
            "--sysdeck-bg": "#f5f5f5",
            "--sysdeck-fg": "#1a1a1a",
            "--sysdeck-accent": "#0066cc",
            "--sysdeck-card-bg": "#ffffff",
        },
    },
    {
        "id": "forest",
        "name": "Forest",
        "description": "Dark green palette for ops environments with red/green alert emphasis.",
        "cockpit_conf": {"Brand": {"Color": "success"}, "Theme": {"style": "dark"}},
        "css_variables": {
            "--sysdeck-bg": "#0f1a0f",
            "--sysdeck-fg": "#cfe0c0",
            "--sysdeck-accent": "#3c9",
            "--sysdeck-card-bg": "#1a2a1a",
        },
    },
    {
        "id": "amber",
        "name": "Amber",
        "description": "Warm dark amber palette — like a 1999 CRT terminal.",
        "cockpit_conf": {"Theme": {"style": "dark"}},
        "css_variables": {
            "--sysdeck-bg": "#1a0f00",
            "--sysdeck-fg": "#ffb000",
            "--sysdeck-accent": "#ff8c00",
            "--sysdeck-card-bg": "#2a1f00",
        },
    },
    {
        "id": "violet",
        "name": "Violet",
        "description": "Deep purple palette — neon-on-dark synthwave.",
        "cockpit_conf": {"Theme": {"style": "dark"}},
        "css_variables": {
            "--sysdeck-bg": "#1a0a2a",
            "--sysdeck-fg": "#e0d0ff",
            "--sysdeck-accent": "#9c3",
            "--sysdeck-card-bg": "#2a1a3a",
        },
    },
    {
        "id": "high-contrast",
        "name": "High Contrast",
        "description": "Black-on-white maximum contrast for accessibility.",
        "cockpit_conf": {"Theme": {"style": "light"}},
        "css_variables": {
            "--sysdeck-bg": "#ffffff",
            "--sysdeck-fg": "#000000",
            "--sysdeck-accent": "#0000ff",
            "--sysdeck-card-bg": "#ffffff",
            "--sysdeck-border": "#000000",
        },
    },
]

# The CSS-variable surface the panel can override live. Each entry:
# (name, kind, default, description). The 'kind' tells the JS panel
# which input control to render: 'color' → <input type=color>,
# 'select' → <select>, 'number' → <input type=number>, 'text' →
# <input type=text>.
CSS_VARIABLES: list[dict[str, Any]] = [
    {"name": "--sysdeck-bg",            "kind": "color",  "default": "#1e1e1e", "description": "Page background"},
    {"name": "--sysdeck-fg",            "kind": "color",  "default": "#e0e0e0", "description": "Primary text color"},
    {"name": "--sysdeck-muted",        "kind": "color",  "default": "#888888", "description": "Muted/secondary text"},
    {"name": "--sysdeck-accent",        "kind": "color",  "default": "#0066cc", "description": "Accent color for links/highlights"},
    {"name": "--sysdeck-accent-success","kind": "color", "default": "#33cc99", "description": "Success badge color"},
    {"name": "--sysdeck-accent-warn",  "kind": "color",  "default": "#f0ad4e", "description": "Warning badge color"},
    {"name": "--sysdeck-accent-danger","kind": "color",  "default": "#d9534f", "description": "Danger badge color"},
    {"name": "--sysdeck-border",       "kind": "color",  "default": "#444444", "description": "Card border color"},
    {"name": "--sysdeck-card-bg",      "kind": "color",  "default": "#2a2a2a", "description": "Card background color"},
    {"name": "--sysdeck-font-size-base","kind": "number","default": "14",      "description": "Base font size (px)"},
    {"name": "--sysdeck-density",       "kind": "select", "default": "normal",  "description": "Padding density",
     "options": ["compact", "normal", "comfortable"]},
    {"name": "--sysdeck-radius",        "kind": "number", "default": "6",       "description": "Card border radius (px)"},
]


# ── INI-style parser ─────────────────────────────────────────────────
#
# cockpit.conf is INI-format. Python's configparser handles it, but
# SysDeck needs to preserve comments and ordering when writing back.
# This minimal parser round-trips comments by treating them as part
# of the previous section's body. Good enough for the operator-facing
# theme panel — the bridge does not need a full INI library.

SECTION_RE = re.compile(r"^\[(?P<name>[^\]]+)\]\s*$")
KV_RE = re.compile(r"^\s*(?P<key>[^=\s]+)\s*=\s*(?P<val>.*)$")


def _parse_conf(text: str) -> dict[str, dict[str, str]]:
    """Parse cockpit.conf text into {section: {key: val}}.

    Comments (lines starting with # or ;) are stripped from the parsed
    structure; the operator can re-add them via the raw text editor.
    """
    sections: dict[str, dict[str, str]] = {}
    current: dict[str, str] = {}
    current_name = ""
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith(("#", ";")):
            continue
        m = SECTION_RE.match(line)
        if m:
            if current_name:
                sections[current_name] = current
            current_name = m.group("name")
            current = {}
            continue
        kv = KV_RE.match(line)
        if kv and current_name:
            current[kv.group("key")] = kv.group("val").strip()
    if current_name:
        sections[current_name] = current
    return sections


def _serialize_conf(sections: dict[str, dict[str, str]]) -> str:
    """Serialize the sections dict back to cockpit.conf text.

    Section order is preserved (Python 3.7+ dict is ordered). Within
    a section, key order is preserved.
    """
    lines: list[str] = ["# cockpit.conf — managed by SysDeck Theme Engine"]
    for section, kvs in sections.items():
        lines.append("")
        lines.append(f"[{section}]")
        for k, v in kvs.items():
            lines.append(f"{k} = {v}")
    lines.append("")
    return "\n".join(lines)


def _read_text() -> str:
    """Read cockpit.conf as text. Returns '' if absent."""
    try:
        return COCKPIT_CONF.read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError, OSError):
        return ""


def _write_text(text: str) -> None:
    """Write cockpit.conf text. Creates parent dir if needed."""
    COCKPIT_CONF.parent.mkdir(parents=True, exist_ok=True)
    COCKPIT_CONF.write_text(text, encoding="utf-8")


# ── Subcommands ──────────────────────────────────────────────────────


def cmd_read_config(_args: list[str]) -> dict[str, Any]:
    """Return the raw cockpit.conf text + parsed sections."""
    text = _read_text()
    return {
        "path": str(COCKPIT_CONF),
        "text": text or "# (file absent — cockpit defaults in effect)",
        "sections": _parse_conf(text),
        "present": bool(text),
    }


def cmd_write_config(args: list[str]) -> dict[str, Any]:
    """Overwrite cockpit.conf with the given text.

    Usage: write-config <text>. The text is taken as the first argv
    element (the JS panel sends it as a single quoted argument).
    """
    if not args:
        return {"error": "text required"}
    text = args[0]
    try:
        _write_text(text)
        return {"written": True, "path": str(COCKPIT_CONF), "size": len(text)}
    except (PermissionError, OSError) as exc:
        return {"written": False, "error": str(exc),
                "hint": "run via cockpit superuser channel (polkit org.sysdeck.system.manage)"}


def cmd_get(args: list[str]) -> dict[str, Any]:
    """Get one section or one key from cockpit.conf.

    Usage: get <section> [key]. Without a key, returns the whole
    section. With a key, returns just that key's value.
    """
    if not args:
        return {"error": "section name required"}
    sections = _parse_conf(_read_text())
    section = args[0]
    if section not in sections:
        return {"error": f"section [{section}] not found", "available_sections": list(sections.keys())}
    if len(args) < 2:
        return {"section": section, "keys": sections[section]}
    key = args[1]
    if key not in sections[section]:
        return {"error": f"key {key} not found in section [{section}]",
                "available_keys": list(sections[section].keys())}
    return {"section": section, "key": key, "value": sections[section][key]}


def cmd_set(args: list[str]) -> dict[str, Any]:
    """Set one key in cockpit.conf.

    Usage: set <section> <key> <value>. Creates the section if absent.

    v0.1.4 SECURITY: section/key/value arrive as raw argv and are
    serialized into /etc/cockpit/cockpit.conf with naive `f"{k} = {v}"
    lines. A value containing a newline could inject whole new
    sections/keys into cockpit.conf ([WebService]/[Session] knobs) the
    next time cockpit parses it (found by the 0.3.0 security audit).
    Newlines, NULs, brackets in section names and '=' in keys are now
    rejected; write-config remains the operator's explicit raw editor.
    """
    if len(args) < 3:
        return {"error": "usage: set <section> <key> <value>"}
    section, key, value = args[0], args[1], args[2]
    if re.search(r"[\r\n\0]", section + key + value) or re.search(r"[\[\]]", section):
        return {"error": "refusing to set: section/key/value must be single-line "
                         "(no newlines, no NULs; no brackets in section names)"}
    if "=" in key:
        return {"error": "refusing to set: key must not contain '='"}
    text = _read_text()
    sections = _parse_conf(text)
    sections.setdefault(section, {})[key] = value
    try:
        _write_text(_serialize_conf(sections))
        return {"set": True, "section": section, "key": key, "value": value}
    except (PermissionError, OSError) as exc:
        return {"set": False, "error": str(exc),
                "hint": "run via cockpit superuser channel (polkit org.sysdeck.system.manage)"}


def cmd_unset(args: list[str]) -> dict[str, Any]:
    """Remove a key from cockpit.conf."""
    if len(args) < 2:
        return {"error": "usage: unset <section> <key>"}
    section, key = args[0], args[1]
    text = _read_text()
    sections = _parse_conf(text)
    if section not in sections or key not in sections[section]:
        return {"unset": False, "error": f"key {key} not in section [{section}]"}
    del sections[section][key]
    if not sections[section]:
        del sections[section]
    try:
        _write_text(_serialize_conf(sections))
        return {"unset": True, "section": section, "key": key}
    except (PermissionError, OSError) as exc:
        return {"unset": False, "error": str(exc)}


def cmd_reset(_args: list[str]) -> dict[str, Any]:
    """Reset cockpit.conf to defaults (delete the file)."""
    try:
        COCKPIT_CONF.unlink(missing_ok=True)
        return {"reset": True, "path": str(COCKPIT_CONF)}
    except (PermissionError, OSError) as exc:
        return {"reset": False, "error": str(exc)}


# ── Preset gallery ──────────────────────────────────────────────────


def cmd_preset_list(_args: list[str]) -> dict[str, Any]:
    """Return the built-in preset gallery + any operator-dropped JSON."""
    presets = list(PRESETS)
    # Discover operator-dropped presets in /var/lib/sysdeck/themes/presets/.
    custom_dir = SYSDECK_THEME_DIR / "presets"
    if custom_dir.is_dir():
        for p in sorted(custom_dir.glob("*.json")):
            try:
                preset = json.loads(p.read_text(encoding="utf-8"))
                if "id" in preset and "name" in preset:
                    preset["_custom"] = True
                    preset["_source"] = str(p)
                    presets.append(preset)
            except (json.JSONDecodeError, OSError):
                continue
    return {"presets": presets, "count": len(presets)}


def cmd_preset_apply(args: list[str]) -> dict[str, Any]:
    """Apply a preset — writes both cockpit.conf and the CSS overrides."""
    if not args:
        return {"error": "preset id required"}
    preset_id = args[0]
    preset = next((p for p in PRESETS if p["id"] == preset_id), None)
    if preset is None:
        return {"error": f"preset '{preset_id}' not found",
                "hint": "call preset-list for available ids"}
    # 1. Apply the cockpit.conf portion.
    text = _read_text()
    sections = _parse_conf(text)
    for section, kvs in (preset.get("cockpit_conf") or {}).items():
        sections.setdefault(section, {}).update(kvs)
    try:
        _write_text(_serialize_conf(sections))
    except (PermissionError, OSError) as exc:
        return {"applied": False, "error": str(exc)}
    # 2. Apply the CSS variable overrides.
    css_vars = preset.get("css_variables") or {}
    try:
        SYSDECK_THEME_DIR.mkdir(parents=True, exist_ok=True)
        css = ":root {\n" + "\n".join(f"  {k}: {v};" for k, v in css_vars.items()) + "\n}\n"
        SYSDECK_OVERRIDES_FILE.write_text(css, encoding="utf-8")
    except (PermissionError, OSError) as exc:
        return {"applied": True, "cockpit_conf": True, "css_overrides": False, "error": str(exc)}
    return {
        "applied": True,
        "preset": preset_id,
        "cockpit_conf_sections_written": list((preset.get("cockpit_conf") or {}).keys()),
        "css_variables_written": list(css_vars.keys()),
    }


# ── CSS variable overrides ───────────────────────────────────────────


def cmd_variable_list(_args: list[str]) -> dict[str, Any]:
    """Return the SysDeck CSS variable surface."""
    return {"variables": CSS_VARIABLES, "count": len(CSS_VARIABLES)}


def cmd_variable_get(args: list[str]) -> dict[str, Any]:
    """Read a CSS variable's current override value (or default)."""
    if not args:
        return {"error": "variable name required"}
    name = args[0]
    spec = next((v for v in CSS_VARIABLES if v["name"] == name), None)
    if spec is None:
        return {"error": f"variable {name} not in the surface",
                "hint": "call variable-list for the available names"}
    # Read from overrides file.
    val = spec["default"]
    try:
        text = SYSDECK_OVERRIDES_FILE.read_text(encoding="utf-8")
        m = re.search(rf"{re.escape(name)}\s*:\s*([^;]+);", text)
        if m:
            val = m.group(1).strip()
    except (FileNotFoundError, OSError):
        pass
    return {"name": name, "value": val, "default": spec["default"], "kind": spec["kind"]}


def cmd_variable_set(args: list[str]) -> dict[str, Any]:
    """Write a CSS variable override."""
    if len(args) < 2:
        return {"error": "usage: variable-set <name> <value>"}
    name, value = args[0], args[1]
    spec = next((v for v in CSS_VARIABLES if v["name"] == name), None)
    if spec is None:
        return {"error": f"variable {name} not in the surface"}
    # Values land in overrides.css, which every SysDeck page loads.
    # Accept color literals and numeric expressions only: no braces,
    # semicolons, quotes, or url()/import tokens — a value that could
    # break out of the declaration or fetch a remote asset is rejected
    # at the door, not sanitized after the fact.
    if not re.fullmatch(r"[A-Za-z0-9 #%(),./_-]{1,128}", value):
        return {"error": "value must be 1-128 chars of color/number syntax "
                         "(letters, digits, space, # % ( ) , . / _ -)"}
    # Values land in overrides.css, which every SysDeck page loads.
    # Accept color literals and numeric expressions only: no braces,
    # semicolons, quotes, or url()/import tokens — a value that could
    # break out of the declaration or fetch a remote asset is rejected
    # at the door, not sanitized after the fact.
    if not re.fullmatch(r"[A-Za-z0-9 #%(),./_-]{1,128}", value):
        return {"error": "value must be 1-128 chars of color/number syntax "
                         "(letters, digits, space, # % ( ) , . / _ -)"}
    try:
        SYSDECK_THEME_DIR.mkdir(parents=True, exist_ok=True)
        # Read existing overrides, replace or append this variable.
        text = SYSDECK_OVERRIDES_FILE.read_text(encoding="utf-8") if SYSDECK_OVERRIDES_FILE.is_file() else ""
        if re.search(rf"{re.escape(name)}\s*:", text):
            text = re.sub(rf"{re.escape(name)}\s*:\s*[^;]+;", f"{name}: {value};", text)
        else:
            # Insert before the closing }.
            text = text.replace("}", f"  {name}: {value};\n}}", 1) if "}" in text else f":root {{\n  {name}: {value};\n}}\n"
        SYSDECK_OVERRIDES_FILE.write_text(text, encoding="utf-8")
        return {"set": True, "name": name, "value": value}
    except (PermissionError, OSError) as exc:
        return {"set": False, "error": str(exc)}


def cmd_variable_reset(_args: list[str]) -> dict[str, Any]:
    """Clear all CSS variable overrides."""
    try:
        SYSDECK_OVERRIDES_FILE.unlink(missing_ok=True)
        return {"reset": True, "path": str(SYSDECK_OVERRIDES_FILE)}
    except (PermissionError, OSError) as exc:
        return {"reset": False, "error": str(exc)}


# ── Dispatch table ───────────────────────────────────────────────────

COMMANDS = {
    "read-config":   lambda _args: cmd_read_config([]),
    "write-config":  lambda args: cmd_write_config(args),
    "get":            lambda args: cmd_get(args),
    "set":            lambda args: cmd_set(args),
    "unset":          lambda args: cmd_unset(args),
    "reset":          lambda _args: cmd_reset([]),
    "preset-list":    lambda _args: cmd_preset_list([]),
    "preset-apply":   lambda args: cmd_preset_apply(args),
    "variable-list":  lambda _args: cmd_variable_list([]),
    "variable-get":   lambda args: cmd_variable_get(args),
    "variable-set":   lambda args: cmd_variable_set(args),
    "variable-reset": lambda _args: cmd_variable_reset([]),
}


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd = COMMANDS.get(argv[0])
    if not cmd:
        print(f"Unknown subcommand: {argv[0]}", file=sys.stderr)
        print(f"Available: {', '.join(sorted(COMMANDS))}", file=sys.stderr)
        return 2
    print(json.dumps(cmd(argv[1:]), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
