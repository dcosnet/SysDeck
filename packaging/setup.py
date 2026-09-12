#!/usr/bin/env python3
"""
SysDeck - setup.py
Author: Jeremy Anderson (https://dcos.net)

Pip-installable package that lays out the cockpit plugin under
/usr/share/cockpit/sysdeck/ and the Python bridge under
/usr/lib/sysdeck/.

Works on all supported distros (Arch, Debian, Fedora/RHEL).
The distro detection at install time determines which Python
site-packages directory gets the bridge symlink.

Usage:
    pip3 install .
    pip3 install . --target=/tmp/overlay
"""

import os
import shutil
import subprocess
from setuptools import setup, find_packages

VERSION = "0.4.3"
PACKAGE = "sysdeck"


def glob_files(directory, pattern="*"):
    """Return all files matching pattern under directory."""
    result = []
    for root, _dirs, files in os.walk(directory):
        for f in files:
            if pattern == "*" or f.endswith(pattern):
                result.append(os.path.join(root, f))
    return result


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


setup(
    name=PACKAGE,
    version=VERSION,
    description="Unified operations surface for Linux infrastructure — eighteen domain modules behind one cockpit dashboard with live bridge channel integration.",
    long_description=open("README.md").read() if os.path.exists("README.md") else "",
    long_description_content_type="text/markdown",
    author="Jeremy Anderson",
    author_email="info@dcos.net",
    url="https://dcos.net",
    license="MIT",
    python_requires=">=3.9",
    packages=find_packages(where="bridge") + ["tests"],
    package_dir={"": "bridge", "tests": "tests"},
    extras_require={
        "glances": ["glances"],
        "benchmark": ["sysbench"],
    },
    data_files=[
        # Cockpit plugin root: manifest + entry HTML + bundle + styles + logo
        (f"/usr/share/cockpit/{PACKAGE}", [
            "manifest.json", "index.html", "suite.js", "suite.css", "logo.svg",
            "README.md", "LICENSE",
        ]),
        # ES module sources — needed at runtime for dynamic imports
        (f"/usr/share/cockpit/{PACKAGE}/src", glob_files("src")),
        (f"/usr/share/cockpit/{PACKAGE}/src/modules", [
            f"src/modules/{f}" for f in os.listdir("src/modules") if f.endswith(".js")
        ]),
        # Type declarations + dev mock
        (f"/usr/share/cockpit/{PACKAGE}/src", [
            "src/cockpit-types.d.ts",
            "src/mock-cockpit.js",
        ]),
    ],
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
