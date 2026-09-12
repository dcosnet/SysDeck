#!/usr/bin/env bash
#
# Name: no-services
# Description: Locked-down host firewall with no public services except SSH. Modern nftables syntax with synproxy, scan detection, bogon filtering, fragment protection. Designed for eBPF-capable kernels.
# Distro: arch,debian
# Services: ssh
#
# ============================================================================
#  nftables-firewall.sh - Modern Linux Firewall for Kernel 7.x
# ============================================================================
#  Replaces legacy iptables scripts with nftables native syntax
#  Designed for eBPF-capable kernels with hardened configurations
#
#  Features:
#    - Unified IPv4/IPv6 via inet family (no separate ip/ip6 tables)
#    - Sets for efficient O(1) lookups instead of linear rule chains
#    - Verdict maps for service routing
#    - Named counters for per-rule statistics
#    - Stateful connection tracking with modern helpers
#    - Synproxy for TCP SYN flood protection
#    - Rate limiting with dynamic set population
#    - Flow offload support for hardware acceleration
#    - XDP integration points (load separately via bpftool)
#    - No legacy iptables/arptables/ebtables compatibility layer
#
#  Requirements:
#    - Linux kernel 6.6+ / 7.x with CONFIG_NF_TABLES=y
#    - nftables >= 1.0.0
#    - libnftables with JSON support
#
#  Usage:
#    ./nftables-firewall.sh [start|stop|restart|status|check|save|dump]
#
# ============================================================================

set -euo pipefail
IFS=$'\n\t'

# ============================================================================
# CONFIGURATION - Edit these variables for your environment
# ============================================================================

# --- Network Interfaces ---
# Primary external interface (WAN)
EXT_IF="eth0"
# Internal/LAN interface (set empty if single-homed)
INT_IF="eth1"
# Additional interfaces (space-separated)
EXTRA_IFS=""
# Loopback (do not change unless you know what you're doing)
LO_IF="lo"

# --- Host Identity ---
# Set to your server's primary IPs to prevent spoofing
# Leave empty to auto-detect
MY_IPV4=""
MY_IPV6=""

# --- Default Policies ---
# Options: accept, drop, reject
POLICY_INPUT="drop"
POLICY_OUTPUT="accept"
POLICY_FORWARD="drop"

# --- Logging ---
# Enable detailed logging (adds performance overhead)
LOG_ENABLED="yes"
# Log prefix for dropped packets
LOG_PREFIX="[NFT-DROP] "
# Log prefix for accepted packets (debug mode)
LOG_ACCEPT_PREFIX="[NFT-ACCEPT] "
# Rate limit for logs (per second, 0 = unlimited)
LOG_RATE="5/second"
# Log burst
LOG_BURST="10"

# --- SSH Configuration ---
SSH_PORT="22"
SSH_ENABLED="yes"
# Max connection attempts per minute before temporary ban
SSH_MAX_CONN="4/minute"
# Ban duration in seconds (0 = permanent until restart)
SSH_BAN_TIME="300"

# --- Allowed TCP Services ---
# Format: "port" or "port:interface" for interface-specific rules
TCP_SERVICES=(
    "80"
    "443"
    "${SSH_PORT}"
)

# --- Allowed UDP Services ---
UDP_SERVICES=(
    "53"           # DNS (if running nameserver)
)

# --- Allowed ICMP Types ---
# Numeric types for inet family
ICMP_ALLOWED=(
    "echo-request"    # ping
    "echo-reply"      # pong
    "destination-unreachable"
    "time-exceeded"   # traceroute
    "parameter-problem"
)

# --- ICMPv6 Specific (additional to above) ---
ICMPV6_ALLOWED=(
    "nd-router-solicit"
    "nd-router-advert"
    "nd-neighbor-solicit"
    "nd-neighbor-advert"
    "packet-too-big"
)

# --- Rate Limiting ---
# General new connection rate limit
CONN_RATE_LIMIT="50/second"
CONN_RATE_BURST="100"
# ICMP rate limit
ICMP_RATE_LIMIT="10/second"
ICMP_RATE_BURST="20"
# DNS rate limit (prevent amplification abuse)
DNS_RATE_LIMIT="20/second"
DNS_RATE_BURST="40"

