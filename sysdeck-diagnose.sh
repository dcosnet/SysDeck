#!/bin/bash
# sysdeck-diagnose.sh — print exactly what Cockpit sees on this system.
#
# Run this AFTER `sudo make install` and `sudo systemctl restart cockpit.socket`.
# Paste the output back if SysDeck still doesn't appear in the Cockpit sidebar.
#
# Usage:
#   chmod +x sysdeck-diagnose.sh
#   ./sysdeck-diagnose.sh
# Or:
#   bash sysdeck-diagnose.sh

set -u
echo "============================================================"
echo "SysDeck install diagnostic — $(date -Iseconds)"
echo "============================================================"

echo
echo "─── 1. Cockpit service status ───"
if command -v systemctl >/dev/null 2>&1; then
    systemctl status cockpit.socket --no-pager 2>&1 | head -8
    echo
    echo "─── 2. Cockpit version (must be >= 239) ───"
    if command -v cockpit-bridge >/dev/null 2>&1; then
        cockpit-bridge --version 2>&1
    else
        echo "cockpit-bridge not in PATH — Cockpit may not be installed correctly"
        echo "On Arch:   sudo pacman -S cockpit"
        echo "On Debian: sudo apt install cockpit"
        echo "On Fedora: sudo dnf install cockpit"
    fi
else
    echo "systemctl not found — not a systemd system?"
fi

echo
echo "─── 3. What's installed under /usr/share/cockpit/ ───"
if [ -d /usr/share/cockpit ]; then
    ls -la /usr/share/cockpit/ 2>&1
else
    echo "/usr/share/cockpit/ does not exist — Cockpit not installed, or install location differs"
fi

echo
echo "─── 3a. Leftover from old single-plugin layout (v0.0.9-v0.0.19) ───"
if [ -d /usr/share/cockpit/sysdeck ] && [ ! -L /usr/share/cockpit/sysdeck ]; then
    echo "WARN: /usr/share/cockpit/sysdeck/ exists (old single-plugin layout)"
    echo "      This directory was installed by sysdeck v0.0.9 through v0.0.19."
    echo "      Cockpit will discover its manifest.json alongside the new"
    echo "      sysdeck-* plugins, and may serve old broken code instead of"
    echo "      the freshly-installed new code. Remove it:"
    echo "        sudo rm -rf /usr/share/cockpit/sysdeck"
    echo "      Or run: sudo make uninstall  (now removes this in v0.0.24+)"
    ls -la /usr/share/cockpit/sysdeck/ 2>&1 | head -10
else
    echo "OK: no /usr/share/cockpit/sysdeck/ directory (good — no stale install)"
fi

echo
echo "─── 4. SysDeck plugins (v0.0.20 architecture: 18 separate plugins) ───"
SYSDECK_PLUGINS=$(ls -d /usr/share/cockpit/sysdeck-* 2>/dev/null | grep -v sysdeck-common)
if [ -n "$SYSDECK_PLUGINS" ]; then
    echo "Found $(echo "$SYSDECK_PLUGINS" | wc -l) SysDeck plugins (expected 18):"
    echo "$SYSDECK_PLUGINS" | sed 's|^|  |'
else
    echo "FAIL: no /usr/share/cockpit/sysdeck-* plugin directories found"
    echo "      Run: sudo make install"
fi

echo
echo "─── 4a. Spot-check installed bridge.js for v0.0.23+ fix ───"
if [ -f /usr/share/cockpit/sysdeck-common/bridge.js ]; then
    if grep -q "const cockpit = window.cockpit" /usr/share/cockpit/sysdeck-common/bridge.js; then
        echo "OK: bridge.js uses window.cockpit (v0.0.23+ fix present)"
    elif grep -q "^import cockpit from" /usr/share/cockpit/sysdeck-common/bridge.js; then
        echo "FAIL: bridge.js still uses 'import cockpit from' (v0.0.22 broken pattern)"
        echo "      The page will stay stuck on 'Loading…' because cockpit.js is"
        echo "      not an ES module. Reinstall:"
        echo "        sudo make uninstall && sudo make install"
    else
        echo "WARN: bridge.js content unknown — paste the first 5 lines:"
        head -5 /usr/share/cockpit/sysdeck-common/bridge.js
    fi
else
    echo "FAIL: /usr/share/cockpit/sysdeck-common/bridge.js not found"
fi

echo
echo "─── 5. SysDeck shared bridge + CSS ───"
if [ -d /usr/share/cockpit/sysdeck-common ]; then
    ls -la /usr/share/cockpit/sysdeck-common/
