#!/usr/bin/env python3
"""
SysDeck - Auth Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Aggregates PKCS#11 token slots (opensc) with pcscd service state,
detected reader hardware (lsusb), and first-class identity objects
(PKCS#11 tokens, SSH keys, Kerberos principals) into a single JSON
document.

The identities subcommand enumerates identity objects that can be used
for authentication. It calls ssh-add -L, pkcs11-tool, and klist as
separate processes — the suite (MIT) and each tool remain independent
programs. No external code is bundled.

cockpit-identities (https://github.com/cockpit-project/cockpit-identities)
is LGPL-2.1 licensed by the cockpit-project. The suite's identities
enumeration invokes the same underlying tools; the standalone
cockpit-identities plugin may be installed separately and linked from
the sidebar.

Usage:
    python3 -m sysdeck.bridge.auth summary
    python3 -m sysdeck.bridge.auth slots
    python3 -m sysdeck.bridge.auth readers
    python3 -m sysdeck.bridge.auth identities
    python3 -m sysdeck.bridge.auth ssh-keys
    python3 -m sysdeck.bridge.auth kerberos
"""

import json
import os
import re
import shutil
import subprocess
import sys
from typing import Any

# Scrubbed child environment: parsed output stays locale-stable and no
# console process state leaks into children.
SCRUBBED_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}

IDENTITIES_LICENSE = "LGPL-2.1 (cockpit-identities)"
IDENTITIES_AUTHOR = "cockpit-project"
IDENTITIES_URL = "https://github.com/cockpit-project/cockpit-identities"

# Slot line: "Slot 0: Alcor Micro AU9540 00 00"
SLOT_RE = re.compile(r"^Slot\s+(?P<slot>\d+):\s+(?P<desc>.+)$")

# SSH key line: "ssh-rsa AAAA... comment"
SSH_KEY_RE = re.compile(r"^(?P<type>ssh-\S+|ecdsa-\S+|sk-\S+)\s+(?P<blob>\S+)(?:\s+(?P<comment>.+))?$")

# Kerberos principal line from klist: "  user@REALM  krbtgt/REALM@REALM"
KLIST_PRINCIPAL_RE = re.compile(r"^\s*Default principal:\s+(?P<principal>\S+)")
KLIST_TICKET_RE = re.compile(r"^\s*(?P<start>\S+)\s+(?P<end>\S+)\s+(?P<renew>\S+)\s+(?P<kvno>\S+)\s+(?P<principal>\S+)")


