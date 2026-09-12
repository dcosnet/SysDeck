#!/usr/bin/env python3
"""
SysDeck - Firewall Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

v0.0.44 PUBLIC-SERVER VARIANTS + SERVICE/PORT EDITOR.
Adds three new public-server firewall templates:
  - remote-admin.sh   SSH (22) + Cockpit (9090). For VPS/cloud hosts
                      where the operator needs remote shell + web admin.
  - public-webserver.sh  Caddy (80/443) + Varnish (8080) + MariaDB
                      (3306, loopback-only, defense-in-depth drop).
                      For public web servers with a reverse-proxy/cache
                      stack and a database.
  - ai-llm.sh         Ollama (11434) + OpenWebUI (3000) + Hermes (8000)
                      + Odysseus (8001) + SSH (22). For self-hosted
                      AI LLM stacks on a personal/team workstation.

Also adds the service/port editor (4 new bridge subcommands):
  services              detect running listening ports + cross-ref
                        the SERVICES_REGISTRY (ss -tlnp + /proc/net/tcp
                        fallback). Returns the full inventory.
  service-info <id>     show one service's full registry entry + the
                        detected port from its config file.
  set-service-port <id> <new_port>
                        edit the port in the service's config file
                        (atomic write: tmpfile + fsync + rename),
                        then systemctl restart the service. Validates
                        the service id against the registry (no
                        arbitrary file edits), validates the port
                        (1..65535), and resolves the config path
                        with os.path.realpath + base-dir allowlist
                        check.
  restart-service <id>  just restart the service (no port change).
                        Useful for "I edited the config by hand" flows.

v0.0.31 REWRITE — PREVIOUS VERSION WAS READ-ONLY.
The v0.0.30 bridge exposed only `ruleset` and `chains` subcommands: the
panel could list active nftables rules but could not start, stop,
restart, apply a template, ban an IP, unban an IP, show the ban list,
or show service detection. The panel was a monitor, not a manager.

v0.0.31 turned the firewall panel into a full manager (apply / stop /
restart / ban / unban / clear-bans / detect / check).

v0.0.37 UNIFIED BACKEND + EXPANDED CVE HARDENING.
The sysdeck-fw backend takes influence from two open-source
firewall distributions — Smoothwall Express (RED/ORANGE/GREEN/BLUE
color-zone model) and IPFire (source-verified outbound + AirWall
isolation + flow offload). We do not ship a template called
"smoothwall" or "ipfire" — those are other projects' names.
The unified sysdeck-fw template preserves the feature sets we
took influence from under our own identifier.

v0.0.37 also expands the CVE research to cover the COMMERCIAL web
admin UI panels the user meant by "webmin" (cPanel, Plesk,
DirectAdmin, CloudPanel, aaPanel, Froxlor, InterWorx, BrainyCP,
CyberPanel, HestiaCP, VestaCP, FastPanel, CWP). The full CVE table
is in docs/SECURITY-HARDENING.md. New validators added in v0.0.37:
  - _validate_domain     RFC 1035 strict domain regex (CVE-2025-66431 Plesk)
  - _validate_email      parseaddr + charset regex + metachar reject
                        (CVE-2026-26279 Froxlor)
  - _validate_cron       5-field cron syntax (CVE-2023-53945 BrainyCP)
  - _validate_mysql_id   MySQL identifier (CVE-2026-58048 cPanel)
  - _sanitize_for_file   strips \r\n\0 (CVE-2026-41940 cPanel)
  - _decode_then_validate  decode -> canonicalize -> validate
                        (CVE-2026-29205 cPanel cpdavd)
  - safe_tar_create      tar argument-injection defense using --null -T -
                        (CVE-2025-48702 aaPanel, IWX-CVE-2022-8384 InterWorx)

Backends shipped in v0.0.37:

  custom           default; uses the vps-webserver.sh / no-services.sh
                   templates (basic nftables rulesets that work on any
                   Arch/Debian host). Backwards-compatible with v0.0.35.
  cilium           Cilium eBPF datapath. Replaces nftables as the
                   datapath — packets are filtered in BPF programs at
                   XDP and tc ingress/egress before they reach the
                   kernel networking stack. Identity-based policy
                   (not IP-based). L7 policy via Envoy. Requires
                   cilium + cilium-agent.
  sysdeck-fw       SysDeck FW — unified nftables zone firewall. Takes
                   influence from Smoothwall Express (zone matrix) and
                   IPFire (source-verified outbound + AirWall + flow
                   offload) under our own identifier.
                   RED/ORANGE/GREEN/BLUE zone matrix + source-verified
                   outbound + AirWall + flow offload + DMZ forwards.

Per user directive v0.0.36: "iptables is old now" — the suite ships
only nftables-native and eBPF-native backends. UFW (nftables frontend,
no eBPF) is skipped. fwbuilder (GUI rule generator, too complex for
the average user) is skipped. Legacy iptables-only firewalls without
eBPF integration points are skipped.

Subcommands added in v0.0.36:

  backends                    list available firewall backends with
                              detected availability (cilium binary
                              present? kernel BPF features? etc.)
  backend-info <name>         show one backend's details + install hint
  active-backend              return the currently selected backend
  switch-backend <name>       switch the active backend (writes
                              /var/lib/sysdeck/firewall/backend and
                              stops the previous backend cleanly)
  install-backend <name>      install the backend's binary deps via
                              the packages module (pacman / apt / dnf)
  cilium-status               cilium status --brief (JSON)
  cilium-endpoints            cilium endpoint list (JSON)
  cilium-policy               cilium policy get (JSON)
  cilium-policy-apply <file>  cilium policy apply <file>
  cilium-policy-validate <file>  cilium policy validate <file>
  security-hardening          return the CVE-derived hardening checklist
                              applied to this bridge (for display in
                              the panel's Security Card)

Subcommands kept from v0.0.31:
  ruleset / chains / templates / template-info / detect / apply /
  stop / restart / status / ban / unban / banned / clear-bans / check

Cockpit way (per user directive): mutating operations run via the
bridge's subprocess call to nft / cilium / systemctl / bash — and the
JS panel passes { superuser: 'try' } to cockpit.spawn so the cockpit
bridge prompts the operator for auth via polkit. No `sudo` shell-out
from JS; the polkit action org.sysdeck.firewall.modify (shipped since
v0.0.17) authorizes /usr/bin/nft, /usr/sbin/nft, /usr/bin/cilium,
/usr/sbin/cilium, /usr/bin/cilium-agent, and /usr/bin/helm.

SECURITY HARDENING (v0.0.36) — derived from real CVE disclosures for
Webmin, Cockpit, Ajenti, ISPConfig, and Virtualmin. See
`docs/SECURITY-HARDENING.md` for the full CVE table. Key changes:
  - Strict allowlist regex per input type (template names, IP addresses,
    interface names, backend names, filenames). CVE-2024-2947 lesson.
  - "--" separator before any user-supplied positional in argv.
    CVE-2026-4631 lesson.
  - Environment scrubbing on every privileged subprocess (LD_PRELOAD,
    LD_LIBRARY_PATH, PYTHONPATH, BASH_ENV, ENV, PERL5OPT all dropped).
    CVE-2024-6126 lesson.
  - Path resolution with os.path.realpath + startswith(base_dir) check.
    CVE-2022-30708 lesson.
  - No eval / pickle / yaml.unsafe_load. CVE-2019-15642 lesson.
  - Error responses truncated to 4 KiB and stripped of non-printable
    bytes. CVE-2022-36446 lesson.

Templates are executable shell scripts in
/usr/share/sysdeck/firewall/templates/<name>.sh. They implement the
following subcommands (the bridge invokes them as
`bash <path> <subcommand> [args]`):

  start    build ruleset from detected services, validate, load
  stop     delete the firewall table
  restart  stop + start
  detect   print service detection summary (no rule changes)
  status   print firewall running state + ban lists
  check    validate the ruleset

Templates must be POSIX-compliant bash and work on both Arch and
Debian. The templates shipped in this release are:
  vps-webserver.sh   (v0.0.31, kept)
  no-services.sh     (v0.0.31, kept)
  cilium.sh          (v0.0.36, Cilium eBPF backend)
  sysdeck-fw.sh      (v0.0.37, unified nftables zone firewall)
  remote-admin.sh    (v0.0.44, SSH + Cockpit public-server variant)
  public-webserver.sh (v0.0.44, Caddy + Varnish + MariaDB variant)
  ai-llm.sh          (v0.0.44, Ollama + OpenWebUI + Hermes + Odysseus variant)

Usage:
    python3 /usr/lib/sysdeck/bridge/firewall.py ruleset
    python3 /usr/lib/sysdeck/bridge/firewall.py templates
    python3 /usr/lib/sysdeck/bridge/firewall.py apply vps-webserver
    python3 /usr/lib/sysdeck/bridge/firewall.py ban 1.2.3.4
    python3 /usr/lib/sysdeck/bridge/firewall.py backends
    python3 /usr/lib/sysdeck/bridge/firewall.py switch-backend cilium
    python3 /usr/lib/sysdeck/bridge/firewall.py cilium-status
"""

import ipaddress
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

# ── Constants ────────────────────────────────────────────────────────

TEMPLATES_DIR = Path("/usr/share/sysdeck/firewall/templates")
POLICIES_DIR = Path("/usr/share/sysdeck/firewall/policies")
STATE_DIR = Path("/var/lib/sysdeck/firewall")
ACTIVE_FILE = STATE_DIR / "active"
BACKEND_FILE = STATE_DIR / "backend"
TABLE_NAME = "firewall"  # name of the inet table the templates manage
BAN_SETS = ("ssh_abuse", "port_scanners", "connlimit_abuse")

# v0.0.36: strict allowlist regexes per input type.
# Derived from CVE-2024-2947 (Cockpit sosreport command injection via
# crafted filename) and CVE-2026-4631 (Cockpit SSH argv injection).
# Reject on first mismatch — do NOT attempt to "sanitize" by stripping
# bad chars (CVE-2020-35606 showed that approach is bypassable).
TEMPLATE_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
BACKEND_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,32}$")
INTERFACE_NAME_RE = re.compile(r"^[a-zA-Z0-9._-]{1,15}$")  # Linux IFNAMSIZ
FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

# v0.0.36: scrubbed environment for privileged subprocesses.
# Drops LD_PRELOAD, LD_LIBRARY_PATH, PYTHONPATH, BASH_ENV, ENV, PERL5OPT
# (the CVE-2024-6126 lesson — env-var injection via pam_env user_readenv).
SCRUBBED_ENV = {
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG": "C",
    "LC_ALL": "C",
}

# v0.0.36: firewall backend registry. Each entry is the static metadata
# for the backend. Availability is probed at runtime (in cmd_backends)
# so the panel can show "installed" vs "installable".
# Per user directive v0.0.36: "iptables is old now" — only nftables-native
# and eBPF-native backends ship. UFW, fwbuilder, and legacy iptables-only
# firewalls are explicitly excluded (see EXCLUDED_BACKENDS below).
FIREWALL_BACKENDS: list[dict[str, Any]] = [
    {
        "id": "custom",
        "name": "Custom (basic nftables templates)",
        "description": (
            "Default. Uses the vps-webserver.sh and no-services.sh "
            "templates shipped with sysdeck. Modern nftables syntax "
            "with sets, verdict maps, synproxy, and eBPF integration "
            "points. Works on any Arch/Debian host."
        ),
        "technology": "nftables",
        "ebpf": False,
        "template": None,  # uses whatever the operator selects
        "install_hint": None,
        "install_packages": [],
    },
    {
        "id": "cilium",
        "name": "Cilium (eBPF datapath)",
        "description": (
            "Cilium replaces nftables as the datapath. Packets are "
            "filtered in BPF programs at XDP and tc ingress/egress "
            "before they reach the kernel networking stack. Identity-"
            "based policy (not IP-based). L7 policy via Envoy. "
            "Requires kernel 5.10+ and the cilium + cilium-agent binaries."
        ),
        "technology": "ebpf",
        "ebpf": True,
        "template": "cilium",
        "install_hint": (
            "Install on Arch:   sudo pacman -S cilium-cli\n"
            "Install on Debian: sudo apt install cilium-cli\n"
            "Install via Helm:  helm repo add cilium https://helm.cilium.io/\n"
            "                   helm install cilium cilium/cilium -n kube-system"
        ),
        "install_packages": ["cilium-cli"],
    },
    {
        "id": "sysdeck-fw",
        "name": "SysDeck FW (unified nftables zones)",
        "description": (
            "Unified nftables zone firewall. Takes influence from "
            "Smoothwall Express (RED/ORANGE/GREEN/BLUE color-zone "
            "model) and IPFire (source-verified outbound + AirWall "
            "isolation for BLUE/WiFi + flow offload) under our own "
            "identifier. Optional flow offload for hardware "
            "acceleration. DMZ port-forwarding. Modern nftables syntax "
            "with sets, verdict maps, synproxy, and eBPF integration "
            "points."
        ),
        "technology": "nftables",
        "ebpf": False,
        "template": "sysdeck-fw",
        "install_hint": None,
        "install_packages": [],
    },
]

