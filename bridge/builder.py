#!/usr/bin/env python3
"""
SysDeck - Image Builder Bridge Helper
Author: Jeremy Anderson (https://dcos.net)

Surfaces the system image-builder backend(s) actually installed on this
host and returns a unified JSON interface so the Builder panel can list
available build profiles / image specs without knowing which tool the
operator picked.

v0.0.30 REWRITE: the previous version was a thin `systemctl is-active
osbuild-composer.service` shim — which is Fedora/RHEL-only and silently
returns 'inactive' on Arch and Debian. Per the user's directive, the
target distros are now Arch Linux and Debian:

  - Arch Linux  → mkosi     (systemd's own image builder; pacman -S mkosi)
                 ↘ archiso  (Arch Live ISO builder; pacman -S archiso)
  - Debian      → vmdb2     (Debian project's image builder; apt install vmdb2)
                 ↘ live-build (Debian Live ISO builder; apt install live-build)

Fedora/RHEL (osbuild-composer / composer-cli) is no longer targeted.
osbuild-composer is not packaged for Arch or Debian, so the v0.0.29
panel was permanently 'inactive' on every distro this suite ships to.
mkosi and vmdb2 are the canonical equivalents and are invoked as
separate processes via subprocess — the suite (MIT) and the image
builders remain independent programs. No builder code is bundled.

The detected builder(s) determine which profile/spec discovery
functions are used. Multiple backends may coexist on a host (e.g. an
Arch box that has both mkosi and archiso installed); the panel surfaces
each backend's profiles grouped under that backend.

Usage:
    python3 /usr/lib/sysdeck/bridge/builder.py status
    python3 /usr/lib/sysdeck/bridge/builder.py profiles
    python3 /usr/lib/sysdeck/bridge/builder.py summary
    python3 /usr/lib/sysdeck/bridge/builder.py backends
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


# ── Backend discovery ────────────────────────────────────────────────
#
# Each candidate backend is a tuple of (backend_id, binary_name,
# version_args, kind). We probe via shutil.which() — that respects PATH
# and works uniformly on Arch/Debian without invoking the binary. The
# os-release–based DISTRO constant from bridge/__init__.py is used only
# as a hint for the install_cmd hint strings returned to the UI; the
# which() check is authoritative (a user may have mkosi installed on
# Debian, or vmdb2 installed on Arch — both work fine).
#
# Order matters for the panel's "primary backend" choice: mkosi is
# preferred on Arch, vmdb2 is preferred on Debian. If both are present,
# the one matching the host's distro wins as primary.

CANDIDATES = [
    # backend_id, binary, version-args, kind, distro_hint
    ("mkosi",      "mkosi",      ["--version"], "image", "arch"),
    ("vmdb2",      "vmdb2",      ["--version"], "image", "debian"),
    ("archiso",    "mkarchiso",  ["--version"], "iso",   "arch"),
    ("live-build", "lb",         ["--version"], "iso",   "debian"),
]


def _detect_backends() -> list[dict[str, Any]]:
    """Return the list of installed image-builder backends.

    Each entry: {id, binary, version, kind, path}. `version` is the
    trimmed first line of `<binary> --version` output, or '' if the
    binary rejected the flag (some tools print to stderr). `path` is
    the absolute path resolved by shutil.which().
    """
    found: list[dict[str, Any]] = []
    for backend_id, binary, vargs, kind, _hint in CANDIDATES:
        resolved = shutil.which(binary)
        if not resolved:
            continue
        version = _try_version(resolved, vargs)
        found.append({
            "id": backend_id,
            "binary": binary,
            "path": resolved,
            "version": version,
            "kind": kind,
        })
    return found


def _try_version(path: str, args: list[str]) -> str:
    """Run `<path> <args>` and return the trimmed first line of stdout
    or stderr. Returns '' on any failure (binary missing flag,
    non-zero exit, etc.) — never raises."""
    try:
        r = subprocess.run(
            [path, *args],
            capture_output=True, text=True, check=False, timeout=5,
        )
        out = (r.stdout or r.stderr or "").strip()
        # First non-empty line — version strings like "mkosi 22" or
        # "vmdb2 0.1.0" tend to be the first line.
        for line in out.splitlines():
            line = line.strip()
            if line:
                return line
        return ""
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return ""


BACKENDS: list[dict[str, Any]] = _detect_backends()


def _primary_backend() -> dict[str, Any] | None:
    """Pick the primary backend for this host.

    Preference order:
      1. Backend whose distro_hint matches the host distro (mkosi on
         Arch, vmdb2 on Debian).
      2. First installed backend of kind='image' (a real image builder
         beats an ISO-only tool like archiso / live-build).
      3. First installed backend of any kind.
      4. None.
    """
    if not BACKENDS:
        return None

    # Match host distro against each candidate's hint.
    try:
        # Local import to avoid a hard dependency on the bridge package
        # being importable (builder.py is invoked as a standalone script).
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from __init__ import DISTRO  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001 — fallback to 'unknown'
        DISTRO = "unknown"

    for hint in ("arch", "debian"):
        if DISTRO == hint:
            for b in BACKENDS:
                # Find candidate's hint
                for cid, _bin, _vargs, _kind, chint in CANDIDATES:
                    if cid == b["id"] and chint == hint:
                        return b

    for b in BACKENDS:
        if b["kind"] == "image":
            return b

    return BACKENDS[0]


# ── Profile / spec discovery ────────────────────────────────────────
#
# Each backend stores its build profiles in well-known locations:
#
#   mkosi:
#     - /etc/mkosi/mkosi.conf                (single profile)
#     - /etc/mkosi/mkosi.conf.d/*.conf       (drop-in fragments)
#     - /etc/mkosi/mkosi.profiles/*.profile  (named profiles, mkosi v22+)
#     - any directory containing a `mkosi.conf` (project-local)
#     Walked dirs: /etc/mkosi/, /usr/share/mkosi/, ~/.config/mkosi/
#
#   archiso:
#     - /usr/share/archiso/configs/<name>/    (shipped profiles: baseline, releng)
#     - /etc/archiso/configs/<name>/          (operator-defined overrides)
#
#   vmdb2:
#     - /etc/vmdb2/*.yaml / *.yml             (system specs)
#     - /usr/share/vmdb2/specs/*.yaml         (shipped examples)
#     - ~/.config/vmdb2/*.yaml                (per-user specs)
#
#   live-build:
#     - any directory containing a `config/` subdir built by `lb config`
#     - Walked dirs: /var/cache/live-build/, /usr/share/live-build/,
#                    /etc/live-build/, ~/.config/live-build/

MKOSI_DIRS = [
    # v0.1.0: per-profile directories under /etc/mkosi/profiles/<name>/
    # are the primary location. Each profile gets its own directory
    # containing a real `mkosi.conf` (the only filename mkosi reads
    # automatically from the cwd). v0.0.50 wrote drop-in fragments
    # to /etc/mkosi/mkosi.conf.d/<name>.conf, which mkosi silently
    # ignores unless a parent /etc/mkosi/mkosi.conf exists to layer
    # them onto — so every v0.0.x build ran with empty defaults.
    Path("/etc/mkosi/profiles"),
    Path("/etc/mkosi"),
    Path("/usr/share/mkosi"),
    Path.home() / ".config" / "mkosi",
]
ARCHISO_DIRS = [
    Path("/usr/share/archiso/configs"),
    Path("/etc/archiso/configs"),
]
VMDB2_DIRS = [
    Path("/etc/vmdb2"),
    Path("/usr/share/vmdb2/specs"),
    Path.home() / ".config" / "vmdb2",
]
LIVE_BUILD_DIRS = [
    Path("/etc/live-build"),
    Path("/usr/share/live-build"),
    Path.home() / ".config" / "live-build",
]

# v0.0.48: destination roots for profile-copy. Module-level (not
# hardcoded inside profile_copy) so unit tests can patch them with
# tempdirs instead of touching real /etc/ paths. Mirrors the
# ARCHISO_DIRS / LIVE_BUILD_DIRS pattern above.
ARCHISO_COPY_DEST = Path("/etc/archiso/configs")
LIVE_BUILD_COPY_DEST = Path("/etc/live-build")


def _mkosi_profiles() -> list[dict[str, str]]:
    """List mkosi profiles / config roots on this host.

    Each entry: {name, path, type}. `type` is 'mkosi.conf' for a
    directory containing mkosi.conf (project-local), 'profile' for a
    named .profile file, or 'fragment' for a .conf drop-in fragment.
    """
    profiles: list[dict[str, str]] = []
    seen: set[str] = set()
    for d in MKOSI_DIRS:
        if not d.is_dir():
            continue
        # mkosi.conf at the root of a config dir — single-profile case.
        root_conf = d / "mkosi.conf"
        if root_conf.is_file():
            key = str(root_conf)
            if key not in seen:
                profiles.append({
                    "name": d.name,
                    "path": str(root_conf),
                    "type": "mkosi.conf",
                })
                seen.add(key)
        # Named profiles (mkosi v22+): mkosi.profiles/<name>.profile
        profiles_dir = d / "mkosi.profiles"
        if profiles_dir.is_dir():
            for p in sorted(profiles_dir.glob("*.profile")):
                key = str(p)
                if key in seen:
                    continue
                profiles.append({
                    "name": p.stem,
                    "path": str(p),
                    "type": "profile",
                })
                seen.add(key)
        # Drop-in fragments: mkosi.conf.d/*.conf
        confd = d / "mkosi.conf.d"
        if confd.is_dir():
            for p in sorted(confd.glob("*.conf")):
                key = str(p)
                if key in seen:
                    continue
                profiles.append({
                    "name": p.stem,
                    "path": str(p),
                    "type": "fragment",
                })
                seen.add(key)
    return profiles


def _archiso_profiles() -> list[dict[str, str]]:
    """List archiso profile directories.

    Each entry: {name, path, type}. `path` is the profile directory
    (containing profiledef.sh + airootfs/)."""
    profiles: list[dict[str, str]] = []
    seen: set[str] = set()
    for d in ARCHISO_DIRS:
        if not d.is_dir():
            continue
        for child in sorted(d.iterdir()):
            if not child.is_dir():
                continue
            # An archiso profile dir must contain profiledef.sh.
            if not (child / "profiledef.sh").is_file():
                continue
            key = str(child)
            if key in seen:
                continue
            profiles.append({
                "name": child.name,
                "path": str(child),
                "type": "archiso-profile",
            })
            seen.add(key)
    return profiles


def _vmdb2_profiles() -> list[dict[str, str]]:
    """List vmdb2 spec YAML files.

    Each entry: {name, path, type}. `name` is the file stem."""
    profiles: list[dict[str, str]] = []
    seen: set[str] = set()
    for d in VMDB2_DIRS:
        if not d.is_dir():
            continue
        for pattern in ("*.yaml", "*.yml"):
            for p in sorted(d.glob(pattern)):
                key = str(p)
                if key in seen:
                    continue
                profiles.append({
                    "name": p.stem,
                    "path": str(p),
                    "type": "vmdb2-spec",
                })
                seen.add(key)
    return profiles


def _live_build_profiles() -> list[dict[str, str]]:
    """List live-build config directories.

    Each entry: {name, path, type}. `path` is a directory that contains
    a `config/` subdir (the marker that `lb config` was run there).
    """
    profiles: list[dict[str, str]] = []
    seen: set[str] = set()
    for d in LIVE_BUILD_DIRS:
        if not d.is_dir():
            continue
        for child in sorted(d.iterdir()):
            if not child.is_dir():
                continue
            if not (child / "config").is_dir():
                continue
            key = str(child)
            if key in seen:
                continue
            profiles.append({
                "name": child.name,
                "path": str(child),
                "type": "live-build-config",
            })
            seen.add(key)
    return profiles


# ── Per-backend dispatch ────────────────────────────────────────────
#
# Each backend's profile-discovery function is registered under its
# backend_id. The summary command iterates over BACKENDS and calls the
# matching discovery function. Unknown / missing backends contribute
# an empty list.

DISCOVERY = {
    "mkosi":      _mkosi_profiles,
    "archiso":    _archiso_profiles,
    "vmdb2":      _vmdb2_profiles,
    "live-build": _live_build_profiles,
}


# ── Command surface ─────────────────────────────────────────────────

def status() -> dict[str, Any]:
    """Return the operational status of the image-builder stack.

    Returns:
      {
        "state":   "active" | "inactive" | "unavailable",
        "primary": {id, binary, version, ...} | None,
        "backends": [<backend dict>, ...],
        "distro":  "arch" | "debian" | ...
      }

    `state` is 'active' when at least one backend is installed; the
    JS panel treats 'active' as "show the profile list" and otherwise
    shows an install hint with the recommended package for this distro.
    """
    primary = _primary_backend()
    if BACKENDS:
        state = "active"
    else:
        state = "unavailable"

    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from __init__ import DISTRO  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        DISTRO = "unknown"

    return {
        "state": state,
        "primary": primary,
        "backends": BACKENDS,
        "distro": DISTRO,
    }


def profiles() -> list[dict[str, Any]]:
    """Return a flat list of all build profiles/specs across all
    installed backends. Each entry includes a `backend` field naming
    the tool that owns it, so the JS can group them under that
    backend's header in the panel."""
    out: list[dict[str, Any]] = []
    for b in BACKENDS:
        discover = DISCOVERY.get(b["id"])
        if not discover:
            continue
        for p in discover():
            p["backend"] = b["id"]
            out.append(p)
    return out


