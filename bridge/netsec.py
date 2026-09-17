#!/usr/bin/env python3
"""
SysDeck - Netsec Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

IPTRAF-NG STYLE NETWORK MONITOR.

The monitor reads the same kernel sources iptraf-ng reads from
directly — no fragile ncurses parsing, no static socket list.

Data sources:
  /proc/net/dev    per-interface RX/TX byte + packet counters
  /proc/net/snmp   IP/TCP/UDP/ICMP protocol counters
  /proc/net/tcp    active TCP connections (state, local, remote)
  /proc/net/udp    active UDP sockets
  ss -tnp          established connections with PID/process mapping

The bridge computes live rates by reading /proc/net/dev twice (1 second
apart) and diffing — this is exactly how iptraf-ng computes per-second
traffic rates.

Subcommands:
  summary         aggregate: total interfaces, total connections, protocol stats
  traffic         per-interface live RX/TX rates (bytes/s, packets/s, errors/s)
  connections     active TCP/UDP flows with PID mapping (like iptraf-ng IP monitor)
  interfaces      per-interface detailed stats (cumulative counters)
  protocols       /proc/net/snmp parsed: IP/TCP/UDP/ICMP counters
  sockets         listening TCP+UDP sockets
  established     established TCP connections

Usage:
    python3 /usr/lib/sysdeck/bridge/netsec.py traffic
    python3 /usr/lib/sysdeck/bridge/netsec.py connections
    python3 /usr/lib/sysdeck/bridge/netsec.py interfaces
    python3 /usr/lib/sysdeck/bridge/netsec.py protocols
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# v0.0.39: import security helpers from firewall.py (single source of truth).
sys.path.insert(0, str(Path(__file__).parent))
try:
    from firewall import (  # type: ignore
        SCRUBBED_ENV,
        _sanitize_output,
    )
except ImportError:
    SCRUBBED_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}
    def _sanitize_output(text: str, max_len: int = 4096) -> str:
        if not text:
            return ""
        if len(text) > max_len:
            text = text[:max_len] + " ... (truncated)"
        return "".join(c if (32 <= ord(c) < 127 or c in "\t\n\r") else " " for c in text)

# ── Regex patterns (compiled once at import) ──────────────────────

SS_LINE_RE = re.compile(
    r"^(?P<netid>\S+)\s+(?P<state>\S+)\s+(?P<recvq>\d+)\s+(?P<sendq>\d+)\s+(?P<local>\S+)\s+(?P<peer>\S+)"
)

# /proc/net/dev line format (after header):
#   eth0: rx_bytes rx_packets rx_errs rx_drop rx_fifo rx_frame rx_compressed rx_multicast
#         tx_bytes tx_packets tx_errs tx_drop tx_fifo tx_colls tx_carrier tx_compressed
DEV_LINE_RE = re.compile(
    r"^\s*(?P<iface>\S+?):\s*(?P<rx_bytes>\d+)\s+(?P<rx_packets>\d+)\s+"
    r"(?P<rx_errs>\d+)\s+(?P<rx_drop>\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+"
    r"(?P<tx_bytes>\d+)\s+(?P<tx_packets>\d+)\s+"
    r"(?P<tx_errs>\d+)\s+(?P<tx_drop>\d+)"
)

# /proc/net/tcp state codes (hex → name)
TCP_STATES = {
    "01": "ESTABLISHED",
    "02": "SYN_SENT",
    "03": "SYN_RECV",
    "04": "FIN_WAIT1",
    "05": "FIN_WAIT2",
    "06": "TIME_WAIT",
    "07": "CLOSE",
    "08": "CLOSE_WAIT",
    "09": "LAST_ACK",
    "0A": "LISTEN",
    "0B": "CLOSING",
}


def _run(argv: list[str], timeout: int = 5) -> str:
    """Run argv and return stdout. Returns '' on failure.

    v0.0.39 hardening: env scrubbed, output sanitized.
    """
    try:
        r = subprocess.run(
            argv, capture_output=True, text=True, check=False, timeout=timeout,
            env=SCRUBBED_ENV,
        )
        return _sanitize_output(r.stdout or "")
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return ""


def _read_file(path: str) -> str:
    """Read a file, returning '' on failure."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except (FileNotFoundError, PermissionError, OSError):
        return ""


