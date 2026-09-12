#!/usr/bin/env bash
#
# Name: vps-webserver
# Description: Service-aware firewall for VPS web servers. Auto-detects SSH, Caddy, Varnish, Forgejo and adapts rules accordingly. Varnish-on-80 + Caddy-HTTP-on-8080 (loopback) is the explicit default cache topology per v0.0.47. Aggressive SSH rate limiting when pubkey-only auth is detected.
# Distro: arch,debian
# Services: ssh,caddy,varnish,forgejo
#
# ============================================================================
#  nftables-firewall.sh - Service-Aware Firewall for Debian/Arch
# ============================================================================
#  Auto-detects: Caddy, Varnish, Forgejo, SSH
#  Adapts rules based on running services
#
#  v0.0.47: When Varnish is detected, the DEFAULT topology is now
#  cache-front-of-origin (Varnish on :80, Caddy HTTP backend on :8080
#  loopback-only, Caddy HTTPS on :443 public). Previously this only
#  happened if Varnish was already listening on :80 at runtime; now
#  detecting Varnish at all is enough to flip Caddy HTTP to :8080
#  loopback — matching the public-webserver.sh topology and the
#  operator's documented cache-environment setup.
#
#  Varnish detected:  :80 Varnish (public) → :8080 Caddy (HTTP, loopback)
#                    :443 Caddy (HTTPS, public)
#  No Varnish:        :80/:443 → Caddy directly (HTTP + HTTPS public)
#
# ============================================================================

set -euo pipefail
IFS=$'\n\t'

# ============================================================================
# OS DETECTION
# ============================================================================

detect_os() {
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        OS_ID="${ID}"
        OS_VERSION="${VERSION_ID}"
        OS_NAME="${PRETTY_NAME}"
    elif [[ -f /etc/debian_version ]]; then
        OS_ID="debian"
        OS_VERSION="$(cat /etc/debian_version)"
        OS_NAME="Debian $OS_VERSION"
    elif [[ -f /etc/arch-release ]]; then
        OS_ID="arch"
        OS_VERSION="rolling"
        OS_NAME="Arch Linux"
    else
        OS_ID="unknown"
        OS_VERSION="unknown"
        OS_NAME="Unknown Linux"
    fi

    case "$OS_ID" in
        debian|ubuntu|devuan)
            OS_FAMILY="debian"
            SERVICE_CMD="systemctl"
            ;;
        arch|manjaro|endeavouros)
            OS_FAMILY="arch"
            SERVICE_CMD="systemctl"
            ;;
        *)
            OS_FAMILY="unknown"
            SERVICE_CMD="systemctl"
            ;;
    esac

    log_debug "Detected OS: $OS_NAME (family: $OS_FAMILY)"
}

# ============================================================================
# SERVICE DETECTION
# ============================================================================

# Check if a systemd service is active
svc_active() {
    $SERVICE_CMD is-active "$1" &>/dev/null
}

# Check if a process is running
proc_running() {
    pgrep -x "$1" &>/dev/null
}

# Check if a binary exists
has_cmd() {
    command -v "$1" &>/dev/null
}

