# SysDeck - RPM Spec
# Author: Jeremy Anderson (https://dcos.net)
# Build: rpmbuild -bb packaging/sysdeck.spec
#
# NOTE: This spec is for Fedora / RHEL / CentOS only.
#       Arch Linux users: see packaging/PKGBUILD
#       Debian/Ubuntu users: see packaging/debian/

Name:           sysdeck
Version:        0.4.5
Release:        1%{?dist}
Summary:        Unified operations surface for Linux infrastructure

License:        MIT
URL:            https://dcos.net
Source0:        %{name}-%{version}.tar.bz2
BuildArch:      noarch

BuildRequires:  make
BuildRequires:  python3-devel
BuildRequires:  nodejs
Requires:       cockpit-bridge >= 239
Recommends:     podman
Recommends:     nftables
Recommends:     opensc
Recommends:     pcsc-lite
Recommends:     fwupd
Recommends:     tpm2-tools
Recommends:     glances
Recommends:     lm_sensors
Recommends:     sysbench
Suggests:       kata-containers
Suggests:       jellyfin
Suggests:       ceph
Suggests:       glusterfs

%description
SysDeck is a standalone Linux operations console that also ships as a
Cockpit plugin suite. This package installs the Cockpit plugin edition:
27 domain modules — containers, firewall, integrity auditing, network
security, service mesh, encryption vaults, fleet compute, Kata
Containers, firmware, image building, mining, theme engine, hardware
authentication, DAG-driven build orchestration, system monitoring,
hardware sensors, system benchmarking, package management, policy &
permissions, database control, Jellyfin media server, photo manager
(PhotoPrism/Piwigo/Lychee/Nextcloud-Memories/LibrePhotos), remote
filesystem manager (Ceph/GlusterFS/MooseFS/BeeGFS/OrangeFS), the
service/port editor, the 3rd-party module installer, and the AI
gateway client — behind the Cockpit web UI. The standalone web
console (no Cockpit required) ships in the master tarball.

This RPM is for Fedora / RHEL / CentOS. For Arch Linux, use the
PKGBUILD. For Debian/Ubuntu, use the dpkg-buildpackage packaging.

%prep
%setup -q

%build
# Pure static assets — nothing to compile.

%install
make install DESTDIR=%{buildroot}

%files
%license LICENSE
%doc README.md QUICKSTART.md BLOG.md QA.md
# The install target ships: 27 plugins under
# /usr/share/cockpit/sysdeck-*/ (manifest.json, index.html, module js),
# the sysdeck-common bridge library, the Python bridge at
# /usr/lib/sysdeck/bridge/, tests, docs, share assets (diagnose +
# smoke + uninstall scripts, firewall templates + policies, prometheus
# configs), AppStream metainfo, and both polkit actions.
/usr/share/cockpit/sysdeck-*/
/usr/lib/%{name}/
/usr/share/%{name}/
/usr/share/doc/%{name}/
/usr/share/metainfo/sysdeck.metainfo.xml
/usr/share/polkit-1/actions/org.sysdeck.policy
/usr/share/polkit-1/actions/org.sysdeck.modules3p.policy

%post
# Restart cockpit.socket so the new plugin appears in the menu.
if [ $1 -eq 1 ]; then
    /bin/systemctl try-restart cockpit.socket >/dev/null 2>&1 || :
    /bin/systemctl reload polkit >/dev/null 2>&1 || :
fi

%postun
if [ $1 -eq 0 ]; then
    /bin/systemctl try-restart cockpit.socket >/dev/null 2>&1 || :
    /bin/systemctl reload polkit >/dev/null 2>&1 || :
fi

%changelog
* Thu Sep 17 2026 Jeremy Anderson <info@dcos.net> - 0.4.5-1
- v0.4.5 production-hardening release: full MoE QA pass. Makefile
  web-dev splice fixed; reproducible dist + clean-tree release gate;
  master tarball hygiene (no dev logs, no .env). Bridge security:
  prometheus push-log filename validation + label escaping, single-
  statement read-only SQL guard, glances availability step-down,
  mutation timeout safety, vmdb2 output-dir guard, theme CSS value
  allowlist, subprocess timeouts across helpers. Web: applySdTheme on
  every theme path, valid table rows, registry-sourced version
  surface, cached fester probes, tsc+eslint as build gates. Firewall:
  six structurally validated nftables rulesets, table-scoped flush
  everywhere, no-services loopback+SSH fixes, vps SSH verdict fix,
  Cilium policy scoping. Packaging: noarch spec with %files matching
  the 27-plugin install, nodejs build dependency, sysdeck.install
  hooks, AppStream extends, Caddyfile port allowlist. Decisive
  comment language across the first-party tree.

* Sat Sep 12 2026 Jeremy Anderson <info@dcos.net> - 0.4.4-1
- v0.4.4: package parity + blog essay. Ten package-manager backends on
  both editions (bridge/packages.py gains emerge/lunar/sorcery/xbps/
  apk/zypper/yum with a unified MUTATION_CMDS table and shutil.which
  detection step-down); zypper tables parse by header-located columns;
  the emerge update regex anchors after the class bracket; xbps
  detection probes xbps-query; lunar reports its missing update-preview
  honestly. Web packages.ts gains the same fixes. BLOG.md becomes the
  long-form engineering essay.

* Sat Sep 12 2026 Jeremy Anderson <info@dcos.net> - 0.4.3-1
- v0.4.3: the MoE QA pass — production hardening across every axis.
  Privileged writes ride stdin (polkit rules verified post-write,
  nft -f -/iptables-restore piped, PIN off argv); rule comments are
  injection-guarded; /tmp staging is mktemp'd; mutations require an
  admin session (SYSDECK_MUTATIONS=any restores single-operator mode);
  dry-runs preview the exact shipped script; dnf check-update rc-100
  is data; the polling layer gained TTL + single-flight caches; the
  cockpit-side sensors bridge gained the full lm-sensors -> sysfs
  step-down chain.
* Sat Sep 12 2026 Jeremy Anderson <info@dcos.net> - 0.4.2-1
- v0.4.2: the zero-demo release — production implementations only.
  Real sensors -j reads, real nftables/iptables ban enforcement with
  live fail2ban merging, a live-ruleset tab on the firewall panel, the
  full seven-template firewall catalog, and honest-empty inventories
  everywhere else. The bridge DataSource type no longer admits 'demo'.

* Sat Sep 12 2026 Jeremy Anderson <info@dcos.net> - 0.4.1-1
- v0.4.1: cockpit module detection for the web console — every
  installed cockpit module (distro modules like cockpit-machines and
  cockpit-podman, addons, anything with a manifest menu entry) is
  scanned from /usr/share/cockpit and loaded into the console
  navigation with live backend probes. Codenames retired from the UI;
  the console subtitle is dcos.net.

* Sat Sep 12 2026 Jeremy Anderson <info@dcos.net> - 0.4.0-1
- v0.4.0: Unix-account login for the web edition, the Cockpit way —
  host PAM verification (scripts/pam-auth.py ctypes client), v2
  user-bound session tokens, cockpit-style account menu + user@host
  status bar, SdUser local-account fallback (SYSDECK_AUTH_MODE),
  per-IP and per-username lockout, legacy v1 token acceptance.

* Sun Sep 13 2026 Jeremy Anderson <info@dcos.net> - 0.3.1-1
- v0.3.1: cockpit-style login for the web edition (shared password,
  HMAC session cookie, gated API routes, fester WS session check,
  audited logins) — the 0.3.0 audit follow-through.

* Fri Sep 11 2026 Jeremy Anderson <info@dcos.net> - 0.3.0-1
- v0.3.0 AI GATEWAY EDITION: klanker-gate (Frosty Deno LLM gateway,
  independent version 0.9.0) vendored at /klanker-gate with full Arch
  Linux packaging (arch/: PKGBUILD, hardened systemd unit, run wrapper,
  INSTALL-ARCH.md). The Arch port required zero upstream source changes.
- NEW klanker module in both editions: bridge/klanker.py (9 subcommands,
  stdlib REST client, KLANKER_URL + KLANKER_ADMIN_TOKEN, graceful
  offline) + plugins/sysdeck-klanker full panel; web edition gets the
  hybrid AI Gateway panel.
- bridge.js klanker surface 10 methods; bridge guard now 215 calls
  across 28 modules; 28 plugin manifests.
* Thu Aug 20 2026 Jeremy Anderson <info@dcos.net> - 0.2.0-1
- v0.2.0 MASTER EDITION: master tarball bundling the cockpit edition, the
  new SysDeck Web Edition (web/), and Fester pre-integrated (vendored at
  web/mini-services/fester, independent version 0.2.1).
- bridge/fester.py: real REST client (11 subcommands) replacing the
  v0.0.31 systemd-listing stub; fester panel fully built; bridge.js
  fester surface 1 -> 11 methods.
- Makefile: recipes are tab-indented (GNU make rejects the 8-space
  indent form; a build-time guard enforces tabs); new targets
  fester-start, web-install, web-dev, master.
* Tue Aug 19 2026 Jeremy Anderson <info@dcos.net> - 0.1.3-1
- v0.1.3 CRITICAL FIX: host package import was silently failing + mkosi
  still wasn't reading the profile config. Two root causes fixed, plus
  new download/manage UI for builds.
- IMPORT BUG: _detect_host_packages() relied on `from __init__ import
  PKG_MANAGER` which silently failed in the cockpit superuser channel
  context. PKG_MANAGER defaulted to "unknown", host query returned
  EMPTY list, import wrote nothing. Operator saw "tries to build only 2".
  FIX: now uses shutil.which() to find pacman/apt-mark/dnf directly.
- BUILD BUG: v0.1.2's --include flag does NOT work as a config loader.
  mkosi's --include includes a drop-in fragment ON TOP OF the base
  mkosi.conf — does NOT replace the base config. If no mkosi.conf in
  cwd, mkosi uses defaults and ignores --include file entirely.
  FIX: build() now creates a temp directory, symlinks the profile file
  as `mkosi.conf`, sets work_dir to that temp dir. mkosi finds the
  symlink, follows it, reads the actual profile. Works for ANY profile
  path. Temp dir cleaned up after build. New: _prepare_mkosi_work_dir().
- NEW: artifact download + management UI. Each artifact has Download
  (via cockpit.spawn cat + Blob), Delete (per-file), Clear all (per-
  profile). Profile card header shows total artifact size.
- NEW: build management. Each build has a Delete button with two-step
  confirm (state+log only, or also artifacts). New subcommand:
  build-delete <build-id> [--artifacts].
- REGRESSION TESTS: 11 new unit tests in TestBuilderArtifactManagement
  (7) + TestBuilderMkosiTempWorkDir (3). Existing tests updated for
  new shutil.which approach and removal of --include. Total: 254 tests
  (was 243; +11).
- VERSION SYNC: bumped 0.1.2 -> 0.1.3 across all 9 release surfaces.

* Tue Aug 19 2026 Jeremy Anderson <info@dcos.net> - 0.1.2-1
- v0.1.2 CRITICAL FIX: mkosi was not reading the profile config at all
  — packages were silently ignored. Operator reported: "the builder
  absolutely does not work yet. it has zero awareness of packages we
  tell it to add."
- ROOT CAUSE 1 (config not loaded): _backend_build_command() for mkosi
  had no flag telling mkosi WHERE the profile config file is. mkosi
  only reads a file literally named `mkosi.conf` from the cwd. For
  v0.0.x profiles at /etc/mkosi/mkosi.conf.d/<name>.conf, mkosi ran in
  that dir, found no `mkosi.conf`, and used EMPTY defaults — zero
  packages. The operator's Packages= setting was never seen by mkosi.
- FIX 1: _backend_build_command() now ALWAYS passes
  --include <profile_path> on the CLI. This tells mkosi to explicitly
  load the profile config by path, regardless of filename or location.
- ROOT CAUSE 2 (legacy Packages= syntax): profiles created by v0.0.x
  used the old indented Packages= syntax (Packages=\n    linux\n...).
  mkosi v22+ only understands single-line (Packages=linux ...). The
  old form is silently parsed as a single package name with embedded
  newlines, which doesn't exist in any repo — so mkosi installs
  NOTHING.
