#!/usr/bin/env bash
#
# Name: public-webserver
# Description: Public server variant for a web stack. Exposes Varnish (80, cache front) and Caddy HTTPS (443) publicly; Caddy HTTP backend (8080) and MariaDB (3306) are bound to loopback only and never exposed. SSH rate-limited with auto-ban. Optional Caddy admin API (2019) is loopback-only. Designed for VPS web servers running a reverse-proxy/cache stack with a database.
# Distro: arch,debian
# Services: ssh,caddy,varnish,mariadb
#
# ============================================================================
#  public-webserver.sh - SysDeck public-server variant: web stack
# ============================================================================
#
#  v0.0.47 PORT-TOPOLOGY FIX. Per user directive: "the web server
#  template, and vps template i setup the webserver on 8080 and
#  varnish on 80 for an automatic cache environment." The v0.0.44
#  template had the topology backwards — it exposed Caddy on :80 and
#  Varnish on :8080. v0.0.47 flips it: Varnish is the public cache
#  front on :80, Caddy HTTP backend lives on :8080 (loopback only),
#  Caddy HTTPS lives on :443 (public, terminates TLS). The :8080
#  backend is now ALWAYS loopback-only — the VARNISH_PUBLIC toggle
#  has been removed because it was a footgun (the previous default
#  exposed the backend cache-miss path to the internet, bypassing
#  Varnish entirely).
#
#  Topology:
#    Client → :80   (Varnish cache frontend, public — HTTP redirect to :443)
#    Client → :443  (Caddy HTTPS, public — terminates TLS)
#    Varnish → :8080 (Caddy backend, loopback only — Varnish cache miss)
#
#  Public TCP ports:
#    22   SSH (rate-limited, auto-ban brute force)
#    80   HTTP (Varnish frontend — must be public for ACME http-01
#              challenge + redirect to HTTPS)
#    443  HTTPS (Caddy — terminates TLS)
#
#  Loopback-only TCP ports (NEVER exposed — firewall enforces):
#    8080 Caddy HTTP backend (Varnish cache-miss target)
#    3306 MariaDB
#    2019 Caddy admin API
#
#  The firewall enforces the loopback-only policy at the kernel level:
#  even if Caddy or MariaDB is misconfigured to listen on 0.0.0.0, the
#  firewall drops the packet before it reaches the daemon. This is
#  defense in depth — the daemon's own bind is the primary control.
#
#  Standard template interface (start/stop/restart/detect/status/check).
#
# ============================================================================

set -euo pipefail
IFS=$'\n\t'

SCRIPT_NAME="public-webserver"
SCRIPT_VERSION="0.0.47"

TABLE_NAME="firewall"
NFT_CMD="${NFT_CMD:-nft}"
RULES_FILE="${RULES_FILE:-/tmp/sysdeck-firewall-public-webserver.rules}"

# ── Configurable ports (auto-detected) ──────────────────────────────
# v0.0.47: Varnish is the public cache front on :80; Caddy HTTP backend
# is loopback-only on :8080. Caddy HTTPS terminates TLS on :443.
SSH_PORT="${SYSDECK_PUBLIC_WEBSERVER_SSH_PORT:-22}"
VARNISH_PORT="${SYSDECK_PUBLIC_WEBSERVER_VARNISH:-80}"
CADDY_HTTP_PORT="${SYSDECK_PUBLIC_WEBSERVER_CADDY_HTTP:-8080}"
CADDY_HTTPS_PORT="${SYSDECK_PUBLIC_WEBSERVER_CADDY_HTTPS:-443}"
CADDY_ADMIN_PORT="${SYSDECK_PUBLIC_WEBSERVER_CADDY_ADMIN:-2019}"
MARIADB_PORT="${SYSDECK_PUBLIC_WEBSERVER_MARIADB:-3306}"

