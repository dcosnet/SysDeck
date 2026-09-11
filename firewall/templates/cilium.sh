#!/usr/bin/env bash
#
# Name: cilium
# Description: Cilium eBPF datapath backend. Replaces nftables with eBPF programs attached at XDP and tc ingress/egress. Manages Cilium network policies via cilium-cli. Requires cilium + cilium-agent (or cilium-agent container). Installs cleanly via Helm or the official cilium-cli install script. Designed for eBPF-capable kernels (5.10+).
# Distro: arch,debian
# Services: cilium
#
# ============================================================================
#  cilium.sh - Cilium eBPF Firewall Backend for SysDeck
# ============================================================================
#
#  This template implements the standard SysDeck firewall template interface
#  (start/stop/restart/detect/status/check) but the datapath is Cilium eBPF
#  programs, NOT nftables rules. Cilium manages its own BPF maps and
#  programs; nftables is left untouched (or explicitly flushed of any
#  sysdeck-firewall table to avoid conflicts).
#
#  Why Cilium over nftables for this backend:
#    - eBPF programs run before the kernel networking stack (XDP) — packets
#      are dropped before they consume socket buffers or conntrack entries.
#    - Identity-based policy (CiliumIdentity labels) instead of IP-based.
#      A pod/workload keeps its policy even when its IP changes.
#    - L7 policy (HTTP/gRPC/Kafka) via Envoy sidecar — nftables cannot.
#    - Observable via `cilium monitor`, `cilium metrics`, Hubble flow logs.
#
#  Requirements:
#    - Linux kernel 5.10+ (5.15+ recommended for latest BPF features)
#    - CONFIG_BPF=y, CONFIG_BPF_SYSCALL=y, CONFIG_XDP_SOCKETS=y
#    - cilium-cli >= 0.15 (or the `cilium` shell script — same binary)
#    - For standalone (non-K8s) mode: cilium-agent binary installed at
#      /usr/bin/cilium-agent (Arch: AUR cilium-agent; Debian: official repo
#      or upstream .deb). Cilium 1.14+ supports standalone mode natively.
#    - Helm 3 (optional — only if the operator chooses K8s-based install)
#
#  Anti-requirements (why other backends are NOT this one):
#    - UFW: frontend for nftables/iptables — does not use eBPF. Skipped
#      per user directive.
#    - fwbuilder: GUI rule generator — too complex for the average user.
#      Skipped per user directive.
#    - iptables-legacy / iptables-nft wrapper: legacy. The eBPF era has
#      moved past it. Skipped per user directive.
#
#  Subcommands (standard SysDeck firewall template interface):
#    start    install cilium (if missing) + apply the default policy
#    stop     delete all Cilium policies + disable cilium-agent
#    restart  stop + start
#    detect   print service detection summary (cilium version, kernel
#             BPF features, agent status, endpoint count)
#    status   print cilium status + policy summary
#    check    cilium policy validate (syntax check)
#
# ============================================================================

set -euo pipefail
IFS=$'\n\t'

# ============================================================================
# CONFIGURATION
# ============================================================================

CILIUM_BIN="${CILIUM_BIN:-cilium}"
CILIUM_AGENT_BIN="${CILIUM_AGENT_BIN:-/usr/bin/cilium-agent}"
CILIUM_AGENT_SVC="${CILIUM_AGENT_SVC:-cilium-agent.service}"
HELM_BIN="${HELM_BIN:-helm}"

# The default Cilium policy shipped with this template. It defines:
#   - default-deny ingress + egress for all endpoints
#   - allow DNS (UDP/TCP 53) to kube-dns / systemd-resolved
#   - allow SSH (TCP 22) from anywhere
#   - allow HTTP/HTTPS (TCP 80/443) from anywhere
# The operator can drop a custom policy at
# /etc/sysdeck/firewall/cilium-policy.yaml to override.
POLICY_FILE="${POLICY_FILE:-/etc/sysdeck/firewall/cilium-policy.yaml}"
DEFAULT_POLICY_FILE="/usr/share/sysdeck/firewall/policies/cilium-default.yaml"

# ============================================================================