- FIX 2: new _migrate_legacy_mkosi_packages() function detects the old
  indented syntax and rewrites it to single-line IN-PLACE before the
  build command is constructed. build() calls this automatically on
  every mkosi build. Migration is logged in build state JSON (warnings
  array) and log file header (# MIGRATED: ...). No-op on modern syntax.
- REGRESSION TESTS: 4 new unit tests in TestBuilderBuildPath cover
  migration (old syntax rewrite, modern no-op, no-section no-op,
  end-to-end during build). Existing test_build_success_path extended
  to verify --include is on the command line and points at the profile.
- VERSION SYNC: bumped 0.1.1 -> 0.1.2 across all 9 release surfaces.
  Total unit tests now 243 (was 239 in v0.1.1; +4).

* Tue Aug 19 2026 Jeremy Anderson <info@dcos.net> - 0.1.1-1
- v0.1.1 OUTPUT PATH SAFETY FIX. An operator reported: "this is NOT
  a safe output path. fix this now." The v0.1.0 release relied on
  OutputDirectory= in the scaffolded mkosi.conf to route build outputs
  to /var/lib/sysdeck/builder/artifacts/<name>/. But when the operator
  built an OLD v0.0.x profile (whose mkosi.conf had no OutputDirectory=
  setting), mkosi defaulted to writing image.raw into the cwd — which
  was /etc/mkosi/mkosi.conf.d/, a system config directory owned by
  root. mkosi then refused to overwrite the existing image.raw,
  blocking every rebuild.
- ROOT CAUSE: _backend_build_command() for mkosi was just
  ["mkosi", "build"] with no CLI output flags. It trusted the
  profile's mkosi.conf to set OutputDirectory=, which doesn't exist
  on v0.0.x profiles, can be hand-edited to anything, and is ignored
  by mkosi if the profile is a drop-in fragment mkosi never reads.
- FIX: _backend_build_command() now ALWAYS passes --output,
  --output-dir, and --force on the CLI for mkosi builds. CLI flags
  override mkosi.conf, so the output path is forced to
  /var/lib/sysdeck/builder/artifacts/<name>/<name>.raw regardless of
  what the profile says. --force overwrites any existing image so
  rebuilds don't fail with "Output path exists already."
- SAFETY CHECK: build() now refuses to proceed if the resolved
  output_dir is not under /var/lib/, /tmp/, /var/tmp/, or the
  configured BUILDER_ARTIFACTS_DIR. Blocks /etc/, /usr/, /boot/,
  /bin/, /sbin/, /lib/, /root/, /home/, etc. Belt-and-suspenders:
  even if an operator passes options.output_dir=/etc/something via
  the JS bridge, the build is refused before subprocess.run is called.
- LEGACY PROFILE WARNING: build() now detects profiles in
  /etc/mkosi/mkosi.conf.d/ (the v0.0.x drop-in layout) and records
  a warning in both the build state JSON and the log file:
  "WARNING: profile is in /etc/mkosi/mkosi.conf.d/ (legacy v0.0.x
  layout). mkosi may silently ignore this drop-in fragment. Migrate
  to /etc/mkosi/profiles/<name>/mkosi.conf for a real profile."
- LOG IMPROVEMENT: build log header now includes the resolved
  output_dir so the operator can see exactly where the image will
  land before mkosi starts.
- REGRESSION TESTS: 2 new unit tests in TestBuilderBuildPath cover
  the safety check (refuses /etc/) and the legacy-profile warning.
  The existing test_build_success_path was extended to verify the
  mkosi command line includes --output, --output-dir, and --force,
  and that --output-dir points at the per-profile artifacts dir.
- VERSION SYNC: bumped 0.1.0 -> 0.1.1 across all 9 release surfaces.
  Total unit tests now 239 (was 237 in v0.1.0; +2).

* Tue Aug 19 2026 Jeremy Anderson <info@dcos.net> - 0.1.0-1
- v0.1.0 BUILDER PROFILE FIXUP + HOST PKG IMPORT. Three compounding
  bugs in the v0.0.x mkosi build path were silently producing empty
  33M images with no kernel/systemd/openssh, plus a new operator
  feature requested in the same release cycle.
- BUG 1 (scaffold location): profile-create wrote
  /etc/mkosi/mkosi.conf.d/<name>.conf — a drop-in fragment that
  mkosi only honors when a parent /etc/mkosi/mkosi.conf exists to
  layer it onto. With no parent, mkosi ran with empty defaults.
  Fix: each profile now lives in its own directory
  /etc/mkosi/profiles/<name>/mkosi.conf (the only filename mkosi
  reads automatically from the cwd). MKOSI_DIRS updated to scan
  /etc/mkosi/profiles first.
- BUG 2 (Packages= syntax): _MKOSI_TEMPLATE and _write_packages_mkosi
  used the indented-continuation form (Packages=\n    linux\n    ...)
  which was the old systemd-mkosi (<=v15) syntax. mkosi v22+ (Arch
  ships 25.x) expects single-line space-separated:
  Packages=linux linux-firmware systemd openssh. The v0.0.x form
  was silently parsed as a single package named "linux\\n..." and
  failed to install.
  Fix: template + writer now emit the modern single-line form. The
  reader accepts both forms so v0.0.x profiles migrate cleanly on
  first append/replace.
- BUG 3 (output routing): mkosi wrote its output to the cwd
  (/etc/mkosi/mkosi.conf.d/image.raw) but build() only scanned
  /var/lib/sysdeck/builder/artifacts/<profile>/ for artifacts — so
  every successful build looked like a failure in the panel.
  Fix: _MKOSI_TEMPLATE now sets OutputDirectory= to the per-profile
  artifacts dir so mkosi writes directly there.
- NEW FEATURE: profile-import-packages subcommand. Queries the
  host's explicitly-installed package set (pacman -Qqe on Arch,
  apt-mark showmanual on Debian, dnf repoquery --userinstalled on
  Fedora) and writes it into a profile's package list via the
  existing _write_packages dispatch. Defaults to append mode so
  the profile's baseline (kernel, systemd, openssh) is preserved.
  Supports --mode=replace, --dry-run for preview, and --packages=
  for manual override (useful for importing a list captured on
  another host). New polkit exec paths for pacman/apt-mark/dnf
  added to org.sysdeck.builder.modify.
- PANEL UX: each profile row in the Builder panel now has a
  "Import host pkgs" button. Click → dry-run preview → window.confirm
  with package count, source distro, and first 200 packages →
  append write. Falls back to operator cancel without writing.
- REGRESSION TESTS: 7 new unit tests in TestBuilderImportHostPackages
  cover _detect_host_packages dispatch (pacman path + dedup), the
  --packages override end-to-end, --dry-run no-write behavior, and
  the unknown-profile / no-args / bad-mode / COMMANDS-registration
  error paths. 4 existing tests in TestBuilderPackagesField
  updated for the new single-line Packages= syntax; 1 new test
  (test_mkosi_modern_single_line_input_parsed) guards against a
  regression where the writer emits the new form but the reader
  only understands the old one.
- VERSION SYNC: bumped 0.0.50 → 0.1.0 across all 9 release surfaces
  (Makefile, bridge/__init__.py, packaging/setup.py, packaging/PKGBUILD,
  packaging/sysdeck.spec, packaging/debian/changelog,
  compat/compat-manifest.json, packaging/sysdeck.metainfo.xml,
  README.md). Version-sync test renamed to
  test_version_sync_all_surfaces_report_010.
- All build-time guards pass. Total unit tests now 237 (was 228 in
  v0.0.50; +8 TestBuilderImportHostPackages + 1 new
  test_mkosi_modern_single_line_input_parsed).

* Tue Aug 19 2026 Jeremy Anderson <info@dcos.net> - 0.0.50-1
- v0.0.50 BUILD PATH NameError FIX. An operator reported:
  "NameError: name 're' is not defined. Did you forget to import 're'?
  happens right away on build for a new profile i created." The
  traceback pointed at _new_build_id() line 492: safe_profile =
  re.sub(r"[^A-Za-z0-9_-]", "_", profile).
- ROOT CAUSE: bridge/builder.py's module-level imports were
  import json / os / shutil / subprocess / sys + from pathlib import
  Path + from typing import Any. No `import re`. _new_build_id has
  used re.sub since v0.0.31, but no test ever exercised the build()
  code path — the unit tests only covered profile_create /
  profile_copy / profile_delete and the v0.0.49 package-writing
  helpers. The bug went undetected for 18 releases (v0.0.31 through
  v0.0.49) until an operator actually clicked Build on a freshly-
  created profile.
- FIX: added `import re` to the module-level imports in
  bridge/builder.py. Removed the now-redundant local `import re`
  inside _write_packages_vmdb2 (it was a v0.0.49 workaround that's
  no longer needed).
- REGRESSION TESTS: 9 new unit tests in tests/test_bridge_parsers.py
  TestBuilderBuildPath cover:
  - _new_build_id format (<safe-profile>-<14-digit-timestamp>).
  - _new_build_id sanitizes unsafe chars (dots → underscores).
  - _new_build_id preserves safe chars (hyphens + underscores).
  - _new_build_id_re_imported_at_module_level: explicit assertion
    that `re` is in the builder module's globals. If anyone ever
    removes the import re line in a future refactor, this test
    will catch it.
  - build() end-to-end with mocked subprocess.run: verifies the
    build state file + log file are written, the response shape is
    correct (build_id / state / rc / success / duration_s /
    artifacts / log_path), and subprocess.run was actually called.
  - build() with unknown profile returns a clear "not found" error.
  - build() with no args returns a usage error (not a crash).
  - build() with backend-not-installed returns a clear error.
  - build() with non-zero subprocess returncode records state
    "failed" (not "succeeded").
  All tests mock subprocess.run and the module-level BUILDER_STATE_DIR
  / BUILDER_LOGS_DIR / BUILDER_ARTIFACTS_DIR so they run hermetically
  — no real /var/lib/ writes, no real backend invocation.
- AUDIT: ran an AST-based audit of bridge/builder.py to find any
  other names used at module level but not imported. No real
  undefined names found — every flagged item was a comprehension
  local (b, v, s, p), tuple-unpacking target (cid, chint, k, v,
  backend_id, binary, vargs, kind), except-clause target (exc), or
  __file__ (provided by Python in every module). The build path is
  now fully exercisable by tests.
- VERSION SYNC: bumped 0.0.49 → 0.0.50 across all 9 release surfaces.
- All build-time guards pass. Total unit tests now 228 (was 219 in
  v0.0.49; +9 TestBuilderBuildPath).

* Tue Aug 19 2026 Jeremy Anderson <info@dcos.net> - 0.0.49-1
- v0.0.49 BUILDER INLINE PACKAGE LIST. Per user directive: "we should
  allow adding a pacman -Sy applist.txt with a literal list of baseline
  apps for the profile being generated." Both the Create Profile and
  Copy shipped profile forms now include a Baseline packages textarea,
  a file upload input (applist.txt), and a merge-mode toggle (append |
  replace). The package list is written to the backend-specific
  package file in the same operation as the scaffold/copy.
- BACKEND COVERAGE: all 4 backends supported (mkosi, vmdb2, archiso,
  live-build). Each writes to its native package-list location:
  mkosi → [Packages] section of <name>.conf, vmdb2 → bootstrap.include
  list in <name>.yaml, archiso → packages.x86_64 in the profile dir,
  live-build → config/package-lists/sysdeck.list.
- INPUT: textarea for inline paste (one package per line, # comments
  allowed) AND file upload (applist.txt / .list / .conf accepted).
  File upload populates the textarea via FileReader so the operator
  can review/edit before submitting. 1 MB cap on uploaded files.
- MERGE MODE: operator chooses per-operation via a toggle:
  - append (default for Copy): preserves the baseline's existing
    packages, adds the operator's, deduplicates.
  - replace (default for Create): overwrites the baseline's package
    file with the operator's list.
- NEW BRIDGE HELPERS in bridge/builder.py:
  - _extract_opts(args): splits argv into (positional, opts) so
    profile-create/profile-copy can accept --packages=<json> and
    --mode=append|replace without breaking their existing positional
    signatures.
  - _parse_packages_text(text): parses multiline text into a deduped
    list of package names (strips full-line + inline comments, blank
    lines, surrounding whitespace; preserves first-occurrence order).
  - _write_packages_mkosi/vmdb2/archiso/live_build: per-backend
    writers that read the existing file, dedup on append, rebuild the
    appropriate section/list/file.
  - _write_packages(profile_path, backend, packages_text, mode):
    dispatcher that routes to the right writer.