else
    echo "FAIL: /usr/share/cockpit/sysdeck-common/ does not exist"
    echo "      Each plugin imports ../sysdeck-common/bridge.js — without it,"
    echo "      every plugin page will fail to load."
fi

echo
echo "─── 5a. Python bridge helpers at /usr/lib/sysdeck/bridge/ ───"
BRIDGE_DIR=/usr/lib/sysdeck/bridge
if [ -d "$BRIDGE_DIR" ]; then
    PY_COUNT=$(find "$BRIDGE_DIR" -maxdepth 1 -name '*.py' -type f 2>/dev/null | wc -l)
    EXEC_COUNT=$(find "$BRIDGE_DIR" -maxdepth 1 -name '*.py' -type f -perm -a+x 2>/dev/null | wc -l)
    echo "Found $PY_COUNT Python helpers in $BRIDGE_DIR (expected ~16; the 18 plugins"
    echo "  invoke them by absolute path: python3 /usr/lib/sysdeck/bridge/<module>.py <subcommand>)."
    if [ "$EXEC_COUNT" -lt "$PY_COUNT" ]; then
        echo "FAIL: $((PY_COUNT - EXEC_COUNT)) of $PY_COUNT helpers are NOT executable."
        echo "      bridge.js spawns them via cockpit.spawn(['python3', '<path>.py', ...])."
        echo "      cockpit.spawn runs the helper as the calling user — if the file is not"
        echo "      marked executable, the spawn may still work (python3 reads it as a script),"
        echo "      but file-system-level ACLs or polkit setups can reject it."
        echo "      Fix: sudo chmod +x $BRIDGE_DIR/*.py"
    else
        echo "OK: all $EXEC_COUNT helpers are executable."
    fi
    # Smoke-test one helper end-to-end (summary subcommand exists on most modules).
    if [ -x "$BRIDGE_DIR/glances.py" ] || [ -r "$BRIDGE_DIR/glances.py" ]; then
        echo "── 5a-spot: invoke glances.py --help (should print docstring) ──"
        if python3 "$BRIDGE_DIR/glances.py" --help 2>&1 | head -5; then :; else
            echo "FAIL: glances.py failed to run. Python or import error."
        fi
    fi
    # Cross-check the v0.0.28 firmware.devices subcommand bug (the most common silent failure).
    if [ -r "$BRIDGE_DIR/firmware.py" ]; then
        if python3 "$BRIDGE_DIR/firmware.py" devices 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); assert isinstance(d.get("Devices"), list)' 2>/dev/null; then
            echo "OK: firmware.py devices subcommand returns {Devices: [...]}"
        else
            echo "FAIL: firmware.py devices subcommand did not return {Devices: [...]}."
            echo "      bridge.firmware.devices() in bridge.js calls this — the firmware"
            echo "      plugin page will crash. Reinstall: sudo make uninstall && sudo make install."
        fi
    fi
    # Cross-check the v0.0.28 benchmark.run-test subcommand bug.
    if [ -r "$BRIDGE_DIR/benchmark.py" ]; then
        if python3 "$BRIDGE_DIR/benchmark.py" run-test 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "raw" in d and "events_per_sec" in d' 2>/dev/null; then
            echo "OK: benchmark.py run-test subcommand returns parsed sysbench result"
        else
            echo "FAIL: benchmark.py run-test subcommand did not return a sysbench result dict."
            echo "      bridge.benchmark.runTest(name) in bridge.js calls this — clicking the"
            echo "      'Run' button in the Available Tests table will error out. Reinstall."
        fi
    fi
else
    echo "FAIL: $BRIDGE_DIR does not exist."
    echo "      Every plugin's bridge.js calls python3 $BRIDGE_DIR/<module>.py — without"
    echo "      these helpers, every bridge call returns 'No such file or directory'."
    echo "      Reinstall: sudo make uninstall && sudo make install"
fi

echo
echo "─── 6. Spot-check one plugin: sysdeck-containers ───"
if [ -d /usr/share/cockpit/sysdeck-containers ]; then
    ls -la /usr/share/cockpit/sysdeck-containers/
    echo
    if [ -f /usr/share/cockpit/sysdeck-containers/manifest.json ]; then
        echo "── manifest.json content ──"
        cat /usr/share/cockpit/sysdeck-containers/manifest.json
        echo
        echo
        echo "── manifest.json file metadata ──"
        stat /usr/share/cockpit/sysdeck-containers/manifest.json
    else
        echo "FAIL: /usr/share/cockpit/sysdeck-containers/ exists but manifest.json is missing"
    fi
else
    echo "FAIL: /usr/share/cockpit/sysdeck-containers/ does not exist"
fi