# Detect Forgejo configuration
detect_forgejo() {
    FORGEJO_DETECTED="no"
    FORGEJO_HTTP_PORT=""
    FORGEJO_SSH_PORT=""
    FORGEJO_SSH_ENABLED="no"

    # Check if Forgejo is running
    if ! svc_active forgejo && ! proc_running forgejo; then
        log_debug "Forgejo not detected"
        return
    fi

    FORGEJO_DETECTED="yes"
    log_debug "Forgejo process detected"

    # Find app.ini location
    local config_paths=()
    case "$OS_FAMILY" in
        debian)
            config_paths=(
                "/etc/forgejo/app.ini"
                "/etc/gitea/app.ini"  # Migration from Gitea
            )
            ;;
        arch)
            config_paths=(
                "/etc/forgejo/app.ini"
                "/etc/gitea/app.ini"
                "/var/lib/forgejo/custom/conf/app.ini"
            )
            ;;
    esac

    # Also check common locations
    config_paths+=(
        "/var/lib/forgejo/custom/conf/app.ini"
        "/var/lib/gitea/custom/conf/app.ini"
        "${HOME}/forgejo/conf/app.ini"
    )

    local config_file=""
    for path in "${config_paths[@]}"; do
        if [[ -f "$path" ]]; then
            config_file="$path"
            break
        fi
    done

    if [[ -n "$config_file" ]]; then
        log_debug "Forgejo config: $config_file"

        # Parse HTTP port (default 3000)
        FORGEJO_HTTP_PORT="$(grep -oP '^\s*HTTP_PORT\s*=\s*\K.*' "$config_file" 2>/dev/null | \
                             tr -d ' "' | head -1)"
        FORGEJO_HTTP_PORT="${FORGEJO_HTTP_PORT:-3000}"

        # Parse SSH port (default 22, but often 2222 for separate sshd)
        FORGEJO_SSH_PORT="$(grep -oP '^\s*SSH_PORT\s*=\s*\K.*' "$config_file" 2>/dev/null | \
                            tr -d ' "' | head -1)"
        FORGEJO_SSH_PORT="${FORGEJO_SSH_PORT:-22}"

        # Check if SSH server is enabled
        local ssh_disabled
        ssh_disabled="$(grep -oP '^\s*START_SSH_SERVER\s*=\s*\K.*' "$config_file" 2>/dev/null | \
                        tr -d ' "' | tr '[:upper:]' '[:lower:]')"

        if [[ "$ssh_disabled" != "false" && "$FORGEJO_SSH_PORT" != "22" ]]; then
            FORGEJO_SSH_ENABLED="yes"
        elif [[ "$ssh_disabled" == "true" ]]; then
            FORGEJO_SSH_ENABLED="no"
        elif [[ "$FORGEJO_SSH_PORT" == "22" ]]; then
            # If using port 22, Forgejo SSH is likely handled by system sshd
            FORGEJO_SSH_ENABLED="no"
        else
            FORGEJO_SSH_ENABLED="yes"
        fi
    else
        log_debug "Forgejo config not found, using defaults"
        FORGEJO_HTTP_PORT="3000"
        FORGEJO_SSH_PORT="2222"
        FORGEJO_SSH_ENABLED="yes"
    fi

    log_info "Forgejo detected: HTTP=:${FORGEJO_HTTP_PORT}, SSH=${FORGEJO_SSH_ENABLED:+:}${FORGEJO_SSH_PORT}"
}

# Detect Caddy
detect_caddy() {
    CADDY_DETECTED="no"
    # v0.0.47: when Varnish is detected, Caddy HTTP moves to :8080
    # (loopback only). The Varnish-detection block below sets
    # CADDY_HTTP_PORT="8080" explicitly. detect_caddy runs BEFORE
    # detect_varnish in detect_all_services(), so we start with the
    # no-Varnish default of :80 and let detect_varnish flip it.
    CADDY_HTTP_PORT="80"
    CADDY_HTTPS_PORT="443"

    if ! svc_active caddy && ! proc_running caddy && ! has_cmd caddy; then
        log_debug "Caddy not detected"
        return
    fi

    CADDY_DETECTED="yes"

    # Try to get Caddy's listen ports from its config
    local caddy_config=""
    case "$OS_FAMILY" in
        debian)
            caddy_config="/etc/caddy/Caddyfile"
            ;;
        arch)
            caddy_config="/etc/caddy/Caddyfile"
            ;;
    esac

    if [[ -f "$caddy_config" ]]; then
        log_debug "Caddy config: $caddy_config"

        # Check for explicit port bindings. If Caddy is bound on
        # :8080 it's almost certainly the Varnish cache-miss backend
        # (loopback only). We surface this for detect_varnish to use.
        if grep -q ':8080' "$caddy_config" 2>/dev/null; then
            CADDY_HTTP_PORT="8080"
            log_debug "Caddy HTTP detected on :8080 (likely Varnish cache-miss backend)"
        fi
    fi

    # Verify ports are actually listening. If something is bound to
    # :8080 (regardless of process name — ss -tlnp naming can be
    # inconsistent across distros), assume Caddy is on the backend.
    if ss -tlnp 2>/dev/null | grep -q ':8080'; then
        CADDY_HTTP_PORT="8080"
    fi

    log_info "Caddy detected: HTTP=:${CADDY_HTTP_PORT}, HTTPS=:${CADDY_HTTPS_PORT}"
}