# ── Rate limits ─────────────────────────────────────────────────────
SSH_RATE_LIMIT="4/minute"
SSH_BURST="8"
SSH_BAN_TIMEOUT="3600s"
HTTP_RATE_LIMIT="100/second"
HTTP_BURST="200"
HTTPS_RATE_LIMIT="100/second"
HTTPS_BURST="200"

# ── Log ─────────────────────────────────────────────────────────────
LOG_PREFIX="[NFT-DROP] "
LOG_RATE="5/second"
LOG_BURST="10"

# ── Bogons ──────────────────────────────────────────────────────────
BOGONS_V4="0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4"
BOGONS_V6="::1/128, fc00::/7, fe80::/10, ff00::/8"

log_info()  { printf '[%s] [INFO]  %s\n' "$SCRIPT_NAME" "$*" >&2; }
log_debug() { printf '[%s] [DEBUG] %s\n' "$SCRIPT_NAME" "$*" >&2 || true; }
die()        { printf '[%s] [FATAL] %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }

check_nftables() {
    command -v "$NFT_CMD" &>/dev/null || die "nftables not installed. Install with: pacman -S nftables  /  apt install nftables"
}

# ── Service detection ───────────────────────────────────────────────

detect_ssh_port() {
    local cfg="/etc/ssh/sshd_config"
    if [[ -f "$cfg" ]]; then
        local port
        port=$(awk '/^[[:space:]]*Port[[:space:]]+/ { print $2; exit }' "$cfg" 2>/dev/null || true)
        if [[ -n "${port:-}" && "$port" =~ ^[0-9]+$ ]]; then SSH_PORT="$port"; return; fi
    fi
    SSH_PORT="22"
}

# Parse Caddy's Caddyfile for explicit port bindings. Caddy's HTTPS
# default is 443 — the operator can override with `:8443` or similar
# in the site block. The HTTP backend port (8080) is what Varnish
# connects to on loopback; Caddy should bind it to 127.0.0.1:8080
# (or 0.0.0.0:8080 — the firewall enforces loopback-only access).
# We surface any non-default bindings but do NOT change the firewall
# ports — the operator is expected to set
# SYSDECK_PUBLIC_WEBSERVER_CADDY_HTTP / _HTTPS env vars or edit the
# script if they want the firewall to match.
detect_caddy_ports() {
    local cfg="/etc/caddy/Caddyfile"
    if [[ -f "$cfg" ]]; then
        # Just log the bindings — don't override the env vars.
        local bindings
        bindings=$(grep -E '^\s*:?[a-z]*://|^[[:space:]]*:[0-9]+' "$cfg" 2>/dev/null | head -5 || true)
        if [[ -n "${bindings:-}" ]]; then
            log_debug "Caddyfile site bindings:\n${bindings}"
        fi
    fi
    # Caddy admin API port — defaults to 2019 (loopback only).
    local admin_cfg="/etc/caddy/caddy-api.json"
    if [[ -f "$admin_cfg" ]]; then
        local port
        port=$(grep -oE '"listen"[[:space:]]*:[[:space:]]*"localhost:[0-9]+"|"listen"[[:space:]]*:[[:space:]]*":?[0-9]+"' "$admin_cfg" 2>/dev/null \
            | grep -oE '[0-9]+' | head -1 || true)
        if [[ -n "${port:-}" ]]; then CADDY_ADMIN_PORT="$port"; fi
    fi
}

# Parse Varnish's listen port. Varnish's systemd unit usually passes
# -a :80 on the command line for a cache-front-of-Caddy setup; the
# VCL itself just defines the backend. We check the systemd unit
# override first, then /etc/default/varnish (VARNISH_LISTEN_PORT),
# then fall back to 80 — the standard production topology where
# Varnish sits in front of Caddy on :80 and Caddy backend listens
# on :8080 (loopback only).
detect_varnish_port() {
    # Check /etc/systemd/system/varnish.service.d/*.conf for -a :PORT
    local unit_dir="/etc/systemd/system/varnish.service.d"
    if [[ -d "$unit_dir" ]]; then
        local port
        port=$(grep -rhoE '\-a[[:space:]]*:?[a-z0-9.]*:([0-9]+)' "$unit_dir" 2>/dev/null \
            | grep -oE '[0-9]+$' | head -1 || true)
        if [[ -n "${port:-}" ]]; then VARNISH_PORT="$port"; return; fi
    fi
    # Debian/Ubuntu: /etc/default/varnish VARNISH_LISTEN_PORT=...
    if [[ -f /etc/default/varnish ]]; then
        local port
        port=$(awk -F= '/^VARNISH_LISTEN_PORT=/ { gsub(/["'\'' \t]/, "", $2); print $2; exit }' /etc/default/varnish 2>/dev/null || true)
        if [[ -n "${port:-}" && "$port" =~ ^[0-9]+$ ]]; then VARNISH_PORT="$port"; return; fi
    fi
    # Default for the public-webserver template is 80 (per v0.0.47
    # user directive — Varnish is the public cache front).
    : "${VARNISH_PORT:=80}"
}

