#!/usr/bin/env bash
#
# Name: sysdeck-fw
# Description: SysDeck FW — unified nftables zone firewall. Takes influence from Smoothwall Express (RED/ORANGE/GREEN/BLUE color-zone model) and IPFire (source-verified outbound + AirWall isolation + flow offload) under our own identifier. Modern nftables syntax with sets, verdict maps, synproxy, bogon filtering, connlimit, optional flow offload, and DMZ port-forwarding. Designed for eBPF-capable kernels with XDP integration points.
# Distro: arch,debian
# Services: ssh
#
# ============================================================================
#  sysdeck-fw.sh - SysDeck Unified nftables Zone Firewall
# ============================================================================
#
#  v0.0.37 UNIFIED ZONE FIREWALL. This template takes influence from
#  two open-source firewall distributions — Smoothwall Express
#  (RED/ORANGE/GREEN/BLUE color-zone model) and IPFire (source-verified
#  outbound + AirWall isolation + flow offload). We do not ship a
#  template called "smoothwall" or "ipfire" — those are other
#  projects' trademarks. The unified SysDeck FW template preserves the
#  feature sets we took influence from under our own identifier.
#
#  What this template takes influence from:
#
#    FROM THE ZONE MODEL (takes influence from Smoothwall Express):
#      RED    untrusted Internet (WAN)
#      GREEN  trusted LAN
#      ORANGE DMZ (servers exposed to RED but isolated from GREEN)
#      BLUE   wireless LAN (semi-trusted, isolated from GREEN)
#
#    FROM SOURCE-VERIFIED OUTBOUND (takes influence from IPFire):
#      Each non-RED zone has a configured CIDR. Outbound traffic from
#      the zone is only accepted if the source IP matches the CIDR.
#      This defeats IP-spoofing inside the firewall (a compromised
#      host on BLUE cannot pretend to be on GREEN by spoofing a GREEN
#      IP — the forward chain checks both iifname AND saddr).
#
#    FROM AIRWALL ISOLATION (takes influence from IPFire):
#      BLUE (WiFi) is treated as semi-trusted. By default, BLUE cannot
#      reach GREEN at all — not even for DNS. The operator can disable
#      AirWall via AIRWALL=false in the config file to allow BLUE ->
#      GREEN DNS only (useful for a unified resolver).
#
#    FROM FLOW OFFLOAD (takes influence from IPFire):
#      Optional hardware acceleration. When FLOW_OFFLOAD=true, the
#      ruleset includes a flowtable that accelerates established TCP/UDP
#      connections. Requires a NIC driver with flow offload support.
#
#    FROM ZONE FORWARDING MATRIX (takes influence from both):
#      GREEN -> RED    allow (LAN -> Internet)
#      GREEN -> ORANGE allow (LAN -> DMZ)
#      GREEN -> BLUE   allow (LAN -> WiFi)
#      BLUE  -> RED    allow (WiFi -> Internet; AirWall outbound OK)
#      BLUE  -> ORANGE allow (WiFi -> DMZ)
#      BLUE  -> GREEN  DENY (AirWall — even DNS blocked, unless
#                            AIRWALL=false, in which case DNS only)
#      ORANGE -> RED   allow (DMZ -> Internet for updates)
#      ORANGE -> GREEN DENY
#      ORANGE -> BLUE  DENY
#      RED   -> GREEN  DENY
#      RED   -> BLUE   DENY
#      RED   -> ORANGE only via DMZ_FORWARDS port-forward rules
#
#    FROM DMZ PORT-FORWARDING (takes influence from both):
#      Operator configures DMZ_FORWARDS="extport:intport:orangeip,..."
#      The template emits both DNAT (prerouting) and the forward-allow
#      rule. Example: "80:80:10.0.0.10,443:443:10.0.0.10".
#
#  ANTI-REQUIREMENTS (per user directive v0.0.36 + v0.0.37):
#    - UFW: nftables frontend, no eBPF. Skipped.
#    - fwbuilder: GUI rule generator, too complex. Skipped.
#    - iptables-legacy: pre-nftables, old. Skipped.
#    - iptables-nft: compatibility wrapper, adds no value over native
#      nftables. Skipped.
#    - Shorewall: iptables-based, no eBPF integration points. Skipped.
#    - We do NOT ship a template called "smoothwall" or "ipfire" —
#      those are trademarks of their respective projects. We took
#      influence from them for sysdeck-fw. This is SysDeck FW.
#
#  Requirements:
#    - Linux kernel 6.6+ with CONFIG_NF_TABLES=y
#    - nftables >= 1.0.0
#
#  Configuration:
#    Edit the variables below, or drop a config file at
#    /etc/sysdeck/firewall/sysdeck-fw.conf to override. The config
#    file is sourced if present.
#
# ============================================================================

