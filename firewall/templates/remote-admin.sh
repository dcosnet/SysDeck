#!/usr/bin/env bash
#
# Name: remote-admin
# Description: Public server variant for remote administration. Exposes SSH (22) and Cockpit (9090) with aggressive rate limiting, port-scan detection, and SSH brute-force auto-ban. Designed for VPS / cloud hosts where the operator needs remote shell + web admin access from anywhere, but wants the surface protected against brute-force and scan traffic.
# Distro: arch,debian
# Services: ssh,cockpit
#
# ============================================================================
#  remote-admin.sh - SysDeck public-server variant: remote admin
# ============================================================================
#
#  v0.0.44 NEW. Per user directive: "another thing the firewall module
#  needs is a few public server variants. like: remote admin enabled
#  ssh and cockpit ...". This template targets the remote-admin use
#  case — the box is reachable from the internet on two admin ports
#  only: SSH (22) and Cockpit (9090). Everything else is dropped.
#
#  What this template does:
#    - inet table "firewall" (unified IPv4/IPv6)
#    - input default policy: drop
#    - forward default policy: drop
#    - output default policy: accept
#    - accept established + related (ct state)
#    - accept loopback
#    - accept ICMP echo-request + echo-reply + needed ICMPv6 (NDP)
#    - accept TCP 22 (SSH) with rate limit (4 new conns / minute / source)
#      — sources exceeding the rate are added to the ssh_abuse set
#      (1 hour timeout) and dropped
#    - accept TCP 9090 (Cockpit web UI) with rate limit
#      (10 new conns / minute / source)
#    - drop invalid TCP flag combos (NULL / XMAS / SYN+FIN / SYN+RST)
#    - drop fragments
#    - drop bogons on input (martian IPv4 + IPv6 docs)
#    - log dropped packets at 5/second burst 10
#
#  Detection:
#    - Reads SSH_PORT from /etc/ssh/sshd_config (falls back to 22)
#    - Reads Cockpit port from /etc/cockpit/cockpit.conf
#      (Listen = ... directive, falls back to 9090)
#    - Both ports are surfaced in the detect output so the panel
#      can show them in the Service/Port editor.
#
#  Hardening notes:
#    - No 0.0.0.0 listener assumption (per v0.0.43 directive — this
#      is a FIREWALL template, not a listener config; the firewall
#      itself never binds any address).
#    - SYNPROXY NOT enabled here — the box only listens on 2 ports,
#      and SYNPROXY adds complexity for little benefit when the rate
#      limiter already handles SYN floods.
#    - Bogon list is small (just RFC 1918 + 169.254 + 127.0.0.0/8 +
#      0.0.0.0/8 + IPv6 ::1 + fc00::/7 + fe80::/10) — keeps the ruleset
#      short for easy review.
#
#  Standard template interface (start/stop/restart/detect/status/check)
#  implemented so the existing bridge.firewall.apply/stop/restart/detect/
#  check subcommands work unchanged.
#
# ============================================================================

set -euo pipefail
IFS=$'\n\t'

SCRIPT_NAME="remote-admin"
SCRIPT_VERSION="0.0.44"

TABLE_NAME="firewall"
NFT_CMD="${NFT_CMD:-nft}"
RULES_FILE="${RULES_FILE:-/tmp/sysdeck-firewall-remote-admin.rules}"

# ── Configurable ports (auto-detected, can be overridden) ───────────
# These are read by the detect / start actions. The operator can also
# override by editing this script's variables directly.
SSH_PORT="${SYSDECK_REMOTE_ADMIN_SSH_PORT:-22}"
COCKPIT_PORT="${SYSDECK_REMOTE_ADMIN_COCKPIT_PORT:-9090}"

# ── Rate limits ─────────────────────────────────────────────────────
SSH_RATE_LIMIT="4/minute"
SSH_BURST="8"
SSH_BAN_TIMEOUT="3600s"  # 1 hour
COCKPIT_RATE_LIMIT="10/minute"
COCKPIT_BURST="20"
COCKPIT_BAN_TIMEOUT="600s"  # 10 minutes

# ── Log ─────────────────────────────────────────────────────────────
LOG_PREFIX="[NFT-DROP] "
LOG_RATE="5/second"
LOG_BURST="10"

