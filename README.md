# SysDeck

**A drop-in plugin for an existing Cockpit install — twenty-six domain modules behind one dashboard.**

Author: **Jeremy Anderson** · <info@dcos.net> · <https://dcos.net>
Version: **0.2.0** (Master Edition) · License: **MIT**

---

## What this is

SysDeck is a cockpit-native plugin that consolidates the day-to-day work of a Linux operations team — containers, firewall, integrity auditing, network security, service mesh, encryption vaults, fleet compute, Kata Containers, firmware, image building, mining, theme engine, hardware authentication, DAG-driven build orchestration, system monitoring, hardware sensors, system benchmarking, package management, policy & permissions, database control, Jellyfin media server, photo manager (PhotoPrism/Piwigo/Lychee/Nextcloud-Memories/LibrePhotos), remote filesystem manager (Ceph/GlusterFS/MooseFS/BeeGFS/OrangeFS), a 3rd-party Cockpit module installer (45Drives Navigator/File-Sharing/ZFS-Manager, cockpit-pacman, cockpit-identities, cockpit-sensors, cockpit-benchmark — each pulled on demand with the license, developer, source URL, and homepage shown inline next to a 1-click Install button), and a service/port editor (a first-class sidebar entry that enumerates every listening TCP socket, cross-references against a SERVICES_REGISTRY of 9 known services — ssh, cockpit, caddy, varnish, mariadb, ollama, openwebui, hermes, odysseus — and lets the operator edit the port in each service's config file with an atomic write + systemctl restart) — into a single dashboard accessible from the cockpit web UI.

The plugin ships as static HTML+JS+CSS plus a Python bridge helper package. It installs under `/usr/share/cockpit/sysdeck-*/` and is discovered automatically by the cockpit-bridge. No separate web server, no Node.js runtime, no database — the plugin runs inside the cockpit web service.

### v0.2.0 highlights (Master Edition)

v0.2.0 ships as a **master tarball — `sysdeck-0.2.0-master.tar.bz2`** — bundling the cockpit edition (this tree), the new **SysDeck Web Edition** (`web/` — a standalone Next.js console with 28 bridge modules, an Overview landing view, and the previously-orphaned Hardware Alerts panel), and **Fester pre-integrated**.

**Fester** remains its own project upstream (independent repository, independent version line — currently 0.2.1). The master tarball vendors a pinned snapshot at `web/mini-services/fester` so nothing else needs cloning:

- **cockpit side** — `bridge/fester.py` is now a real REST client of the fester service (`FESTER_URL`, default `http://127.0.0.1:3010`; 11 subcommands: status, metrics, builds, build, nodes, targets, timeline, sessions, start-build, cancel, replay) and `plugins/sysdeck-fester/` is a full panel — the v0.0.31 systemd-listing stub is gone.
- **web side** — a dedicated Fester sub-app (live DAG, replay sessions, timeline, failure autopsy, cause graph, interactive debugger, metrics) wired via the `/api/fester` proxy and a WebSocket event stream.
- **fixed** — the shipped 0.1.3 Makefile had space-indented recipes (GNU make rejected it with `missing separator`); v0.2.0 restores tabs, and every target parses.

Quick start (web edition, from an extracted master tarball):

    make web-dev     # fester service (background, :3010) + web console (:3000)

Or step by step: `make fester-start`, then `cd web && bun install && bun run db:push && bun run dev`. Rebuild the master tarball with `make master`. See `web/README.md` for details.

### v0.1.3 highlights

v0.1.3 fixes two critical bugs and adds the download/manage UI for builds. The operator reported: *"profile workstation still doesnt import current system pkgs. it trys to build only 2."* Two root causes were identified and fixed.

- **Import bug — `from __init__ import` failed silently.** `_detect_host_packages()` relied on `from __init__ import PKG_MANAGER` which silently failed in the cockpit superuser channel context (different Python path). `PKG_MANAGER` defaulted to `"unknown"`, the host query returned an EMPTY list, and the import wrote nothing. The operator saw "tries to build only 2" because the build used the profile's original template packages.
- **Import fix — `shutil.which()`.** `_detect_host_packages()` now uses `shutil.which()` to find `pacman`/`apt-mark`/`dnf` directly — no import dependency, works in any execution context.
- **Build bug — `--include` doesn't load the config.** v0.1.2's `--include` flag includes a drop-in fragment ON TOP OF the base `mkosi.conf` — it does NOT replace the base config. If there's no `mkosi.conf` in the cwd, mkosi uses defaults and ignores the `--include` file entirely. This is why v0.1.2 still produced builds with only 2 packages.
- **Build fix — temp work dir with symlink.** `build()` now creates a temp directory, symlinks the profile file into it as `mkosi.conf`, and sets `work_dir` to that temp dir. mkosi finds `mkosi.conf` (the symlink), follows it, reads the actual profile. Works for ANY profile path regardless of filename or location. Temp dir is cleaned up after the build finishes. New helper: `_prepare_mkosi_work_dir()`.
- **New: artifact download.** Each artifact in the Artifacts panel now has a ⬇ Download button. Reads the file via `cockpit.spawn(["cat", path])` with superuser, creates a Blob, triggers browser download.
- **New: artifact management.** Each artifact has a 🗑 delete button (per-file). Each profile's artifacts card has a 🗑 Clear all button that removes ALL artifacts for that profile (shows file count + bytes freed).
- **New: build management.** Each build in the Builds table has a 🗑 delete button. Two-step confirm: (1) delete state + log only, or (2) also delete the profile's entire artifacts dir.
- **Regression tests.** 11 new unit tests in `TestBuilderArtifactManagement` (7 tests) and `TestBuilderMkosiTempWorkDir` (3 tests). Existing tests updated for the new `shutil.which` approach and removal of `--include`. Total: 254 tests (was 243; +11).
- **Version sync.** Bumped 0.1.2 → 0.1.3 across all 9 release surfaces.

### v0.1.2 highlights

v0.1.2 fixes the critical "zero packages" bug. An operator reported: *"the builder absolutely does not work yet. it has zero awareness of packages we tell it to add."* Two compounding root causes were identified and fixed.

- **Root cause 1 — mkosi never read the profile config.** `_backend_build_command()` for mkosi was `["mkosi", "build", "--output", ..., "--output-dir", ...]` with NO flag telling mkosi WHERE the profile config file is. mkosi only reads a file literally named `mkosi.conf` from the cwd. For v0.0.x profiles at `/etc/mkosi/mkosi.conf.d/<name>.conf`, mkosi ran in that dir, found no `mkosi.conf` (the file is named `<name>.conf`), and used EMPTY defaults — zero packages, default distro, default everything. The operator's `Packages=` setting was never seen by mkosi.
- **Fix 1 — `--include <profile_path>`.** `_backend_build_command()` now ALWAYS passes `--include <profile_path>` on the CLI. This tells mkosi to explicitly load the profile config by path, regardless of its filename or location. CLI `--include` overrides the default `mkosi.conf` discovery.
- **Root cause 2 — legacy `Packages=` syntax.** Profiles created by v0.0.x used the old indented `Packages=` syntax (`Packages=\n    linux\n    linux-firmware\n...`). mkosi v22+ (Arch ships 25.x) only understands single-line (`Packages=linux linux-firmware ...`). The old form is silently parsed as a single package name with embedded newlines, which doesn't exist in any repo — so mkosi installs NOTHING.
- **Fix 2 — auto-migration.** New `_migrate_legacy_mkosi_packages()` function detects the old indented syntax and rewrites it to single-line IN-PLACE before the build command is constructed. `build()` calls this automatically on every mkosi build. The migration is logged in both the build state JSON (`warnings` array) and the log file header (`# MIGRATED: ...`). If the file already uses modern syntax, the migration is a no-op.
- **Regression tests.** 4 new unit tests in `TestBuilderBuildPath` cover migration (old syntax rewrite, modern no-op, no-section no-op, end-to-end during build). The existing `test_build_success_path` was extended to verify `--include` is on the command line and points at the profile file.
- **Version sync.** Bumped 0.1.1 → 0.1.2 across all 9 release surfaces. Total unit tests now 243 (was 239 in v0.1.1; +4).

### v0.1.1 highlights

v0.1.1 fixes a critical output-path safety bug. An operator reported: *"this is NOT a safe output path. fix this now."* The v0.1.0 release relied on `OutputDirectory=` in the scaffolded `mkosi.conf` to route build outputs to `/var/lib/sysdeck/builder/artifacts/<name>/`. But when building an OLD v0.0.x profile (whose `mkosi.conf` had no `OutputDirectory=` setting), mkosi defaulted to writing `image.raw` into the cwd — which was `/etc/mkosi/mkosi.conf.d/`, a system config directory owned by root. mkosi then refused to overwrite the existing `image.raw`, blocking every rebuild.

- **Root cause.** `_backend_build_command()` for mkosi was just `["mkosi", "build"]` with no CLI output flags. It trusted the profile's `mkosi.conf` to set `OutputDirectory=`, which doesn't exist on v0.0.x profiles, can be hand-edited to anything, and is ignored by mkosi if the profile is a drop-in fragment mkosi never reads.
- **Fix.** `_backend_build_command()` now ALWAYS passes `--output`, `--output-dir`, and `--force` on the CLI for mkosi builds. CLI flags override `mkosi.conf`, so the output path is forced to `/var/lib/sysdeck/builder/artifacts/<name>/<name>.raw` regardless of what the profile says. `--force` overwrites any existing image so rebuilds don't fail with "Output path exists already."
- **Safety check.** `build()` now refuses to proceed if the resolved `output_dir` is not under `/var/lib/`, `/tmp/`, `/var/tmp/`, or the configured `BUILDER_ARTIFACTS_DIR`. Blocks `/etc/`, `/usr/`, `/boot/`, `/bin/`, `/sbin/`, `/lib/`, `/root/`, `/home/`, etc. Belt-and-suspenders: even if an operator passes `options.output_dir=/etc/something` via the JS bridge, the build is refused before `subprocess.run` is called.
- **Legacy profile warning.** `build()` now detects profiles in `/etc/mkosi/mkosi.conf.d/` (the v0.0.x drop-in layout) and records a warning in both the build state JSON and the log file: *"WARNING: profile is in /etc/mkosi/mkosi.conf.d/ (legacy v0.0.x layout). mkosi may silently ignore this drop-in fragment. Migrate to /etc/mkosi/profiles/<name>/mkosi.conf for a real profile."*
- **Log improvement.** Build log header now includes the resolved `output_dir` so the operator can see exactly where the image will land before mkosi starts.
- **Regression tests.** 2 new unit tests in `TestBuilderBuildPath` cover the safety check (refuses `/etc/`) and the legacy-profile warning. The existing `test_build_success_path` was extended to verify the mkosi command line includes `--output`, `--output-dir`, and `--force`, and that `--output-dir` points at the per-profile artifacts dir.
- **Version sync.** Bumped 0.1.0 → 0.1.1 across all 9 release surfaces. Total unit tests now 239 (was 237 in v0.1.0; +2).

### v0.1.0 highlights

v0.1.0 fixes three compounding bugs in the mkosi build path that were silently producing empty 33M images with no kernel, no systemd, no openssh — the operator clicked Build on a freshly-created profile and got back a 33M `image.raw` containing only `iana-etc` + `filesystem`. Plus a new operator feature requested in the same release cycle: *"import current os pkg list to profile should be an option"*.

- **Bug 1 — scaffold location.** `profile-create` wrote `/etc/mkosi/mkosi.conf.d/<name>.conf` — a drop-in fragment that mkosi only honors when a parent `/etc/mkosi/mkosi.conf` exists to layer it onto. With no parent, mkosi ran with empty defaults. Fix: each profile now lives in its own directory `/etc/mkosi/profiles/<name>/mkosi.conf` (the only filename mkosi reads automatically from the cwd). `MKOSI_DIRS` updated to scan `/etc/mkosi/profiles` first.
- **Bug 2 — `Packages=` syntax.** `_MKOSI_TEMPLATE` and `_write_packages_mkosi` used the indented-continuation form which was the old systemd-mkosi (<=v15) syntax. mkosi v22+ (Arch ships 25.x) expects single-line space-separated: `Packages=linux linux-firmware systemd openssh`. Fix: template + writer now emit the modern single-line form. The reader accepts both forms so v0.0.x profiles migrate cleanly on first append/replace.
- **Bug 3 — output routing.** mkosi wrote its output to the cwd (`/etc/mkosi/mkosi.conf.d/image.raw`) but `build()` only scanned `/var/lib/sysdeck/builder/artifacts/<profile>/` for artifacts — so every successful build looked like a failure in the panel. Fix: `_MKOSI_TEMPLATE` now sets `OutputDirectory=` to the per-profile artifacts dir so mkosi writes directly there.
- **New feature — `profile-import-packages`.** Queries the host's explicitly-installed package set (`pacman -Qqe` on Arch, `apt-mark showmanual` on Debian, `dnf repoquery --userinstalled` on Fedora) and writes it into a profile's package list via the existing `_write_packages` dispatch. Defaults to **append** mode so the profile's baseline (kernel, systemd, openssh) is preserved. Supports `--mode=replace`, `--dry-run` for preview, and `--packages=<json>` for manual override (useful for importing a list captured on another host). New polkit exec paths for `pacman`/`apt-mark`/`dnf` added to `org.sysdeck.builder.modify`.
- **Panel UX.** Each profile row in the Builder panel now has a "⇩ Import host pkgs" button. Click → dry-run preview → `window.confirm` with package count, source distro, and first 200 packages → append write. Falls back to operator cancel without writing.
- **Regression tests.** 8 new unit tests in `TestBuilderImportHostPackages` cover `_detect_host_packages` dispatch (pacman path + dedup), the `--packages` override end-to-end, `--dry-run` no-write behavior, and the unknown-profile / no-args / bad-mode / COMMANDS-registration error paths. 4 existing tests in `TestBuilderPackagesField` updated for the new single-line `Packages=` syntax; 1 new test (`test_mkosi_modern_single_line_input_parsed`) guards against a regression where the writer emits the new form but the reader only understands the old one.
- **Version sync.** Bumped 0.0.50 → 0.1.0 across all 9 release surfaces. Total unit tests now 237 (was 228 in v0.0.50; +8 `TestBuilderImportHostPackages` + 1 new `test_mkosi_modern_single_line_input_parsed`).

### v0.0.50 highlights

v0.0.50 fixes a `NameError: name 're' is not defined` that blocked every `build()` invocation since v0.0.31. An operator reported: *"happens right away on build for a new profile i created."* The traceback pointed at `_new_build_id()` line 492: `safe_profile = re.sub(r"[^A-Za-z0-9_-]", "_", profile)`.

- **Root cause.** `bridge/builder.py`'s module-level imports were `import json / os / shutil / subprocess / sys` + `from pathlib import Path` + `from typing import Any`. No `import re`. `_new_build_id` has used `re.sub` since v0.0.31 (when the full-featured build operations were added), but no test ever exercised the `build()` code path — the unit tests only covered `profile_create` / `profile_copy` / `profile_delete` and the v0.0.49 package-writing helpers. The bug went undetected for 18 releases (v0.0.31 through v0.0.49) until an operator actually clicked Build on a freshly-created profile.
- **Fix.** Added `import re` to the module-level imports in `bridge/builder.py`. Removed the now-redundant local `import re` inside `_write_packages_vmdb2` (it was a v0.0.49 workaround that's no longer needed — the module-level import covers both callers).
- **Regression tests.** 9 new unit tests in `TestBuilderBuildPath` cover `_new_build_id` (format, sanitization of unsafe chars like dots, preservation of safe chars like hyphens/underscores, and an explicit assertion that `re` is in the builder module's globals so the bug can't recur if anyone refactors the imports). The class also includes `build()` end-to-end tests with mocked `subprocess.run` — success path (verifies state file + log file written, response shape correct, subprocess actually called), unknown profile, no args, backend-not-installed, and non-zero returncode records state "failed". All tests mock the module-level `BUILDER_STATE_DIR` / `BUILDER_LOGS_DIR` / `BUILDER_ARTIFACTS_DIR` so they run hermetically.
- **AST audit.** Ran an AST-based audit of `bridge/builder.py` to find any other names used at module level but not imported. No real undefined names found — every flagged item was a comprehension local, tuple-unpacking target, except-clause target, or `__file__`. The build path is now fully exercisable by tests.
- **Version sync.** Bumped 0.0.49 → 0.0.50 across all 9 release surfaces.

### v0.0.49 highlights

v0.0.49 closes the loop on the Image Builder profile-creation flow. Per user directive: *"we should allow adding a pacman -Sy applist.txt with a literal list of baseline apps for the profile being generated."* Previously the operator scaffolded/copied a profile, then had to drop to a shell to edit the package list. Now both the Create Profile and Copy shipped profile forms include an inline package-list field — paste the list or upload `applist.txt`, pick a merge mode, and the bridge writes the packages to the right place for whichever backend was selected.

- **All 4 backends supported.** Each writes to its native package-list location: mkosi → `[Packages]` section of `<name>.conf`, vmdb2 → `bootstrap.include` list in `<name>.yaml`, archiso → `packages.x86_64` in the profile dir, live-build → `config/package-lists/sysdeck.list`. The per-backend writers are intentionally distinct (no generic "update INI/YAML" abstraction) because each format has its own quirks.
- **Textarea + file upload.** The textarea is the source of truth — one package per line, `#` comments allowed. The file upload (`applist.txt` / `.list` / `.conf` accepted) populates the textarea via the browser's `FileReader` API so the operator can review/edit the uploaded content before submitting. 1 MB cap on uploaded files.
- **Operator-chooses merge mode.** A dropdown toggle on each form: **append** (default for Copy — preserves the baseline's existing packages like `linux`/`base`, adds the operator's, deduplicates) or **replace** (default for Create — overwrites the baseline's package file with the operator's list). The operator chooses per-operation.
- **New bridge helpers.** `_extract_opts(args)` splits argv into positional + `--key=value` opts so `profile-create`/`profile-copy` can accept the new flags without breaking their existing positional signatures. `_parse_packages_text(text)` parses multiline text into a deduped list (strips full-line + inline comments, blank lines, whitespace; preserves first-occurrence order). `_write_packages_mkosi/vmdb2/archiso/live_build` are per-backend writers. `_write_packages(profile_path, backend, packages_text, mode)` is the dispatcher.
- **Extended `profile_create` + `profile_copy`.** Both accept `--packages=<json>` (JSON-encoded so newlines/quotes survive the argv boundary) and `--mode=append|replace`. Both return a new `packages` field in their success response: `{count, mode, path}`. If package-writing fails, the profile is still created/copied and a `packages_error` field is included (non-fatal).
- **Updated `shared/bridge.js`.** `profileCreate(name, backend, base, packagesText, mode)` and `profileCopy(srcName, newName, backend, packagesText, mode)`. `packagesText` is JSON-encoded via `JSON.stringify()`. When omitted/null, the bridge writes no package file (back-compat with v0.0.48 callers).
- **28 new unit tests** in `TestBuilderPackagesField` cover `_parse_packages_text` (6 tests), `_extract_opts` (4 tests), each per-backend writer (10 tests across 4 backends × 2 modes + edge cases), the dispatcher (3 tests), and end-to-end `profile_create`/`profile_copy` with `--packages` (5 tests). All use tempdirs; none touch real `/etc/` paths.
- **Version sync.** Bumped 0.0.48 → 0.0.49 across all 9 release surfaces.

### v0.0.48 highlights

v0.0.48 fixes a builder-panel bug that surfaced on hosts with only `archiso` or only `live-build` installed (i.e. no `mkosi`/`vmdb2`). The v0.0.31 Create Profile dropdown fell back to `primary.id` when no scaffoldable backend was installed — on an archiso-only Arch host or a live-build-only Debian host, the operator could pick "archiso" or "live-build" from the dropdown, click Create, and get hit with `Error: profile-create supports ('mkosi', 'vmdb2'); archiso profiles are not scaffolded (use the shipped ones)`. That error is by design — archiso and live-build use shipped directory-based profile trees, not single-file specs that can be scaffolded from scratch — but the panel gave the operator no way to act on the "use the shipped ones" hint.

- **Fix 1: Create Profile dropdown gating.** `renderCreateProfile` in `plugins/sysdeck-builder/builder.js` no longer falls back to `primary.id` when no `mkosi`/`vmdb2` backend is installed. The dropdown only offers actually-scaffoldable backends. When none is installed, the form renders an inline install hint with the exact `pacman`/`apt` command instead of a dropdown that would have errored.
- **Fix 2: new "Copy shipped profile" form.** A new `renderCopyProfile` form lists every shipped `archiso` and `live-build` profile discovered via `profiles()` (typically `baseline` and `releng` for archiso) and offers a one-click copy into `/etc/`. Source profiles are grouped by backend in an `<optgroup>`; the new-name input is free-text. This is the supported way to create profiles for the directory-based backends.
- **New bridge command: `profile-copy`.** `bridge/builder.py` gains a `profile_copy()` function (registered in the `COMMANDS` dict as `profile-copy`). It copies `/usr/share/archiso/configs/<src>/` → `/etc/archiso/configs/<new>/` (and the live-build equivalent). Validates the new-name (rejects slashes and `.`/`..` to prevent path traversal), resolves the source via `profiles()`, refuses non-directory-based backends with a clear "use profile-create" hint, refuses if the destination already exists, and returns structured `{copied, backend, source, source_path, name, path}` on success. Uses the same polkit action as `profile-create` (`org.sysdeck.builder.modify`) — no new polkit file needed.
- **New bridge.js method.** `bridge.builder.profileCopy(srcName, newName, backend)` runs with `{ superuser: 'try' }`, same as `profileCreate` / `profileDelete`.
- **Destination-roots refactor.** `ARCHISO_COPY_DEST` and `LIVE_BUILD_COPY_DEST` are now module-level constants in `bridge/builder.py` (was: hardcoded `Path("/etc/...")` literals inside `profile_copy`). This mirrors the existing `ARCHISO_DIRS` / `LIVE_BUILD_DIRS` pattern and lets unit tests patch them with tempdirs instead of touching real `/etc/` paths.
- **15 new unit tests.** A new `TestBuilderProfileCopy` class in `tests/test_bridge_parsers.py` covers argument validation (no args, one arg, slash in name, `.`/`..` name), source resolution (not-found, wrong-backend hint filter, mkosi/vmdb2 rejection with "use profile-create" hint), success paths (archiso copy, live-build copy, backend-hint-inferred-when-omitted), and failure modes (dest-already-exists with "use profile-delete" hint, source-path-not-a-directory, permission-error returns polkit hint). All tests use `tempfile.mkdtemp()` and `unittest.mock.patch.object()`; none touch real `/etc/` or `/usr/share/` paths.
- **Version sync.** Bumped 0.0.47 → 0.0.48 across all 9 release surfaces (Makefile `VERSION` + header comment, `bridge/__init__.py` `__version__`, `packaging/setup.py` `VERSION`, PKGBUILD `pkgver`, RPM spec `Version` + `%changelog` entry, `debian/changelog` entry, `compat/compat-manifest.json` `version` + `_comment`, `packaging/sysdeck.metainfo.xml` `<release>`, `README.md` Version line). All 9 surfaces now report v0.0.48.

### v0.0.47 highlights

v0.0.47 fixes four logic flaws in the v0.0.46 release. Per user directive: *"we need to fix a few logic flaws i do things a certain way on my servers so ill correct the ports on a firewall script or two. the web server template, and vps template i setup the webserver on 8080 and varnish on 80 for an automatic cache environment. we should move the service/ports editor to its own module entry for ease of access. the glances we should default to enabling the built in webui and embedding that into our module instead it visually looks stunning in comparison to ours."*

- **Firewall: public-webserver.sh port-topology fix.** The v0.0.44 template had the cache topology backwards — it exposed Caddy on `:80` and Varnish on `:8080`. v0.0.47 flips it to match the operator's documented cache-environment setup: **Varnish is the public cache front on `:80`**, **Caddy HTTP backend lives on `:8080` (loopback only)** — Varnish's cache-miss target — and **Caddy HTTPS terminates TLS on `:443` (public)**. The `VARNISH_PUBLIC` toggle is removed entirely: `:8080` is now ALWAYS loopback-only because the previous default (`VARNISH_PUBLIC=true`) exposed the cache-miss backend path to the internet, letting clients bypass Varnish and hit Caddy directly. Defense-in-depth drops were added for `:8080` alongside the existing MariaDB + Caddy admin drops, so even a misconfigured `0.0.0.0:8080` Caddy bind gets dropped at the firewall. The detect output now reflects the corrected cache-front-of-origin topology.
- **Firewall: vps-webserver.sh default topology.** When Varnish is detected at all (installed but stopped, or running on the upstream default `:6081`), the template now forces **`VARNISH_PORT=80`** with a log message explaining the override, and flips Caddy HTTP to `:8080` loopback. Previously this only happened if Varnish was already listening on `:80` at runtime — meaning the cache-environment topology depended on the operator having manually moved Varnish to `:80` first. v0.0.47 makes the cache-front-of-origin topology the explicit default the moment Varnish is detected, matching the public-webserver.sh behavior.
- **NEW PLUGIN: sysdeck-services (order 45).** The Service/Port Editor card that lived at the bottom of the Firewall panel since v0.0.44 has been lifted out into its own first-class sidebar entry — **Service / Ports** at order 45 — for ease of access. The new panel adds a filter box (search by name/id/port/process), a show-only-editable toggle, and a Refresh button. The bridge surface (`bridge.firewall.services` / `service-info` / `set-service-port` / `restart-service`) is unchanged; a new `bridge.services` proxy (4 methods: `list` / `info` / `setPort` / `restart`) was added to `shared/bridge.js` so the new panel has a clean API surface. No new bridge helper file was needed — the `SERVICES_REGISTRY`, atomic-write logic, and `CONFIG_BASE_DIRS` allowlist remain in `bridge/firewall.py` as the single source of truth. The firewall panel keeps a signpost card pointing operators to the new sidebar entry; the `service` / `port` / `editor` keywords were removed from the firewall manifest (they belong to the new services plugin now).
- **Glances: default-on embedded webui.** The Glances panel now auto-starts the built-in Glances webserver (`glances -w --bind 127.0.0.1 --port 61208`) on mount — no click required. The iframe is now the primary view, sized to fill the viewport (`min-height: calc(100vh - 200px)`). The legacy SysDeck snapshot cards (CPU/Memory/Swap/Network/Disk/Processes) are moved into a collapsed `<details>` at the bottom of the page so they don't push the iframe below the fold. The Stop button is retained for explicit shutdown; we don't stop on unmount because keeping the webserver running speeds re-entry. The manifest CSP was updated to `frame-src 'self' http://127.0.0.1:61208 http://localhost:61208` so the embedded Glances web UI loads without a CSP violation.
- **Version sync catch-up.** The v0.0.46 release bumped PKGBUILD / spec / debian changelog to 0.0.46 but missed `bridge/__init__.py` and `packaging/setup.py` (both stayed at 0.0.45). v0.0.47 catches these up to 0.0.47 alongside every other release surface (Makefile VERSION + comment, metainfo, compat-manifest, README). All 9 release surfaces now report v0.0.47.

### v0.0.46 highlights

v0.0.46 is a trademark-scrub release. Per user directive: *"you cannot say smoothwall and ipfire where merged into our fw script either. you can say logic derived from or influenced by these projects. its really hard holding your hand on legal issues."* The v0.0.36 and v0.0.37 release notes, changelogs, code comments, and worklog entries previously claimed we shipped templates called `smoothwall.sh` and `ipfire.sh` and "merged" them into `sysdeck-fw`. That language implied we incorporated code from those trademarked projects. v0.0.45 rewords every such claim to the legally-safe phrasing: the `sysdeck-fw` backend's logic is **derived from** / **takes influence from** Smoothwall Express and IPFire under our own identifier. We never shipped templates called `smoothwall` or `ipfire`.

- **Trademark scrub.** Every file in the repository was audited for problematic phrasings near "smoothwall" or "ipfire". The script `/home/z/my-project/scripts/scrub_v045_trademark.py` performed systematic find/replace across 10 files: `bridge/firewall.py` (EXCLUDED_BACKENDS reasons + docstring), `firewall/templates/sysdeck-fw.sh` (header comment), `firewall/templates/cilium.sh` (stale backend reference), `tests/test_bridge_parsers.py` (test class docstrings + comments), `plugins/sysdeck-firewall/firewall.js` (header comment), `plugins/sysdeck-firewall/manifest.json` (keywords list — removed `smoothwall` + `ipfire`, added `sysdeck-fw`), `README.md` (v0.0.36 + v0.0.37 highlights), `packaging/debian/changelog` (v0.0.36 + v0.0.37 entries), `packaging/sysdeck.spec` (v0.0.36 + v0.0.37 changelog entries), `worklog.md` (Task 36 + Task 37 entries).
- **Legally-safe phrasings used.** Every reference to Smoothwall Express or IPFire now uses one of: "takes influence from", "logic derived from", "influenced by these projects". The `EXCLUDED_BACKENDS` reasons for `smoothwall` and `ipfire` now read: "other projects' trademarks — we took influence from them for sysdeck-fw instead of shipping templates by those names."
- **No functional changes.** This is a wording-only release. No code paths changed, no templates changed, no bridge subcommands changed. All 141 unit tests still pass. The `sysdeck-fw` backend, the 7 firewall templates, and the v0.0.44 service/port editor are unchanged.
- **Direct-quote preservation.** User-directive quotes that mention "smoothwall" or "ipfire" (e.g. the v0.0.36 directive: *"or they can select celium, or smoothwall or ipfire or other firewall scripts"*) are preserved verbatim as the user's own words. Our commentary around them uses the legally-safe phrasings.

### v0.0.44 highlights

v0.0.44 adds three public-server firewall variants and a full service/port editor to the firewall module. Per user directive: *"another thing the firewall module needs is a few public server variants. like: remote admin enabled ssh and cockpit, server enabled like caddy and varnish 80 and 8080 w mariadb, an ai llm variant for ollama, hermes, openwebui and oddyseus. and lastly a full service/port editor that detects based on running ports and services detected on them. make it as simple as editing the port to change it in a config on the system. auto restart the associated service if it is changed."*

- **Three new public-server firewall templates.** All three implement the standard start/stop/restart/detect/status/check interface and use modern nftables inet family with named sets, rate limiting with dynamic auto-ban, bogon filtering, invalid TCP flag drops, and per-port log prefixes. They appear in the existing Templates card when the `custom` backend is active — no new UI surface needed for selection.
  - `remote-admin.sh` — SSH (22) + Cockpit (9090). Aggressive rate limiting with auto-ban (4/min SSH, 10/min Cockpit). For VPS / cloud hosts where the operator needs remote shell + web admin from anywhere.
  - `public-webserver.sh` — Caddy (80/443) + Varnish (8080, public by default per the "80 and 8080" directive) + SSH (22). MariaDB (3306) and Caddy admin API (2019) are bound loopback-only with DEFENSE-IN-DEPTH DROP rules — even if the daemon is misconfigured to bind 0.0.0.0, the firewall drops the packet before it reaches the daemon.
  - `ai-llm.sh` — Ollama (11434) + OpenWebUI (3000) + Hermes (8000) + Odysseus (8001) + SSH (22). For self-hosted AI LLM stacks. All four AI service ports are public per the user directive; the detect output documents the v0.0.43 "never 0.0.0.0" directive and explains why Ollama's default 0.0.0.0 bind is acceptable here (the firewall gates access, not the bind address).
- **Service/Port Editor.** Four new bridge/firewall.py subcommands (`services`, `service-info`, `set-service-port`, `restart-service`) plus a new "Service / Port Editor" card in the firewall panel. The editor runs `ss -tlnp` (or `/proc/net/tcp` fallback) to enumerate ALL listening TCP ports on the host, cross-references against a static SERVICES_REGISTRY of 9 services (ssh, cockpit, caddy, varnish, mariadb, ollama, openwebui, hermes, odysseus), and renders one row per service with: editable port input, Save & Restart button, Restart-only button, current port from config, default port, listening ports, processes, PIDs, config file path. Unmapped listeners (ports with no matching registry entry) are shown in an expandable block so the operator can spot services the editor doesn't yet know about. Editing a port writes the new value to the config file atomically (tmpfile + fsync + rename) and runs `systemctl restart` on the service. Adding a new service to the editor is as simple as adding an entry to `SERVICES_REGISTRY` in `bridge/firewall.py` with its config file paths and port-extraction regex — no other code changes.
- **Hardening.** service_id validated against SERVICES_REGISTRY (CVE-2024-2947 — attacker cannot trick the bridge into editing /etc/shadow). Port validated with strict integer regex 1..65535, `re.fullmatch` to reject trailing newlines (CVE-2019-15107 — the v0.0.43 validators used `re.match` which let "22\n" slip past; v0.0.44 fixes this). Config path resolved with `os.path.realpath` + base-dir allowlist (`/etc/` or `/usr/share/sysdeck/` — CVE-2022-30708 symlink-escape defense). Port substitution uses a strict per-service regex (NOT freeform sed) so only the port digits are replaced — comments and other content on the line are preserved. systemctl invoked with `shell=False`, list argv, env scrubbed (CVE-2024-6126). systemctl binary validated against an allowlist (`/usr/bin/systemctl`, `/bin/systemctl`, `/usr/sbin/systemctl`). Atomic write via tmpfile + fsync + rename defeats partial-write corruption. The `org.sysdeck.firewall.modify` polkit action (shipped since v0.0.17) already authorizes `/usr/bin/systemctl` — no polkit changes required.
- **Regression tests.** 32 new tests in two new test classes (`TestFirewallV044ServicesEditor` + `TestFirewallV044PublicServerTemplates`). Tests cover: SERVICES_REGISTRY structure, `_validate_service_id` and `_validate_port` accept/reject (including shell-metachar and path-traversal attacks), `cmd_services` JSON shape, `cmd_service_info` / `cmd_set_service_port` / `cmd_restart_service` validation, end-to-end atomic-write test on a temp config file, no-config-file and regex-no-match error paths, three new template files exist + executable + metadata header + standard dispatch interface + no-sudo. Total tests: 109 (v0.0.43) → 141 (v0.0.44).

### v0.0.43 highlights

v0.0.43 fixes a hardening lapse from v0.0.40: the Prometheus port fix introduced 4 references to `0.0.0.0:9095` as a listener address — a wildcard bind that would expose Prometheus to every network interface. All 4 are replaced with `127.0.0.1:9095` (loopback only). A new regression test (`TestNoWildcardListeners`) scans every bridge helper and panel JS for the `0.0.0.0:<port>` pattern and fails the build if any are found — enforcing the "never bind 0.0.0.0" rule permanently.

- **No 0.0.0.0 listeners.** Per user directive: *"we need to make sure we never ever set a web listen address to 0.0.0.0, if anything use 127.0.0.1. we already discussed hardening that should have been fresh."* The v0.0.40 Prometheus port fix introduced `webListenAddress: "0.0.0.0:9095"` in the bridge config display and `web.listen_address: "0.0.0.0:9095"` in the install hint — a wildcard bind exposing Prometheus to the LAN/internet. v0.0.43 replaces all 4 references with `127.0.0.1:9095`.
- **Regression test.** `TestNoWildcardListeners` scans every `bridge/*.py` and `plugins/*/*.js` for the `0.0.0.0:<port>` listener pattern and fails the build if any are found. The only allowed uses of `0.0.0.0` are CIDR bogon blocks in firewall templates (e.g. `0.0.0.0/8`) and comments documenting upstream defaults. Total tests: 98 → 100.
- **Audit confirmed.** Every other web listener in the suite already uses `127.0.0.1`: Glances (`--bind 127.0.0.1`), Jellyfin (panel uses `127.0.0.1` even though Jellyfin itself defaults to `0.0.0.0`), Photos/RemoteFS/Mining (no web listeners — they manage systemd services).

### v0.0.40 highlights

v0.0.40 fixes a port conflict bug: Prometheus and Cockpit-ws both default to port 9090. Since Cockpit is already on 9090 on every SysDeck host, the v0.0.39 bridge was hitting Cockpit-ws instead of Prometheus. Prometheus is moved to port 9095.

- **Port conflict fix — Prometheus 9090 → 9095.** Per user directive: *"prometheus and cockpit both use the same port. so we can assume prometheus was moved not cockpit."* Cockpit-ws defaults to port 9090. Prometheus also defaults to 9090. The v0.0.39 bridge hardcoded `http://localhost:9090` as the Prometheus API URL — on any host where Cockpit is running, the bridge would hit Cockpit-ws instead of Prometheus and get HTML pages instead of JSON API responses. v0.0.40 moves the Prometheus default to port 9095 (familiar 909x range, no conflict with Pushgateway 9091, Alertmanager 9093, or Cockpit 9090). 10 references updated across 6 files: `bridge/prometheus.py` (PROM_API_URL default + webListenAddress), `plugins/sysdeck-monitoring/monitoring.js` (iframe src, open-in-new-tab link, status table URL, install hint port, comment), `manifest.json` (CSP `frame-src`), `prometheus/sysdeck_scrape.yml` (self-scrape target), `prometheus/sysdeck_grafana_datasources.yml` (datasource URL). The install hint now explicitly tells operators to move Prometheus off 9090 via `web.listen_address` or `ARGS`.
- **Operator override.** Operators who already run Prometheus on a custom port can override via the `PROMETHEUS_API_URL` environment variable (e.g. `PROMETHEUS_API_URL=http://localhost:9096`).

### v0.0.39 highlights

v0.0.39 adds a shared tabbed Monitoring module (Prometheus + Grafana) and hardens both bridge helpers to v0.0.37 security standards:

- **Monitoring module — Prometheus + Grafana.** Per user directive: *"we have 2 modules left, we can actually have them share a module with tabs similar to the container/vm module. we should add prometheus, and graphana webui modules."* New plugin `plugins/sysdeck-monitoring/` with two tabs: (1) Prometheus — status card (version, uptime, targets, alerts firing) + iframe of the real Prometheus web UI at `http://127.0.0.1:9090`; (2) Grafana — status card (version, dashboards, datasources) + iframe of the real Grafana web UI at `http://127.0.0.1:3000`. Each tab has Refresh / Reload Config / Restart buttons. When a service is not installed, the tab shows a distro-specific install hint (Arch / Debian / Fedora). Plugin count 23 → 24.
- **Bridge hardening.** The existing `bridge/prometheus.py` (448 lines) and `bridge/grafana.py` (413 lines) were written before v0.0.36/v0.0.37 hardening. v0.0.39 brings them up to standard: `NoRedirectHandler` on all HTTP calls (SSRF defense, CVE-2020-35850), 127.0.0.1-only URL check, env scrubbed on every subprocess (CVE-2024-6126), output sanitized (CVE-2022-36446), no `sudo` (replaced with direct `systemctl` + cockpit superuser channel + polkit), `check=False` with structured error return, reuses `firewall.py` security helpers via import.
- **New bridge.js surfaces.** `bridge.prometheus` (8 methods) + `bridge.grafana` (11 methods). Read-only queries do NOT pass `superuser: 'try'`; restart/reload DO.
- **Polkit action.** New `org.sysdeck.monitoring.modify` authorizes `systemctl` for Prometheus + Grafana service management.
- **Config files shipped.** The `prometheus/` directory (existed since v0.0.31 but was never installed) is now shipped read-only at `/usr/share/sysdeck/prometheus/`: scrape configs, alert rules, Grafana datasource + dashboard provisioning YAMLs.
- **Regression tests.** 12 new tests for the prometheus + grafana bridge helpers. Total: 90 (v0.0.38) → 102.

### v0.0.38 highlights

v0.0.38 makes the Kata panel production-ready by replacing the mock React bundle with a real Python bridge, and adds a polkit action for future mutating kata verbs:

- **Kata panel production rewrite.** The v0.0.35-v0.0.37 Kata panel shipped a 470KB pre-built React bundle from the upstream cockpit-kata sub-project. That bundle displayed **hardcoded mock data**: 5 fake sandboxes (`web-frontend-prod`, `api-gateway-staging`, etc.) with synthetic UUIDs and `createdAt:"2026-07-15..."` timestamps, fake per-sandbox metrics (cpuUsagePercent, memoryUsageMB, historyCpu/historyMemory arrays), a fake QCrows bundle catalog, and a fake PXE status (always `dnsmasqRunning:true`). The only real features were the QCrows kernel-bundle extraction and `kata-runtime check`. v0.0.38 deletes the React bundle and ships a vanilla-JS panel (`plugins/sysdeck-kata/kata.js`) backed by a new `bridge/kata.py` that calls the **real Kata Containers 3.x APIs**: `kata-monitor` HTTP `/sandboxes` + `/agent-url` + `/metrics?sandbox=<id>` for sandbox enumeration and metrics, filesystem probes of `/run/vc/sbs/<id>/` (Go shim) and `/run/kata/<id>/` (Rust shim) for sandbox state, `kata-runtime version` + `kata-runtime env --json` for version info, `kata-runtime check` (exit code) for host capability, `systemctl is-active dnsmasq` + real `/srv/tftp/` probes for PXE status, and real filesystem enumeration of `/usr/share/sysdeck/kata/qcrows/` for the QCrows bundle catalog. When no sandboxes are running, the panel shows the **real empty state** — not mock data. The bridge applies all v0.0.36 + v0.0.37 security hardening (strict sandbox-ID validation with `^[0-9a-f]{64}$`, env scrubbing, output sanitization, no-redirect HTTP to kata-monitor for SSRF defense).
- **Kata 3.x API correctness.** Researched the real `kata-runtime` CLI surface for Kata Containers 3.x. Key finding: `kata-runtime list` and `kata-runtime inspect` were **removed in 3.x** — the bridge does NOT call them. Sandbox enumeration uses `kata-monitor`'s `/sandboxes` endpoint (plain text, one 64-hex-char ID per line — NOT JSON) plus filesystem enumeration. `kata-runtime env --json` returns structured JSON with **Capitalized Go field names** (no `json:` struct tags) — `Runtime`, `Hypervisor`, `Host`, `Version`, `Semver` — the parser handles this correctly. `kata-monitor /metrics` returns **Prometheus text format** (not JSON), parsed via `prometheus_client.parser.text_string_to_metric_families` when available.
- **New bridge helper.** `bridge/kata.py` with 8 subcommands: `list`, `inspect`, `metrics`, `summary`, `version`, `check`, `pxe-status`, `qcrows-list`. Reuses the v0.0.37 firewall.py security helpers (SCRUBBED_ENV, _sanitize_output, _validate_filename, _resolve_path_under_base) via import — single source of truth for hardening.
- **New bridge.js surface.** `bridge.kata` with 8 methods mirroring the subcommands. All read-only (no `superuser: 'try'`).
- **Polkit action.** New `org.sysdeck.kata.modify` action authorizing `kata-runtime`, `kata-monitor`, `ctr`, `crictl`, `qcrows-export`, `qcrows-initrd-regen`, and `systemctl`. Ships now so future mutating verbs (sandbox create/stop/remove, qcrows-export) are authorized when they land.
- **Manifest relaxed.** `plugins/sysdeck-kata/manifest.json` `requires.cockpit` lowered from `286` to `239` (matching every other plugin — the React bundle's cockpit-286 requirement no longer applies). CSP simplified to the standard `'unsafe-inline' 'unsafe-eval'` (the React bundle's `connect-src http://127.0.0.1:8090` exception is gone — the bridge does the HTTP server-side). Keywords extended with `kata-monitor`, `qcrows`, `pxe`, `tftp`, `cloud-hypervisor`, `firecracker`, `qemu`.
- **Regression tests.** 13 new tests in `TestKataBridgeProduction` class verifying: `cmd_list` returns `[]` (not mock 5 sandboxes), `cmd_qcrows_list` returns `[]` (not mock catalog), `cmd_summary` returns real state (`kata_runtime_installed: false`), `cmd_pxe_status` returns real state (`dnsmasq_running: false`), sandbox-ID validation rejects malicious input (CVE-2024-2947), and a source-code scan verifying `kata.py` contains NONE of the mock markers (`web-frontend-prod`, `kata-sbx-a1b2c3`, etc.). Total tests: 78 (v0.0.37) → 91 (v0.0.38).

### v0.0.37 highlights

v0.0.37 introduces the unified "SysDeck FW" backend (which takes influence from Smoothwall Express and IPFire for its zone model + source-verified outbound + AirWall isolation) and expands the CVE-derived security hardening to cover commercial web admin UI panels (cPanel, Plesk, CyberPanel, aaPanel, CloudPanel, HestiaCP, VestaCP, Froxlor, InterWorx, BrainyCP, DirectAdmin, CWP):

- **Unified SysDeck FW backend.** Per user directive: *"we cant call smoothwall or ipfire if its a rewrite, so lets unify them into a unified nftables fw template in the drop down we can call it SysDeck FW."* The `sysdeck-fw` backend takes influence from Smoothwall Express (RED/ORANGE/GREEN/BLUE color-zone model) and IPFire (source-verified outbound per-zone CIDR, AirWall isolation for BLUE/WiFi toggleable via `AIRWALL=false`, flow offload for hardware acceleration, DMZ port-forwarding) under our own identifier. We do not ship templates called "smoothwall" or "ipfire" — those are other projects' trademarks. Config file at `/etc/sysdeck/firewall/sysdeck-fw.conf`. Smoothwall and IPFire appear in `EXCLUDED_BACKENDS` with the reason documented.
- **Expanded CVE research.** Per user directive: *"when i say webmin i mean all web admin ui panels cpanel all of them have a history for us to learn from on the security side of things."* v0.0.36 covered Webmin, Cockpit, Ajenti, ISPConfig, Virtualmin. v0.0.37 extends the research to cover cPanel/WHM, Plesk, DirectAdmin, CloudPanel, aaPanel, Froxlor, InterWorx, BrainyCP, CyberPanel, HestiaCP, VestaCP, FastPanel, and CWP. 29 additional CVEs reviewed — full table in `docs/SECURITY-HARDENING.md`. Key new CVEs: CVE-2026-41940 (cPanel session-file CRLF injection, CVSS 9.8, CISA KEV — attacker injects `\r\nuser=root\r\n` into a pre-auth session file, bypassing password + 2FA), CVE-2025-66431 (Plesk domain-creation RCE-as-root — domain names flow into root-run scripts), CVE-2024-51567 (CyberPanel pre-auth 0-click RCE as root, CVSS 10.0, exploited by PSAUX ransomware Oct 2024 — `secMiddleware` only inspects POST; attackers bypass via PUT/OPTIONS), CVE-2025-48702 (aaPanel tar argument injection — **subprocess array form does NOT prevent this**; filenames like `--checkpoint-action=exec=bash shell.sh` execute code), CVE-2026-26279 (Froxlor email-validation logic bug — validation disabled for fields declared as email type), CVE-2023-53945 (BrainyCP crontab RCE — users inject commands through the crontab interface), CVE-2023-35885 (CloudPanel auth bypass via insecure file-manager cookie), CVE-2025-100 (CWP/CentOS Web Panel critical RCE, actively exploited).
- **New validators (7).** Each grounded in a specific commercial-panel CVE: `_validate_domain` (CVE-2025-66431 Plesk — RFC 1035 strict domain regex, rejects shell metacharacters, path separators, `..`, leading/trailing hyphens, enforces 253-char max / 63-char label max), `_validate_email` (CVE-2026-26279 Froxlor — `parseaddr` + charset regex + separate shell-metachar reject; defense in depth on top of input validation), `_validate_cron_schedule` (CVE-2023-53945 BrainyCP — 5-field cron syntax only; the cron *command* is never user-supplied), `_validate_mysql_identifier` (CVE-2026-58048 cPanel — MySQL identifier + reserved-word denylist + no embedded backticks), `_sanitize_for_file` (CVE-2026-41940 cPanel — strips `\r\n\0` from any value written to a line-oriented file), `_decode_then_validate` (CVE-2026-29205 cPanel cpdavd — URL-decode + canonicalize + validate; never validate-then-decode), `safe_tar_create` (CVE-2025-48702 aaPanel + IWX-CVE-2022-8384 InterWorx — tar `--null -T -` keeps filenames OUT of argv entirely, defeating argument injection that bypasses the v0.0.36 `--` separator defense).
- **Security-hardening subcommand expanded.** `cmd_security_hardening` now returns 17 applied items (up from 9 in v0.0.36) and 48 CVEs reviewed (up from 19). The panel's Security Card renders the expanded checklist with the new commercial-panel CVE badges.
- **Backend count: 3.** `FIREWALL_BACKENDS` has 3 entries: `custom`, `cilium`, `sysdeck-fw`. `EXCLUDED_BACKENDS` has 7 entries: the original 5 (ufw, fwbuilder, iptables-legacy, iptables-nft, shorewall) plus `smoothwall` and `ipfire` (both excluded because they are other projects' trademarks; we took influence from them for sysdeck-fw).
- **Regression tests expanded.** `tests/test_bridge_parsers.py` grows from 45 tests (v0.0.36) to 70 tests (v0.0.37) — 25 new tests for the v0.0.37 validators, each mapped to a specific commercial-panel CVE.

### v0.0.36 highlights

v0.0.36 adds a firewall backend dropdown to the Firewall panel and hardens the entire firewall bridge against CVE disclosures found in Webmin, Cockpit, Ajenti, ISPConfig, and Virtualmin:

- **Firewall backend dropdown.** Per user directive: *"next we will add cilium support as a drop down option in the fw area, the user can select custom which is default with the templates that are basic. or they can select celium, or smoothwall or ipfire or other firewall scripts that install cleanly with value for ebpf era and nftables. iptables is old now."* Three backends ship: `custom` (default — the existing vps-webserver.sh + no-services.sh nftables templates), `cilium` (Cilium eBPF datapath — replaces nftables as the datapath; identity-based policy via CiliumIdentity labels; L7 policy via Envoy), and `sysdeck-fw` (unified nftables zone firewall — takes influence from Smoothwall Express and IPFire under our own identifier; we do not ship templates called "smoothwall" or "ipfire" because those are other projects' trademarks). Excluded backends — UFW, fwbuilder, iptables-legacy, iptables-nft, Shorewall, Smoothwall Express, IPFire — are documented in the panel's expandable "Excluded backends" block with the reason for each.
- **New templates.** Two new firewall templates ship under `firewall/templates/`: `cilium.sh` (Cilium eBPF policy loader — applies the default policy at `/usr/share/sysdeck/firewall/policies/cilium-default.yaml`) and `sysdeck-fw.sh` (unified nftables zone firewall — RED/ORANGE/GREEN/BLUE zone matrix, source-verified outbound, AirWall isolation for BLUE, optional flow offload, DMZ port-forwarding; takes influence from Smoothwall Express + IPFire under our own identifier). Both implement the standard start/stop/restart/detect/status/check interface.
- **Security hardening.** Per user directive: *"now theres inherintly alot of lessons to learn from all the other webmins that came before us. search the web for vuln disclosures for older webmins that we could learn to secure our code from the release info."* v0.0.36 hardens the firewall bridge against every CVE disclosure found in Webmin, Cockpit, Ajenti, ISPConfig, and Virtualmin. Full CVE table + hardening checklist in `docs/SECURITY-HARDENING.md`. Highlights: CVE-2019-15107 (strict allowlist regex on user input before argv), CVE-2024-2947 (filename validation `^[A-Za-z0-9._-]+$`), CVE-2026-4631 (`--` separator before user positionals), CVE-2024-6126 (env scrubbed on every privileged subprocess — LD_PRELOAD, LD_LIBRARY_PATH, PYTHONPATH, BASH_ENV, ENV, PERL5OPT all dropped), CVE-2022-36446 (all bridge output escaped in JS, never innerHTML), CVE-2022-30708 (path resolution with realpath + startswith base check), CVE-2019-15642 (no eval / pickle / yaml.unsafe_load), CVE-2022-0824 (per-verb polkit check, no UI-trust), CVE-2020-35606 (reject on first mismatch, no sanitization), 2019 Webmin backdoor (release-gate runs `git status --porcelain`; reproducible builds with pinned `LC_ALL=C`, `SOURCE_DATE_EPOCH`).
- **New bridge subcommands (11).** `backends`, `backend-info`, `active-backend`, `switch-backend`, `install-backend`, `cilium-status`, `cilium-endpoints`, `cilium-policy`, `cilium-policy-apply`, `cilium-policy-validate`, `security-hardening`. The bridge.js firewall surface exposes 11 new methods mirroring them.
- **Polkit policy extended.** `org.sysdeck.firewall.modify` action now authorizes `/usr/bin/cilium`, `/usr/sbin/cilium`, `/usr/bin/cilium-agent`, `/usr/sbin/cilium-agent`, `/usr/bin/helm`, `/usr/sbin/helm` (in addition to the v0.0.17 set: nft, iptables, ip6tables).
- **Regression tests.** `tests/test_bridge_parsers.py` grows from 9 tests (v0.0.35) to 45 tests (v0.0.36) — 36 new hardening / backend / Cilium / security-hardening tests, each mapped to a specific CVE.
- **Plugin count unchanged at 23.** No new sidebar entries; this is a feature release for the existing Firewall panel.

### v0.0.35 highlights

v0.0.35 restores SysDeck Kata as a standalone sidebar entry and adds three new modules per user directive — Jellyfin media server, photo manager, and remote filesystem manager:

- **Kata split.** Per user directive: *"kata containers should be called SysDeck Kata and moved out of the tools area. and dont call it hidden thats akward."* The v0.0.34 layout had Kata Containers demoted to a hidden "tools" entry inside the merged Containers & VMs panel — labeled "Kata Containers (hidden helper)" with priority -1, in `plugins/sysdeck-containers-kata/`. v0.0.35 splits Kata back out: renamed to **SysDeck Kata**, moved to `plugins/sysdeck-kata/`, converted from a `tools` manifest entry to a `menu` entry (label "SysDeck Kata", order 27), removed the "hidden helper" wording, dropped the priority -1, and restored a dedicated keywords list. The Containers panel now manages Podman only — the Kata tab and its iframe were removed. The pre-built cockpit-kata React bundle (`index.js` + `index.css`) is shipped unchanged.
- **Jellyfin media server module.** Per user directive: *"next we will integrate a jellyfin management module where it starts, stops, and loads the admin panel in the module."* New plugin `plugins/sysdeck-jellyfin/` + new bridge helper `bridge/jellyfin.py`. The bridge runs `systemctl start/stop/restart jellyfin.service` via the cockpit superuser channel (polkit `org.sysdeck.jellyfin.modify`); the panel iframes the running Jellyfin admin UI at `http://127.0.0.1:8096` — same pattern as the v0.0.34 Glances integration. Library list is best-effort via `GET /Library/VirtualFolders` on the local Jellyfin instance.
- **Photo manager module.** Per user directive: *"as well as a photo manager of equal quality. with its own module."* New plugin `plugins/sysdeck-photos/` + new bridge helper `bridge/photos.py`. Multi-backend design (same shape as the DB Control module): PhotoPrism (port 2342, MIT), Piwigo (port 80, GPL-2.0), Lychee (port 80, MIT), Nextcloud-Memories (port 80, AGPL-3.0), LibrePhotos (port 3000, MIT). Each backend is auto-detected; the bridge runs `systemctl start/stop/restart <service>` and the panel iframes its admin UI when running. Polkit action: `org.sysdeck.photos.modify`.
- **Remote FS manager module.** Per user directive: *"then a remote fs manager such as ceph, and others but not nfs or amanada fs."* New plugin `plugins/sysdeck-remotefs/` + new bridge helper `bridge/remotefs.py`. Multi-backend: Ceph (LGPL-2.1), GlusterFS (GPL-2.0), MooseFS (GPL-2.0), BeeGFS (BeeGFS EULA — free), OrangeFS (BSD-3). Each backend is auto-detected; the bridge runs `systemctl start/stop/restart <service>` and the cluster-info subcommand queries backend-specific cluster status (`ceph status --format=json`, `gluster pool list`, `moosefs-cli info`, `beegfs-ctl --listnodes`, `pvfs2-server -m`). Polkit action `org.sysdeck.remotefs.modify` authorizes the systemctl binary plus ceph / gluster / moosefs-cli / beegfs-ctl / pvfs2-server CLIs. **NFS and Amanda are explicitly EXCLUDED per directive** — documented in the panel footer and in `bridge/remotefs.py:EXCLUDED`.
- **Plugin count 20 → 23.** The v0.0.34 hidden helper (`sysdeck-containers-kata`) is renamed to `sysdeck-kata` and promoted to a visible sidebar entry; three new visible modules are added. `tests/check_manifest_consistency.py` expected count updated to 23. `scripts/generate-plugins.py` updated to back up + restore hand-maintained plugins (`sysdeck-kata` ships a pre-built React bundle that can't be regenerated by the suite generator).

### v0.0.34 highlights

v0.0.34 consolidates Containers + Kata into one module, integrates the Glances built-in web UI, and expands Themes + Mining to "1999 power-tool style" per user directive:

- **Containers + Kata consolidation.** Per user directive: "for the containers and kata containers will be merged into one module and replaced by this upload, i will merge this sub project into sysdeck directly and close the other project after this." The standalone `sysdeck-kata` plugin is removed; the Kata portion of the merged panel loads the pre-built cockpit-kata React app via iframe to a hidden helper plugin at `sysdeck-containers-kata/`. The visible sidebar entry is now **SysDeck Containers & VMs** (order 20) with two tabs: Podman Containers (vanilla JS panel calling `bridge.containers`) and Kata Sandboxes (iframe to the React app). The standalone cockpit-kata sub-project closes after this release.
- **Glances web UI integration.** Per user directive: "glances is not integrated yet i just assumed you would integrate the built in webui as a module." The bridge now ships `start-web / stop-web / web-status` subcommands that run `glances -w --bind 127.0.0.1 --port 61208` as a background process; the panel iframes the running web UI at `http://127.0.0.1:61208`. The full Glances web UI (every chart, every sensor, every top process, every history graph) is available without SysDeck re-implementing any of it. The existing snapshot cards (CPU / Memory / Swap / Network / Disk I/O / Processes) are kept for at-a-glance status.
- **Themes 1999 power-tool expansion.** Per user directive: "themes and mining they need to be expanded for maximum ui control. think 1999 power tool style here." The new `bridge/themes.py` surfaces: `read-config / write-config / get / set / unset / reset / preset-list / preset-apply / variable-list / variable-get / variable-set / variable-reset`. Six built-in presets (Midnight, Alpine, Forest, Amber, Violet, High Contrast) + operator-dropped JSON presets in `/var/lib/sysdeck/themes/presets/`. Twelve CSS variables (`--sysdeck-bg`, `--sysdeck-fg`, `--sysdeck-accent`, etc.) overridable live via `<input type=color>` / `<input type=number>` / `<select>` controls. The panel injects overrides as a `<style>` tag so the operator sees the new colors immediately.
- **Mining 1999 power-tool expansion.** The bridge now surfaces `summary / threads / pool-config-get / pool-config-set / threads-config-get / threads-config-set / algorithm-get / algorithm-set / pause / resume / pause-worker / resume-worker / start / stop / restart / service-status` — every XMRig REST API knob. The panel renders: summary stats (hashrate/pool/uptime), service controls (start/stop/restart `xmrig.service`), all-workers pause/resume, per-thread hashrate table with per-worker pause/resume buttons, pool config form, thread count form, algorithm picker with 7 RandomX variants.

### v0.0.33 highlights

v0.0.33 expands the Policy & Permissions module with the rest of the modern Linux LSM stack, applies a MoE (Mixture-of-Experts) QA pass across the codebase, and rewrites the project documentation:

- **Policy module — LSM expansion.** Per user directive: "lets now add smack, tomoyo, yama and others as well to the same policy module." Added **Smack**, **TOMOYO**, **Yama**, **LoadPin**, **Lockdown**, **BPF-LSM**, **Landlock**, plus **file capabilities (setcap/getcap)**. Each is **optional** — the bridge auto-detects via `/sys/kernel/security/<lsm>/` and the panel renders an enable hint with the kernel cmdline when the LSM is absent. **SELinux remains skipped** (native to the host distro). The `lsm-status` subcommand reads `/sys/kernel/security/lsm` and renders the active stack as a badge row in the panel header. The polkit `org.sysdeck.policy.modify` action now authorizes 30+ binaries across ACLs / cgroups / VLANs / eBPF / filecaps / AppArmor / Smack / TOMOYO.
- **MoE QA pass.** A senior QA analyst, senior Linux engineer, senior architect, senior admin, and project-manager-in-devops pass replaced nested ifs with lookup tables (`LSM_PROBES`, `NON_LSM_CONCERNS`, `SMACK_FILE_MAP`, `TOMOYO_FILES`, `YAMA_SCOPE_NAMES`), shifted `for`/`while` loops toward `map`/`filter`/`reduce` where the data shape allowed it, and kept PEP 868 (typed Python), POSIX (one function = one job, compose with pipes), SEI CERT (no `eval`, no `Function`, all spawn calls use the array form), and MISRA (limited cyclomatic complexity, single exit where practical) in mind. Step-down logic: when a fork of choices appeared, the option that composed best with the rest of the system won.
- **Documentation rewrite.** README, QUICKSTART, BLOG, and LICENSE rewritten with decisive language — no "restored / brought back / surviving artifact" wording. Every design choice is documented as a decision.
- **Polkit policy.** `org.sysdeck.policy.modify` extended to authorize `smackload`, `smackcipsos`, `tomoyo-setprofile`, `tomoyo-set-profile`, `tomoyo-savepolicy`, `tomoyo-init`, `setcap`, `getcap` (in addition to the v0.0.32 set: `setfacl`, `getfacl`, `mkdir`, `mount`, `ip`, `bpftool`, `lsns`, `aa-enforce`, `aa-complain`, `aa-status`).

### v0.0.32 highlights

v0.0.32 adds two modules — **Policy & Permissions** and **DB Control** — and brings the plugin count from 18 to 20:

- **Policy & Permissions module.** `cockpit-policy` — modern policy management and permissions manager for groups. Surfaces five concerns: POSIX ACLs (getfacl/setfacl), cgroups v2 unified hierarchy (mkdir / move PID / write control files), VLANs (ip link add/del type vlan), eBPF programs and maps (bpftool, plus pin-to-bpffs), and namespaces (lsns). AppArmor is **optional** — the bridge auto-detects whether it is compiled into the kernel; if absent, the panel renders an install hint instead of an empty table. SELinux is intentionally skipped (native to the host distro). Bridge helper: `bridge/policy.py`. Polkit action: `org.sysdeck.policy.modify`.
- **DB Control module.** `cockpit-db` — unified control for SQL/NoSQL/vector/AI database engines. The bridge helper `bridge/db.py` surfaces 32+ engines across SQL/NoSQL/Vector/TimeSeries/Graph/Embedded/Cloud/AI families with summary/status/start/stop/restart/connections/query subcommands. The plugin panel renders per-family engine tables with Start/Stop/Restart buttons, a SQL query runner, and a connections viewer. All mutating operations run via the cockpit superuser channel (polkit `org.sysdeck.db.modify`) — no `sudo` shell-out from JS.

### v0.0.31 highlights

- **Firewall module — monitor → manager.** Template selector, Apply/Stop/Restart, ban/unban IP, clear bans, live service detection. Two templates ship under `/usr/share/sysdeck/firewall/templates/` (`vps-webserver.sh`, `no-services.sh`); operators can drop more in.
- **Packages module — sudo → cockpit way.** `update-all / install / remove / update` now actually run the package manager via subprocess; the JS panel passes `{ superuser: 'try' }` so polkit prompts the operator. Live output renders in an in-panel `<pre>` — no more `alert("Run this command with superuser privileges.")`.
- **Builder module — viewer → full-featured.** `build / profile-create / profile-delete / build-status / build-log / artifacts` subcommands. Builds stream stdout+stderr to `/var/lib/sysdeck/builder/logs/<build-id>.log`; state lives in `/var/lib/sysdeck/builder/state/<build-id>.json`; artifacts under `/var/lib/sysdeck/builder/artifacts/<profile>/`.
- **Fester rename.** Build orch panel menu label and panel title changed to "SysDeck Fester" per user directive.

### Two deployment shapes

| Shape | Use case | Lives at |
|-------|----------|----------|
| **Cockpit plugin** (default) | Drop into an existing cockpit install; access via `https://<host>:9090` | `/usr/share/cockpit/sysdeck-*/` |
| **Tarball source** | Build from source, customize, or contribute | `sysdeck-<version>/` source tree |

The cockpit plugin is the primary deliverable.

## Module catalog

| # | Module | Codename | Priority | Backend |
|---|--------|----------|----------|---------|
| 1 | Containers (Podman) | `cockpit-containers` | P0 | `podman ps` |
| 2 | Firewall Control | `cockpit-firewall` | P0 | `nft list ruleset` + template apply |
| 3 | Integrity Auditor | `cockpit-integrity` | P0 | `lynis audit system` |
| 4 | Network SOC | `cockpit-netsec` | P1 | `ss -tulpn` |
| 5 | Service Mesh | `cockpit-mesh` | P1 | `kubectl get svc` |
| 6 | Encryption Vault | `cockpit-vault` | P1 | `lsblk -J` |
| 7 | Fleet Compute | `cockpit-fleet` | P1 | `uptime`, cockpit peers |
| 8 | SysDeck Kata | `cockpit-kata` | P0 | kata-runtime (pre-built React app) |
| 9 | SysDeck Fester (build orchestration) | `cockpit-fester` | P1 | `systemctl list-units` |
| 10 | Firmware Control | `cockpit-firmware` | P2 | `fwupdmgr`, `tpm2_pcrread` |
| 11 | Image Builder | `cockpit-builder` | P2 | `mkosi` (Arch) / `vmdb2` (Debian) |
| 12 | Mining Dashboard (XMRig power tool) | `cockpit-mining` | P2 | XMRig REST API + service control |
| 13 | Theme Engine (1999 power tool) | `cockpit-themes` | P2 | `/etc/cockpit/cockpit.conf` + CSS variable surface + 6 presets |
| 14 | Hardware Auth | `cockpit-auth` | P2 | `pkcs11-tool`, `pcsc_scan` |
| 15 | System Monitor (Glances web UI) | `cockpit-glances` | P1 | `glances -w` (iframe) + snapshot cards |
| 16 | Hardware Sensors | `cockpit-sensors` | P1 | `sensors` (lm_sensors) |
| 17 | System Benchmark | `cockpit-benchmark` | P2 | `sysbench` |
| 18 | Package Manager | `cockpit-packages` | P1 | `pacman` / `dnf` / `apt` |
| 19 | Policy & Permissions | `cockpit-policy` | P1 | ACLs · cgroups v2 · VLANs · eBPF · namespaces · filecaps · LSM stack (AppArmor/Smack/TOMOYO/Yama/LoadPin/Lockdown/BPF-LSM/Landlock) |
| 20 | DB Control | `cockpit-db` | P1 | DB engine CLIs (SQL/NoSQL/vector/AI) |
| 21 | Jellyfin Media Server | `cockpit-jellyfin` | P1 | `systemctl start/stop/restart jellyfin.service` + admin UI iframe (port 8096) |
| 22 | Photo Manager | `cockpit-photos` | P1 | Multi-backend: PhotoPrism / Piwigo / Lychee / Nextcloud-Memories / LibrePhotos — start/stop + admin UI iframe |
| 23 | Remote FS Manager | `cockpit-remotefs` | P1 | Ceph / GlusterFS / MooseFS / BeeGFS / OrangeFS — start/stop + cluster-info (NFS & Amanda excluded per directive) |
| 24 | Prometheus | `cockpit-prometheus` | P1 | Prometheus pushgateway |
| 25 | Grafana | `cockpit-grafana` | P1 | Grafana API |

Each module fails closed when its backend tool is absent — the panel shows an install hint instead of crashing.

## Architecture

```
sysdeck-0.0.35/
├── Makefile                    # install / uninstall / check / dist / distcheck
├── manifest.json               # not present (multi-plugin layout — see plugins/)
├── plugins/                    # 23 standalone Cockpit plugins
│   ├── sysdeck-containers/    # v0.0.35: Podman only (Kata split out)
│   ├── sysdeck-firewall/
│   ├── sysdeck-integrity/
│   ├── sysdeck-netsec/
│   ├── sysdeck-mesh/
│   ├── sysdeck-vault/
│   ├── sysdeck-fleet/
│   ├── sysdeck-kata/          # v0.0.35: restored to standalone sidebar entry — pre-built cockpit-kata React app
│   ├── sysdeck-fester/
│   ├── sysdeck-firmware/
│   ├── sysdeck-builder/
│   ├── sysdeck-mining/
│   ├── sysdeck-themes/
│   ├── sysdeck-auth/
│   ├── sysdeck-glances/
│   ├── sysdeck-sensors/
│   ├── sysdeck-benchmark/
│   ├── sysdeck-packages/
│   ├── sysdeck-policy/         # Policy & Permissions module
│   ├── sysdeck-db/             # DB Control module
│   ├── sysdeck-jellyfin/       # v0.0.35: Jellyfin media server — start/stop + admin UI iframe
│   ├── sysdeck-photos/         # v0.0.35: Photo Manager — multi-backend start/stop + admin UI iframe
│   └── sysdeck-remotefs/       # v0.0.35: Remote FS Manager — Ceph/GlusterFS/MooseFS/BeeGFS/OrangeFS
├── shared/                     # shared bridge.js + sysdeck.css + manifest.json
├── bridge/                     # Python bridge helpers (called via cockpit.spawn)
│   ├── __init__.py             # package init + distro detection
│   ├── containers.py           # podman + systemd aggregation
│   ├── firewall.py             # nft ruleset parser + template manager
│   ├── integrity.py            # lynis audit runner
│   ├── firmware.py             # fwupd + TPM PCR aggregation
│   ├── netsec.py               # ss + nft counters aggregation
│   ├── fleet.py                # local host + peer-hosts aggregation
│   ├── auth.py                 # pkcs11-tool + lsusb + pcscd state
│   ├── glances.py              # v0.0.34: snapshot + start-web/stop-web
│   ├── sensors.py              # lm_sensors normalization + alert thresholds
│   ├── benchmark.py            # sysbench result parsing + baselines
│   ├── packages.py             # pacman/dnf/apt unified package ops
│   ├── mining.py               # v0.0.34: XMRig REST API power tool
│   ├── themes.py               # v0.0.34: cockpit.conf + CSS variable surface
│   ├── policy.py               # Policy & Permissions module (LSM stack)
│   ├── db.py                   # database engine control (32+ engines)
│   ├── jellyfin.py             # v0.0.35: Jellyfin media server service control
│   ├── photos.py               # v0.0.35: photo backend service control (5 backends)
│   ├── remotefs.py             # v0.0.35: remote FS backend service control (5 backends, NFS/Amanda excluded)
│   ├── prometheus.py           # Prometheus pushgateway log pipeline
│   ├── grafana.py              # Grafana dashboard API
│   └── hwalert.py              # hardware alert aggregation
├── firewall/                   # v0.0.31 firewall templates
│   └── templates/
│       ├── vps-webserver.sh
│       └── no-services.sh
├── packaging/                  # RPM spec + PKGBUILD + debian/ + setup.py + polkit/
├── compat/                     # compat-manifest.json (per-distro dep matrix)
├── tests/                      # unit tests + build-time guards
├── scripts/                    # generate-plugins.py
├── prometheus/                 # prometheus configs + grafana dashboards
├── standalone-plugins/         # external cockpit plugin sidebar registrations
├── docs/                       # INSTALL.md
├── README.md
├── QUICKSTART.md
├── BLOG.md                     # release narrative
├── QA.md                       # QA notes per release
├── THIRD_PARTY.md              # third-party attributions
├── LICENSE                     # MIT
├── worklog.md                  # per-task development log
├── sysdeck-diagnose.sh         # diagnostic script (install issues)
└── cockpit-smoke-test.sh       # smoke-test for cockpit itself
```

### Bridge layers

The bridge client is the only path to the system. It is layered so each concern can evolve independently:

| Layer | Responsibility | Module entry-point |
|-------|----------------|--------------------|
| **Transport** | Raw `cockpit.spawn` / `cockpit.file` / `cockpit.dbus` / `cockpit.metrics` | `rawSpawn`, `file`, `dbus`, `metricsTap` |
| **Resilience** | Retry with exponential backoff for transient failures | `withRetry` |
| **Pooling** | Collapse identical in-flight spawns into one bridge round-trip | `pooledSpawn` |
| **Permission** | Gate privileged calls on `cockpit.permission` state | `spawnPrivileged`, `permission` |
| **Per-module helpers** | Typed façade per domain (containers, firewall, policy, db, …) | `containers`, `firewall`, `policy`, `db`, … |

Panels import the per-module helpers and never touch the lower layers directly.

### Cross-cutting contracts

- **Cockpit manifest.** Each plugin's `manifest.json` registers it with cockpit under the `index` menu key. Cockpit serves `index.html` at `https://<host>:9090/cockpit/@localhost/sysdeck-<name>/index.html`.
- **cockpit.js.** The global `cockpit` object is loaded via `<script src="../base1/cockpit.js">` — a path relative to the plugin root that the cockpit-bridge resolves. The shared `bridge.js` accesses the global `window.cockpit` directly (the v0.0.22 `import cockpit from "../base1/cockpit.js"` pattern was broken because `cockpit.js` is a UMD/IIFE, not an ES module).
- **Module registry.** `scripts/generate-plugins.py` is the single declarative source for the 20-module catalog. Adding a module means appending one entry and dropping a plugin directory — no other wiring.
- **Python bridge.** The `bridge/` directory contains standalone CLI scripts invoked by absolute path: `python3 /usr/lib/sysdeck/bridge/<module>.py <subcommand> [args]`. No `python3 -m` flag, no `PYTHONPATH` magic (the v0.0.25 `-m sysdeck.bridge.<module>` pattern was broken because it required a nested Python package layout the install target never produced).
- **Polkit.** Privileged bridge operations run via the cockpit superuser channel: the JS panel passes `{ superuser: 'try' }` to `cockpit.spawn`, and the operator authenticates via polkit. The polkit policy at `/usr/share/polkit-1/actions/org.sysdeck.policy` defines eight privilege domains: `system.manage`, `firewall.modify`, `packages.modify`, `firmware.modify`, `vault.modify`, `builder.modify`, `fester.modify`, `policy.modify`, `db.modify`. No `sudo` shell-out from JS anywhere in the suite — this is the **cockpit way**.

## Quick start

See [QUICKSTART.md](./QUICKSTART.md) for the five-minute path. The short version:

```bash
tar xjf sysdeck-0.0.33.tar.bz2
cd sysdeck-0.0.33
sudo make install
sudo systemctl restart cockpit.socket
# open https://<host>:9090 → 20 "SysDeck <Name>" entries appear in the sidebar
```

## Coding standards

The codebase follows four reference standards, adapted to TypeScript/JavaScript/Python:

- **PEP 868 (spirit).** 4-space indentation in Python; 2-space in JS; trailing commas in multi-line literals. Type annotations on every public Python function.
- **POSIX.** Each function does one thing. Compose with pipes (event bus), not with hidden side effects. No function returns more than one type.
- **SEI CERT.** No `eval`, no `Function` constructor, no untrusted input reaching `spawn` without an allowlist. All `cockpit.spawn` calls use the array form.
- **MISRA (spirit).** Limited cyclomatic complexity per function. Single exit point where practical. No heap allocation in render hot paths.

### Refactor discipline

When modifying code, prefer in this order:

1. **Lookup table** — if the construct is a status-to-X mapping, use a `Record<string, X>` (JS) or `dict` / list-of-tuples (Python). The v0.0.33 policy module uses `LSM_PROBES`, `NON_LSM_CONCERNS`, `SMACK_FILE_MAP`, `TOMOYO_FILES`, and `YAMA_SCOPE_NAMES` for exactly this reason — adding a new LSM is one line in the table, not a new code path.
2. **Functional iterator** — `map` / `filter` / `reduce` / `flatMap` over `for` or `while`. The summary command in `bridge/policy.py` builds the entire capability matrix with two dict comprehensions over the lookup tables.
3. **Early return** — flatten nested `if` with guard clauses.
4. **Switch** — only when the case set is closed and a lookup table would be less readable.

When a fork of choices appears, apply **step-down logic**: pick the option that composes best with the rest of the system (Unix philosophy), document the decision in a comment, and move on.

### Comments

Code comments state decisions, not history. Use them to record *why* a non-obvious choice was made. Avoid "restored", "brought back", "was dropped", "surviving artifact", "previously" — these read as haphazard back-and-forth. Every comment should sound like a decisive decision.

## License

MIT — see [LICENSE](./LICENSE). Third-party attributions: see [THIRD_PARTY.md](./THIRD_PARTY.md). Author: Jeremy Anderson (<info@dcos.net>, <https://dcos.net>).

## Release notes

See [BLOG.md](./BLOG.md) for the v0.0.33 release narrative and prior-version history.

## Project history

See [worklog.md](./worklog.md) for the per-task development log.

## Detailed install

See [docs/INSTALL.md](./docs/INSTALL.md) for RPM, DEB, pip, and manual install paths.