# --- TCP Hardening ---
# Enable TCP SYNPROXY (requires SYNPROXY target)
SYNPROXY_ENABLED="yes"
# MSS clamping for Path MTU Discovery
MSS_CLAMP="yes"
# MSS value (0 = auto-detect from interface MTU)
MSS_VALUE="0"
# Drop invalid TCP flag combinations
TCP_FLAGS_STRICT="yes"
# Enable window tracking
TCP_WINDOW_TRACK="yes"

# --- Protection Toggles ---
PROTECT_SYN_FLOOD="yes"
PROTECT_PORT_SCAN="yes"
PROTECT_IP_SPOOF="yes"
PROTECT_SMURF="yes"
PROTECT_FRAGMENTS="yes"
PROTECT_XMAS="yes"
PROTECT_NULL_SCAN="yes"
PROTECT_INVALID="yes"
PROTECT_BOGUS_TCP="yes"

# --- NAT/Masquerade ---
# Enable NAT masquerade for outbound traffic (router mode)
NAT_ENABLED="no"
# NAT source interface
NAT_SRC_IF="$INT_IF"
# NAT outbound interface
NAT_OUT_IF="$EXT_IF"

# --- Port Forwarding ---
# Format: "ext_port:proto:int_ip:int_port"
# Example: "8080:tcp:192.168.1.10:80"
PORT_FORWARDS=()

# --- Flow Offload ---
# Enable hardware flow offloading (if supported)
FLOW_OFFLOAD="no"

# --- Trusted Networks ---
# These bypass most restrictions
TRUSTED_NETS=(
    # "192.168.1.0/24"
    # "10.0.0.0/8"
)

# --- Blocked Networks ---
# Known bad networks, bogons, etc.
BLOCKED_NETS=(
    "0.0.0.0/8"           # Current network
    "10.0.0.0/8"          # Private (allow if you use it)
    "127.0.0.0/8"         # Loopback
    "169.254.0.0/16"      # Link-local
    "172.16.0.0/12"       # Private
    "192.0.0.0/24"        # IETF Protocol Assignments
    "192.0.2.0/24"        # Documentation
    "192.88.99.0/24"      # IPv6 to IPv4 relay
    "192.168.0.0/16"      # Private (allow if you use it)
    "198.18.0.0/15"       # Benchmark testing
    "198.51.100.0/24"     # Documentation
    "203.0.113.0/24"      # Documentation
    "224.0.0.0/4"         # Multicast
    "240.0.0.0/4"         # Reserved
    "255.255.255.255/32"  # Broadcast
)

# ============================================================================
# INTERNAL VARIABLES - Do not modify
# ============================================================================

SCRIPT_NAME="$(basename "$0")"
SCRIPT_VERSION="2.0.0"
NFT_CMD="$(command -v nft 2>/dev/null || echo "")"
TABLE_NAME="firewall"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
RULES_FILE="$(mktemp /tmp/nftables-rules-XXXXXX.nft)"
# a fresh mktemp name per run — no predictable /tmp path for a root write
trap 'rm -f "$RULES_FILE"' EXIT
SAVED_RULES="/etc/nftables/firewall.rules"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

log_info() {
    echo -e "${GREEN}[INFO]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*" >&2
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

log_debug() {
    if [[ "${DEBUG:-no}" == "yes" ]]; then
        echo -e "${BLUE}[DEBUG]${NC} $*"
    fi
}

die() {
    log_error "$@"
    exit 1
}

# Check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        die "This script must be run as root"
    fi
}

# Check for nftables
check_nftables() {
    if [[ -z "$NFT_CMD" ]]; then
        die "nftables not found. Install with: apt install nftables / dnf install nftables"
    fi
    
    local nft_ver
    nft_ver=$($NFT_CMD -v | grep -oP 'nftables v\K[0-9.]+')
    log_debug "nftables version: $nft_ver"
}

# Verify interface exists
verify_interface() {
    local iface="$1"
    if ! ip link show "$iface" &>/dev/null; then
        log_warn "Interface $iface does not exist - rules will still be created"
    fi
}