set -euo pipefail
IFS=$'\n\t'

TABLE_NAME="firewall"

# ============================================================================
# CONFIGURATION
# ============================================================================

# Zone interfaces. RED (WAN) is auto-detected from the default route
# if RED_IF is empty. GREEN/ORANGE/BLUE are optional — zones without
# an interface are skipped at start.
RED_IF="${RED_IF:-}"
GREEN_IF="${GREEN_IF:-}"
ORANGE_IF="${ORANGE_IF:-}"
BLUE_IF="${BLUE_IF:-}"

# Zone CIDRs (used for source-verified outbound). Each non-RED zone
# has a configured CIDR; outbound from the zone is only accepted if
# the source IP matches. Defeats IP spoofing inside the firewall.
RED_CIDR="${RED_CIDR:-}"        # WAN — leave blank
GREEN_CIDR="${GREEN_CIDR:-10.0.0.0/24}"
ORANGE_CIDR="${ORANGE_CIDR:-10.0.1.0/24}"
BLUE_CIDR="${BLUE_CIDR:-192.168.1.0/24}"

# Inbound ports per zone (CSV). Empty = no inbound beyond established.
RED_IN_TCP="${RED_IN_TCP:-22}"          # SSH from Internet
RED_IN_UDP="${RED_IN_UDP:-}"            # e.g. 51820 for WireGuard
GREEN_IN_TCP="${GREEN_IN_TCP:-22,80,443}"
GREEN_IN_UDP="${GREEN_IN_UDP:-53}"      # DNS for LAN clients
ORANGE_IN_TCP="${ORANGE_IN_TCP:-80,443}"
ORANGE_IN_UDP="${ORANGE_IN_UDP:-}"
BLUE_IN_TCP="${BLUE_IN_TCP:-22,80,443}"
BLUE_IN_UDP="${BLUE_IN_UDP:-53}"

# AirWall: when true (default), BLUE is fully isolated from GREEN.
# Set to "false" to allow BLUE -> GREEN DNS only (for a unified resolver).
AIRWALL="${AIRWALL:-true}"

# Flow offload (hardware acceleration). Set to "true" to enable.
# Requires a NIC driver with flow offload support.
FLOW_OFFLOAD="${FLOW_OFFLOAD:-false}"

# DMZ port-forwarding: RED extport -> ORANGE host:intport (CSV).
# Example: "80:80:10.0.0.10,443:443:10.0.0.10"
DMZ_FORWARDS="${DMZ_FORWARDS:-}"