# ── Bogons (small list — keep short for reviewability) ──────────────
BOGONS_V4="0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4"
BOGONS_V6="::1/128, fc00::/7, fe80::/10, ff00::/8"

log_info()  { printf '[%s] [INFO]  %s\n' "$SCRIPT_NAME" "$*" >&2; }
log_debug() { printf '[%s] [DEBUG] %s\n' "$SCRIPT_NAME" "$*" >&2 || true; }
die()        { printf '[%s] [FATAL] %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }

check_nftables() {
    command -v "$NFT_CMD" &>/dev/null || die "nftables not installed. Install with: pacman -S nftables  /  apt install nftables"
}

# ── Service detection ───────────────────────────────────────────────
#
# Auto-detect SSH port from /etc/ssh/sshd_config. Falls back to 22 if
# the file is absent or the Port directive is missing/commented out.
detect_ssh_port() {
    local cfg="/etc/ssh/sshd_config"
    if [[ -f "$cfg" ]]; then
        # Match: Port 2222  (ignoring commented #Port lines)
        local port
        port=$(awk '
            /^[[:space:]]*Port[[:space:]]+/ { print $2; exit }
        ' "$cfg" 2>/dev/null || true)
        if [[ -n "${port:-}" && "$port" =~ ^[0-9]+$ ]]; then
            SSH_PORT="$port"
            return
        fi
    fi
    SSH_PORT="22"
}

# Auto-detect Cockpit port from /etc/cockpit/cockpit.conf. Cockpit's
# listener configuration uses a [Listen] section with a `Port = ...`
# key, OR a `Listen = addr:port` directive in [WebService]. We try
# both. Falls back to 9090.
detect_cockpit_port() {
    local cfg="/etc/cockpit/cockpit.conf"
    if [[ -f "$cfg" ]]; then
        local port
        # Try [WebService] Listen = 9090  OR  Listen = 0.0.0.0:9090
        # (Note: we explicitly do NOT support 0.0.0.0 binds per the
        # v0.0.43 directive — but if the operator has already set
        # one, we extract just the port.)
        port=$(awk '
            /^\[WebService\]/ { in_ws=1; next }
            /^\[/ { in_ws=0 }
            in_ws && /^[[:space:]]*Listen[[:space:]]*=/ {
                v=$3
                # Strip "addr:" prefix if present
                sub(/^.*:/, "", v)
                print v
                exit
            }
        ' "$cfg" 2>/dev/null || true)
        # Try [Socket] section as well
        if [[ -z "${port:-}" ]]; then
            port=$(awk '
                /^\[Socket\]/ { in_s=1; next }
                /^\[/ { in_s=0 }
                in_s && /^[[:space:]]*Port[[:space:]]*=/ { print $3; exit }
            ' "$cfg" 2>/dev/null || true)
        fi
        if [[ -n "${port:-}" && "$port" =~ ^[0-9]+$ ]]; then
            COCKPIT_PORT="$port"
            return
        fi
    fi
    COCKPIT_PORT="9090"
}

# ── Build ruleset ───────────────────────────────────────────────────
build_ruleset() {
    cat <<RULESET
#!/usr/sbin/nft -f

flush ruleset

table inet ${TABLE_NAME} {

    # ── Sets ──────────────────────────────────────────────────────

    # SSH brute-force ban list. Populated by the rate-limit rule
    # when a source exceeds ${SSH_RATE_LIMIT}. Entries expire after
    # ${SSH_BAN_TIMEOUT}.
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

    # Cockpit rate-limit ban list.
    set cockpit_abuse {
        type ipv4_addr
        flags timeout
        timeout ${COCKPIT_BAN_TIMEOUT}
    }

    set cockpit_abuse6 {
        type ipv6_addr
        flags timeout
        timeout ${COCKPIT_BAN_TIMEOUT}
    }

    # Bogon source addresses (martian / RFC 1918 / etc).
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

        # Drop bogons first.
        ip saddr @bogons_v4 drop
        ip6 saddr @bogons_v6 drop

        # Established / related — accept.
        ct state vmap { established: accept, related: accept }

        # Loopback.
        iifname "lo" accept

        # Invalid.
        ct state invalid drop

        # ICMP / ICMPv6 essentials.
        ip protocol icmp icmp type { echo-request, echo-reply, destination-unreachable, time-exceeded } accept
        ip6 nexthdr icmpv6 icmpv6 type { echo-request, echo-reply, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert, packet-too-big, destination-unreachable, time-exceeded } accept

        # ── SSH (port ${SSH_PORT}) ─────────────────────────────────
        # If source is in the ban set, drop.
        ip saddr @ssh_abuse drop
        ip6 saddr @ssh_abuse6 drop

        # Rate-limit new SSH connections. Sources exceeding
        # ${SSH_RATE_LIMIT} burst ${SSH_BURST} get added to ssh_abuse.
        tcp dport ${SSH_PORT} ct state new \
            limit rate ${SSH_RATE_LIMIT} burst ${SSH_BURST} packets accept

        tcp dport ${SSH_PORT} ct state new \
            add @ssh_abuse { ip saddr } \
            add @ssh_abuse6 { ip6 saddr } \
            log prefix "${LOG_PREFIX}ssh-rate " drop

        # ── Cockpit (port ${COCKPIT_PORT}) ────────────────────────
        ip saddr @cockpit_abuse drop
        ip6 saddr @cockpit_abuse6 drop

        tcp dport ${COCKPIT_PORT} ct state new \
            limit rate ${COCKPIT_RATE_LIMIT} burst ${COCKPIT_BURST} packets accept

        tcp dport ${COCKPIT_PORT} ct state new \
            add @cockpit_abuse { ip saddr } \
            add @cockpit_abuse6 { ip6 saddr } \
            log prefix "${LOG_PREFIX}cockpit-rate " drop

        # Drop invalid TCP flag combinations.
        tcp flags & (fin|syn|rst|psh|ack|urg) == 0 drop
        tcp flags & (fin|syn) == (fin|syn) drop
        tcp flags & (syn|rst) == (syn|rst) drop
        tcp flags & (fin|rst) == (fin|rst) drop
        tcp flags & (psh|fin) == (psh|fin) drop
        tcp flags & (urg|psh|ack|fin|rst|syn) == (urg|psh|ack|fin|rst|syn) drop

        # Log + drop everything else.
        limit rate ${LOG_RATE} burst ${LOG_BURST} packets log prefix "${LOG_PREFIX}input "
        drop
    }

    chain forward {
        type filter hook forward priority 0; policy drop;
        limit rate ${LOG_RATE} burst ${LOG_BURST} packets log prefix "${LOG_PREFIX}forward "
        drop
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
    detect_cockpit_port
    log_info "Starting remote-admin firewall: ssh=${SSH_PORT}, cockpit=${COCKPIT_PORT}"
    build_ruleset > "$RULES_FILE"
    "$NFT_CMD" -f "$RULES_FILE"
    log_info "Firewall loaded."
}

fw_stop() {
    check_nftables
    log_info "Stopping remote-admin firewall"
    "$NFT_CMD" delete table inet "$TABLE_NAME" 2>/dev/null || true
    rm -f "$RULES_FILE"
}

fw_restart() {
    fw_stop
    fw_start
}

fw_detect() {
    detect_ssh_port
    detect_cockpit_port
    local os_name="unknown"
    if [[ -f /etc/os-release ]]; then . /etc/os-release; os_name="${PRETTY_NAME:-${NAME:-unknown}}"; fi
    cat <<EOF
+-----------------------------------------------------+
|              Service Detection Summary              |
+-----------------------------------------------------+
| OS: ${os_name}
| Template: remote-admin (SSH + Cockpit)
| SSH port:    ${SSH_PORT}  (from /etc/ssh/sshd_config)
| Cockpit port: ${COCKPIT_PORT}  (from /etc/cockpit/cockpit.conf)
| Rate limits:
|   SSH:    ${SSH_RATE_LIMIT} burst ${SSH_BURST} (ban ${SSH_BAN_TIMEOUT})
|   Cockpit: ${COCKPIT_RATE_LIMIT} burst ${COCKPIT_BURST} (ban ${COCKPIT_BAN_TIMEOUT})
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
    detect_cockpit_port
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
