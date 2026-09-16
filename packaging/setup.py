#!/usr/bin/env python3
"""
SysDeck - setup.py
Author: Jeremy Anderson (https://dcos.net)

Pip-installable package that lays out the Cockpit plugin suite under
/usr/share/cockpit/sysdeck-*/ (one directory per plugin) and the Python
bridge helpers under /usr/lib/sysdeck/bridge/.

Works on all supported distros (Arch, Debian, Fedora/RHEL).
The distro detection at install time determines which Python
site-packages directory gets the bridge symlink.

Usage:
    pip3 install packaging/
    pip3 install packaging/ --target=/tmp/overlay

The standalone web console (web/) is not installed by this package —
it ships in the master tarball and runs from its own directory.
"""

import os
import shutil
import subprocess
from setuptools import setup

VERSION = "0.4.4"
PACKAGE = "sysdeck"

# The repository root (setup.py lives in packaging/).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def repo(*parts):
    """Path to a file in the repository root."""
    return os.path.join(ROOT, *parts)


def glob_files(directory, pattern="*"):
    """Return all files matching pattern under directory."""
    result = []
    for root, _dirs, files in os.walk(directory):
        for f in files:
            if pattern == "*" or f.endswith(pattern):
                result.append(os.path.join(root, f))
    return result


def plugin_data_files():
    """One data_files entry per sysdeck-* plugin directory.

    The multi-plugin layout (v0.0.20+): each plugins/sysdeck-<name>/
    directory installs to /usr/share/cockpit/sysdeck-<name>/.
    """
    entries = []
    plugins_dir = repo("plugins")
    if not os.path.isdir(plugins_dir):
        return entries
    for name in sorted(os.listdir(plugins_dir)):
        pdir = os.path.join(plugins_dir, name)
        if not os.path.isdir(pdir) or not name.startswith("sysdeck-"):
            continue
        files = [
            os.path.join(pdir, f)
            for f in sorted(os.listdir(pdir))
            if f.endswith((".json", ".html", ".js", ".css"))
        ]
        if files:
            entries.append((f"/usr/share/cockpit/{name}", files))
    return entries


def detect_distro():
    """Detect distro for distro-aware post-install actions."""
    try:
        with open("/etc/os-release", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("ID="):
                    return line.split("=", 1)[1].strip().strip('"').lower()
    except (FileNotFoundError, PermissionError):
        pass
    return "unknown"


def _existing(*parts):
    """Return the path when it exists, else None (tolerant helper)."""
    path = repo(*parts)
    return path if os.path.exists(path) else None


def _dir_files(*parts, ext):
    """All files with the given suffix in a repository directory."""
    directory = repo(*parts)
    if not os.path.isdir(directory):
        return []
    return [
        os.path.join(directory, f)
        for f in sorted(os.listdir(directory))
        if f.endswith(ext)
    ]


setup(
    name=PACKAGE,
    version=VERSION,
    description=(
        "Unified operations surface for Linux infrastructure — the Cockpit "
        "plugin edition (27 domain modules plus the Python bridge); the "
        "standalone web console ships in the master tarball."
    ),
    long_description=open(repo("README.md")).read() if os.path.exists(repo("README.md")) else "",
    long_description_content_type="text/markdown",
    author="Jeremy Anderson",
    author_email="info@dcos.net",
    url="https://dcos.net",
    license="MIT",
    python_requires=">=3.9",
    extras_require={
        "glances": ["glances"],
        "benchmark": ["sysbench"],
    },
    data_files=(
        plugin_data_files()
        + [
            # Shared bridge + styles: /usr/share/cockpit/sysdeck-common/
            # (the manifest.json is REQUIRED — without it every
            # /cockpit/@localhost/sysdeck-common/bridge.js URL 404s)
            (
                "/usr/share/cockpit/sysdeck-common",
                [
                    p
                    for p in (
                        _existing("shared", "manifest.json"),
                        _existing("shared", "bridge.js"),
                        _existing("shared", "sysdeck.css"),
                        _existing("shared", "sysdeck-web.css"),
                    )
                    if p
                ],
            ),
            # Python bridge helpers: /usr/lib/sysdeck/bridge/
            # (invoked by absolute path — python3 /usr/lib/sysdeck/bridge/<module>.py)
            ("/usr/lib/sysdeck/bridge", _dir_files("bridge", ext=".py")),
            ("/usr/lib/sysdeck/bridge/modules", _dir_files("bridge", "modules", ext=".py")),
            # Firewall templates + policies: /usr/share/sysdeck/firewall/
            ("/usr/share/sysdeck/firewall/templates", _dir_files("firewall", "templates", ext=".sh")),
            ("/usr/share/sysdeck/firewall/policies", _dir_files("firewall", "policies", ext=".yaml")),
            # Prometheus + Grafana provisioning: /usr/share/sysdeck/prometheus/
            ("/usr/share/sysdeck/prometheus", _dir_files("prometheus", ext=".yml")),
            # Documentation: /usr/share/doc/sysdeck/
            (
                "/usr/share/doc/sysdeck",
                [
                    p
                    for p in (
                        _existing("README.md"),
                        _existing("QUICKSTART.md"),
                        _existing("LICENSE"),
                    )
                    if p
                ],
            ),
        ]
    ),
    classifiers=[
        "Development Status :: 4 - Beta",
        "Environment :: Web Environment",
        "Intended Audience :: System Administrators",
        "License :: OSI Approved :: MIT License",
        "Operating System :: POSIX :: Linux",
        "Programming Language :: JavaScript",
        "Programming Language :: Python :: 3",
        "Topic :: System :: Systems Administration",
    ],
)