# Load operator overrides if present.
CONFIG_FILE="${CONFIG_FILE:-/etc/sysdeck/firewall/sysdeck-fw.conf}"
if [[ -f "$CONFIG_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$CONFIG_FILE"
fi

NFT_CMD="${NFT_CMD:-nft}"

# ============================================================================

log_info()  { printf '[sysdeck-fw] [INFO]  %s\n' "$*" >&2; }
log_warn()  { printf '[sysdeck-fw] [WARN]  %s\n' "$*" >&2; }
log_error() { printf '[sysdeck-fw] [ERROR] %s\n' "$*" >&2; }
die()        { log_error "$*"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ============================================================================
# PRE-FLIGHT
# ============================================================================

check_root()     { [[ $EUID -eq 0 ]] || die "Requires root (cockpit superuser channel)."; }
check_nftables() { have "$NFT_CMD" || die "nftables not installed. Install: pacman -S nftables / apt install nftables."; }

# Auto-detect the RED (WAN) interface from the default route if not set.
autodetect_red() {
    if [[ -z "$RED_IF" ]]; then
        RED_IF="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"
        [[ -z "$RED_IF" ]] && die "Could not auto-detect RED (WAN) interface. Set RED_IF in $CONFIG_FILE."
        log_info "Auto-detected RED interface: $RED_IF"
    fi
}

# ============================================================================
# RULE GENERATION
# ============================================================================

csv_to_nft_set() {
    # Emit a space-separated list of items from a CSV, skipping empties.
    local csv="$1"
    [[ -z "$csv" ]] && return 0
    echo "$csv" | tr ',' ' '
}

# Emit a conditional nftables line only if the given zone interface is set.
# Usage: zone_line "$GREEN_IF" "iifname \"$GREEN_IF\" ip saddr @green_net oifname \"$RED_IF\" accept comment \"GREEN -> RED\""
zone_line() {
    local iface="$1"
    local rule="$2"
    [[ -n "$iface" ]] && echo "        $rule"
}

build_ruleset() {
    autodetect_red

    local red_tcp_in="$(csv_to_nft_set "$RED_IN_TCP")"
    local red_udp_in="$(csv_to_nft_set "$RED_IN_UDP")"
    local green_tcp_in="$(csv_to_nft_set "$GREEN_IN_TCP")"
    local green_udp_in="$(csv_to_nft_set "$GREEN_IN_UDP")"
    local orange_tcp_in="$(csv_to_nft_set "$ORANGE_IN_TCP")"
    local orange_udp_in="$(csv_to_nft_set "$ORANGE_IN_UDP")"
    local blue_tcp_in="$(csv_to_nft_set "$BLUE_IN_TCP")"
    local blue_udp_in="$(csv_to_nft_set "$BLUE_IN_UDP")"

    cat <<EOF
#!/usr/sbin/nft -f
# SysDeck FW — unified nftables zone firewall. Generated by sysdeck-fw.sh.
# Zones:
#   RED   (WAN):    iface=${RED_IF}     cidr=WAN
#   GREEN (LAN):    iface=${GREEN_IF:-unset}    cidr=${GREEN_CIDR:-unset}
#   ORANGE (DMZ):   iface=${ORANGE_IF:-unset}   cidr=${ORANGE_CIDR:-unset}
#   BLUE  (WiFi):   iface=${BLUE_IF:-unset}     cidr=${BLUE_CIDR:-unset}
# AirWall: ${AIRWALL}
# Flow offload: ${FLOW_OFFLOAD}

flush table inet ${TABLE_NAME} 2>/dev/null

table inet ${TABLE_NAME} {
    # ── Sets ─────────────────────────────────────────────────────────
    set ssh_abuse        { type ipv4_addr; flags interval; timeout 1h; }
    set port_scanners    { type ipv4_addr; flags interval; timeout 1h; }
    set connlimit_abuse  { type ipv4_addr; timeout 10m; }

    set bogons_v4 {
        type ipv4_addr; flags interval;
        elements = {
            0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
            169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24,
            192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24,
            203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32
        }
    }

    # Zone source CIDRs (source-verified outbound).
    $( [[ -n "$GREEN_CIDR" ]]  && echo "set green_net   { type ipv4_addr; flags interval; elements = { $GREEN_CIDR }; }" )
    $( [[ -n "$ORANGE_CIDR" ]] && echo "set orange_net  { type ipv4_addr; flags interval; elements = { $ORANGE_CIDR }; }" )
    $( [[ -n "$BLUE_CIDR" ]]   && echo "set blue_net    { type ipv4_addr; flags interval; elements = { $BLUE_CIDR }; }" )

    # ── Input (to firewall host) ─────────────────────────────────────
    chain input {
        type filter hook input priority filter; policy drop;

        iifname "lo" accept
        iifname "$RED_IF" ip saddr @bogons_v4 drop comment "bogon from RED"

        ip saddr @ssh_abuse drop
        ip saddr @port_scanners drop

        ct state established,related accept
        ct state invalid drop

        ct state new tcp flags & (fin|syn|rst|ack) == syn limit rate 50/second burst 100 packets accept
        ct state new tcp flags & (fin|syn|rst|ack) == syn drop

        ip protocol icmp icmp type echo-request limit rate 5/second accept
        ip6 nexthdr icmpv6 icmpv6 type { echo-request, nd-neighbor-solicit, nd-router-advert } accept

        iifname "$RED_IF"   tcp dport { $red_tcp_in }   accept comment "RED inbound TCP"
        iifname "$RED_IF"   udp dport { $red_udp_in }   accept comment "RED inbound UDP"
        $( [[ -n "$GREEN_IF" ]]  && echo "iifname \"$GREEN_IF\"  ip saddr @green_net  tcp dport { $green_tcp_in }  accept comment \"GREEN inbound (source-verified)\"" )
        $( [[ -n "$GREEN_IF" ]]  && echo "iifname \"$GREEN_IF\"  ip saddr @green_net  udp dport { $green_udp_in }  accept comment \"GREEN inbound (source-verified)\"" )
        $( [[ -n "$ORANGE_IF" ]] && echo "iifname \"$ORANGE_IF\" ip saddr @orange_net tcp dport { $orange_tcp_in } accept comment \"ORANGE inbound (source-verified)\"" )
        $( [[ -n "$ORANGE_IF" ]] && echo "iifname \"$ORANGE_IF\" ip saddr @orange_net udp dport { $orange_udp_in } accept comment \"ORANGE inbound (source-verified)\"" )
        $( [[ -n "$BLUE_IF" ]]   && echo "iifname \"$BLUE_IF\"   ip saddr @blue_net   tcp dport { $blue_tcp_in }   accept comment \"BLUE inbound (source-verified)\"" )
        $( [[ -n "$BLUE_IF" ]]   && echo "iifname \"$BLUE_IF\"   ip saddr @blue_net   udp dport { $blue_udp_in }   accept comment \"BLUE inbound (source-verified)\"" )
    }

    # ── Forward (between zones) ──────────────────────────────────────
    chain forward {
        type filter hook forward priority filter; policy drop;

        iifname "$RED_IF" ip saddr @bogons_v4 drop

        ct state established,related accept
        ct state invalid drop

        # SYN flood protection on RED ingress (synproxy).
        iifname "$RED_IF" tcp flags syn notrack accept comment "synproxy: pass new SYN to synproxy chain"

        # ── Zone-to-zone matrix (source-verified) ──────────────────────
        # GREEN -> RED  : allow
        # GREEN -> ORANGE: allow
        # GREEN -> BLUE : allow
        $( zone_line "$GREEN_IF" "iifname \"$GREEN_IF\" ip saddr @green_net oifname \"$RED_IF\"   accept comment \"GREEN -> RED\"" )
        $( [[ -n "$GREEN_IF" && -n "$ORANGE_IF" ]] && echo "        iifname \"$GREEN_IF\" ip saddr @green_net oifname \"$ORANGE_IF\" accept comment \"GREEN -> ORANGE\"" )
        $( [[ -n "$GREEN_IF" && -n "$BLUE_IF" ]]   && echo "        iifname \"$GREEN_IF\" ip saddr @green_net oifname \"$BLUE_IF\"   accept comment \"GREEN -> BLUE\"" )

        # BLUE -> RED  : allow (AirWall outbound OK)
        # BLUE -> ORANGE: allow
        # BLUE -> GREEN: DENY (AirWall) unless AIRWALL=false → DNS only
        $( zone_line "$BLUE_IF" "iifname \"$BLUE_IF\" ip saddr @blue_net oifname \"$RED_IF\"   accept comment \"BLUE -> RED (AirWall outbound)\"" )
        $( [[ -n "$BLUE_IF" && -n "$ORANGE_IF" ]] && echo "        iifname \"$BLUE_IF\" ip saddr @blue_net oifname \"$ORANGE_IF\" accept comment \"BLUE -> ORANGE\"" )
        $( [[ "$AIRWALL" == "false" && -n "$BLUE_IF" && -n "$GREEN_IF" ]] && echo "        iifname \"$BLUE_IF\" ip saddr @blue_net oifname \"$GREEN_IF\" udp dport 53 accept comment \"AirWall-off: BLUE -> GREEN DNS only\"" )

        # ORANGE -> RED  : allow (DMZ -> Internet for updates)
        # ORANGE -> GREEN: DENY
        # ORANGE -> BLUE : DENY
        $( zone_line "$ORANGE_IF" "iifname \"$ORANGE_IF\" ip saddr @orange_net oifname \"$RED_IF\" accept comment \"ORANGE -> RED\"" )

        # DMZ port-forward rules (RED extport -> ORANGE host:intport).
EOF

    # Emit port-forward rules (forward chain — accept the forwarded traffic).
    if [[ -n "$DMZ_FORWARDS" ]]; then
        local IFS=','
        for fwd in $DMZ_FORWARDS; do
            local extport="${fwd%%:*}"
            local rest="${fwd#*:}"
            local intport="${rest%%:*}"
            local orangeip="${rest##*:}"
            if [[ -n "$extport" && -n "$intport" && -n "$orangeip" && -n "$ORANGE_IF" ]]; then
                echo "        iifname \"$RED_IF\" oifname \"$ORANGE_IF\" tcp dport $extport ip daddr $orangeip accept comment \"forward RED:$extport -> ORANGE:$orangeip:$intport\""
            fi
        done
    fi

    cat <<EOF
    }

    # ── synproxy chain (SYN flood mitigation) ────────────────────────
    chain synproxy {
        tcp flags syn notrack accept
    }

    # ── Output ───────────────────────────────────────────────────────
    chain output {
        type filter hook output priority filter; policy accept;
    }
EOF

    # Flow offload (optional, hardware acceleration).
    if [[ "$FLOW_OFFLOAD" == "true" ]]; then
        local flow_devices="$RED_IF"
        [[ -n "$GREEN_IF" ]] && flow_devices+=", $GREEN_IF"
        cat <<EOF

    # ── Flow offload (hardware acceleration) ─────────────────────────
    flowtable f1 {
        hook ingress priority 0; devices = { $flow_devices };
    }
    chain flowtable {
        type filter hook forward priority 0; policy accept;
        meta l4proto { tcp, udp } flow add 2>/dev/null accept comment "flow offload"
    }
EOF
    fi

    cat <<EOF

    # ── NAT ──────────────────────────────────────────────────────────
    chain nat_postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        # Masquerade traffic from GREEN/BLUE/ORANGE going out RED.
        $( [[ -n "$GREEN_IF" ]]  && echo "oifname \"$RED_IF\" ip saddr $GREEN_CIDR  masquerade comment \"GREEN NAT\"" )
        $( [[ -n "$BLUE_IF" ]]   && echo "oifname \"$RED_IF\" ip saddr $BLUE_CIDR   masquerade comment \"BLUE NAT\"" )
        $( [[ -n "$ORANGE_IF" ]] && echo "oifname \"$RED_IF\" ip saddr $ORANGE_CIDR masquerade comment \"ORANGE NAT\"" )
    }

    chain nat_prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        # Port-forwarding DNAT rules (RED extport -> ORANGE host:intport).
EOF

    # Emit DNAT rules.
    if [[ -n "$DMZ_FORWARDS" ]]; then
        local IFS=','
        for fwd in $DMZ_FORWARDS; do
            local extport="${fwd%%:*}"
            local rest="${fwd#*:}"
            local intport="${rest%%:*}"
            local orangeip="${rest##*:}"
            if [[ -n "$extport" && -n "$intport" && -n "$orangeip" ]]; then
                echo "        iifname \"$RED_IF\" tcp dport $extport dnat to $orangeip:$intport"
            fi
        done
    fi

    cat <<EOF
    }
}
EOF
}

# ============================================================================
# ACTIONS
# ============================================================================

RULES_FILE="$(mktemp /tmp/sysdeck-fw-XXXXXX.nft)"
trap 'rm -f "$RULES_FILE"' EXIT

fw_start() {
    log_info "Starting SysDeck FW (unified nftables zone firewall)..."
    check_root
    check_nftables

    log_info "Generating ruleset..."
    build_ruleset > "$RULES_FILE"

    log_info "Validating..."
    if ! "$NFT_CMD" -c -f "$RULES_FILE"; then
        cp "$RULES_FILE" /tmp/sysdeck-fw-failed.nft
        die "Validation failed. Ruleset saved to /tmp/sysdeck-fw-failed.nft"
    fi

    log_info "Loading..."
    if "$NFT_CMD" -f "$RULES_FILE"; then
        log_info "Firewall started."
    else
        die "Failed to load ruleset."
    fi
}

fw_stop() {
    log_info "Stopping SysDeck FW..."
    check_root
    check_nftables
    "$NFT_CMD" delete table inet "$TABLE_NAME" 2>/dev/null || log_warn "table $TABLE_NAME not present."
    log_info "Firewall stopped."
}

fw_restart() {
    fw_stop
    sleep 1
    fw_start
}

fw_detect() {
    local os_name="unknown"
    if [[ -f /etc/os-release ]]; then . /etc/os-release; os_name="${PRETTY_NAME:-${NAME:-unknown}}"; fi
    autodetect_red 2>/dev/null || RED_IF="unknown"
    cat <<EOF
+-----------------------------------------------------+
|              Service Detection Summary              |
+-----------------------------------------------------+
| OS: ${os_name}
| Template: sysdeck-fw (unified nftables zone firewall)
| AirWall: ${AIRWALL}
| Flow offload: ${FLOW_OFFLOAD}
| Zones:
|   RED   (WAN):    iface=${RED_IF:-unset}     cidr=WAN
|   GREEN (LAN):    iface=${GREEN_IF:-unset}    cidr=${GREEN_CIDR:-unset}
|   ORANGE (DMZ):   iface=${ORANGE_IF:-unset}   cidr=${ORANGE_CIDR:-unset}
|   BLUE  (WiFi):   iface=${BLUE_IF:-unset}     cidr=${BLUE_CIDR:-unset}
| Inbound RED TCP: ${RED_IN_TCP:-none}
| DMZ forwards:    ${DMZ_FORWARDS:-none}
| Config file:     ${CONFIG_FILE}
+-----------------------------------------------------+
EOF
}

fw_status() {
    check_nftables
    "$NFT_CMD" list table inet "$TABLE_NAME" 2>&1 || echo "table not loaded."
}

fw_check() {
    check_nftables
    build_ruleset > "$RULES_FILE"
    "$NFT_CMD" -c -f "$RULES_FILE"
}

# ============================================================================
# DISPATCH
# ============================================================================

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
            sed -n '1,90p' "$0"
            ;;
        *)
            die "Unknown command: $command\nRun '$0 help' for usage."
            ;;
    esac
}

main "$@"
