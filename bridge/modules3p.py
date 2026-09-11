#!/usr/bin/env python3
"""
SysDeck - Third-Party Cockpit Modules Bridge (modules3p)
Author: Jeremy Anderson (https://dcos.net)

Catalog-driven installer for third-party Cockpit modules. Each entry
in the catalog declares its license, author, source URL, and an
install hook (git clone, deb extract, or native pacman). The
front-end (sysdeck-modules plugin) renders the catalog inline — each
row shows the license, developer, source URL, and homepage link
right next to a 1-click Install button. Clicking Install IS the
operator's acceptance of the inline-displayed license.

Design rules (per v0.0.46 directive):
  1. The catalog is the single source of truth — no per-module code
     branches. Adding a module = appending a dict to CATALOG.
  2. No pulls are executed without an explicit install call from
     the front-end. There is no bulk "install all".
  3. Every install / uninstall is appended to
     /etc/cockpit/MODULE_LICENSES.log as a JSON record.
  4. The suite (MIT) and every catalog entry remain independent
     programs. The suite invokes git/curl/pacman/tar as separate
     subprocesses. No third-party code is ever bundled into the
     SysDeck tarball; nothing is imported at Python import time.
  5. The bridge refuses silent installs (no --accept-license=1 ⇒
     license-not-accepted). The JS always passes that flag because
     the license is rendered inline next to the Install button —
     the click IS the acceptance gesture.

Usage:
    python3 /usr/lib/sysdeck/bridge/modules3p.py catalog
    python3 /usr/lib/sysdeck/bridge/modules3p.py status
    python3 /usr/lib/sysdeck/bridge/modules3p.py preflight <id>
    python3 /usr/lib/sysdeck/bridge/modules3p.py install <id> [--accept-license]
    python3 /usr/lib/sysdeck/bridge/modules3p.py uninstall <id>
    python3 /usr/lib/sysdeck/bridge/modules3p.py audit
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Callable


# ── Constants ─────────────────────────────────────────────────────────────────

COCKPIT_DIR = "/usr/share/cockpit"
AUDIT_LOG = "/etc/cockpit/MODULE_LICENSES.log"
BRIDGE_VERSION = "0.0.46"


# ── Catalog (single source of truth) ────────────────────────────────────────
#
# Each entry MUST declare: id, name, blurb, license, author, source, kind,
# install_spec. `kind` is one of:
#
#   "pacman"   — install_spec: {"pkg": "<pacman-name>"}
#   "git"      — install_spec: {"repo": "<url>", "dest": "<relative-path-under-COCKPIT_DIR>"}
#   "deb-tar"  — install_spec: {"url": "<deb-url>", "dest": "<relative-path-under-COCKPIT_DIR>"}
#   "tarball"  — install_spec: {"url": "<tarball-url>", "dest": "<relative-path-under-COCKPIT_DIR>", "strip": <int>}
#
# Optional fields: homepage (defaults to source), category (for grouping
# in the UI), depends (list of CLI tools that must exist on PATH),
# conflicts (list of catalog ids that should not be co-installed).

CATALOG: list[dict[str, Any]] = [
    # ── Cockpit Project upstream (LGPL-2.1) ──────────────────────────────
    {
        "id": "cockpit-machines",
        "name": "Cockpit Machines",
        "blurb": "Official libvirt/QEMU virtual machine manager.",
        "license": "LGPL-2.1",
        "author": "Cockpit Project",
        "source": "https://github.com/cockpit-project/cockpit-machines",
        "category": "Virtualization",
        "kind": "pacman",
        "install_spec": {"pkg": "cockpit-machines"},
        "depends": ["libvirtd"],
    },
    {
        "id": "cockpit-podman",
        "name": "Cockpit Podman",
        "blurb": "Official Podman container management UI.",
        "license": "LGPL-2.1",
        "author": "Cockpit Project",
        "source": "https://github.com/cockpit-project/cockpit-podman",
        "category": "Containers",
        "kind": "pacman",
        "install_spec": {"pkg": "cockpit-podman"},
        "depends": ["podman"],
    },
    {
        "id": "cockpit-storaged",
        "name": "Cockpit Storaged",
        "blurb": "Official storage (udisks) management UI.",
        "license": "LGPL-2.1",
        "author": "Cockpit Project",
        "source": "https://github.com/cockpit-project/cockpit-storaged",
        "category": "Storage",
        "kind": "pacman",
        "install_spec": {"pkg": "cockpit-storaged"},
        "depends": ["udisksd"],
    },
    {
        "id": "cockpit-identities",
        "name": "Cockpit Identities",
        "blurb": "Official SSH/PKCS#11/Kerberos identity panel.",
        "license": "LGPL-2.1",
        "author": "Cockpit Project",
        "source": "https://github.com/cockpit-project/cockpit-identities",
        "category": "Identity",
        "kind": "git",
        "install_spec": {
            "repo": "https://github.com/cockpit-project/cockpit-identities.git",
            "dest": "identities",
        },
        "depends": ["ssh-add"],
    },

    # ── 45Drives storage stack (GPL-3.0) ────────────────────────────────
    {
        "id": "cockpit-navigator",
        "name": "45Drives Navigator",
        "blurb": "Web file browser for the cockpit user.",
        "license": "GPL-3.0",
        "author": "45Drives",
        "source": "https://github.com/45Drives/cockpit-navigator",
        "category": "Storage / Files",
        "kind": "deb-tar",
        "install_spec": {
            "url": "https://github.com/45Drives/cockpit-navigator/releases/download/v3.1.0/cockpit-navigator_3.1.0-1focal_all.deb",
            "dest": "navigator",
        },
    },
    {
        "id": "cockpit-file-sharing",
        "name": "45Drives File Sharing",
        "blurb": "Samba / NFS share management UI.",
        "license": "GPL-3.0",
        "author": "45Drives",
        "source": "https://github.com/45Drives/cockpit-file-sharing",
        "category": "Storage / Files",
        "kind": "deb-tar",
        "install_spec": {
            "url": "https://github.com/45Drives/cockpit-file-sharing/releases/download/v3.3.4/cockpit-file-sharing_3.3.4-1focal_all.deb",
            "dest": "file-sharing",
        },
        "depends": ["smbd", "exportfs"],
    },
    {
        "id": "cockpit-zfs-manager",
        "name": "45Drives ZFS Manager",
        "blurb": "OpenZFS pool, dataset, and snapshot UI.",
        "license": "GPL-3.0",
        "author": "45Drives",
        "source": "https://github.com/45Drives/cockpit-zfs-manager",
        "category": "Storage / ZFS",
        "kind": "git",
        "install_spec": {
            "repo": "https://github.com/45Drives/cockpit-zfs-manager.git",
            "dest": "zfs-manager",
        },
        "depends": ["zpool"],
    },

    # ── Community modules (MIT / GPL-3.0) ──────────────────────────────
    {
        "id": "cockpit-pacman",
        "name": "cockpit-pacman",
        "blurb": "ALPM/pacman WebUI for Arch Linux hosts.",
        "license": "GPL-3.0",
        "author": "pfeifferj",
        "source": "https://github.com/pfeifferj/cockpit-pacman",
        "category": "Package Management",
        "kind": "git",
        "install_spec": {
            "repo": "https://github.com/pfeifferj/cockpit-pacman.git",
            "dest": "pacman",
        },
        "depends": ["pacman"],
    },
    {
        "id": "cockpit-sensors",
        "name": "cockpit-sensors",
        "blurb": "Standalone lm_sensors reader (ocristopfer). "
                 "SysDeck already ships a built-in sensors panel; this is the "
                 "upstream reference if you prefer its layout.",
        "license": "MIT",
        "author": "ocristopfer",
        "source": "https://github.com/ocristopfer/cockpit-sensors",
        "category": "Hardware",
        "kind": "tarball",
        "install_spec": {
            "url": "https://github.com/ocristopfer/cockpit-sensors/releases/latest/download/cockpit-sensors.tar.xz",
            "dest": "sensors",
            "strip": 1,
        },
        "depends": ["sensors"],
    },
    {
        "id": "cockpit-benchmark",
        "name": "cockpit-benchmark",
        "blurb": "sysbench / fio / iperf3 wrapper UI (ealier). "
                 "SysDeck already ships a built-in benchmark panel; this is the "
                 "upstream reference if you prefer its layout.",
        "license": "MIT",
        "author": "ealier",
        "source": "https://github.com/ealier/cockpit-benchmark",
        "category": "Benchmarking",
        "kind": "git",
        "install_spec": {
            "repo": "https://github.com/ealier/cockpit-benchmark.git",
            "dest": "benchmark",
        },
        "depends": ["sysbench"],
    },
]


# ── Dataclass wrapper for typed access ───────────────────────────────────────

@dataclass
class CatalogEntry:
    id: str
    name: str
    blurb: str
    license: str
    author: str
    source: str
    category: str
    kind: str
    install_spec: dict[str, Any]
    depends: list[str] = field(default_factory=list)
    homepage: str = ""

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "CatalogEntry":
        return cls(
            id=d["id"],
            name=d["name"],
            blurb=d["blurb"],
            license=d["license"],
            author=d["author"],
            source=d["source"],
            category=d.get("category", "Uncategorized"),
            kind=d["kind"],
            install_spec=d["install_spec"],
            depends=list(d.get("depends", [])),
            homepage=d.get("homepage", d["source"]),
        )

    def to_public_dict(self) -> dict[str, Any]:
        return asdict(self)


def catalog_entries() -> list[CatalogEntry]:
    return [CatalogEntry.from_dict(e) for e in CATALOG]


def find_entry(entry_id: str) -> CatalogEntry | None:
    for e in catalog_entries():
        if e.id == entry_id:
            return e
    return None


# ── Install-state probe ──────────────────────────────────────────────────────
#
# A module is "installed" if its destination directory exists under
# /usr/share/cockpit/. For pacman entries we additionally check `pacman -Q`
# so that distro-managed installs are reported correctly even when the
# destination dir is empty.

def _dest_path(entry: CatalogEntry) -> str:
    spec = entry.install_spec
    rel = spec.get("dest") or entry.id
    return os.path.join(COCKPIT_DIR, rel)


def _pacman_has(pkg: str) -> bool:
    # `pacman` may be absent on non-Arch hosts (Debian, Fedora, dev boxes).
    # Treat missing pacman as "not installed via pacman" rather than crashing.
    if shutil.which("pacman") is None:
        return False
    r = subprocess.run(["pacman", "-Q", pkg], capture_output=True, text=True)
    return r.returncode == 0


def is_installed(entry: CatalogEntry) -> bool:
    if entry.kind == "pacman":
        return _pacman_has(entry.install_spec["pkg"])
    return os.path.isdir(_dest_path(entry)) and \
        bool(os.listdir(_dest_path(entry)))


def missing_deps(entry: CatalogEntry) -> list[str]:
    """Return the subset of `depends` CLI tools missing from PATH."""
    out: list[str] = []
    for dep in entry.depends:
        if shutil.which(dep) is None:
            # allow the kernel-builtin or service-style deps
            # (e.g. smbd may live in /usr/sbin but not in PATH for the
            # cockpit user) — re-check via systemctl is-active. If
            # systemctl itself is unavailable (container / non-systemd
            # host), treat the dep as missing rather than crashing.
            if shutil.which("systemctl") is None:
                out.append(dep)
                continue
            r = subprocess.run(
                ["systemctl", "is-active", "--quiet", dep],
                capture_output=True,
            )
            if r.returncode != 0:
                out.append(dep)
    return out


# ── Preflight (called BEFORE install) ────────────────────────────────────────
#
# Returns the full disclosure bundle: license, author, source URL,
# install plan (the exact commands that will run), missing deps, and
# a `credit_line` that the front-end can paste into a tooltip / banner.
#
# The 1-click UI doesn't strictly need this — the row already shows
# everything inline — but it's exposed for headless inspection and
# for the smoke-test suite.

def preflight(entry_id: str) -> dict[str, Any]:
    entry = find_entry(entry_id)
    if entry is None:
        return {"ok": False, "error": f"unknown module id: {entry_id}"}

    plan = _install_plan(entry)
    already = is_installed(entry)
    missing = missing_deps(entry)

    return {
        "ok": True,
        "id": entry.id,
        "name": entry.name,
        "blurb": entry.blurb,
        "license": entry.license,
        "author": entry.author,
        "source": entry.source,
        "homepage": entry.homepage or entry.source,
        "category": entry.category,
        "already_installed": already,
        "missing_deps": missing,
        "install_plan": plan,
        "credit_line": (
            f"Module: {entry.name}\n"
            f"License: {entry.license}\n"
            f"Author: {entry.author}\n"
            f"Source: {entry.source}\n"
            f"Install plan:\n  " + "\n  ".join(plan)
        ),
    }


def _install_plan(entry: CatalogEntry) -> list[str]:
    spec = entry.install_spec
    if entry.kind == "pacman":
        return [f"pacman -S --noconfirm --needed {spec['pkg']}"]
    if entry.kind == "git":
        return [
            f"git clone --depth 1 {spec['repo']} "
            f"{_dest_path(entry)}",
        ]
    if entry.kind == "deb-tar":
        return [
            f"curl -fsSL {spec['url']} -o /tmp/<file>.deb",
            f"bsdtar -xf /tmp/<file>.deb -C /tmp/<extract>",
            f"tar -xf /tmp/<extract>/data.tar.xz "
            f"-C {COCKPIT_DIR}/{spec['dest']} --strip-components=4",
            "rm -rf /tmp/<file>.deb /tmp/<extract>",
        ]
    if entry.kind == "tarball":
        strip = spec.get("strip", 1)
        return [
            f"curl -fsSL {spec['url']} -o /tmp/<file>.tar.xz",
            f"tar -xf /tmp/<file>.tar.xz -C "
            f"{_dest_path(entry)} --strip-components={strip}",
            "rm -f /tmp/<file>.tar.xz",
        ]
    return [f"<unknown kind: {entry.kind}>"]


# ── Install ──────────────────────────────────────────────────────────────────
#
# The 1-click UI always passes accept_license=True because the license
# is rendered inline next to the Install button — the click IS the
# acceptance gesture. The accept_license check remains as a guard
# against malicious callers (e.g. a different front-end that tries
# to bulk-install without operator interaction).

def install(entry_id: str, accept_license: bool = False) -> dict[str, Any]:
    entry = find_entry(entry_id)
    if entry is None:
        return {"ok": False, "error": f"unknown module id: {entry_id}"}

    if is_installed(entry):
        return {"ok": True, "id": entry.id, "status": "already-installed",
                "message": f"{entry.name} is already installed"}

    if not accept_license:
        # Refuse silent installs — this is the guard rail.
        return {
            "ok": False,
            "id": entry.id,
            "error": "license-not-accepted",
            "message": (
                "Refusing to install without explicit license acceptance. "
                "The front-end must render the license inline next to "
                "the Install button and pass acceptLicense=true on click."
            ),
        }

    try:
        os.makedirs(COCKPIT_DIR, exist_ok=True)
        if entry.kind == "pacman":
            _install_pacman(entry)
        elif entry.kind == "git":
            _install_git(entry)
        elif entry.kind == "deb-tar":
            _install_deb_tar(entry)
        elif entry.kind == "tarball":
            _install_tarball(entry)
        else:
            return {"ok": False, "error": f"unsupported kind: {entry.kind}"}
    except subprocess.CalledProcessError as e:
        _audit_append(entry, "install-failed",
                      f"rc={e.returncode} stderr={e.stderr or ''}")
        return {
            "ok": False,
            "id": entry.id,
            "error": "install-command-failed",
            "rc": e.returncode,
            "stderr": e.stderr or e.stdout or str(e),
        }
    except Exception as e:  # noqa: BLE001
        _audit_append(entry, "install-failed", str(e))
        return {"ok": False, "id": entry.id, "error": str(e)}

    _audit_append(entry, "install-ok", "installed")
    return {
        "ok": True,
        "id": entry.id,
        "status": "installed",
        "name": entry.name,
        "license": entry.license,
        "author": entry.author,
        "source": entry.source,
    }


def _install_pacman(entry: CatalogEntry) -> None:
    pkg = entry.install_spec["pkg"]
    subprocess.run(
        ["pacman", "-S", "--noconfirm", "--needed", pkg],
        check=True, capture_output=True, text=True,
    )


def _install_git(entry: CatalogEntry) -> None:
    repo = entry.install_spec["repo"]
    dest = _dest_path(entry)
    if os.path.exists(dest):
        raise RuntimeError(f"destination {dest} already exists")
    subprocess.run(
        ["git", "clone", "--depth", "1", repo, dest],
        check=True, capture_output=True, text=True,
    )


def _install_deb_tar(entry: CatalogEntry) -> None:
    spec = entry.install_spec
    dest = _dest_path(entry)
    if os.path.exists(dest):
        raise RuntimeError(f"destination {dest} already exists")
    os.makedirs(dest, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        deb = os.path.join(tmp, "pkg.deb")
        subprocess.run(
            ["curl", "-fsSL", spec["url"], "-o", deb],
            check=True, capture_output=True, text=True,
        )
        extract_dir = os.path.join(tmp, "extract")
        os.makedirs(extract_dir, exist_ok=True)
        subprocess.run(
            ["bsdtar", "-xf", deb, "-C", extract_dir],
            check=True, capture_output=True, text=True,
        )
        data_tar = os.path.join(extract_dir, "data.tar.xz")
        if not os.path.exists(data_tar):
            raise RuntimeError(
                f"deb archive {spec['url']} missing data.tar.xz"
            )
        subprocess.run(
            ["tar", "-xf", data_tar, "-C", dest, "--strip-components=4"],
            check=True, capture_output=True, text=True,
        )


def _install_tarball(entry: CatalogEntry) -> None:
    spec = entry.install_spec
    dest = _dest_path(entry)
    if os.path.exists(dest) and os.listdir(dest):
        raise RuntimeError(f"destination {dest} is not empty")
    os.makedirs(dest, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tarball = os.path.join(tmp, "pkg.tar.xz")
        subprocess.run(
            ["curl", "-fsSL", spec["url"], "-o", tarball],
            check=True, capture_output=True, text=True,
        )
        subprocess.run(
            ["tar", "-xf", tarball, "-C", dest,
             f"--strip-components={spec.get('strip', 1)}"],
            check=True, capture_output=True, text=True,
        )


# ── Uninstall ────────────────────────────────────────────────────────────────

def uninstall(entry_id: str) -> dict[str, Any]:
    entry = find_entry(entry_id)
    if entry is None:
        return {"ok": False, "error": f"unknown module id: {entry_id}"}

    if not is_installed(entry):
        return {"ok": True, "id": entry.id, "status": "not-installed"}

    try:
        if entry.kind == "pacman":
            pkg = entry.install_spec["pkg"]
            subprocess.run(
                ["pacman", "-R", "--noconfirm", pkg],
                check=True, capture_output=True, text=True,
            )
        else:
            dest = _dest_path(entry)
            shutil.rmtree(dest)
    except Exception as e:  # noqa: BLE001
        _audit_append(entry, "uninstall-failed", str(e))
        return {"ok": False, "id": entry.id, "error": str(e)}

    _audit_append(entry, "uninstall-ok", "removed")
    return {"ok": True, "id": entry.id, "status": "removed"}


# ── Audit log ────────────────────────────────────────────────────────────────
#
# Append-only JSON-lines audit log. Lives next to the legacy
# /etc/cockpit/MODULE_LICENSES.log (which cockpit-module-pull.sh
# wrote in plain text). We honor the same path so existing
# compliance tooling picks up both records.

def _audit_append(entry: CatalogEntry, action: str, detail: str) -> None:
    os.makedirs(os.path.dirname(AUDIT_LOG), exist_ok=True)
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "module": entry.id,
        "name": entry.name,
        "license": entry.license,
        "author": entry.author,
        "source": entry.source,
        "action": action,
        "detail": detail,
        "bridge_version": BRIDGE_VERSION,
    }
    with open(AUDIT_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")


def audit(limit: int = 200) -> dict[str, Any]:
    """Return the last `limit` audit records, newest last."""
    if not os.path.exists(AUDIT_LOG):
        return {"ok": True, "path": AUDIT_LOG, "records": []}
    records: list[dict[str, Any]] = []
    with open(AUDIT_LOG, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                # legacy plain-text line from cockpit-module-pull.sh — keep as raw
                records.append({"raw": line})
    return {
        "ok": True,
        "path": AUDIT_LOG,
        "records": records[-limit:] if limit > 0 else records,
    }


# ── Status (combined catalog view for the front-end) ────────────────────────

def status() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for entry in catalog_entries():
        out.append({
            "id": entry.id,
            "name": entry.name,
            "blurb": entry.blurb,
            "license": entry.license,
            "author": entry.author,
            "source": entry.source,
            "homepage": entry.homepage or entry.source,
            "category": entry.category,
            "kind": entry.kind,
            "depends": entry.depends,
            "installed": is_installed(entry),
            "missing_deps": missing_deps(entry),
        })
    return out


# ── CLI ──────────────────────────────────────────────────────────────────────

COMMANDS: dict[str, Callable[[list[str]], Any]] = {
    "catalog":  lambda _a: [e.to_public_dict() for e in catalog_entries()],
    "status":   lambda _a: status(),
    "preflight": lambda a: preflight(a[0]),
    "install":  lambda a: install(
        a[0],
        accept_license=("--accept-license" in a) or ("--accept-license=1" in a),
    ),
    "uninstall": lambda a: uninstall(a[0]),
    "audit":    lambda a: audit(int(a[0]) if a else 200),
}


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd = COMMANDS.get(argv[0])
    if not cmd:
        print(f"Unknown subcommand: {argv[0]}", file=sys.stderr)
        return 2
    result = cmd(argv[1:])
    print(json.dumps(result, indent=2, default=str))
    return 0 if (not isinstance(result, dict) or result.get("ok", True)) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