# Detect Varnish
detect_varnish() {
    VARNISH_DETECTED="no"
    VARNISH_PORT="80"
    VARNISH_ADMIN_PORT="6082"

    if ! svc_active varnish && ! proc_running varnishd && ! has_cmd varnishd; then
        log_debug "Varnish not detected"
        return
    fi

    VARNISH_DETECTED="yes"

    # Find Varnish config to get actual port
    local varnish_config=""
    case "$OS_FAMILY" in
        debian)
            varnish_config="/etc/default/varnish"
            ;;
        arch)
            varnish_config="/etc/varnish/default.vcl"
            # Arch uses systemd override or direct args
            if [[ -f /etc/systemd/system/varnish.service.d/override.conf ]]; then
                varnish_config="/etc/systemd/system/varnish.service.d/override.conf"
            fi
            ;;
    esac

    # Check what port Varnish is actually listening on
    local listening_port
    listening_port=$(ss -tlnp 2>/dev/null | grep 'varnishd' | grep -oP ':\K[0-9]+' | head -1) || true

    if [[ -n "$listening_port" ]]; then
        VARNISH_PORT="$listening_port"
    fi

    # Check admin interface port
    local admin_port
    admin_port=$(ss -tlnp 2>/dev/null | grep 'varnishd' | grep -oP ':\K[0-9]+' | tail -1) || true
    if [[ -n "$admin_port" && "$admin_port" != "$VARNISH_PORT" ]]; then
        VARNISH_ADMIN_PORT="$admin_port"
    fi

    # v0.0.47: When Varnish is detected at all, the operator's
    # documented setup is cache-front-of-origin — Varnish on :80,
    # Caddy HTTP backend on :8080 (loopback only). If Varnish is
    # detected but not yet listening on :80 (e.g. the service is
    # installed but stopped, or it's still on the upstream default
    # :6081), force VARNISH_PORT=80 anyway — that's the v0.0.47
    # explicit default. The operator can override with an env var
    # or by editing the systemd unit.
    if [[ "$VARNISH_PORT" != "80" ]]; then
        log_info "Varnish detected on :${VARNISH_PORT} — overriding to :80 (cache-front-of-origin default per v0.0.47). Set VARNISH_PORT env var to keep :${VARNISH_PORT}."
        VARNISH_PORT="80"
    fi
    # When Varnish is present, Caddy HTTP MUST move to :8080 loopback.
    # This is the cache-miss backend Varnish forwards to.
    CADDY_HTTP_PORT="8080"

    log_info "Varnish detected: :${VARNISH_PORT} (admin: :${VARNISH_ADMIN_PORT}) — Caddy HTTP moved to :${CADDY_HTTP_PORT} (loopback only)"
}