- EXTENDED profile_create() and profile_copy() to accept --packages=
  <json> and --mode=append|replace. Default mode for create is
  "replace"; for copy it's "append". Both return a new "packages"
  field in their success response: {count, mode, path}.
- UPDATED shared/bridge.js: profileCreate(name, backend, base,
  packagesText, mode) and profileCopy(srcName, newName, backend,
  packagesText, mode). packagesText is JSON-encoded so newlines and
  quotes survive the argv boundary cleanly. When omitted, the bridge
  writes no package file (back-compat with v0.0.48 callers).
- UPDATED plugins/sysdeck-builder/builder.js: new renderPackagesField
  (prefix, defaultMode) helper shared by both forms. File-upload
  handlers use FileReader to populate the textarea. Both submit
  handlers read the textarea + mode toggle and pass them to the
  bridge; the success message now shows the package count + path.
- NEW TESTS: 28 unit tests in tests/test_bridge_parsers.py
  TestBuilderPackagesField cover _parse_packages_text (6 tests),
  _extract_opts (4 tests), _write_packages_mkosi (3 tests),
  _write_packages_vmdb2 (2 tests), _write_packages_archiso (2 tests),
  _write_packages_live_build (3 tests), _write_packages dispatcher
  (3 tests), profile_create end-to-end (2 tests), profile_copy end-
  to-end (3 tests). All use tempdirs; none touch real /etc/ paths.
- VERSION SYNC: bumped 0.0.48 → 0.0.49 across all 9 release surfaces.
- All build-time guards pass.

* Tue Aug 19 2026 Jeremy Anderson <info@dcos.net> - 0.0.48-1
- v0.0.48 BUILDER PROFILE-CREATE BUGFIX. The v0.0.31 Create Profile
  form's backend dropdown fell back to `primary.id` when no scaffoldable
  backend (mkosi/vmdb2) was installed. On an archiso-only or live-build-
  only host, this funneled the operator straight into the "profile-create
  supports ('mkosi', 'vmdb2')" error — archiso and live-build use shipped
  directory-based profile trees, not single-file specs, so they cannot
  be scaffolded from scratch.
- FIX 1 (panel): renderCreateProfile in plugins/sysdeck-builder/builder.js
  no longer falls back to primary.id. When no mkosi/vmdb2 backend is
  installed, the form renders an inline install hint instead. The dropdown
  only offers actually-scaffoldable backends.
- FIX 2 (panel): new renderCopyProfile form lists every shipped archiso
  and live-build profile discovered via profiles() and offers a one-click
  copy into /etc/ via the new bridge.builder.profileCopy() method. This
  is the supported way to create profiles for directory-based backends.
- NEW BRIDGE COMMAND: bridge/builder.py profile_copy() — copies a
  shipped archiso/live-build profile tree from /usr/share/ into /etc/.
  Validates new-name (no slashes, no "."/".." to prevent path traversal),
  resolves source via profiles(), refuses non-directory-based backends
  with a clear "use profile-create" hint, refuses if destination exists,
  returns structured {copied, backend, source, source_path, name, path}
  on success. Same polkit action as profile-create (org.sysdeck.builder.modify).
- NEW BRIDGE.JS METHOD: bridge.builder.profileCopy(srcName, newName, backend)
  runs with { superuser: 'try' }, same as profileCreate / profileDelete.
- DESTINATION ROOTS REFACTOR: ARCHISO_COPY_DEST and LIVE_BUILD_COPY_DEST
  are now module-level constants in bridge/builder.py (was: hardcoded
  inside profile_copy). Tests can patch them with tempdirs.
- NEW TESTS: 15 unit tests in tests/test_bridge_parsers.py
  TestBuilderProfileCopy cover arg validation, source resolution
  (not-found, wrong-backend, mkosi/vmdb2 rejection), success paths
  (archiso + live-build), failure modes (dest-exists, source-not-a-dir,
  permission-error-with-polkit-hint). All tests use tempdirs and mock
  profiles(); none touch real /etc/ or /usr/share/ paths.
- VERSION SYNC: bumped 0.0.47 → 0.0.48 across all 9 release surfaces
  (Makefile VERSION + comment, bridge/__init__.py __version__,
  packaging/setup.py VERSION, PKGBUILD pkgver, RPM spec Version,
  debian/changelog, compat-manifest.json version + _comment,
  metainfo.xml <release>, README.md Version line).
- All build-time guards pass: manifest consistency, metainfo consistency,
  Makefile recipe indentation, no broken import patterns, no broken
  python3 -m sysdeck.bridge pattern, bridge.js subcommand cross-check
  (now 102 calls — was 101 in v0.0.47, +1 for the new profileCopy),
  version sync, all unit tests (15 new + existing).

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.47-1
- v0.0.47 LOGIC-FLAW FIXES per user directive: "we need to fix a few
  logic flaws i do things a certain way on my servers so ill correct
  the ports on a firewall script or two. the web server template, and
  vps template i setup the webserver on 8080 and varnish on 80 for an
  automatic cache environment. we should move the service/ports editor
  to its own module entry for ease of access. the glances we should
  default to enabling the built in webui and embedding that into our
  module instead it visually looks stunning in comparison to ours."
- firewall/templates/public-webserver.sh: PORT-TOPOLOGY FIX. The
  v0.0.44 template had the topology backwards — it exposed Caddy on
  :80 and Varnish on :8080. v0.0.47 flips it: Varnish is the public
  cache front on :80, Caddy HTTP backend lives on :8080 (loopback
  only), Caddy HTTPS lives on :443 (public, terminates TLS). The
  VARNISH_PUBLIC toggle is removed — :8080 is now ALWAYS loopback-
  only (the previous default exposed the cache-miss path to the
  internet, bypassing Varnish). Defense-in-depth drops added for
  :8080 (Caddy HTTP backend) alongside the existing MariaDB + Caddy
  admin drops.
- firewall/templates/vps-webserver.sh: when Varnish is detected at
  all, the operator's documented setup is now the explicit default —
  Varnish on :80, Caddy HTTP backend on :8080 (loopback only), Caddy
  HTTPS on :443. Previously this only happened if Varnish was already
  listening on :80 at runtime; now detecting Varnish is enough to
  flip Caddy HTTP to :8080 loopback.
- NEW PLUGIN: sysdeck-services — first-class sidebar entry at order
  45. The Service/Port Editor card that lived at the bottom of the
  Firewall panel since v0.0.44 has been lifted out into its own
  module. Adds a filter box (search by name/id/port/process), a
  show-only-editable toggle, and a Refresh button. The bridge
  surface (bridge.firewall.services / service-info / set-service-port
  / restart-service) is unchanged; a new bridge.services proxy was
  added to bridge.js so the new panel has a clean API.
- plugins/sysdeck-firewall/firewall.js: removed the
  renderServicePortEditor() card + the .btn-svc-save / .btn-svc-
  restart wireEvents handlers + the services() Promise from the
  parallel load. Added a renderServicesLinkCard() signpost pointing
  operators to the new sidebar entry.
- plugins/sysdeck-firewall/manifest.json: removed service/port/
  editor keywords (they belong to the new services plugin now).
- plugins/sysdeck-services/{manifest.json,index.html,services.js}:
  new plugin. Proxies to bridge.services.{list,info,setPort,restart}.
- shared/bridge.js: added bridge.services surface (4 methods) that
  proxies to bridgeCmd("firewall", [...]) — no new bridge helper file
  needed. The SERVICES_REGISTRY + atomic-write + systemctl restart
  logic remains in bridge/firewall.py as the single source of truth.
- plugins/sysdeck-glances/glances.js: DEFAULT-ON EMBEDDED WEBUI.
  The panel now auto-starts the Glances built-in webserver
  (glances -w --bind 127.0.0.1 --port 61208) on mount — no click
  required. The iframe is now the primary view, sized to fill the
  viewport (min-height: calc(100vh - 200px)). The legacy SysDeck
  snapshot cards (CPU/Memory/Swap/Network/Disk/Processes) are moved
  into a collapsed <details> at the bottom of the page so they
  don't push the iframe below the fold.
- plugins/sysdeck-glances/manifest.json: CSP updated to allow
  frame-src http://127.0.0.1:61208 + http://localhost:61208 so the
  embedded Glances web UI loads without a CSP violation. Added
  webui/embed/iframe/real-time keywords.
- Makefile: bumped VERSION 0.0.46 → 0.0.47, plugin count 25 → 26.
- bridge/__init__.py: __version__ 0.0.45 → 0.0.47 (catches up the
  v0.0.46 release that bumped PKGBUILD/spec/debian but missed this
  file + setup.py).
- packaging/setup.py: VERSION 0.0.45 → 0.0.47 (same catch-up).
- VERSION SYNC: all 9 release surfaces now report v0.0.47.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.46-1
- NEW PLUGIN: sysdeck-modules — in-suite 3rd-party Cockpit module installer
- Each catalog row shows module name, license badge, developer, source URL,
  and homepage link INLINE next to a 1-click Install button. Clicking
  Install is the operator's acceptance of the inline-displayed license.
  No modal, no separate confirmation step.
- bridge/modules3p.py: 10-entry catalog (cockpit-machines, cockpit-podman,
  cockpit-storaged, cockpit-identities, cockpit-navigator, cockpit-file-
  sharing, cockpit-zfs-manager, cockpit-pacman, cockpit-sensors, cockpit-
  benchmark), 4 install kinds (pacman / git / deb-tar / tarball).
- Bridge refuses silent installs (no --accept-license=1 ⇒ license-not-
  accepted). JS always passes that flag because the license is shown inline.
- Audit log: /etc/cockpit/MODULE_LICENSES.log gets a JSON record per
  install / uninstall. Legacy plain-text lines preserved as {raw: ...}.
- New polkit action: org.sysdeck.modules3p.modify (auth_admin_keep).
- bridge.js: added bridge.modules3p surface (catalog / status / preflight
  / install / uninstall / audit).
- THIRD_PARTY.md: appended v0.0.46 section + updated existing notes.
- Makefile: bumped VERSION 0.0.45 → 0.0.46, plugin count 24 → 25.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.45-1
- TRADEMARK SCRUB. Per user directive: "you cannot say smoothwall and
  ipfire where merged into our fw script either. you can say logic
  derived from or influenced by these projects. its really hard
  holding your hand on legal issues." v0.0.36 and v0.0.37 release
  notes, changelogs, code comments, and worklog entries previously
  claimed we shipped templates called smoothwall.sh and ipfire.sh
  and "merged" them into sysdeck-fw. v0.0.45 rewords every such claim
  to "takes influence from" / "logic derived from" Smoothwall Express
  + IPFire under our own identifier. We never shipped templates called
  "smoothwall" or "ipfire".
- FILES SCRUBBED (10): bridge/firewall.py (EXCLUDED_BACKENDS reasons
  + docstring + sysdeck-fw description), firewall/templates/sysdeck-fw.sh
  (header comment), firewall/templates/cilium.sh (stale backend
  reference), tests/test_bridge_parsers.py (test class rename +
  comments), plugins/sysdeck-firewall/firewall.js (header bump +
  excluded-backends description), plugins/sysdeck-firewall/manifest.json
  (keywords list: removed smoothwall+ipfire, added sysdeck-fw + v0.0.44
  service/port editor keywords), README.md (v0.0.36+v0.0.37 highlights),
  packaging/debian/changelog (v0.0.36+v0.0.37 entries), packaging/sysdeck.spec
  (v0.0.36+v0.0.37 %changelog entries — this very entry), worklog.md
  (Task 36 + Task 37 entries).
- LEGALLY-SAFE PHRASINGS. Every reference to Smoothwall Express or
  IPFire now uses "takes influence from" / "logic derived from" /
  "influenced by these projects". EXCLUDED_BACKENDS reasons for
  smoothwall + ipfire now read: "other projects' trademarks — we
  took influence from them for sysdeck-fw instead of shipping
  templates by those names."