# ── /proc/net/dev parsing (per-interface stats) ──────────────────


def _parse_proc_net_dev(content: str) -> dict[str, dict[str, int]]:
    """Parse /proc/net/dev into {iface: {rx_bytes, rx_packets, ...}}.

    This is the same data source iptraf-ng reads for its general
    interface statistics view.
    """
    interfaces: dict[str, dict[str, int]] = {}
    for line in content.splitlines():
        m = DEV_LINE_RE.match(line)
        if not m:
            continue
        iface = m.group("iface")
        interfaces[iface] = {
            "rx_bytes": int(m.group("rx_bytes")),
            "rx_packets": int(m.group("rx_packets")),
            "rx_errs": int(m.group("rx_errs")),
            "rx_drop": int(m.group("rx_drop")),
            "tx_bytes": int(m.group("tx_bytes")),
            "tx_packets": int(m.group("tx_packets")),
            "tx_errs": int(m.group("tx_errs")),
            "tx_drop": int(m.group("tx_drop")),
        }
    return interfaces


def _read_dev_stats() -> dict[str, dict[str, int]]:
    """Read current /proc/net/dev snapshot."""
    return _parse_proc_net_dev(_read_file("/proc/net/dev"))


# ── Traffic rate computation (iptraf-ng style) ────────────────────


def cmd_traffic(_args: list[str]) -> list[dict[str, Any]]:
    """Compute per-interface live RX/TX rates by sampling /proc/net/dev
    twice (1 second apart) and diffing.

    Returns a list of {iface, rx_bps, tx_bps, rx_pps, tx_pps,
    rx_errs_total, tx_errs_total, rx_drop_total, tx_drop_total}.

    This is exactly how iptraf-ng computes its live traffic rates.
    """
    snapshot1 = _read_dev_stats()
    if not snapshot1:
        return []
    t1 = time.monotonic()
    time.sleep(1.0)
    snapshot2 = _read_dev_stats()
    t2 = time.monotonic()
    elapsed = t2 - t1
    if elapsed <= 0:
        elapsed = 1.0

    result: list[dict[str, Any]] = []
    for iface in sorted(snapshot2.keys()):
        s1 = snapshot1.get(iface, {})
        s2 = snapshot2.get(iface, {})
        if not s2:
            continue
        rx_bytes_diff = s2.get("rx_bytes", 0) - s1.get("rx_bytes", 0)
        tx_bytes_diff = s2.get("tx_bytes", 0) - s1.get("tx_bytes", 0)
        rx_pkt_diff = s2.get("rx_packets", 0) - s1.get("rx_packets", 0)
        tx_pkt_diff = s2.get("tx_packets", 0) - s1.get("tx_packets", 0)
        result.append({
            "iface": iface,
            "rx_bps": int(rx_bytes_diff / elapsed),
            "tx_bps": int(tx_bytes_diff / elapsed),
            "rx_pps": int(rx_pkt_diff / elapsed),
            "tx_pps": int(tx_pkt_diff / elapsed),
            "rx_bytes_total": s2.get("rx_bytes", 0),
            "tx_bytes_total": s2.get("tx_bytes", 0),
            "rx_packets_total": s2.get("rx_packets", 0),
            "tx_packets_total": s2.get("tx_packets", 0),
            "rx_errs_total": s2.get("rx_errs", 0),
            "tx_errs_total": s2.get("tx_errs", 0),
            "rx_drop_total": s2.get("rx_drop", 0),
            "tx_drop_total": s2.get("tx_drop", 0),
        })
    return result


# ── Interface details ─────────────────────────────────────────────


