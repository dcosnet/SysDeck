# SysDeck - Makefile
# Author: Jeremy Anderson (https://dcos.net)
#
# v0.3.0 AI GATEWAY EDITION: two distributions in one tree —
#   /        the cockpit edition: 27 standalone Cockpit plugins + shared bridge
#   /web     the SysDeck Web Edition (Next.js console, 29 bridge modules)
#   /klanker-gate — the Frosty Deno LLM gateway, vendored + pre-integrated
#                  (by TykoDev, https://github.com/TykoDev/klanker-gate,
#                  Apache-2.0 — not SysDeck code; own version 0.9.0, with
#                  arch/ packaging for Arch Linux)
#   /web/mini-services/fester — Fester, vendored + pre-integrated (own version 0.2.1)
# Each plugin ships to /usr/share/cockpit/sysdeck-<name>/ and appears as
# its own sidebar entry in Cockpit. The Python bridge helpers stay at
# /usr/lib/sysdeck/bridge/ (called via cockpit.spawn).
#
# Targets:
#   make install     - install all 27 plugins + bridge + scripts + firewall templates
#   make uninstall   - remove all 27 plugins + bridge + scripts
#   make check       - validate all manifests against cockpit-podman pattern,
#                      syntax-check JS/Python/shell sources, run unit tests
#   make plugins     - verify plugins/ + shared/ match the generator catalog
#   make clean       - remove build artifacts
#   make dist        - build the source tarball (runs check first)
#   make distcheck   - extract the tarball into a clean dir and run check inside
#   make fester-start - run the vendored fester service on :3010 (bun)
#   make web-install  - install + migrate the web edition (bun + prisma)
#   make web-dev      - start fester (background) + the web console on :3000
#   make master       - build the master tarball (cockpit + web + fester)
#
# Distro support: Arch Linux, Debian/Ubuntu, Fedora/RHEL/CentOS.

PACKAGE := sysdeck
VERSION := 0.4.5
LIB_DIR := $(DESTDIR)/usr/lib/$(PACKAGE)
PYTHON_DIR := $(LIB_DIR)/bridge
SHARE_DIR := $(DESTDIR)/usr/share/$(PACKAGE)
# Firewall templates (pre-built nftables rulesets the operator selects
# from the panel — applied via the org.sysdeck.firewall.modify polkit
# action). Seven topologies ship; operators can drop more in.
FIREWALL_TEMPLATES_DIR := $(SHARE_DIR)/firewall/templates