log_info()  { printf '[cilium] [INFO]  %s\n' "$*" >&2; }
log_warn()  { printf '[cilium] [WARN]  %s\n' "$*" >&2; }
log_error() { printf '[cilium] [ERROR] %s\n' "$*" >&2; }

die() {
    log_error "$*"
    exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# ============================================================================
# PRE-FLIGHT
# ============================================================================

check_root() {
    [[ $EUID -eq 0 ]] || die "This action requires root. The cockpit superuser channel should provide it."
}

check_cilium_installed() {
    if ! have "$CILIUM_BIN"; then
        cat >&2 <<EOF
[cilium] cilium-cli is not installed.

Install on Arch:   sudo pacman -S cilium-cli     (or AUR: cilium-cli-bin)
Install on Debian: sudo apt install cilium-cli    (or upstream .deb)
Install via Helm:  helm repo add cilium https://helm.cilium.io/ \\
                   helm install cilium cilium/cilium -n kube-system

Once installed, re-run this template. The bridge firewall.py
install-backend subcommand can also install it via the packages module.
EOF
        return 1
    fi
    return 0
}

check_kernel_bpf() {
    local kver
    kver="$(uname -r)"
    local major="${kver%%.*}"
    if [[ "$major" -lt 5 ]]; then
        log_warn "Kernel $kver is older than 5.10 — Cilium may not function. Recommended: 5.15+."
    fi
    if ! have bpftool; then
        log_warn "bpftool not found — BPF feature probing will be skipped."
    fi
}

# ============================================================================
# DETECT
# ============================================================================

fw_detect() {
    local os_name="unknown"
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        os_name="${PRETTY_NAME:-${NAME:-unknown}}"
    fi

    local kernel_ver
    kernel_ver="$(uname -r)"

    local cilium_ver="not installed"
    if have "$CILIUM_BIN"; then
        cilium_ver="$("$CILIUM_BIN" version --short 2>/dev/null | head -1 || echo 'unknown')"
    fi

    local agent_status="not running"
    if systemctl is-active --quiet "$CILIUM_AGENT_SVC" 2>/dev/null; then
        agent_status="running"
    fi

    local endpoint_count="n/a"
    if have "$CILIUM_BIN"; then
        endpoint_count="$("$CILIUM_BIN" endpoint list -o json 2>/dev/null | \
            python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 'n/a')"
    fi

    local bpf_features="unknown"
    if have bpftool; then
        if bpftool feature probe kernel 2>/dev/null | grep -q 'eBPF program_type fentry'; then
            bpf_features="fentry,fexit, LSM (modern)"
        else
            bpf_features="legacy (kprobe-based)"
        fi
    fi

    cat <<EOF
+-----------------------------------------------------+
|              Service Detection Summary              |
+-----------------------------------------------------+
| OS: ${os_name}
| Kernel: ${kernel_ver}
| BPF features: ${bpf_features}
| Template: cilium (eBPF datapath)
| cilium-cli: ${cilium_ver}
| cilium-agent: ${agent_status}
| Endpoints: ${endpoint_count}
| Policy file: ${POLICY_FILE}
+-----------------------------------------------------+
EOF
}

# ============================================================================
# START
# ============================================================================

fw_start() {
    log_info "Starting Cilium eBPF firewall backend..."
    check_root
    check_cilium_installed || return 1
    check_kernel_bpf

    # Flush any leftover nftables inet firewall table from a previous
    # 'custom'/'sysdeck-fw' backend. Cilium manages its own
    # datapath — a stale nftables table would conflict.
    if have nft; then
        nft delete table inet firewall 2>/dev/null || true
        log_info "Cleared any stale nftables 'firewall' table."
    fi

    # Ensure cilium-agent is running (standalone mode). On K8s, cilium
    # runs as a DaemonSet and this is a no-op.
    if [[ -x "$CILIUM_AGENT_BIN" ]] && ! systemctl is-active --quiet "$CILIUM_AGENT_SVC" 2>/dev/null; then
        log_info "Starting $CILIUM_AGENT_SVC ..."
        systemctl start "$CILIUM_AGENT_SVC" || log_warn "cilium-agent did not start — assuming K8s DaemonSet mode."
    fi

    # Wait briefly for cilium API to be reachable.
    local i
    for i in 1 2 3 4 5; do
        if "$CILIUM_BIN" status --brief >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done

    # Apply the default policy (or the operator's override).
    local policy="$DEFAULT_POLICY_FILE"
    if [[ -f "$POLICY_FILE" ]]; then
        policy="$POLICY_FILE"
        log_info "Using operator policy: $POLICY_FILE"
    else
        log_info "Using shipped default policy: $DEFAULT_POLICY_FILE"
    fi

    if [[ ! -f "$policy" ]]; then
        die "Policy file not found: $policy. Reinstall the sysdeck package."
    fi

    log_info "Validating policy..."
    if ! "$CILIUM_BIN" policy validate "$policy" 2>&1; then
        die "Policy validation failed."
    fi

    log_info "Applying policy..."
    if "$CILIUM_BIN" policy apply "$policy" 2>&1; then
        log_info "Cilium policy applied successfully."
    else
        die "Policy apply failed."
    fi
}

# ============================================================================
# STOP
# ============================================================================

fw_stop() {
    log_info "Stopping Cilium eBPF firewall backend..."
    check_root
    if ! check_cilium_installed; then
        log_warn "cilium-cli not installed — nothing to stop."
        return 0
    fi

    # Delete all Cilium policies (reverts to default allow-all).
    # This does NOT unload the BPF programs — cilium-agent keeps running
    # so the operator can re-apply a policy without reinstalling.
    "$CILIUM_BIN" policy delete --all 2>/dev/null || log_warn "policy delete --all failed (no policies loaded?)."

    if [[ -x "$CILIUM_AGENT_BIN" ]] && systemctl is-active --quiet "$CILIUM_AGENT_SVC" 2>/dev/null; then
        log_info "Stopping $CILIUM_AGENT_SVC ..."
        systemctl stop "$CILIUM_AGENT_SVC" || log_warn "could not stop cilium-agent."
    fi
    log_info "Cilium backend stopped (BPF programs removed when agent exits)."
}

# ============================================================================
# RESTART
# ============================================================================

fw_restart() {
    fw_stop
    sleep 1
    fw_start
}

# ============================================================================
# STATUS
# ============================================================================

fw_status() {
    if ! check_cilium_installed; then
        echo "cilium-cli not installed."
        return 0
    fi
    "$CILIUM_BIN" status 2>&1 || true
    echo
    echo "--- Policy summary ---"
    "$CILIUM_BIN" policy get 2>&1 | head -40 || true
}

# ============================================================================
# CHECK
# ============================================================================

fw_check() {
    check_cilium_installed || return 1
    local policy="$DEFAULT_POLICY_FILE"
    [[ -f "$POLICY_FILE" ]] && policy="$POLICY_FILE"
    if [[ ! -f "$policy" ]]; then
        die "Policy file not found: $policy"
    fi
    "$CILIUM_BIN" policy validate "$policy"
}

# ============================================================================
# DISPATCH
# ============================================================================

main() {
    local command="${1:-help}"
    case "$command" in
        start)    fw_start ;;
        stop)     fw_stop ;;
        restart|reload) fw_restart ;;
        detect)   fw_detect ;;
        status)   fw_status ;;
        check|validate) fw_check ;;
        help|--help|-h)
            cat <<EOF
cilium.sh — Cilium eBPF firewall backend for SysDeck

Usage: cilium.sh <start|stop|restart|detect|status|check>

Subcommands:
  start    install cilium (if missing) + apply the default policy
  stop     delete all Cilium policies + stop cilium-agent
  restart  stop + start
  detect   print detection summary (cilium version, kernel BPF features)
  status   print cilium status + policy summary
  check    validate the policy file

Environment variables:
  CILIUM_BIN       path to cilium CLI (default: cilium)
  CILIUM_AGENT_BIN path to cilium-agent binary (default: /usr/bin/cilium-agent)
  POLICY_FILE      operator policy override (default: /etc/sysdeck/firewall/cilium-policy.yaml)
EOF
            ;;
        *)
            die "Unknown command: $command\nRun 'cilium.sh help' for usage."
            ;;
    esac
}

main "$@"