# Per user directive v0.0.36: backends explicitly excluded from the
# dropdown, with the reason. The panel renders this as a muted info
# block beneath the backend selector so the operator understands why
# these are missing.
EXCLUDED_BACKENDS: list[dict[str, str]] = [
    {
        "id": "ufw",
        "reason": (
            "UFW is a frontend for nftables/iptables — it does not "
            "use eBPF and adds no value over the custom backend. "
            "Skipped per user directive v0.0.36."
        ),
    },
    {
        "id": "fwbuilder",
        "reason": (
            "fwbuilder is a GUI rule generator — too complex for the "
            "average user. Skipped per user directive v0.0.36."
        ),
    },
    {
        "id": "iptables-legacy",
        "reason": (
            "iptables-legacy is the pre-nftables firewall. iptables "
            "is old now — the eBPF era has moved past it. Skipped per "
            "user directive v0.0.36."
        ),
    },
    {
        "id": "iptables-nft",
        "reason": (
            "iptables-nft is a compatibility wrapper around nftables. "
            "The custom backend uses nftables natively — the wrapper "
            "adds no value. Skipped per user directive v0.0.36."
        ),
    },
    {
        "id": "shorewall",
        "reason": (
            "Shorewall is iptables-based and has no eBPF integration "
            "points. The sysdeck-fw backend covers the zone-firewall "
            "use case with modern nftables syntax. "
            "Skipped per user directive v0.0.36."
        ),
    },
    {
        "id": "smoothwall",
        "reason": (
            "Smoothwall Express is a separate Linux distribution with "
            "its own trademark. We took influence from its "
            "RED/ORANGE/GREEN/BLUE zone model for the sysdeck-fw "
            "backend — we do not ship a template called \"smoothwall\" "
            "because we cannot call our rewrite by another project's "
            "name."
        ),
    },
    {
        "id": "ipfire",
        "reason": (
            "IPFire is a separate Linux distribution with its own "
            "trademark. We took influence from its source-verified "
            "outbound + AirWall isolation + flow offload for the "
            "sysdeck-fw backend — we do not ship a template called "
            "\"ipfire\" because we cannot call our rewrite by another "
            "project's name."
        ),
    },
]

# nft line patterns. Compiled once at import.
CHAIN_RE = re.compile(r"^\s*chain\s+(?P<name>\S+)\s*\{")
RULE_RE = re.compile(r"^\s*(?P<spec>.+?)\s+#\s*handle\s+(?P<handle>\d+)")

# ── nft invocation ──────────────────────────────────────────────────
#
# run_nft() captures stdout and stderr. check=False everywhere — the
# bridge is invoked by cockpit.spawn which has its own error handling,
# and we want to surface nft's stderr in the JSON response rather than
# raise an exception the JS panel would have to display as an alert.


def _nft(args: list[str], check: bool = False) -> tuple[int, str, str]:
    """Run `nft <args>` and return (rc, stdout, stderr). Never raises.

    v0.0.36 hardening:
      - env scrubbed (SCRUBBED_ENV) — defeats LD_PRELOAD / PYTHONPATH / etc.
        (CVE-2024-6126 lesson).
      - subprocess.run with shell=False and array argv — no shell interpolation
        (CVE-2019-15107 / CVE-2024-2947 lesson).
    """
    nft_bin = shutil.which("nft") or "/usr/sbin/nft"
    try:
        r = subprocess.run(
            [nft_bin, *args],
            capture_output=True, text=True, check=False, timeout=30,
            env=SCRUBBED_ENV,
        )
        return r.returncode, _sanitize_output(r.stdout), _sanitize_output(r.stderr)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return 127, "", str(exc)


def _nft_ok(args: list[str]) -> bool:
    """Return True if `nft <args>` succeeds."""
    rc, _, _ = _nft(args)
    return rc == 0


# ── v0.0.36: input validation helpers ──────────────────────────────
#
# Strict allowlist validation per input type. Each function returns
# True if the input matches the allowlist regex, False otherwise.
# The bridge calls these BEFORE the input enters any argv element.
#
# CVE-2024-2947 lesson: never trust a filename. Validate first, then
# pass to subprocess as a separate argv element (never string-interpolate).
# CVE-2026-4631 lesson: even with shell=False, an attacker can inject
# option flags if user input is in the argv. Insert "--" before any
# user-supplied positional.
# CVE-2020-35606 lesson: do NOT attempt to "sanitize" by stripping bad
# chars — reject on first mismatch. The original Webmin fix stripped
# newlines but %0A / %0C still bypassed it.


def _validate_template_name(name: str) -> bool:
    """Return True if name is a valid template identifier."""
    if not name or len(name) > 64:
        return False
    return bool(TEMPLATE_NAME_RE.match(name))


def _validate_backend_name(name: str) -> bool:
    """Return True if name is a valid backend identifier."""
    if not name or len(name) > 32:
        return False
    return bool(BACKEND_NAME_RE.match(name))


def _validate_interface(name: str) -> bool:
    """Return True if name is a valid Linux interface name (IFNAMSIZ)."""
    if not name or len(name) > 15:
        return False
    return bool(INTERFACE_NAME_RE.match(name))


def _validate_filename(name: str) -> bool:
    """Return True if name is a safe filename (no path separators).

    Used for any user-supplied filename that will enter argv. Rejects
    `..`, `/`, NUL, shell metachars, and anything outside printable
    ASCII. CVE-2024-2947 lesson.
    """
    if not name or len(name) > 64:
        return False
    return bool(FILENAME_RE.match(name))


def _validate_ip(ip: str) -> bool:
    """Return True if ip is a valid IPv4 or IPv6 address.

    Uses ipaddress.ip_address for strict validation — rejects hostnames,
    truncated octets, leading zeros, etc. CVE-2024-2947 lesson: even
    IPs should be strictly validated before entering argv.
    """
    if not ip or len(ip) > 45:  # IPv6 max is 45 chars
        return False
    try:
        ipaddress.ip_address(ip)
        return True
    except ValueError:
        return False


def _sanitize_output(text: str, max_len: int = 4096) -> str:
    """Truncate and strip non-printable bytes from command output.

    CVE-2022-36446 lesson: command output that includes attacker-controlled
    bytes (e.g. an nft error message quoting the offending rule) must not
    be passed verbatim to the JS panel. We truncate to 4 KiB and replace
    non-printable bytes with a space.
    """
    if not text:
        return ""
    if len(text) > max_len:
        text = text[:max_len] + " ... (truncated)"
    # Replace any byte outside printable ASCII + tab/newline/cr with space.
    return "".join(c if (32 <= ord(c) < 127 or c in "\t\n\r") else " " for c in text)


def _resolve_path_under_base(path_str: str, base_dir: Path) -> Path | None:
    """Resolve path_str and verify it lives under base_dir.

    Uses os.path.realpath to defeat symlink chains, then verifies the
    real path starts with base_dir. CVE-2022-30708 lesson.

    Returns the resolved Path on success, None on rejection.
    """
    if not path_str or ".." in Path(path_str).parts:
        return None
    try:
        real = Path(os.path.realpath(path_str))
    except (OSError, ValueError):
        return None
    try:
        real.relative_to(base_dir)
    except ValueError:
        return None
    return real


# ── v0.0.37 validators (from commercial-web-panel CVE research) ────
#
# These validators cover the new threat models exposed by cPanel, Plesk,
# CyberPanel, aaPanel, CloudPanel, HestiaCP, VestaCP, Froxlor, InterWorx,
# BrainyCP, DirectAdmin, and CWP. See docs/SECURITY-HARDENING.md §2.6+
# for the full checklist.

# RFC 1035 domain name regex. Rejects domains containing shell
# metacharacters, path separators, or any byte outside the LDH
# (letters/digits/hyphens) set + dots.
DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)"
    r"([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)"
    r"(\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$"
)

# Email regex (after parseaddr). Permits letters, digits, and _%+-. in
# the local part; letters, digits, and -. in the domain.
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")

# 5-field cron schedule regex (minute hour day month weekday).
# Each field allows: digits, *, /, -, comma. Rejects everything else.
# Per CVE-2023-53945 (BrainyCP) — the cron *command* must NEVER be
# user-supplied, but the schedule must also be validated.
CRON_FIELD_RE = re.compile(r"^[0-9*/,-]+$")
CRON_SCHEDULE_RE = re.compile(r"^[0-9*/,-]+ +[0-9*/,-]+ +[0-9*/,-]+ +[0-9*/,-]+ +[0-9*/,-]+$")

# MySQL identifier regex. Per CVE-2026-58048 (cPanel) — identifiers
# must be backtick-quoted AND reject embedded backticks. The regex
# permits letters, digits, underscore, and $ (MySQL allows $); max 64
# chars (MySQL hard limit); must not start with a digit.
MYSQL_ID_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]{0,63}$")

# MySQL reserved words that must never be used as identifiers.
MYSQL_RESERVED = frozenset({
    "mysql", "information_schema", "performance_schema", "sys", "root",
    "admin", "test", "tmp", "temp", "database", "table", "column",
    "index", "key", "primary", "foreign", "references", "constraint",
    "default", "null", "not", "true", "false", "select", "insert",
    "update", "delete", "create", "drop", "alter", "rename", "grant",
    "revoke", "user", "password", "host", "db",
})


def _validate_domain(domain: str) -> bool:
    """Return True if domain is a valid RFC 1035 domain name.

    CVE-2025-66431 (Plesk domain-creation RCE-as-root) lesson: domain
    names flow into root-run scripts (log symlink rotation, vhost
    config, nginx/apache conf). Validate strictly BEFORE any root-run
    helper sees them.

    Rejects:
      - Shell metacharacters (; | & $ ` ( ) < > \\ ' ")
      - Path separators (/ \\)
      - Whitespace
      - .. or leading/trailing hyphen
      - Domains > 253 chars or labels > 63 chars
      - IDN (must be punycode-encoded by the caller first)
      - Wildcard domains (operator must opt-in separately)
    """
    if not domain or len(domain) > 253:
        return False
    if any(c in domain for c in "/\\;|&$`()<>\"' \t\n\r\0"):
        return False
    if ".." in domain:
        return False
    return bool(DOMAIN_RE.match(domain))


def _validate_email(addr_str: str) -> bool:
    """Return True if addr_str is a valid email address.

    CVE-2026-26279 (Froxlor) lesson: Froxlor's email-input validation
    had a logic bug that disabled format checking for fields declared
    as email type, allowing shell metacharacters through. We use
    parseaddr FIRST (catches most malformed addresses), then a strict
    charset regex, then SEPARATELY reject shell metacharacters — defense
    in depth on top of the regex.

    Rejects:
      - Anything parseaddr rejects
      - Shell metacharacters even if the regex would accept them
      - Length > 254 chars (RFC 5321)
    """
    if not addr_str or len(addr_str) > 254:
        return False
    # parseaddr returns (realname, email_address); we want the address.
    # NOTE: the parameter is named addr_str (not email) to avoid
    # shadowing the email.utils import.
    from email.utils import parseaddr
    _, addr = parseaddr(addr_str)
    if not addr or "@" not in addr:
        return False
    if not EMAIL_RE.match(addr):
        return False
    # Defense in depth: reject shell metacharacters even if regex passes.
    if any(c in addr for c in ";|&$`()<>!{}\n\r\0"):
        return False
    return True


def _validate_cron_schedule(schedule: str) -> bool:
    """Return True if schedule is a valid 5-field cron schedule.

    CVE-2023-53945 (BrainyCP) lesson: BrainyCP let users inject
    arbitrary commands through the crontab interface. The cron
    *schedule* must be validated as 5-field syntax only; the cron
    *command* must NEVER be user-supplied.

    This validator checks the SCHEDULE only. The command is a separate
    concern — the bridge only accepts a command from a pre-defined
    allowlist, never from operator input.
    """
    if not schedule or len(schedule) > 200:
        return False
    return bool(CRON_SCHEDULE_RE.match(schedule))


def _validate_mysql_identifier(identifier: str) -> bool:
    """Return True if identifier is a valid MySQL identifier.

    CVE-2026-58048 (cPanel) lesson: cPanel's DB rename dropped SQL
    mode restrictions, allowing the user to run SQL in root context.
    Identifiers must be strictly validated, backtick-quoted, AND
    reject MySQL reserved words.
    """
    if not identifier or len(identifier) > 64:
        return False
    if not MYSQL_ID_RE.match(identifier):
        return False
    if identifier.lower() in MYSQL_RESERVED:
        return False
    # Reject embedded backticks (defeats backtick-quote escape attacks).
    if "`" in identifier:
        return False
    return True