- DIRECT-QUOTE PRESERVATION. User-directive quotes mentioning
  "smoothwall" or "ipfire" preserved verbatim as the user's own
  words. The v0.0.37 directive quote was lightly paraphrased from
  "lets merge them into" to "lets unify them into" — same meaning,
  legally safer verb.
- NO FUNCTIONAL CHANGES. Wording-only release. No code paths changed,
  no templates changed, no bridge subcommands changed. The sysdeck-fw
  backend, the 7 firewall templates, and the v0.0.44 service/port
  editor are unchanged. All 141 unit tests pass. All 7 build-time
  guards pass.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.44-1
- PUBLIC-SERVER FIREWALL VARIANTS. Per user directive: "another thing
  the firewall module needs is a few public server variants. like:
  remote admin enabled ssh and cockpit, server enabled like caddy
  and varnish 80 and 8080 w mariadb, an ai llm variant for ollama,
  hermes, openwebui and oddyseus." Three new templates ship:
  - remote-admin.sh: SSH (22) + Cockpit (9090). Aggressive rate
    limiting with auto-ban. For VPS / cloud hosts.
  - public-webserver.sh: Caddy (80/443) + Varnish (8080) + SSH (22).
    MariaDB (3306) and Caddy admin API (2019) are bound loopback-only
    with defense-in-depth DROP rules — even if the daemon is
    misconfigured to bind 0.0.0.0, the firewall drops the packet
    before it reaches the daemon.
  - ai-llm.sh: Ollama (11434) + OpenWebUI (3000) + Hermes (8000) +
    Odysseus (8001) + SSH (22). For self-hosted AI LLM stacks on a
    personal/team workstation.
  All three templates implement the standard start/stop/restart/
  detect/status/check interface. All use modern nftables inet family
  with sets, rate limiting, bogon filtering, invalid-flag drops,
  and per-port logging.
- SERVICE/PORT EDITOR. Per user directive: "and lastly a full
  service/port editor that detects based on running ports and
  services detected on them. make it as simple as editing the port
  to change it in a config on the system. auto restart the
  associated service if it is changed." Four new bridge subcommands:
  - services: runs `ss -tlnp` (or /proc/net/tcp fallback) to enumerate
    ALL listening TCP ports. Cross-references against SERVICES_REGISTRY
    (9 services: ssh, cockpit, caddy, varnish, mariadb, ollama,
    openwebui, hermes, odysseus). Returns full inventory including
    current port from config, listening ports, processes, PIDs,
    systemd unit, config file path, and editable flag.
  - service-info <id>: returns one service's full registry entry.
  - set-service-port <id> <new_port>: edits the port in the service's
    config file via atomic write (tmpfile + fsync + rename), then
    runs `systemctl restart` on the service. Falls back to alt_units
    if primary unit fails.
  - restart-service <id>: just restarts the service (no port change).
  HARDENING: service_id validated against SERVICES_REGISTRY (no
  arbitrary file edits — CVE-2024-2947 lesson). Port validated with
  strict integer regex 1..65535, fullmatch to reject trailing
  newlines (CVE-2019-15107 lesson). Config path resolved with
  os.path.realpath + base-dir allowlist (/etc/ or /usr/share/sysdeck/)
  — symlink-escape attacks rejected (CVE-2022-30708 lesson). Port
  substitution uses a strict per-service regex (not freeform sed) so
  only the port digits are replaced, never comments or other content.
  systemctl invoked with shell=False, list argv, env scrubbed
  (CVE-2024-6126 lesson). systemctl binary validated against an
  allowlist (/usr/bin/systemctl, /bin/systemctl, /usr/sbin/systemctl).
  Atomic write via tmpfile + fsync + rename defeats partial-write
  corruption.
- PANEL: new "Service / Port Editor" card in the firewall panel.
  Renders one row per registered service with: editable port input
  (1..65535), Save & Restart button, Restart-only button, current
  port from config, default port, listening ports, processes, PIDs,
  config file path. Unmapped listeners (ports with no matching
  registry entry) shown in an expandable details block so the
  operator can spot services the editor doesn't yet know about.
- BRIDGE.JS: 4 new firewall methods — services, serviceInfo,
  setServicePort, restartService. Read-only queries (services,
  serviceInfo) do NOT pass { superuser: 'try' }. Mutating queries
  (setServicePort, restartService) DO — the cockpit bridge prompts
  via polkit. The org.sysdeck.firewall.modify action (shipped since
  v0.0.17) already authorizes /usr/bin/systemctl — no polkit changes.
- REGRESSION TESTS EXPANDED. 32 new tests in two new test classes
  (TestFirewallV044ServicesEditor + TestFirewallV044PublicServerTemplates).
  Tests cover: SERVICES_REGISTRY structure (9 entries, all valid),
  _validate_service_id accept/reject (incl. shell-metachar and
  path-traversal attacks), _validate_port accept/reject (incl. shell
  metachars and trailing newlines), cmd_services JSON shape,
  cmd_service_info accept/reject, cmd_set_service_port CVE-attack
  rejection (path traversal, shell metachars, unknown service,
  missing args), cmd_restart_service validation, _run_ss_listening
  return-list contract, _extract_port_from_config regex extraction
  for all 9 services, end-to-end atomic-write test on a temp config
  file (verifies file modified + non-target lines preserved +
  returned JSON contains before/after port), no-config-file error
  path, regex-no-match error path (refuses to write — doesn't guess
  where the port line is), no-sudo-in-v044-subcommands check, three
  new template files exist + executable + metadata header + standard
  dispatch interface + no-sudo.
