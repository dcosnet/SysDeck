#!/usr/bin/env bash
# sysdeck-uninstall.sh — quiet uninstaller for every cockpit-installed
# SysDeck version.
#
# Removes ALL traces of SysDeck from a cockpit host, across every
# layout ever shipped:
#   - the pacman/dpkg/rpm-installed 'sysdeck' package, if any
#   - /usr/share/cockpit/sysdeck/          (v0.0.9-v0.0.19 single-plugin layout)
#   - /usr/share/cockpit/sysdeck-*/        (v0.0.20+ multi-plugin layout, incl. sysdeck-common)
#   - /usr/share/cockpit/branding.css      (0.3.0+ shell skin; restores the
#                                           .sysdeck-bak backup when present)
#   - /usr/lib/sysdeck/                    (Python bridge helpers + tests)
#   - /usr/share/sysdeck/                  (diagnostic/smoke scripts, firewall
#                                           templates + policies, prometheus configs)
#   - /usr/share/doc/sysdeck/              (docs)
#   - /usr/share/metainfo/sysdeck.metainfo.xml          (AppStream)
#   - /usr/share/polkit-1/actions/org.sysdeck.policy    (polkit)
#   - /usr/share/polkit-1/actions/org.sysdeck.modules3p.policy
#   - python site-packages sysdeck symlink / dist-info (any python3.x)
# then reloads polkit, refreshes the AppStream cache and restarts
# cockpit.socket so the sidebar flushes (unless --no-restart).
#
# Deliberately NOT removed (operator data, not part of any package):
#   - /var/lib/sysdeck/   builder artifacts/state/logs  (--purge-state opts in)
#   - /etc/sysdeck/       operator firewall overrides
#   - /etc/pam.d/sysdeck  operator-tailored PAM stack for the web console
#   - third-party cockpit modules installed via the 3rd-Party Modules panel
#     (those are other projects' software)
#   - the standalone web console (web/ — a directory, not an install)
#
# Quiet contract: prints NOTHING on success (exit 0), including when
# nothing was installed. All diagnostics go to stderr and set a non-zero
# exit. -v lists each removal; -n lists without removing.
#
# Idempotent: safe to run any number of times.
#
# Usage:
#   sudo ./sysdeck-uninstall.sh [options]
#
# Options:
#   -q, --quiet      say nothing on success (default)
#   -v, --verbose    list every path as it is removed
#   -n, --dry-run    list what would be removed; change nothing
#   --no-restart     do not restart cockpit.socket (polkit reload +
#                    appstream refresh still attempted)
#   --purge-state    also remove /var/lib/sysdeck (builder artifacts,
#                    logs, state — operator data; off by default)
#   -h, --help       this help
#
# Testing: SYSDECK_ROOT=<prefix> relocates every filesystem path under
# <prefix> and replaces system actions (package-manager removal, polkit
# reload, appstream refresh, cockpit restart) with entries appended to
# <prefix>/.uninstall-actions.log — nothing outside the prefix is touched.

set -u

QUIET=1
VERBOSE=0
DRY_RUN=0
RESTART=1
PURGE_STATE=0
ROOT="${SYSDECK_ROOT:-}"

usage() {
    awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
    exit 0
}

say()    { [ "$VERBOSE" -eq 1 ] || return 0; printf '%s\n' "$*"; }
warn()   { printf 'sysdeck-uninstall: %s\n' "$*" >&2; }
die()    { warn "$*"; exit 1; }

# ── argument parsing ────────────────────────────────────────────────
# Preserved before the loop: the loop consumes "$@", and the root
# re-exec below must carry the operator's exact options (a lost -n
# would turn a dry run into a real uninstall).
SAVED_ARGS="${*:-}"
while [ $# -gt 0 ]; do
    case "$1" in
        -q|--quiet)     QUIET=1 ;;
        -v|--verbose)   VERBOSE=1; QUIET=0 ;;
        -n|--dry-run)   DRY_RUN=1 ;;
        --no-restart)   RESTART=0 ;;
        --purge-state)  PURGE_STATE=1 ;;
        -h|--help)      usage ;;
        *)              die "unknown option: $1 (try --help)" ;;
    esac
    shift
done
# a dry run with no listing at all would be useless
[ "$DRY_RUN" -eq 1 ] && VERBOSE=1

# ── privilege: the real filesystem needs root; the prefix mode is a sandbox ──
if [ -z "$ROOT" ] && [ "$(id -u)" -ne 0 ]; then
    # word-split is intentional: SAVED_ARGS holds simple option words
    # shellcheck disable=SC2086
    exec sudo -- "$0" $SAVED_ARGS
fi

# ── system actions: executed quietly, or logged in prefix mode ──────
ACTIONS_LOG="$ROOT/.uninstall-actions.log"
svc() {  # svc <description> <command...>
    local desc="$1"; shift
    if [ -n "$ROOT" ]; then
        printf '%s\n' "$desc" >> "$ACTIONS_LOG"
        return 0
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
        say "    would run: $desc"
        return 0
    fi
    "$@" >/dev/null 2>&1 || true
}