# Parse MariaDB config for the listen port. The config is split across
# multiple files in /etc/mysql/mariadb.conf.d/ on Debian. We look for
# [mysqld] port = ... in any *.cnf file there.
detect_mariadb_port() {
    local cfg_dirs=("/etc/mysql/mariadb.conf.d" "/etc/mysql" "/etc")
    local cfg_files=(
        "$cfg_dirs[0]/50-server.cnf"
        "$cfg_dirs[0]/60-galera.cnf"
        "/etc/my.cnf"
        "/etc/mysql/my.cnf"
    )
    # Also check the .d directories.
    while IFS= read -r -d '' f; do cfg_files+=("$f"); done < <(
        find "${cfg_dirs[@]}" -name '*.cnf' -print0 2>/dev/null || true
    )
    local f
    for f in "${cfg_files[@]}"; do
        [[ -f "$f" ]] || continue
        local port
        port=$(awk '
            /^\[mysqld\]/ { in_m=1; next }
            /^\[/ { in_m=0 }
            in_m && /^[[:space:]]*port[[:space:]]*=/ { gsub(/[^0-9]/, "", $3); print $3; exit }
        ' "$f" 2>/dev/null || true)
        if [[ -n "${port:-}" ]]; then MARIADB_PORT="$port"; return; fi
    done
    MARIADB_PORT="3306"
}

# ── Build ruleset ───────────────────────────────────────────────────

build_ruleset() {
    cat <<RULESET
#!/usr/sbin/nft -f

flush ruleset

table inet ${TABLE_NAME} {

    # ── Sets ──────────────────────────────────────────────────────

    set ssh_abuse {
        type ipv4_addr
        flags timeout
        timeout ${SSH_BAN_TIMEOUT}
    }
    set ssh_abuse6 {
        type ipv6_addr
        flags timeout
        timeout ${SSH_BAN_TIMEOUT}
    }
    set bogons_v4 {
        type ipv4_addr
        flags interval
        elements = { ${BOGONS_V4} }
    }
    set bogons_v6 {
        type ipv6_addr
        flags interval
        elements = { ${BOGONS_V6} }
    }

    # ── Chains ────────────────────────────────────────────────────

    chain input {
        type filter hook input priority 0; policy drop;

        ip saddr @bogons_v4 drop
        ip6 saddr @bogons_v6 drop

        ct state vmap { established: accept, related: accept }
        iifname "lo" accept
        ct state invalid drop

        # ICMP / ICMPv6 essentials.
        ip protocol icmp icmp type { echo-request, echo-reply, destination-unreachable, time-exceeded } accept
        ip6 nexthdr icmpv6 icmpv6 type { echo-request, echo-reply, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert, packet-too-big, destination-unreachable, time-exceeded } accept

        # ── SSH (port ${SSH_PORT}) ─────────────────────────────────
        ip saddr @ssh_abuse drop
        ip6 saddr @ssh_abuse6 drop
        tcp dport ${SSH_PORT} ct state new \
            limit rate ${SSH_RATE_LIMIT} burst ${SSH_BURST} packets accept
        tcp dport ${SSH_PORT} ct state new \
            add @ssh_abuse { ip saddr } \
            add @ssh_abuse6 { ip6 saddr } \
            log prefix "${LOG_PREFIX}ssh-rate " drop

        # ── HTTP (Varnish cache front ${VARNISH_PORT}) ─────────────
        # Varnish is the public cache frontend on :80 — handles ACME
        # http-01 challenge + redirects to :443 for HTTPS traffic.
        tcp dport ${VARNISH_PORT} ct state new \
            limit rate ${HTTP_RATE_LIMIT} burst ${HTTP_BURST} packets accept
        tcp dport ${VARNISH_PORT} ct state new \
            log prefix "${LOG_PREFIX}http-rate " drop

        # ── HTTPS (Caddy ${CADDY_HTTPS_PORT}) ──────────────────────
        # Caddy terminates TLS on :443. Varnish also forwards pinned
        # HTTPS traffic here via PROXY protocol (operator configures
        # that in the VCL — the firewall doesn't need to know).
        tcp dport ${CADDY_HTTPS_PORT} ct state new \
            limit rate ${HTTPS_RATE_LIMIT} burst ${HTTPS_BURST} packets accept
        tcp dport ${CADDY_HTTPS_PORT} ct state new \
            log prefix "${LOG_PREFIX}https-rate " drop

        # Drop invalid TCP flag combinations.
        tcp flags & (fin|syn|rst|psh|ack|urg) == 0 drop
        tcp flags & (fin|syn) == (fin|syn) drop
        tcp flags & (syn|rst) == (syn|rst) drop
        tcp flags & (fin|rst) == (fin|rst) drop
        tcp flags & (psh|fin) == (psh|fin) drop

        # ── DEFENSE IN DEPTH ───────────────────────────────────────
        # Even if Caddy HTTP backend, MariaDB, or Caddy admin is
        # misconfigured to bind 0.0.0.0, these rules DROP the packet
        # before it reaches the daemon. The default policy is drop —
        # these explicit drops just LOG the attempt so the operator
        # sees misconfiguration. v0.0.47: :8080 (Caddy HTTP backend)
        # is now in this defense-in-depth block — it must NEVER be
        # reachable from outside loopback.
        tcp dport ${CADDY_HTTP_PORT} ip saddr != 127.0.0.0/8 \
            limit rate ${LOG_RATE} burst ${LOG_BURST} packets \
            log prefix "${LOG_PREFIX}caddy-http-backend-blocked " drop
        tcp dport ${CADDY_HTTP_PORT} ip6 saddr != ::1 \
            limit rate ${LOG_RATE} burst ${LOG_BURST} packets \
            log prefix "${LOG_PREFIX}caddy-http-backend6-blocked " drop
        tcp dport ${MARIADB_PORT} ip saddr != 127.0.0.0/8 \
            limit rate ${LOG_RATE} burst ${LOG_BURST} packets \
            log prefix "${LOG_PREFIX}mariadb-blocked " drop
        tcp dport ${MARIADB_PORT} ip6 saddr != ::1 \
            limit rate ${LOG_RATE} burst ${LOG_BURST} packets \
            log prefix "${LOG_PREFIX}mariadb6-blocked " drop
        tcp dport ${CADDY_ADMIN_PORT} ip saddr != 127.0.0.0/8 \
            limit rate ${LOG_RATE} burst ${LOG_BURST} packets \
            log prefix "${LOG_PREFIX}caddy-admin-blocked " drop

        limit rate ${LOG_RATE} burst ${LOG_BURST} packets log prefix "${LOG_PREFIX}input "
        drop
    }

    chain forward {
        type filter hook forward priority 0; policy drop;
    }

    chain output {
        type filter hook output priority 0; policy accept;
    }
}
RULESET
}

# ── Actions ─────────────────────────────────────────────────────────

fw_start() {
    check_nftables
    detect_ssh_port
    detect_caddy_ports
    detect_varnish_port
    detect_mariadb_port
    log_info "Starting public-webserver firewall:"
    log_info "  ssh=${SSH_PORT} (public, rate-limited)"
    log_info "  varnish=${VARNISH_PORT} (public cache front, HTTP redirect to HTTPS)"
    log_info "  caddy-https=${CADDY_HTTPS_PORT} (public, terminates TLS)"
    log_info "  caddy-http-backend=${CADDY_HTTP_PORT} (loopback only — Varnish cache-miss target)"
    log_info "  caddy-admin=${CADDY_ADMIN_PORT} (loopback only)"
    log_info "  mariadb=${MARIADB_PORT} (loopback only, defense-in-depth drop)"
    build_ruleset > "$RULES_FILE"
    "$NFT_CMD" -f "$RULES_FILE"
    log_info "Firewall loaded."
}

fw_stop() {
    check_nftables
    log_info "Stopping public-webserver firewall"
    "$NFT_CMD" delete table inet "$TABLE_NAME" 2>/dev/null || true
    rm -f "$RULES_FILE"
}

fw_restart() {
    fw_stop
    fw_start
}

fw_detect() {
    detect_ssh_port
    detect_caddy_ports
    detect_varnish_port
    detect_mariadb_port
    local os_name="unknown"
    if [[ -f /etc/os-release ]]; then . /etc/os-release; os_name="${PRETTY_NAME:-${NAME:-unknown}}"; fi
    cat <<EOF
+-----------------------------------------------------+
|              Service Detection Summary              |
+-----------------------------------------------------+
| OS: ${os_name}
| Template: public-webserver (Varnish → Caddy + MariaDB)
|
| Public ports:
|   ${SSH_PORT}/tcp        SSH (rate-limited, auto-ban)
|   ${VARNISH_PORT}/tcp        Varnish cache front (HTTP, redirect to HTTPS)
|   ${CADDY_HTTPS_PORT}/tcp        Caddy HTTPS (terminates TLS)
|
| Loopback-only ports (defense-in-depth drop at firewall):
|   ${CADDY_HTTP_PORT}/tcp        Caddy HTTP backend (Varnish cache-miss target)
|   ${MARIADB_PORT}/tcp        MariaDB
|   ${CADDY_ADMIN_PORT}/tcp        Caddy admin API
|
| Topology (v0.0.47 — cache-front-of-origin):
|   Client → :${VARNISH_PORT} (Varnish cache front, public)
|   Client → :${CADDY_HTTPS_PORT} (Caddy HTTPS, public)
|   Varnish → :${CADDY_HTTP_PORT} (Caddy HTTP backend, loopback only)
|
| Config files:
|   SSH:      /etc/ssh/sshd_config
|   Caddy:    /etc/caddy/Caddyfile
|   Varnish:  /etc/systemd/system/varnish.service.d/*.conf
|             /etc/default/varnish (VARNISH_LISTEN_PORT=)
|   MariaDB:  /etc/mysql/mariadb.conf.d/*.cnf
+-----------------------------------------------------+
EOF
}

fw_status() {
    check_nftables
    "$NFT_CMD" list table inet "$TABLE_NAME" 2>&1 || echo "table not loaded."
}

fw_check() {
    check_nftables
    detect_ssh_port
    detect_caddy_ports
    detect_varnish_port
    detect_mariadb_port
    build_ruleset > "$RULES_FILE"
    "$NFT_CMD" -c -f "$RULES_FILE"
}

# ── Dispatch ────────────────────────────────────────────────────────

main() {
    local command="${1:-help}"
    case "$command" in
        start)          fw_start ;;
        stop)           fw_stop ;;
        restart|reload) fw_restart ;;
        detect)         fw_detect ;;
        status)         fw_status ;;
        check|validate) fw_check ;;
        help|--help|-h)
            sed -n '1,60p' "$0"
            ;;
        *)
            die "Unknown command: $command\nRun '$0 help' for usage."
            ;;
    esac
}

main "$@"
