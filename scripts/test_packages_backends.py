#!/usr/bin/env python3
"""Standalone fixture tests for the ten-backend packages bridge parsers.

Runs outside the unittest suite for quick iteration; the same fixtures
live in tests/test_bridge_parsers.py (TestPackagesBackends)."""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bridge"))
import packages as p  # noqa: E402


def check_zypper_table():
    layout_a = (
        "S | Repository       | Name       | Current | Available | Arch\n"
        "--+------------------+------------+---------+-----------+-------\n"
        "v | openSUSE-OSS     | glib2      | 2.78     | 2.80      | x86_64\n"
        "  | openSUSE-OSS     | zypper     | 1.14.70  | 1.14.74   | x86_64"
    )
    h, r = p._zypper_table(layout_a, ("Name", "Current", "Available"))
    assert h == {"Name": 2, "Current": 3, "Available": 4}, h
    assert len(r) == 2
    print("zypper layout A (status+repo prefix) OK")

    layout_b = (
        "S# | Repository       | Name       | Current | Available | Arch\n"
        "---+------------------+------------+---------+-----------+-------\n"
        " 1 | openSUSE-OSS     | glib2      | 2.78     | 2.80      | x86_64"
    )
    h, r = p._zypper_table(layout_b, ("Name", "Current", "Available"))
    assert r and r[0][2] == "glib2"
    print("zypper layout B (numbered prefix) OK")

    se = (
        "S | Name        | Summary                    | Type\n"
        "--+-------------+----------------------------+-----------\n"
        "  | packagekit  | PackageKit service         | package\n"
        "i | glib2       | GLib library               | package"
    )
    h, r = p._zypper_table(se, ("Name", "Summary"))
    assert h == {"Name": 1, "Summary": 2}, h
    assert r[1][0] == "i"
    print("zypper se table OK")

    noisy = (
        "Name | Current | Available\n"
        "-----+---------+----------\n"
        "glib2 | 2.78 | 2.80\n"
        "Name | Current | Available\n"
        "bash | 5.2 | 5.3"
    )
    h, r = p._zypper_table(noisy, ("Name", "Current", "Available"))
    assert len(r) == 2 and r[1][0] == "bash", r
    print("separator + repeat-header filtering OK")


def check_emerge_regex():
    rx = r"\[ebuild\s+U[^\]]*\]\s*(\S+)(?:\s+\[([^\]]+)\])?"
    m = re.search(rx, " [ebuild     U     ] dev-lang/python-3.12.4 [3.12.3]")
    assert m and m.group(1) == "dev-lang/python-3.12.4" and m.group(2) == "3.12.3", m.groups()
    assert re.search(rx, " [ebuild  NS    ] dev-lang/python-3.11.8 [3.11.6]") is None
    assert re.search(rx, " [ebuild  N     ] app-misc/newpkg-1.0") is None
    m = re.search(rx, " [ebuild     U  r  ] sys-libs/glibc-2.38-r9 [2.37-r7]")
    assert m and m.group(1) == "sys-libs/glibc-2.38-r9" and m.group(2) == "2.37-r7", m.groups()
    print("emerge update regex OK (padded class field; N/NS rows excluded)")


def check_xbps_regexes():
    m = re.match(r"^ii\s+(\S+)\s+(.*)$", "ii firefox-128.0_1 The Firefox web browser")
    assert m and m.group(1) == "firefox-128.0_1"
    # -Rs rows may or may not carry a repository prefix.
    rx = r"^\[\*\]\s+(?:\S+/)?(\S+)\s+-\s+(.*)$"
    m = re.match(rx, "[*] firefox-128.0_1 - The Firefox web browser")
    assert m and m.group(1) == "firefox-128.0_1" and m.group(2) == "The Firefox web browser"
    m = re.match(rx, "[*] void-repo/firefox-128.0_1 - The Firefox web browser")
    assert m and m.group(1) == "firefox-128.0_1", m.groups()
    print("xbps regexes OK")


def check_helpers():
    info = p._parse_colon_blocks("Name        : curl\nVersion     : 8.6.0\nInstalled Size: 1.2 MiB")
    assert info["name"] == "curl" and info["version"] == "8.6.0"
    assert info["installed_size"] == "1.2 MiB"
    assert p._split_name_ver("gcc-13.2.1-r0") == ("gcc", "13.2.1-r0")
    assert p._split_name_ver("linux-headers-6.1") == ("linux-headers", "6.1")
    assert p._split_name_ver("firefox-128.0_1") == ("firefox", "128.0_1")
    assert p._split_name_ver("bash") == ("bash", "")
    print("colon blocks + split_name_ver OK")


def check_fallbacks():
    orig = p.run
    p.run = lambda argv, timeout=60, ok_rcs=(): ""
    assert p._lunar_list_installed() == []
    assert p._sorcery_list_installed() == []
    assert p._lunar_list_updates() == []
    p.run = orig
    print("lunar/sorcery honest-empty fallbacks OK")


def check_mutation_table():
    for mgr in ("pacman", "emerge", "lunar", "sorcery", "xbps", "apk",
                "zypper", "dnf", "yum", "apt"):
        p.PKG_MANAGER = mgr
        assert p._mutation_cmd("install", "x"), mgr
        assert p._mutation_cmd("remove", "x"), mgr
        assert p._mutation_cmd("update-all", ""), mgr
        if mgr != "lunar":
            assert p._mutation_cmd("update", "x"), mgr
        else:
            assert p._mutation_cmd("update", "x") == [], mgr
    p.PKG_MANAGER = "unknown"
    assert p._mutation_cmd("install", "x") == []
    p.PKG_MANAGER = p._detect_pkg_manager()
    print("mutation table covers all ten managers (lunar update honestly absent) OK")


def check_detection_probes():
    ids = [m for m, _ in p.DETECT_PROBES]
    assert ids == ["pacman", "emerge", "lunar", "sorcery", "xbps",
                   "apk", "zypper", "dnf", "yum", "apt"], ids
    # xbps must probe xbps-query: Void ships no bare `xbps` binary.
    assert dict(p.DETECT_PROBES)["xbps"] == "xbps-query"
    print("detection probe order + xbps-query probe OK")


if __name__ == "__main__":
    check_zypper_table()
    check_emerge_regex()
    check_xbps_regexes()
    check_helpers()
    check_fallbacks()
    check_mutation_table()
    check_detection_probes()
    print("ALL PACKAGES-BACKEND CHECKS OK")