rm_path() {  # rm_path <path> [description]
    local path="$1" desc="${2:-}"
    [ -e "$path" ] || [ -L "$path" ] || return 0
    if [ "$DRY_RUN" -eq 1 ]; then
        printf 'would remove %s\n' "$path"
        return 0
    fi
    say "removing $path${desc:+  ($desc)}"
    rm -rf -- "$path" || die "failed to remove: $path"
    REMOVED=$((REMOVED + 1))
}
REMOVED=0

# ── 1. package-manager copies (best effort; the file pass below catches the rest) ──
if [ -z "$ROOT" ]; then
    if command -v pacman >/dev/null 2>&1 && pacman -Q sysdeck >/dev/null 2>&1; then
        svc "pacman -R --noconfirm sysdeck" pacman -R --noconfirm sysdeck
    fi
    if command -v dpkg >/dev/null 2>&1 && dpkg -l sysdeck >/dev/null 2>&1; then
        svc "dpkg --purge sysdeck" dpkg --purge sysdeck
    fi
    if command -v rpm >/dev/null 2>&1 && rpm -q sysdeck >/dev/null 2>&1; then
        svc "rpm -e sysdeck" rpm -e sysdeck
    fi
fi

# ── 2. cockpit plugin directories (every layout ever shipped) ───────
COCKPIT_DIR="$ROOT/usr/share/cockpit"

rm_path "$COCKPIT_DIR/sysdeck" "v0.0.9-v0.0.19 single-plugin layout"

for dir in "$COCKPIT_DIR"/sysdeck-*; do
    [ -e "$dir" ] || [ -L "$dir" ] || continue
    rm_path "$dir" "v0.0.20+ multi-plugin layout"
done

# the 0.3.0+ shell skin: drop our branding.css, restore the distro
# backup when one was taken (mirrors `make uninstall-branding`)
if [ -f "$COCKPIT_DIR/branding.css.sysdeck-bak" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
        printf 'would restore %s -> branding.css\n' "$COCKPIT_DIR/branding.css.sysdeck-bak"
    else
        say "restoring $COCKPIT_DIR/branding.css from backup"
        rm -f -- "$COCKPIT_DIR/branding.css"
        mv -- "$COCKPIT_DIR/branding.css.sysdeck-bak" "$COCKPIT_DIR/branding.css" \
            || die "failed to restore branding.css backup"
    fi
elif [ -f "$COCKPIT_DIR/branding.css" ]; then
    # no backup: only ours to remove if install-branding put it there —
    # remove it (the distro package restores its own on reinstall)
    rm_path "$COCKPIT_DIR/branding.css" "cockpit shell skin"
fi

# ── 3. the rest of the install surface ──────────────────────────────
rm_path "$ROOT/usr/lib/sysdeck"        "Python bridge helpers + tests"
rm_path "$ROOT/usr/share/sysdeck"      "diagnostics, firewall templates, prometheus configs"
rm_path "$ROOT/usr/share/doc/sysdeck"  "documentation"
rm_path "$ROOT/usr/share/metainfo/sysdeck.metainfo.xml" "AppStream metainfo"
rm_path "$ROOT/usr/share/polkit-1/actions/org.sysdeck.policy"         "polkit policy"
rm_path "$ROOT/usr/share/polkit-1/actions/org.sysdeck.modules3p.policy" "polkit policy (3rd-party modules)"

[ "$PURGE_STATE" -eq 1 ] && rm_path "$ROOT/var/lib/sysdeck" "builder artifacts/state/logs (--purge-state)"

# ── 4. python site-packages: the sysdeck symlink + dist-info, any python3.x ──
shopt -s nullglob
for pysite in "$ROOT"/usr/lib/python3*/site-packages "$ROOT"/usr/lib/python3*/dist-packages; do
    [ -d "$pysite" ] || continue
    [ -L "$pysite/sysdeck" ] && rm_path "$pysite/sysdeck" "python site-packages symlink"
    for egg in "$pysite"/sysdeck-*.dist-info "$pysite"/sysdeck-*.egg-info; do
        rm_path "$egg" "python packaging metadata"
    done
done
shopt -u nullglob
if [ -z "$ROOT" ] && command -v python3 >/dev/null 2>&1; then
    SITE_PACKAGES="$(python3 -c 'import site; print(site.getsitepackages()[0])' 2>/dev/null || true)"
    if [ -n "$SITE_PACKAGES" ]; then
        [ -L "$SITE_PACKAGES/sysdeck" ] && rm_path "$SITE_PACKAGES/sysdeck" "python site-packages symlink"
        for egg in "$SITE_PACKAGES"/sysdeck-*.dist-info "$SITE_PACKAGES"/sysdeck-*.egg-info; do
            [ -e "$egg" ] || continue
            rm_path "$egg" "python packaging metadata"
        done
    fi
fi

# ── 5. reload caches + flush the cockpit sidebar ─────────────────────
if command -v systemctl >/dev/null 2>&1 || [ -n "$ROOT" ]; then
    svc "systemctl reload polkit"            systemctl reload polkit
fi
if command -v appstreamcli >/dev/null 2>&1 || [ -n "$ROOT" ]; then
    svc "appstreamcli refresh-cache"         appstreamcli refresh-cache
fi
if [ "$RESTART" -eq 1 ]; then
    svc "systemctl restart cockpit.socket"   systemctl restart cockpit.socket
fi

[ "$VERBOSE" -eq 1 ] && printf 'done (%d paths removed)\n' "$REMOVED"
exit 0