def summary() -> dict[str, Any]:
    """Combined status + profiles in one call — what the panel renders."""
    s = status()
    profs = profiles()
    s["profiles"] = profs
    s["profileCount"] = len(profs)
    return s


def backends() -> list[dict[str, Any]]:
    """Return just the installed backend list — useful for the panel's
    'install hint' UI when no backend is present."""
    return BACKENDS


def install_hint() -> dict[str, str]:
    """Return the recommended install command for the host distro.

    Used by the panel when `status.state == 'unavailable'` so the
    operator sees the exact pacman/apt command to run instead of a
    generic 'install mkosi' message."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from __init__ import DISTRO  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        DISTRO = "unknown"

    hints = {
        "arch": {
            "primary": "mkosi",
            "primary_cmd": "sudo pacman -S --needed mkosi",
            "iso": "archiso",
            "iso_cmd": "sudo pacman -S --needed archiso",
        },
        "debian": {
            "primary": "vmdb2",
            "primary_cmd": "sudo apt install -y vmdb2",
            "iso": "live-build",
            "iso_cmd": "sudo apt install -y live-build",
        },
    }
    return hints.get(DISTRO, {
        "primary": "mkosi",
        "primary_cmd": "install mkosi (or vmdb2 on Debian)",
        "iso": "archiso / live-build",
        "iso_cmd": "install archiso (Arch) or live-build (Debian)",
    })


# ── v0.0.31: Full-featured build operations ────────────────────────
#
# The v0.0.30 builder was a status+profile viewer. v0.0.31 adds the
# ability to actually build images, create and delete profiles, list
# build artifacts, and tail build logs.
#
# Build state lives under /var/lib/sysdeck/builder/:
#   state/<build-id>.json   per-build state record
#   artifacts/<profile>/    produced image/ISO files (backend puts them here)
#   logs/<build-id>.log     full stdout+stderr of the build
#
# Build IDs are timestamps: <profile>-<YYYYMMDDHHMMSS>. The JS panel
# can refresh build-status() periodically to see progress.

BUILDER_STATE_DIR = Path("/var/lib/sysdeck/builder/state")
BUILDER_LOGS_DIR = Path("/var/lib/sysdeck/builder/logs")
BUILDER_ARTIFACTS_DIR = Path("/var/lib/sysdeck/builder/artifacts")


def _ensure_state_dirs() -> None:
    """Create the state/logs/artifacts dirs. Best-effort; the cockpit
    superuser channel handles root perms when needed."""
    for d in (BUILDER_STATE_DIR, BUILDER_LOGS_DIR, BUILDER_ARTIFACTS_DIR):
        try:
            d.mkdir(parents=True, exist_ok=True)
        except (PermissionError, OSError):
            pass


def _new_build_id(profile: str) -> str:
    """Generate a build ID: <profile>-<YYYYMMDDHHMMSS>."""
    import datetime
    ts = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    safe_profile = re.sub(r"[^A-Za-z0-9_-]", "_", profile)
    return f"{safe_profile}-{ts}"


def _build_state_path(build_id: str) -> Path:
    return BUILDER_STATE_DIR / f"{build_id}.json"


def _build_log_path(build_id: str) -> Path:
    return BUILDER_LOGS_DIR / f"{build_id}.log"


def _read_build_state(build_id: str) -> dict[str, Any] | None:
    p = _build_state_path(build_id)
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, PermissionError, OSError):
        return None


def _write_build_state(build_id: str, state: dict[str, Any]) -> None:
    p = _build_state_path(build_id)
    try:
        _ensure_state_dirs()
        p.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except (PermissionError, OSError):
        pass


# ── Build invocation ────────────────────────────────────────────────
#
# Each backend has its own invocation pattern:
#   mkosi       run `mkosi build` in the profile's directory
#   archiso     run `mkarchiso <profile> build` in /usr/share/archiso/configs/<profile>
#   vmdb2       run `vmdb2 <spec.yaml> --output <artifact>` in /tmp
#   live-build  run `lb build` in the profile's directory
#
# The bridge invokes the backend via subprocess and streams stdout
# and stderr to the log file. The build runs synchronously (the JS
# panel's cockpit.spawn will block until completion; for long builds
# the operator can navigate away and check back via build-status()).


def _migrate_legacy_mkosi_packages(conf_path: Path) -> dict[str, Any]:
    """Detect and rewrite old indented Packages= syntax to single-line.

    mkosi v22+ (Arch ships 25.x) ONLY understands:
        Packages=linux linux-firmware systemd openssh

    The old v0.0.x indented form:
        Packages=
            linux
            linux-firmware
            systemd
            openssh

    is silently parsed by mkosi v22+ as a single package name with
    embedded newlines ("linux\\nlinux-firmware\\n..."), which doesn't
    exist in any repo — so mkosi installs NOTHING. The operator sees
    a successful build with zero of their requested packages in the
    image.

    This function reads the profile, detects the old syntax, rewrites
    the Packages= line to single-line space-separated form IN-PLACE,
    and returns a status dict. If the file already uses modern syntax,
    it's a no-op.
    """
    try:
        content = conf_path.read_text(encoding="utf-8") if conf_path.is_file() else ""
    except (PermissionError, OSError) as exc:
        return {"error": str(exc)}

    if "[Packages]" not in content:
        return {"migrated": False, "reason": "no [Packages] section"}

    # Match: "Packages=" followed by a newline and one or more
    # indented lines (the old v0.0.x continuation syntax).
    old_pat = re.compile(
        r"^(Packages=)\s*\n((?:[ \t]+[^\s\n][^\n]*\n)+)",
        re.MULTILINE,
    )
    m = old_pat.search(content)
    if not m:
        return {"migrated": False, "reason": "already uses single-line syntax"}

    # Extract package names from the indented block.
    packages: list[str] = []
    for line in m.group(2).splitlines():
        name = line.strip()
        if name and name not in packages:
            packages.append(name)

    if not packages:
        return {"migrated": False, "reason": "no packages found in indented block"}

    # Rewrite: replace "Packages=\n    pkg1\n    pkg2\n" with
    # "Packages=pkg1 pkg2"
    new_line = f"Packages={' '.join(packages)}"
    new_content = content[:m.start()] + new_line + content[m.end():]

    try:
        conf_path.write_text(new_content, encoding="utf-8")
    except (PermissionError, OSError) as exc:
        return {"error": str(exc)}

    return {"migrated": True, "count": len(packages), "packages": packages}


def _backend_build_command(backend_id: str, profile: dict[str, Any], options: dict[str, Any]) -> list[str]:
    """Build the backend invocation command for the given profile.

    `options` may carry: output_dir, image_format, extra_args, force.
    Returns the argv list to subprocess.run.

    v0.1.3 CRITICAL FIX: --include does NOT work as a config loader.
    mkosi's --include flag includes a drop-in fragment ON TOP OF the
    base mkosi.conf — it does NOT replace the base config. If there's
    no mkosi.conf in the cwd, mkosi uses defaults and ignores the
    --include file entirely. This is why v0.1.2 still produced builds
    with only 2 packages (mkosi's hardcoded base).

    The fix: build() now creates a temp directory, symlinks the
    profile file into it as `mkosi.conf`, and sets work_dir to that
    temp dir. mkosi finds `mkosi.conf` (the symlink), follows it,
    reads the actual profile. This works for ANY profile path
    regardless of its filename or location.

    v0.1.1: --output and --output-dir are ALWAYS passed on the CLI
    so the output path is forced to the artifacts dir.
    """
    ppath = profile.get("path", "")
    pname = profile.get("name", "")
    if backend_id == "mkosi":
        artifacts_dir = options.get("output_dir") or str(BUILDER_ARTIFACTS_DIR / pname)
        output_name = options.get("output_name") or f"{pname}.raw"
        cmd = [
            "mkosi", "build",
            "--output", output_name,
            "--output-dir", artifacts_dir,
        ]
        if options.get("force", True):
            cmd.append("--force")
        if options.get("image_format"):
            cmd += ["--format", options["image_format"]]
        return cmd
    if backend_id == "archiso":
        return ["mkarchiso", ppath, "build"] if ppath else ["mkarchiso", "build"]
    if backend_id == "vmdb2":
        cmd = ["vmdb2", ppath] if ppath else ["vmdb2"]
        out = options.get("output_dir") or str(BUILDER_ARTIFACTS_DIR / pname)
        cmd += ["--output", out]
        return cmd
    if backend_id == "live-build":
        return ["lb", "build"]
    return []


def _prepare_mkosi_work_dir(profile: dict[str, Any]) -> Path | None:
    """Create a temp dir with mkosi.conf symlinked to the profile file.

    v0.1.3: mkosi ONLY reads a file literally named `mkosi.conf` from
    the cwd. --include includes a drop-in but does NOT replace the base
    config. So we create a temp dir, symlink the profile as `mkosi.conf`,
    and run mkosi there. The symlink ensures mkosi reads the REAL profile
    file (not a stale copy), so any edits the operator makes are picked
    up on the next build.

    Returns the temp dir Path, or None if the profile has no path.
    The caller is responsible for cleaning up the temp dir after the
    build finishes.
    """
    ppath = profile.get("path", "")
    if not ppath:
        return None
    p = Path(ppath)
    if not p.is_file():
        return None
    tmpdir = Path(tempfile.mkdtemp(prefix="sysdesk-mkosi-"))
    link = tmpdir / "mkosi.conf"
    try:
        link.symlink_to(p.resolve())
    except (OSError, FileExistsError):
        # If symlink fails, copy the file instead.
        import shutil as _sh
        _sh.copy2(p, link)
    return tmpdir


def _backend_profile_dir(backend_id: str, profile: dict[str, Any]) -> Path | None:
    """Return the working directory for the backend invocation."""
    ppath = profile.get("path", "")
    if not ppath:
        return None
    p = Path(ppath)
    # mkosi.conf is a file — work in its parent.
    if p.is_file():
        return p.parent
    return p


def build(args: list[str]) -> dict[str, Any]:
    """Run a build for the given profile.

    Usage: build <profile-name> [backend] [--options json]
    The profile is looked up via profiles(). If backend is omitted,
    the profile's own backend field is used. Returns a build-id that
    the JS panel can pass to build-status() / build-log().

    The build runs synchronously. The cockpit superuser channel
    handles root privileges via the org.sysdeck.builder.modify polkit
    action (shipped since v0.0.17, v0.0.30 expanded for mkosi/vmdb2/
    archiso/live-build).
    """
    if not args:
        return {"error": "profile name required"}
    pname = args[0]
    backend_override = args[1] if len(args) > 1 and not args[1].startswith("--") else None
    # Parse --options json
    options: dict[str, Any] = {}
    for a in args[1:]:
        if a.startswith("--options="):
            try:
                options = json.loads(a[len("--options="):])
            except json.JSONDecodeError:
                pass

    # Find the profile.
    all_profiles = profiles()
    profile = None
    for p in all_profiles:
        if p.get("name") == pname:
            profile = p
            break
    if profile is None:
        return {"error": f"profile '{pname}' not found"}

    backend_id = backend_override or profile.get("backend") or (primary["id"] if (primary := _primary_backend() or {}) else "")
    # Verify backend is installed.
    backend_installed = next((b for b in BACKENDS if b["id"] == backend_id), None)
    if backend_installed is None:
        return {"error": f"backend '{backend_id}' is not installed",
                "hint": install_hint()}

    # v0.1.1: detect OLD v0.0.x profiles in /etc/mkosi/mkosi.conf.d/.
    profile_path = profile.get("path", "")
    is_legacy_v050_profile = False
    if backend_id == "mkosi" and profile_path:
        try:
            p_obj = Path(profile_path)
            if "/etc/mkosi/mkosi.conf.d/" in str(p_obj) or \
               (p_obj.parent.name == "mkosi.conf.d" and p_obj.name != "mkosi.conf"):
                is_legacy_v050_profile = True
        except (ValueError, TypeError):
            pass

    # v0.1.2: auto-migrate legacy indented Packages= syntax to
    # single-line before building. mkosi v22+ can't parse the old
    # v0.0.x indented form — it silently treats it as a single
    # package name with embedded newlines, which doesn't exist in
    # any repo, so ZERO packages get installed. This must happen
    # BEFORE the build command is constructed so mkosi sees the
    # correct syntax when --include= loads the file.
    migration_result = None
    if backend_id == "mkosi" and profile_path:
        try:
            p_obj = Path(profile_path)
            if p_obj.is_file():
                migration_result = _migrate_legacy_mkosi_packages(p_obj)
        except Exception:  # noqa: BLE001
            migration_result = {"error": "migration failed unexpectedly"}

    build_id = _new_build_id(pname)
    log_path = _build_log_path(build_id)

    # v0.1.3: for mkosi, create a temp work dir with mkosi.conf
    # symlinked to the profile file. mkosi ONLY reads a file named
    # `mkosi.conf` from the cwd — --include doesn't replace the base
    # config. The temp dir ensures mkosi always finds and reads the
    # profile regardless of its actual filename or location.
    mkosi_temp_dir = None
    if backend_id == "mkosi":
        mkosi_temp_dir = _prepare_mkosi_work_dir(profile)
        if mkosi_temp_dir is not None:
            work_dir = mkosi_temp_dir
        else:
            work_dir = _backend_profile_dir(backend_id, profile)
    else:
        work_dir = _backend_profile_dir(backend_id, profile)

    cmd = _backend_build_command(backend_id, profile, options)

    if not cmd:
        # Clean up temp dir before returning.
        if mkosi_temp_dir:
            shutil.rmtree(mkosi_temp_dir, ignore_errors=True)
        return {"error": f"no build command for backend '{backend_id}'"}

    # v0.1.1 SAFETY CHECK: verify the resolved output path is NOT under
    # any system config directory. The check enforces that the output
    # dir is either (a) the real BUILDER_ARTIFACTS_DIR (which lives under
    # /var/lib/sysdeck/builder/artifacts/), or (b) under /var/lib/, /tmp/,
    # or /var/tmp/. This blocks /etc/, /usr/, /boot/, /bin/, /sbin/,
    # /lib/, /root/, /home/, etc. — anywhere a stray image.raw would
    # corrupt the system or pollute a user's home.
    if backend_id == "mkosi":
        resolved_output_dir = Path(options.get("output_dir") or str(BUILDER_ARTIFACTS_DIR / pname))
        try:
            resolved = resolved_output_dir.resolve()
        except (OSError, RuntimeError):
            resolved = resolved_output_dir
        # Allow if it equals the patched BUILDER_ARTIFACTS_DIR/<name>
        # (the test-suite patches BUILDER_ARTIFACTS_DIR to a tempdir).
        expected_default = (BUILDER_ARTIFACTS_DIR / pname).resolve() \
            if BUILDER_ARTIFACTS_DIR.is_absolute() else (BUILDER_ARTIFACTS_DIR / pname)
        try:
            is_default = (resolved == expected_default or
                          str(resolved) == str(expected_default))
        except (OSError, ValueError):
            is_default = False
        # Allow under /var/lib/, /tmp/, /var/tmp/.
        allowed_roots = (Path("/var/lib"), Path("/tmp"), Path("/var/tmp"))
        is_under_allowed = False
        for root in allowed_roots:
            try:
                resolved.relative_to(root)
                is_under_allowed = True
                break
            except ValueError:
                continue
        if not (is_default or is_under_allowed):
            return {
                "error": (
                    f"refusing to build: output directory '{resolved_output_dir}' "
                    f"is not under /var/lib/, /tmp/, or /var/tmp/. Build outputs "
                    f"must go to /var/lib/sysdeck/builder/artifacts/<profile>/ to "
                    f"avoid corrupting system config directories."
                ),
                "hint": "remove the output_dir override from your build options",
            }
        # Ensure the per-profile artifacts dir exists (mkosi won't
        # create the parent dir for --output-dir itself).
        try:
            resolved_output_dir.mkdir(parents=True, exist_ok=True)
        except (PermissionError, OSError) as exc:
            return {"error": f"cannot create artifacts dir '{resolved_output_dir}': {exc}",
                    "hint": "run via cockpit superuser channel (polkit org.sysdeck.builder.modify)"}

    # Write initial state.
    import datetime
    started = datetime.datetime.now().isoformat()
    # v0.1.1: record the resolved output_dir in the build state so the
    # panel and the log both make it clear where the image will land.
    resolved_output_dir = None
    if backend_id == "mkosi":
        resolved_output_dir = str(options.get("output_dir") or str(BUILDER_ARTIFACTS_DIR / pname))
    elif backend_id == "vmdb2":
        resolved_output_dir = options.get("output_dir") or str(BUILDER_ARTIFACTS_DIR / pname)
    state = {
        "build_id": build_id,
        "profile": pname,
        "backend": backend_id,
        "command": " ".join(cmd),
        "work_dir": str(work_dir) if work_dir else None,
        "output_dir": resolved_output_dir,
        "started": started,
        "finished": None,
        "duration_s": None,
        "state": "running",
        "rc": None,
        "artifacts": [],
        "options": options,
        "warnings": (
            ["legacy_v050_profile: profile is in /etc/mkosi/mkosi.conf.d/ — "
             "mkosi may ignore it. Migrate to /etc/mkosi/profiles/<name>/mkosi.conf."]
            if is_legacy_v050_profile else []
        ) + (
            [f"packages_migrated: rewrote Packages= from old indented syntax "
             f"to single-line ({migration_result['count']} packages: "
             f"{', '.join(migration_result['packages'][:10])})"]
            if migration_result and migration_result.get("migrated") else []
        ),
    }
    _write_build_state(build_id, state)

    # Run the build. stdout+stderr → log file.
    _ensure_state_dirs()
    try:
        with log_path.open("w", encoding="utf-8") as logf:
            logf.write(f"$ {' '.join(cmd)}\n")
            logf.write(f"# work_dir: {work_dir}\n")
            logf.write(f"# backend: {backend_id}\n")
            logf.write(f"# profile: {pname}\n")
            if resolved_output_dir:
                logf.write(f"# output_dir: {resolved_output_dir}\n")
            if is_legacy_v050_profile:
                logf.write("# WARNING: profile is in /etc/mkosi/mkosi.conf.d/ (legacy v0.0.x layout).\n")
                logf.write("#          --include= on the CLI forces mkosi to load it anyway.\n")
            if migration_result and migration_result.get("migrated"):
                pkgs = migration_result.get("packages", [])
                shown = ", ".join(pkgs[:10])
                suffix = f" (and {len(pkgs)-10} more)" if len(pkgs) > 10 else ""
                logf.write(f"# MIGRATED: rewrote Packages= from old indented syntax to single-line\n")
                logf.write(f"#           ({migration_result['count']} packages: {shown}{suffix})\n")
            elif migration_result and migration_result.get("error"):
                logf.write(f"# MIGRATION ERROR: {migration_result['error']}\n")
            logf.write("\n")
            logf.flush()
            r = subprocess.run(
                cmd,
                cwd=work_dir if work_dir else None,
                stdout=logf, stderr=subprocess.STDOUT,
                check=False, timeout=3600,
            )
        rc = r.returncode
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        rc = 127
        try:
            with log_path.open("a", encoding="utf-8") as logf:
                logf.write(f"\n[bridge] build invocation failed: {exc}\n")
        except (PermissionError, OSError):
            pass

    # Discover artifacts.
    artifacts_dir = BUILDER_ARTIFACTS_DIR / pname
    artifact_files: list[dict[str, Any]] = []
    if artifacts_dir.is_dir():
        for f in sorted(artifacts_dir.iterdir()):
            if f.is_file():
                try:
                    sz = f.stat().st_size
                except OSError:
                    sz = 0
                artifact_files.append({"name": f.name, "path": str(f), "size": sz})

    # v0.1.3: clean up the temp work dir created for mkosi.
    if mkosi_temp_dir:
        shutil.rmtree(mkosi_temp_dir, ignore_errors=True)

    # Update state.
    finished = datetime.datetime.now().isoformat()
    state["state"] = "succeeded" if rc == 0 else "failed"
    state["rc"] = rc
    state["finished"] = finished
    state["artifacts"] = artifact_files
    try:
        started_dt = datetime.datetime.fromisoformat(started)
        finished_dt = datetime.datetime.fromisoformat(finished)
        state["duration_s"] = (finished_dt - started_dt).total_seconds()
    except (ValueError, TypeError):
        pass
    _write_build_state(build_id, state)

    return {
        "build_id": build_id,
        "profile": pname,
        "backend": backend_id,
        "rc": rc,
        "success": rc == 0,
        "state": state["state"],
        "duration_s": state["duration_s"],
        "artifacts": artifact_files,
        "log_path": str(log_path),
    }


# ── Profile creation / deletion ──────────────────────────────────────
#
# These scaffold a minimal profile config in the appropriate dir for
# the chosen backend. The operator is expected to edit the scaffolded
# file before building — the bridge writes the minimum required to
# make the backend discover the profile.
#
# v0.0.49: profile-create and profile-copy accept an optional inline
# package list (--packages=<json>) and a merge mode (--mode=append|
# replace). The package list is written to the backend-specific
# package file:
#   mkosi      → [Packages] section of <name>.conf
#   vmdb2      → bootstrap.include list in <name>.yaml
#   archiso    → packages.x86_64 in the profile dir
#   live-build → config/package-lists/sysdeck.list


def _extract_opts(args: list[str]) -> tuple[list[str], dict[str, str]]:
    """Split an argv list into (positional, opts).

    Recognizes `--key=value` and `--key` (boolean, value="true").
    Everything else is positional. This lets profile-create and
    profile-copy accept optional --packages=<json> and --mode=append|
    replace flags without breaking their existing positional
    `<name> <backend> [base]` / `<src> <new> [backend]` signatures.
    """
    positional: list[str] = []
    opts: dict[str, str] = {}
    for a in args:
        if a.startswith("--") and "=" in a:
            k, v = a[2:].split("=", 1)
            opts[k] = v
        elif a.startswith("--"):
            opts[a[2:]] = "true"
        else:
            positional.append(a)
    return positional, opts


def _parse_packages_text(text: str) -> list[str]:
    """Parse a multiline package-list text into a list of names.

    Accepts one package per line. Lines starting with `#` are comments
    and are stripped (the underlying backend file format may or may not
    preserve them — archiso/live-build do, mkosi/vmdb2 don't). Empty
    lines and surrounding whitespace are stripped. Duplicate names are
    removed while preserving first-occurrence order.
    """
    if not text:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for line in text.splitlines():
        # Strip comments: everything after a inline `#` is dropped too,
        # matching archiso's packages.* format.
        hash_idx = line.find("#")
        if hash_idx >= 0:
            line = line[:hash_idx]
        name = line.strip()
        if not name:
            continue
        if name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


_MKOSI_TEMPLATE = """[Distribution]
Distribution={distro}
Release={release}

[Output]
Format=disk
Output={name}.raw
OutputDirectory=/var/lib/sysdeck/builder/artifacts/{name}

[Packages]
Packages=linux linux-firmware systemd openssh
"""


_VMDB2_TEMPLATE = """# vmdb2 spec for {name}
# See https://vmdb2.rtfd.io for full schema.
image_size: 2G
image_format: raw

partitions:
  - name: root
    type: ext4
    mountpoint: /

bootstrap:
  - distro: debian
    target: root
    include:
      - linux-image-amd64
      - systemd
      - openssh-server

commands:
  - passwd -d root
"""


def profile_create(args: list[str]) -> dict[str, Any]:
    """Scaffold a new profile.

    Usage: profile-create <name> <backend> [base] [--packages=<json>] [--mode=append|replace]
    Creates the file at the backend's profile dir. For mkosi, writes
    /etc/mkosi/mkosi.conf.d/<name>.conf. For vmdb2, writes
    /etc/vmdb2/<name>.yaml. For archiso and live-build, returns an
    error (those use shipped profile dirs the operator should copy
    via profile-copy, not scaffold from scratch).

    v0.0.49: if --packages=<json> is given, the JSON-decoded string is
    parsed as a multiline package list (one per line, # comments ok)
    and written to the backend-specific package file. --mode defaults
    to "replace" for profile-create (the scaffold's defaults are
    minimal; the operator's list replaces them).
    """
    positional, opts = _extract_opts(args)
    if len(positional) < 2:
        return {"error": "usage: profile-create <name> <backend> [base] [--packages=<json>] [--mode=append|replace]"}
    name = positional[0]
    backend_id = positional[1]
    base = positional[2] if len(positional) > 2 else None

    # Validate backend.
    valid_backends = ("mkosi", "vmdb2")
    if backend_id not in valid_backends:
        return {"error": f"profile-create supports {valid_backends}; {backend_id} profiles are not scaffolded (use the shipped ones)"}

    # Parse --packages and --mode.
    packages_json = opts.get("packages")
    packages_text = ""
    if packages_json:
        try:
            packages_text = json.loads(packages_json)
            if not isinstance(packages_text, str):
                return {"error": "--packages JSON must decode to a string"}
        except json.JSONDecodeError as exc:
            return {"error": f"--packages is not valid JSON: {exc}"}
    mode = opts.get("mode", "replace")  # default for create

    if backend_id == "mkosi":
        # v0.1.0: each mkosi profile lives in its own directory
        # /etc/mkosi/profiles/<name>/mkosi.conf. mkosi only reads a
        # file literally named `mkosi.conf` from the cwd — the v0.0.x
        # layout of /etc/mkosi/mkosi.conf.d/<name>.conf was a drop-in
        # fragment that mkosi silently ignored without a parent
        # mkosi.conf to layer onto. Per-profile directories also let
        # operators drop in mkosi.pkg / mkosi.extra/ etc. naturally.
        target_dir = Path("/etc/mkosi/profiles") / name
        target_file = target_dir / "mkosi.conf"
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
            if target_file.exists():
                return {"error": f"{target_file} already exists"}
            try:
                sys.path.insert(0, str(Path(__file__).resolve().parent))
                from __init__ import DISTRO  # type: ignore[import-not-found]
            except Exception:  # noqa: BLE001
                DISTRO = "unknown"
            distro = "arch" if DISTRO == "arch" else "debian"
            release = "rolling" if DISTRO == "arch" else "bookworm"
            content = _MKOSI_TEMPLATE.format(distro=distro, release=release, name=name)
            target_file.write_text(content, encoding="utf-8")
            result: dict[str, Any] = {"created": True, "backend": backend_id, "name": name,
                    "path": str(target_file), "template": "mkosi.conf"}
            # v0.0.49: write packages if provided.
            if packages_text:
                pkg_result = _write_packages(str(target_file), backend_id, packages_text, mode)
                if "error" in pkg_result:
                    result["packages_error"] = pkg_result["error"]
                else:
                    result["packages"] = pkg_result
            return result
        except (PermissionError, OSError) as exc:
            return {"created": False, "error": str(exc),
                    "hint": "run via cockpit superuser channel (polkit org.sysdeck.builder.modify)"}

    if backend_id == "vmdb2":
        target_dir = Path("/etc/vmdb2")
        target_file = target_dir / f"{name}.yaml"
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
            if target_file.exists():
                return {"error": f"{target_file} already exists"}
            content = _VMDB2_TEMPLATE.format(name=name)
            target_file.write_text(content, encoding="utf-8")
            result = {"created": True, "backend": backend_id, "name": name,
                    "path": str(target_file), "template": "vmdb2-spec"}
            # v0.0.49: write packages if provided.
            if packages_text:
                pkg_result = _write_packages(str(target_file), backend_id, packages_text, mode)
                if "error" in pkg_result:
                    result["packages_error"] = pkg_result["error"]
                else:
                    result["packages"] = pkg_result
            return result
        except (PermissionError, OSError) as exc:
            return {"created": False, "error": str(exc),
                    "hint": "run via cockpit superuser channel (polkit org.sysdeck.builder.modify)"}

    return {"error": "unreachable"}


# ── Profile copy (archiso / live-build) ─────────────────────────────
#
# v0.0.48: profile-create only scaffolds single-file specs (mkosi.conf
# fragments and vmdb2 YAML). The directory-based backends — archiso
# and live-build — ship baseline profile trees under /usr/share that
# the operator is expected to *copy* into /etc/ and then edit, not
# scaffold from scratch. Without a copy path, the panel's Create
# Profile form would funnel operators of archiso-only or live-build-
# only hosts straight into the "profile-create supports ('mkosi',
# 'vmdb2')" error.
#
# profile-copy resolves a shipped source profile via the existing
# profiles() discovery, refuses if the destination already exists,
# and copies the tree with shutil.copytree. The operator then owns
# the /etc/ copy and can edit it before building.


def profile_copy(args: list[str]) -> dict[str, Any]:
    """Copy a shipped directory-based profile into /etc/.

    Usage: profile-copy <src-name> <new-name> [backend] [--packages=<json>] [--mode=append|replace]

    Resolves <src-name> through profiles() — typically a shipped
    archiso baseline/releng or a live-build config dir under
    /usr/share. Copies the whole tree to /etc/<backend>/configs/
    <new-name>/ (archiso) or /etc/live-build/<new-name>/ (live-build).

    Refuses to copy:
      - profiles owned by mkosi or vmdb2 (single-file specs —
        use profile-create to scaffold a new one),
      - if the destination already exists,
      - if the source path is not a directory.

    The copy is a single shutil.copytree call; the cockpit superuser
    channel handles root perms via the org.sysdeck.builder.modify
    polkit action (same one profile-create uses).

    v0.0.49: if --packages=<json> is given, the JSON-decoded string is
    parsed as a multiline package list and written to the backend-
    specific package file in the freshly-copied profile. --mode
    defaults to "append" for profile-copy (the baseline's packages
    like 'linux'/'base' are preserved; the operator's list adds to
    them). Use --mode=replace to overwrite the baseline's package
    file entirely.
    """
    positional, opts = _extract_opts(args)
    if len(positional) < 2:
        return {"error": "usage: profile-copy <src-name> <new-name> [backend] [--packages=<json>] [--mode=append|replace]"}
    src_name = positional[0]
    new_name = positional[1]
    backend_hint = positional[2] if len(positional) > 2 else None

    # Reject obviously bad new-names before touching the filesystem.
    if "/" in new_name or new_name in (".", ".."):
        return {"error": f"invalid new-name '{new_name}' (must be a single path component)"}

    # Parse --packages and --mode (default for copy is append).
    packages_json = opts.get("packages")
    packages_text = ""
    if packages_json:
        try:
            packages_text = json.loads(packages_json)
            if not isinstance(packages_text, str):
                return {"error": "--packages JSON must decode to a string"}
        except json.JSONDecodeError as exc:
            return {"error": f"--packages is not valid JSON: {exc}"}
    mode = opts.get("mode", "append")  # default for copy

    # Find the source profile via the unified discovery.
    all_profiles = profiles()
    src_profile: dict[str, Any] | None = None
    for p in all_profiles:
        if p.get("name") != src_name:
            continue
        if backend_hint and p.get("backend") != backend_hint:
            continue
        src_profile = p
        break
    if src_profile is None:
        return {
            "error": f"source profile '{src_name}' not found",
            "hint": "use 'profiles' to list available profiles; "
                    "shipped archiso profiles are usually 'baseline' and 'releng'",
        }

    backend = src_profile.get("backend")
    # Only directory-based backends are copyable. mkosi/vmdb2 use
    # single files and have profile-create for scaffolding instead.
    if backend not in ("archiso", "live-build"):
        return {
            "error": (
                f"profile-copy is for archiso/live-build directory profiles; "
                f"'{src_name}' is a {backend} profile "
                f"(use profile-create to scaffold a new one)"
            ),
        }

    src_path = Path(src_profile.get("path", ""))
    if not src_path.is_dir():
        return {"error": f"source profile path {src_path} is not a directory"}

    # Destination layout per backend:
    #   archiso      → /etc/archiso/configs/<new-name>/
    #   live-build   → /etc/live-build/<new-name>/
    # (Roots are module-level constants ARCHISO_COPY_DEST /
    # LIVE_BUILD_COPY_DEST so unit tests can patch them with tempdirs.)
    if backend == "archiso":
        dest_dir = ARCHISO_COPY_DEST / new_name
    else:  # live-build
        dest_dir = LIVE_BUILD_COPY_DEST / new_name

    if dest_dir.exists():
        return {
            "error": f"{dest_dir} already exists",
            "hint": "pick a different name, or profile-delete the existing one first",
        }

    try:
        import shutil
        dest_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src_path, dest_dir)
        result: dict[str, Any] = {
            "copied": True,
            "backend": backend,
            "source": src_name,
            "source_path": str(src_path),
            "name": new_name,
            "path": str(dest_dir),
        }
        # v0.0.49: write packages if provided.
        if packages_text:
            pkg_result = _write_packages(str(dest_dir), backend, packages_text, mode)
            if "error" in pkg_result:
                result["packages_error"] = pkg_result["error"]
            else:
                result["packages"] = pkg_result
        return result
    except (PermissionError, OSError) as exc:
        return {
            "copied": False,
            "error": str(exc),
            "hint": "run via cockpit superuser channel (polkit org.sysdeck.builder.modify)",
        }


# ── Package-list writing (v0.0.49) ─────────────────────────────────
#
# Each backend stores its package list in a different place and format:
#
#   mkosi      → [Packages] section of <name>.conf (INI continuation)
#   vmdb2      → bootstrap[].include list in <name>.yaml (YAML list)
#   archiso    → packages.x86_64 in the profile dir (one per line)
#   live-build → config/package-lists/sysdeck.list (one per line)
#
# All four writers accept (path, packages_list, mode) where mode is
# "append" or "replace". They return a dict with the written path and
# the final package count so profile_create / profile_copy can surface
# it in their success response.
#
# The writers are intentionally per-backend (no generic "update INI"
# or "update YAML" abstraction) because each format has its own quirks
# (mkosi's indented continuation, vmdb2's nested include list,
# archiso's per-arch files, live-build's multi-file package-lists).
# A shared abstraction would leak format details through it.


def _write_packages_mkosi(conf_path: Path, packages: list[str], mode: str) -> dict[str, Any]:
    """Rewrite or extend the [Packages] section of a mkosi.conf file.

    v0.1.0: mkosi v22+ (what Arch ships as mkosi 25.x) expects a single
    space-separated `Packages=` line:
        [Packages]
        Packages=linux linux-firmware systemd openssh
    The v0.0.x writer used indented continuation lines, which mkosi v22+
    silently parsed as a single package named "linux\\nlinux-firmware..."
    and failed to install. The old indented form is detected on read so
    existing v0.0.x profiles migrate cleanly when next written.
    """
    try:
        existing = conf_path.read_text(encoding="utf-8") if conf_path.is_file() else ""
    except (PermissionError, OSError) as exc:
        return {"error": str(exc)}

    # Parse existing packages out of the [Packages] section so we can
    # dedup on append. Accepts both the modern single-line form:
    #   Packages=a b c
    # and the legacy v0.0.x indented continuation form:
    #   Packages=
    #       a
    #       b
    existing_pkgs: list[str] = []
    if "[Packages]" in existing:
        in_packages = False
        in_packages_value = False
        for line in existing.splitlines():
            if line.startswith("[") and line.endswith("]"):
                in_packages = (line == "[Packages]")
                in_packages_value = False
                continue
            if in_packages and line.strip().startswith("Packages="):
                in_packages_value = True
                # Modern form: Packages=a b c — capture inline.
                inline = line.split("=", 1)[1].strip() if "=" in line else ""
                if inline:
                    for name in inline.split():
                        if name and name not in existing_pkgs:
                            existing_pkgs.append(name)
                continue
            if in_packages and in_packages_value:
                # Legacy continuation lines are indented. A non-indented
                # line ends the continuation.
                if line and not line[0].isspace():
                    in_packages_value = False
                    continue
                name = line.strip()
                if name and name not in existing_pkgs:
                    existing_pkgs.append(name)

    if mode == "append":
        # Dedup: keep existing, add new (preserving order).
        seen = set(existing_pkgs)
        for p in packages:
            if p not in seen:
                existing_pkgs.append(p)
                seen.add(p)
        final = existing_pkgs
    else:  # replace
        final = packages

    # Rebuild the [Packages] section as a single-line space-separated
    # value. mkosi v22+ accepts this form unambiguously.
    pkgs_line = " ".join(final)
    new_section = f"[Packages]\nPackages={pkgs_line}"

    if "[Packages]" in existing:
        # Replace the existing [Packages] section up to the next [Section]
        # or EOF.
        lines = existing.splitlines(keepends=True)
        out: list[str] = []
        in_packages_section = False
        for line in lines:
            if line.startswith("[") and line.endswith("]\n"):
                if line.strip() == "[Packages]":
                    in_packages_section = True
                    out.append(new_section + "\n")
                else:
                    in_packages_section = False
                    out.append(line)
            elif in_packages_section:
                # Skip existing [Packages] body lines.
                continue
            else:
                out.append(line)
        new_content = "".join(out)
    else:
        # No [Packages] section yet — append one.
        new_content = existing.rstrip("\n") + "\n\n" + new_section + "\n"

    try:
        conf_path.write_text(new_content, encoding="utf-8")
    except (PermissionError, OSError) as exc:
        return {"error": str(exc)}
    return {"path": str(conf_path), "count": len(final), "mode": mode}


def _write_packages_vmdb2(yaml_path: Path, packages: list[str], mode: str) -> dict[str, Any]:
    """Rewrite or extend the bootstrap.include list in a vmdb2 YAML.

    The scaffolded YAML has a single bootstrap entry with an `include:`
    list. We do regex-based surgery on that list — pyyaml is not a hard
    dependency (vmdb2 itself isn't typically installed on Arch, and we
    shouldn't pull in a YAML parser just to update a list).
    """
    try:
        existing = yaml_path.read_text(encoding="utf-8") if yaml_path.is_file() else ""
    except (PermissionError, OSError) as exc:
        return {"error": str(exc)}

    # Parse the existing include list. The pattern is:
    #   include:
    #     - linux-image-amd64
    #     - systemd
    #     - openssh-server
    include_pat = re.compile(
        r"(^(\s+)include:\s*\n)((?:\s+\- \S+\s*\n)+)",
        re.MULTILINE,
    )
    existing_pkgs: list[str] = []
    m = include_pat.search(existing)
    if m:
        for line in m.group(3).splitlines():
            s = line.strip()
            if s.startswith("- "):
                name = s[2:].strip()
                if name and name not in existing_pkgs:
                    existing_pkgs.append(name)

    if mode == "append":
        seen = set(existing_pkgs)
        for p in packages:
            if p not in seen:
                existing_pkgs.append(p)
                seen.add(p)
        final = existing_pkgs
    else:  # replace
        final = packages

    # Rebuild the include block.
    if m:
        indent = m.group(2)
        new_lines = m.group(1)
        for p in final:
            new_lines += f"{indent}  - {p}\n"
        new_content = existing[:m.start()] + new_lines + existing[m.end():]
    else:
        # No include: block found — append one under the bootstrap section.
        # This is a fallback; the scaffolded YAML always has it.
        indent = "    "
        block = f"\n{indent}include:\n"
        for p in final:
            block += f"{indent}  - {p}\n"
        new_content = existing.rstrip("\n") + "\n" + block

    try:
        yaml_path.write_text(new_content, encoding="utf-8")
    except (PermissionError, OSError) as exc:
        return {"error": str(exc)}
    return {"path": str(yaml_path), "count": len(final), "mode": mode}


def _write_packages_archiso(profile_dir: Path, packages: list[str], mode: str) -> dict[str, Any]:
    """Rewrite or extend packages.x86_64 in an archiso profile dir.

    archiso's packages.<arch> files are one-package-per-line with
    # comments allowed. We preserve comments in append mode (read
    existing, add new at the end). In replace mode we write a fresh
    file with a header comment + the new packages.
    """
    pkg_file = profile_dir / "packages.x86_64"
    try:
        existing = pkg_file.read_text(encoding="utf-8") if pkg_file.is_file() else ""
    except (PermissionError, OSError) as exc:
        return {"error": str(exc)}

    if mode == "append":
        # Parse existing package names (preserve comments + order).
        existing_pkgs: list[str] = []
        for line in existing.splitlines():
            hash_idx = line.find("#")
            if hash_idx >= 0:
                line = line[:hash_idx]
            name = line.strip()
            if name and name not in existing_pkgs:
                existing_pkgs.append(name)
        seen = set(existing_pkgs)
        for p in packages:
            if p not in seen:
                existing_pkgs.append(p)
                seen.add(p)
        final = existing_pkgs
        # Preserve the existing file's comment header if present, then
        # write the deduped package list.
        header_lines = []
        for line in existing.splitlines():
            if line.strip().startswith("#"):
                header_lines.append(line)
            else:
                break
        new_lines = header_lines
        if header_lines and header_lines[-1].strip() != "":
            new_lines.append("")
        for p in final:
            new_lines.append(p)
        new_content = "\n".join(new_lines) + "\n"
    else:  # replace
        new_content = "# Package list (written by sysdeck-builder v0.0.49)\n"
        for p in packages:
            new_content += f"{p}\n"

    try:
        pkg_file.write_text(new_content, encoding="utf-8")
    except (PermissionError, OSError) as exc:
        return {"error": str(exc)}
    return {"path": str(pkg_file), "count": len(packages) if mode == "replace"
            else len(final), "mode": mode}


def _write_packages_live_build(profile_dir: Path, packages: list[str], mode: str) -> dict[str, Any]:
    """Write config/package-lists/sysdeck.list in a live-build profile dir.

    live-build merges all `config/package-lists/*.list` files at build
    time, so each list file is an independent package set. In replace
    mode we delete any existing sysdeck.list (and other operator-added
    .list files in the same dir that were created by this command —
    tracked via a header comment) and write a fresh one. In append mode
    we just write/overwrite sysdeck.list (the file is the unit).
    """
    lists_dir = profile_dir / "config" / "package-lists"
    pkg_file = lists_dir / "sysdeck.list"
    try:
        lists_dir.mkdir(parents=True, exist_ok=True)
    except (PermissionError, OSError) as exc:
        return {"error": str(exc)}

    if mode == "replace":
        # Remove any existing sysdeck.list files (including ones we
        # wrote previously under variant names like sysdeck-<n>.list).
        # We do NOT touch other .list files that shipped with the
        # baseline profile — those are the distro's responsibility.
        try:
            for f in lists_dir.glob("sysdeck*.list"):
                f.unlink()
        except (PermissionError, OSError) as exc:
            return {"error": str(exc)}

    new_content = "# Package list (written by sysdeck-builder v0.0.49)\n"
    for p in packages:
        new_content += f"{p}\n"
    try:
        pkg_file.write_text(new_content, encoding="utf-8")
    except (PermissionError, OSError) as exc:
        return {"error": str(exc)}
    return {"path": str(pkg_file), "count": len(packages), "mode": mode}


def _write_packages(profile_path: str, backend: str, packages_text: str, mode: str) -> dict[str, Any]:
    """Dispatch to the per-backend package writer.

    `profile_path` is the path returned by profiles() (a file for
    mkosi/vmdb2, a directory for archiso/live-build). `packages_text`
    is the raw multiline text from the operator (textarea or uploaded
    file content). `mode` is "append" or "replace".

    Returns the writer's result dict on success, or {"error": ...} on
    invalid backend / mode.
    """
    if mode not in ("append", "replace"):
        return {"error": f"invalid mode '{mode}' (must be 'append' or 'replace')"}
    packages = _parse_packages_text(packages_text)
    p = Path(profile_path)
    if backend == "mkosi":
        return _write_packages_mkosi(p, packages, mode)
    if backend == "vmdb2":
        return _write_packages_vmdb2(p, packages, mode)
    if backend == "archiso":
        if not p.is_dir():
            return {"error": f"archiso profile path {p} is not a directory"}
        return _write_packages_archiso(p, packages, mode)
    if backend == "live-build":
        if not p.is_dir():
            return {"error": f"live-build profile path {p} is not a directory"}
        return _write_packages_live_build(p, packages, mode)
    return {"error": f"unknown backend '{backend}' for package writing"}


def profile_delete(args: list[str]) -> dict[str, Any]:
    """Delete a profile config file.

    Usage: profile-delete <name>
    Looks up the profile in the discovered profiles() list and removes
    the file. Refuses to delete shipped profiles (under /usr/share).
    """
    if not args:
        return {"error": "profile name required"}
    name = args[0]
    all_profiles = profiles()
    profile = None
    for p in all_profiles:
        if p.get("name") == name:
            profile = p
            break
    if profile is None:
        return {"error": f"profile '{name}' not found"}
    ppath = profile.get("path")
    if not ppath:
        return {"error": "profile has no path"}
    p = Path(ppath)
    # Refuse to delete shipped profiles under /usr/share.
    try:
        p.resolve().relative_to(Path("/usr/share"))
        return {"error": f"refusing to delete shipped profile {p} (under /usr/share)",
                "hint": "ship your own profile under /etc/ instead"}
    except ValueError:
        pass
    try:
        if p.is_file():
            p.unlink()
        elif p.is_dir():
            # For archiso/live-build profile dirs, refuse unless --force.
            if "--force" not in args[1:]:
                return {"error": f"refusing to delete profile directory {p} without --force"}
            import shutil
            shutil.rmtree(p)
        else:
            return {"error": f"profile path {p} is neither file nor dir"}
        return {"deleted": True, "name": name, "path": ppath}
    except (PermissionError, OSError) as exc:
        return {"deleted": False, "error": str(exc),
                "hint": "run via cockpit superuser channel (polkit org.sysdeck.builder.modify)"}


# ── Host package-list import (v0.1.0) ───────────────────────────────


def _detect_host_packages() -> tuple[list[str], str]:
    """Return (explicitly-installed package list, distro_id) for the host.

    v0.1.3 FIX: previous versions relied on `from __init__ import
    PKG_MANAGER` which silently failed in the cockpit superuser
    channel context (different Python path), causing PKG_MANAGER to
    default to "unknown" and the host query to return an EMPTY list.
    The operator saw "tries to build only 2" because the import wrote
    nothing and the build used the profile's original template packages.

    Now uses shutil.which() to find the package manager binary directly
    — no import dependency, works in any execution context.
    """
    # Try each package manager in order. First one found wins.
    pacman_bin = shutil.which("pacman")
    if pacman_bin:
        cmd = [pacman_bin, "-Qqe"]
        marker = "arch"
    else:
        apt_mark = shutil.which("apt-mark")
        if apt_mark:
            cmd = [apt_mark, "showmanual"]
            marker = "debian"
        else:
            dnf_bin = shutil.which("dnf")
            if dnf_bin:
                cmd = [dnf_bin, "repoquery", "--userinstalled",
                       "--queryformat", "%{name}"]
                marker = "fedora"
            else:
                return [], "unknown"

    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           check=False, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return [], marker

    # If the command failed (non-zero exit), return empty with the
    # marker so the caller can report which distro was detected.
    if r.returncode != 0:
        return [], marker

    pkgs: list[str] = []
    seen: set[str] = set()
    for line in r.stdout.splitlines():
        name = line.strip()
        if not name or name in seen:
            continue
        if name.startswith("#"):
            continue
        seen.add(name)
        pkgs.append(name)
    return pkgs, marker


def profile_import_packages(args: list[str]) -> dict[str, Any]:
    """Import the host's explicitly-installed packages into a profile.

    Usage: profile-import-packages <name> [--mode=append|replace]
                                    [--packages=<json>] [--dry-run]

    Without --packages, queries the host package manager (pacman -Qqe on
    Arch, apt-mark showmanual on Debian, dnf repoquery --userinstalled
    on Fedora) and writes the result into the named profile's package
    list via the existing _write_packages() dispatch.

    --packages=<json> overrides the host query (JSON-decoded multiline
    string) — useful for importing a list captured on a different host.

    --mode defaults to "append" for this command (the operator usually
    wants to layer host packages on top of the profile's existing
    baseline). Pass --mode=replace to wipe the baseline first.

    --dry-run returns what *would* be written without touching the
    profile file. Useful for the JS panel's "Preview" affordance.

    The package list is sanitized through _parse_packages_text (dedup,
    comment stripping, whitespace trim) before being written.
    """
    if not args:
        return {"error": "profile name required"}
    name = args[0]
    positional, opts = _extract_opts(args)
    # _extract_opts strips the leading positional too — re-grab name.
    if not positional:
        return {"error": "profile name required"}
    name = positional[0]
    mode = opts.get("mode", "append")
    if mode not in ("append", "replace"):
        return {"error": f"invalid mode '{mode}' (must be 'append' or 'replace')"}
    dry_run = "dry-run" in opts

    # Look up the profile so we can resolve (backend, path).
    all_profiles = profiles()
    profile = None
    for p in all_profiles:
        if p.get("name") == name:
            profile = p
            break
    if profile is None:
        return {"error": f"profile '{name}' not found"}

    backend_id = profile.get("backend") or (primary["id"] if (primary := _primary_backend() or {}) else "")
    ppath = profile.get("path", "")
    if not ppath:
        return {"error": f"profile '{name}' has no path"}

    # Source: --packages override, or the host query.
    packages_json = opts.get("packages")
    if packages_json:
        try:
            packages_text = json.loads(packages_json)
            if not isinstance(packages_text, str):
                return {"error": "--packages JSON must decode to a string"}
        except json.JSONDecodeError as exc:
            return {"error": f"--packages is not valid JSON: {exc}"}
        source = "manual"
        host_distro = "n/a"
    else:
        packages_text, host_distro = _detect_host_packages()
        # _detect_host_packages returns a list — re-render as multiline
        # text so _write_packages / _parse_packages_text can handle it
        # uniformly with the rest of the pipeline.
        packages_text = "\n".join(packages_text)
        source = f"host:{host_distro}"
        if not packages_text.strip():
            return {"error": f"no packages detected on host (distro={host_distro})",
                    "hint": "install pacman/apt/dnf, or pass --packages=<json> manually"}

    # Dry-run: return what would be written, don't touch the file.
    parsed = _parse_packages_text(packages_text)
    if dry_run:
        return {
            "profile": name,
            "backend": backend_id,
            "source": source,
            "host_distro": host_distro,
            "mode": mode,
            "dry_run": True,
            "package_count": len(parsed),
            "packages": parsed[:200],  # cap to keep JSON sane
            "truncated": len(parsed) > 200,
        }

    # Write via the shared dispatch.
    result = _write_packages(ppath, backend_id, packages_text, mode)
    if "error" in result:
        return result
    return {
        "imported": True,
        "profile": name,
        "backend": backend_id,
        "source": source,
        "host_distro": host_distro,
        "mode": mode,
        **result,
    }


# ── Build status / log / artifacts ──────────────────────────────────


def build_status(_args: list[str] = None) -> list[dict[str, Any]]:
    """List active and recently-finished builds.

    Reads the state files under BUILDER_STATE_DIR and returns them
    sorted by started timestamp descending. The JS panel uses this
    to render a Builds table.
    """
    if not BUILDER_STATE_DIR.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for sf in BUILDER_STATE_DIR.glob("*.json"):
        try:
            state = json.loads(sf.read_text(encoding="utf-8"))
            out.append(state)
        except (json.JSONDecodeError, PermissionError, OSError):
            continue
    out.sort(key=lambda s: s.get("started", ""), reverse=True)
    return out


def build_log(args: list[str]) -> dict[str, Any]:
    """Return the contents of a build's log file.

    Usage: build-log <build-id>
    Returns the full log text (capped at 1MB to avoid blowing up the
    JSON response for huge builds). The JS panel renders this in a
    <pre>.
    """
    if not args:
        return {"error": "build-id required"}
    build_id = args[0]
    log_path = _build_log_path(build_id)
    if not log_path.is_file():
        return {"error": f"no log file for build {build_id}", "build_id": build_id}
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
        # Cap at 1MB.
        if len(text) > 1_000_000:
            text = f"[truncated — log is {len(text)} bytes, showing last 1MB]\n" + text[-1_000_000:]
        return {"build_id": build_id, "log": text, "path": str(log_path)}
    except (PermissionError, OSError) as exc:
        return {"error": str(exc), "build_id": build_id}


def artifacts(args: list[str]) -> dict[str, Any]:
    """List build artifacts.

    Usage: artifacts [profile]
    Without a profile arg, lists artifacts across all profiles.
    With a profile arg, lists artifacts for that profile only.
    """
    if not BUILDER_ARTIFACTS_DIR.is_dir():
        return {"artifacts": [], "by_profile": {}}
    profile_filter = args[0] if args else None
    by_profile: dict[str, list[dict[str, Any]]] = {}
    if profile_filter:
        profiles_to_scan = [BUILDER_ARTIFACTS_DIR / profile_filter]
    else:
        profiles_to_scan = [p for p in BUILDER_ARTIFACTS_DIR.iterdir() if p.is_dir()]
    for prof_dir in profiles_to_scan:
        if not prof_dir.is_dir():
            continue
        files: list[dict[str, Any]] = []
        for f in sorted(prof_dir.iterdir()):
            if not f.is_file():
                continue
            try:
                sz = f.stat().st_size
                import datetime
                mtime = datetime.datetime.fromtimestamp(f.stat().st_mtime).isoformat()
            except OSError:
                sz, mtime = 0, None
            files.append({"name": f.name, "path": str(f), "size": sz, "modified": mtime})
        by_profile[prof_dir.name] = files
    return {"by_profile": by_profile, "artifacts": sum(len(v) for v in by_profile.values())}


def artifact_delete(args: list[str]) -> dict[str, Any]:
    """Delete a single build artifact file.

    Usage: artifact-delete <profile> <name>
    Removes /var/lib/sysdeck/builder/artifacts/<profile>/<name>.
    Refuses to delete files outside the artifacts dir (safety).
    """
    if len(args) < 2:
        return {"error": "usage: artifact-delete <profile> <name>"}
    profile = args[0]
    name = args[1]
    # Resolve the artifact path safely.
    prof_dir = BUILDER_ARTIFACTS_DIR / profile
    target = (prof_dir / name).resolve()
    try:
        target.relative_to(BUILDER_ARTIFACTS_DIR.resolve())
    except (ValueError, RuntimeError):
        return {"error": f"refusing to delete: path '{target}' is not under {BUILDER_ARTIFACTS_DIR}"}
    if not target.is_file():
        return {"error": f"artifact not found: {target}"}
    try:
        sz = target.stat().st_size
        target.unlink()
    except (PermissionError, OSError) as exc:
        return {"error": str(exc),
                "hint": "run via cockpit superuser channel (polkit org.sysdeck.builder.modify)"}
    return {"deleted": True, "profile": profile, "name": name, "path": str(target), "size": sz}


def artifacts_clear(args: list[str]) -> dict[str, Any]:
    """Delete ALL artifacts for a profile.

    Usage: artifacts-clear <profile>
    Removes /var/lib/sysdeck/builder/artifacts/<profile>/ entirely.
    """
    if not args:
        return {"error": "usage: artifacts-clear <profile>"}
    profile = args[0]
    prof_dir = BUILDER_ARTIFACTS_DIR / profile
    if not prof_dir.is_dir():
        return {"error": f"no artifacts directory for profile '{profile}'"}
    # Count files before deletion.
    file_count = 0
    total_size = 0
    for f in prof_dir.rglob("*"):
        if f.is_file():
            try:
                total_size += f.stat().st_size
                file_count += 1
            except OSError:
                pass
    try:
        shutil.rmtree(prof_dir)
    except (PermissionError, OSError) as exc:
        return {"error": str(exc),
                "hint": "run via cockpit superuser channel (polkit org.sysdeck.builder.modify)"}
    return {"cleared": True, "profile": profile, "files_deleted": file_count,
            "bytes_freed": total_size}


def build_delete(args: list[str]) -> dict[str, Any]:
    """Delete a build's state + log files, optionally its artifacts.

    Usage: build-delete <build-id> [--artifacts]
    Removes state + log for the build. With --artifacts, also clears
    the profile's entire artifacts dir.

    v0.1.3: reads the state file FIRST (to get the profile name for
    artifact cleanup) before deleting it.
    """
    if not args:
        return {"error": "build-id required"}
    build_id = args[0]
    delete_artifacts = "--artifacts" in args[1:]
    deleted = []
    errors = []
    # Read state file first to get the profile name (for artifact cleanup).
    state_file = BUILDER_STATE_DIR / f"{build_id}.json"
    profile_name = None
    if state_file.is_file():
        try:
            state_data = json.loads(state_file.read_text(encoding="utf-8"))
            profile_name = state_data.get("profile")
        except (json.JSONDecodeError, PermissionError, OSError):
            pass
    # Delete state file.
    if state_file.is_file():
        try:
            state_file.unlink()
            deleted.append(str(state_file))
        except (PermissionError, OSError) as exc:
            errors.append(f"state: {exc}")
    # Delete log file.
    log_file = BUILDER_LOGS_DIR / f"{build_id}.log"
    if log_file.is_file():
        try:
            log_file.unlink()
            deleted.append(str(log_file))
        except (PermissionError, OSError) as exc:
            errors.append(f"log: {exc}")
    # Optionally delete artifacts.
    if delete_artifacts and profile_name:
        prof_dir = BUILDER_ARTIFACTS_DIR / profile_name
        if prof_dir.is_dir():
            try:
                shutil.rmtree(prof_dir)
                deleted.append(str(prof_dir) + "/ (artifacts dir)")
            except (PermissionError, OSError) as exc:
                errors.append(f"artifacts: {exc}")
    if not deleted and not errors:
        return {"error": f"no build found with id '{build_id}'"}
    return {"deleted": True, "build_id": build_id, "profile": profile_name,
            "files": deleted, "errors": errors}


COMMANDS = {
    # v0.0.30 viewer subcommands (kept):
    "status":          lambda _args: status(),
    "profiles":        lambda _args: profiles(),
    "summary":         lambda _args: summary(),
    "backends":        lambda _args: backends(),
    "install-hint":    lambda _args: install_hint(),
    # v0.0.31 full-featured subcommands:
    "build":           lambda args: build(args),
    "profile-create":  lambda args: profile_create(args),
    "profile-copy":    lambda args: profile_copy(args),
    "profile-delete":  lambda args: profile_delete(args),
    # v0.1.0: import host's explicitly-installed packages into a profile.
    "profile-import-packages": lambda args: profile_import_packages(args),
    "build-status":    lambda args: build_status(args),
    "build-log":       lambda args: build_log(args),
    "build-delete":    lambda args: build_delete(args),
    "artifacts":       lambda args: artifacts(args),
    # v0.1.3: artifact management — delete + clear.
    "artifact-delete": lambda args: artifact_delete(args),
    "artifacts-clear": lambda args: artifacts_clear(args),
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