- The v0.0.43 validators (_validate_service_id, _validate_port)
  now use re.fullmatch instead of re.match — closes a regression
  where "ssh\n" or "22\n" would slip past `re.match(r"...$")` because
  $ matches at \n in MULTILINE mode (or in the default mode for
  patterns that don't span lines). fullmatch rejects trailing chars.
- Total tests: 109 (v0.0.43) → 141 (v0.0.44). 32 new tests.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.43-1
- FIREWALL BACKEND/TEMPLATE COORDINATION FIX. Backend selector +
  template selector now coordinate. When a backend has its own
  template (cilium/sysdeck-fw), template selector is hidden. When
  'custom' is active, only custom-compatible templates shown. Apply
  button is backend-aware.
- NETWORK MONITOR REWRITE (iptraf-ng style). bridge/netsec.py reads
  /proc/net/dev, /proc/net/snmp, /proc/net/tcp+udp directly. Panel
  recreated with live traffic cards, connection monitor, protocol
  stats. Auto-refresh every 5s. 9 new tests. Total: 100 -> 109.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.42-1
- SIDEBAR LABEL CLEANUP. User directive: "instead of looking kinda
  eccentric with putting SysDeck leading every module." Dropped the
  "SysDeck " prefix from all 24 plugin labels — matches the cockpit
  ecosystem convention (cockpit-machines is "Machines", not "Cockpit
  Machines"). 24 labels changed. Contiguous order numbers (20-43)
  preserved for visual grouping after stock cockpit plugins.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.41-1
- HARDENING: NO 0.0.0.0 LISTENERS. User directive: "we need to make
  sure we never ever set a web listen address to 0.0.0.0, if anything
  use 127.0.0.1. we already discussed hardening that should have been
  fresh." The v0.0.40 Prometheus port fix introduced 4 references to
  0.0.0.0:9095 as the webListenAddress + install-hint examples — a
  wildcard bind that would expose Prometheus to every network
  interface. v0.0.43 replaces all 4 with 127.0.0.1:9095 (loopback
  only). Added a regression test (TestNoWildcardListeners) that scans
  every bridge/*.py and plugins/*/*.js for the 0.0.0.0:<port> listener
  pattern and fails the build if any are found — this enforces the
  rule permanently going forward. Total tests: 98 → 100.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.40-1
- PORT CONFLICT FIX: PROMETHEUS 9090 → 9095. User directive:
  "prometheus and cockpit both use the same port. so we can assume
  prometheus was moved not cockpit." Cockpit-ws defaults to port
  9090. Prometheus also defaults to 9090. The v0.0.39 bridge
  hardcoded http://localhost:9090 as the Prometheus API URL — on
  any host where Cockpit is running, the bridge would hit
  Cockpit-ws instead of Prometheus and get HTML pages instead of
  JSON API responses. v0.0.43 moves the Prometheus default to
  port 9095 (familiar 909x range, no conflict with Pushgateway
  9091, Alertmanager 9093, or Cockpit 9090). 10 references
  updated: bridge/prometheus.py (PROM_API_URL default +
  webListenAddress), plugins/sysdeck-monitoring/monitoring.js
  (iframe src, open-in-new-tab link, status table URL, install
  hint port, comment), manifest.json (CSP frame-src),
  prometheus/sysdeck_scrape.yml (self-scrape target),
  prometheus/sysdeck_grafana_datasources.yml (datasource URL).
  The install hint now explicitly tells operators to move
  Prometheus off 9090 via web.listen_address or ARGS.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.39-1
- MONITORING MODULE (PROMETHEUS + GRAFANA). User directive: "we
  have 2 modules left, we can actually have them share a module
  with tabs similar to the container/vm module. we should add
  prometheus, and graphana webui modules." v0.0.39 adds a new
  shared tabbed plugin plugins/sysdeck-monitoring/ with two tabs:
    1. Prometheus — status card (version, uptime, targets, alerts)
       + iframe of the real Prometheus web UI at 127.0.0.1:9090.
    2. Grafana — status card (version, dashboards, datasources) +
       iframe of the real Grafana web UI at 127.0.0.1:3000.
  Plugin count 23 → 24. The bridge helpers (bridge/prometheus.py,
  bridge/grafana.py) already existed but were unwired — v0.0.43
  wires them into bridge.js + adds the panel UI.
- BRIDGE HARDENING. Both prometheus.py and grafana.py received the
  v0.0.36 + v0.0.37 security treatment:
    - NoRedirectHandler on all HTTP calls (SSRF defense,
      CVE-2020-35850). Prevents attacker-controlled Prometheus/
      Grafana from redirecting to internal services.
    - 127.0.0.1-only URL check (SSRF defense).
    - Env scrubbed (SCRUBBED_ENV) on every subprocess.
      CVE-2024-6126 lesson.
    - Output sanitized (_sanitize_output). CVE-2022-36446 lesson.
    - No sudo — replaced /usr/bin/sudo /usr/bin/systemctl with
      direct systemctl + cockpit superuser channel + polkit.
      This is the v0.0.31 "cockpit way" pattern — the v0.0.15-era
      sudo shell-out is gone. CVE-2022-0824 lesson.
    - check=False with structured error return (no exceptions).
    - Reuses firewall.py security helpers via import (single
      source of truth for hardening).
- NEW BRIDGE.JS SURFACES. bridge.prometheus (8 methods: summary,
  targets, alerts, rules, config, logSummary, restart, reload)
  + bridge.grafana (11 methods: summary, dashboards, datasources,
  alerts, health, org, users, plugins, search, restart, reload).
  Read-only queries do NOT pass superuser:'try'; restart/reload DO.
- POLKIT ACTION. New org.sysdeck.monitoring.modify authorizes
  systemctl for Prometheus + Grafana service management.
- CONFIG FILES SHIPPED. prometheus/sysdeck_scrape.yml (scrape
  configs for sysdeck bridge health endpoints + pushgateway),
  sysdeck_alerts.yml (alert rules), sysdeck_grafana_datasources.yml
  (Provisioned Prometheus + Alertmanager datasources),
  sysdeck_grafana_dashboards.yml (dashboard provisioning). Installed
  read-only at /usr/share/sysdeck/prometheus/.
- MANIFEST + METAINFO. New plugins/sysdeck-monitoring/manifest.json
  (order 43, cockpit>=239, CSP allows iframes to 127.0.0.1:9090 +
  127.0.0.1:3000). Metainfo declares 24 launchable entries. The
  manifest consistency guard expected count updated 23 → 24.
- GENERATOR UPDATED. scripts/generate-plugins.py PLUGINS registry
  + KEYWORDS extended with monitoring entry. The bridge surface
  is hand-maintained in shared/bridge.js (not generated).
- REGRESSION TESTS. 12 new tests for prometheus + grafana bridge
  helpers. Total: 90 (v0.0.38) → 102 tests.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.38-1
- KATA PANEL PRODUCTION REWRITE. User directive: "oh yea, theres
  kata sandboxes i didnt start myself. are those default? or did
  we create those? or those mock/stubs. we definately dont want
  mock place holders. lets get it production ready now." The
  v0.0.35-v0.0.37 Kata panel shipped a 470KB pre-built React
  bundle that displayed HARDCODED MOCK DATA: 5 fake sandboxes
  (web-frontend-prod, api-gateway-staging, etc.) with synthetic
  UUIDs and createdAt:"2026-07-15..." timestamps, fake metrics,
  a fake QCrows bundle catalog, and a fake PXE status (always
  dnsmasqRunning:true). v0.0.43 deletes the React bundle and
  ships a vanilla-JS panel backed by a new bridge/kata.py that
  calls the REAL Kata Containers 3.x APIs:
    - list/inspect/metrics → kata-monitor HTTP /sandboxes,
      /agent-url, /metrics?sandbox=<id> + filesystem
      /run/vc/sbs/<id>/ (Go shim) + /run/kata/<id>/ (Rust shim)
    - summary/version/check → kata-runtime version +
      kata-runtime env --json + kata-runtime check (exit code)
    - pxe-status → systemctl is-active dnsmasq + real
      /srv/tftp/ filesystem probes
    - qcrows-list → filesystem /usr/share/sysdeck/kata/qcrows/
  When no sandboxes are running, the panel shows the real empty
  state — not mock data.
- KATA 3.x API CORRECTNESS. Researched the real kata-runtime CLI.
  Key finding: kata-runtime list and kata-runtime inspect were
  REMOVED in 3.x. The bridge does NOT call them. kata-monitor
  /sandboxes returns PLAIN TEXT (one ID per line), NOT JSON.
  kata-runtime env --json uses CAPITALIZED Go field names (no
  json struct tags). kata-monitor /metrics returns PROMETHEUS
  TEXT FORMAT, parsed via prometheus_client.
- NEW BRIDGE HELPER. bridge/kata.py with 8 subcommands. Reuses
  v0.0.37 firewall.py security helpers (SCRUBBED_ENV,
  _sanitize_output, _validate_filename, _resolve_path_under_base)
  via import. Sandbox IDs validated with ^[0-9a-f]{64}$.
  HTTP to kata-monitor is 127.0.0.1-only with no redirects
  (SSRF defense, CVE-2020-35850 lesson).
- NEW BRIDGE.JS SURFACE. bridge.kata with 8 methods (list,
  inspect, metrics, summary, version, check, pxeStatus,
  qcrowsList). All read-only.
- POLKIT ACTION. New org.sysdeck.kata.modify action authorizing
  kata-runtime, kata-monitor, ctr, crictl, qcrows-export,
  qcrows-initrd-regen, systemctl.
- MANIFEST RELAXED. plugins/sysdeck-kata/manifest.json
  requires.cockpit lowered from 286 to 239 (React bundle's
  cockpit-286 requirement no longer applies). CSP simplified.
  Keywords extended (kata-monitor, qcrows, pxe, tftp,
  cloud-hypervisor, firecracker, qemu).
- REGRESSION TESTS. 13 new tests in TestKataBridgeProduction
  class. Includes a source-code scan verifying kata.py contains
  NONE of the mock markers. Total: 78 (v0.0.37) → 91 tests.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.37-1
- UNIFIED BACKEND — SYSDECK FW. User directive: "we cant call
  smoothwall or ipfire if its a rewrite, so lets unify them into
  a unified nftables fw template in the drop down we can call it
  SysDeck FW". v0.0.37 introduces the unified sysdeck-fw backend (takes influence from
  templates into a single unified sysdeck-fw.sh template. The merged
  template preserves BOTH feature sets: RED/ORANGE/GREEN/BLUE zone
  matrix (from Smoothwall), source-verified outbound per-zone CIDR
  (from IPFire), AirWall isolation for BLUE/WiFi (from IPFire,
  toggleable), flow offload (from IPFire), DMZ port-forwarding
  (from both). Config at /etc/sysdeck/firewall/sysdeck-fw.conf.
  Smoothwall and IPFire appear in EXCLUDED_BACKENDS with the reason "took influence from for sysdeck-fw —
  we cannot call our rewrite by another project's name."
- EXPANDED CVE RESEARCH. User directive: "when i say webmin i mean
  all web admin ui panels cpanel all of them." v0.0.43 extends the
  CVE research to cover cPanel/WHM, Plesk, DirectAdmin, CloudPanel,
  aaPanel, Froxlor, InterWorx, BrainyCP, CyberPanel, HestiaCP,
  VestaCP, FastPanel, CWP. 29 additional CVEs reviewed. Full table
  in docs/SECURITY-HARDENING.md. Key: CVE-2026-41940 (cPanel
  session CRLF, CVSS 9.8 KEV), CVE-2025-66431 (Plesk domain RCE-
  as-root), CVE-2024-51567 (CyberPanel pre-auth RCE, CVSS 10.0,
  PSAUX ransomware), CVE-2025-48702 (aaPanel tar argument
  injection — array form does NOT prevent this), CVE-2026-26279
  (Froxlor email-validation logic bug), CVE-2023-53945 (BrainyCP
  crontab RCE), CVE-2023-35885 (CloudPanel auth bypass).
- NEW VALIDATORS (7). _validate_domain (CVE-2025-66431 Plesk),
  _validate_email (CVE-2026-26279 Froxlor), _validate_cron_schedule
  (CVE-2023-53945 BrainyCP), _validate_mysql_identifier
  (CVE-2026-58048 cPanel), _sanitize_for_file (CVE-2026-41940
  cPanel), _decode_then_validate (CVE-2026-29205 cPanel cpdavd),
  safe_tar_create (CVE-2025-48702 aaPanel + IWX-CVE-2022-8384
  InterWorx — tar --null -T - keeps filenames out of argv).
- SECURITY-HARDENING SUBCOMMAND EXPANDED. cmd_security_hardening
  now returns 17 applied items (was 9) and 48 CVEs reviewed
  (was 19).
- REGRESSION TESTS EXPANDED. 25 new tests for v0.0.43 validators.
  Total: 45 (v0.0.36) -> 70 tests.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.36-1
- FIREWALL BACKEND DROPDOWN. User directive: add cilium as a
  dropdown option in the firewall area; operator can select custom
  (default basic templates), cilium, or other firewall scripts that
  install cleanly with value for the eBPF era and nftables. iptables
  is old now. Skip older firewalls without eBPF support. UFW doesn't
  count. fwbuilder too complex for average user. v0.0.36 ships three
  backends: custom, cilium (eBPF datapath — replaces nftables;
  packets filtered in BPF programs at XDP/tc; identity-based
  policy; L7 via Envoy), and sysdeck-fw (unified nftables zone
  firewall — logic derived from Smoothwall Express + IPFire under
  our own identifier; we do not ship templates called "smoothwall"
  or "ipfire" because those are other projects' trademarks).
  Excluded: UFW, fwbuilder, iptables-legacy, iptables-nft,
  Shorewall, Smoothwall Express (trademark — logic derived from
  for sysdeck-fw), IPFire (trademark — logic derived from for
  sysdeck-fw) — each documented in the panel's expandable
  "Excluded backends" block.
- NEW TEMPLATES. cilium.sh (Cilium eBPF policy loader) and
  sysdeck-fw.sh (unified nftables zone firewall — zone matrix +
  source-verified outbound + AirWall + flow offload; logic derived
  from Smoothwall Express + IPFire under our own identifier). Both
  implement the standard start/stop/restart/detect/status/check
  interface.
- NEW POLICY FILE. firewall/policies/cilium-default.yaml — the default
  CiliumNetworkPolicy applied by cilium.sh start. Default-deny ingress
  + egress, allows DNS to kube-dns, allows SSH/HTTP/HTTPS.
- SECURITY HARDENING. Researched CVE disclosures for Webmin, Cockpit,
  Ajenti, ISPConfig, Virtualmin. Applied lessons:
  CVE-2019-15107 (strict allowlist regex on user input before argv),
  CVE-2024-2947 (filename validation ^[A-Za-z0-9._-]+$),
  CVE-2026-4631 ("--" separator before user positionals),
  CVE-2024-6126 (env scrubbed on every privileged subprocess),
  CVE-2022-36446 (all bridge output escaped in JS, no innerHTML),
  CVE-2022-30708 (path resolution with realpath + startswith),
  CVE-2019-15642 (no eval/pickle/yaml.unsafe_load),
  CVE-2022-0824 (per-verb polkit check, no UI-trust),
  CVE-2020-35606 (reject on first mismatch, no sanitization),
  2019 Webmin backdoor (release-gate runs git status --porcelain;
  reproducible builds with pinned LC_ALL=C, SOURCE_DATE_EPOCH).
  Full checklist in docs/SECURITY-HARDENING.md.
- NEW BRIDGE SUBCOMMANDS (11): backends, backend-info, active-backend,
  switch-backend, install-backend, cilium-status, cilium-endpoints,
  cilium-policy, cilium-policy-apply, cilium-policy-validate,
  security-hardening.
- POLICY EXPANSION. org.sysdeck.firewall.modify action extended to
  authorize /usr/bin/cilium, /usr/sbin/cilium, /usr/bin/cilium-agent,
  /usr/sbin/cilium-agent, /usr/bin/helm, /usr/sbin/helm.
- KEYWORDS EXTENSION. plugins/sysdeck-firewall/manifest.json keywords
  list extended with cilium, ebpf, xdp, smoothwall, ipfire, zone,
  color zone, airwall, backend, security, hardening.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.34-1
- CONTAINERS + KATA CONSOLIDATION. User directive: merge the two
  modules and replace with the cockpit-kata sub-project upload. The
  standalone sysdeck-kata plugin is removed; the Kata portion of the
  merged panel loads the pre-built cockpit-kata React app via iframe
  to a hidden helper plugin at sysdeck-containers-kata/. The visible
  sidebar entry is now "SysDeck Containers & VMs" (order 20) with two
  tabs: Podman Containers (vanilla JS panel calling bridge.containers)
  and Kata Sandboxes (iframe to the React app). The standalone
  cockpit-kata sub-project closes after this release.
- GLANCES WEB UI INTEGRATION. User directive: integrate the built-in
  webui as a module. bridge/glances.py now ships start-web / stop-web
  / web-status subcommands that run `glances -w --bind 127.0.0.1
  --port 61208` as a background process. The panel iframes the running
  web UI at http://127.0.0.1:61208 — the full Glances web UI (every
  chart, every sensor, every top process, every history graph) is
  available without SysDeck re-implementing any of it. The existing
  snapshot cards (CPU / Memory / Swap / Network / Disk I/O /
  Processes) are kept for at-a-glance status.
- THEMES 1999 POWER-TOOL EXPANSION. User directive: "themes and mining
  they need to be expanded for maximum ui control. think 1999 power
  tool style here." New bridge/themes.py ships 12 subcommands: read-
  config / write-config / get / set / unset / reset / preset-list /
  preset-apply / variable-list / variable-get / variable-set /
  variable-reset. Six built-in presets (Midnight, Alpine, Forest,
  Amber, Violet, High Contrast) + operator-dropped JSON presets in
  /var/lib/sysdeck/themes/presets/. Twelve CSS variables (--sysdeck-bg,
  --sysdeck-fg, --sysdeck-accent, etc.) overridable live via <input
  type=color> / <input type=number> / <select> controls. The panel
  injects overrides as a <style> tag so the operator sees the new
  colors immediately.
- MINING 1999 POWER-TOOL EXPANSION. bridge/mining.py now ships 16
  subcommands: summary / threads / pool-config-get / pool-config-set
  / threads-config-get / threads-config-set / algorithm-get /
  algorithm-set / pause / resume / pause-worker / resume-worker /
  start / stop / restart / service-status. Every XMRig REST API knob
  is exposed. The panel renders: summary stats, service controls
  (start/stop/restart xmrig.service via polkit), all-workers pause/
  resume via XMRig JSON-RPC, per-thread hashrate table with per-worker
  pause/resume buttons, pool config form, thread count form, algorithm
  picker with 7 RandomX variants.
- bridge/kata.py REMOVED — consolidated into sysdeck-containers. The
  Kata panel is the pre-built cockpit-kata React app, loaded via
  iframe; no SysDeck-side bridge helper is needed.
- shared/bridge.js: bridge.kata surface removed. bridge.glances
  extended with startWeb/stopWeb/webStatus. bridge.themes extended
  from 1 method to 11 methods. bridge.mining extended from 1 method
  to 16 methods.
- scripts/generate-plugins.py MODULES table: removed sysdeck-kata
  entry; updated sysdeck-containers label to "SysDeck Containers &
  VMs". KEYWORDS dict: merged 'kata' into 'containers'; removed the
  standalone 'kata' KEYWORDS entry.
- README.md: bumped tagline "twenty" → "nineteen". Module catalog
  merged row 8 (Kata) into row 1 (Containers & VMs); renumbered
  rows 9-22 → 8-21. Added v0.0.34 highlights. Updated architecture
  file-tree.
- compat/compat-manifest.json: removed standalone kata entry;
  extended containers entry to mention kata-runtime as optional.
  Bumped min_cockpit for containers to 286 (cockpit-kata React app
  requires cockpit 286).
- plugins/sysdeck-containers/manifest.json: label updated to
  "SysDeck Containers & VMs". keywords extended with kata/sandbox/
  vm/isolation. content-security-policy extended with frame-src
  'self' so the Kata tab iframe loads cleanly.
- plugins/sysdeck-containers-kata/manifest.json: new hidden helper
  plugin. Uses cockpit's preload mechanism (no menu entry so it does
  not appear in the sidebar).
- Version bumped 0.0.33 → 0.0.34 across all 7 release-surface files.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.33-1
- POLICY MODULE — FULL LSM STACK EXPANSION. User directive: "lets now
  add smack, tomoyo, yama and others as well to the same policy module."
  AppArmor confirmed in-place in bridge/policy.py (v0.0.32 surface:
  apparmor-status/profiles/enforce/complain); no duplicate module.
  v0.0.33 extends bridge/policy.py with: lsm-status, smack-status,
  smack-labels, smack-load, tomoyo-status, tomoyo-profiles,
  tomoyo-save-policy, yama-status, yama-set-scope, loadpin-status,
  lockdown-status, bpflsm-status, landlock-status, filecaps-list,
  filecaps-show, filecaps-set, filecaps-remove. Each new LSM is
  optional — the bridge auto-detects via /sys/kernel/security/<lsm>/;
  if absent, the panel renders an enable hint with the kernel cmdline.
  SELinux skipped per user directive (native to host distro).
- MOE QA PASS (MIXTURE-OF-EXPERTS): senior QA analyst + senior Linux
  engineer + senior architect + senior admin + project-manager-in-devops
  lens applied. Replaced nested ifs with lookup tables (LSM_PROBES,
  NON_LSM_CONCERNS, SMACK_FILE_MAP, TOMOYO_FILES, YAMA_SCOPE_NAMES);
  shifted for/while toward map/filter/reduce where the data shape
  allowed; kept PEP 868, POSIX, SEI CERT, MISRA in mind. Every
  failure mode returns structured JSON with { available: false, reason,
  install } rather than crashing.
- POLKIT POLICY EXPANSION: org.sysdeck.policy.modify now authorizes
  30+ binaries — added smackload, smackcipsos, smackcipso,
  tomoyo-setprofile, tomoyo-set-profile, tomoyo-savepolicy, tomoyo-init,
  setcap, getcap (in addition to v0.0.32 set: setfacl, getfacl, mkdir,
  mount, ip, bpftool, lsns, aa-enforce, aa-complain, aa-status).
- DOCUMENTATION REWRITE: README.md, QUICKSTART.md, BLOG.md, LICENSE
  state every design choice as a standing decision in the present
  tense; active code comments and current-version docs carry no
  development-churn narration (release history stays in the changelog,
  where it belongs).
- STEP-DOWN LOGIC: SELinux decision documented in BLOG.md v0.0.33
  entry — three options considered (implement / skip / detect-only);
  option 2 won because it composes best with the rest of the system.
- scripts/generate-plugins.py KEYWORDS: extended policy entry with
  smack, tomoyo, yama, loadpin, lockdown, landlock, lsm, setcap,
  getcap, capabilities, ptrace.
- compat/compat-manifest.json: policy entry install-hint extended to
  include libcap (Arch/Fedora) / libcap2-bin (Debian) for filecaps;
  optional_dep_package list now mentions smack-util / tomoyo-tools
  where packaged.
- Version bumped 0.0.32 → 0.0.33 across all 7 release-surface files.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.32-1
- TWO NEW MODULES — POLICY & PERMISSIONS + DB CONTROL. Plugin count
  goes from 18 to 20.
- POLICY & PERMISSIONS MODULE (NEW): bridge/policy.py surfaces five
  concerns per user directive — ACLs (getfacl/setfacl), cgroups v2
  unified hierarchy (mkdir / move PID / write control files), VLANs
  (ip link add/del type vlan), eBPF programs and maps (bpftool +
  pin-to-bpffs), and namespaces (lsns). SELinux skipped (native).
  AppArmor is OPTIONAL — bridge auto-detects whether it is compiled
  into the kernel; if absent, panel renders install hint instead of
  empty table. 25 subcommands (summary + 4 ACL + 6 cgroup + 4 VLAN +
  4 eBPF + 2 namespace + 4 AppArmor).
- DB CONTROL MODULE (RESTORED): the DB Control module (cockpit-db)
  was originally added in v0.0.15 alongside Prometheus and Grafana.
  The v0.0.20 architectural overhaul split SysDeck into 18
  standalone plugins and the DB plugin panel got dropped in the cut
  — only 18 made the list, even though the bridge helper survived.
  v0.0.32 restores the plugin panel and fixes the v0.0.15-era
  `sudo systemctl` shell-out in cmd_start/stop/restart — the cockpit
  way (per v0.0.31 pattern) is to run systemctl directly via
  subprocess and let the JS panel pass { superuser: 'try' } so the
  cockpit bridge prompts the operator via polkit for the new
  org.sysdeck.db.modify action. The bridge surfaces 32+ engines
  across SQL/NoSQL/Vector/TimeSeries/Graph/Embedded/Cloud/AI
  families with summary/status/start/stop/restart/connections/
  query subcommands.
- NEW POLKIT ACTIONS: org.sysdeck.policy.modify (authorizes setfacl,
  getfacl, mkdir, mount, ip, bpftool, lsns, aa-enforce, aa-complain,
  aa-status for the new Policy module); org.sysdeck.db.modify
  (authorizes /usr/bin/systemctl for the DB Control module's
  start/stop/restart subcommands).
- README.md module catalog: added row 19 (Policy & Permissions) and
  row 20 (DB Control); renumbered Prometheus to 21 and Grafana to
  22. v0.0.32 highlight section added.
- compat/compat-manifest.json: added policy and db entries with per-
  distro install commands for acl/iproute2/bpftool/util-linux +
  optional apparmor.
- scripts/generate-plugins.py MODULES table: added sysdeck-policy
  (order 38) and sysdeck-db (order 39). KEYWORDS dict expanded with
  policy and db keyword lists.
- Makefile: bumped install target message to "20 Cockpit plugins".
  The existing for-loop already picks up any plugins/sysdeck-*/
  directory so no install-target change was needed.
- shared/bridge.js: added bridge.policy surface (25 methods) and
  bridge.db surface (7 methods). All mutating methods use
  { superuser: 'try' } — no `sudo` shell-out from JS anywhere.
- Version bumped 0.0.31 → 0.0.32 across all 7 release-surface files.

* Mon Aug 18 2026 Jeremy Anderson <info@dcos.net> - 0.0.31-1
- FIREWALL MODULE REWRITE: v0.0.30 panel was read-only (could only list
  nftables rules). v0.0.31 makes it a full manager: template selector,
  Apply/Stop/Restart, ban/unban IP, clear bans, live service detection.
  New bridge subcommands: templates, template-info, detect, apply, stop,
  restart, status, ban, unban, banned, clear-bans, check. Two templates
  ship under /usr/share/sysdeck/firewall/templates/ (vps-webserver.sh,
  no-services.sh) and the operator can drop more in. Mutating ops run
  via cockpit superuser channel + org.sysdeck.firewall.modify polkit
  action — no shell-out to sudo from JS.
- PACKAGES MODULE — UPDATE NEEDS SUDO, FIXED THE COCKPIT WAY. v0.0.30
  packages.js Update All button called bridge.packages.updateAll() which
  returned the command string that would be run, NOT the result. The
  panel showed alert("Run this command with superuser privileges."). The
  operator had to copy the command, open a terminal, sudo, paste, run.
  v0.0.31 makes install/remove/update/update-all actually execute via
  the cockpit superuser channel (polkit). The bridge helper runs the
  detected package manager via subprocess with check=True, and the JS
  panel subscribes to the cockpit spawn stream so the operator sees
  live stdout/stderr in a <pre> log panel — exactly like cockpit's own
  Packages panel. No sudo shell-out from JS.
- IMAGE BUILDER MODULE — EXPANDED TO FULL-FEATURED. v0.0.30 builder was
  a status+profile viewer: could list installed backends and walk their
  config dirs, but could not actually build anything, could not create/
  edit profiles, could not show build artifacts or logs. v0.0.31 adds:
  build(profile, backend, options), profile-create(name, backend, base),
  profile-delete(name), artifacts(profile?), build-status(), build-log(id).
  The panel renders a Build button per profile, a Builds table, a per-
  build log viewer, and a Create Profile form.
- FESTER RENAME: build orch panel menu label and panel title changed
  from "SysDeck Build Orchestration" to "SysDeck Fester" per user
  directive. Updated manifest.json, fester.js, scripts/generate-plugins.py
  MODULES table, README.md, compat-manifest.json, BLOG.md.
- POLKIT POLICY: added org.sysdeck.fester.modify action covering
  /usr/bin/systemctl and /usr/bin/journalctl for future fester DAG
  orchestration. Existing firewall.modify and packages.modify actions
  already authorize the binaries the new subcommands invoke.
- MAKEFILE: new FIREWALL_TEMPLATES_DIR variable; install target copies
  firewall/templates/*.sh to /usr/share/sysdeck/firewall/templates/
  with mode 0755; dist target includes the firewall/ source tree.
- Version bumped across release surfaces (Makefile, __init__.py,
  setup.py, PKGBUILD, spec, debian/changelog, compat-manifest.json).

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.30-1
- BUILDER MODULE REWRITE: target distros now Arch + Debian. Replaced
  the osbuild-composer / composer-cli bridge shim (Fedora/RHEL-only,
  permanently 'inactive' on Arch/Debian) with a multi-backend
  detection layer: mkosi + archiso on Arch; vmdb2 + live-build on
  Debian. New bridge subcommands: status, profiles, summary, backends,
  install-hint. Rewrote plugins/sysdeck-builder/builder.js to render
  per-backend profile cards + a distro-specific install hint. Updated
  polkit org.sysdeck.builder.modify to authorize /usr/bin/mkosi,
  /usr/bin/mkarchiso, /usr/bin/vmdb2, /usr/bin/lb (osbuild +
  livemedia-creator annotations removed). Updated compat-manifest.json
  builder entry: Arch and Debian distro_support upgraded from 'none'
  to 'full'. Fedora entry repointed from osbuild-composer to mkosi
  (cross-distro). Updated plugin manifest keywords + docs.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.29-1
- EMAIL MIGRATION: author/maintainer contact address changed from
  jeremy@dcos.net to info@dcos.net across every release surface:
  debian/changelog (all 17 historical entries), debian/control
  Maintainer, packaging/setup.py author_email, PKGBUILD Maintainer +
  Contributor, sysdeck.spec changelog (all 19 historical entries).
  Rationale: project moved to a shared info@ inbox; no per-developer
  addresses on public packaging. Author name "Jeremy Anderson" is
  preserved everywhere; only the email address is replaced.
- REMOVED DUPLICATE CONTAINER ENTRY: deleted
  standalone-plugins/cockpit-podman/. Podman ships its own native
  Cockpit module upstream, so bundling a second cockpit-podman
  manifest here was duplicating upstream — installing both would
  produce two competing sidebar entries pointing at the same backend.
- NEW standalone-plugins/cockpit-incus/manifest.json: sidebar link
  (order 46, gated on /usr/bin/incus) for Incus system container and
  VM management. Incus is the LXC/LXD successor maintained by the
  Linux Containers project. This slot was the original intent for
  the third standalone plugin slot, which had been mis-assigned to
  podman.
- UPDATED compat/compat-manifest.json: standalone_plugins.cockpit-podman
  entry replaced with standalone_plugins.cockpit-incus. Per-distro
  install commands: pacman -S incus (Arch), dnf install incus
  (Fedora 40+), apt install incus (Debian 13 trixie / bookworm
  backports). distro_support: full on all three target distros.
- UPDATED sysdeck-diagnose.sh section 13 reference loop: was
  iterating over cockpit-podman / cockpit-machines / cockpit-ostree;
  now iterates over cockpit-incus / cockpit-machines / cockpit-ostree.
- UPDATED README.md v0.0.15 highlights section: the three standalone
  plugin sidebar links now list cockpit-incus (order 46) instead of
  cockpit-podman.
- UPDATED QA.md v0.0.15 QA section 2: standalone plugin table row 3
  changed from cockpit-podman (Podman Containers) to cockpit-incus
  (Incus Containers).

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.28-1
- FIXED 2 BROKEN BRIDGE SUBCOMMANDS that slipped through v0.0.27's
  "subcommand alignment" pass:
    1. firmware.py: bridge.js called `python3 firmware.py devices` but
       the helper only implemented `summary`. Result: every visit to the
       Firmware plugin page crashed with "Unknown subcommand: devices".
       Fix: added a real `devices` subcommand returning fwupdmgr's
       native {Devices: [...]} shape (capital D, matches the panel's
       `result.value?.Devices` access pattern).
    2. benchmark.py: bridge.js called `python3 benchmark.py run-test <name>`
       when the user clicked "Run" in the Available Tests table, but the
       helper had no `run-test` subcommand. Fix: added `run-test` that
       runs `sysbench <name> run` and returns the parsed result dict
       ({raw, events_per_sec, latency_ms, error?}) — same shape as the
       existing run-cpu/run-memory/run-io helpers.
- NEW BUILD-TIME GUARD: `check-bridge-subcommands` in `make check`.
  Cross-checks every `bridgeCmd("<module>", ["<sub>", ...])` call in
  shared/bridge.js against the COMMANDS dict declared in each
  bridge/<module>.py. Would have caught both bugs above. Regression-
  tested: reverting firmware.py to its v0.0.27 state causes the guard
  to fail with a clear message naming the file, line, and missing
  subcommand.
- FIXED MISSING CSS CLASSES: shared/sysdeck.css was missing
  .suite-progress, .suite-progress-bar, .suite-progress-fill,
  .suite-stat-value, .suite-stat-label, .suite-row, .suite-row-between,
  .suite-grid, .cols-2, .cols-3, .suite-col-2, .suite-col-3,
  .suite-btn-primary, .suite-badge.info, .suite-input, .suite-warn.
  Without them, progress bars in glances/fleet/netsec were invisible
  (0-height divs), multi-column layouts in fleet/integrity/mining/
  packages collapsed to a single column, and primary CTA buttons in
  benchmark/integrity/packages looked like ghost buttons. All added.
- FIXED COCKPIT-SMOKE-TEST.SH: the embedded manifest used
  "requires": { "cockpit": ">=239" } — the exact broken pattern that
  Cockpit silently rejects at the discovery layer (sortify_version()
  turns ">=" into a string that sorts greater than any real cockpit
  version). Smoke test would produce a false "Cockpit is broken"
  diagnostic. Fixed to "cockpit": "239" (bare number) to match the
  pattern used by every real working plugin.
- IMPROVED DIAGNOSTIC: sysdeck-diagnose.sh now verifies that
  /usr/lib/sysdeck/bridge/*.py exists and is executable, and spot-
  checks that firmware.py `devices` and benchmark.py `run-test`
  subcommands work end-to-end. Previously the diagnose script could
  not detect a missing Python helper — every plugin would silently
  fail with "No such file or directory" and the user had no clue.
- FIXED DOCS: bridge/__init__.py docstring still showed the broken
  `python3 -m sysdeck.bridge.<module>` invocation pattern that was
  fixed in v0.0.26. Updated to `python3 /usr/lib/sysdeck/bridge/<m>.py`
  with a note explaining why the -m pattern was broken.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.27-1
- FIXED 6 MISSING PYTHON HELPERS: mining.py, builder.py, fester.py,
  kata.py, vault.py, mesh.py were never written — every plugin that
  called one got "Module load failed: can't open file". Wrote minimal
  stubs that return empty data structures so the modules render with
  "no items" instead of crashing. Each stub uses the real backend tool
  (kubectl, kata-runtime, lsblk, systemctl, XMRig REST API) and returns
  empty when the tool is absent.
- FIXED 4 SUBCOMMAND MISMATCHES: bridge.js called subcommands the Python
  helpers didn't have:
    auth.smartcards        → now calls 'slots' (auth.py has 'slots', not 'smartcards')
    netsec.listeningPorts  → now calls 'sockets' (netsec.py has 'sockets')
    integrity.trustScore   → now calls 'score' (integrity.py has 'score')
    integrity.runLynis     → now calls 'scan' (integrity.py has 'scan')
    firewall.listChains   → now calls 'chains' (firewall.py has 'chains')
    firewall.listRules    → now calls 'ruleset' (firewall.py has 'ruleset')
    firewall.ruleCount    → now computes from ruleset (no 'count' subcommand)
    containers.count      → now computes from list (no 'count' subcommand)
    containers.action     → now calls podman directly (no 'action' subcommand)
    fleet.uptime          → now derives from summary (no 'uptime' subcommand)
    fleet.nodeCount       → now derives from summary (no 'node-count' subcommand)
    firmware.tpmInfo      → now reads PCR0 directly via tpm2_pcrread
  Each subcommand now verified against the actual COMMANDS dict in the
  Python helper before being called.
- NOT A BUG (working as designed): glances module shows "Glances
  unavailable" when the glances binary is not installed. This is the
  module's own graceful degradation — same pattern as "Podman unavailable",
  "Lynis unavailable", etc. Install the backend tool to see real data.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.26-1
- ROOT CAUSE FOUND AND FIXED: every plugin that called a bridge helper
  failed with ModuleNotFoundError: No module named 'sysdeck.bridge'.
  Cause: shared/bridge.js called `python3 -m sysdeck.bridge.<module>`, which
  requires a Python package layout (sysdeck/bridge/<module>.py) that doesn't
  exist in the install. The actual layout is /usr/lib/sysdeck/bridge/<module>.py
  (flat files, not a nested package). So `python3 -m sysdeck.glances` would
  have worked, but `python3 -m sysdeck.bridge.glances` never could.
  Fix: changed bridgeCmd() to call helpers by absolute path:
    `python3 /usr/lib/sysdeck/bridge/<module>.py <args>`
  No package layout, no PYTHONPATH, no symlink needed.
  Also: Makefile now installs each helper as executable (0755, not 0644)
  so they can be invoked directly. Removed the broken site-packages
  symlink that was trying (and failing) to make `python3 -m sysdeck.bridge`
  resolve.
  Note: only firmware/fleet/themes 'worked' in v0.0.25 because they use
  Promise.allSettled() (catches rejections silently) or cockpit.file()
  (no Python helper needed) — they were showing 'unavailable' cards, not
  real data. With v0.0.26 the other 15 modules should now load real data.
- New guard: check-no-broken-python-module in `make check` scans every JS
  file for spawn calls using `python3 -m sysdeck.bridge` and fails with a
  clear message. Negative-tested: the broken pattern makes `make check`
  fail.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.25-1
- ROOT CAUSE FOUND AND FIXED: every plugin page showed "Module load
  failed: error loading dynamically imported module:
  http://127.0.0.1:9090/cockpit/@localhost/sysdeck-common/bridge.js".
  Cause: shared/sysdeck-common/ had bridge.js and sysdeck.css but NO
  manifest.json. Cockpit only registers a directory as a package if it
  contains manifest.json (packages.py:457 scans cockpit/*/manifest.json).
  Without registration, every URL like
  /cockpit/@localhost/sysdeck-common/bridge.js returned 404, and the
  dynamic import("../sysdeck-common/bridge.js") failed.
  Fix: added shared/manifest.json with name="sysdeck-common". Pattern
  verified from cockpit's own pkg/static/manifest.json (just `{}`).
  Updated Makefile install to install shared/manifest.json alongside
  bridge.js and sysdeck.css.
  Updated tests/check_manifest_consistency.py to verify shared/manifest.json
  exists — regression-tested by deleting it and confirming `make check`
  fails with a clear message naming packages.py:457.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.24-1
