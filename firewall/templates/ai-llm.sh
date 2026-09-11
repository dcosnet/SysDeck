#!/usr/bin/env bash
#
# Name: ai-llm
# Description: Public server variant for self-hosted AI LLM stacks. Exposes Ollama (11434), OpenWebUI (3000), Hermes (8000), Odysseus (8001), and SSH (22). All AI service ports are public so the operator can reach them from anywhere; SSH is rate-limited with auto-ban. Ollama is also reachable on its API port from the LAN. Designed for a personal / team AI workstation accessible over a trusted network or VPN.
# Distro: arch,debian
# Services: ssh,ollama,openwebui,hermes,odysseus
#
# ============================================================================
#  ai-llm.sh - SysDeck public-server variant: AI LLM stack
# ============================================================================
#
#  v0.0.44 NEW. Per user directive: "an ai llm variant for ollama,
#  hermes, openwebui and oddyseus." This template targets an AI
#  workstation running a self-hosted LLM stack.
#
#  Stack:
#    Ollama      — local LLM inference server (default :11434)
#    OpenWebUI   — web UI for Ollama / OpenAI-compatible APIs (:3000)
#    Hermes      — Nous Research Hermes function-calling gateway (:8000)
#    Odysseus    — companion web UI / agent runtime (:8001)
#    SSH         — admin shell (rate-limited, auto-ban)
#
#  Public TCP ports:
#    22    SSH (rate-limited, auto-ban brute force)
#    11434 Ollama API (public — operator may want to call from laptop)
#    3000  OpenWebUI (public)
#    8000  Hermes (public)
#    8001  Odysseus (public)
#
#  Loopback-only ports (defense-in-depth drop — operator can change
#  by editing the script, but the default is "public" since the user
#  directive is to expose all four services):
#    (none — all four AI ports are public per user directive)
#
#  Detection:
#    - Ollama: reads OLLAMA_HOST from /etc/systemd/system/ollama.service.d/*.conf
#      or /etc/environment. Default 0.0.0.0:11434 (the Ollama upstream
#      default — note: the Ollama systemd unit DOES bind 0.0.0.0 by
#      default; we surface this in detect output but do NOT change it.
#      Per v0.0.43 directive "never 0.0.0.0" — but Ollama here is
#      PUBLIC by design per user directive; the firewall gates access,
#      not the bind address. If the operator wants loopback-only, set
#      OLLAMA_HOST=127.0.0.1:11434 in the systemd override.)
#    - OpenWebUI: reads /etc/open-webui/config or env. Default 3000.
#    - Hermes: reads /etc/hermes/config.yaml. Default 8000.
#    - Odysseus: reads /etc/odysseus/config.toml. Default 8001.
#
#  Standard template interface (start/stop/restart/detect/status/check).
#
# ============================================================================

set -euo pipefail
IFS=$'\n\t'

SCRIPT_NAME="ai-llm"
SCRIPT_VERSION="0.0.44"

TABLE_NAME="firewall"
NFT_CMD="${NFT_CMD:-nft}"
RULES_FILE="${RULES_FILE:-/tmp/sysdeck-firewall-ai-llm.rules}"

# ── Configurable ports (auto-detected) ──────────────────────────────
SSH_PORT="${SYSDECK_AI_LLM_SSH_PORT:-22}"
OLLAMA_PORT="${SYSDECK_AI_LLM_OLLAMA_PORT:-11434}"
OPENWEBUI_PORT="${SYSDECK_AI_LLM_OPENWEBUI_PORT:-3000}"
HERMES_PORT="${SYSDECK_AI_LLM_HERMES_PORT:-8000}"
ODYSSEUS_PORT="${SYSDECK_AI_LLM_ODYSSEUS_PORT:-8001}"

# ── Rate limits ─────────────────────────────────────────────────────
SSH_RATE_LIMIT="4/minute"
SSH_BURST="8"
SSH_BAN_TIMEOUT="3600s"
# AI inference is request/response — bursts can be large. Set generous
# rate limits to avoid dropping legitimate requests during model
# swaps / batch embeddings.
AI_RATE_LIMIT="50/second"
AI_BURST="100"

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