def cmd_interfaces(_args: list[str]) -> list[dict[str, Any]]:
    """Return per-interface detailed stats (cumulative counters).

    Like iptraf-ng's detailed interface statistics view.
    """
    stats = _read_dev_stats()
    if not stats:
        return []
    result: list[dict[str, Any]] = []
    for iface in sorted(stats.keys()):
        s = stats[iface]
        # Compute human-readable rates.
        rx_mb = s["rx_bytes"] / (1024 * 1024)
        tx_mb = s["tx_bytes"] / (1024 * 1024)
        result.append({
            "iface": iface,
            "rx_bytes": s["rx_bytes"],
            "rx_mb": round(rx_mb, 2),
            "rx_packets": s["rx_packets"],
            "rx_errs": s["rx_errs"],
            "rx_drop": s["rx_drop"],
            "tx_bytes": s["tx_bytes"],
            "tx_mb": round(tx_mb, 2),
            "tx_packets": s["tx_packets"],
            "tx_errs": s["tx_errs"],
            "tx_drop": s["tx_drop"],
        })
    return result


# ── Protocol statistics (/proc/net/snmp) ──────────────────────────


def cmd_protocols(_args: list[str]) -> dict[str, Any]:
    """Parse /proc/net/snmp for IP/TCP/UDP/ICMP protocol counters.

    Like iptraf-ng's statistical breakdowns view.
    """
    content = _read_file("/proc/net/snmp")
    if not content:
        return {"error": "cannot read /proc/net/snmp"}
    result: dict[str, Any] = {}
    lines = content.splitlines()
    i = 0
    while i < len(lines) - 1:
        header = lines[i].strip()
        values = lines[i + 1].strip()
        if ":" not in header or ":" not in values:
            i += 1
            continue
        proto_name = header.split(":")[0]
        hdr_fields = header.split(":")[1].split()
        val_fields = values.split(":")[1].split()
        if len(hdr_fields) != len(val_fields):
            i += 1
            continue
        proto_stats = {}
        for j, field in enumerate(hdr_fields):
            try:
                proto_stats[field] = int(val_fields[j])
            except (ValueError, IndexError):
                proto_stats[field] = val_fields[j]
        result[proto_name.lower()] = proto_stats
        i += 2
    return result


# ── Active connections (iptraf-ng IP traffic monitor style) ───────


def _decode_addr(hex_addr: str) -> tuple[str, int]:
    """Decode a /proc/net/tcp hex address (little-endian) into (ip, port)."""
    if not hex_addr or ":" not in hex_addr:
        return ("?", 0)
    ip_hex, port_hex = hex_addr.split(":")
    try:
        port = int(port_hex, 16)
        # /proc/net/tcp stores IPv4 in little-endian hex.
        ip_int = int(ip_hex, 16)
        ip = f"{ip_int & 0xFF}.{(ip_int >> 8) & 0xFF}.{(ip_int >> 16) & 0xFF}.{(ip_int >> 24) & 0xFF}"
        return (ip, port)
    except ValueError:
        return ("?", 0)