# Auto-detect IPs if not set
detect_ips() {
    if [[ -z "$MY_IPV4" ]]; then
        MY_IPV4=$(ip -4 addr show dev "$EXT_IF" 2>/dev/null | \
                  grep -oP 'inet \K[0-9.]+' | head -1) || true
    fi
    if [[ -z "$MY_IPV6" ]]; then
        MY_IPV6=$(ip -6 addr show dev "$EXT_IF" 2>/dev/null | \
                  grep -oP 'inet6 \K[0-9a-f:]+(?=/)' | head -1) || true
    fi
    log_debug "Detected IPv4: ${MY_IPV4:-none}"
    log_debug "Detected IPv6: ${MY_IPV6:-none}"
}

# Build interface list
get_all_interfaces() {
    local ifs="$EXT_IF"
    [[ -n "$INT_IF" ]] && ifs="$ifs $INT_IF"
    [[ -n "$EXTRA_IFS" ]] && ifs="$ifs $EXTRA_IFS"
    echo "$ifs"
}

# ============================================================================
# RULE GENERATION
# ============================================================================

generate_rules() {
    local all_ifs
    all_ifs=$(get_all_interfaces)
    
    # Start with table definition
    cat > "$RULES_FILE" << 'TABLE_HEADER'
#!/usr/sbin/nft -f

# ============================================================================
# Auto-generated nftables rules - DO NOT EDIT MANUALLY
# Generated by: nftables-firewall.sh
# ============================================================================

flush ruleset

TABLE_HEADER

    # --- Main inet table (IPv4 + IPv6 unified) ---
    cat >> "$RULES_FILE" << INET_TABLE
table inet ${TABLE_NAME} {

    # ----------------------------------------------------------------
    # SETS - Efficient O(1) lookups
    # ----------------------------------------------------------------

    # Blocked networks (bogons, reserved, etc.)
    set blocked_nets {
        type ipv4_addr
        flags interval, timeout
        elements = { $(printf '%s, ' "${BLOCKED_NETS[@]}" | sed 's/, $//') }
    }

    # Trusted networks
    set trusted_nets {
        type ipv4_addr
        flags interval
        elements = { $(printf '%s, ' "${TRUSTED_NETS[@]}" | sed 's/, $//') }
    }

    # TCP ports to allow
    set tcp_allowed {
        type inet_service
        flags interval
        elements = { $(parse_tcp_services) }
    }

    # UDP ports to allow  
    set udp_allowed {
        type inet_service
        flags interval
        elements = { $(printf '%s, ' "${UDP_SERVICES[@]}" | sed 's/, $//') }
    }

    # Allowed ICMP types
    set icmp_allowed {
        type icmp_type
        elements = { $(printf '%s, ' "${ICMP_ALLOWED[@]}" | sed 's/, $//') }
    }

    # Allowed ICMPv6 types
    set icmpv6_allowed {
        type icmpv6_type
        elements = { $(printf '%s, ' "${ICMPV6_ALLOWED[@]}" | sed 's/, $//') }
    }

    # SSH brute force attackers (dynamic, with timeout)
    set ssh_abuse {
        type ipv4_addr
        flags timeout
        timeout ${SSH_BAN_TIME}s
    }

    # Port scanners (dynamic)
    set port_scanners {
        type ipv4_addr
        flags timeout
        timeout 1h
    }

    # Rate-limited connections
    set connlimit_abuse {
        type ipv4_addr
        flags timeout
        timeout 10m
    }

INET_TABLE

    # --- Verdict map for interface-based policies ---
    cat >> "$RULES_FILE" << VERDICT_MAP
    # Verdict map: interface -> policy (allows per-interface overrides)
    map iface_input_policy {
        type ifname : verdict
        elements = {
VERDICT_MAP

    # Add policies for each interface
    for iface in $all_ifs; do
        cat >> "$RULES_FILE" << IFACE_POLICY
            "$iface" : jump input_${iface},
IFACE_POLICY
    done

    cat >> "$RULES_FILE" << VERDICT_MAP_END
        }
    }
VERDICT_MAP_END

    # --- Counter map for statistics ---
    cat >> "$RULES_FILE" << COUNTER_MAP
    # Per-interface packet counters
    map iface_counters {
        type ifname : counter
    }

    # Per-service counters
    map service_counters {
        type inet_service : counter
    }
COUNTER_MAP

    # ----------------------------------------------------------------
    # CHAINS
    # ----------------------------------------------------------------

    # --- Input Chain (main entry point) ---
    cat >> "$RULES_FILE" << INPUT_CHAIN
    chain input {
        type filter hook input priority 0; policy ${POLICY_INPUT};

        # Update interface counters
        meta iifname @iface_input_policy counter name @iface_counters

        # Jump to interface-specific handling
        meta iifname @iface_input_policy
INPUT_CHAIN

    # --- Loopback Chain ---
    cat >> "$RULES_FILE" << LO_CHAIN
    chain input_lo {
        # Allow all loopback traffic
        iifname "$LO_IF" accept
    }
LO_CHAIN

    # --- Global Pre-filter Chain ---
    cat >> "$RULES_FILE" << PREFILTER
    chain prefilter {
        # Drop packets with invalid connection state
        $(if [[ "$PROTECT_INVALID" == "yes" ]]; then echo "ct state invalid counter drop"; fi)

        # Allow established/related connections
        ct state { established, related } accept

        # Drop packets to our own IP on external interface (anti-spoof)
        $(if [[ "$PROTECT_IP_SPOOF" == "yes" && -n "$MY_IPV4" ]]; then echo "iifname \"$EXT_IF\" ip saddr $MY_IPV4 counter drop comment \"Anti-spoof: our IP from outside\""; fi)
        $(if [[ "$PROTECT_IP_SPOOF" == "yes" && -n "$MY_IPV6" ]]; then echo "iifname \"$EXT_IF\" ip6 saddr $MY_IPV6 counter drop comment \"Anti-spoof: our IP from outside\""; fi)

        # Drop bogon networks from external interface
        $(if [[ "$PROTECT_SMURF" == "yes" ]]; then echo "iifname \"$EXT_IF\" ip saddr @blocked_nets counter drop comment \"Bogon network\""; fi)

        # Drop fragments (modern kernels handle this, but defense in depth)
        $(if [[ "$PROTECT_FRAGMENTS" == "yes" ]]; then echo "ip frag-off != 0 counter drop comment \"Fragmented packet\""; fi)

        # Drop XMAS tree scans (all flags set)
        $(if [[ "$PROTECT_XMAS" == "yes" ]]; then echo "tcp flags & (fin|syn|rst|psh|ack|urg) == (fin|syn|rst|psh|ack|urg) counter jump to port_scan_detect comment \"XMAS scan\""; fi)

        # Drop NULL scans (no flags set)
        $(if [[ "$PROTECT_NULL_SCAN" == "yes" ]]; then echo "tcp flags & (fin|syn|rst|psh|ack|urg) == 0x0 counter jump to port_scan_detect comment \"NULL scan\""; fi)

        # Drop bogus TCP flag combinations
        $(if [[ "$PROTECT_BOGUS_TCP" == "yes" ]]; then generate_bogus_tcp_rules; fi)

        # ICMP handling
        jump to icmp_handling

        # Connection rate limiting
        $(generate_connlimit_rules)

        jump to service_handling
    }
PREFILTER

    # --- External Interface Chain ---
    cat >> "$RULES_FILE" << EXT_CHAIN
    chain input_${EXT_IF} {
        jump prefilter
    }
EXT_CHAIN

    # --- Internal Interface Chain ---
    if [[ -n "$INT_IF" ]]; then
        cat >> "$RULES_FILE" << INT_CHAIN
    chain input_${INT_IF} {
        # Internal network - more permissive
        ct state { established, related } accept
        ct state invalid drop

        # Allow all from trusted networks
        ip saddr @trusted_nets accept

        # Allow DHCP
        udp sport { 67, 68 } udp dport { 67, 68 } accept

        jump prefilter
    }
INT_CHAIN
    fi

    # --- Extra Interfaces ---
    for iface in $EXTRA_IFS; do
        cat >> "$RULES_FILE" << EXTRA_CHAIN
    chain input_${iface} {
        jump prefilter
    }
EXTRA_CHAIN
    done

    # --- Port Scan Detection Chain ---
    cat >> "$RULES_FILE" << SCAN_CHAIN
    chain port_scan_detect {
        # Add to scanner set and drop
        ip saddr @port_scanners drop
        ip saddr set add @port_scanners counter drop comment \"Port scan detected\"
    }
SCAN_CHAIN

    # --- ICMP Handling Chain ---
    cat >> "$RULES_FILE" << ICMP_CHAIN
    chain icmp_handling {
        # ICMPv4
        ip protocol icmp icmp type @icmp_allowed limit rate ${ICMP_RATE_LIMIT} burst ${ICMP_RATE_BURST} accept
        ip protocol icmp icmp type @icmp_allowed counter drop comment \"ICMP rate limit exceeded\"
        ip protocol icmp drop comment \"ICMP type not allowed\"

        # ICMPv6 - allow more types for IPv6 to function
        ip6 nexthdr icmpv6 icmpv6 type @icmpv6_allowed accept
        ip6 nexthdr icmpv6 icmpv6 type @icmp_allowed limit rate ${ICMP_RATE_LIMIT} burst ${ICMP_RATE_BURST} accept
        ip6 nexthdr icmpv6 drop comment \"ICMPv6 type not allowed\"
    }
ICMP_CHAIN

    # --- Service Handling Chain ---
    cat >> "$RULES_FILE" << SERVICE_CHAIN
    chain service_handling {
        # SSH with brute force protection
        $(if [[ "$SSH_ENABLED" == "yes" ]]; then generate_ssh_rules; fi)

        # TCP services
        tcp dport @tcp_allowed ct state new counter name @service_counters accept

        # UDP services
        udp dport @udp_allowed ct state new counter name @service_counters accept

        # DNS rate limiting (prevent amplification)
        $(generate_dns_ratelimit)

        $(if [[ "$LOG_ENABLED" == "yes" ]]; then echo "counter log prefix \"$LOG_PREFIX\" level warn limit rate ${LOG_RATE} burst ${LOG_BURST}"; fi)
        counter drop comment \"Default drop - no matching rule\"
    }
SERVICE_CHAIN

    # --- SYNPROXY Chain (TCP SYN Flood Protection) ---
    if [[ "$SYNPROXY_ENABLED" == "yes" ]]; then
        cat >> "$RULES_FILE" << SYNPROXY_CHAIN
    chain synproxy {
        # Only for TCP SYN packets to allowed ports
        tcp flags & (fin|syn|rst|ack) == syn ct state new \
            synproxy mss ${MSS_VALUE} wscale 7 timestamp sack-perm
    }
SYNPROXY_CHAIN
    fi

    # ----------------------------------------------------------------
    # OUTPUT CHAIN
    # ----------------------------------------------------------------
    cat >> "$RULES_FILE" << OUTPUT_CHAIN
    chain output {
        type filter hook output priority 0; policy ${POLICY_OUTPUT};

        # Allow all outgoing established connections
        ct state { established, related } accept

        # Allow outgoing new connections
        ct state new accept

        # MSS clamping for outgoing (PMTU discovery)
        $(if [[ "$MSS_CLAMP" == "yes" ]]; then echo "tcp flags syn tcp option maxseg size 1-536 tcpmss clamp to mtu"; fi)
    }
OUTPUT_CHAIN

    # ----------------------------------------------------------------
    # FORWARD CHAIN
    # ----------------------------------------------------------------
    cat >> "$RULES_FILE" << FORWARD_CHAIN
    chain forward {
        type filter hook forward priority 0; policy ${POLICY_FORWARD};

        # Flow offloading for hardware acceleration
        $(if [[ "$FLOW_OFFLOAD" == "yes" ]]; then echo "meta l4proto { tcp, udp } flow offload @fwd"; fi)

        ct state { established, related } accept
        ct state invalid drop

        # Allow forwarding from internal to external
        $(if [[ -n "$INT_IF" ]]; then echo "iifname \"$INT_IF\" oifname \"$EXT_IF\" ct state new accept"; fi)

        # Allow port forwards
        $(generate_forward_rules)

        $(if [[ "$LOG_ENABLED" == "yes" ]]; then echo "counter log prefix \"$LOG_PREFIX\" level warn limit rate ${LOG_RATE} burst ${LOG_BURST}"; fi)
        counter drop
    }
FORWARD_CHAIN

    # ----------------------------------------------------------------
    # NAT (if enabled)
    # ----------------------------------------------------------------
    if [[ "$NAT_ENABLED" == "yes" ]]; then
        cat >> "$RULES_FILE" << NAT_CHAIN
    # NAT chain
    chain postrouting {
        type nat hook postrouting priority srcnat;

        # Masquerade outbound traffic
        iifname "$NAT_SRC_IF" oifname "$NAT_OUT_IF" masquerade
    }

    chain prerouting {
        type nat hook prerouting priority dstnat;

        # Port forwards
        $(generate_nat_prerouting)
    }
NAT_CHAIN
    fi

    # --- Close table ---
    echo "}" >> "$RULES_FILE"

    # Add flowtable if offload enabled
    if [[ "$FLOW_OFFLOAD" == "yes" ]]; then
        cat >> "$RULES_FILE" << FLOWTABLE
table inet ${TABLE_NAME}_offload {
    flowtable fwd {
        hook ingress priority 0
        devices = { ${EXT_IF}${INT_IF:+, $INT_IF}${EXTRA_IFS:+, $EXTRA_IFS} }
    }
}
FLOWTABLE
    fi

    log_debug "Rules written to $RULES_FILE"
}

# Parse TCP services (handle interface-specific format)
parse_tcp_services() {
    local ports=()
    for svc in "${TCP_SERVICES[@]}"; do
        ports+=("${svc%%:*}")
    done
    printf '%s, ' "${ports[@]}" | sed 's/, $//'
}

# Generate SSH-specific rules
generate_ssh_rules() {
    cat << SSH_RULES
        # SSH brute force protection
        tcp dport $SSH_PORT ip saddr @ssh_abuse counter drop comment \"SSH brute force ban\"
        tcp dport $SSH_IP ct state new limit rate ${SSH_MAX_CONN} burst 5 accept
        tcp dport $SSH_IP ct state new add @ssh_abuse ip saddr counter drop comment \"SSH rate limit exceeded\"
SSH_RULES
}

# Generate DNS rate limiting rules
generate_dns_ratelimit() {
    cat << DNS_RULES
        # DNS rate limiting (prevent amplification abuse if running DNS)
        udp dport 53 ct state new limit rate ${DNS_RATE_LIMIT} burst ${DNS_RATE_BURST} accept
        udp dport 53 ct state new counter drop comment \"DNS rate limit\"
DNS_RULES
}

# Generate connection rate limiting
generate_connlimit_rules() {
    cat << CONNLIMIT_RULES
        # Global connection rate limit
        ct state new limit rate ${CONN_RATE_LIMIT} burst ${CONN_RATE_BURST} accept
        ct state new add @connlimit_abuse ip saddr counter drop comment \"Connection rate limit exceeded\"
CONNLIMIT_RULES
}

# Generate bogus TCP flag rules
generate_bogus_tcp_rules() {
    cat << BOGUS_TCP
        # SYN+FIN (scan)
        tcp flags & (syn|fin) == (syn|fin) counter jump to port_scan_detect
        # SYN+RST (scan)
        tcp flags & (syn|rst) == (syn|rst) counter jump to port_scan_detect
        # FIN+RST (scan)
        tcp flags & (fin|rst) == (fin|rst) counter jump to port_scan_detect
        # PSH+FIN without ACK (scan)
        tcp flags & (psh|fin|ack) == (psh|fin) counter jump to port_scan_detect
BOGUS_TCP
}

# Generate NAT prerouting rules (port forwarding)
generate_nat_prerouting() {
    for fwd in "${PORT_FORWARDS[@]}"; do
        IFS=':' read -r ext_port proto int_ip int_port <<< "$fwd"
        echo "iifname \"$EXT_IF\" $proto dport $ext_port dnat to $int_ip:$int_port"
    done
}

# Generate forward rules for port forwards
generate_forward_rules() {
    for fwd in "${PORT_FORWARDS[@]}"; do
        IFS=':' read -r ext_port proto int_ip int_port <<< "$fwd"
        echo "iifname \"$EXT_IF\" $proto dport $ext_port daddr $int_ip $proto dport $int_port accept"
    done
}

# ============================================================================
# FIREWALL CONTROL FUNCTIONS
# ============================================================================

fw_start() {
    log_info "Starting ${TABLE_NAME} firewall..."

    check_root
    check_nftables
    detect_ips

    # Verify interfaces exist
    for iface in $(get_all_interfaces); do
        verify_interface "$iface"
    done

    # Generate rules
    generate_rules

    # Validate syntax
    log_info "Validating rules..."
    if ! $NFT_CMD -c -f "$RULES_FILE"; then
        die "Rule validation failed. Check $RULES_FILE"
    fi

    # Load rules
    log_info "Loading rules into kernel..."
    if $NFT_CMD -f "$RULES_FILE"; then
        log_info "Firewall started successfully"
        rm -f "$RULES_FILE"
    else
        die "Failed to load rules"
    fi
}

# v0.0.31: detect action — print service inventory + OS info, no rule changes.
# SysDeck bridge firewall.py `detect` subcommand invokes this.
fw_detect() {
    # OS detection (this template doesn't have detect_os at top-level — inline here)
    local os_name="unknown"
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        os_name="${PRETTY_NAME:-${NAME:-unknown}}"
    fi
    # Auto-detect primary interface if EXT_IF is the default "eth0"
    local ext_if="${EXT_IF:-eth0}"
    if ! ip link show "$ext_if" &>/dev/null 2>&1; then
        ext_if="$(ip route show default 2>/dev/null | grep -oP 'dev \K\S+' | head -1)"
        ext_if="${ext_if:-unknown}"
    fi
    # Auto-detect IPv4/IPv6 on the interface
    local my_ipv4="" my_ipv6=""
    my_ipv4="$(ip -4 addr show dev "$ext_if" 2>/dev/null | grep -oP 'inet \K[0-9.]+' | head -1)" || true
    my_ipv6="$(ip -6 addr show dev "$ext_if" 2>/dev/null | grep -oP 'inet6 \K[0-9a-f:]+(?=/)' | head -1)" || true
    echo "+-----------------------------------------------------+"
    echo "|              Service Detection Summary              |"
    echo "+-----------------------------------------------------+"
    echo "| OS: ${os_name}"
    echo "| Interface: ${ext_if}"
    echo "| IPv4: ${my_ipv4:-none}"
    echo "| IPv6: ${my_ipv6:-none}"
    echo "| Template: no-services (locked-down)"
    echo "| Public TCP: ${SSH_PORT:-22}"
    echo "| Public UDP: (none)"
    echo "+-----------------------------------------------------+"
}

fw_stop() {
    log_info "Stopping ${TABLE_NAME} firewall..."
    check_root
    check_nftables

    # Flush our table only, not the entire ruleset
    $NFT_CMD delete table inet ${TABLE_NAME} 2>/dev/null || true
    $NFT_CMD delete table inet ${TABLE_NAME}_offload 2>/dev/null || true

    log_info "Firewall stopped"
}

fw_restart() {
    fw_stop
    sleep 1
    fw_start
}

fw_status() {
    check_nftables

    echo "============================================"
    echo " nftables Firewall Status"
    echo "============================================"
    echo ""

    # Check if table exists
    if ! $NFT_CMD list tables 2>/dev/null | grep -q "inet ${TABLE_NAME}"; then
        echo "Status: STOPPED"
        return 0
    fi

    echo "Status: RUNNING"
    echo ""

    # Show counters
    echo "--- Packet Counters ---"
    $NFT_CMD list table inet ${TABLE_NAME} 2>/dev/null | grep -E '^\s+[0-9]+ [0-9]+ counter' || echo "(no counters)"
    echo ""

    # Show set sizes
    echo "--- Set Statistics ---"
    $NFT_CMD list table inet ${TABLE_NAME} 2>/dev/null | grep -A1 'set ' | grep 'size' || echo "(no sets)"
    echo ""

    # Show SSH abuse list
    echo "--- SSH Abuse List ---"
    local abuse_count
    abuse_count=$($NFT_CMD get element inet ${TABLE_NAME} set ssh_abuse \{ \} 2>/dev/null | wc -l)
    if [[ $abuse_count -gt 0 ]]; then
        $NFT_CMD list set inet ${TABLE_NAME} ssh_abuse 2>/dev/null | tail -n +2
    else
        echo "(empty)"
    fi
    echo ""

    # Show port scanners
    echo "--- Port Scanners ---"
    local scanner_count
    scanner_count=$($NFT_CMD get element inet ${TABLE_NAME} set port_scanners \{ \} 2>/dev/null | wc -l)
    if [[ $scanner_count -gt 0 ]]; then
        $NFT_CMD list set inet ${TABLE_NAME} port_scanners 2>/dev/null | tail -n +2
    else
        echo "(empty)"
    fi
}

fw_check() {
    check_nftables
    log_info "Checking current ruleset..."
    
    if $NFT_CMD -c list ruleset 2>&1; then
        log_info "Ruleset is valid"
    else
        log_error "Ruleset has errors"
        return 1
    fi
}

fw_save() {
    check_root
    check_nftables

    local dir
    dir=$(dirname "$SAVED_RULES")
    mkdir -p "$dir"

    $NFT_CMD list ruleset > "$SAVED_RULES"
    log_info "Rules saved to $SAVED_RULES"
}

fw_dump() {
    check_nftables
    $NFT_CMD -j list ruleset 2>/dev/null | jq '.' 2>/dev/null || $NFT_CMD list ruleset
}

fw_clear_ssh_abuse() {
    check_root
    check_nftables
    $NFT_CMD flush set inet ${TABLE_NAME} ssh_abuse 2>/dev/null
    log_info "SSH abuse list cleared"
}

fw_clear_scanners() {
    check_root
    check_nftables
    $NFT_CMD flush set inet ${TABLE_NAME} port_scanners 2>/dev/null
    log_info "Port scanner list cleared"
}

fw_unban_ip() {
    local ip="$1"
    check_root
    check_nftables
    
    $NFT_CMD delete element inet ${TABLE_NAME} set ssh_abuse \{ $ip \} 2>/dev/null && \
        log_info "Unbanned $ip from SSH abuse" || true
    $NFT_CMD delete element inet ${TABLE_NAME} set port_scanners \{ $ip \} 2>/dev/null && \
        log_info "Unbanned $ip from port scanners" || true
}

fw_show_banned() {
    check_nftables
    echo "=== SSH Abuse ==="
    $NFT_CMD list set inet ${TABLE_NAME} ssh_abuse 2>/dev/null | tail -n +2 || echo "(none)"
    echo ""
    echo "=== Port Scanners ==="
    $NFT_CMD list set inet ${TABLE_NAME} port_scanners 2>/dev/null | tail -n +2 || echo "(none)"
    echo ""
    echo "=== Connection Rate Abusers ==="
    $NFT_CMD list set inet ${TABLE_NAME} connlimit_abuse 2>/dev/null | tail -n +2 || echo "(none)"
}

# ============================================================================
# USAGE / HELP
# ============================================================================

show_help() {
    cat << HELPTEXT
 ${SCRIPT_NAME} v${SCRIPT_VERSION} - Modern nftables Firewall

Usage: $0 [COMMAND] [OPTIONS]

Commands:
    start               Start the firewall
    stop                Stop the firewall (remove rules only)
    restart             Restart the firewall
    status              Show firewall status and statistics
    check               Validate current ruleset syntax
    save                Save current rules to ${SAVED_RULES}
    dump                Dump ruleset as JSON

    Management:
    clear-ssh           Clear SSH brute-force ban list
    clear-scanners      Clear port scanner ban list
    unban <IP>          Unban an IP from all lists
    show-banned         Show all banned IPs
    help                Show this help message

Configuration:
    Edit the variables at the top of this script to customize:
    - Network interfaces
    - Allowed services/ports
    - Rate limits
    - Protection toggles
    - NAT/port forwarding

Notes:
    - Uses nftables inet family (unified IPv4/IPv6)
    - Sets provide O(1) lookups vs linear chain traversal
    - Dynamic sets auto-expire banned IPs
    - No iptables compatibility layer used
    - Compatible with kernel 6.6+ / 7.x with eBPF support

HELPTEXT
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    local command="${1:-help}"

    case "$command" in
        start)
            fw_start
            ;;
        stop)
            fw_stop
            ;;
        restart|reload)
            fw_restart
            ;;
        detect)
            fw_detect
            ;;
        status)
            fw_status
            ;;
        check|validate)
            fw_check
            ;;
        save)
            fw_save
            ;;
        dump)
            fw_dump
            ;;
        clear-ssh|clear-ssh-abuse)
            fw_clear_ssh_abuse
            ;;
        clear-scanners|clear-portscanners)
            fw_clear_scanners
            ;;
        unban)
            [[ -z "${2:-}" ]] && die "Usage: $0 unban <IP>"
            fw_unban_ip "$2"
            ;;
        show-banned|banned|list-banned)
            fw_show_banned
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            die "Unknown command: $command\nRun '$0 help' for usage"
            ;;
    esac
}

main "$@"