- THOROUGH UNINSTALLER: previous `make uninstall` only removed
  /usr/share/cockpit/sysdeck-* (with dash). v0.0.9-v0.0.19 installed
  to /usr/share/cockpit/sysdeck/ (no dash) — that directory was NEVER
  removed by uninstall. Cockpit would discover both old and new
  manifests, possibly serving old broken code instead of the new
  freshly-installed code. v0.0.24 uninstall now removes:
    * /usr/share/cockpit/sysdeck/        (v0.0.9-v0.0.19 single-plugin)
    * /usr/share/cockpit/sysdeck-*/      (v0.0.20+ multi-plugin)
    * /usr/lib/sysdeck/                  (Python bridge, all versions)
    * /usr/share/sysdeck/                (diagnostic scripts, v0.0.19+)
    * /usr/share/doc/sysdeck/            (docs, v0.0.20+)
    * /usr/share/metainfo/sysdeck.metainfo.xml        (v0.0.17+)
    * /usr/share/polkit-1/actions/org.sysdeck.policy (v0.0.17+)
    * python site-packages sysdeck symlink            (all versions)
    * pacman-tracked sysdeck package                   (if installed via PKGBUILD)
- VISIBLE ERROR REPORTING: every plugin's index.html now installs
  window.addEventListener('error') and 'unhandledrejection' handlers
  that replace the 'Loading…' placeholder with the actual error message
  on the page. No devtools required — the user sees the error directly.