echo
echo "─── 7. Can the cockpit user read the plugin manifests? ───"
if id cockpit >/dev/null 2>&1; then
    OK_COUNT=0
    FAIL_COUNT=0
    for plugin in /usr/share/cockpit/sysdeck-*/; do
        [ -d "$plugin" ] || continue
        if sudo -u cockpit cat "$plugin/manifest.json" >/dev/null 2>&1; then
            OK_COUNT=$((OK_COUNT + 1))
        else
            FAIL_COUNT=$((FAIL_COUNT + 1))
            echo "  FAIL: cockpit user cannot read $plugin/manifest.json"
        fi
    done
    echo "  OK: $OK_COUNT manifests readable by cockpit user"
    [ "$FAIL_COUNT" -gt 0 ] && echo "  FAIL: $FAIL_COUNT manifests NOT readable"
    [ "$FAIL_COUNT" -gt 0 ] && echo "  Fix: sudo chmod -R a+rX /usr/share/cockpit/sysdeck-*"
else
    echo "NOTE: 'cockpit' user does not exist on this system (Cockpit may use a different service user)"
    echo "      On most distros Cockpit runs as the 'cockpit' user; on some it runs as 'root'."
fi

echo
echo "─── 8. AppStream metainfo ───"
METAINFO_PATH=/usr/share/metainfo/sysdeck.metainfo.xml
if [ -f "$METAINFO_PATH" ]; then
    ls -la "$METAINFO_PATH"
    echo
    if command -v appstreamcli >/dev/null 2>&1; then
        echo "─── 9. AppStream validation of metainfo ───"
        appstreamcli validate "$METAINFO_PATH" 2>&1 || true
        echo
        echo "─── 10. AppStream cache search for sysdeck ───"
        appstreamcli search sysdeck 2>&1 | head -20 || true
    else
        echo "appstreamcli not installed — install appstream to validate metainfo"
        echo "On Arch: sudo pacman -S appstream"
    fi
else
    echo "NOTE: $METAINFO_PATH does not exist"
    echo "      Without metainfo, SysDeck appears in the sidebar but NOT in the Cockpit"
    echo "      Applications install menu. Run: sudo make install (installs metainfo too)"
fi

echo
echo "─── 11. Cockpit journal — recent sysdeck/error/warning lines ───"
if command -v journalctl >/dev/null 2>&1; then
    journalctl -u cockpit -n 200 --no-pager 2>&1 | grep -iE 'sysdeck|error|warning|fail|cannot|denied' | tail -30
    if [ ${PIPESTATUS[0]} -ne 0 ]; then
        echo "(no cockpit unit found — Cockpit may not be running as a systemd service)"
    fi
else
    echo "journalctl not available"
fi

echo
echo "─── 12. Cockpit config (if any) ───"
if [ -f /etc/cockpit/cockpit.conf ]; then
    cat /etc/cockpit/cockpit.conf
else
    echo "(no /etc/cockpit/cockpit.conf — using defaults)"
fi

echo
echo "─── 13. Reference: working plugin manifests shipped in this tarball ───"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
for ref in cockpit-incus cockpit-machines cockpit-ostree; do
    refpath="$SCRIPT_DIR/standalone-plugins/$ref/manifest.json"
    if [ -f "$refpath" ]; then
        echo
        echo "── $ref/manifest.json ──"
        cat "$refpath"
    fi
done

echo
echo "─── 14. Compare: is sysdeck's manifest structurally similar? ───"
echo "(compare the keys in sysdeck's manifest above to the reference plugins above)"
echo
echo "If sysdeck's manifest has keys that the reference plugins don't have (like"
echo "'content', 'title', 'priority', or 'path' inside menu entries), Cockpit"
echo "may silently reject it. The v0.0.19 manifest was rewritten to match"
echo "the cockpit-podman reference pattern exactly. If the installed manifest"
echo "doesn't match, you may have an old version installed — run:"
echo
echo "  sudo rm -rf /usr/share/cockpit/sysdeck"
echo "  sudo make install"
echo "  sudo systemctl restart cockpit.socket"

echo
echo "─── 15. Final smoke test: load Cockpit and check the sidebar ───"
echo "Open https://localhost:9090 in a browser. Log in. Look at the left sidebar."
echo "SysDeck should appear as an entry (typically under 'System')."
echo
echo "If it's NOT there, also check:"
echo "  - Open browser devtools (F12) → Network tab → reload → look for /cockpit/@localhost/sysdeck/ requests"
echo "  - Hard-refresh with Ctrl+Shift+R (cockpit-ws caches manifests aggressively)"
echo "  - Check the journal again AFTER opening the page (Cockpit may log the discovery attempt)"

echo
echo "============================================================"
echo "End of diagnostic."
echo "============================================================"