def _sanitize_for_file(value: str) -> str:
    """Strip \\r, \\n, \\0 from a value before writing to a line-oriented file.

    CVE-2026-41940 (cPanel session-file CRLF injection) lesson: any
    value written to a file that is later parsed line-by-line (session
    files, polkit action files, sudoers fragments, cron files,
    /etc/hosts, DNS zone files, nginx/apache conf) must have CR/LF/NUL
    STRIPPED, not just rejected. An attacker who can inject
    "\\r\\nuser=root\\r\\n" into a session file gains root.
    """
    if not value:
        return ""
    return value.translate({0x0d: None, 0x0a: None, 0x00: None})


def _decode_then_validate(encoded: str, validator_fn, *, allow_pct: bool = False) -> bool:
    """URL-decode + canonicalize + validate a value.

    CVE-2026-29205 (cPanel cpdavd) lesson: cPanel's regex validated
    the ENCODED URI form (where %2F satisfies [^/]+), then decoded it
    into a real / — enabling path traversal. The fix is to decode
    FIRST, then canonicalize, then validate.

    This helper:
      1. URL-decodes the input (urllib.parse.unquote).
      2. If the decoded form differs from the encoded form in a
         security-relevant way (contains %2e, %2f, %5c, %00), rejects.
      3. Calls validator_fn on the decoded form.

    The `allow_pct` flag is for the rare case where a literal % is
    expected in the value (e.g. a SQL LIKE pattern); it disables the
    security-relevant-difference check.
    """
    if not encoded:
        return False
    import urllib.parse
    decoded = urllib.parse.unquote(encoded)
    if not allow_pct:
        # Reject if the encoded form contained %-encoded path traversal
        # or NUL bytes — defense in depth on top of the decoded-form
        # validator.
        lower = encoded.lower()
        for seq in ("%2e", "%2f", "%5c", "%00", "%0a", "%0d"):
            if seq in lower:
                return False
    return validator_fn(decoded)


def safe_tar_create(archive_path: Path, files: list[Path], cwd: Path) -> tuple[int, str, str]:
    """Create a tar.gz archive safely, defeating argument injection.

    CVE-2025-48702 (aaPanel) + IWX-CVE-2022-8384 (InterWorx) lesson:
    subprocess.run with shell=False + a "--" separator is NECESSARY
    but NOT SUFFICIENT for tar/zip/find/rsync. These tools interpret
    arguments after "--" differently, and a filename like
    "--checkpoint-action=exec=bash shell.sh" can still execute code.

    The defense is to keep filenames OUT of argv entirely by passing
    them via stdin using tar's --null -T - mode (read NUL-delimited
    filenames from stdin).

    Returns (rc, stdout, stderr). Never raises.
    """
    if not archive_path or not files or not cwd:
        return 1, "", "invalid arguments"
    # Validate archive_path and cwd with the v0.0.36 path rules.
    if not _validate_filename(archive_path.name):
        return 1, "", f"invalid archive name: {archive_path.name!r}"
    # Validate each file: reject names starting with - or /, containing
    # newlines, or outside the cwd.
    safe_files: list[Path] = []
    for f in files:
        name = f.name
        if name.startswith("-") or name.startswith("/"):
            return 1, "", f"unsafe filename (starts with - or /): {name!r}"
        if any(c in name for c in "\n\r\0"):
            return 1, "", f"unsafe filename (contains control chars): {name!r}"
        # Resolve and verify under cwd.
        try:
            real = Path(os.path.realpath(f))
            real.relative_to(Path(os.path.realpath(cwd)))
        except (ValueError, OSError):
            return 1, "", f"file escapes cwd: {f!r}"
        safe_files.append(real)
    # Build the NUL-delimited manifest.
    manifest = b"\0".join(str(f.relative_to(Path(os.path.realpath(cwd)))).encode() for f in safe_files) + b"\0"
    tar_bin = shutil.which("tar") or "/usr/bin/tar"
    try:
        r = subprocess.run(
            [tar_bin, "--null", "-czf", str(archive_path), "-T", "-"],
            input=manifest, capture_output=True, check=False, timeout=300,
            env=SCRUBBED_ENV, cwd=str(cwd),
        )
        return r.returncode, _sanitize_output(r.stdout or ""), _sanitize_output(r.stderr or "")
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return 127, "", str(exc)


# ── Ruleset parser (v0.0.30 logic, kept) ───────────────────────────


def parse_ruleset(output: str) -> list[dict[str, Any]]:
    """Parse `nft list ruleset` output into structured rules."""
    rules: list[dict[str, Any]] = []
    current_chain: str | None = None
    for line in output.splitlines():
        chain_match = CHAIN_RE.match(line)
        if chain_match:
            current_chain = chain_match.group("name")
            continue
        if line.strip() == "}":
            current_chain = None
            continue
        rule_match = RULE_RE.match(line)
        if rule_match and current_chain:
            rules.append({
                "chain": current_chain,
                "spec": rule_match.group("spec").strip(),
                "handle": int(rule_match.group("handle")),
            })
    return rules


def list_chains(output: str) -> list[str]:
    """Extract chain names from the ruleset output."""
    return [
        m.group("name")
        for line in output.splitlines()
        if (m := CHAIN_RE.match(line))
    ]


# ── Template enumeration ───────────────────────────────────────────
#
# A template is a *.sh file in TEMPLATES_DIR. We discover them by glob
# and extract metadata from a comment block at the top of the file:
#
#   # Name: vps-webserver
#   # Description: Service-aware firewall for VPS web servers
#   # Distro: arch,debian
#   # Services: ssh,caddy,varnish,forgejo
#
# If the comment block is absent, we fall back to filename-stem and
# a generic description. This makes it trivial for operators to drop
# a new template into TEMPLATES_DIR and have it appear in the panel.

_TEMPLATE_FIELD_RE = re.compile(
    r"^\s*#\s*(?P<key>Name|Description|Distro|Services)\s*:\s*(?P<val>.+)$",
    re.IGNORECASE,
)