# Python bridge helpers (called via `python3 -m sysdeck.bridge.<module>`).
PY_FILES := $(wildcard bridge/*.py bridge/modules/*.py)

# Unit tests.
TEST_FILES := $(wildcard tests/*.py)

# Documentation.
DOC_FILES := $(wildcard docs/*.md)

# AppStream metainfo + PolKit policy.
METAINFO_FILE := packaging/sysdeck.metainfo.xml
POLKIT_FILE := packaging/polkit/org.sysdeck.policy

# Diagnostic + smoke-test scripts.
DIAGNOSE_SCRIPT := sysdeck-diagnose.sh
SMOKE_TEST_SCRIPT := cockpit-smoke-test.sh
UNINSTALL_SCRIPT := sysdeck-uninstall.sh

# Generator script (regenerates plugins/ and shared/).
GENERATOR := scripts/generate-plugins.py

.PHONY: install uninstall check clean dist distcheck plugins fester-start web-install web-dev master install-branding uninstall-branding

# ─── plugins: verify the tree against the generator catalog ─────────
# The shipped plugins/ and shared/ assets are hand-maintained source;
# the generator VERIFIES catalog <-> disk consistency and never writes.
# (--force exists only to bootstrap a tree with missing plugin dirs.)
plugins:
	@echo ">>> Verifying plugins/ and shared/ against the catalog in $(GENERATOR)"
	python3 $(GENERATOR)

# ─── install: 27 visible plugins + shared/ + bridge + scripts + metainfo ────
install:
	@echo ">>> Installing $(PACKAGE) $(VERSION): 27 standalone Cockpit plugins"
	# Each plugin: /usr/share/cockpit/sysdeck-<name>/{manifest.json,index.html,<module>.js}
	@for plugin in plugins/sysdeck-*; do \
	    [ -d "$$plugin" ] || continue; \
	    name=$$(basename "$$plugin"); \
	    destdir=$(DESTDIR)/usr/share/cockpit/$$name; \
	    install -d "$$destdir"; \
	    for f in $$plugin/manifest.json $$plugin/index.html $$plugin/*.js; do \
		[ -f "$$f" ] || continue; \
		install -m 0644 "$$f" "$$destdir/$$(basename $$f)"; \
	    done; \
	    echo "    installed $$name"; \
	done
	# Shared bridge + CSS + manifest: /usr/share/cockpit/sysdeck-common/
	# The manifest.json is REQUIRED — without it, cockpit doesn't register
	# sysdeck-common as a package, and every URL like
	# /cockpit/@localhost/sysdeck-common/bridge.js returns 404.
	# Verified from cockpit's pkg/static/manifest.json (just `{}`).
	install -d $(DESTDIR)/usr/share/cockpit/sysdeck-common
	install -m 0644 shared/manifest.json $(DESTDIR)/usr/share/cockpit/sysdeck-common/manifest.json
	install -m 0644 shared/bridge.js   $(DESTDIR)/usr/share/cockpit/sysdeck-common/bridge.js
	install -m 0644 shared/sysdeck.css $(DESTDIR)/usr/share/cockpit/sysdeck-common/sysdeck.css
	# v0.3.0: the web-edition skin (midnight/teal design of the Next.js
	# console) — every plugin index.html links it after base sysdeck.css.
	# Remove the file to revert plugin pages to the classic 0.1.x skin.
	install -m 0644 shared/sysdeck-web.css $(DESTDIR)/usr/share/cockpit/sysdeck-common/sysdeck-web.css
	# Python bridge helpers: /usr/lib/sysdeck/bridge/
	# v0.0.27: install each helper as an executable script (0755, not 0644)
	# so they can be invoked by absolute path:
	#   python3 /usr/lib/sysdeck/bridge/glances.py snapshot
	# No PYTHONPATH or symlink needed — the JS calls them directly.
	# Each helper has a `if __name__ == "__main__": sys.exit(main(sys.argv[1:]))` guard.
	install -d $(PYTHON_DIR)
	@for f in $(PY_FILES); do \
	    rel=$$(echo $$f | sed 's|^bridge/||'); \
	    install -d $$(dirname $(PYTHON_DIR)/$$rel); \
	    install -m 0755 $$f $(PYTHON_DIR)/$$rel; \
	done
	# Unit tests: /usr/lib/sysdeck/tests/
	install -d $(LIB_DIR)/tests
	@for f in $(TEST_FILES); do \
	    rel=$$(echo $$f | sed 's|^tests/||'); \
	    install -m 0644 $$f $(LIB_DIR)/tests/$$rel; \
	done
	# Documentation: /usr/share/doc/sysdeck/
	install -d $(DESTDIR)/usr/share/doc/$(PACKAGE)
	@for f in $(DOC_FILES); do \
	    install -m 0644 $$f $(DESTDIR)/usr/share/doc/$(PACKAGE)/$$(basename $$f); \
	done
	install -m 0644 README.md     $(DESTDIR)/usr/share/doc/$(PACKAGE)/README.md
	install -m 0644 QUICKSTART.md $(DESTDIR)/usr/share/doc/$(PACKAGE)/QUICKSTART.md
	install -m 0644 LICENSE       $(DESTDIR)/usr/share/doc/$(PACKAGE)/LICENSE
	# Diagnostic + smoke-test scripts: /usr/share/sysdeck/
	install -d $(DESTDIR)/usr/share/$(PACKAGE)
	install -m 0755 $(DIAGNOSE_SCRIPT)   $(DESTDIR)/usr/share/$(PACKAGE)/$(DIAGNOSE_SCRIPT)
	install -m 0755 $(SMOKE_TEST_SCRIPT) $(DESTDIR)/usr/share/$(PACKAGE)/$(SMOKE_TEST_SCRIPT)
	install -m 0755 $(UNINSTALL_SCRIPT) $(DESTDIR)/usr/share/$(PACKAGE)/$(UNINSTALL_SCRIPT)
	# v0.0.31: firewall templates — pre-built nftables rulesets the
	# operator selects from the Firewall panel. The bridge firewall.py
	# `templates` and `apply-template` subcommands read this directory.
	# Templates are executable (0755) because they are invoked by the
	# bridge via `bash <template>.sh start|stop|detect|...` under the
	# org.sysdeck.firewall.modify polkit action.
	# v0.0.36: also install firewall/policies/*.yaml — the Cilium
	# default policy file (cilium-default.yaml) lives here and is
	# applied by cilium.sh `start`. Operator overrides go in
	# /etc/sysdeck/firewall/ (not shipped by the package).
	install -d $(FIREWALL_TEMPLATES_DIR)
	@for f in firewall/templates/*.sh; do \
	    [ -f "$$f" ] || continue; \
	    install -m 0755 $$f $(FIREWALL_TEMPLATES_DIR)/$$(basename $$f); \
	    echo "    installed firewall template: $$(basename $$f)"; \
	done
	install -d $(SHARE_DIR)/firewall/policies
	@for f in firewall/policies/*.yaml; do \
	    [ -f "$$f" ] || continue; \
	    install -m 0644 $$f $(SHARE_DIR)/firewall/policies/$$(basename $$f); \
	    echo "    installed firewall policy: $$(basename $$f)"; \
	done
	# v0.0.43: Prometheus + Grafana config files — scrape configs,
	# alert rules, datasource + dashboard provisioning. Operators
	# include these in their prometheus.yml / grafana provisioning
	# dirs. Shipped read-only at /usr/share/sysdeck/prometheus/.
	install -d $(SHARE_DIR)/prometheus
	@for f in prometheus/*.yml; do \
	    [ -f "$$f" ] || continue; \
	    install -m 0644 $$f $(SHARE_DIR)/prometheus/$$(basename $$f); \
	    echo "    installed monitoring config: $$(basename $$f)"; \
	done
	# AppStream metainfo: /usr/share/metainfo/
	install -d $(DESTDIR)/usr/share/metainfo
	install -m 0644 $(METAINFO_FILE) $(DESTDIR)/usr/share/metainfo/sysdeck.metainfo.xml
	# PolKit policy: /usr/share/polkit-1/actions/
	install -d $(DESTDIR)/usr/share/polkit-1/actions
	install -m 0644 $(POLKIT_FILE) $(DESTDIR)/usr/share/polkit-1/actions/org.sysdeck.policy
	# v0.0.46: 3rd-party-modules polkit action (org.sysdeck.modules3p.modify)
	install -m 0644 packaging/polkit/org.sysdeck.modules3p.policy $(DESTDIR)/usr/share/polkit-1/actions/
	# Host integration (polkit reload, AppStream refresh) runs only
	# on a real install — a DESTDIR staging install (deb/rpm/pacman
	# package build) must never mutate the build host.
	-@if [ -z "$(DESTDIR)" ]; then \
	    if command -v systemctl >/dev/null 2>&1; then \
	        systemctl reload polkit 2>/dev/null || true; \
	    fi; \
	    if command -v appstreamcli >/dev/null 2>&1; then \
	        appstreamcli refresh-cache 2>/dev/null || true; \
	    fi; \
	fi
	@echo ">>> Done. Restart cockpit.socket to pick up the new plugins:"
	@echo "    sudo systemctl restart cockpit.socket"
	@echo ">>> 27 sidebar entries should appear under 'SysDeck <Name>' in Cockpit."

# ─── uninstall: remove EVERY trace of EVERY prior version ──────────
# This target is deliberately over-aggressive. It removes:
#   - /usr/share/cockpit/sysdeck/         (v0.0.9-v0.0.19 single-plugin layout)
#   - /usr/share/cockpit/sysdeck-*/       (v0.0.20+ multi-plugin layout, including sysdeck-common)
#   - /usr/lib/sysdeck/                   (Python bridge helpers, all versions)
#   - /usr/share/sysdeck/                 (diagnostic scripts, v0.0.19+)
#   - /usr/share/doc/sysdeck/             (docs, v0.0.20+)
#   - /usr/share/metainfo/sysdeck.metainfo.xml        (AppStream metainfo, v0.0.17+)
#   - /usr/share/polkit-1/actions/org.sysdeck.policy (PolKit policy, v0.0.17+)
#   - python site-packages sysdeck symlink            (all versions)
#   - the pacman-installed sysdeck package             (if installed via PKGBUILD)
# Without this thorough cleanup, cockpit would discover stale manifests from
# prior versions and serve old broken code instead of the freshly-installed
# new code.
uninstall:
	@echo ">>> Removing EVERY trace of $(PACKAGE) (all prior versions)"
	# Try to remove pacman-tracked package first (if installed that way)
	-@if command -v pacman >/dev/null 2>&1; then \
	    if pacman -Q sysdeck >/dev/null 2>&1; then \
		echo "    removing pacman package 'sysdeck'"; \
		pacman -R --noconfirm sysdeck 2>/dev/null || true; \
	    fi; \
	fi
	# Old single-plugin layout (v0.0.9-v0.0.19): /usr/share/cockpit/sysdeck/
	@if [ -d "$(DESTDIR)/usr/share/cockpit/sysdeck" ]; then \
	    echo "    removing old single-plugin /usr/share/cockpit/sysdeck/ (v0.0.9-v0.0.19 layout)"; \
	    rm -rf "$(DESTDIR)/usr/share/cockpit/sysdeck"; \
	fi
	# New multi-plugin layout (v0.0.20+): /usr/share/cockpit/sysdeck-*
	@for dir in $(DESTDIR)/usr/share/cockpit/sysdeck-*; do \
	    [ -d "$$dir" ] || continue; \
	    echo "    removing $$(basename $$dir)"; \
	    rm -rf "$$dir"; \
	done
	# Python bridge helpers (all versions)
	rm -rf "$(LIB_DIR)"
	# Diagnostic + smoke-test scripts + firewall templates (v0.0.19+)
	# v0.0.31: firewall/templates/*.sh live under here too.
	rm -rf "$(DESTDIR)/usr/share/$(PACKAGE)"
	# Documentation (v0.0.20+)
	rm -rf "$(DESTDIR)/usr/share/doc/$(PACKAGE)"
	# AppStream metainfo (v0.0.17+)
	rm -f "$(DESTDIR)/usr/share/metainfo/sysdeck.metainfo.xml"
	# PolKit policy (v0.0.17+)
	rm -f "$(DESTDIR)/usr/share/polkit-1/actions/org.sysdeck.policy"
	rm -f "$(DESTDIR)/usr/share/polkit-1/actions/org.sysdeck.modules3p.policy"
	# Python site-packages symlink (all versions)
	@SITE_PACKAGES=$$(python3 -c "import site; print(site.getsitepackages()[0])" 2>/dev/null); \
	if [ -n "$$SITE_PACKAGES" ] && [ -L "$(DESTDIR)$$SITE_PACKAGES/$(PACKAGE)" ]; then \
	    echo "    removing python site-packages symlink"; \
	    rm -f "$(DESTDIR)$$SITE_PACKAGES/$(PACKAGE)"; \
	fi
	# Reload polkit + refresh AppStream cache
	-@if command -v systemctl >/dev/null 2>&1; then \
	    systemctl reload polkit 2>/dev/null || true; \
	fi
	-@if command -v appstreamcli >/dev/null 2>&1; then \
	    appstreamcli refresh-cache 2>/dev/null || true; \
	fi
	@echo ">>> Done. Verify with: ls /usr/share/cockpit/ | grep sysdeck"
	@echo ">>> (should print nothing)"
	@echo ">>> Then restart cockpit.socket to flush the sidebar:"
	@echo "    sudo systemctl restart cockpit.socket"

# ─── check: build-time guards ────────────────────────────────────────
check-metainfo-consistency:
	@echo ">>> Checking packaging/sysdeck.metainfo.xml structural consistency"
	@python3 tests/check_metainfo_consistency.py

# check-manifest-consistency: validate EVERY plugin's manifest against
# the working cockpit-podman reference pattern. One bad manifest = the
# plugin silently disappears from the sidebar. Catches:
#   - non-zero `version` field
#   - any top-level field not in cockpit-podman's manifest
#   - a `content` section (real plugins don't declare one)
#   - menu keys other than `index` (the magic key)
#   - `path` field inside menu entries
check-manifest-consistency:
	@echo ">>> Checking all 27 plugin manifests against cockpit-podman reference"
	@python3 tests/check_manifest_consistency.py

check-makefile-recipes:
	@echo ">>> Checking Makefile recipe indentation (must be tabs, not spaces)"
	@if awk '/^[ \t]+[@a-zA-Z#]/{if ($$0 !~ /^\t/) exit 1}' Makefile; then \
	    echo "    OK: all recipe lines use tabs"; \
	else \
	    echo "FAIL: Makefile has recipe lines indented with spaces instead of tabs."; \
	    echo "      Run: perl -i -pe 's{^( {8})+}{ \"\\t\" x (length(\$$&)/8) }e' Makefile"; \
	    exit 1; \
	fi

# check-no-broken-cockpit-import: scan every JS file shipped to plugins/ and
# shared/ for `import cockpit from "..."` — that pattern is broken because
# pkg/base1/cockpit.js is a UMD/IIFE that sets window.cockpit as a global,
# NOT an ES module. The broken import returns undefined, cockpit.spawn()
# throws when mount() runs, and the plugin page stays on "Loading…".
# This was the v0.0.27 root cause of "every plugin stuck on Loading".
# Pattern verified from cockpit's build.js:71-83 (esbuild plugin rewrites
# `import cockpit from "cockpit"` to `module.exports = cockpit`).
check-no-broken-cockpit-import:
	@echo ">>> Checking no JS file uses broken \`import cockpit from\` pattern"
	@hits=$$(grep -rEn '^[[:space:]]*import\s+cockpit\s+from' shared/ plugins/ 2>/dev/null); \
	if [ -n "$$hits" ]; then \
	    echo "FAIL: found 'import cockpit from' in JS files — cockpit.js is NOT an ES module;"; \
	    echo "      use 'const cockpit = window.cockpit' instead. Affected files:"; \
	    echo "$$hits" | sed 's/^/    /'; \
	    exit 1; \
	fi
	echo "    OK: no JS file uses the broken import-cockpit pattern"

# check-bridge-subcommands: cross-check every `bridgeCmd("<module>", ["<sub>"] )`
# call in shared/bridge.js against the COMMANDS dict declared in
# bridge/<module>.py. Catches the v0.0.27 bug class where the JS
# bridge surface references a subcommand the Python helper doesn't
# implement — every call to that bridge method returns
# "Unknown subcommand: X" and the plugin page crashes.
# Examples this guard would have caught in v0.0.27:
#   - bridge.firmware.devices() calling `python3 firmware.py devices`
#     (firmware.py only had `summary`)
#   - bridge.benchmark.runTest(name) calling `python3 benchmark.py run-test`
#     (benchmark.py had no `run-test` subcommand)
check-bridge-subcommands:
	@echo ">>> Cross-checking bridge.js calls vs Python COMMANDS dicts"
	@python3 tests/check_bridge_subcommands.py

# check-no-broken-python-module: verify bridge.js does NOT call
# `python3 -m sysdeck.bridge.X` — that pattern requires a Python package
# layout (sysdeck/bridge/X.py) that doesn't exist in our install.
# v0.0.27 bug: every bridge helper call returned ModuleNotFoundError
# "No module named 'sysdeck.bridge'" because the actual layout is
# /usr/lib/sysdeck/bridge/X.py (flat files, not a nested package).
# v0.0.27 fix: call helpers by absolute path:
#   python3 /usr/lib/sysdeck/bridge/X.py <args>
check-no-broken-python-module:
	@echo ">>> Checking no JS file uses broken \`python3 -m sysdeck.bridge\` pattern"
	@hits=$$(grep -rEn '"python3".*"-m".*"sysdeck\.bridge' shared/ plugins/ 2>/dev/null); \
	if [ -n "$$hits" ]; then \
	    echo "FAIL: found 'python3 -m sysdeck.bridge' in JS files — this pattern"; \
	    echo "      requires a Python package layout (sysdeck/bridge/X.py) that doesn't"; \
	    echo "      exist. Use 'python3 /usr/lib/sysdeck/bridge/X.py' (absolute path)."; \
	    echo "      Affected files:"; \
	    echo "$$hits" | sed 's/^/    /'; \
	    exit 1; \
	fi
	echo "    OK: no JS file uses the broken python3 -m sysdeck.bridge pattern"

# check-release-tree: supply-chain gate from docs/SECURITY-HARDENING.md —
# a release tarball builds from a clean tree, never from a working copy
# with uncommitted edits (the 2019 Webmin build-host compromise class).
# Steps down by environment: git tree → git status must be clean;
# plain tarball tree → skip (nothing to verify against).
check-release-tree:
	@if [ -d .git ]; then \
	    if [ -n "$$(git status --porcelain 2>/dev/null)" ]; then \
		echo "FAIL: working tree has uncommitted changes — commit or stash before building a release."; \
		git status --porcelain | sed 's/^/    /'; \
		exit 1; \
	    fi; \
	    echo "    OK: git working tree is clean"; \
	else \
	    echo "    OK: not a git tree (tarball build) — nothing to verify"; \
	fi

check-version-sync:
	@echo ">>> Checking version consistency across release surfaces"
	@v=$(VERSION); \
	for f in \
	    bridge/__init__.py \
	    packaging/setup.py \
	    packaging/PKGBUILD \
	    packaging/sysdeck.spec \
	    packaging/debian/changelog \
	    compat/compat-manifest.json \
	; do \
	    if ! grep -q "$$v" "$$f" 2>/dev/null; then \
		echo "FAIL: $$f does not reference version $$v"; \
		exit 1; \
	    fi; \
	done; \
	echo "    OK: all release surfaces report v$$v"

check: check-metainfo-consistency check-manifest-consistency check-makefile-recipes check-no-broken-cockpit-import check-no-broken-python-module check-bridge-subcommands check-version-sync check-release-tree
	@echo ">>> Syntax-checking Python sources"
	@python3 -m py_compile bridge/*.py bridge/modules/*.py
	@echo ">>> Syntax-checking JS sources (node --check)"
	@for f in shared/bridge.js plugins/*/*.js; do \
	    node --check $$f || exit 1; \
	done
	@echo ">>> Validating all manifest.json files"
	@for f in plugins/*/manifest.json; do \
	    python3 -c "import json; json.load(open('$$f'))" || { echo "FAIL: $$f is not valid JSON"; exit 1; }; \
	done
	@echo ">>> Syntax-checking shell scripts"
	@for f in $(DIAGNOSE_SCRIPT) $(SMOKE_TEST_SCRIPT); do \
	    bash -n $$f || { echo "FAIL: $$f has syntax errors"; exit 1; }; \
	done
	@echo ">>> Running bridge parser unit tests"
	@PYTHONPATH=bridge python3 -m unittest tests/test_bridge_parsers.py -v
	@echo ">>> All checks passed."

clean:
	rm -rf build dist *.tar.bz2
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

dist: check
	@echo ">>> Building $(PACKAGE)-$(VERSION).tar.bz2"
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	LC_ALL=C tar cjf $(PACKAGE)-$(VERSION).tar.bz2 \
	    --sort=name \
	    --mtime="@$(SOURCE_DATE_EPOCH)" \
	    --owner=0 --group=0 --numeric-owner \
	    --exclude='__pycache__' \
	    --exclude='*.pyc' \
	    --exclude='*.tar.bz2' \
	    --transform 's,^,$(PACKAGE)-$(VERSION)/,' \
	    plugins shared bridge tests packaging compat standalone-plugins \
	    prometheus scripts firewall \
	    Makefile README.md QUICKSTART.md BLOG.md LICENSE QA.md worklog.md THIRD_PARTY.md docs \
	    sysdeck-diagnose.sh cockpit-smoke-test.sh sysdeck-uninstall.sh
	@echo ">>> $(PACKAGE)-$(VERSION).tar.bz2 ready"

# SOURCE_DATE_EPOCH: pin the tarball mtime for reproducible builds.
# Release builds set it explicitly (e.g. `make dist SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)`);
# unpacked trees without git fall back to a fixed epoch.
SOURCE_DATE_EPOCH ?= 0

# distcheck: verify the tarball extracts into <package>-<version>/ and
# passes `make check` from inside the extracted tree.
distcheck: dist
	@echo ">>> Distcheck: extracting $(PACKAGE)-$(VERSION).tar.bz2"
	DISTCHECK_DIR=$$(mktemp -d /tmp/sysdeck-distcheck.XXXXXX)
	tar xjf $(PACKAGE)-$(VERSION).tar.bz2 -C $$DISTCHECK_DIR
	@if [ ! -d $$DISTCHECK_DIR/$(PACKAGE)-$(VERSION) ]; then \
	    echo "FAIL: tarball did not extract into $(PACKAGE)-$(VERSION)/"; \
	    rm -rf $$DISTCHECK_DIR; \
	    exit 1; \
	fi
	@echo ">>> Distcheck: running make check inside extracted tree"
	@(cd $$DISTCHECK_DIR/$(PACKAGE)-$(VERSION) && make check)
	@rm -rf $$DISTCHECK_DIR
	@echo ">>> Distcheck passed: tarball is self-sufficient and structurally correct."

# ─── v0.3.0 master edition: web + fester + klanker-gate ─────────────────────────────
# Run these from an extracted master tarball (where web/ sits alongside
# this Makefile) or the canonical dev tree with web/ present.

FESTER_DIR := web/mini-services/fester
FESTER_URL ?= http://127.0.0.1:3010
export FESTER_URL

fester-start:
	@echo ">>> Starting the vendored fester service on :3010 (Ctrl+C stops it)"
	cd $(FESTER_DIR) && bun install && bun run dev

web-install:
	@echo ">>> Installing the SysDeck Web Edition (bun + prisma)"
	cd web && bun install && bun run db:push
	cd $(FESTER_DIR) && bun install

web-dev: web-install
	@echo ">>> Starting fester in the background (log: /tmp/fester.log)"
	cd $(FESTER_DIR) && nohup bun run dev >/tmp/fester.log 2>&1 &
	@echo ">>> Starting SysDeck Web Edition on :3000 (Ctrl+C stops next; fester keeps running)"
	cd web && bun run dev

# ─── branding: theme the Cockpit SHELL chrome to the web-edition look ────
# /usr/share/cockpit/branding.css is Cockpit's documented override point
# for the shell (sidebar, header, login). shared/branding.css ports the
# web edition 0.3.0 midnight/teal design onto it. Any pre-existing
# branding.css (shipped by the distro) is backed up first and restored
# by `make uninstall-branding`.
install-branding:
	@echo ">>> Theming the Cockpit shell to the web-edition look"
	-@if test -f $(DESTDIR)/usr/share/cockpit/branding.css; then \
	    cp -a $(DESTDIR)/usr/share/cockpit/branding.css $(DESTDIR)/usr/share/cockpit/branding.css.sysdeck-bak; \
	    echo "    existing branding.css backed up (branding.css.sysdeck-bak)"; \
	fi
	install -d $(DESTDIR)/usr/share/cockpit
	install -m 0644 shared/branding.css $(DESTDIR)/usr/share/cockpit/branding.css
	@echo "    installed /usr/share/cockpit/branding.css"
	@echo "    reload the Cockpit page (hard refresh) to see the shell skin"

uninstall-branding:
	@echo ">>> Restoring the Cockpit shell branding"
	rm -f $(DESTDIR)/usr/share/cockpit/branding.css
	-@if test -f $(DESTDIR)/usr/share/cockpit/branding.css.sysdeck-bak; then \
	    mv $(DESTDIR)/usr/share/cockpit/branding.css.sysdeck-bak $(DESTDIR)/usr/share/cockpit/branding.css; \
	    echo "    restored original branding.css from backup"; \
	else \
	    echo "    no backup found — the distro package owns branding.css"; \
	    echo "    reinstall the cockpit-bridge package to restore defaults"; \
	fi

# master: rebuild the master tarball from this tree (cockpit + web + fester + klanker-gate)
master:
	@echo ">>> Building $(PACKAGE)-$(VERSION)-master.tar.bz2 (cockpit + web + fester + klanker-gate)"
	tar cjf $(PACKAGE)-$(VERSION)-master.tar.bz2 \
	    --exclude='__pycache__' --exclude='*.pyc' --exclude='*.tar.bz2' \
	    --exclude='*node_modules*' --exclude='*.next' --exclude='*.tsbuildinfo' \
	    --exclude='*public/download*' --exclude='*.db' --exclude='*.db-*' \
	    --exclude='dev.log' --exclude='server.log' --exclude='*.log' --exclude='.env' \
	    --transform 's,^,$(PACKAGE)-$(VERSION)-master/,' \
	    bridge plugins shared tests packaging compat standalone-plugins \
	    prometheus scripts firewall docs web klanker-gate \
	    Makefile README.md QUICKSTART.md BLOG.md LICENSE QA.md worklog.md THIRD_PARTY.md \
	    sysdeck-diagnose.sh cockpit-smoke-test.sh sysdeck-uninstall.sh
	@echo ">>> $(PACKAGE)-$(VERSION)-master.tar.bz2 ready"