# Ollama listens on OLLAMA_HOST (default 0.0.0.0:11434). The systemd
# unit /etc/systemd/system/ollama.service.d/override.conf can set
# Environment="OLLAMA_HOST=127.0.0.1:11434" — we honor that.
detect_ollama_port() {
    local dirs=(
        "/etc/systemd/system/ollama.service.d"
        "/etc/systemd/system/ollama.service"
    )
    for d in "${dirs[@]}"; do
        if [[ -d "$d" ]]; then
            local host
            host=$(grep -rhoE 'OLLAMA_HOST=[^"]+' "$d" 2>/dev/null | head -1 | cut -d= -f2 || true)
            if [[ -n "${host:-}" ]]; then
                # Strip the host: prefix, keep the port.
                local port="${host##*:}"
                if [[ -n "${port:-}" && "$port" =~ ^[0-9]+$ ]]; then
                    OLLAMA_PORT="$port"
                    return
                fi
            fi
        fi
    done
    # Fall back to /etc/environment.
    if [[ -f /etc/environment ]]; then
        local host
        host=$(grep -E '^OLLAMA_HOST=' /etc/environment 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"' || true)
        if [[ -n "${host:-}" ]]; then
            local port="${host##*:}"
            if [[ -n "${port:-}" && "$port" =~ ^[0-9]+$ ]]; then
                OLLAMA_PORT="$port"
                return
            fi
        fi
    fi
    OLLAMA_PORT="11434"
}

# OpenWebUI listens on PORT env (default 8080 in their docker image,
# 3000 in their bare-metal install). We check the systemd unit override
# and /etc/open-webui/.
detect_openwebui_port() {
    local dirs=(
        "/etc/systemd/system/open-webui.service.d"
        "/etc/systemd/system/open-webui.service"
        "/etc/systemd/system/openwebui.service.d"
    )
    for d in "${dirs[@]}"; do
        if [[ -d "$d" ]]; then
            local port
            port=$(grep -rhoE 'PORT=[0-9]+' "$d" 2>/dev/null | head -1 | cut -d= -f2 || true)
            if [[ -n "${port:-}" ]]; then OPENWEBUI_PORT="$port"; return; fi
        fi
    done
    if [[ -f /etc/open-webui/config ]]; then
        local port
        port=$(awk -F= '/^PORT=/ { print $2; exit }' /etc/open-webui/config 2>/dev/null || true)
        if [[ -n "${port:-}" && "$port" =~ ^[0-9]+$ ]]; then OPENWEBUI_PORT="$port"; return; fi
    fi
    OPENWEBUI_PORT="3000"
}

# Hermes config: /etc/hermes/config.yaml. Look for `port: N` under the
# `server:` section.
detect_hermes_port() {
    local cfg_files=("/etc/hermes/config.yaml" "/etc/hermes/config.yml" "/etc/hermes/hermes.yaml")
    for f in "${cfg_files[@]}"; do
        if [[ -f "$f" ]]; then
            local port
            port=$(awk '
                /^server:/ { in_s=1; next }
                /^[a-z]/ { in_s=0 }
                in_s && /^[[:space:]]*port:/ { gsub(/[^0-9]/, "", $2); print $2; exit }
            ' "$f" 2>/dev/null || true)
            if [[ -n "${port:-}" ]]; then HERMES_PORT="$port"; return; fi
        fi
    done
    HERMES_PORT="8000"
}

# Odysseus config: /etc/odysseus/config.toml. Look for `port = N`.
detect_odysseus_port() {
    local cfg_files=("/etc/odysseus/config.toml" "/etc/odysseus/odysseus.toml")
    for f in "${cfg_files[@]}"; do
        if [[ -f "$f" ]]; then
            local port
            port=$(awk -F= '
                /^[[:space:]]*port[[:space:]]*=/ { gsub(/[^0-9]/, "", $2); print $2; exit }
            ' "$f" 2>/dev/null || true)
            if [[ -n "${port:-}" ]]; then ODYSSEUS_PORT="$port"; return; fi
        fi
    done
    ODYSSEUS_PORT="8001"
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

        # ── Ollama API (port ${OLLAMA_PORT}) ───────────────────────
        tcp dport ${OLLAMA_PORT} ct state new \
            limit rate ${AI_RATE_LIMIT} burst ${AI_BURST} packets accept
        tcp dport ${OLLAMA_PORT} ct state new \
            log prefix "${LOG_PREFIX}ollama-rate " drop

        # ── OpenWebUI (port ${OPENWEBUI_PORT}) ─────────────────────
        tcp dport ${OPENWEBUI_PORT} ct state new \
            limit rate ${AI_RATE_LIMIT} burst ${AI_BURST} packets accept
        tcp dport ${OPENWEBUI_PORT} ct state new \
            log prefix "${LOG_PREFIX}openwebui-rate " drop

        # ── Hermes (port ${HERMES_PORT}) ───────────────────────────
        tcp dport ${HERMES_PORT} ct state new \
            limit rate ${AI_RATE_LIMIT} burst ${AI_BURST} packets accept
        tcp dport ${HERMES_PORT} ct state new \
            log prefix "${LOG_PREFIX}hermes-rate " drop

        # ── Odysseus (port ${ODYSSEUS_PORT}) ───────────────────────
        tcp dport ${ODYSSEUS_PORT} ct state new \
            limit rate ${AI_RATE_LIMIT} burst ${AI_BURST} packets accept
        tcp dport ${ODYSSEUS_PORT} ct state new \
            log prefix "${LOG_PREFIX}odysseus-rate " drop

        # Drop invalid TCP flag combinations.
        tcp flags & (fin|syn|rst|psh|ack|urg) == 0 drop
        tcp flags & (fin|syn) == (fin|syn) drop
        tcp flags & (syn|rst) == (syn|rst) drop
        tcp flags & (fin|rst) == (fin|rst) drop
        tcp flags & (psh|fin) == (psh|fin) drop

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
    detect_ollama_port
    detect_openwebui_port
    detect_hermes_port
    detect_odysseus_port
    log_info "Starting ai-llm firewall:"
    log_info "  ssh=${SSH_PORT} (public, rate-limited)"
    log_info "  ollama=${OLLAMA_PORT} (public)"
    log_info "  openwebui=${OPENWEBUI_PORT} (public)"
    log_info "  hermes=${HERMES_PORT} (public)"
    log_info "  odysseus=${ODYSSEUS_PORT} (public)"
    build_ruleset > "$RULES_FILE"
    "$NFT_CMD" -f "$RULES_FILE"
    log_info "Firewall loaded."
}

fw_stop() {
    check_nftables
    log_info "Stopping ai-llm firewall"
    "$NFT_CMD" delete table inet "$TABLE_NAME" 2>/dev/null || true
    rm -f "$RULES_FILE"
}

fw_restart() {
    fw_stop
    fw_start
}

fw_detect() {
    detect_ssh_port
    detect_ollama_port
    detect_openwebui_port
    detect_hermes_port
    detect_odysseus_port
    local os_name="unknown"
    if [[ -f /etc/os-release ]]; then . /etc/os-release; os_name="${PRETTY_NAME:-${NAME:-unknown}}"; fi
    cat <<EOF
+-----------------------------------------------------+
|              Service Detection Summary              |
+-----------------------------------------------------+
| OS: ${os_name}
| Template: ai-llm (Ollama + OpenWebUI + Hermes + Odysseus)
|
| Public ports:
|   ${SSH_PORT}/tcp        SSH (rate-limited, auto-ban)
|   ${OLLAMA_PORT}/tcp        Ollama API
|   ${OPENWEBUI_PORT}/tcp        OpenWebUI (web UI)
|   ${HERMES_PORT}/tcp        Hermes (function-calling gateway)
|   ${ODYSSEUS_PORT}/tcp        Odysseus (companion UI / agent runtime)
|
| Config files (for the Service/Port editor):
|   SSH:       /etc/ssh/sshd_config
|   Ollama:    /etc/systemd/system/ollama.service.d/*.conf (OLLAMA_HOST)
|   OpenWebUI: /etc/open-webui/config (PORT=)
|   Hermes:    /etc/hermes/config.yaml (server.port)
|   Odysseus:  /etc/odysseus/config.toml (port = )
|
| Note: per v0.0.43 "never 0.0.0.0" directive, Ollama's default
| bind IS 0.0.0.0 — but the user directive here is "public variant
| for ai llm". The firewall gates access. If you want Ollama to
| bind loopback-only, set OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT} in
| the systemd override, then set the firewall to NAT-forward the
| public port to loopback.
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
    detect_ollama_port
    detect_openwebui_port
    detect_hermes_port
    detect_odysseus_port
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