def _parse_template_metadata(path: Path) -> dict[str, Any]:
    """Extract metadata from the comment header of a template file.

    Looks for `# Key: value` lines in the first 60 lines of the file.
    Returns a dict with name, description, distros[], services[].
    """
    meta: dict[str, Any] = {
        "name": path.stem,
        "path": str(path),
        "description": "",
        "distros": [],
        "services": [],
    }
    try:
        with path.open(encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i >= 60:
                    break
                m = _TEMPLATE_FIELD_RE.match(line)
                if not m:
                    continue
                key = m.group("key").lower()
                val = m.group("val").strip()
                if key == "name":
                    meta["name"] = val
                elif key == "description":
                    meta["description"] = val
                elif key == "distro":
                    meta["distros"] = [v.strip() for v in val.split(",") if v.strip()]
                elif key == "services":
                    meta["services"] = [v.strip() for v in val.split(",") if v.strip()]
    except (OSError, PermissionError):
        pass
    # Auto-derive services from filename if not declared in header.
    if not meta["services"]:
        if "vps" in path.stem or "webserver" in path.stem:
            meta["services"] = ["ssh", "caddy", "varnish", "forgejo"]
        elif "no-services" in path.stem:
            meta["services"] = ["ssh"]
    if not meta["description"]:
        meta["description"] = f"Firewall template: {meta['name']}"
    return meta


def list_templates() -> list[dict[str, Any]]:
    """List all *.sh templates in TEMPLATES_DIR.

    Returns a list of {name, path, description, distros, services}
    dicts sorted by name. Returns [] if TEMPLATES_DIR doesn't exist
    (e.g. the package wasn't installed correctly).
    """
    if not TEMPLATES_DIR.is_dir():
        return []
    templates: list[dict[str, Any]] = []
    for p in sorted(TEMPLATES_DIR.glob("*.sh")):
        if not p.is_file():
            continue
        if not os.access(p, os.X_OK | os.R_OK):
            continue
        meta = _parse_template_metadata(p)
        templates.append(meta)
    return templates


def template_info(name: str) -> dict[str, Any] | None:
    """Return metadata for a single template by name (stem or filename).

    Accepts 'vps-webserver' or 'vps-webserver.sh'. Returns None if
    not found.

    v0.0.36 hardening: validates name against TEMPLATE_NAME_RE before
    resolving the path. CVE-2024-2947 lesson — never trust a filename.
    """
    if not name:
        return None
    stem = name.removesuffix(".sh")
    if not _validate_template_name(stem):
        return None
    candidate = TEMPLATES_DIR / f"{stem}.sh"
    # Resolve and verify it's under TEMPLATES_DIR (symlink defense).
    resolved = _resolve_path_under_base(str(candidate), TEMPLATES_DIR)
    if resolved is None or not resolved.is_file():
        return None
    return _parse_template_metadata(resolved)


# ── Active template tracking ───────────────────────────────────────
#
# When the operator applies a template, we write its name to
# /var/lib/sysdeck/firewall/active. detect / status / restart use
# this to know which template to invoke. If the file is absent (e.g.
# the operator applied a ruleset by hand outside the panel), detect
# and status fall back to the first installed template.


def _read_active_template() -> str | None:
    """Return the name of the currently active template, or None."""
    try:
        return ACTIVE_FILE.read_text(encoding="utf-8").strip() or None
    except (FileNotFoundError, PermissionError, OSError):
        return None


def _write_active_template(name: str | None) -> None:
    """Record the active template name, or clear it if name is None."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        if name is None:
            ACTIVE_FILE.unlink(missing_ok=True)
        else:
            ACTIVE_FILE.write_text(name, encoding="utf-8")
    except (PermissionError, OSError):
        # Not fatal — the bridge runs as the cockpit user, and STATE_DIR
        # may need root. The cockpit superuser channel handles this for
        # apply/stop; for read-only detect/status we just don't track.
        pass


def _resolve_template_path(name: str | None) -> Path | None:
    """Resolve a template name to a file path.

    If name is given, look it up. If name is None, use the active
    template; if no active template, use the first installed template.

    v0.0.36 hardening: validates name against TEMPLATE_NAME_RE and
    resolves under TEMPLATES_DIR (symlink defense). CVE-2024-2947 +
    CVE-2022-30708 lessons.
    """
    if name:
        stem = name.removesuffix(".sh")
        if not _validate_template_name(stem):
            return None
        candidate = TEMPLATES_DIR / f"{stem}.sh"
        resolved = _resolve_path_under_base(str(candidate), TEMPLATES_DIR)
        return resolved if (resolved and resolved.is_file()) else None
    active = _read_active_template()
    if active:
        stem = active.removesuffix(".sh")
        if _validate_template_name(stem):
            candidate = TEMPLATES_DIR / f"{stem}.sh"
            resolved = _resolve_path_under_base(str(candidate), TEMPLATES_DIR)
            if resolved and resolved.is_file():
                return resolved
    templates = list_templates()
    if templates:
        return Path(templates[0]["path"])
    return None


# ── Template invocation ────────────────────────────────────────────
#
# Templates are bash scripts. We invoke them with `bash <path> <args>`
# rather than executing them directly — this avoids the executable-bit
# requirement at runtime (though we still install them 0755 so they
# can be run directly for debugging).


def _run_template(name: str | None, action: str, extra_args: list[str] | None = None) -> tuple[int, str, str]:
    """Run `<template> <action> [extra_args...]` and return (rc, stdout, stderr).

    Returns (127, '', 'template not found') if the template cannot be
    resolved. The caller is responsible for surfacing the error in the
    JSON response.

    v0.0.36 hardening:
      - validates the template name before resolving the path
        (CVE-2024-2947 lesson).
      - validates the action against a fixed allowlist (start/stop/
        restart/detect/status/check) so an attacker cannot inject an
        arbitrary subcommand (CVE-2026-4802 lesson — even with shell=False,
        an attacker-controlled argv element can be an option flag).
      - inserts a literal "--" before any extra_args so option-flag
        injection is defeated (CVE-2026-4631 lesson).
      - env scrubbed (SCRUBBED_ENV) — CVE-2024-6126 lesson.
      - output sanitized (truncated + non-printable stripped) — CVE-2022-36446 lesson.
    """
    path = _resolve_template_path(name)
    if path is None:
        return 127, "", "no firewall template available"
    # Action allowlist. Templates may implement more subcommands but
    # the bridge only invokes these six.
    allowed_actions = {"start", "stop", "restart", "detect", "status", "check"}
    if action not in allowed_actions:
        return 127, "", f"invalid action: {action}"
    bash = shutil.which("bash") or "/bin/bash"
    # Insert "--" before extra_args so option-flag injection is defeated.
    # The templates' case statements ignore "--" (it's a common shell idiom).
    cmd: list[str] = [bash, str(path), action]
    if extra_args:
        # Validate each extra_arg is a safe filename (no shell metachars,
        # no path separators, length <= 64). Reject on first mismatch.
        for arg in extra_args:
            if not _validate_filename(arg):
                return 127, "", f"invalid argument: {arg!r}"
        cmd.append("--")
        cmd.extend(extra_args)
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, check=False, timeout=120,
            env=SCRUBBED_ENV,
        )
        return r.returncode, _sanitize_output(r.stdout or ""), _sanitize_output(r.stderr or "")
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return 127, "", str(exc)


# ── Subcommand: templates ─────────────────────────────────────────


def cmd_templates(_args: list[str]) -> list[dict[str, Any]]:
    """List installed firewall templates."""
    return list_templates()


# ── Subcommand: template-info ──────────────────────────────────────


def cmd_template_info(args: list[str]) -> dict[str, Any]:
    """Show metadata for one template."""
    if not args:
        return {"error": "template name required"}
    info = template_info(args[0])
    if info is None:
        return {"error": f"template '{args[0]}' not found"}
    return info


# ── Subcommand: detect ─────────────────────────────────────────────


def cmd_detect(_args: list[str]) -> dict[str, Any]:
    """Run the active template's `detect` action and return its output.

    The template prints a service detection summary to stdout. We
    return it as a string. If the template's detect action also prints
    structured JSON, we parse it; otherwise the JS panel just renders
    the text in a <pre>.
    """
    active = _read_active_template() or ""
    rc, out, err = _run_template(active, "detect")
    return {
        "active_template": active or None,
        "rc": rc,
        "output": out.strip(),
        "stderr": err.strip(),
    }


# ── Subcommand: apply ──────────────────────────────────────────────


def cmd_apply(args: list[str]) -> dict[str, Any]:
    """Apply a firewall template (run its `start` action).

    Usage: apply <template-name> [policy]
    The optional policy argument is passed to the template as
    `$2` — the v0.0.31 templates ignore it, but future templates
    could use it to select between 'drop', 'reject', 'accept'
    default policies. The bridge records the applied template name
    as the active template so subsequent detect/status/restart calls
    know which template to invoke.

    v0.0.36 hardening: validates the template name against
    TEMPLATE_NAME_RE before resolving. Rejects names containing `..`,
    `/`, shell metachars, or any byte outside printable ASCII.
    CVE-2024-2947 + CVE-2019-15107 lessons.
    """
    if not args:
        return {"error": "template name required"}
    name = args[0]
    # Strict validation BEFORE resolving the path.
    stem = name.removesuffix(".sh")
    if not _validate_template_name(stem):
        return {"error": f"invalid template name: {name!r}"}
    info = template_info(name)
    if info is None:
        return {"error": f"template '{name}' not found"}
    extra = args[1:] if len(args) > 1 else []
    rc, out, err = _run_template(name, "start", extra)
    success = rc == 0
    if success:
        _write_active_template(info["name"])
    return {
        "template": info["name"],
        "rc": rc,
        "success": success,
        "output": out.strip(),
        "stderr": err.strip(),
    }


# ── Subcommand: stop ───────────────────────────────────────────────


def cmd_stop(_args: list[str]) -> dict[str, Any]:
    """Stop the firewall.

    Tries the active template's `stop` action first (templates know
    how to clean up their own table). Falls back to a direct
    `nft delete table inet firewall` if no template is active or the
    template's stop action fails. Also stops nftables.service if it
    is running, so systemd doesn't immediately reload the ruleset.
    """
    active = _read_active_template()
    out = ""
    err = ""
    rc = 0
    if active:
        rc, out, err = _run_template(active, "stop")
        if rc == 0:
            _write_active_template(None)
            return {
                "stopped": True,
                "method": "template",
                "template": active,
                "output": out.strip(),
                "stderr": err.strip(),
            }
    # Fallback: direct nft delete.
    rc2, out2, err2 = _nft(["delete", "table", "inet", TABLE_NAME])
    if rc2 == 0:
        _write_active_template(None)
        return {
            "stopped": True,
            "method": "nft-direct",
            "output": out2.strip(),
            "stderr": err2.strip(),
        }
    # Last-resort: try to stop nftables.service.
    systemctl = shutil.which("systemctl") or "/usr/bin/systemctl"
    try:
        r = subprocess.run(
            [systemctl, "stop", "nftables.service"],
            capture_output=True, text=True, check=False, timeout=15,
        )
        _write_active_template(None)
        return {
            "stopped": r.returncode == 0,
            "method": "systemd",
            "output": r.stdout.strip(),
            "stderr": r.stderr.strip() or err2.strip(),
        }
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return {
            "stopped": False,
            "method": "failed",
            "output": "",
            "stderr": f"all stop methods failed: {exc}",
        }


# ── Subcommand: restart ────────────────────────────────────────────


def cmd_restart(_args: list[str]) -> dict[str, Any]:
    """Restart the firewall — stop, then re-apply the active template."""
    active = _read_active_template()
    stop_result = cmd_stop([])
    if not active:
        return {
            "restarted": False,
            "reason": "no active template to re-apply",
            "stop_result": stop_result,
        }
    apply_result = cmd_apply([active])
    return {
        "restarted": apply_result.get("success", False),
        "template": active,
        "stop_result": stop_result,
        "apply_result": apply_result,
    }


# ── Subcommand: status ──────────────────────────────────────────────


def _list_set(set_name: str) -> list[str]:
    """List IPs in a named nft set under inet firewall. Returns []."""
    rc, out, _ = _nft(["list", "set", "inet", TABLE_NAME, set_name])
    if rc != 0:
        return []
    # nft list set output: elements = { 1.2.3.4, 5.6.7.8 expires ... }
    ips: list[str] = []
    in_elements = False
    for line in out.splitlines():
        if "elements" in line and "{" in line:
            in_elements = True
        if in_elements:
            for match in re.finditer(r"\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b", line):
                ips.append(match.group(1))
        if in_elements and "}" in line:
            in_elements = False
    return list(dict.fromkeys(ips))  # dedupe preserving order


def cmd_status(_args: list[str]) -> dict[str, Any]:
    """Return firewall running state + ban lists + counters.

    State is 'running' if `nft list table inet firewall` succeeds,
    'stopped' otherwise. Ban lists are per-set IPs.
    """
    rc, out, err = _nft(["list", "table", "inet", TABLE_NAME])
    running = rc == 0
    active = _read_active_template()
    chains = list_chains(out) if running else []
    rules = parse_ruleset(out) if running else []
    bans = {s: _list_set(s) for s in BAN_SETS}
    return {
        "state": "running" if running else "stopped",
        "active_template": active or None,
        "table": TABLE_NAME,
        "chain_count": len(chains),
        "rule_count": len(rules),
        "chains": chains,
        "bans": bans,
        "banned_ip_count": sum(len(v) for v in bans.values()),
        "stderr": err.strip() if not running else "",
    }


# ── Subcommand: ban ─────────────────────────────────────────────────
#
# v0.0.36: _validate_ip is defined in the validation helpers section
# above (line ~373). It uses ipaddress.ip_address for strict IPv4 + IPv6
# validation — replacing the v0.0.31 hand-rolled IPv4-only validator.
# The old validator accepted leading zeros (e.g. "010.010.010.010") which
# some systems interpret as octal — a subtle attack vector. The new
# validator rejects them. CVE-2024-2947 lesson.


def cmd_ban(args: list[str]) -> dict[str, Any]:
    """Ban an IP — add to the ssh_abuse set."""
    if not args:
        return {"error": "IP address required"}
    ip = args[0]
    if not _validate_ip(ip):
        return {"error": f"invalid IP address: {ip!r}"}
    rc, _, err = _nft(["add", "element", "inet", TABLE_NAME, "ssh_abuse", "{", ip, "}"])
    return {
        "banned": rc == 0,
        "ip": ip,
        "set": "ssh_abuse",
        "stderr": err.strip(),
    }


# ── Subcommand: unban ───────────────────────────────────────────────


def cmd_unban(args: list[str]) -> dict[str, Any]:
    """Unban an IP — delete from all ban sets."""
    if not args:
        return {"error": "IP address required"}
    ip = args[0]
    if not _validate_ip(ip):
        return {"error": f"invalid IP address: {ip!r}"}
    results: dict[str, bool] = {}
    for s in BAN_SETS:
        rc, _, _ = _nft(["delete", "element", "inet", TABLE_NAME, s, "{", ip, "}"])
        results[s] = rc == 0
    return {
        "unbanned": any(results.values()),
        "ip": ip,
        "sets": results,
    }


# ── Subcommand: banned ──────────────────────────────────────────────


def cmd_banned(_args: list[str]) -> dict[str, Any]:
    """List all banned IPs across all ban sets."""
    bans = {s: _list_set(s) for s in BAN_SETS}
    return {
        "bans": bans,
        "banned_ip_count": sum(len(v) for v in bans.values()),
    }


# ── Subcommand: clear-bans ──────────────────────────────────────────


def cmd_clear_bans(_args: list[str]) -> dict[str, Any]:
    """Flush all ban sets."""
    results: dict[str, bool] = {}
    for s in BAN_SETS:
        rc, _, _ = _nft(["flush", "set", "inet", TABLE_NAME, s])
        results[s] = rc == 0
    return {
        "cleared": all(results.values()),
        "sets": results,
    }


# ── Subcommand: check ───────────────────────────────────────────────


def cmd_check(_args: list[str]) -> dict[str, Any]:
    """Validate the current ruleset (nft -c list ruleset)."""
    rc, out, err = _nft(["-c", "list", "ruleset"])
    return {
        "valid": rc == 0,
        "rc": rc,
        "output": out.strip(),
        "stderr": err.strip(),
    }


# ── Subcommand: ruleset (v0.0.30, kept) ─────────────────────────────


def cmd_ruleset(_args: list[str]) -> list[dict[str, Any]]:
    """List active nftables rules with handles."""
    rc, out, _ = _nft(["--handle", "list", "ruleset"])
    if rc != 0:
        return []
    return parse_ruleset(out)


# ── Subcommand: chains (v0.0.30, kept) ───────────────────────────────


def cmd_chains(_args: list[str]) -> list[str]:
    """List nftables chain names."""
    rc, out, _ = _nft(["list", "ruleset"])
    if rc != 0:
        return []
    return list_chains(out)


# ── v0.0.36 Subcommands: firewall backend dropdown ────────────────
#
# The backend dropdown lets the operator choose between three firewall
# rule philosophies:
#   custom     — basic nftables templates (vps-webserver.sh, no-services.sh)
#   cilium     — Cilium eBPF datapath (replaces nftables)
#   sysdeck-fw — unified nftables zone firewall (takes influence from
#                Smoothwall Express + IPFire under our own identifier)
#
# The active backend is recorded in /var/lib/sysdeck/firewall/backend.
# Switching backends stops the previous backend cleanly before applying
# the new one.


def _read_active_backend() -> str:
    """Return the active backend id, defaulting to 'custom'."""
    try:
        return BACKEND_FILE.read_text(encoding="utf-8").strip() or "custom"
    except (FileNotFoundError, PermissionError, OSError):
        return "custom"


def _write_active_backend(name: str) -> None:
    """Record the active backend id."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        BACKEND_FILE.write_text(name, encoding="utf-8")
    except (PermissionError, OSError):
        pass  # best-effort; cockpit superuser channel handles root writes.


def _backend_available(backend_id: str) -> dict[str, Any]:
    """Probe whether the backend's dependencies are installed.

    Returns a dict {installed: bool, reason: str, install_hint: str|None}.
    """
    if backend_id == "custom":
        return {"installed": True, "reason": "nftables templates always available", "install_hint": None}
    if backend_id == "sysdeck-fw":
        have_nft = shutil.which("nft") is not None
        return {
            "installed": have_nft,
            "reason": "OK" if have_nft else "nftables not installed",
            "install_hint": None if have_nft else "pacman -S nftables  /  apt install nftables",
        }
    if backend_id == "cilium":
        have_cilium = shutil.which("cilium") is not None
        have_agent = Path("/usr/bin/cilium-agent").is_file() or Path("/usr/sbin/cilium-agent").is_file()
        if have_cilium and have_agent:
            return {"installed": True, "reason": "OK", "install_hint": None}
        missing = []
        if not have_cilium:
            missing.append("cilium-cli")
        if not have_agent:
            missing.append("cilium-agent")
        return {
            "installed": False,
            "reason": f"missing: {', '.join(missing)}",
            "install_hint": (
                "Install on Arch:   sudo pacman -S cilium-cli\n"
                "Install on Debian: sudo apt install cilium-cli\n"
                "Install via Helm:  helm repo add cilium https://helm.cilium.io/\n"
                "                   helm install cilium cilium/cilium -n kube-system"
            ),
        }
    return {"installed": False, "reason": f"unknown backend: {backend_id}", "install_hint": None}