- COCKPIT.JS PRESENCE CHECK: every plugin's index.html now checks
  `if (!window.cockpit)` before importing bridge.js, and shows a clear
  error if cockpit.js failed to load (e.g., 404 on ../base1/cockpit.js).
- TRY/CATCH AROUND MOUNT(): if mount() throws synchronously (e.g., bridge
  is undefined, panel is null), the error is now displayed on the page
  instead of leaving it stuck on 'Loading…'.
- DIAGNOSTIC SCRIPT: sysdeck-diagnose.sh now detects leftover
  /usr/share/cockpit/sysdeck/ directory from old installs, and
  spot-checks that the installed bridge.js contains the v0.0.23+
  `const cockpit = window.cockpit` fix.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.23-1
- ROOT CAUSE FOUND AND FIXED: every plugin page was stuck on "Loading…"
  because shared/bridge.js did `import cockpit from "../base1/cockpit.js"`
  — an ES module import. But pkg/base1/cockpit.js is NOT an ES module:
  it's a UMD/IIFE that sets window.cockpit as a global (verified from
  cockpit source code: pkg/base1/cockpit.js has no `export` statements;
  cockpit's own plugins load it via <script src> in their HTML, then
  access the global `cockpit`). The import returned undefined, so
  cockpit.spawn() threw when mount() ran, and the plugin page never
  rendered. Fix: replaced `import cockpit from "../base1/cockpit.js"`
  with `const cockpit = window.cockpit` — exactly how the cockpit
  source code accesses it after the esbuild plugin (build.js:71-83)
  rewrites `import cockpit from "cockpit"` to `module.exports = cockpit`.
- New guard: check-no-broken-cockpit-import in `make check` scans every
  JS file in plugins/ and shared/ for the broken `import cockpit from`
  pattern. Negative-tested: the v0.0.22 import form makes `make check`
  fail with a clear message citing the cockpit source code.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.22-1