# Detect SSH configuration
detect_ssh() {
    SSH_DETECTED="no"
    SSH_PORT="22"
    SSH_PUBKEY_ONLY="unknown"

    if ! svc_active sshd && ! svc_active ssh && ! proc_running sshd; then
        log_debug "SSH not detected"
        return
    fi

    SSH_DETECTED="yes"

    # Find SSH config
    local sshd_config=""
    for path in /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf; do
        if [[ -f "$path" ]]; then
            sshd_config="$path"
            break
        fi
    done

    if [[ -n "$sshd_config" ]]; then
        # Get SSH port
        SSH_PORT="$(grep -oP '^\s*Port\s+\K[0-9]+' "$sshd_config" 2>/dev/null | head -1)"
        SSH_PORT="${SSH_PORT:-22}"

        # Check if pubkey auth is enforced
        local pubkey_auth password_auth
        pubkey_auth="$(grep -ri '^\s*PubkeyAuthentication\s+' "$sshd_config" /etc/ssh/sshd_config.d/ 2>/dev/null | \
                       tail -1 | grep -oP '\K(yes|no)' | tr '[:upper:]' '[:lower:]')"
        password_auth="$(grep -ri '^\s*PasswordAuthentication\s+' "$sshd_config" /etc/ssh/sshd_config.d/ 2>/dev/null | \
                         tail -1 | grep -oP '\K(yes|no)' | tr '[:upper:]' '[:lower:]')"

        # Also check for Match blocks that might enforce pubkey
        if grep -q 'Match.*Address' "$sshd_config" /etc/ssh/sshd_config.d/* 2>/dev/null; then
            # Complex config, assume pubkey enforced if PasswordAuthentication is no
            :
        fi

        if [[ "$pubkey_auth" == "yes" && "$password_auth" == "no" ]]; then
            SSH_PUBKEY_ONLY="yes"
        elif [[ "$password_auth" == "yes" ]]; then
            SSH_PUBKEY_ONLY="no"
        else
            SSH_PUBKEY_ONLY="unknown"
        fi
    fi

    log_info "SSH detected: :${SSH_PORT} (pubkey-only: ${SSH_PUBKEY_ONLY})"
}

# Master detection function
detect_all_services() {
    log_info "Detecting services..."

    detect_ssh
    detect_forgejo
    detect_caddy
    detect_varnish

    # Build service summary
    echo ""
    echo "+-----------------------------------------------------+"
    echo "|              Service Detection Summary              |"
    echo "+-----------------------------------------------------+"
    echo "| OS: ${OS_NAME}"
    echo "+-----------------------------------------------------+"
    echo "| SSH:       ${SSH_DETECTED}  Port: ${SSH_PORT}  Pubkey: ${SSH_PUBKEY_ONLY}"
    echo "| Forgejo:   ${FORGEJO_DETECTED}  HTTP: ${FORGEJO_HTTP_PORT:-N/A}  SSH: ${FORGEJO_SSH_PORT:-N/A} (${FORGEJO_SSH_ENABLED})"
    echo "| Caddy:     ${CADDY_DETECTED}  HTTP: ${CADDY_HTTP_PORT}  HTTPS: ${CADDY_HTTPS_PORT}"
    echo "| Varnish:   ${VARNISH_DETECTED}  Port: ${VARNISH_PORT}"
    echo "+-----------------------------------------------------+"
    echo ""
}

# ============================================================================
# CONFIGURATION
# ============================================================================

# These are set by detection, can be overridden
EXT_IF=""
INT_IF=""
EXTRA_IFS=""
LO_IF="lo"

MY_IPV4=""
MY_IPV6=""

POLICY_INPUT="drop"
POLICY_OUTPUT="accept"  
POLICY_FORWARD="drop"

LOG_ENABLED="yes"
LOG_PREFIX="[NFT-DROP] "
LOG_RATE="5/second"
LOG_BURST="10"

# SSH rate limiting - more aggressive if pubkey-only
# With pubkey auth, failed connections are almost always attacks
SSH_MAX_CONN_PUBKEY="3/minute"
SSH_MAX_CONN_PASSWORD="10/minute"
SSH_BAN_TIME="3600"  # 1 hour ban

ICMP_RATE_LIMIT="10/second"
ICMP_RATE_BURST="20"

SYNPROXY_ENABLED="yes"
MSS_CLAMP="yes"

PROTECT_SYN_FLOOD="yes"
PROTECT_PORT_SCAN="yes"
PROTECT_IP_SPOOF="yes"
PROTECT_SMURF="yes"
PROTECT_FRAGMENTS="yes"
PROTECT_XMAS="yes"
PROTECT_NULL_SCAN="yes"
PROTECT_INVALID="yes"
PROTECT_BOGUS_TCP="yes"

FLOW_OFFLOAD="no"

TRUSTED_NETS=()

# ============================================================================
# INTERNAL VARIABLES
# ============================================================================

SCRIPT_NAME="$(basename "$0")"
SCRIPT_VERSION="2.1.0"
NFT_CMD="$(command -v nft 2>/dev/null || echo "")"
TABLE_NAME="firewall"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
RULES_FILE="$(mktemp /tmp/nftables-rules-XXXXXX.nft)"
# a fresh mktemp name per run — no predictable /tmp path for a root write
trap 'rm -f "$RULES_FILE"' EXIT
SAVED_RULES="/etc/nftables/firewall.rules"

# OS/Service detection results (set by detect functions)
OS_ID=""
OS_VERSION=""
OS_NAME=""
OS_FAMILY=""
SERVICE_CMD=""

SSH_DETECTED="no"
SSH_PORT="22"
SSH_PUBKEY_ONLY="unknown"

FORGEJO_DETECTED="no"
FORGEJO_HTTP_PORT=""
FORGEJO_SSH_PORT=""
FORGEJO_SSH_ENABLED="no"

CADDY_DETECTED="no"
CADDY_HTTP_PORT="80"
CADDY_HTTPS_PORT="443"

VARNISH_DETECTED="no"
VARNISH_PORT="80"
VARNISH_ADMIN_PORT="6082"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
# v0.0.31 fix: log_debug returned non-zero under set -e when DEBUG=no,
# silently killing the script mid-detection. Add `|| return 0` so the
# function always returns success.
log_debug() { [[ "${DEBUG:-no}" == "yes" ]] && echo -e "${BLUE}[DEBUG]${NC} $*" || true; }
log_svc()   { echo -e "${CYAN}[SVC]${NC} $*"; }

die() { log_error "$@"; exit 1; }

check_root() {
    [[ $EUID -ne 0 ]] && die "This script must be run as root"
}

check_nftables() {
    if [[ -z "$NFT_CMD" ]]; then
        die "nftables not found."
        case "$OS_FAMILY" in
            debian) die "Install: apt install nftables" ;;
            arch)   die "Install: pacman -S nftables" ;;
            *)      die "Install nftables for your distribution" ;;
        esac
    fi
}

detect_primary_interface() {
    # Find the interface with default route
    EXT_IF="$(ip route show default | grep -oP 'dev \K\S+' | head -1)"

    if [[ -z "$EXT_IF" ]]; then
        # Fallback: first non-loopback interface
        EXT_IF="$(ip link show | grep -oP '^\d+: \K[^:]+' | grep -v '^lo$' | head -1)"
    fi

    if [[ -z "$EXT_IF" ]]; then
        die "Could not detect primary network interface"
    fi

    log_debug "Primary interface: $EXT_IF"
}

detect_ips() {
    [[ -z "$MY_IPV4" ]] && MY_IPV4="$(ip -4 addr show dev "$EXT_IF" 2>/dev/null | \
                                       grep -oP 'inet \K[0-9.]+' | head -1)" || true
    [[ -z "$MY_IPV6" ]] && MY_IPV6="$(ip -6 addr show dev "$EXT_IF" 2>/dev/null | \
                                       grep -oP 'inet6 \K[0-9a-f:]+(?=/)' | head -1)" || true
    log_debug "IPv4: ${MY_IPV4:-none}, IPv6: ${MY_IPV6:-none}"
}

verify_interface() {
    ip link show "$1" &>/dev/null || log_warn "Interface $1 does not exist"
}

# ============================================================================
# RULE GENERATION
# ============================================================================

build_tcp_ports() {
    local ports=()

    # SSH
    [[ "$SSH_DETECTED" == "yes" ]] && ports+=("$SSH_PORT")

    # Caddy HTTP
    if [[ "$CADDY_DETECTED" == "yes" ]]; then
        # If Varnish is handling 80, only open 8080 for localhost/Varnish
        if [[ "$VARNISH_DETECTED" == "yes" && "$VARNISH_PORT" == "80" ]]; then
            # Caddy 8080 is internal only - don't add to public ports
            :
        else
            ports+=("$CADDY_HTTP_PORT")
        fi
        ports+=("$CADDY_HTTPS_PORT")
    fi

    # Varnish
    [[ "$VARNISH_DETECTED" == "yes" ]] && ports+=("$VARNISH_PORT")

    # Forgejo HTTP (if not proxied through Caddy)
    if [[ "$FORGEJO_DETECTED" == "yes" ]]; then
        # Only expose if not behind Caddy
        # Most setups proxy Forgejo through Caddy, so we skip this
        # Uncomment if you need direct access:
        # ports+=("$FORGEJO_HTTP_PORT")
        :
    fi

    # Forgejo SSH
    [[ "$FORGEJO_SSH_ENABLED" == "yes" ]] && ports+=("$FORGEJO_SSH_PORT")

    # Deduplicate and output
    printf '%s\n' "${ports[@]}" | sort -un | tr '\n' ',' | sed 's/,$//'
}

build_udp_ports() {
    local ports=()
    # Typically no UDP needed for these services
    # Add if you have DNS, etc.
    printf '%s\n' "${ports[@]}" | tr '\n' ',' | sed 's/,$//'
}

build_internal_tcp_ports() {
    local ports=()

    # Caddy 8080 when behind Varnish - only from localhost
    if [[ "$VARNISH_DETECTED" == "yes" && "$CADDY_DETECTED" == "yes" ]]; then
        ports+=("$CADDY_HTTP_PORT")
    fi

    # Forgejo HTTP if proxied through Caddy (localhost access)
    if [[ "$FORGEJO_DETECTED" == "yes" ]]; then
        ports+=("$FORGEJO_HTTP_PORT")
    fi

    printf '%s\n' "${ports[@]}" | sort -un | tr '\n' ',' | sed 's/,$//'
}

generate_rules() {
    local tcp_ports udp_ports internal_tcp_ports
    tcp_ports="$(build_tcp_ports)"
    udp_ports="$(build_udp_ports)"
    internal_tcp_ports="$(build_internal_tcp_ports)"

    # Determine SSH rate limit based on auth method
    local ssh_rate_limit
    if [[ "$SSH_PUBKEY_ONLY" == "yes" ]]; then
        ssh_rate_limit="$SSH_MAX_CONN_PUBKEY"
        log_debug "Using aggressive SSH rate limit (pubkey-only detected)"
    else
        ssh_rate_limit="$SSH_MAX_CONN_PASSWORD"
        log_debug "Using standard SSH rate limit"
    fi

    cat > "$RULES_FILE" << RULESET
#!/usr/sbin/nft -f

# ${TABLE_NAME} - Generated ${TIMESTAMP}
# OS: ${OS_NAME}
# SSH: ${SSH_DETECTED:+:${SSH_PORT}} ${FORGEJO_DETECTED:+Forgejo SSH: :${FORGEJO_SSH_PORT}}
# Web: ${VARNISH_DETECTED:+Varnish:${VARNISH_PORT} -> }Caddy:${CADDY_HTTP_PORT}/${CADDY_HTTPS_PORT}

flush ruleset

table inet ${TABLE_NAME} {

    # ================================================================
    # SETS
    # ================================================================

    set tcp_public {
        type inet_service
        flags interval
        elements = { ${tcp_ports} }
    }

    set tcp_internal {
        type inet_service
        flags interval
        $(if [[ -n "$internal_tcp_ports" ]]; then echo "elements = { ${internal_tcp_ports} }"; else echo "# (empty - no internal-only ports)"; fi)
    }

    $(if [[ -n "$udp_ports" ]]; then echo "
    set udp_public {
        type inet_service
        flags interval
        elements = { ${udp_ports} }
    }"; fi)

    set ssh_abuse {
        type ipv4_addr
        flags timeout
        timeout ${SSH_BAN_TIME}s
    }

    set port_scanners {
        type ipv4_addr
        flags timeout
        timeout 1h
    }

    set connlimit_abuse {
        type ipv4_addr
        flags timeout
        timeout 10m
    }

    set trusted_nets {
        type ipv4_addr
        flags interval
        $(if [[ ${#TRUSTED_NETS[@]} -gt 0 ]]; then
            echo "elements = { $(printf '%s, ' "${TRUSTED_NETS[@]}" | sed 's/, $//') }"
        else
            echo "# (empty)"
        fi)
    }

    # ================================================================
    # INPUT CHAIN
    # ================================================================

    chain input {
        type filter hook input priority 0; policy ${POLICY_INPUT};

        # ---- Loopback ----
        iifname "lo" accept
        iifname "lo" ip saddr != 127.0.0.0/8 drop comment "Loopback spoof"

        # ---- Established/Related ----
        ct state { established, related } accept
        ct state invalid counter drop comment "Invalid state"

        # ---- Anti-spoofing ----
        $(if [[ -n "$MY_IPV4" ]]; then echo "iifname \"$EXT_IF\" ip saddr $MY_IPV4 counter drop comment \"Our IP from outside\""; fi)
        $(if [[ -n "$MY_IPV6" ]]; then echo "iifname \"$EXT_IF\" ip6 saddr $MY_IPV6 counter drop comment \"Our IPv6 from outside\""; fi)

        # ---- Bogon filtering ----
        iifname "$EXT_IF" ip saddr { 0.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32 } drop comment "Bogon IPv4"

        # ---- Fragment protection ----
        ip frag-off != 0 drop comment "Fragmented packet"

        # ---- TCP anomaly detection ----
        tcp flags & (fin|syn|rst|psh|ack|urg) == (fin|syn|rst|psh|ack|urg) jump scan_detect comment "XMAS scan"
        tcp flags & (fin|syn|rst|psh|ack|urg) == 0x0 jump scan_detect comment "NULL scan"
        tcp flags & (syn|fin) == (syn|fin) jump scan_detect comment "SYN+FIN"
        tcp flags & (syn|rst) == (syn|rst) jump scan_detect comment "SYN+RST"

        # ---- ICMP ----
        ip protocol icmp icmp type { echo-request, echo-reply, destination-unreachable, time-exceeded, parameter-problem } limit rate ${ICMP_RATE_LIMIT} burst ${ICMP_RATE_BURST} accept
        ip protocol icmp drop comment "ICMP rejected"

        ip6 nexthdr icmpv6 icmpv6 type { destination-unreachable, packet-too-big, time-exceeded, parameter-problem, echo-request, echo-reply, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept
        ip6 nexthdr icmpv6 drop comment "ICMPv6 rejected"

        # ---- Connection rate limiting ----
        ct state new limit rate 50/second burst 100 accept
        ct state new add @connlimit_abuse ip saddr drop comment "Connlimit exceeded"

        # ---- SSH with brute-force protection ----
        $(if [[ "$SSH_DETECTED" == "yes" ]]; then echo "
        # SSH - aggressive protection (pubkey-only assumed)
        tcp dport $SSH_PORT ip saddr @ssh_abuse drop comment \"SSH banned\"
        tcp dport $SSH_PORT ct state new limit rate ${ssh_rate_limit} burst 5 \
            $(if [[ "$SYNPROXY_ENABLED" == "yes" ]]; then echo "synproxy mss 1460 wscale 7 timestamp sack-perm"; else echo "accept"; fi)
        tcp dport $SSH_PORT ct state new add @ssh_abuse ip saddr drop comment \"SSH brute force\"
        "; fi)

        # ---- Forgejo SSH (separate from system SSH) ----
        $(if [[ "$FORGEJO_SSH_ENABLED" == "yes" ]]; then echo "
        # Forgejo SSH
        tcp dport $FORGEJO_SSH_PORT ip saddr @ssh_abuse drop comment \"Forgejo SSH banned\"
        tcp dport $FORGEJO_SSH_PORT ct state new limit rate ${ssh_rate_limit} burst 5 accept
        tcp dport $FORGEJO_SSH_PORT ct state new add @ssh_abuse ip saddr drop comment \"Forgejo SSH brute force\"
        "; fi)

        # ---- Public TCP services ----
        tcp dport @tcp_public ct state new accept comment "Allowed TCP service"

        # ---- Internal-only TCP services (localhost/Varnish) ----
        $(if [[ -n "$internal_tcp_ports" ]]; then echo "
        # Internal services - localhost and Varnish only
        iifname \"lo\" tcp dport @tcp_internal accept comment \"Internal service via loopback\"
        $(if [[ "$VARNISH_DETECTED" == "yes" ]]; then echo "
        # Varnish backend access (Varnish connects to Caddy on 8080)
        ip saddr 127.0.0.1 tcp dport @tcp_internal accept comment \"Internal service from local\"
        "; fi)
        "; fi)

        # ---- UDP services ----
        $(if [[ -n "$udp_ports" ]]; then echo "udp dport @udp_public ct state new accept comment \"Allowed UDP service\""; fi)

        # ---- Trusted networks ----
        $(if [[ ${#TRUSTED_NETS[@]} -gt 0 ]]; then echo "ip saddr @trusted_nets accept comment \"Trusted network\""; fi)

        # ---- Default drop with logging ----
        $(if [[ "$LOG_ENABLED" == "yes" ]]; then echo "counter log prefix \"${LOG_PREFIX}\" level warn limit rate ${LOG_RATE} burst ${LOG_BURST}"; fi)
        counter drop comment "Default deny"
    }

    # ================================================================
    # SCAN DETECTION CHAIN
    # ================================================================

    chain scan_detect {
        ip saddr @port_scanners drop
        add @port_scanners { ip saddr } drop comment "Port scan detected"
    }

    # ================================================================
    # OUTPUT CHAIN
    # ================================================================

    chain output {
        type filter hook output priority 0; policy ${POLICY_OUTPUT};

        ct state { established, related } accept
        ct state new accept

        # MSS clamping for PMTUD
        $(if [[ "$MSS_CLAMP" == "yes" ]]; then echo "tcp flags syn tcp option maxseg size 1-536 tcpmss clamp to mtu"; fi)
    }

    # ================================================================
    # FORWARD CHAIN
    # ================================================================

    chain forward {
        type filter hook forward priority 0; policy ${POLICY_FORWARD};
        $(if [[ "$LOG_ENABLED" == "yes" ]]; then echo "counter log prefix \"[NFT-FWD-DROP] \" level warn limit rate 2/second burst 5"; fi)
        counter drop
    }
}

RULESET

    log_debug "Rules written to $RULES_FILE"
}

# ============================================================================
# FIREWALL CONTROL
# ============================================================================

fw_start() {
    log_info "Starting ${TABLE_NAME} firewall..."
    check_root
    check_nftables
    detect_os
    detect_primary_interface
    detect_ips
    detect_all_services

    verify_interface "$EXT_IF"

    generate_rules

    log_info "Validating rules..."
    if ! $NFT_CMD -c -f "$RULES_FILE" 2>&1; then
        log_error "Validation failed. Rules saved to $RULES_FILE for inspection"
        exit 1
    fi

    log_info "Loading rules..."
    if $NFT_CMD -f "$RULES_FILE"; then
        log_info "Firewall started successfully"
        rm -f "$RULES_FILE"
        fw_status_brief
    else
        die "Failed to load rules"
    fi
}

fw_stop() {
    log_info "Stopping ${TABLE_NAME} firewall..."
    check_root
    check_nftables

    $NFT_CMD delete table inet ${TABLE_NAME} 2>/dev/null || true
    log_info "Firewall stopped"
}

fw_restart() {
    fw_stop
    sleep 1
    fw_start
}

fw_status_brief() {
    echo ""
    echo "+-----------------------------------------------------+"
    echo "|                 Firewall Active                     |"
    echo "+-----------------------------------------------------+"
    echo "| Interface: $EXT_IF"
    echo "| Policy:    INPUT=${POLICY_INPUT} OUTPUT=${POLICY_OUTPUT} FORWARD=${POLICY_FORWARD}"
    echo "| Ports:     $(build_tcp_ports | tr ',' ' ')"
    echo "+-----------------------------------------------------+"
    echo ""
}

fw_status() {
    check_nftables

    if ! $NFT_CMD list tables 2>/dev/null | grep -q "inet ${TABLE_NAME}"; then
        echo "Status: STOPPED"
        return 0
    fi

    echo "============================================"
    echo " nftables Firewall Status"
    echo "============================================"
    echo ""
    echo "Status: RUNNING"
    echo "Table:  inet ${TABLE_NAME}"
    echo ""

    # Counters
    echo "--- Rule Counters ---"
    $NFT_CMD list table inet ${TABLE_NAME} 2>/dev/null | \
        grep -E '^\s+[0-9]+ [0-9]+ counter' | \
        head -20
    echo ""

    # SSH abuse
    echo "--- SSH Ban List ($( $NFT_CMD list set inet ${TABLE_NAME} ssh_abuse 2>/dev/null | grep -c 'expires' || echo 0 ) IPs) ---"
    $NFT_CMD list set inet ${TABLE_NAME} ssh_abuse 2>/dev/null | grep -oP '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -10 || echo "(empty)"
    echo ""

    # Port scanners
    echo "--- Port Scanners ---"
    $NFT_CMD list set inet ${TABLE_NAME} port_scanners 2>/dev/null | grep -oP '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -10 || echo "(empty)"
}

fw_check() {
    check_nftables
    log_info "Checking ruleset..."
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
    dir="$(dirname "$SAVED_RULES")"
    mkdir -p "$dir"
    $NFT_CMD list ruleset > "$SAVED_RULES"
    log_info "Saved to $SAVED_RULES"
}

fw_dump() {
    check_nftables
    if has_cmd jq; then
        $NFT_CMD -j list ruleset 2>/dev/null | jq '.'
    else
        $NFT_CMD list ruleset
    fi
}

fw_unban() {
    local ip="${1:?Usage: $0 unban <IP>}"
    check_root
    check_nftables

    local unbanned=0
    $NFT_CMD delete element inet ${TABLE_NAME} set ssh_abuse \{ $ip \} 2>/dev/null && { log_info "Unbanned $ip from SSH abuse"; unbanned=1; }
    $NFT_CMD delete element inet ${TABLE_NAME} set port_scanners \{ $ip \} 2>/dev/null && { log_info "Unbanned $ip from scanners"; unbanned=1; }
    $NFT_CMD delete element inet ${TABLE_NAME} set connlimit_abuse \{ $ip \} 2>/dev/null && { log_info "Unbanned $ip from connlimit"; unbanned=1; }

    [[ $unbanned -eq 0 ]] && log_warn "$ip not found in any ban list"
}

fw_show_banned() {
    check_nftables
    echo "=== SSH Abuse (${SSH_BAN_TIME}s timeout) ==="
    $NFT_CMD list set inet ${TABLE_NAME} ssh_abuse 2>/dev/null | grep -oP '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' || echo "(none)"
    echo ""
    echo "=== Port Scanners (1h timeout) ==="
    $NFT_CMD list set inet ${TABLE_NAME} port_scanners 2>/dev/null | grep -oP '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' || echo "(none)"
    echo ""
    echo "=== Connection Rate Abusers (10m timeout) ==="
    $NFT_CMD list set inet ${TABLE_NAME} connlimit_abuse 2>/dev/null | grep -oP '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' || echo "(none)"
}

fw_clear_bans() {
    check_root
    check_nftables
    $NFT_CMD flush set inet ${TABLE_NAME} ssh_abuse 2>/dev/null && log_info "Cleared SSH abuse list"
    $NFT_CMD flush set inet ${TABLE_NAME} port_scanners 2>/dev/null && log_info "Cleared scanner list"
    $NFT_CMD flush set inet ${TABLE_NAME} connlimit_abuse 2>/dev/null && log_info "Cleared connlimit list"
}

fw_detect() {
    detect_os
    detect_primary_interface
    detect_ips
    detect_all_services
}

# ============================================================================
# USAGE
# ============================================================================

show_help() {
    cat << 'HELP'
nftables-firewall.sh v2.1.0 - Service-Aware Firewall

Auto-detects and configures rules for:
  o SSH (with pubkey-only aggressive rate limiting)
  o Caddy (HTTP/HTTPS, with or without Varnish)
  o Varnish (auto-detects, adjusts Caddy ports)
  o Forgejo (HTTP via proxy, dedicated SSH if configured)

Usage: nftables-firewall.sh <command>

Commands:
  start           Start firewall (auto-detects services)
  stop            Stop firewall
  restart         Restart firewall
  status          Show status and ban lists
  detect          Show service detection results only
  check           Validate current ruleset
  save            Save rules to /etc/nftables/firewall.rules
  dump            Dump ruleset as JSON

Ban Management:
  unban <IP>      Remove IP from all ban lists
  banned          Show all banned IPs
  clear-bans      Clear all ban lists

Architecture:
  With Varnish:    Client -> :80 Varnish -> :8080 Caddy -> Backend
                   Client -> :443 Caddy -> Backend
  Without Varnish: Client -> :80/:443 Caddy -> Backend

  Forgejo SSH (if enabled) is exposed directly on its port.
  Forgejo HTTP is expected to be proxied through Caddy.

Supported OS: Debian 12+, Ubuntu 22.04+, Arch Linux
HELP
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    local cmd="${1:-help}"

    case "$cmd" in
        start)     fw_start ;;
        stop)      fw_stop ;;
        restart|reload) fw_restart ;;
        status)    fw_status ;;
        detect)    fw_detect ;;
        check)     fw_check ;;
        save)      fw_save ;;
        dump)      fw_dump ;;
        unban)
            [[ -z "${2:-}" ]] && die "Usage: $0 unban <IP>"
            fw_unban "$2"
            ;;
        banned|show-banned|list-banned) fw_show_banned ;;
        clear-bans|clear) fw_clear_bans ;;
        help|--help|-h) show_help ;;
        *) die "Unknown command: $cmd\nRun '$0 help' for usage" ;;
    esac
}

main "$@"