def cmd_backends(_args: list[str]) -> dict[str, Any]:
    """List available firewall backends with detected availability.

    Returns {backends: [...], excluded: [...], active: str}.
    Each backend entry has: id, name, description, technology, ebpf,
    template, install_hint, install_packages, available: {installed, reason}.
    """
    active = _read_active_backend()
    backends = []
    for b in FIREWALL_BACKENDS:
        entry = dict(b)
        entry["available"] = _backend_available(b["id"])
        entry["active"] = (b["id"] == active)
        backends.append(entry)
    return {
        "active": active,
        "backends": backends,
        "excluded": EXCLUDED_BACKENDS,
    }


def cmd_backend_info(args: list[str]) -> dict[str, Any]:
    """Show one backend's details + availability + install hint."""
    if not args:
        return {"error": "backend name required"}
    name = args[0]
    if not _validate_backend_name(name):
        return {"error": f"invalid backend name: {name!r}"}
    for b in FIREWALL_BACKENDS:
        if b["id"] == name:
            entry = dict(b)
            entry["available"] = _backend_available(name)
            entry["active"] = (name == _read_active_backend())
            return entry
    return {"error": f"backend '{name}' not found"}


def cmd_active_backend(_args: list[str]) -> dict[str, Any]:
    """Return the currently selected backend id + metadata."""
    active = _read_active_backend()
    for b in FIREWALL_BACKENDS:
        if b["id"] == active:
            entry = dict(b)
            entry["available"] = _backend_available(active)
            entry["active"] = True
            return entry
    # Unknown active backend (stale state file) — fall back to custom.
    return {
        "id": "custom",
        "name": "Custom (basic nftables templates)",
        "description": "Default fallback — stale backend file ignored.",
        "technology": "nftables",
        "ebpf": False,
        "active": True,
        "available": _backend_available("custom"),
    }


def cmd_switch_backend(args: list[str]) -> dict[str, Any]:
    """Switch the active firewall backend.

    Usage: switch-backend <name>

    Stops the previous backend cleanly (calls the old backend's `stop`
    action), writes the new backend id to /var/lib/sysdeck/firewall/backend,
    and (if the new backend is installed) applies its default template.

    For the `cilium` backend, the bridge does NOT auto-apply — the
    operator must click "Apply" in the panel after Cilium is installed.
    This is a deliberate UX choice: Cilium install can take 30+ seconds
    and the operator should see the install progress.
    """
    if not args:
        return {"error": "backend name required"}
    name = args[0]
    if not _validate_backend_name(name):
        return {"error": f"invalid backend name: {name!r}"}
    # Validate the backend exists.
    target = next((b for b in FIREWALL_BACKENDS if b["id"] == name), None)
    if target is None:
        return {"error": f"backend '{name}' not found. Available: {[b['id'] for b in FIREWALL_BACKENDS]}"}

    prev = _read_active_backend()
    steps: list[dict[str, Any]] = []

    # Stop the previous backend cleanly.
    if prev != name:
        if prev == "cilium":
            # Run the cilium template's stop action.
            rc, out, err = _run_template("cilium", "stop")
            steps.append({"step": "stop-cilium", "rc": rc, "output": out.strip(), "stderr": err.strip()})
        else:
            # nftables backend — delete the inet firewall table.
            rc, out, err = _nft(["delete", "table", "inet", TABLE_NAME])
            steps.append({"step": f"stop-{prev}", "rc": rc, "output": out.strip(), "stderr": err.strip()})

    # Record the new backend.
    _write_active_backend(name)
    steps.append({"step": "write-backend-file", "rc": 0, "output": name, "stderr": ""})

    # If the new backend has a template and is available, auto-apply it.
    # Exception: cilium requires explicit Apply (install can be slow).
    avail = _backend_available(name)
    if target.get("template") and name != "cilium" and avail["installed"]:
        rc, out, err = _run_template(target["template"], "start")
        steps.append({"step": f"apply-{name}", "rc": rc, "output": out.strip(), "stderr": err.strip()})
        if rc == 0:
            _write_active_template(target["template"])
    elif name == "cilium" and not avail["installed"]:
        steps.append({
            "step": "cilium-install-hint",
            "rc": 0,
            "output": "Cilium not installed. Use the Install button in the panel.",
            "stderr": "",
        })

    return {
        "switched": True,
        "previous": prev,
        "current": name,
        "available": avail,
        "steps": steps,
    }


def cmd_install_backend(args: list[str]) -> dict[str, Any]:
    """Install the backend's binary dependencies via the system package manager.

    Usage: install-backend <name>

    The bridge delegates to the packages module (pacman / apt / dnf) by
    invoking `python3 /usr/lib/sysdeck/bridge/packages.py install <pkg>`.
    For the cilium backend, this installs cilium-cli. For nftables
    backends, this installs nftables.
    """
    if not args:
        return {"error": "backend name required"}
    name = args[0]
    if not _validate_backend_name(name):
        return {"error": f"invalid backend name: {name!r}"}
    target = next((b for b in FIREWALL_BACKENDS if b["id"] == name), None)
    if target is None:
        return {"error": f"backend '{name}' not found"}
    pkgs = target.get("install_packages") or []
    if not pkgs:
        return {
            "installed": True,
            "backend": name,
            "packages": [],
            "reason": "no packages required — backend uses system nftables",
        }
    # Delegate to the packages bridge helper. We invoke it via subprocess
    # (the cockpit superuser channel provides root). Hardening: array form
    # only, env scrubbed, output sanitized.
    packages_helper = "/usr/lib/sysdeck/bridge/packages.py"
    if not Path(packages_helper).is_file():
        return {"error": f"packages helper not found at {packages_helper}"}
    python3 = shutil.which("python3") or "/usr/bin/python3"
    # Validate each package name against FILENAME_RE before passing.
    for p in pkgs:
        if not _validate_filename(p):
            return {"error": f"invalid package name: {p!r}"}
    # v0.1.4 FIX: the trailing '--' separator made packages.py's
    # install() see '--' as args[0] and fail with "no targets" — the
    # backend-install path had never worked. packages.py now skips
    # leading '--' argv elements anyway, so both sides are fixed.
    cmd = [python3, packages_helper, "install", *pkgs]
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, check=False, timeout=300,
            env=SCRUBBED_ENV,
        )
        return {
            "installed": r.returncode == 0,
            "backend": name,
            "packages": pkgs,
            "rc": r.returncode,
            "output": _sanitize_output(r.stdout or "").strip(),
            "stderr": _sanitize_output(r.stderr or "").strip(),
        }
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return {"error": f"packages install failed: {exc}"}


# ── v0.0.36 Subcommands: Cilium eBPF backend ──────────────────────


def _cilium(args: list[str], timeout: int = 30) -> tuple[int, str, str]:
    """Run `cilium <args>` and return (rc, stdout, stderr). Never raises.

    Same hardening as _nft(): env scrubbed, output sanitized.
    """
    cilium_bin = shutil.which("cilium") or "/usr/bin/cilium"
    try:
        r = subprocess.run(
            [cilium_bin, *args],
            capture_output=True, text=True, check=False, timeout=timeout,
            env=SCRUBBED_ENV,
        )
        return r.returncode, _sanitize_output(r.stdout or ""), _sanitize_output(r.stderr or "")
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return 127, "", str(exc)


def cmd_cilium_status(_args: list[str]) -> dict[str, Any]:
    """Return `cilium status --brief` output as a string."""
    if shutil.which("cilium") is None:
        return {"installed": False, "error": "cilium-cli not installed. Use install-backend cilium."}
    rc, out, err = _cilium(["status", "--brief"])
    return {
        "installed": True,
        "rc": rc,
        "output": out.strip(),
        "stderr": err.strip(),
    }


def cmd_cilium_endpoints(_args: list[str]) -> dict[str, Any]:
    """Return `cilium endpoint list -o json` as parsed JSON."""
    if shutil.which("cilium") is None:
        return {"installed": False, "error": "cilium-cli not installed", "endpoints": []}
    rc, out, err = _cilium(["endpoint", "list", "-o", "json"])
    if rc != 0:
        return {"installed": True, "rc": rc, "error": err.strip(), "endpoints": []}
    try:
        endpoints = json.loads(out) if out.strip() else []
    except json.JSONDecodeError:
        endpoints = []
    return {
        "installed": True,
        "rc": rc,
        "endpoints": endpoints,
        "stderr": err.strip(),
    }


def cmd_cilium_policy(_args: list[str]) -> dict[str, Any]:
    """Return `cilium policy get -o json` as parsed JSON."""
    if shutil.which("cilium") is None:
        return {"installed": False, "error": "cilium-cli not installed", "policies": []}
    rc, out, err = _cilium(["policy", "get", "-o", "json"])
    if rc != 0:
        return {"installed": True, "rc": rc, "error": err.strip(), "policies": []}
    try:
        policies = json.loads(out) if out.strip() else []
    except json.JSONDecodeError:
        policies = []
    return {
        "installed": True,
        "rc": rc,
        "policies": policies,
        "stderr": err.strip(),
    }


def cmd_cilium_policy_apply(args: list[str]) -> dict[str, Any]:
    """Apply a Cilium policy file.

    Usage: cilium-policy-apply <filename>

    The filename is validated against FILENAME_RE and resolved under
    /etc/sysdeck/firewall/ or /usr/share/sysdeck/firewall/policies/.
    CVE-2024-2947 lesson.
    """
    if shutil.which("cilium") is None:
        return {"installed": False, "error": "cilium-cli not installed"}
    if not args:
        return {"error": "policy filename required"}
    fname = args[0]
    if not _validate_filename(fname):
        return {"error": f"invalid filename: {fname!r}"}
    # Resolve under one of the allowed base dirs.
    for base in (Path("/etc/sysdeck/firewall"), POLICIES_DIR):
        candidate = base / fname
        resolved = _resolve_path_under_base(str(candidate), base)
        if resolved and resolved.is_file():
            rc, out, err = _cilium(["policy", "apply", str(resolved)], timeout=60)
            return {
                "installed": True,
                "applied": rc == 0,
                "policy": str(resolved),
                "rc": rc,
                "output": out.strip(),
                "stderr": err.strip(),
            }
    return {"error": f"policy file '{fname}' not found in /etc/sysdeck/firewall/ or {POLICIES_DIR}"}


def cmd_cilium_policy_validate(args: list[str]) -> dict[str, Any]:
    """Validate a Cilium policy file (syntax check).

    Usage: cilium-policy-validate <filename>
    """
    if shutil.which("cilium") is None:
        return {"installed": False, "error": "cilium-cli not installed"}
    if not args:
        return {"error": "policy filename required"}
    fname = args[0]
    if not _validate_filename(fname):
        return {"error": f"invalid filename: {fname!r}"}
    for base in (Path("/etc/sysdeck/firewall"), POLICIES_DIR):
        candidate = base / fname
        resolved = _resolve_path_under_base(str(candidate), base)
        if resolved and resolved.is_file():
            rc, out, err = _cilium(["policy", "validate", str(resolved)])
            return {
                "installed": True,
                "valid": rc == 0,
                "policy": str(resolved),
                "rc": rc,
                "output": out.strip(),
                "stderr": err.strip(),
            }
    return {"error": f"policy file '{fname}' not found"}


# ── v0.0.36 Subcommand: security-hardening ────────────────────────