def run(argv: list[str]) -> str:
    """Run a command, returning stdout. Returns '' on failure."""
    try:
        return subprocess.run(
            argv, capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def slots() -> list[dict[str, str]]:
    """PKCS#11 token slots from opensc."""
    raw = run(["pkcs11-tool", "--list-token-slots"])
    parsed: list[dict[str, str]] = []
    for line in raw.splitlines():
        m = SLOT_RE.match(line)
        if m:
            parsed.append({
                "slot": m.group("slot"),
                "description": m.group("desc").strip(),
            })
    return parsed


def readers() -> list[dict[str, str]]:
    """Smartcard readers detected by lsusb (vendor:product filtered)."""
    raw = run(["lsusb"])
    return [
        {"description": line.strip()}
        for line in raw.splitlines()
        if any(needle in line.lower() for needle in ("smart", "card", "reader", "pcsc"))
    ]


def certs() -> dict[str, Any]:
    """PKCS#11 objects of type cert via pkcs11-tool.

    v0.1.4: the auth panel's "List Certificates" button used to call a
    bridge.spawn() that bridge.js never exported — the button has
    always thrown. The listing now lives here (fixed argv list, no
    shell), matching every other spawn in this suite.
    """
    if not shutil.which("pkcs11-tool"):
        return {"available": False,
                "reason": "pkcs11-tool not installed (opensc)",
                "count": 0, "output": ""}
    raw = run(["pkcs11-tool", "--list-objects", "--type", "cert"])
    lines = [line for line in raw.splitlines() if line.strip()]
    return {"available": True,
            "count": sum(1 for line in lines if "Certificate" in line),
            "output": "\n".join(lines) or "(no certificates on any slot)"}


def pcscd_state() -> str:
    """pcscd.service state via systemctl."""
    raw = run(["systemctl", "is-active", "pcscd"]).strip()
    return raw or "unknown"


def ssh_keys() -> list[dict[str, Any]]:
    """SSH keys from ssh-add -L and ~/.ssh/."""
    identities: list[dict[str, Any]] = []

    # Keys loaded in the SSH agent
    raw = run(["ssh-add", "-L"])
    for line in raw.splitlines():
        m = SSH_KEY_RE.match(line)
        if m:
            key_type = m.group("type")
            # ssh-keygen -lf reads the REAL key size; unavailable keys
            # report bits: 0 rather than a per-type guess.
            bits = 0
            try:
                probe = subprocess.run(
                    ["ssh-keygen", "-lf", "/dev/stdin"],
                    input=line + "\n", capture_output=True, text=True,
                    check=False, timeout=5, env=SCRUBBED_ENV,
                )
                if probe.returncode == 0:
                    bits = int(probe.stdout.split()[0])
            except (ValueError, subprocess.TimeoutExpired, OSError):
                bits = 0
            identities.append({
                "keyType": key_type,
                "bits": bits,
                "fingerprint": m.group("blob")[:32] + "...",
                "comment": m.group("comment") or "",
                "path": "ssh-agent",
                "passphrase": False,
                "agentLoaded": True,
            })

    # Keys in ~/.ssh/ not in agent
    ssh_dir = os.path.expanduser("~/.ssh")
    if os.path.isdir(ssh_dir):
        for fname in os.listdir(ssh_dir):
            fpath = os.path.join(ssh_dir, fname)
            if (fname.endswith(".pub") or fname.startswith(".")
                    or fname in ("known_hosts", "authorized_keys", "config")):
                continue
            if os.path.isfile(fpath):
                # Heuristic: private key files don't have extensions like .pub, .old
                identities.append({
                    "keyType": "unknown",
                    "bits": 0,
                    "fingerprint": "",
                    "comment": fname,
                    "path": fpath,
                    "passphrase": True,
                    "agentLoaded": any(k["path"] == "ssh-agent" and fname in k.get("comment", "") for k in identities),
                })

    return identities


def kerberos() -> list[dict[str, Any]]:
    """Kerberos ticket-granting tickets from klist.

    Only fields klist actually reports are emitted — the panel renders
    what the host says, never a guessed key type or kvno."""
    principals: list[dict[str, Any]] = []
    raw = run(["klist"])

    default_principal = None
    for line in raw.splitlines():
        m = KLIST_PRINCIPAL_RE.match(line)
        if m:
            default_principal = m.group("principal")

    if default_principal:
        user, realm = default_principal.split("@") if "@" in default_principal else (default_principal, "")
        principals.append({
            "principal": default_principal,
            "realm": realm,
            "kdc": "",
        })

    return principals


def identities() -> dict[str, Any]:
    """Aggregate all identity objects: PKCS#11 tokens, SSH keys, Kerberos principals."""
    pkcs11_slots = slots()
    ssh = ssh_keys()
    krb = kerberos()

    all_identities: list[dict[str, Any]] = []

    # PKCS#11 tokens as identity objects
    for i, s in enumerate(pkcs11_slots):
        all_identities.append({
            "id": f"pkcs11-{i}",
            "type": "pkcs11-token",
            "name": s.get("description", f"Slot {s.get('slot', i)}"),
            "status": "active",
            "createdAt": "",
            "details": {
                "slot": int(s.get("slot", i)),
                "label": s.get("description", ""),
                "manufacturer": "",
                "model": "",
                "serial": "",
                "tokenType": "PKCS#11",
                "flags": [],
                "algorithms": [],
            },
        })

    # SSH keys as identity objects
    for i, k in enumerate(ssh):
        all_identities.append({
            "id": f"ssh-{i}",
            "type": "ssh-key",
            "name": k.get("comment") or k.get("path", f"key-{i}"),
            "status": "active" if k.get("agentLoaded") else "inactive",
            "createdAt": "",
            "details": k,
        })

    # Kerberos principals as identity objects
    for i, p in enumerate(krb):
        all_identities.append({
            "id": f"krb-{i}",
            "type": "kerberos-principal",
            "name": p.get("principal", f"principal-{i}"),
            "status": "active" if p.get("endTime") else "expired",
            "createdAt": p.get("startTime", ""),
            "expiresAt": p.get("endTime", ""),
            "details": p,
        })

    return {
        "pkcs11Tokens": len(pkcs11_slots),
        "sshKeys": len(ssh),
        "kerberosPrincipals": len(krb),
        "identities": all_identities,
    }


def summary() -> dict[str, Any]:
    """Aggregate slots + readers + pcscd state + identities."""
    return {
        "slots": slots(),
        "readers": readers(),
        "pcscdState": pcscd_state(),
        "identities": identities(),
    }


COMMANDS = {
    "summary": lambda _args: summary(),
    "slots": lambda _args: slots(),
    "readers": lambda _args: readers(),
    "certs": lambda _args: certs(),
    "identities": lambda _args: identities(),
    "ssh-keys": lambda _args: ssh_keys(),
    "kerberos": lambda _args: kerberos(),
}


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd = COMMANDS.get(argv[0])
    if not cmd:
        print(f"Unknown subcommand: {argv[0]}", file=sys.stderr)
        return 2
    print(json.dumps(cmd(argv[1:]), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
