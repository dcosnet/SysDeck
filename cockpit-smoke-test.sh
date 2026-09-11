#!/bin/bash
# cockpit-smoke-test.sh — install a 5-line hello-world Cockpit plugin
# and verify Cockpit discovers it. This decouples "is Cockpit working?"
# from "is sysdeck's manifest correct?".
#
# If this smoke test ALSO fails to show "Hello Test" in the sidebar,
# the problem is NOT sysdeck — it's Cockpit itself (config, permissions,
# install location, version, etc.).
#
# Usage:
#   sudo bash cockpit-smoke-test.sh install   # install hello-world plugin
#   sudo bash cockpit-smoke-test.sh remove    # remove hello-world plugin
#
# After 'install', open https://localhost:9090 and look for "Hello Test"
# in the sidebar. Hard-refresh with Ctrl+Shift+R if needed.

set -eu

ACTION="${1:-install}"
PLUGIN_DIR=/usr/share/cockpit/hellotest

case "$ACTION" in
    install)
        echo ">>> Installing hello-world Cockpit plugin to $PLUGIN_DIR"
        mkdir -p "$PLUGIN_DIR"

        # Manifest matches the cockpit-podman pattern exactly — this is
        # the smallest manifest that real, working Cockpit plugins use.
        # NOTE: requires.cockpit MUST be a bare number ("239"), NOT ">=239".
        # Cockpit's sortify_version() turns ">=" into a string that sorts
        # GREATER than any real cockpit version (because '>' is ASCII 62
        # > '0' ASCII 48), so packages.py raises JsonError and silently
        # rejects the manifest — the plugin never appears in the sidebar.
        # This was the v0.0.9-v0.0.21 root cause of "zero entries".
        cat > "$PLUGIN_DIR/manifest.json" <<'JSON'
{
    "version": 0,
    "name": "hellotest",
    "requires": { "cockpit": "239" },
    "menu": {
        "index": {
            "label": "Hello Test",
            "order": 99
        }
    },
    "content-security-policy": "default-src 'self' 'unsafe-inline'"
}
JSON

        # Minimal index.html — just enough to confirm the page loads.
        cat > "$PLUGIN_DIR/index.html" <<'HTML'
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Hello Test</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
    <h1>Hello from Cockpit!</h1>
    <p>If you can read this in the Cockpit web UI, Cockpit's plugin
       discovery is working correctly. The issue with sysdeck is
       therefore sysdeck's manifest, not Cockpit itself.</p>
    <p>Timestamp: <span id="ts"></span></p>
    <script>document.getElementById('ts').textContent = new Date().toISOString();</script>
</body>
</html>
HTML

        chmod a+rx "$PLUGIN_DIR"
        chmod a+r "$PLUGIN_DIR/manifest.json" "$PLUGIN_DIR/index.html"

        echo ">>> Installed. Restarting cockpit.socket..."
        systemctl restart cockpit.socket 2>/dev/null || true

        echo
        echo ">>> DONE. Now open https://localhost:9090 and look for"
        echo "    'Hello Test' in the left sidebar."
        echo
        echo "    If you see it → Cockpit discovery works; the issue is sysdeck."
        echo "    If you DON'T see it → the issue is Cockpit itself, not sysdeck."
        echo "                       Run sysdeck-diagnose.sh and share the output."
        echo
        echo "    Hard-refresh the browser with Ctrl+Shift+R if needed."
        echo
        echo "    When done, remove with: sudo bash cockpit-smoke-test.sh remove"
        ;;

    remove)
        echo ">>> Removing hello-world Cockpit plugin"
        rm -rf "$PLUGIN_DIR"
        systemctl restart cockpit.socket 2>/dev/null || true
        echo ">>> Removed. Hard-refresh the browser (Ctrl+Shift+R) to update the sidebar."
        ;;

    *)
        echo "Usage: sudo bash $0 {install|remove}"
        exit 1
        ;;
esac