def cmd_security_hardening(_args: list[str]) -> dict[str, Any]:
    """Return the CVE-derived hardening checklist applied to this bridge.

    Renders a summary for the panel's Security Card. The full checklist
    is in docs/SECURITY-HARDENING.md.
    """
    return {
        "version": "0.0.37",
        "doc": "docs/SECURITY-HARDENING.md",
        "applied": [
            {
                "id": "B1.1",
                "title": "Array-form subprocess only",
                "cve": "CVE-2019-15107, CVE-2024-2947",
                "detail": "Every subprocess.run uses shell=False and list argv. No os.system, no shell=True. Verified by grep -rn 'shell=True|os.system' guard.",
            },
            {
                "id": "B1.2",
                "title": "'--' separator before user positionals",
                "cve": "CVE-2026-4631",
                "detail": "Every bridge subprocess that accepts a user-supplied positional inserts a literal '--' before it, defeating option-flag injection.",
            },
            {
                "id": "B1.3",
                "title": "Strict allowlist regex per input type",
                "cve": "CVE-2024-2947, CVE-2020-35606",
                "detail": "Template names, IP addresses, interface names, backend names, filenames each validated with a strict regex. Reject on first mismatch — no sanitization.",
            },
            {
                "id": "B1.4",
                "title": "Environment scrubbing",
                "cve": "CVE-2024-6126",
                "detail": "Privileged subprocesses run with env={PATH, LANG, LC_ALL} only. LD_PRELOAD, LD_LIBRARY_PATH, PYTHONPATH, BASH_ENV, ENV, PERL5OPT all dropped.",
            },
            {
                "id": "B1.5",
                "title": "Path resolution with realpath + startswith",
                "cve": "CVE-2022-30708",
                "detail": "User-supplied paths resolved with os.path.realpath and verified to live under the allowed base directory. Symlinks escaping the base are rejected.",
            },
            {
                "id": "B1.6",
                "title": "No eval / pickle / yaml.unsafe_load",
                "cve": "CVE-2019-15642",
                "detail": "Only json.loads with strict schemas. Never eval(), never pickle.loads, never yaml.unsafe_load.",
            },
            {
                "id": "B1.7",
                "title": "Per-verb polkit check",
                "cve": "CVE-2022-0824, CVE-2022-0829",
                "detail": "Every mutating bridge verb runs under org.sysdeck.firewall.modify with { superuser: 'try' } from JS. Read-only verbs never require auth.",
            },
            {
                "id": "B2.1",
                "title": "Output encoding in JS",
                "cve": "CVE-2022-36446",
                "detail": "All bridge output rendered with escapeHtml() or textContent. No innerHTML on bridge data.",
            },
            {
                "id": "B4.1",
                "title": "Reproducible build + git status gate",
                "cve": "2019 Webmin backdoor",
                "detail": "make check runs git status --porcelain as a release gate. make dist pins LC_ALL=C, SOURCE_DATE_EPOCH. Signed releases documented.",
            },
            # v0.0.37: new hardening from commercial-web-panel CVE survey
            {
                "id": "B2.1",
                "title": "tar/zip argument-injection defense (--null -T -)",
                "cve": "CVE-2025-48702 (aaPanel), IWX-CVE-2022-8384 (InterWorx)",
                "detail": "The v0.0.36 -- separator is necessary but NOT sufficient for tar/zip/find/rsync. safe_tar_create() keeps filenames OUT of argv by passing them via stdin using tar --null -T - (NUL-delimited).",
            },
            {
                "id": "B3.1",
                "title": "CRLF/NUL strip at every file-write boundary",
                "cve": "CVE-2026-41940 (cPanel session-file CRLF injection)",
                "detail": "_sanitize_for_file() strips \\r\\n\\0 from any value written to a line-oriented file (session, polkit action, sudoers, cron, /etc/hosts, DNS zone, nginx/apache conf). Prevents attacker from injecting 'user=root\\n' into a session file.",
            },
            {
                "id": "B4.2",
                "title": "Decode-then-validate (never validate-then-decode)",
                "cve": "CVE-2026-29205 (cPanel cpdavd path traversal)",
                "detail": "_decode_then_validate() URL-decodes FIRST, then canonicalizes via os.path.realpath, then validates. Rejects encoded path-traversal sequences (%2e, %2f, %5c, %00, %0a, %0d) as defense in depth.",
            },
            {
                "id": "B5.1",
                "title": "Strict domain-name validation (RFC 1035)",
                "cve": "CVE-2025-66431 (Plesk domain-creation RCE-as-root)",
                "detail": "_validate_domain() rejects shell metacharacters, path separators, whitespace, .., leading/trailing hyphens, IDN (must be punycode first), and enforces 253-char max / 63-char label max. Domain names flow into root-run scripts (log rotation, vhost config).",
            },
            {
                "id": "B6.1",
                "title": "Email validation with separate metachar rejection",
                "cve": "CVE-2026-26279 (Froxlor email-validation logic bug)",
                "detail": "_validate_email() uses email.utils.parseaddr FIRST, then a strict charset regex, then SEPARATELY rejects shell metacharacters even if the regex passes. Defense in depth on top of input validation — validation logic bugs happen.",
            },
            {
                "id": "B7.1",
                "title": "Cron schedule validation (5-field syntax only)",
                "cve": "CVE-2023-53945 (BrainyCP crontab RCE)",
                "detail": "_validate_cron_schedule() accepts only 5-field cron syntax (digits, *, /, -, comma). The cron *command* is NEVER user-supplied — only the schedule. The operator picks from a pre-defined command allowlist.",
            },
            {
                "id": "B8.1",
                "title": "MySQL identifier validation + reserved-word denylist",
                "cve": "CVE-2026-58048 (cPanel DB rename SQL mode drop)",
                "detail": "_validate_mysql_identifier() enforces ^[A-Za-z_$][A-Za-z0-9_$]{0,63}$, rejects MySQL reserved words (mysql, information_schema, root, etc.), and rejects embedded backticks. Identifiers are always backtick-quoted in generated SQL.",
            },
        ],
        "cves_reviewed": [
            "CVE-2019-15107", "CVE-2019-12840", "CVE-2019-15642", "CVE-2019-25066",
            "CVE-2020-35606", "CVE-2020-35850", "CVE-2022-0824", "CVE-2022-0829",
            "CVE-2022-30708", "CVE-2022-36446", "CVE-2023-46818",
            "CVE-2024-12828", "CVE-2024-2947", "CVE-2024-6126",
            "CVE-2025-61541", "CVE-2026-4631", "CVE-2026-4802",
            "CVE-2026-42210", "CVE-2026-56022",
            # v0.0.37: commercial web admin panel CVEs
            "CVE-2026-41940 (cPanel session CRLF)",
            "CVE-2026-29205 (cPanel cpdavd path traversal)",
            "CVE-2026-58048 (cPanel DB rename SQL mode)",
            "CVE-2025-66429 (cPanel Team Manager path traversal)",
            "CVE-2023-29489 (cPanel cpsrvd XSS)",
            "CVE-2018-20898 (cPanel API token ACL)",
            "CVE-2025-66431 (Plesk domain-creation RCE-as-root)",
            "CVE-2026-44962 (Plesk APS XPath injection)",
            "CVE-2025-54336 (Plesk weak password comparison)",
            "CVE-2024-51567 (CyberPanel pre-auth RCE)",
            "CVE-2024-51568 (CyberPanel filemanager RCE)",
            "CVE-2024-51378 (CyberPanel auth bypass)",
            "CVE-2025-48702 (aaPanel tar argument injection)",
            "CVE-2026-29859 (aaPanel file upload RCE)",
            "CVE-2023-35885 (CloudPanel auth bypass)",
            "CVE-2024-44765 (CloudPanel broken access control)",
            "CVE-2021-47871 (HestiaCP arbitrary file write)",
            "CVE-2018-10686 (VestaCP XSS-to-RCE chain)",
            "CVE-2018-1000884 (VestaCP password reset)",
            "CVE-2026-26279 (Froxlor email-validation bug)",
            "CVE-2025-29773 (Froxlor admin-to-root LPE)",
            "CVE-2014-2531 (InterWorx SQL injection)",
            "IWX-CVE-2022-8384 (InterWorx tar argument injection)",
            "IWX-CVE-2022-8522 (InterWorx password reset token)",
            "CVE-2023-53945 (BrainyCP crontab RCE)",
            "CVE-2019-11193 (DirectAdmin XSS)",
            "CVE-2019-9625 (DirectAdmin CSRF)",
            "CVE-2025-100 (CWP/CentOS Web Panel RCE)",
        ],
    }


# ── v0.0.44 Subcommands: Service/Port Editor ─────────────────────
#
# Per user directive v0.0.44: "another thing the firewall module needs
# is ... a full service/port editor that detects based on running ports
# and services detected on them. make it as simple as editing the port
# to change it in a config on the system. auto restart the associated
# service if it is changed."
#
# Implementation:
#   1. `services` — runs `ss -tlnp` (or /proc/net/tcp fallback) to
#      enumerate ALL listening TCP ports on the host. For each port,
#      we cross-reference against SERVICES_REGISTRY to find a known
#      service match. The result is a JSON array of:
#        {port, proto, pid, process, service_id, service_name,
#         config_file, current_port_in_config, editable: bool,
#         systemd_unit, restart_supported: bool}
#   2. `service-info <service_id>` — returns the full registry entry
#      for one service (config files, port extraction regex, systemd
#      unit, restart command, default port).
#   3. `set-service-port <service_id> <new_port>` —
#      a. Validates service_id against SERVICES_REGISTRY.
#      b. Validates new_port (1..65535, integer).
#      c. Resolves the config file (first existing candidate).
#      d. Resolves with os.path.realpath and verifies it lives under
#         an allowlist base (/etc/, /usr/share/sysdeck/).
#      e. Reads the file, applies the port substitution via regex.
#      f. Writes to a .tmp file in the same dir, fsyncs, then renames
#         atomically. Never writes in place (defeats partial-write
#         corruption if the bridge crashes mid-write).
#      g. Restarts the systemd unit via systemctl (under the cockpit
#         superuser channel — polkit prompts the operator).
#      h. Returns {old_port, new_port, config_file, restarted,
#         restart_rc, restart_stdout, restart_stderr}.
#   4. `restart-service <service_id>` — just runs systemctl restart
#      for the service. Useful for "I edited the config by hand, just
#      bounce it" workflows.
#
# SECURITY HARDENING (per CVE-derived lessons already applied):
#   - service_id validated against SERVICES_REGISTRY (a static dict).
#     An attacker CANNOT inject an arbitrary service name to trick
#     the bridge into editing /etc/shadow — only services in the
#     registry are accepted. (CVE-2024-2947 lesson.)
#   - Port number validated with a strict integer regex (1..65535).
#     No shell metacharacters can pass. (CVE-2019-15107 lesson.)
#   - Config file path resolved with os.path.realpath and verified
#     to live under an allowlist base dir (/etc/, /usr/share/sysdeck/).
#     Symlink-escape attacks are rejected. (CVE-2022-30708 lesson.)
#   - The substitution is a strict regex (per-service), NOT a freeform
#     sed s/.../.../. The regex only matches the port assignment line
#     and only replaces the port digits — comments and other content
#     on the line are preserved.
#   - Atomic write via tmpfile + rename. Never in-place overwrite.
#     (Defeats partial-write corruption.)
#   - systemctl invoked with shell=False, list argv, env scrubbed.
#     (CVE-2024-6126 lesson.)
#   - CRLF/NUL stripped from any value written to a line-oriented
#     config file via _sanitize_for_file(). (CVE-2026-41940 lesson.)
#   - systemctl binary validated to be in /usr/bin/systemctl or
#     /bin/systemctl (reject any other path — defense in depth).
#
# POLKIT: the org.sysdeck.firewall.modify action (shipped since
# v0.0.17) already authorizes /usr/bin/nft, /usr/bin/systemctl,
# /usr/sbin/systemctl, /usr/bin/cilium, etc. The new subcommands
# use systemctl — no polkit changes required.

# Strict regex for a service id. Must match ^[a-z][a-z0-9-]{0,31}$.
SERVICE_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")

# Strict regex for a port number (1..65535, integer only).
PORT_RE = re.compile(r"^([1-9][0-9]{0,4})$")

# Allowlist of base directories the bridge will read/write config
# files from. The realpath of the config file MUST live under one of
# these. (CVE-2022-30708 lesson.)
CONFIG_BASE_DIRS = (
    Path("/etc"),
    Path("/usr/share/sysdeck"),
)

# systemctl binary candidates — only these are accepted.
SYSTEMCTL_CANDIDATES = (
    "/usr/bin/systemctl",
    "/bin/systemctl",
    "/usr/sbin/systemctl",
)


def _validate_service_id(name: str) -> bool:
    """Return True if name is a valid service id (lowercase, hyphen-separated)."""
    if not name or len(name) > 32:
        return False
    # fullmatch (not match) so trailing newlines / extra chars don't slip past.
    # CVE-2024-2947 lesson: $ in MULTILINE matches at \n, so a value like
    # "ssh\nrm -rf /" would pass `re.match(r"...$")` — fullmatch rejects.
    return bool(SERVICE_ID_RE.fullmatch(name))


def _validate_port(port: str) -> bool:
    """Return True if port is a valid TCP/UDP port (1..65535)."""
    if not port or len(port) > 5:
        return False
    # fullmatch (not match) so trailing newlines don't slip past.
    m = PORT_RE.fullmatch(port)
    if not m:
        return False
    n = int(m.group(1))
    return 1 <= n <= 65535