def cmd_connections(_args: list[str]) -> list[dict[str, Any]]:
    """Active TCP/UDP connections with state + address info.

    Reads /proc/net/tcp + /proc/net/udp directly (no ss dependency).
    Returns a list of {proto, state, local_ip, local_port, remote_ip,
    remote_port, tx_queue, rx_queue}.

    Like iptraf-ng's IP traffic monitor.
    """
    result: list[dict[str, Any]] = []
    # TCP
    tcp_content = _read_file("/proc/net/tcp")
    for line in tcp_content.splitlines()[1:]:  # skip header
        parts = line.split()
        if len(parts) < 10:
            continue
        local_ip, local_port = _decode_addr(parts[1])
        remote_ip, remote_port = _decode_addr(parts[2])
        state_hex = parts[3]
        state = TCP_STATES.get(state_hex, f"UNKNOWN({state_hex})")
        tx_queue = rx_queue = 0
        if ":" in parts[4]:
            tx_q, rx_q = parts[4].split(":")
            try:
                tx_queue = int(tx_q, 16)
                rx_queue = int(rx_q, 16)
            except ValueError:
                pass
        result.append({
            "proto": "tcp",
            "state": state,
            "local_ip": local_ip,
            "local_port": local_port,
            "remote_ip": remote_ip,
            "remote_port": remote_port,
            "tx_queue": tx_queue,
            "rx_queue": rx_queue,
        })
    # UDP
    udp_content = _read_file("/proc/net/udp")
    for line in udp_content.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 8:
            continue
        local_ip, local_port = _decode_addr(parts[1])
        remote_ip, remote_port = _decode_addr(parts[2])
        result.append({
            "proto": "udp",
            "state": "UDP",
            "local_ip": local_ip,
            "local_port": local_port,
            "remote_ip": remote_ip,
            "remote_port": remote_port,
            "tx_queue": 0,
            "rx_queue": 0,
        })
    return result


# ── Summary (aggregate panel header) ──────────────────────────────


def cmd_summary(_args: list[str]) -> dict[str, Any]:
    """Aggregate network state: total interfaces, connections, protocol stats."""
    interfaces = cmd_interfaces([])
    connections = cmd_connections([])
    protocols = cmd_protocols([])
    # Count connections by state.
    tcp_states: dict[str, int] = {}
    for c in connections:
        if c["proto"] == "tcp":
            tcp_states[c["state"]] = tcp_states.get(c["state"], 0) + 1
    return {
        "total_interfaces": len(interfaces),
        "interfaces_up": len([i for i in interfaces if i["rx_bytes"] > 0 or i["tx_bytes"] > 0]),
        "total_connections": len(connections),
        "tcp_established": tcp_states.get("ESTABLISHED", 0),
        "tcp_listen": tcp_states.get("LISTEN", 0),
        "tcp_time_wait": tcp_states.get("TIME_WAIT", 0),
        "tcp_states": tcp_states,
        "top_interfaces_by_traffic": sorted(
            interfaces, key=lambda i: i["rx_bytes"] + i["tx_bytes"], reverse=True
        )[:5],
        "protocols": protocols,
    }


# ── Socket-listing subcommands ───────────────────────────────────


def parse_ss(output: str) -> list[dict[str, Any]]:
    """Parse `ss -tulpn` output into socket records."""
    return [
        {
            "netid": m.group("netid"),
            "state": m.group("state"),
            "recvQ": int(m.group("recvq")),
            "sendQ": int(m.group("sendq")),
            "local": m.group("local"),
            "peer": m.group("peer"),
        }
        for line in output.splitlines()
        if (m := SS_LINE_RE.match(line))
    ]


def sockets() -> list[dict[str, Any]]:
    """Listening TCP and UDP sockets from `ss -tulpn`."""
    return parse_ss(_run(["ss", "-tulpn"]))


def established() -> list[dict[str, Any]]:
    """Established TCP connections from `ss -tnp state established`."""
    return parse_ss(_run(["ss", "-tnp", "state", "established"]))


def cmd_sockets(_args: list[str]) -> list[dict[str, Any]]:
    return sockets()


def cmd_established(_args: list[str]) -> list[dict[str, Any]]:
    return established()


# ── Dispatch table ────────────────────────────────────────────────

COMMANDS = {
    "summary":      cmd_summary,
    "traffic":      cmd_traffic,
    "connections":  cmd_connections,
    "interfaces":   cmd_interfaces,
    "protocols":    cmd_protocols,
    "sockets":      cmd_sockets,
    "established":  cmd_established,
}


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd = COMMANDS.get(argv[0])
    if not cmd:
        print(f"Unknown subcommand: {argv[0]}", file=sys.stderr)
        print(f"Available: {', '.join(sorted(COMMANDS))}", file=sys.stderr)
        return 2
    print(json.dumps(cmd(argv[1:]), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