- ROOT CAUSE FOUND AND FIXED: the `requires.cockpit` field was set to
  ">=239" in every manifest since v0.0.9. Cockpit's packages.py uses
  sortify_version() (a 0-pad of numeric components) to compare versions,
  NOT a semver parser. ">=239" becomes ">=00000239" which is GREATER than
  any real cockpit version (because '>' is ASCII 62 > '0' ASCII 48),
  causing packages.py:263 to raise JsonError and silently reject every
  manifest at install time. The plugins never reached the shell's menu
  builder — that's why the sidebar was empty.
  Fix: changed `requires.cockpit` from ">=239" to "239" (bare number) in
  all 18 manifests. This matches the pattern in pkg/systemd/manifest.json
  ("cockpit": "265"), pkg/storaged/manifest.json ("cockpit": "266"), etc.
  None of cockpit's own plugins use the ">=" prefix.
- Renamed all 18 sidebar labels from "SD <Name>" to "SysDeck <Name>"
  per user requirement: "SysDeck should be never abbreviated. So SD is
  not ok."

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.21-1
- Fix AppStream metainfo: replace <provides><cockpit-manifest> (silently
  ignored by cockpit's apps page) with <launchable type="cockpit-manifest">
  for each of the 18 plugins. Pattern verified from the cockpit source
  code itself: src/appstream/org.cockpit_project.cockpit_*.xml.in all
  use <launchable>, and pkg/apps/watch-appstream.py:237 reads it.
- Rewrite tests/check_manifest_consistency.py to validate against the REAL
  Cockpit manifest contract from pkg/shell/manifests.ts and
  src/cockpit/packages.py — not the invented contract used in v0.0.19-v0.0.20.
  The previous test was wrong: it rejected manifests for having `version`,
  `title`, `priority`, `content` sections — none of which Cockpit actually
  rejects. They are silently ignored by the shell.
- Rewrite tests/check_metainfo_consistency.py to validate <launchable>
  elements (the real pattern) instead of <provides><cockpit-manifest>.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.20-1
- ARCHITECTURAL OVERHAUL: split the single SysDeck shell into 18
  standalone Cockpit plugins. Each module (containers, firewall,
  integrity, etc.) is now its own plugin at /usr/share/cockpit/sysdeck-<name>/
  with its own manifest.json + index.html + <module>.js. Each appears as
  its own sidebar entry in Cockpit, just like cockpit-podman,
  cockpit-machines, and cockpit-ostree do.
- DELETED the v0.0.19 shell entirely: manifest.json, index.html, suite.js,
  suite.css, src/bridge-client.js, src/event-bus.js, src/mock-cockpit.js,
  src/cockpit-types.d.ts, src/modules/, and the entire nextjs-dashboard/
  tree. Cockpit is the dashboard framework; we are no longer rebuilding one.
- NEW shared/bridge.js at /usr/share/cockpit/sysdeck-common/bridge.js:
  provides the `bridge` and `EventBus` objects that each plugin imports.
  Calls cockpit.spawn() directly to invoke the Python bridge helpers.
  Live-update subscriptions (subscribeCount, subscribeLoadAvg,
  subscribeSocketRate, dbusProxies.systemd) are no-ops in v0.0.20 —
  each plugin provides a manual Refresh button instead. v0.0.21 can
  re-enable live updates via cockpit.dbus if needed.
- NEW shared/sysdeck.css at /usr/share/cockpit/sysdeck-common/sysdeck.css:
  base styles for every plugin. Module JS still uses .suite-* class
  names from v0.0.19; the shared CSS provides both .sysdeck-* and
  .suite-* aliases so the module JS works unchanged. v0.0.21 can
  rename the classes inside the module JS and drop the aliases.
- NEW scripts/generate-plugins.py: regenerates plugins/ and shared/
  from the v0.0.19 src/modules/*.js source files. Run `make plugins`
  to regenerate. Persisted in the tarball so packagers can re-run it.
- Updated tests/check_manifest_consistency.py: validates ALL 18 plugin
  manifests against the cockpit-podman reference pattern (was: validated
  the single sysdeck manifest). One bad manifest = one missing sidebar
  entry, so each one is checked independently.
- Updated Makefile: install target creates 18 plugin directories under
  /usr/share/cockpit/sysdeck-<name>/, plus shared/ at
  /usr/share/cockpit/sysdeck-common/, plus the Python bridge at
  /usr/lib/sysdeck/bridge/, plus the diagnostic scripts at
  /usr/share/sysdeck/. dist target includes plugins/, shared/, scripts/.
- DROPPED: nextjs-dashboard/ (the standalone Next.js variant was never
  used and pulled in 50+ MB of node_modules). If operators want a
  standalone dashboard they can run the cockpit plugins directly —
  they're plain HTML+JS, no Node.js required.
- DROPPED: src/cockpit-types.d.ts (was only used by the now-deleted
  bridge-client.js). The plugins import cockpit.js directly.
- DROPPED: src/mock-cockpit.js (was only used for dev-mode testing
  of the shell). Each plugin now loads ../base1/cockpit.js directly.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.19-1
- CRITICAL FIX: rewrote manifest.json to match the working cockpit-podman
  pattern exactly. Previous releases (v0.0.9 through v0.0.18) used a
  manifest schema with 'version: 1', a 'content' section, and a
  'menu.suite' entry with an explicit 'path' field — none of which
  appear in any real, working Cockpit plugin's manifest. Cockpit silently
  rejected the plugin on every install, leaving "zero entries anywhere"
  in the sidebar and Applications menu.
- New manifest uses: version=0 (universally supported), menu.index (the
  magic key Cockpit uses to serve index.html implicitly), no 'content'
  section, no 'path' on menu entries, no top-level 'title' or 'priority'.
  This matches cockpit-podman, cockpit-machines, cockpit-ostree — the
  three reference plugins shipped in this very tarball under
  standalone-plugins/.
- Hardened guard: tests/check_manifest_consistency.py no longer validates
  against a made-up contract. It now validates against the actual
  cockpit-podman reference manifest — fails if sysdeck's manifest has
  any field not present in cockpit-podman's manifest. Regression-tested:
  deliberately reverting to the v0.0.18 manifest fails with a clear
  message naming every deviation.
- Added sysdeck-diagnose.sh: prints exactly what Cockpit sees on the
  target system (installed manifest content, file permissions, cockpit
  journal errors, AppStream cache state, comparison against reference
  manifests). Installed to /usr/share/sysdeck/sysdeck-diagnose.sh.
- Added cockpit-smoke-test.sh: installs a 5-line hello-world Cockpit
  plugin to /usr/share/cockpit/hellotest/ to verify Cockpit's plugin
  discovery works INDEPENDENTLY of sysdeck. If 'Hello Test' also fails
  to appear in the sidebar, the issue is Cockpit itself, not sysdeck.
- Updated Makefile: dist target includes the two new scripts; check
  target bash-syntax-checks them.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.18-1
- CRITICAL FIX: v0.0.16 changed manifest.json content.suite.path from
  "/index.html" to "/suite" and menu.suite.path also pointed at "/suite".
  This passed the manifest-consistency test (paths matched each other) but
  the path did not resolve to an actual file in the plugin directory.
  Cockpit served a 404 / empty page when the user clicked the SysDeck
  sidebar entry, because no `suite.html` file existed at
  /usr/share/cockpit/sysdeck/suite.html.
- Fix: changed both content.suite.path and menu.suite.path to "/index.html".
  Cockpit now serves the real index.html file at the /index.html URL and
  the dashboard loads when the menu entry is clicked.
- Hardened guard: tests/check_manifest_consistency.py now also verifies that
  every content/menu path resolves to a real file in the plugin directory,
  mirroring Cockpit's URL-to-file mapping (e.g. /suite -> ./suite.html or
  ./suite/index.html; /index.html -> ./index.html). This catches the
  v0.0.16 silent-empty-page bug at build time.
- Corrected misleading path semantics documented in BLOG.md and QA.md for
  v0.0.16. Cockpit does NOT auto-serve index.html at arbitrary URL paths;
  the URL path declared in content/menu must map to a real file.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.17-1
- Register as a first-class Cockpit application via AppStream metainfo
  at /usr/share/metainfo/sysdeck.metainfo.xml with
  <provides><cockpit-manifest>sysdeck</cockpit-manifest></provides>.
  Without this, Cockpit-ws does not give the plugin proper auth context
  and the plugin does not appear in the Applications install menu.
- Ship PolKit policy at /usr/share/polkit-1/actions/org.sysdeck.policy
  covering six privilege domains: system.manage, firewall.modify,
  packages.modify, firmware.modify, vault.modify, builder.modify.
  Without these, privileged bridge operations fail with permission
  denied errors when invoked via cockpit.spawn.
- Makefile install target now installs both files and reloads polkit
  + refreshes the AppStream cache on install.
- New guard: check-metainfo-consistency in make check validates the
  metainfo XML has required fields and declares a cockpit-manifest.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.16-1
- CRITICAL FIX: manifest.json content.suite.path was "/index.html"
  while menu.suite.path was "/suite". Cockpit requires every menu
  entry's path to match a content entry's path. The mismatch caused
  Cockpit to silently drop SysDeck from the menu after install. The
  plugin installed but never appeared in the sidebar.
- Fix: changed content.suite.path from "/index.html" to "/suite".
  Cockpit now serves index.html at the /suite URL and the menu entry
  resolves correctly.
- New guard: check-manifest-consistency target in make check. Validates
  that every menu path matches a content path, and that required fields
  (name, title, content, menu) are present. Catches this class of bug
  at build time.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.15-1
- SOURCE COMPLETENESS: bridge/grafana.py, bridge/hwalert.py, and
  bridge/prometheus.py ship in the tarball (the v0.0.13-v0.0.14
  tarballs omitted them; 1489 lines of code).
- SOURCE COMPLETENESS: nextjs-dashboard/ directory (standalone Next.js
  variant dashboard) and prometheus/ config directory (Prometheus +
  Grafana YAML configs) ship in the source tree.
- Makefile dist target now includes prometheus/ and nextjs-dashboard/.
- Makefile install target now installs prometheus configs to
  /etc/sysdeck/prometheus/ and the Next.js dashboard to
  /usr/share/sysdeck/nextjs-dashboard/.
- Tarball size back at ~280 KB (v0.0.14 shipped an 80 KB tarball due to
  the dropped code).

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.14-1
- Fix Makefile dist target: tarball now extracts into sysdeck-<version>/
  subdirectory. The previous --transform regex silently no-op'd because
  tar with explicit file arguments does not prepend ./ to archive paths,
  which blocked RPM %%setup -q, PKGBUILD cd, and Debian dh_auto_configure.
- Add `make distcheck` regression guard that extracts the tarball into
  a clean /tmp directory, verifies the wrapping subdirectory exists,
  and runs `make check` inside the extracted tree.

* Sun Aug 17 2026 Jeremy Anderson <info@dcos.net> - 0.0.13-1
- Full Arch Linux (PKGBUILD) and Debian (.deb) packaging support.
- Packages module (pacman/dnf/apt wrapper) for package listing, search,
  install, update, and remove operations via cockpit.spawn.
- Auth identities extension: enumerates PKCS#11 tokens, SSH keys,
  and Kerberos principals as first-class identity objects.
  Attributes cockpit-identities (LGPL-2.1, cockpit-project).
- Removed incorrect Recommends: pacman from RPM spec (wrong distro).

* Sat Aug 16 2026 Jeremy Anderson <info@dcos.net> - 0.0.11-1
- External module integrations: glances (GPL-3.0, Nicolargo) for
  system monitoring, sensors (MIT, ocristopfer) for hardware sensor
  readings, benchmark (MIT, ealier) for sysbench benchmarks.
  All invoked as separate processes; no bundled code. License audit
  via THIRD_PARTY.md and MODULE_LICENSES.log pattern.

* Sat Aug 16 2026 Jeremy Anderson <info@dcos.net> - 0.0.10-1
- Bridge channel integration: cockpit.metrics tap, dbus proxies for
  systemd and NetworkManager, retry/backoff on transient spawn errors,
  permission gating on privileged calls, dev mock of the cockpit global.

* Sat Aug 16 2026 Jeremy Anderson <info@dcos.net> - 0.0.9-1
- Initial cockpit-native release: drop-in plugin with manifest.json,
  vanilla-JS dashboard, Python bridge helpers, and full packaging.