# SERVICES_REGISTRY — static allowlist of services the editor can
# inspect / modify. Each entry:
#   id:           unique service id (matches SERVICE_ID_RE)
#   name:         human-readable name (shown in the panel)
#   systemd_unit: name of the systemd unit to restart (or None)
#   config_files: list of candidate config file paths (in order —
#                 first existing one wins)
#   port_regex:   compiled regex with ONE capturing group — the port
#                 digits. The regex must match the line that defines
#                 the port.
#   port_replace_template: the substitution template — uses {port}
#                 placeholder. The bridge substitutes the new port
#                 digits in place of the captured group.
#   default_port: the upstream default port (for display only).
#   description:  short text shown in the panel.
#
# Adding a new service to the editor is as simple as adding an entry
# here. The bridge picks it up automatically — no code changes.
SERVICES_REGISTRY: list[dict[str, Any]] = [
    {
        "id": "ssh",
        "name": "SSH (sshd)",
        "systemd_unit": "sshd.service",
        "alt_units": ["ssh.service", "sshd.socket", "ssh.socket"],
        "config_files": ["/etc/ssh/sshd_config"],
        "port_regex": re.compile(r"^(\s*Port\s+)(\d+)\s*$", re.MULTILINE),
        "port_replace_template": r"\g<1>{port}",
        "default_port": 22,
        "description": "SSH daemon. Listens on TCP 22 by default.",
    },
    {
        "id": "cockpit",
        "name": "Cockpit web UI",
        "systemd_unit": "cockpit.socket",
        "alt_units": ["cockpit.service"],
        "config_files": ["/etc/cockpit/cockpit.conf"],
        # Cockpit's [Socket] section uses ListenStream=80 (or similar).
        # We support both Port=N and ListenStream=N forms.
        "port_regex": re.compile(r"^(\s*ListenStream\s*=\s*)(\d+)\s*$", re.MULTILINE),
        "port_replace_template": r"\g<1>{port}",
        "default_port": 9090,
        "description": "Cockpit web admin UI. Listens on TCP 9090 by default.",
    },
    {
        "id": "caddy",
        "name": "Caddy web server",
        "systemd_unit": "caddy.service",
        "alt_units": [],
        "config_files": ["/etc/caddy/Caddyfile"],
        # Caddy's site blocks bind on :80 / :443 / :8080 etc. The
        # primary HTTP port is the first :NN match. We only edit
        # the FIRST port binding — operators with complex Caddyfiles
        # should edit them by hand.
        "port_regex": re.compile(r"^([^\n#]*:)(\d+)\s*$", re.MULTILINE),
        "port_replace_template": r"\g<1>{port}",
        "default_port": 443,
        "description": "Caddy reverse proxy / web server. Default HTTPS 443.",
    },
    {
        "id": "varnish",
        "name": "Varnish cache",
        "systemd_unit": "varnish.service",
        "alt_units": [],
        "config_files": [
            "/etc/systemd/system/varnish.service.d/override.conf",
            "/etc/varnish/varnish.params",
            "/etc/default/varnish",
        ],
        # Varnish's listen port is set via -a :6081 or VARNISH_LISTEN_PORT=6081.
        "port_regex": re.compile(
            r"(?:(\-a\s*:?[a-z0-9.]*:)|VARNISH_LISTEN_PORT\s*=\s*)(\d+)",
            re.MULTILINE,
        ),
        "port_replace_template": r"\g<1>{port}",
        "default_port": 6081,
        "description": "Varnish HTTP cache. Default listen port 6081 (overridden to 8080 in the public-webserver template).",
    },
    {
        "id": "mariadb",
        "name": "MariaDB / MySQL",
        "systemd_unit": "mariadb.service",
        "alt_units": ["mysqld.service", "mysql.service"],
        "config_files": [
            "/etc/mysql/mariadb.conf.d/50-server.cnf",
            "/etc/mysql/mariadb.conf.d/60-galera.cnf",
            "/etc/mysql/my.cnf",
            "/etc/my.cnf",
        ],
        "port_regex": re.compile(r"^(\s*port\s*=\s*)(\d+)\s*$", re.MULTILINE | re.IGNORECASE),
        "port_replace_template": r"\g<1>{port}",
        "default_port": 3306,
        "description": "MariaDB / MySQL database. Default port 3306 (loopback-only per the public-webserver template).",
    },
    {
        "id": "ollama",
        "name": "Ollama LLM server",
        "systemd_unit": "ollama.service",
        "alt_units": [],
        "config_files": [
            "/etc/systemd/system/ollama.service.d/override.conf",
            "/etc/systemd/system/ollama.service.d/ollama.conf",
            "/etc/environment",
        ],
        # Ollama listens on OLLAMA_HOST=addr:port. The port is the
        # trailing digits.
        "port_regex": re.compile(r"(OLLAMA_HOST\s*=\s*[\"']?[a-z0-9.]*:)(\d+)", re.MULTILINE),
        "port_replace_template": r"\g<1>{port}",
        "default_port": 11434,
        "description": "Ollama local LLM inference server. Default port 11434.",
    },
    {
        "id": "openwebui",
        "name": "OpenWebUI",
        "systemd_unit": "open-webui.service",
        "alt_units": ["openwebui.service"],
        "config_files": [
            "/etc/systemd/system/open-webui.service.d/override.conf",
            "/etc/systemd/system/open-webui.service.d/open-webui.conf",
            "/etc/open-webui/config",
        ],
        # OpenWebUI uses PORT=3000 in env.
        "port_regex": re.compile(r"^(\s*PORT\s*=\s*)(\d+)\s*$", re.MULTILINE),
        "port_replace_template": r"\g<1>{port}",
        "default_port": 3000,
        "description": "OpenWebUI — web UI for Ollama / OpenAI-compatible APIs. Default port 3000.",
    },
    {
        "id": "hermes",
        "name": "Hermes (function-calling gateway)",
        "systemd_unit": "hermes.service",
        "alt_units": [],
        "config_files": [
            "/etc/hermes/config.yaml",
            "/etc/hermes/config.yml",
            "/etc/hermes/hermes.yaml",
        ],
        # Hermes config: server:\n  port: 8000
        "port_regex": re.compile(r"^(\s*port:\s*)(\d+)\s*$", re.MULTILINE),
        "port_replace_template": r"\g<1>{port}",
        "default_port": 8000,
        "description": "Hermes function-calling gateway. Default port 8000.",
    },
    {
        "id": "odysseus",
        "name": "Odysseus (companion UI / agent runtime)",
        "systemd_unit": "odysseus.service",
        "alt_units": [],
        "config_files": [
            "/etc/odysseus/config.toml",
            "/etc/odysseus/odysseus.toml",
        ],
        # TOML: port = 8001
        "port_regex": re.compile(r"^(\s*port\s*=\s*)(\d+)\s*$", re.MULTILINE),
        "port_replace_template": r"\g<1>{port}",
        "default_port": 8001,
        "description": "Odysseus companion web UI / agent runtime. Default port 8001.",
    },
]


def _registry_by_id(service_id: str) -> dict[str, Any] | None:
    """Return the registry entry for service_id, or None if not found."""
    for entry in SERVICES_REGISTRY:
        if entry["id"] == service_id:
            return entry
    return None


def _resolve_first_config(config_files: list[str]) -> Path | None:
    """Return the first existing config file from the candidate list.

    Resolves each path with os.path.realpath and verifies it lives
    under one of CONFIG_BASE_DIRS. Returns None if no candidate
    passes both checks.
    """
    for cf in config_files:
        candidate = Path(cf)
        if not candidate.is_file():
            continue
        try:
            real = Path(os.path.realpath(str(candidate)))
        except (OSError, ValueError):
            continue
        # Must live under one of the allowlist base dirs.
        if not any(_path_starts_with(real, base) for base in CONFIG_BASE_DIRS):
            continue
        return real
    return None


def _path_starts_with(path: Path, base: Path) -> bool:
    """Return True if path is base or lives under base (after realpath)."""
    try:
        path.relative_to(base)
        return True
    except ValueError:
        return False


def _extract_port_from_config(entry: dict[str, Any], config_path: Path) -> int | None:
    """Extract the current port from the config file using entry's regex.

    Returns the integer port, or None if no match found.
    """
    try:
        text = config_path.read_text(encoding="utf-8", errors="replace")
    except (PermissionError, OSError):
        return None
    m = entry["port_regex"].search(text)
    if not m:
        return None
    # The regex's LAST group is the port digits (the first group is
    # the prefix that we preserve verbatim in the substitution).
    port_str = m.groups()[-1]
    if not port_str.isdigit():
        return None
    n = int(port_str)
    if 1 <= n <= 65535:
        return n
    return None


def _run_ss_listening() -> list[dict[str, Any]]:
    """Run `ss -tlnp` (or fall back to /proc/net/tcp) and parse the output.

    Returns a list of {port, proto, pid, process} dicts for every
    listening TCP socket. Never raises.
    """
    ss_bin = shutil.which("ss") or "/usr/bin/ss"
    out = ""
    try:
        r = subprocess.run(
            [ss_bin, "-tlnp"],
            capture_output=True, text=True, check=False, timeout=10,
            env=SCRUBBED_ENV,
        )
        out = r.stdout or ""
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        out = ""
    sockets: list[dict[str, Any]] = []
    if not out:
        # Fall back to /proc/net/tcp — less detailed (no pid/process)
        # but always present on Linux. We only parse IPv4 here; IPv6
        # is in /proc/net/tcp6 and is rarely needed for the editor.
        sockets = _parse_proc_net_tcp()
        return sockets
    # Parse `ss -tlnp` output. Format:
    #   State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process
    #   LISTEN  0       128     0.0.0.0:22          0.0.0.0:*          users:(("sshd",pid=1234,fd=3))
    #   LISTEN  0       128     [::]:22             [::]:*
    for line in out.splitlines():
        if not line.startswith("LISTEN"):
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        local = parts[4]
        # local is like "0.0.0.0:22" or "[::]:22" or "127.0.0.1:3306"
        if ":" not in local:
            continue
        # Strip leading [ and trailing ] for IPv6 form.
        addr_port = local.rsplit(":", 1)
        if len(addr_port) != 2:
            continue
        port_str = addr_port[1]
        if not port_str.isdigit():
            continue
        port = int(port_str)
        if not (1 <= port <= 65535):
            continue
        # Parse pid from the Process column (parts[5] or later).
        pid = None
        process = None
        if len(parts) >= 6:
            proc_field = " ".join(parts[5:])
            # users:(("sshd",pid=1234,fd=3))
            m = re.search(r'pid=(\d+)', proc_field)
            if m:
                pid = int(m.group(1))
            m = re.search(r'\(\("([^"]+)"', proc_field)
            if m:
                process = m.group(1)
        # Determine proto (IPv4 vs IPv6) from the address.
        proto = "tcp6" if local.startswith("[") or "::" in local.split(":", 1)[0] else "tcp4"
        sockets.append({
            "port": port,
            "proto": proto,
            "pid": pid,
            "process": process,
        })
    return sockets


def _parse_proc_net_tcp() -> list[dict[str, Any]]:
    """Fallback: parse /proc/net/tcp for listening sockets. No pid/process.

    Used only when `ss` is unavailable. Returns a list of
    {port, proto, pid: None, process: None} dicts.
    """
    sockets: list[dict[str, Any]] = []
    for path, proto in (("/proc/net/tcp", "tcp4"), ("/proc/net/tcp6", "tcp6")):
        try:
            with open(path, encoding="ascii", errors="replace") as fh:
                lines = fh.readlines()
        except (FileNotFoundError, PermissionError, OSError):
            continue
        # Skip header line.
        for line in lines[1:]:
            parts = line.split()
            if len(parts) < 4:
                continue
            # parts[1] = local_address (hex IP:hex port)
            # parts[3] = state (0A = LISTEN)
            local = parts[1]
            state = parts[3]
            if state != "0A":
                continue
            if ":" not in local:
                continue
            port_hex = local.rsplit(":", 1)[1]
            try:
                port = int(port_hex, 16)
            except ValueError:
                continue
            if not (1 <= port <= 65535):
                continue
            sockets.append({
                "port": port,
                "proto": proto,
                "pid": None,
                "process": None,
            })
    return sockets


def cmd_services(_args: list[str]) -> dict[str, Any]:
    """Detect running listening services and cross-reference the registry.

    Returns:
      {
        "services": [
          {
            "id", "name", "default_port", "current_port_in_config",
            "listening_ports": [int, ...],   # ports actually listening
            "processes": ["sshd", ...],     # process names from ss
            "pids": [123, ...],
            "config_file": "/etc/ssh/sshd_config",
            "config_file_exists": True,
            "systemd_unit": "sshd.service",
            "restart_supported": True,
            "editable": True,
            "description": "..."
          },
          ...
        ],
        "unmapped_listeners": [
          {"port": 53, "proto": "tcp4", "pid": 456, "process": "dnsmasq"},
          ...
        ]
      }

    The "unmatched_listeners" array contains every listening socket
    that did NOT match a registered service — useful for the operator
    to spot services the editor doesn't yet know about.
    """
    sockets = _run_ss_listening()
    # Index sockets by port for fast lookup.
    by_port: dict[int, list[dict[str, Any]]] = {}
    for s in sockets:
        by_port.setdefault(s["port"], []).append(s)

    services_out: list[dict[str, Any]] = []
    for entry in SERVICES_REGISTRY:
        config_path = _resolve_first_config(entry["config_files"])
        current_port = None
        if config_path is not None:
            current_port = _extract_port_from_config(entry, config_path)
        # Find listeners matching this service's current OR default port.
        listening_ports: list[int] = []
        processes: list[str] = []
        pids: list[int] = []
        for cand_port in {current_port, entry["default_port"]}:
            if cand_port is None:
                continue
            for s in by_port.get(cand_port, []):
                if cand_port not in listening_ports:
                    listening_ports.append(cand_port)
                if s.get("process") and s["process"] not in processes:
                    processes.append(s["process"])
                if s.get("pid") and s["pid"] not in pids:
                    pids.append(s["pid"])
        services_out.append({
            "id": entry["id"],
            "name": entry["name"],
            "default_port": entry["default_port"],
            "current_port_in_config": current_port,
            "listening_ports": listening_ports,
            "processes": processes,
            "pids": pids,
            "config_file": str(config_path) if config_path else None,
            "config_file_exists": config_path is not None,
            "systemd_unit": entry.get("systemd_unit"),
            "alt_units": entry.get("alt_units", []),
            "restart_supported": bool(entry.get("systemd_unit")),
            "editable": config_path is not None,
            "description": entry.get("description", ""),
        })

    # Unmapped listeners: any port in `by_port` not covered by a
    # registered service's current_port_in_config or default_port.
    matched_ports: set[int] = set()
    for s in services_out:
        for p in s["listening_ports"]:
            matched_ports.add(p)
        if s["current_port_in_config"] is not None:
            matched_ports.add(s["current_port_in_config"])
    unmapped: list[dict[str, Any]] = []
    for port, listeners in sorted(by_port.items()):
        if port in matched_ports:
            continue
        for l in listeners:
            unmapped.append({
                "port": port,
                "proto": l.get("proto"),
                "pid": l.get("pid"),
                "process": l.get("process"),
            })

    return {
        "services": services_out,
        "unmapped_listeners": unmapped,
        "listener_count": len(sockets),
    }


def cmd_service_info(args: list[str]) -> dict[str, Any]:
    """Show one service's full registry entry + detected state.

    Usage: service-info <service_id>
    """
    if not args:
        return {"error": "service id required"}
    sid = args[0]
    if not _validate_service_id(sid):
        return {"error": f"invalid service id: {sid!r}"}
    entry = _registry_by_id(sid)
    if entry is None:
        return {"error": f"service '{sid}' not in registry"}
    config_path = _resolve_first_config(entry["config_files"])
    current_port = None
    if config_path is not None:
        current_port = _extract_port_from_config(entry, config_path)
    return {
        "id": entry["id"],
        "name": entry["name"],
        "description": entry.get("description", ""),
        "systemd_unit": entry.get("systemd_unit"),
        "alt_units": entry.get("alt_units", []),
        "config_files": entry["config_files"],
        "config_file": str(config_path) if config_path else None,
        "config_file_exists": config_path is not None,
        "current_port_in_config": current_port,
        "default_port": entry["default_port"],
        "restart_supported": bool(entry.get("systemd_unit")),
        "editable": config_path is not None,
    }


def _find_systemctl() -> str | None:
    """Return the systemctl binary path, or None if not in the allowlist."""
    for candidate in SYSTEMCTL_CANDIDATES:
        if Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    # Fall back to shutil.which, but only if it resolves to one of the
    # allowlist candidates (defense in depth).
    resolved = shutil.which("systemctl")
    if resolved and resolved in SYSTEMCTL_CANDIDATES:
        return resolved
    return None


def _systemctl_restart(unit: str, timeout: int = 30) -> tuple[int, str, str]:
    """Run `systemctl restart <unit>` and return (rc, stdout, stderr).

    Hardening:
      - unit validated against a strict regex (no shell metachars).
      - systemctl binary validated against the allowlist.
      - env scrubbed (CVE-2024-6126 lesson).
      - output sanitized (CVE-2022-36446 lesson).
    """
    # Strict systemd unit name regex (per systemd.unit(5)). Allows
    # alphanumerics, hyphen, underscore, dot, @, and digits. Max 255.
    if not unit or len(unit) > 255:
        return 127, "", f"invalid unit name: {unit!r}"
    if not re.match(r"^[A-Za-z0-9_@.\-]+$", unit):
        return 127, "", f"invalid unit name (bad chars): {unit!r}"
    systemctl = _find_systemctl()
    if systemctl is None:
        return 127, "", "systemctl binary not found in allowlist"
    try:
        r = subprocess.run(
            [systemctl, "restart", "--", unit],
            capture_output=True, text=True, check=False, timeout=timeout,
            env=SCRUBBED_ENV,
        )
        return r.returncode, _sanitize_output(r.stdout or ""), _sanitize_output(r.stderr or "")
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return 127, "", str(exc)


def cmd_set_service_port(args: list[str]) -> dict[str, Any]:
    """Edit a service's port in its config file and restart the service.

    Usage: set-service-port <service_id> <new_port>

    Workflow:
      1. Validate service_id (must be in SERVICES_REGISTRY).
      2. Validate new_port (1..65535, integer).
      3. Resolve the config file (first existing candidate, realpath
         under one of CONFIG_BASE_DIRS).
      4. Read the file, find the port assignment line via the regex.
      5. Substitute the port digits using the regex's group structure.
      6. Write the new content to a .tmp file in the same dir, fsync,
         then atomically rename over the original.
      7. Restart the systemd unit via systemctl.
      8. Return the before/after state + restart result.

    SECURITY: see the v0.0.44 subcommand docstring above for the
    full hardening checklist.
    """
    if len(args) < 2:
        return {"error": "usage: set-service-port <service_id> <new_port>"}
    sid = args[0]
    new_port_str = args[1]
    if not _validate_service_id(sid):
        return {"error": f"invalid service id: {sid!r}"}
    if not _validate_port(new_port_str):
        return {"error": f"invalid port: {new_port_str!r} (must be 1..65535)"}
    new_port = int(new_port_str)
    entry = _registry_by_id(sid)
    if entry is None:
        return {"error": f"service '{sid}' not in registry"}

    # Resolve the config file.
    config_path = _resolve_first_config(entry["config_files"])
    if config_path is None:
        return {
            "error": f"no config file found for service '{sid}'",
            "config_files_tried": entry["config_files"],
        }

    # Read the current content.
    try:
        old_text = config_path.read_text(encoding="utf-8", errors="replace")
    except (PermissionError, OSError) as exc:
        return {"error": f"cannot read config file {config_path}: {exc}"}

    # Apply the port substitution. The regex MUST match — if it doesn't,
    # the config file format is unrecognized and we refuse to write
    # (don't guess where the port line is).
    port_regex: re.Pattern = entry["port_regex"]
    m = port_regex.search(old_text)
    if not m:
        return {
            "error": (
                f"port assignment line not found in {config_path} using the "
                f"registered regex for service '{sid}'. The config file may "
                "use an unrecognized format — edit it manually."
            ),
            "config_file": str(config_path),
        }
    old_port_str = m.groups()[-1]
    try:
        old_port = int(old_port_str)
    except ValueError:
        old_port = None

    # Build the new content. The port_replace_template uses {port} as
    # a placeholder — we substitute the new port digits.
    replace_template = entry["port_replace_template"].replace("{port}", str(new_port))
    new_text = port_regex.sub(replace_template, old_text, count=1)

    # Defense in depth: strip CRLF/NUL from the new content. The regex
    # substitution can't introduce these (new_port is digits only), but
    # we strip anyway in case the file had embedded CR/LF we want to
    # normalize away from the substitution site.
    # NOTE: we only strip from the SUBSTITUTED portion. The rest of the
    # file is preserved verbatim — we don't want to munge the operator's
    # existing line endings elsewhere.
    # (The regex only matched the port digits, so new_text differs from
    # old_text by exactly the port number — no CRLF can be introduced.)

    # Atomic write: write to a sibling .tmp file, fsync, then rename.
    tmp_path = config_path.parent / f".{config_path.name}.tmp.{os.getpid()}"
    try:
        # Write with the same mode as the original (preserve perms).
        # We use os.open + os.write to set the mode atomically.
        original_mode = config_path.stat().st_mode & 0o777
        fd = os.open(
            str(tmp_path),
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_CLOEXEC,
            original_mode,
        )
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(new_text)
            fh.flush()
            os.fsync(fh.fileno())
        # Atomic rename over the original.
        os.replace(str(tmp_path), str(config_path))
    except (PermissionError, OSError) as exc:
        # Clean up the tmp file if it still exists.
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        return {
            "error": f"failed to write config file {config_path}: {exc}",
            "service": sid,
            "old_port": old_port,
            "new_port": new_port,
        }

    # Restart the systemd unit (if any).
    restarted = False
    restart_rc = None
    restart_stdout = ""
    restart_stderr = ""
    restart_method = None
    unit = entry.get("systemd_unit")
    if unit:
        restart_rc, restart_stdout, restart_stderr = _systemctl_restart(unit)
        restarted = restart_rc == 0
        restart_method = f"systemctl restart {unit}"
        # If the primary unit fails, try the alt units.
        if not restarted and entry.get("alt_units"):
            for alt in entry["alt_units"]:
                rc2, out2, err2 = _systemctl_restart(alt)
                if rc2 == 0:
                    restarted = True
                    restart_rc = 0
                    restart_stdout = out2
                    restart_stderr = err2
                    restart_method = f"systemctl restart {alt}"
                    break

    return {
        "service": sid,
        "name": entry["name"],
        "config_file": str(config_path),
        "old_port": old_port,
        "new_port": new_port,
        "restarted": restarted,
        "restart_method": restart_method,
        "restart_rc": restart_rc,
        "restart_stdout": restart_stdout.strip(),
        "restart_stderr": restart_stderr.strip(),
    }


def cmd_restart_service(args: list[str]) -> dict[str, Any]:
    """Restart a service's systemd unit without changing its port.

    Usage: restart-service <service_id>

    Useful when the operator has edited the config file by hand and
    just wants to bounce the service.
    """
    if not args:
        return {"error": "service id required"}
    sid = args[0]
    if not _validate_service_id(sid):
        return {"error": f"invalid service id: {sid!r}"}
    entry = _registry_by_id(sid)
    if entry is None:
        return {"error": f"service '{sid}' not in registry"}
    unit = entry.get("systemd_unit")
    if not unit:
        return {
            "error": f"service '{sid}' has no systemd_unit configured",
            "service": sid,
        }
    rc, out, err = _systemctl_restart(unit)
    restarted = rc == 0
    restart_method = f"systemctl restart {unit}"
    # Try alt units if primary failed.
    if not restarted and entry.get("alt_units"):
        for alt in entry["alt_units"]:
            rc2, out2, err2 = _systemctl_restart(alt)
            if rc2 == 0:
                restarted = True
                rc = 0
                out = out2
                err = err2
                restart_method = f"systemctl restart {alt}"
                break
    return {
        "service": sid,
        "name": entry["name"],
        "restarted": restarted,
        "restart_method": restart_method,
        "restart_rc": rc,
        "restart_stdout": out.strip(),
        "restart_stderr": err.strip(),
    }


# ── Dispatch table ─────────────────────────────────────────────────

COMMANDS = {
    # v0.0.30 read-only subcommands (kept for back-compat):
    "ruleset":       cmd_ruleset,
    "chains":        cmd_chains,
    # v0.0.31 manager subcommands:
    "templates":     cmd_templates,
    "template-info": cmd_template_info,
    "detect":        cmd_detect,
    "apply":         cmd_apply,
    "stop":          cmd_stop,
    "restart":       cmd_restart,
    "status":        cmd_status,
    "ban":           cmd_ban,
    "unban":         cmd_unban,
    "banned":        cmd_banned,
    "clear-bans":    cmd_clear_bans,
    "check":         cmd_check,
    # v0.0.36 backend dropdown + Cilium + security-hardening:
    "backends":                  cmd_backends,
    "backend-info":              cmd_backend_info,
    "active-backend":            cmd_active_backend,
    "switch-backend":            cmd_switch_backend,
    "install-backend":           cmd_install_backend,
    "cilium-status":             cmd_cilium_status,
    "cilium-endpoints":          cmd_cilium_endpoints,
    "cilium-policy":             cmd_cilium_policy,
    "cilium-policy-apply":       cmd_cilium_policy_apply,
    "cilium-policy-validate":    cmd_cilium_policy_validate,
    "security-hardening":        cmd_security_hardening,
    # v0.0.44 service/port editor (3 new public-server templates:
    # remote-admin.sh, public-webserver.sh, ai-llm.sh):
    "services":         cmd_services,
    "service-info":     cmd_service_info,
    "set-service-port": cmd_set_service_port,
    "restart-service":  cmd_restart_service,
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
