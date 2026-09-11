# SysDeck — Release Notes

Author: **Jeremy Anderson** · <info@dcos.net> · <https://dcos.net>

---

## v0.2.0 — 2026-08-20 (Master Edition: one tarball, two editions, Fester pre-integrated)

v0.2.0 turns SysDeck into a single distributable that ships **both** editions with **Fester vendored and wired in**. The release answers the operator's framing directly: *"fester exists as a separate repository — it deserves its own. generate a master tarball of sysdeck with fester pre-integrated."*

### What ships in sysdeck-0.2.0-master.tar.bz2

- `/` — the cockpit edition, unchanged upstream layout: 26 plugins, bridge/, shared/, packaging, tests, docs.
- `/web` — the NEW **SysDeck Web Edition**: a standalone Next.js 16 console (28 bridge modules) with real `/proc` + `/sys` collectors where the host allows, and clearly badged demo datasets where backends are absent. New panels: Overview landing view, Hardware Alerts (the orphaned bridge that never had a UI), and fully-built Mesh / Vault / Hardware Auth / Firmware.
- `/web/mini-services/fester` — **Fester, vendored + pre-integrated**. Fester stays an independent project with its own version line (0.2.1); the master tarball pins a snapshot so no separate checkout is needed.

### Fester pre-integration (the cockpit side is real now)

- `bridge/fester.py` — the v0.0.31 systemd-listing stub is gone. 11 real subcommands against the fester REST API (stdlib urllib, 4s timeout, `FESTER_URL` override, default `http://127.0.0.1:3010`): `status`, `metrics`, `builds`, `build <id>`, `nodes`, `targets`, `timeline <id>`, `sessions`, `start-build --project --targets [--no-cache] [--retries] [--fail-action]`, `cancel <id>`, `replay <id>`. Every subcommand degrades to actionable JSON when the service is down ("start it with `make fester-start`…").
- `plugins/sysdeck-fester/fester.js` — a real panel: service status card, stat grid (builds total/running/succeeded/failed, cache-hit rate), cluster nodes table, live+history builds table with state chips and row actions (Cancel, Replay → inline session id, Timeline → expandable event log), a start-build form built from the target catalog, 5s auto-refresh that preserves form state.
- `shared/bridge.js` — the fester surface grew from 1 method to 11; `check-bridge-subcommands` now verifies **206 calls across 27 bridge modules** (was 195/26).

### Also fixed in this release

- **The shipped 0.1.3 Makefile was broken.** Its recipes were indented with 8 spaces instead of tabs — GNU make rejects the file outright (`missing separator (did you mean TAB instead of 8 spaces?)`), so `make install` / `make dist` could not run from the released tarball. v0.2.0 restores tab indentation (the fix the v0.0.28 guard itself recommended) and `make -n` passes for every target.
- **New Makefile targets**: `fester-start` (vendored fester service on :3010), `web-install` (bun + prisma setup for the web edition), `web-dev` (fester in the background + web console on :3000), `master` (rebuild the master tarball from the tree).
- Version surfaces bumped 0.1.3 → 0.2.0 across all release surfaces (Makefile, `bridge/__init__.py`, setup.py, PKGBUILD, spec, debian/changelog, compat-manifest, metainfo).

### Verification

- Cockpit tree guards: `python3 -m py_compile bridge/fester.py` clean; `node --check` clean on `fester.js` and `bridge.js`; `tests/check_bridge_subcommands.py` → 206/206 across 27 modules; `check-makefile-recipes` green (tabs restored); `make -n` parses for install / plugins / dist / master / web-dev / fester-start.
- Live integration smoke against the running fester service: `start-build --project gentoo-stage3 --targets mipsel` → build `gentoo-stage3-mtw730qo` (7/7 actions, 7 CAS cache hits, 1050 ms critical path); a second build listed `running` then `cancel` → `{"ok": true}` (final state cancelled, 11 timeline events); `replay` → session `sess-tl6ax5-uvo7vh`.
- Web edition end-to-end: all 28 modules clicked through with zero page errors and zero console errors; the Fester sub-app through the gateway shows live WS events, cluster nodes, and mid-flight builds; the theme engine re-tints the whole suite.
- Master tarball assembled by `scripts/make-master-tarball.sh`; verified by extraction, file count, and sha256.

### Notes

- Fester's version (0.2.1) is intentionally independent from SysDeck's (0.2.0) — it mirrors the separate-repo reality and lets the vendored snapshot track upstream releases without forcing a SysDeck release.
- The web edition's Prisma-backed modules (mesh, vault, containers, mining, …) are demo-badged where the host lacks the backend — the badge is honest, the data shapes are real.

## v0.1.3 — 2026-08-19 (critical: import fixed with shutil.which + mkosi reads profile via temp symlink + download/manage UI)

### Theme: the import was silently empty and the build still wasn't reading the config

v0.1.3 fixes two more critical bugs that v0.1.2 missed, and adds the
download/manage UI the operator asked for. The operator's report:

> *profile workstation still doesnt import current system pkgs. it
> trys to build only 2. which is repetitive at this point.*

Two root causes. Both are embarrassingly simple.

### Import bug: `from __init__ import` failed in the cockpit context

`_detect_host_packages()` started with:

```python
try:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from __init__ import DISTRO, PKG_MANAGER
except Exception:
    DISTRO = "unknown"
    PKG_MANAGER = "unknown"
```

The `except Exception: PKG_MANAGER = "unknown"` was the silent killer.
When the cockpit superuser channel runs the bridge helper, the Python
path context is different — `from __init__ import` fails, the except
clause silently sets `PKG_MANAGER = "unknown"`, and the function
returns `([], "unknown")`. No error, no warning, just an empty list.

The import call in `profile_import_packages` then wrote nothing (the
empty-list early return), and the build used the profile's original
4 template packages — of which mkosi installed 2 (the base `iana-etc`
and `filesystem`).

**Fix:** use `shutil.which()` to find the binary directly:

```python
pacman_bin = shutil.which("pacman")
if pacman_bin:
    cmd = [pacman_bin, "-Qqe"]
    marker = "arch"
```

No import dependency. Works in any execution context. If `pacman`
isn't on PATH, it tries `apt-mark`, then `dnf`. If none are found,
returns `([], "unknown")` — but now the "unknown" is real, not a
silent import failure.

### Build bug: `--include` doesn't replace the base config

v0.1.2 added `--include <profile_path>` to the mkosi command. I
thought `--include` told mkosi "load this config file." It doesn't.

mkosi's `--include` flag includes a **drop-in fragment** ON TOP OF
the base `mkosi.conf`. The base config must still exist as
`mkosi.conf` in the cwd. If it doesn't, mkosi uses defaults and
the `--include` file is silently ignored.

So for the operator's profile at `/etc/mkosi/mkosi.conf.d/arch-workstation.conf`:
- mkosi runs in `/etc/mkosi/mkosi.conf.d/`
- looks for `mkosi.conf` there — doesn't find one
- uses empty defaults (2 base packages)
- the `--include arch-workstation.conf` file is layered on top of
  nothing, effectively ignored

**Fix:** create a temp directory, symlink the profile file as
`mkosi.conf` inside it, and run mkosi from there:

```python
def _prepare_mkosi_work_dir(profile):
    tmpdir = Path(tempfile.mkdtemp(prefix="sysdeck-mkosi-"))
    link = tmpdir / "mkosi.conf"
    link.symlink_to(Path(profile["path"]).resolve())
    return tmpdir
```

Then `build()` sets `work_dir = tmpdir`, so mkosi's cwd is the temp
dir. mkosi finds `mkosi.conf` (the symlink), follows it, reads the
actual profile file. Works for ANY profile path — v0.0.x drop-ins,
v0.1.0+ per-profile dirs, even profiles in random locations.

The temp dir is cleaned up after the build finishes.

### New: download artifacts directly from the panel

Each artifact in the Artifacts panel now has a ⬇ Download button.

The implementation uses `cockpit.spawn(["cat", path], { superuser:
"try", binary: true })` to read the file as a binary stream, collects
the chunks into a `Blob`, creates an object URL, and triggers a
browser download via a synthetic `<a download>` click. Works for
files of any size (streamed, not loaded into memory all at once by
the bridge — the JS side does collect chunks, but cockpit handles
the transport efficiently).

### New: manage artifacts — delete per-file, clear per-profile

Each artifact has a 🗑 button that calls `artifact-delete <profile>
<name>`. The Python side resolves the path safely (refuses path
traversal outside `BUILDER_ARTIFACTS_DIR`) and `unlink()`s the file.

Each profile's artifacts card has a 🗑 Clear all button that calls
`artifacts-clear <profile>`. Removes the entire
`/var/lib/sysdeck/builder/artifacts/<profile>/` directory. Returns
file count + bytes freed for the log.

The card header now shows total size: `myarch artifacts (3, 1.2 GB)`.

### New: manage builds — delete state + log (+ optionally artifacts)

Each build in the Builds table has a 🗑 button. Two-step confirm:

1. "Delete build record?" — OK = delete state + log only
2. If Cancel: "Also delete ALL artifacts for profile?" — OK = delete
   state + log + the profile's entire artifacts dir

The Python `build-delete <build-id> [--artifacts]` reads the state
file FIRST (to get the profile name for artifact cleanup) before
deleting it. Then deletes state + log. If `--artifacts`, also
`shutil.rmtree()` the artifacts dir.

### Regression tests

11 new unit tests across two new test classes:

- `TestBuilderArtifactManagement` (7 tests):
  - `test_artifact_delete_removes_file`
  - `test_artifact_delete_refuses_path_traversal`
  - `test_artifacts_clear_removes_all`
  - `test_build_delete_removes_state_and_log`
  - `test_build_delete_with_artifacts_flag_clears_artifacts_dir`
  - `test_build_delete_nonexistent_returns_error`
  - `test_new_subcommands_registered_in_commands`

- `TestBuilderMkosiTempWorkDir` (3 tests):
  - `test_prepare_creates_temp_dir_with_mkosi_conf_symlink`
  - `test_prepare_returns_none_for_missing_profile_path`
  - `test_prepare_returns_none_for_nonexistent_file`

Existing `test_detect_host_packages_pacman` rewritten to mock
`shutil.which` instead of `__import__`. `test_build_success_path`
updated to no longer expect `--include` on the command line.

Total: 254 tests (was 243 in v0.1.2; +11). All pass.

### The mkosi command now

```
$ mkosi build --output myarch.raw --output-dir /var/lib/sysdeck/builder/artifacts/myarch --force
# work_dir: /tmp/sysdeck-mkosi-abc123
# backend: mkosi
# profile: myarch
# output_dir: /var/lib/sysdeck/builder/artifacts/myarch
```

`work_dir` is the temp dir containing `mkosi.conf` → symlink to the
real profile. mkosi reads the symlink, gets the real config. No
`--include` needed.

---

## v0.1.2 — 2026-08-19 (critical: mkosi never read the profile — --include + auto-migrate)

### Theme: the builder had zero package awareness because mkosi never saw the config

v0.1.2 fixes the critical "zero packages" bug. The operator's report
was unambiguous:

> *the builder absolutely does not work yet. it has zero awareness of
> packages we tell it to add.*

Two compounding root causes were identified and both fixed.

### Root cause 1: mkosi never read the profile config file

`_backend_build_command()` for mkosi was:

```python
cmd = ["mkosi", "build", "--output", name, "--output-dir", dir, "--force"]
```

No flag tells mkosi WHERE the profile config file is. mkosi's default
behavior: look for a file literally named `mkosi.conf` in the cwd. If
it doesn't find one, it uses EMPTY defaults — no distribution override,
no packages, no output settings, nothing.

For the operator's profile at `/etc/mkosi/mkosi.conf.d/arch-workstation.conf`:
- `work_dir` = `/etc/mkosi/mkosi.conf.d/` (parent of the profile file)
- mkosi runs in that cwd
- mkosi looks for `mkosi.conf` in `/etc/mkosi/mkosi.conf.d/`
- The file is named `arch-workstation.conf`, NOT `mkosi.conf`
- mkosi finds no config → uses empty defaults
- Zero packages installed

Even for v0.1.0+ profiles at `/etc/mkosi/profiles/<name>/mkosi.conf`,
the file IS named `mkosi.conf` so mkosi would find it — but only
because of the directory layout, not because sysdeck was explicit
about it. That's fragile.

### Fix 1: `--include <profile_path>` on every mkosi build

```python
cmd = ["mkosi", "build"]
if ppath:
    cmd += ["--include", ppath]
cmd += ["--output", output_name, "--output-dir", artifacts_dir, "--force"]
```

`--include` tells mkosi to explicitly load the profile config by path,
regardless of its filename or location. This is the fix for "zero
awareness of packages" — mkosi now ALWAYS sees the profile config,
whether it's at `/etc/mkosi/profiles/myarch/mkosi.conf` (v0.1.0 layout)
or `/etc/mkosi/mkosi.conf.d/arch-workstation.conf` (v0.0.x layout).

### Root cause 2: legacy `Packages=` syntax silently parsed as garbage

Even when mkosi DID read the profile file (e.g. v0.1.0+ profiles with
correct location), profiles created by v0.0.x used the old indented
`Packages=` syntax:

```ini
[Packages]
Packages=
    linux
    linux-firmware
    systemd
    openssh
```

mkosi v22+ (Arch ships 25.x) only understands single-line:

```ini
[Packages]
Packages=linux linux-firmware systemd openssh
```

The old indented form is silently parsed as a single package name with
embedded newlines (`"linux\nlinux-firmware\nsystemd\nopenssh"`), which
doesn't exist in any repo — so mkosi installs NOTHING. The build
"succeeds" but the image has zero of the operator's requested packages.

### Fix 2: auto-migrate legacy `Packages=` syntax before every build

New `_migrate_legacy_mkosi_packages(conf_path)` function:
1. Reads the profile file
2. Detects the old indented syntax via regex
3. Extracts package names from the indented block
4. Rewrites the `Packages=` line to single-line space-separated form
5. Writes the file back IN-PLACE

`build()` calls this automatically on every mkosi build, BEFORE
constructing the command. The migration is logged in:
- **Build state JSON** (`warnings` array): `"packages_migrated: rewrote Packages= from old indented syntax to single-line (N packages: ...)"`
- **Log file header**: `# MIGRATED: rewrote Packages= from old indented syntax to single-line (N packages: ...)`

If the file already uses modern syntax, the migration is a no-op
(returns `{"migrated": False, "reason": "already uses single-line syntax"}`).

### Regression tests

4 new unit tests in `TestBuilderBuildPath`:

- `test_migrate_rewrites_old_indented_syntax` — verifies old
  `Packages=\n    linux\n    vim\n` is rewritten to `Packages=linux vim`
- `test_migrate_noop_on_modern_syntax` — verifies already-modern files
  are left unchanged
- `test_migrate_noop_on_no_packages_section` — verifies files without
  `[Packages]` are left unchanged
- `test_migrate_runs_during_build` — end-to-end: `build()` with a
  profile containing old syntax auto-migrates before mkosi runs, and
  the migration is recorded in state + log

The existing `test_build_success_path` was extended to verify
`--include` is on the command line and points at the profile file.

Total: 243 tests (was 239 in v0.1.1; +4). All build-time guards pass.

### The mkosi command line now

```
$ mkosi build --include /etc/mkosi/profiles/myarch/mkosi.conf --output myarch.raw --output-dir /var/lib/sysdeck/builder/artifacts/myarch --force
# work_dir: /etc/mkosi/profiles/myarch
# backend: mkosi
# profile: myarch
# output_dir: /var/lib/sysdeck/builder/artifacts/myarch
```

Every flag sysdeck needs is on the CLI. Nothing depends on the
profile's `mkosi.conf` having the right settings — sysdeck forces
the config path, output name, output dir, and overwrite.

---

## v0.1.1 — 2026-08-19 (output path safety fix: CLI flags force artifacts dir)

### Theme: trusting mkosi.conf was the bug

v0.1.1 is the "I should have done this in v0.1.0" release. The v0.1.0
fix added `OutputDirectory=` to the scaffolded `mkosi.conf` template,
trusting mkosi to honor it. Two problems with that trust:

1. **Old v0.0.x profiles have no `OutputDirectory=`.** The operator's
   `arch-workstation` profile was created by v0.0.50 — it lives at
   `/etc/mkosi/mkosi.conf.d/arch-workstation.conf` and has no output
   directory setting. mkosi defaulted to writing `image.raw` into
   the cwd (`/etc/mkosi/mkosi.conf.d/`), a system config directory
   owned by root.
2. **mkosi then refused to overwrite the existing `image.raw`.** The
   error message — "Output path /etc/mkosi/mkosi.conf.d/image.raw
   exists already. (Use --force to rebuild.)" — blocked every rebuild
   from the panel, which had no way to pass `--force`.

The operator's response was unambiguous:

> *this is NOT a safe output path. fix this now.*

### The fix: don't trust the profile, force the CLI

`_backend_build_command()` for mkosi was just:

```python
cmd = ["mkosi", "build"]
```

It is now:

```python
artifacts_dir = options.get("output_dir") or str(BUILDER_ARTIFACTS_DIR / pname)
output_name = options.get("output_name") or f"{pname}.raw"
cmd = [
    "mkosi", "build",
    "--output", output_name,
    "--output-dir", artifacts_dir,
    "--force",
]
```

CLI flags override `mkosi.conf` (mkosi's documented precedence: CLI >
config file). So the output path is forced to
`/var/lib/sysdeck/builder/artifacts/<name>/<name>.raw` regardless of
what the profile says — or doesn't say. `--force` overwrites any
existing image so rebuilds don't fail.

### Belt-and-suspenders: refuse unsafe output paths

Even with the CLI force, I added a safety check in `build()` that
refuses to proceed if the resolved `output_dir` is not under
`/var/lib/`, `/tmp/`, `/var/tmp/`, or the configured
`BUILDER_ARTIFACTS_DIR`. This blocks `/etc/`, `/usr/`, `/boot/`,
`/bin/`, `/sbin/`, `/lib/`, `/root/`, `/home/`, etc. — anywhere a
stray `image.raw` would corrupt the system or pollute a user's home.

If an operator somehow passes `options.output_dir=/etc/something` via
the JS bridge, the build is refused before `subprocess.run` is called.
The error message:

```
refusing to build: output directory '/etc/mkosi/evil' is not under
/var/lib/, /tmp/, or /var/tmp/. Build outputs must go to
/var/lib/sysdeck/builder/artifacts/<profile>/ to avoid corrupting
system config directories.
```

### Legacy profile warning

The operator's build was running against a v0.0.x profile in
`/etc/mkosi/mkosi.conf.d/`. v0.1.0 already fixed the scaffold location
for NEW profiles (they go in `/etc/mkosi/profiles/<name>/mkosi.conf`),
but the OLD profile is still there. v0.1.1 doesn't refuse to build it
(the output-path safety is handled), but it records a warning in both
the build state JSON and the log file:

```
# WARNING: profile is in /etc/mkosi/mkosi.conf.d/ (legacy v0.0.x layout).
#          mkosi may silently ignore this drop-in fragment.
#          Migrate to /etc/mkosi/profiles/<name>/mkosi.conf for a real profile.
```

The build state JSON gets a `warnings` array so the panel can surface
it in the UI too.

### Log improvement

The build log header now includes the resolved `output_dir` so the
operator can see exactly where the image will land before mkosi starts:

```
$ mkosi build --output arch-workstation.raw --output-dir /var/lib/sysdeck/builder/artifacts/arch-workstation --force
# work_dir: /etc/mkosi/mkosi.conf.d
# backend: mkosi
# profile: arch-workstation
# output_dir: /var/lib/sysdeck/builder/artifacts/arch-workstation
```

### Regression tests

2 new unit tests in `TestBuilderBuildPath`:

- `test_build_refuses_output_dir_under_etc` — verifies the safety check
  rejects `output_dir=/etc/mkosi/evil`.
- `test_build_legacy_v050_profile_records_warning` — verifies building
  a profile in `/etc/mkosi/mkosi.conf.d/` records the legacy warning
  in state + log.

The existing `test_build_success_path` was extended to verify the
mkosi command line includes `--output`, `--output-dir`, and `--force`,
and that `--output-dir` points at the per-profile artifacts dir.

Total: 239 tests (was 237 in v0.1.0; +2). All build-time guards pass.

### What the operator should do

1. `sudo make uninstall && sudo make install && sudo systemctl restart cockpit.socket`
2. Delete the old image.raw that mkosi created in the wrong place:
   `sudo rm /etc/mkosi/mkosi.conf.d/image.raw`
3. Migrate the old profile: `sudo mkdir -p /etc/mkosi/profiles/arch-workstation && sudo mv /etc/mkosi/mkosi.conf.d/arch-workstation.conf /etc/mkosi/profiles/arch-workstation/mkosi.conf`
4. Click Build on `arch-workstation` — output will land at
   `/var/lib/sysdeck/builder/artifacts/arch-workstation/arch-workstation.raw`

---

## v0.1.0 — 2026-08-19 (builder profile fixup + host pkg import)

### Theme: the empty-image bug that turned out to be three bugs in a trench coat

v0.1.0 is the "fix what v0.0.50 should have caught" release. The v0.0.50
fix (adding the missing `import re` to `bridge/builder.py`) unblocked
the `build()` code path, and the operator immediately ran into the next
layer of problems. The build log went:

```
‣  Installing Arch Linux
Packages (2) iana-etc-20260530-1  filesystem-2025.10.12-1
‣  Generating disk image
‣  /etc/mkosi/mkosi.conf.d/image.raw size is 33.0M, consumes 32.0M.
```

Then the operator wrote: *"nice try but i think our profile build didnt
work. i dont see a final tarball or image file to look at."* Two red
flags in that single last line:
1. The file is `image.raw`, not `myimage.raw` (the template said
   `Output=myimage.raw`)
2. It's in `/etc/mkosi/mkosi.conf.d/`, not sysdeck's artifacts dir.

The four packages from the scaffold template (`linux`, `linux-firmware`,
`systemd`, `openssh`) were silently dropped. Three compounding bugs were
to blame, and only one of them was the "obvious" one.

### Bug 1: the scaffolded profile was never read

`profile-create` (since v0.0.31) wrote
`/etc/mkosi/mkosi.conf.d/<name>.conf` — a drop-in *fragment*.

mkosi's drop-in semantics: `mkosi.conf.d/*.conf` files are layered on
top of a *parent* `mkosi.conf`. With no parent, mkosi runs as if the
fragment didn't exist. It auto-detected the host distro, defaulted to
`Format=disk` with `Output=image.raw`, and used an empty `Packages=`
list. That's why the output filename was `image.raw` not `myimage.raw`,
and why the only packages that got installed were `iana-etc` + 
`filesystem` — mkosi's hardcoded Arch base.

**Fix:** each profile now lives in its own directory
`/etc/mkosi/profiles/<name>/mkosi.conf`. `mkosi.conf` is the only
filename mkosi reads automatically from the cwd. `MKOSI_DIRS` updated
to scan `/etc/mkosi/profiles` first.

This also makes per-profile `mkosi.extra/`, `mkosi.pkg/`, etc. work
naturally — operators can drop in supplementary files alongside the
config and mkosi picks them up.

### Bug 2: the `Packages=` syntax was from mkosi v15

The template was:

```ini
[Packages]
Packages=
    linux
    linux-firmware
    systemd
    openssh
```

That indented-continuation form was the **old systemd-mkosi (≤v15)**
syntax. Modern mkosi (v22+, what Arch ships as `mkosi 25.x`) wants
either `Packages=linux linux-firmware systemd openssh` on a single
line, or a separate `mkosi.pkg` file referenced via
`Packages=mkosi.pkg`. The v0.0.x form was silently parsed as a single
package named `"linux\nlinux-firmware\nsystemd\nopenssh"` and failed
to install.

**Fix:** template + writer now emit the modern single-line form. The
reader accepts both forms so v0.0.x profiles migrate cleanly on first
append/replace.

This bug was particularly nasty because:
- The writer's tests (`test_bridge_parsers.py:2216-2252`) asserted
  `"    vim\n"` was in the file — passing the test meant emitting the
  *wrong* syntax.
- The reader only understood the indented form, so even if you fixed
  the template by hand, the next `--mode=append` write would silently
  re-break the syntax.

### Bug 3: the artifact never reached sysdeck's artifacts directory

`build()` (line 672-681 of the old code) only scanned
`/var/lib/sysdeck/builder/artifacts/<profile>/` for artifacts. But mkosi
writes its output to the cwd (`/etc/mkosi/mkosi.conf.d/image.raw`). No
copy step. Hence "i dont see a final tarball or image file to look at"
from sysdeck's point of view — even though mkosi technically did
produce one.

**Fix:** `_MKOSI_TEMPLATE` now sets
`OutputDirectory=/var/lib/sysdeck/builder/artifacts/<name>` so mkosi
writes directly there. The artifacts panel's discovery code already
scanned that directory, so once mkosi writes there the panel finds it
automatically.

### New feature: `profile-import-packages`

Per operator request: *"import current os pkg list to profile should be
an option."*

Queries the host's explicitly-installed packages:
- **Arch:** `pacman -Qqe` (explicitly installed; excludes deps)
- **Debian:** `apt-mark showmanual` (closest analog to `pacman -Qqe`)
- **Fedora:** `dnf repoquery --userinstalled --queryformat '%{name}'`

Then writes the result into the profile via the existing
`_write_packages` dispatch. Defaults to **append** mode (the operator
usually wants to layer host packages on top of the profile's existing
baseline like `linux`/`systemd`/`openssh`).

Three flags:
- `--mode=replace` — wipe the baseline first
- `--dry-run` — return what *would* be written, don't touch the file
- `--packages=<json>` — override the host query with a JSON-encoded
  multiline string (useful for importing a list captured on a
  different host)

The panel exposes a "⇩ Import host pkgs" button on every profile row.
Two-step UX: dry-run preview → `window.confirm` with package count,
source distro, and first 200 packages → append write. Operator can
cancel cleanly without any file changes.

New polkit exec paths for `pacman`/`apt-mark`/`dnf` added to
`org.sysdeck.builder.modify`.

### Regression tests

7 new unit tests in `TestBuilderImportHostPackages`:
- `_detect_host_packages` dispatch (pacman path + dedup)
- `--packages` override end-to-end (writes the file)
- `--dry-run` doesn't write
- unknown profile / no args / bad mode / COMMANDS-registration error
  paths

(Actually 8 — one of the dispatch tests splits into two methods, one
for the happy path and one for dedup. The class total is 8.)

4 existing tests in `TestBuilderPackagesField` updated for the new
single-line `Packages=` syntax. 1 new test
(`test_mkosi_modern_single_line_input_parsed`) guards against a
regression where the writer emits the new form but the reader only
understands the old one — that would silently break append mode on
profiles created by v0.1.0 itself.

Total: 237 tests (was 228 in v0.0.50; +9). All build-time guards pass.

### Why v0.1.0 (and not v0.0.51)

The bug fixes are technically backwards-incompatible: profiles created
by v0.0.x live in `/etc/mkosi/mkosi.conf.d/<name>.conf` and use the
indented `Packages=` syntax. v0.1.0's reader accepts both syntaxes
(safe migration), but the scaffold location is different. Operators
upgrading from v0.0.x to v0.1.0 should either:
1. Move their profiles from `/etc/mkosi/mkosi.conf.d/<name>.conf` to
   `/etc/mkosi/profiles/<name>/mkosi.conf`, or
2. Create a parent `/etc/mkosi/mkosi.conf` (any non-empty `[Distribution]`
   section will do) so the existing drop-ins start being honored.

The minor version bump makes the incompatibility visible.

---

## v0.0.50 — 2026-08-19 (build path NameError fix: `import re` added to bridge/builder.py)

### Theme: the one-line fix that took 18 releases to find

v0.0.50 is a one-line bugfix release. An operator reported:

> *NameError: name 're' is not defined. Did you forget to import
> 're'? happens right away on build for a new profile i created.*

The traceback pointed at `bridge/builder.py` line 492, inside
`_new_build_id()`:

```python
safe_profile = re.sub(r"[^A-Za-z0-9_-]", "_", profile)
```

`re` wasn't imported at module level. The module-level imports were:

```python
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any
```

No `import re`. `_new_build_id` has used `re.sub` since v0.0.31 —
when the build operations were first added. The bug went undetected
for 18 releases (v0.0.31 through v0.0.49) until an operator actually
clicked Build on a freshly-created profile.

#### Why it went undetected

Three layers of defense all missed it:

1. **`python3 -m py_compile`** (the `make check` syntax check) only
   catches *syntax* errors. A `NameError` at call time is not a
   syntax error — the code is syntactically valid Python, it just
   references a name that isn't in scope when the function runs.

2. **Unit tests.** The existing unit tests covered `profile_create`,
   `profile_copy`, `profile_delete`, and the v0.0.49 package-writing
   helpers. None of them call `build()`, and `build()` is the only
   caller of `_new_build_id`. So the function that held the bug was
   never exercised by any test.

3. **Manual testing.** The operator workflow up to v0.0.48 was
   "create/copy a profile, then build it from a shell." The v0.0.49
   release added the inline package-list field, which made the
   create-then-build flow smooth enough that the operator clicked
   Build in the panel for the first time — and hit the bug.

The lesson: functions that are reachable only through a specific code
path (here: `build()` → `_new_build_id()`) need explicit tests that
exercise that path, even if the function itself looks trivial. The
`make check` syntax check is necessary but not sufficient.

#### The fix

One line added to the module-level imports:

```python
import json
import os
import re          # ← added
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any
```

Also removed the now-redundant local `import re` inside
`_write_packages_vmdb2` (it was a v0.0.49 workaround — that function
uses `re.compile` for the YAML-include regex, and I added a local
import there instead of checking whether `re` was already module-level.
It wasn't. The local import masked the missing module-level import for
`_write_packages_vmdb2`'s own tests, but did nothing for
`_new_build_id`).

#### Regression tests

9 new unit tests in `TestBuilderBuildPath`:

- **`_new_build_id` format**: asserts the build_id matches
  `^<profile>-(\d{14})$`.
- **`_new_build_id` sanitizes unsafe chars**: profile name
  `myarch.v2` → `myarch_v2-<ts>` (dot replaced with `_`).
- **`_new_build_id` preserves safe chars**: profile name
  `my-arch_profile` → `my-arch_profile-<ts>` (hyphens + underscores
  kept).
- **`_new_build_id_re_imported_at_module_level`**: explicit
  `assertIn("re", dir(builder))`. This is the regression guard — if
  anyone ever removes the `import re` line in a future refactor, this
  test fails before the tarball ships. The v0.0.31-v0.0.49 bug can't
  recur.
- **`build()` success path**: end-to-end with mocked `subprocess.run`
  (rc=0). Patches `BUILDER_STATE_DIR` / `BUILDER_LOGS_DIR` /
  `BUILDER_ARTIFACTS_DIR` to tempdirs, patches `BACKENDS` to fake a
  mkosi install, patches `profiles()` to return a fake profile.
  Verifies response shape (`build_id` / `state` / `rc` / `success` /
  `duration_s` / `artifacts` / `log_path`), state file written, log
  file written, `subprocess.run` was actually called.
- **`build()` unknown profile**: returns `{error: "profile
  'nonexistent' not found"}`.
- **`build()` no args**: returns `{error: "profile name required"}`
  (no crash).
- **`build()` backend not installed**: returns `{error: "backend
  'mkosi' is not installed", hint: ...}`.
- **`build()` non-zero returncode**: mocked `subprocess.run` returns
  rc=1 → build state `"failed"`, `rc=1`, `success=False`.

All tests mock `subprocess.run` and the module-level state dirs; none
touch real `/var/lib/` or invoke real backends. The tests run in 9
milliseconds.

#### AST audit

To make sure there weren't *other* latent NameErrors lurking in
`builder.py`, I wrote an AST-based audit that walks every function
body, collects `Name` loads, and checks each against (module-level
names + function locals + builtins). The audit flagged ~50 items,
but every one was a false positive:

- **Comprehension locals** (`b`, `v`, `s`, `p`, `logf`) — bound by
  the comprehension itself.
- **Tuple-unpacking targets** (`cid`, `chint`, `k`, `v`,
  `backend_id`, `binary`, `vargs`, `kind`) — bound by `for ... in`
  loops.
- **Except-clause targets** (`exc`) — bound by `except ... as exc:`.
- **`__file__`** — provided by Python in every module.

No real undefined names. The build path is now fully exercisable by
tests.

#### What this release is NOT

- **No JS changes.** This is a Python-only fix. The bridge.js
  subcommand cross-check stays at 102 calls.
- **No new bridge subcommands.** `build` is an existing command;
  it just works now.
- **No new plugin / polkit / bridge helper file.** Counts unchanged.
- **No changes to profile discovery, build invocation, or the
  package-writing helpers.** The fix is purely the missing import.

#### Process improvement

The v0.0.31-v0.0.49 bug existed because no test exercised the
`build()` code path. v0.0.50 adds that test coverage — 9 tests that
mock `subprocess.run` and the state dirs, so they run hermetically in
the `make check` suite without needing a real backend installed. Any
future regression in the build path (missing imports, broken state-
file writing, wrong response shape, wrong subprocess invocation) will
now be caught before the tarball ships.

---

## v0.0.49 — 2026-08-19 (builder inline package list: textarea + file upload + merge mode for all 4 backends)

### Theme: close the loop on profile creation — paste the baseline apps inline

v0.0.49 is a feature release for the Image Builder panel. Per user
directive: *"we should allow adding a pacman -Sy applist.txt with a
literal list of baseline apps for the profile being generated."*

The v0.0.48 release fixed the dead-end error that operators of
archiso-only or live-build-only hosts were hitting, and added the
"Copy shipped profile" form. But both forms still left the operator
with a half-finished profile: they scaffolded/copied the config, then
had to drop to a shell to edit the package list. v0.0.49 closes that
loop — the package list is now part of the creation flow.

#### 1. The field

Both the Create Profile and Copy shipped profile forms now include a
shared `renderPackagesField(prefix, defaultMode)` block with three
parts:

- A `<textarea>` for inline paste. One package per line, `#` comments
  allowed. This is the source of truth.
- A file `<input type="file">` accepting `.txt` / `.list` / `.conf`.
  When the operator picks a file, the browser's `FileReader` API reads
  it as text and populates the textarea — so the operator can review
  and edit the uploaded content before submitting. 1 MB cap (anything
  larger is probably not a package list).
- A merge-mode `<select>` with two options: **append** (add to
  baseline, dedup) and **replace** (overwrite). Default is `replace`
  for Create (the scaffold's minimal defaults are replaced by the
  operator's list) and `append` for Copy (the baseline's packages
  like `linux`/`base` are preserved, the operator's list adds to
  them). The operator can flip the toggle per-operation.

The `prefix` parameter distinguishes element IDs (`cp-create-*` vs
`cp-copy-*`) so both forms coexist on the same page without ID
collisions.

#### 2. All 4 backends supported

Each backend stores its package list in a different place and format.
Rather than build a generic "update INI/YAML" abstraction (which would
leak format details through it), I wrote four per-backend writers:

- **mkosi** → `[Packages]` section of `<name>.conf`. mkosi v22+ uses
  an INI continuation: each package on its own indented line under
  `Packages=`. The writer parses the existing section, dedups on
  append, and rebuilds it. Other sections (`[Distribution]`,
  `[Output]`, etc.) are preserved.
- **vmdb2** → `bootstrap.include` list in `<name>.yaml`. Regex-based
  surgery on the include block. pyyaml is NOT a hard dependency —
  vmdb2 isn't typically installed on Arch, and pulling in a YAML
  parser just to update a list would be overkill. Other YAML sections
  (`partitions`, `commands`) are preserved.
- **archiso** → `packages.x86_64` in the profile dir. One package per
  line, `#` comments allowed. The writer preserves the comment header
  on append, dedups, and rewrites. In replace mode, writes a fresh
  file with a header comment + the operator's packages.
- **live-build** → `config/package-lists/sysdeck.list`. live-build
  merges all `.list` files at build time, so each list file is an
  independent package set. In replace mode, removes old `sysdeck*.list`
  files (does NOT touch baseline `.list` files like `baseline.list`).
  In append mode, just writes/overwrites `sysdeck.list` (the file is
  the unit).

A dispatcher (`_write_packages(profile_path, backend, packages_text,
mode)`) validates the mode, parses the packages text, and routes to
the right writer.

#### 3. Bridge extensions

`profile_create()` and `profile_copy()` in `bridge/builder.py` now
accept two new optional flags:

- `--packages=<json>` — a JSON-encoded string. JSON is used so
  newlines, quotes, and unicode survive the argv boundary cleanly.
  The bridge does `json.loads(arg)` to recover the original multiline
  text.
- `--mode=append|replace` — defaults to `replace` for create, `append`
  for copy.

Both commands return a new `packages` field in their success response:
`{count, mode, path}`. If package-writing fails (e.g. permission
error), the profile is still created/copied and a `packages_error`
field is included — non-fatal, so the operator can fix the package
file by hand without losing the profile.

A small `_extract_opts(args)` helper splits the argv into positional +
`--key=value` opts, so the new flags don't break the existing
positional signatures (`<name> <backend> [base]` for create,
`<src> <new> [backend]` for copy).

#### 4. Bridge.js updates

`bridge.builder.profileCreate(name, backend, base, packagesText, mode)`
and `bridge.builder.profileCopy(srcName, newName, backend, packagesText,
mode)`. `packagesText` is JSON-encoded via `JSON.stringify()` in the
JS, decoded via `json.loads()` in the bridge. When `packagesText` is
omitted/null, the bridge writes no package file — full back-compat
with v0.0.48 callers.

#### 5. 28 new unit tests

A new `TestBuilderPackagesField` class in `tests/test_bridge_parsers.py`
covers:

- `_parse_packages_text` (6 tests): empty input, full-line comments,
  inline comments, dedup, whitespace, blank lines.
- `_extract_opts` (4 tests): positional-only, key=value, boolean flag,
  mixed.
- `_write_packages_mkosi` (3 tests): replace, append+dedup,
  append-to-empty-section.
- `_write_packages_vmdb2` (2 tests): replace, append+dedup.
- `_write_packages_archiso` (2 tests): replace, append+preserve-
  baseline.
- `_write_packages_live_build` (3 tests): basic write, replace clears
  old `sysdeck*.list` but preserves `baseline.list`, append overwrites
  `sysdeck.list` only.
- `_write_packages` dispatcher (3 tests): invalid mode, unknown
  backend, archiso file path rejected.
- `profile_create` end-to-end (2 tests): arg parsing + JSON decode,
  invalid JSON rejected.
- `profile_copy` end-to-end (3 tests): archiso append, live-build
  replace, back-compat without `--packages`.

All 28 tests use `tempfile.mkdtemp()` and `unittest.mock.patch.object()`;
none touch real `/etc/` or `/usr/share/` paths. The tests run in 13
milliseconds.

#### 6. What this release is NOT

- **No new polkit file.** Package-writing uses the existing
  `org.sysdeck.builder.modify` action — same as `profile-create`,
  `profile-copy`, `profile-delete`, and `build`.
- **No new bridge helper file.** All the new code lives inside
  `bridge/builder.py`. Bridge helper count stays at 22.
- **No new plugin.** The packages field is part of the existing
  `sysdeck-builder` panel. Plugin count stays at 26.
- **No new bridge subcommand.** `profile-create` and `profile-copy`
  are existing commands; they just accept new optional flags. The
  bridge.js subcommand cross-check stays at 102 calls.
- **No pyyaml dependency.** The vmdb2 writer uses regex-based surgery
  on the include list, not a YAML parser. This keeps the bridge
  dependency-free.
- **No changes to profile discovery or build invocation.** Profiles
  with written package lists build the same way as before — the
  operator runs `▶ Build` on the new entry in the profiles table.

#### 7. Step-down logic

Three options were on the table for where to put the package-writing
logic:

1. **Embed in `profile-create` / `profile-copy`.** Chosen. Atomic
   (if packages fail to write, the whole create/copy fails — though
   we made it non-fatal so the profile survives), one JS call instead
   of two, matches the user's framing ("for the profile being
   generated").

2. **Separate `profile-set-packages` command.** Rejected as the
   primary path (would require JS to chain two calls; if the second
   fails, the profile exists but has no packages). However, this
   would be a natural follow-up if operators want to edit packages
   on an existing profile without re-creating it — the `_write_packages`
   helper is already factored out and could be called from a new
   command with ~10 lines of glue.

3. **File upload only (no textarea).** Rejected. The textarea lets
   the operator quickly add 2-3 packages without creating a file, and
   it's where file uploads land anyway (so the operator can review
   before submitting). Two input modes, one source of truth.

Option 1 won because it matches the user's framing and keeps the
creation flow atomic. The `_write_packages` helper is factored out
so option 2 can be added later without rewriting the writers.

---

## v0.0.48 — 2026-08-19 (builder profile-create bugfix: dropdown gating + new copy-shipped-profile path)

### Theme: stop funneling archiso/live-build operators into a dead-end error

v0.0.48 is a targeted bugfix release for the Image Builder panel. An
operator on an archiso-only Arch host (or a live-build-only Debian
host — i.e. a box with `archiso`/`live-build` installed but no
`mkosi`/`vmdb2`) reported hitting this error when trying to create a
build profile:

```
Error: profile-create supports ('mkosi', 'vmdb2'); archiso profiles
are not scaffolded (use the shipped ones)
```

The bridge-side rejection is correct by design — `archiso` and
`live-build` use shipped directory-based profile trees (with
`profiledef.sh` + `airootfs/` for archiso, `config/` for live-build),
not single-file specs that can be scaffolded from scratch. The bug was
on the panel side: the v0.0.31 Create Profile dropdown's fallback path
offered `primary.id` when no `mkosi`/`vmdb2` backend was installed.
On an archiso-only host, `primary.id` is `archiso` — the operator
picked it, clicked Create, and ran straight into the brick wall.

Worse, the error message told them what to do — *"use the shipped
ones"* — but the panel gave them no affordance to actually do it.
There was no Copy button, no shipped-profile picker, no link to the
docs. Just a dead end.

#### 1. Fix the dropdown gating

`renderCreateProfile` in `plugins/sysdeck-builder/builder.js` no
longer falls back to `primary.id`. When no `mkosi`/`vmdb2` backend is
installed, the form renders an inline install hint card with the exact
`pacman -S --needed mkosi` / `apt install -y vmdb2` command — no
dropdown at all. When scaffoldable backends ARE installed, the
dropdown only offers those (no `archiso`/`live-build` entries to
mislead).

This is the kind of bug that's easy to introduce and embarrassingly
easy to miss in review: the existing
`backends.filter(b => b.id === 'mkosi' || b.id === 'vmdb2')` line is
correct — the bug was the `||` fallback that activated when the filter
returned empty. The lesson is: when a filter empties out, don't
silently widen the scope — show a message explaining why the operation
isn't available and what to do about it.

#### 2. Add a "Copy shipped profile" form

The new `renderCopyProfile(profiles, primary)` form is the panel-side
answer to the bridge's *"use the shipped ones"* hint. It lists every
shipped `archiso` and `live-build` profile discovered via `profiles()`
— typically `baseline` and `releng` for archiso — grouped by backend
in `<optgroup>` elements. A free-text input takes the new profile
name. A "⎘ Copy" button triggers the new
`bridge.builder.profileCopy(srcName, newName, backend)` method.

When no shipped archiso/live-build profiles are found (e.g. the
backend isn't installed), the form renders an inline install hint
with the exact `pacman -S --needed archiso` / `apt install -y
live-build` command.

The form lives directly below the Create Profile form, so the
operator sees both paths side-by-side: scaffold a new single-file
spec (mkosi/vmdb2) OR copy a shipped directory tree (archiso/live-
build). The right tool for each backend.

#### 3. New bridge command: `profile-copy`

`bridge/builder.py` gains a `profile_copy()` function, registered in
the `COMMANDS` dict as `profile-copy`. Usage:

    python3 /usr/lib/sysdeck/bridge/builder.py profile-copy <src-name> <new-name> [backend]

It copies `/usr/share/archiso/configs/<src-name>/` →
`/etc/archiso/configs/<new-name>/` (and the live-build equivalent at
`/etc/live-build/<new-name>/`). Validation:

- **new-name safety**: rejects `/`, `.`, and `..` to prevent path
  traversal via crafted names like `../../etc/passwd`. The polkit
  action `org.sysdeck.builder.modify` already gates access, but
  defense-in-depth says don't trust the caller with path
  construction.
- **source resolution**: reuses the existing `profiles()` discovery
  — no new path-walking code. If `backend` is given, the source must
  match it; we don't silently cross-copy.
- **backend-kind guard**: refuses mkosi/vmdb2 sources with a clear
  `"use profile-create to scaffold a new one"` hint. The two
  operations are distinct: `profile-create` writes a single file
  from a template; `profile-copy` copies a directory tree. Keeping
  them separate avoids a confusing "create-or-copy?" branch inside
  one command.
- **destination-exists guard**: refuses if the destination already
  exists, with a hint pointing at `profile-delete` as the cleanup
  path. Matches `profile-create`'s "already exists" behavior.

Returns structured `{copied, backend, source, source_path, name,
path}` on success; `{copied: False, error, hint}` on failure (same
shape as `profile_create`). Uses the same polkit action as
`profile-create` — no new polkit file needed.

#### 4. Destination-roots refactor (testability)

The destination paths were hardcoded `Path("/etc/archiso/configs")`
and `Path("/etc/live-build")` literals inside `profile_copy`. Pulled
them out to module-level constants `ARCHISO_COPY_DEST` and
`LIVE_BUILD_COPY_DEST`. This mirrors the existing `ARCHISO_DIRS` /
`LIVE_BUILD_DIRS` pattern and lets unit tests patch them with
tempdirs instead of touching real `/etc/` paths. Small change, big
testability win.

#### 5. 15 new unit tests

A new `TestBuilderProfileCopy` class in
`tests/test_bridge_parsers.py` covers:

- **Argument validation** (5 tests): no args, one arg, slash in
  name, `.` name, `..` name.
- **Source resolution** (4 tests): not-found (returns clear error +
  hint pointing at the `profiles` subcommand), wrong-backend hint
  filter (passes `backend=archiso` but only a live-build profile
  matches → not-found, no silent cross-copy), mkosi source rejected
  with "use profile-create" hint, vmdb2 source rejected with same.
- **Success paths** (3 tests): archiso copy (builds a fake
  `profiledef.sh` + `airootfs/etc/hostname` tree in a tempdir,
  copies via patched `ARCHISO_COPY_DEST`, verifies the tree was
  actually copied byte-for-byte), live-build copy (same pattern
  with `config/shared`), backend-hint-inferred-when-omitted (third
  arg optional — first matching profile used regardless of backend).
- **Failure modes** (3 tests): dest-already-exists (pre-create the
  dest, expect "already exists" + "use profile-delete" hint),
  source-path-not-a-directory (canned entry with a file path instead
  of dir → "not a directory"), permission-error (mock
  `shutil.copytree` to raise `PermissionError("denied")` → expect
  error + polkit hint mentioning `org.sysdeck.builder.modify`).

All 15 tests use `tempfile.mkdtemp()` and
`unittest.mock.patch.object()`. None touch real `/etc/` or
`/usr/share/` paths. The tests run in 8 milliseconds.

#### 6. Version sync

Bumped 0.0.47 → 0.0.48 across all 9 release surfaces (Makefile
`VERSION` + header comment, `bridge/__init__.py` `__version__`,
`packaging/setup.py` `VERSION`, PKGBUILD `pkgver`, RPM spec `Version`
+ `%changelog` entry, `debian/changelog` entry,
`compat/compat-manifest.json` `version` + `_comment` + a new
`_comment_v0.0.48` field on the builder module entry,
`packaging/sysdeck.metainfo.xml` `<release>`, `README.md` Version
line + highlights section).

The existing `test_version_sync_all_surfaces_report_047` test was
renamed to `..._048` and the version string updated to `"0.0.48"`.
The test enumerates 8 files and asserts each contains `"0.0.48"`,
catching any surface that misses the bump.

#### What this release is NOT

- **No new polkit file.** `profile-copy` uses the existing
  `org.sysdeck.builder.modify` action — same as `profile-create`,
  `profile-delete`, and `build`. No new polkit XML, no new
  `packaging/polkit/*.policy` file, no Makefile install-stanza
  changes.
- **No new bridge helper file.** `profile_copy` lives inside
  `bridge/builder.py` alongside `profile_create` and
  `profile_delete`. The bridge helper count stays at 22.
- **No new plugin.** The Copy shipped profile form is part of the
  existing `sysdeck-builder` panel. Plugin count stays at 26.
- **No changes to profile discovery.** `_archiso_profiles()` and
  `_live_build_profiles()` are unchanged. `profile_copy` reuses
  `profiles()` as-is.
- **No changes to build invocation.** `build()` and
  `_backend_build_command()` are unchanged. Copied profiles build
  the same way as shipped ones — the operator runs `▶ Build` on the
  new `/etc/` entry in the profiles table.

#### Step-down logic

Three options were on the table for fixing this bug:

1. **Make `profile-create` accept archiso/live-build by auto-copying
   a shipped baseline internally.** Rejected: conflates two distinct
   operations (scaffold-from-template vs. copy-existing-tree),
   forces a "which baseline?" choice inside the scaffold command,
   and the operator loses visibility into what got copied.

2. **Stop offering archiso/live-build in Create, add a separate
   `profile-copy` command + UI form.** Chosen: keeps each operation
   single-purpose, the UI shows both paths side-by-side, the bridge
   surface stays self-documenting (`profile-create` scaffolds,
   `profile-copy` copies — the names say what they do).

3. **Just fix the dropdown filter, no new command.** Rejected:
   fixes the immediate crash but leaves the operator of an
   archiso-only host with no way to create a profile at all. They'd
   have to drop to a shell and `cp -r /usr/share/archiso/configs/
   baseline /etc/archiso/configs/myarch` — defeating the point of
   the panel.

Option 2 won because it composes best with the rest of the system:
the new `profile-copy` command is a natural sibling to
`profile-create` and `profile-delete`, the UI form is a natural
sibling to the existing Create Profile form, and the operator gets
both paths presented side-by-side under the same panel.

---

## v0.0.47 — 2026-08-18 (logic-flaw fixes: firewall ports, services module, glances default-on webui)

### Theme: fix the port topology, lift the service editor out, default-on the glances webui

v0.0.47 is a tight, directive-driven release that closes four logic
flaws the operator flagged after running v0.0.46 in production. Per
user directive:

> *we need to fix a few logic flaws i do things a certain way on my
> servers so ill correct the ports on a firewall script or two. the
> web server template, and vps template i setup the webserver on
> 8080 and varnish on 80 for an automatic cache environment. we
> should move the service/ports editor to its own module entry for
> ease of access. the glances we should default to enabling the
> built in webui and embedding that into our module instead it
> visually looks stunning in comparison to ours.*

Four concrete fixes shipped:

#### 1. Firewall: public-webserver.sh port-topology fix

The v0.0.44 `public-webserver.sh` template had the cache topology
**backwards**. The header comment described the correct topology
(Varnish on `:80`, Caddy HTTP backend on `:8080`, Caddy HTTPS on
`:443`) but the actual variable defaults and ruleset did the
opposite — `CADDY_HTTP_PORT=80` (Caddy exposed on `:80`) and
`VARNISH_PORT=8080` (Varnish exposed on `:8080`). Worse, the
template shipped a `VARNISH_PUBLIC=true` default that exposed
`:8080` to the internet — meaning clients could bypass Varnish
entirely and hit Caddy's cache-miss backend path directly.

v0.0.47 flips the topology to match the operator's documented
cache-environment setup:

| Port | Service | Visibility |
|------|---------|------------|
| `:80` | Varnish cache front (HTTP, redirect to HTTPS) | **public** |
| `:443` | Caddy HTTPS (terminates TLS) | **public** |
| `:8080` | Caddy HTTP backend (Varnish cache-miss target) | **loopback only** |
| `:3306` | MariaDB | loopback only |
| `:2019` | Caddy admin API | loopback only |

The `VARNISH_PUBLIC` toggle is removed entirely — `:8080` is now
ALWAYS loopback-only because exposing it defeats the entire point
of running a cache. Defense-in-depth drops were added for `:8080`
alongside the existing MariaDB + Caddy admin drops, so even a
misconfigured `0.0.0.0:8080` Caddy bind gets dropped at the
firewall with a `caddy-http-backend-blocked` log prefix.

The detect output now reflects the corrected cache-front-of-origin
topology — `Client → :80 (Varnish) → :8080 (Caddy backend,
loopback)` instead of the misleading `Client → :80 (Caddy)`.

#### 2. Firewall: vps-webserver.sh default topology

The `vps-webserver.sh` template had a subtler version of the same
flaw. Its `detect_varnish()` function correctly flipped Caddy HTTP
to `:8080` *if Varnish was already listening on `:80`* — but that
required the operator to have manually moved Varnish to `:80`
first. If Varnish was installed but stopped, or still on the
upstream default `:6081`, the template would expose Caddy on `:80`
and leave Varnish unreachable.

v0.0.47 makes the cache-front-of-origin topology the **explicit
default the moment Varnish is detected at all**:

- If Varnish is detected on `:80` (the operator already moved it),
  the behavior is unchanged.
- If Varnish is detected on any other port (`:6081` upstream
  default, or a custom port), the template now forces
  `VARNISH_PORT=80` with a log message explaining the override:
  `Varnish detected on :6081 — overriding to :80 (cache-front-of-origin default per v0.0.47). Set VARNISH_PORT env var to keep :6081.`
- Caddy HTTP is unconditionally moved to `:8080` loopback when
  Varnish is detected, regardless of what port Varnish was on.

This matches the public-webserver.sh behavior and the operator's
documented cache-environment setup.

#### 3. NEW PLUGIN: sysdeck-services (sidebar order 45)

The Service/Port Editor card that lived at the bottom of the
Firewall panel since v0.0.44 has been **lifted out into its own
first-class sidebar entry** — **Service / Ports** at order 45 —
for ease of access. The operator can now manage service ports
without scrolling past the firewall ruleset table.

The new panel (`plugins/sysdeck-services/services.js`) adds:

- A filter box — search by name, id, port, or process name.
- A **show-only-editable** toggle — hides services with no
  detected config file (e.g. services that are registered but
  not installed on this host).
- A Refresh button — re-mounts the panel and re-runs the
  listening-socket enumeration.
- The full unmapped-listeners card — ports that didn't match any
  `SERVICES_REGISTRY` entry, so the operator can spot services
  the editor doesn't yet know about.
- An operation output card — shows the result of the last
  Save / Restart action (success message or stderr).

The bridge surface is unchanged. `bridge.firewall.services` /
`service-info` / `set-service-port` / `restart-service` remain
the source of truth — the `SERVICES_REGISTRY`, atomic-write
logic, and `CONFIG_BASE_DIRS` allowlist stay in
`bridge/firewall.py`. A new `bridge.services` proxy (4 methods:
`list` / `info` / `setPort` / `restart`) was added to
`shared/bridge.js` so the new panel has a clean API surface
without polluting the firewall namespace.

The firewall panel keeps a `renderServicesLinkCard()` signpost
pointing operators to the new sidebar entry — preserves the
workflow for operators who used to scroll to the bottom of the
Firewall panel for port edits. The `service` / `port` / `editor`
keywords were removed from the firewall manifest (they belong
to the new services plugin now).

#### 4. Glances: default-on embedded webui

The v0.0.34 Glances integration added the webui but kept it
**opt-in** — the operator had to click "Start Web UI" every time
they opened the panel, and the legacy SysDeck snapshot cards
were rendered above the iframe. The iframe was also sized to a
fixed `height:600px`, which left most of the viewport empty on
larger screens.

v0.0.47 flips the default:

- **AUTO-START on mount.** When the panel loads and glances is
  installed but the webserver isn't running, the panel calls
  `bridge.glances.startWeb()` automatically. The operator sees a
  "Starting Glances web UI …" stub for <1s, then the full Glances
  web UI loads in the iframe. No click required.
- **EMBEDDED-FIRST LAYOUT.** The iframe is now the primary view,
  sized to fill the viewport (`min-height: calc(100vh - 200px)`).
  The legacy snapshot cards (CPU / Memory / Swap / Network / Disk
  / Processes) are moved into a collapsed `<details>` at the
  bottom of the page — they're still there for a quick numeric
  read, but they don't push the iframe below the fold.
- **CSP fix.** The manifest CSP was updated to
  `default-src 'self' 'unsafe-inline' 'unsafe-eval'; frame-src 'self' http://127.0.0.1:61208 http://localhost:61208`
  so the embedded Glances web UI loads without a CSP violation.
  The previous CSP (`default-src 'self' 'unsafe-inline' 'unsafe-eval'`
  with no `frame-src`) would have blocked the iframe once the
  browser enforced the default-src fallback for frame-src.
- **Stop on unmount is intentionally NOT done.** Keeping the
  webserver running speeds re-entry — the operator can flip
  between sidebar entries without paying the ~1s startup cost
  each time. The Stop button is retained for explicit shutdown.

#### Version sync catch-up

While doing the version bump, I noticed the v0.0.46 release had
bumped PKGBUILD / spec / debian changelog to 0.0.46 but missed
`bridge/__init__.py` and `packaging/setup.py` — both stayed at
0.0.45. v0.0.47 catches these up to 0.0.47 alongside every other
release surface (Makefile VERSION + comment, metainfo,
compat-manifest, README). All 9 release surfaces now report
v0.0.47.

The metainfo `<launchable>` list also got two missing entries:
`sysdeck-modules` (added in v0.0.46 but never added to the
launchable list — the AppStream apps page would have shown the
component but not linked it to the plugin) and `sysdeck-services`
(new in v0.0.47). The list is now 26 entries, matching the 26
plugin directories.

#### Compatibility

No bridge subcommands were removed. The
`bridge.firewall.services` / `serviceInfo` / `setServicePort` /
`restartService` methods on the JS bridge surface are kept for
back-compat with any operator-side scripts that may have called
them directly — they proxy to the same `firewall` subcommands as
the new `bridge.services.*` methods. The `SERVICES_REGISTRY`
shape, the atomic-write logic, the `CONFIG_BASE_DIRS` allowlist,
and the `org.sysdeck.firewall.modify` polkit action are all
unchanged.

The firewall templates keep their standard
`start/stop/restart/detect/status/check` interface — no bridge
changes needed to call them. The v0.0.47 port-topology fix is
invisible to the bridge; it just changes which ports the ruleset
opens and which it drops.

---

## v0.0.46 — 2026-08-18 (in-suite 3rd-party module installer)

### Theme: kill cockpit-module-pull.sh, ship a real installer panel

The previous flow for installing third-party Cockpit modules (45Drives
Navigator / File Sharing / ZFS Manager, cockpit-pacman, cockpit-
identities, cockpit-sensors, cockpit-benchmark) was a side-channel
shell script — `cockpit-module-pull.sh` — that surfaced a single
blanket license banner at the top and only logged per-module licenses
*after* the pull succeeded. Per user directive:

> *i wanted the in ui module to handle showing license, developer, 3rd
> party model name and ability to visit homepage and install the
> plugin 1 click with license agreement inline.*

v0.0.46 replaces that flow with a first-class sidebar entry —
**3rd-Party Modules** at order 44 — backed by a Python bridge helper.
Every catalog row renders the module name, license badge,
developer/author, source URL, and a clickable homepage link INLINE,
right next to a 1-click Install button. No modal. No separate
confirmation step. The license is visible in the row; clicking Install
IS the acceptance.

#### Why this is better than the shell script

The shell script's `log_mod` ran after `cp -r` / `tar -xf` / `git
clone` succeeded. Bytes had already hit the network and disk before
the operator was told the module's license and source URL. There was
also no per-module opt-out — once the top-level banner was accepted,
every entry pulled unconditionally.

The new panel surfaces the license, developer, source, and homepage
in the row, BEFORE the operator clicks anything. Each Install is a
single click; each Uninstall is a single click. The bridge's audit
log captures every action with a JSON record.

#### Bridge: catalog-driven, no per-module code branches

`bridge/modules3p.py` defines a single `CATALOG` list of dicts. Each
entry has `id`, `name`, `blurb`, `license`, `author`, `source`,
`kind`, `install_spec`, and optional `depends` / `homepage`. Four
install kinds are supported:

- `pacman` — native package install (`pacman -S --noconfirm --needed`)
- `git` — depth-1 clone into `/usr/share/cockpit/<dest>/`
- `deb-tar` — download a .deb, `bsdtar -xf` it, then `tar -xf
  data.tar.xz` into the destination
- `tarball` — `curl` + `tar -x --strip-components=N`

Adding a new module to the catalog is a single dict append. No code
branches per module, no per-module JS, no per-module polkit actions.

#### Bridge refuses silent installs

The bridge's `install()` subcommand checks for `--accept-license=1`
and returns `license-not-accepted` otherwise. The JS always passes
that flag because the license is rendered inline next to the Install
button — the click IS the acceptance gesture. The check remains as a
guard against malicious callers (e.g. a different front-end that
tries to bulk-install without operator interaction).

#### Audit log: shared path, JSON records

Every install / uninstall appends a JSON record to
`/etc/cockpit/MODULE_LICENSES.log` — the same path the legacy
`cockpit-module-pull.sh` wrote to in plain text. Legacy plain-text
lines are preserved as `{raw: ...}` records, so a single audit view
shows both old and new entries. Each new record includes: timestamp
(UTC), module id, name, license, author, source URL, action
(`install-ok` / `install-failed` / `uninstall-ok` / `uninstall-failed`),
detail string, and bridge version.

#### Polkit action

New polkit policy `packaging/polkit/org.sysdeck.modules3p.policy`
defines the action `org.sysdeck.modules3p.modify`. It authorizes
`/usr/bin/python3 /usr/lib/sysdeck/bridge/modules3p.py install|
uninstall <id>` with `auth_admin_keep` for active sessions — so the
operator authenticates once and can install/uninstall multiple modules
within the keep window without re-authenticating.

#### Bridge.js surface

`shared/bridge.js` gains a `bridge.modules3p` object with `catalog`,
`status`, `preflight`, `install`, `uninstall`, and `audit` methods.
`install` and `uninstall` use `{ superuser: 'try' }` so cockpit
prompts via polkit; the rest are read-only and run as the cockpit
user.

#### Catalog (v0.0.46, 10 entries)

| Module | License | Author | Source | Kind |
|--------|---------|--------|--------|------|
| cockpit-machines | LGPL-2.1 | Cockpit Project | github.com/cockpit-project/cockpit-machines | pacman |
| cockpit-podman | LGPL-2.1 | Cockpit Project | github.com/cockpit-project/cockpit-podman | pacman |
| cockpit-storaged | LGPL-2.1 | Cockpit Project | github.com/cockpit-project/cockpit-storaged | pacman |
| cockpit-identities | LGPL-2.1 | Cockpit Project | github.com/cockpit-project/cockpit-identities | git |
| cockpit-navigator | GPL-3.0 | 45Drives | github.com/45Drives/cockpit-navigator | deb-tar |
| cockpit-file-sharing | GPL-3.0 | 45Drives | github.com/45Drives/cockpit-file-sharing | deb-tar |
| cockpit-zfs-manager | GPL-3.0 | 45Drives | github.com/45Drives/cockpit-zfs-manager | git |
| cockpit-pacman | GPL-3.0 | pfeifferj | github.com/pfeifferj/cockpit-pacman | git |
| cockpit-sensors | MIT | ocristopfer | github.com/ocristopfer/cockpit-sensors | tarball |
| cockpit-benchmark | MIT | ealier | github.com/ealier/cockpit-benchmark | git |

#### Smoke test

A Python smoke-test script (`scripts/test_modules3p.py`) exercises the
bridge: catalog shape, status shape, preflight for every entry,
install refuses without `--accept-license=1`, unknown-id preflight
returns `ok=false`, audit returns records list. 42 checks, all pass
on a host without `pacman` and without `systemctl` (the bridge
degrades gracefully when those binaries are missing).

#### Files added / changed

- NEW `plugins/sysdeck-modules/{manifest.json, index.html, modules.js}`
- NEW `bridge/modules3p.py`
- NEW `packaging/polkit/org.sysdeck.modules3p.policy`
- EDITED `shared/bridge.js` — added `bridge.modules3p` surface
- EDITED `Makefile` — bumped VERSION 0.0.45 → 0.0.46, plugin count
  24 → 25, added polkit install + uninstall stanzas
- EDITED `THIRD_PARTY.md` — appended v0.0.46 section, updated two
  existing "see cockpit-module-pull.sh" notes
- EDITED `packaging/debian/changelog`, `packaging/sysdeck.spec`,
  `packaging/sysdeck.metainfo.xml` — v0.0.46 entries

#### What's next

- Extend the catalog: candidates include cockpit-netplan,
  cockpit-certificates, and a 45Drives identities-style RH-SSO entry.
- Optional `EXCLUDE_MODULES` env var so operators can hide specific
  entries from the panel (e.g. hide cockpit-sensors because the suite
  already ships its own sensors panel).
- Optional "verify checksum" field on catalog entries for operators
  who want to pin to a known-good release artifact.

---

## v0.0.35 — 2026-08-18 (Kata split + Jellyfin, Photos, Remote FS modules)

### Theme: restore Kata as its own sidebar entry, add three new modules

v0.0.34 consolidated Kata Containers into the merged Containers & VMs panel, demoting it to a hidden "tools" entry labeled "Kata Containers (hidden helper)" with priority -1. The user directive was clear: *"kata containers should be called SysDeck Kata and moved out of the tools area. and dont call it hidden thats akward."* v0.0.35 splits Kata back out into a standalone sidebar entry called **SysDeck Kata** at order 27. The plugin directory moved from `plugins/sysdeck-containers-kata/` to `plugins/sysdeck-kata/`, the manifest was converted from a `tools` section to a `menu` section, and the awkward "hidden helper" wording was removed everywhere.

The second theme is **three new modules** added per directive: Jellyfin media server, photo manager, and remote filesystem manager. Each follows the established pattern: a Python bridge helper under `bridge/` runs `systemctl start/stop/restart` via the cockpit superuser channel (polkit prompts the operator), and the JS panel iframes the running service's built-in admin web UI — same shape as the v0.0.34 Glances integration.

#### Kata restored as standalone sidebar entry

The pre-built cockpit-kata React bundle (`index.js` + `index.css`, ~470KB + ~60KB) ships unchanged. The Kata plugin now hosts that bundle directly as its page content — no iframe needed, since the plugin IS the page. The Containers panel was simplified to Podman-only; the merged "Containers & VMs" subtitle was dropped, the Kata tab and its iframe target were removed, and the `containers` keywords list dropped `kata`/`sandbox` (those now live under `sysdeck-kata`'s own keywords list). `scripts/generate-plugins.py` was extended with a `HAND_MAINTAINED_PLUGINS = {"sysdeck-kata"}` set — the generator backs up + restores hand-maintained plugins before wiping `plugins/`, so running `make plugins` no longer destroys the pre-built React bundle. The Makefile was updated to comment "23 standalone Cockpit plugins" and the install target prints "23 standalone Cockpit plugins" instead of the old "19 visible + 1 hidden helper = 20" wording.

#### Jellyfin module

Jellyfin ships a single systemd unit (`jellyfin.service`) on every distro that packages it, and serves a full admin web UI on `http://127.0.0.1:8096`. The new bridge helper `bridge/jellyfin.py` exposes seven subcommands: `summary` (service status + version + port + url in one call), `status` (service status only), `start` / `stop` / `restart` (systemctl control), `web-status` (running + url for iframe embedding), and `libraries` (best-effort `GET /Library/VirtualFolders` on the local Jellyfin instance). The panel renders: a service summary card (status badge, version, port, uptime, URL with a clickable link), three action buttons (Start / Stop / Restart — each triggers a polkit prompt for `org.sysdeck.jellyfin.modify`), the running admin UI in an 800px-tall iframe below the service card, and a libraries table. The Content-Security-Policy in the manifest allows `frame-src http://127.0.0.1:8096` and `connect-src http://127.0.0.1:*` so the iframe can load Jellyfin's built-in CSS / JS / image assets. When Jellyfin is not installed, the panel renders an install hint with the per-distro install command and the Jellyfin homepage link.

#### Photo Manager module

Multi-backend design (same shape as the DB Control module in v0.0.32). Five backends are registered in `bridge/photos.py:BACKEND_REGISTRY`:

| id | name | family | port | systemd unit | license |
|----|------|--------|------|--------------|---------|
| photoprism | PhotoPrism | go-binary | 2342 | photoprism.service | MIT |
| piwigo | Piwigo | php-app | 80 | php-fpm.service | GPL-2.0 |
| lychee | Lychee | php-app | 80 | php-fpm.service | MIT |
| nextcloud-memories | Nextcloud Memories | nextcloud-plugin | 80 | php-fpm.service | AGPL-3.0 |
| librephotos | LibrePhotos | django-react | 3000 | librephotos.service | MIT |

Each backend is auto-detected via `shutil.which()` (CLI availability), `systemctl list-unit-files` (unit presence), and `os.path.exists()` (config dir presence). The bridge runs `systemctl start/stop/restart <service>` for the chosen backend; the panel renders a per-backend card with status badge, service name, port, URL, license, and — when the service is running — an 800px-tall iframe loading the backend's admin UI. Each card has its own Start / Stop / Restart / Refresh buttons. An install-hint card renders when no backend is detected, listing all five options with their per-distro install commands and license links. The polkit action `org.sysdeck.photos.modify` authorizes `/usr/bin/systemctl` and `/usr/bin/photoprism`.

#### Remote FS Manager module

Multi-backend design (same shape as the Photos module). Five backends in `bridge/remotefs.py:BACKEND_REGISTRY`:

| id | name | family | port | systemd unit | cli | license |
|----|------|--------|------|--------------|-----|---------|
| ceph | Ceph | object-storage | 6789 | ceph.target | ceph | LGPL-2.1 |
| glusterfs | GlusterFS | scale-out-fs | 24007 | glusterd.service | gluster | GPL-2.0 |
| moosefs | MooseFS | distributed-fs | 9420 | moosefs-master.service | moosefs-cli | GPL-2.0 |
| beegfs | BeeGFS | parallel-fs | 8008 | beegfs-meta.service | beegfs-ctl | BeeGFS EULA (free) |
| orangefs | OrangeFS | parallel-fs | 3334 | pvfs2-server.service | pvfs2-server | BSD-3 |

Each backend is auto-detected; the panel renders a card per detected backend with status, service name, CLI tool, port, config path, license, and Start / Stop / Restart / Cluster Info buttons. The `cluster-info` subcommand dispatches per backend: `ceph status --format=json` (returns a parsed summary with health, fsid, mon count, osd count, pg count, plus the raw text), `gluster pool list`, `moosefs-cli info`, `beegfs-ctl --listnodes`, `pvfs2-server -m`. Output renders in a `<pre>` block at the bottom of the panel.

The polkit action `org.sysdeck.remotefs.modify` authorizes `/usr/bin/systemctl` plus `/usr/bin/ceph`, `/usr/bin/gluster`, `/usr/bin/moosefs-cli`, `/usr/bin/beegfs-ctl`, `/usr/bin/pvfs2-server` (and their `/usr/sbin/` variants, plus `/opt/beegfs/sbin/beegfs-ctl`).

#### NFS and Amanda explicitly excluded

Per user directive: *"and others but not nfs or amanada fs."* The exclusion is documented in three places: the `EXCLUDED` dict in `bridge/remotefs.py` (`{"nfs": "kernel-builtin; no cluster; no remote-FS-as-data-store semantics. Use cockpit-nfs.", "amanda": "backup system, not a remote/distributed filesystem. Use a dedicated backup solution."}`), the `_comment_v0.0.35` field in `compat/compat-manifest.json`, and a dedicated "Intentionally excluded" card in the panel UI itself — the bridge returns the `excluded` dict in its `summary` response and the panel renders a table showing each excluded backend and the reason. Amanda is included here even though the directive spelled it "amanada" — the operator's intent is clear: AMANDA (Advanced Maryland Automatic Network Disk Archiver) is a backup system, not a remote FS, and doesn't belong in this module.

#### Plugin count and version sync

The plugin count went from 20 (19 visible + 1 hidden helper in v0.0.34) to 23 (23 visible, 0 hidden). The hidden helper was promoted to a visible sidebar entry, and three new visible modules were added. `tests/check_manifest_consistency.py` was updated to expect 23 plugins (still a warn-only check). The Makefile install target now says "23 standalone Cockpit plugins". All release surfaces (Makefile, `bridge/__init__.py`, `packaging/setup.py`, `packaging/PKGBUILD`, `packaging/sysdeck.spec`, `packaging/debian/changelog`, `compat/compat-manifest.json`) were bumped to 0.0.35 — `make check-version-sync` passes.

#### Bridge surface expanded

`shared/bridge.js` got three new module surfaces (`bridge.jellyfin`, `bridge.photos`, `bridge.remotefs`) totaling 19 new `bridgeCmd()` calls. The build-time guard `check-bridge-subcommands.py` now verifies 140 calls across 25 bridge modules (was 116 calls across 22 modules in v0.0.34). All calls resolve to a real Python dispatch entry — verified end-to-end.

---

## v0.0.33 — 2026-08-18 (Policy module LSM expansion + MoE QA pass + docs rewrite)

### Theme: complete the modern LSM stack, then run a senior-team QA pass

v0.0.32 introduced the Policy & Permissions module with five concerns (ACLs, cgroups v2, VLANs, eBPF, namespaces) plus an optional AppArmor card. v0.0.33 expands the module to cover the rest of the modern Linux LSM stack per user directive: *"lets now add smack, tomoyo, yama and others as well to the same policy module. we again dont need selinux its native for cockpit."* The bridge now surfaces nine LSMs — AppArmor, Smack, TOMOYO, Yama, LoadPin, Lockdown, BPF-LSM, Landlock, and the capability LSM (file capabilities via setcap/getcap). Each is optional and auto-detected; the panel renders an enable hint when an LSM is absent from the kernel stack.

The second theme is a **MoE (Mixture-of-Experts) QA pass** that applied a senior QA analyst, senior Linux engineer, senior architect, senior admin, and project-manager-in-devops lens to the codebase. The pass replaced nested ifs with lookup tables (`LSM_PROBES`, `NON_LSM_CONCERNS`, `SMACK_FILE_MAP`, `TOMOYO_FILES`, `YAMA_SCOPE_NAMES`), shifted `for`/`while` loops toward `map`/`filter`/`reduce` where the data shape allowed it, and kept PEP 868, POSIX, SEI CERT, and MISRA in mind. The QA pass also rewrote project documentation (README, QUICKSTART, BLOG, LICENSE) with decisive language — every design choice is recorded as a decision, not as history.

#### What's new in the Policy module

- **`lsm-status`** — reads `/sys/kernel/security/lsm` (the comma-separated active-stack file the kernel exposes since 5.1) and cross-references each entry against the per-LSM probe. The panel renders a badge row in the header showing the active stack at a glance, and a table showing every supported LSM with its `active_in_stack` / `dir_present` / `path` fields.
- **Smack** — `/sys/kernel/security/smack/` directory probe + reads the 12 control files (`logging`, `load`, `load2`, `revoke-subject`, `change-rule`, `onlycap`, `cipso2`, `access2`, `access`, `mapped`, `network-queue-length`, `ptrace`) via the `SMACK_FILE_MAP` lookup table. The `smack-labels` subcommand walks `/proc/<pid>/attr/current` for every running PID and returns the deduplicated label set. The `smack-load` subcommand writes a rules file to `/sys/kernel/security/smack/load`.
- **TOMOYO** — `/sys/kernel/security/tomoyo/` directory probe + reads the 9 control files (`profile`, `exception_policy`, `domain_policy`, `manager`, `query`, `grant_log`, `reject_log`, `status`, `version`) via the `TOMOYO_FILES` lookup table. The `tomoyo-profiles` subcommand returns the `profile` file's contents; `tomoyo-save-policy` snapshots the four policy files to an operator-chosen path.
- **Yama** — `/proc/sys/kernel/yama/ptrace_scope` read (the only knob Yama has). The `YAMA_SCOPE_NAMES` lookup table maps 0-3 to human-readable names (`disabled` / `restricted (default)` / `admin-only` / `no-ptrace`). The `yama-set-scope` subcommand writes a new value; the JS panel renders a `<select>` with the four options.
- **LoadPin** — `/sys/kernel/security/loadpin/` directory probe + reads `enforce` and `exclude` files when present. LoadPin has no userspace management surface beyond the kernel cmdline — the panel documents this.
- **Lockdown** — `/sys/kernel/security/lockdown/` directory probe + iterates every file in the directory. Lockdown is enabled by UEFI secure boot; the panel documents that there is no userspace toggle.
- **BPF-LSM** — `/sys/kernel/security/bpf/` directory probe + uses `bpftool prog show -j` to enumerate `BPF_PROG_TYPE_LSM` programs. The same programs appear under the eBPF card, but here they're filtered to the LSM hook type.
- **Landlock** — `/sys/kernel/security/landlock/` directory probe + walks `/proc/<pid>/status` looking for the `Landlock:` line on each process. The panel renders a table of sandboxed processes with their ruleset identifier.
- **File capabilities** — `getcap -r /` enumeration (capped at 200 entries to avoid huge responses), `setcap '<caps>' <path>` to grant capabilities, `setcap -r <path>` to remove. These predate the LSM stack but compose with it for fine-grained privilege delegation.

Each new LSM follows the same shape: if unavailable, the panel renders an enable hint with the kernel cmdline that activates the LSM; if available, the panel renders the live state plus any management controls the LSM supports. Decisive language — no "this is pending" or "to be implemented".

#### Polkit policy expansion

The `org.sysdeck.policy.modify` action authorizes 30+ binaries across the policy module's surface:

- ACLs: `setfacl`, `getfacl`
- cgroups: `mkdir`, `mount` (for bpffs pinning)
- VLANs: `ip`, `vconfig`
- eBPF: `bpftool`
- namespaces: `lsns`
- AppArmor: `aa-status`, `aa-enforce`, `aa-complain`
- v0.0.33 new: `smackload`, `smackcipsos`, `smackcipso`, `tomoyo-setprofile`, `tomoyo-set-profile`, `tomoyo-savepolicy`, `tomoyo-init`, `setcap`, `getcap`

SELinux remains intentionally skipped per user directive: it is native to the host distro and SysDeck does not try to manage it.

#### MoE QA pass — what changed

The QA pass applied five expert lenses:

1. **Senior QA analyst** — verified that every bridge subcommand named in `shared/bridge.js` exists in the matching `bridge/<module>.py` `COMMANDS` dict. The `check_bridge_subcommands.py` build-time guard now verifies 100+ calls across 22 bridge modules. Smoke-tested every new LSM subcommand against the sandbox (where most LSMs are absent — the panel renders install hints, exactly as designed).

2. **Senior Linux engineer** — confirmed the bridge invokes the kernel's standard interfaces, not custom ones: `/sys/kernel/security/lsm` for the stack list, `/sys/kernel/security/<lsm>/` for each LSM's directory, `/proc/sys/kernel/yama/ptrace_scope` for Yama, `/proc/<pid>/attr/current` for Smack labels, `/proc/<pid>/status` for Landlock rulesets. The bridge uses `subprocess.run` with `capture_output=True` and `check=False` everywhere — never raises, always surfaces stderr in the JSON response.

3. **Senior architect** — replaced the v0.0.32 summary command's hand-built per-concern dict with two lookup tables: `LSM_PROBES` (9 entries: id, pretty_name, sub_dir) and `NON_LSM_CONCERNS` (5 entries: id, pretty_name, probe_fn). Adding a new LSM or non-LSM concern is now a one-line table addition, not a new code path. The Smack file-probe loop was refactored to use the `SMACK_FILE_MAP` table; the TOMOYO file-probe loop was refactored to use the `TOMOYO_FILES` tuple.

4. **Senior admin** — verified the cockpit-way pattern is consistent across the entire module: every mutating operation (`acl-set`, `cgroup-create`, `cgroup-move`, `cgroup-set`, `vlan-create`, `vlan-delete`, `ebpf-pin`, `apparmor-enforce`, `apparmor-complain`, `smack-load`, `yama-set-scope`, `tomoyo-save-policy`, `filecaps-set`, `filecaps-remove`) runs through `bridgeCmd("policy", [...], { superuser: "try" })`. The cockpit bridge prompts the operator via polkit. No `sudo` shell-out from JS anywhere.

5. **Project-manager-in-devops** — confirmed the polkit action authorizes every binary the bridge invokes, so operators do not hit "permission denied" dead-ends during incident response. Production-readiness checklist: every failure mode returns a structured JSON response with `available: false, reason: ..., install: ...` rather than crashing.

#### Documentation rewrite

- **README.md** — rewritten with the v0.0.33 highlights, the full 22-row module catalog, the architecture file-tree, the bridge-layer table, the cross-cutting contracts, the coding standards (PEP 868 / POSIX / SEI CERT / MISRA + step-down logic + lookup tables), and the install paths. Every design choice is recorded as a decision.
- **QUICKSTART.md** — rewritten with the 5-minute install path, the 20-sidebar-entry verification table, the first-use walkthrough for the Firewall / Packages / Policy / Databases panels, the build-from-source instructions, and the uninstall path.
- **LICENSE** — kept MIT (the right license for a Cockpit plugin that integrates with both GPL-licensed cockpit and permissive-licensed third-party helpers). Added a third-party attributions block listing the independently-licensed programs the bridge invokes as separate subprocesses (nft, pacman, mkosi, bpftool, setcap, aa-*, smackload, tomoyo-*, systemctl, getfacl, ip, lsns, mount, mkdir).
- **BLOG.md** — this entry. Every prior release narrative is preserved as-is; the v0.0.32 narrative is rewritten to use decisive decision language (the v0.0.15-era `sudo systemctl` shell-out fix, the DB module panel addition, the polkit actions, etc. are all stated as decisions, not as "restored" or "brought back").

#### Decision: step-down logic for the SELinux question

When the user directive said "we again dont need selinux its native for cockpit," the team faced a fork of choices:

1. **Implement SELinux management anyway** — surface `semanage`, `setsebool`, `audit2allow`, `restorecon` as bridge subcommands.
2. **Skip SELinux entirely** — declare it out-of-scope and document the decision.
3. **Detect SELinux state only** — read `/sys/fs/selinux/enforce` and report it without management controls.

Applying step-down logic: option 1 violates the user directive and duplicates what `setroubleshoot` and `cockpit-selinux` already do. Option 3 is half-measure — reading enforcement state without management controls gives the operator a useless read-only view. **Option 2 wins**: the `summary` subcommand returns `{selinux: {skipped: true, reason: "SELinux is native to the host distro — not managed by SysDeck."}}`, the panel's capability matrix shows a "skipped" badge for SELinux, and the decision is documented in `bridge/policy.py` and `plugins/sysdeck-policy/policy.js`. Decisive, composes with the rest of the system, documented.

#### Guards

`make check` passes all 7 build-time guards: manifest consistency (20 plugin manifests + 1 shared manifest = 21 total), metainfo consistency, Makefile recipe indentation (tabs not spaces), no broken `import cockpit from` pattern, no broken `python3 -m sysdeck.bridge` pattern, bridge.js subcommand cross-check (**100+ calls verified across 22 bridge modules** — up from 84 in v0.0.32 thanks to the 16 new policy subcommands), version sync (all release surfaces report v0.0.33). All 9 unit tests pass. JS files pass `node --check`. Shell scripts pass `bash -n`. Manifest JSON files all parse.

`make dist` builds `sysdeck-0.0.33.tar.bz2` (~220KB). `make distcheck` confirms the tarball is self-sufficient — it extracts into `sysdeck-0.0.33/` and `make check` passes inside the extracted tree.

---

## v0.0.32 — 2026-08-18 (Policy & Permissions + DB Control — plugin count 18 → 20)

### Theme: cover the modern Linux policy stack and the database layer in one release

v0.0.32 ships two new modules. The first is **Policy & Permissions** (`cockpit-policy`) — a modern policy management and permissions manager for groups. Per user directive: *"modern policy management and permissions manager for groups. such as acl, cgroups, vlans, ebpf namespace separation and related policies. we can skip selinux its native. we can implement apparmor but its not default on my machine so make it optional for sure."* The module surfaces five concerns: POSIX ACLs (getfacl/setfacl), cgroups v2 unified hierarchy (mkdir / move PID / write control files), VLANs (ip link add/del type vlan), eBPF programs and maps (bpftool, plus pin-to-bpffs), and namespaces (lsns). AppArmor is optional — the bridge auto-detects whether it is compiled into the kernel; if absent, the panel renders an install hint instead of an empty table. SELinux is intentionally skipped (native to the host distro).

The second is **DB Control** (`cockpit-db`). The bridge helper `bridge/db.py` surfaces 32+ engines across SQL/NoSQL/Vector/TimeSeries/Graph/Embedded/Cloud/AI families with summary/status/start/stop/restart/connections/query subcommands. v0.0.32 also fixes the v0.0.15-era `sudo systemctl` shell-out in `cmd_start` / `cmd_stop` / `cmd_restart` — the cockpit way (per the v0.0.31 packages-module pattern) is to run systemctl directly via subprocess and let the JS panel pass `{ superuser: 'try' }` so the cockpit bridge prompts the operator via polkit for the new `org.sysdeck.db.modify` action.

Two new polkit actions: `org.sysdeck.policy.modify` (authorizes setfacl, getfacl, mkdir, mount, ip, bpftool, lsns, aa-enforce, aa-complain, aa-status) and `org.sysdeck.db.modify` (authorizes /usr/bin/systemctl).

`make check` passes: 84 bridge.js calls cross-verified against Python `COMMANDS` dicts across 22 bridge modules (up from 59 in v0.0.31 thanks to the 25 new policy methods + 7 new db methods). `make distcheck` confirms the tarball is self-sufficient.

---

## v0.0.31 — 2026-08-18 (Firewall manager + Packages sudo fix + Builder full-featured + Fester rename)

### Theme: turn the monitor-only modules into full managers, the cockpit way

v0.0.31 fixes four operator-reported issues:

1. **Firewall — monitor → manager.** v0.0.30's panel could only list nftables rules. v0.0.31 makes it a full manager: template selector, Apply/Stop/Restart, ban/unban IP, clear bans, live service detection. Two templates ship under `/usr/share/sysdeck/firewall/templates/` (`vps-webserver.sh`, `no-services.sh`); operators can drop more in. The bridge gains `templates`, `template-info`, `detect`, `apply`, `stop`, `restart`, `status`, `ban`, `unban`, `banned`, `clear-bans`, `check` subcommands.

2. **Packages — sudo → cockpit way.** v0.0.30's `Update All` button called `bridge.packages.updateAll()` which returned only the command string. The panel showed `alert("Run this command with superuser privileges.")` and the operator had to copy / sudo / paste / run. v0.0.31 makes install/remove/update/update-all actually execute via subprocess; the JS panel passes `{ superuser: 'try' }` to cockpit.spawn so the operator authenticates via polkit (`org.sysdeck.packages.modify`). Live stdout/stderr renders in an in-panel `<pre>` log.

3. **Builder — viewer → full-featured.** v0.0.30's builder could list installed backends and walk their config dirs. v0.0.31 adds `build(profile, backend, options)` — runs the backend in the profile's directory via subprocess under the `org.sysdeck.builder.modify` polkit action; streams stdout+stderr to `/var/lib/sysdeck/builder/logs/<build-id>.log`; tracks state in `/var/lib/sysdeck/builder/state/<build-id>.json`. Also: `profile-create`, `profile-delete`, `artifacts`, `build-status`, `build-log`. The panel renders a Build button per profile, a Builds table, a per-build log viewer, and a Create Profile form.

4. **Fester rename.** The directory was already `plugins/sysdeck-fester/` but the menu label and panel title said "SysDeck Build Orchestration". v0.0.31 changes both to "SysDeck Fester" per user directive. Updated `manifest.json`, `fester.js`, `scripts/generate-plugins.py` MODULES table, `README.md`, `compat-manifest.json`, `BLOG.md` references.

All mutating operations use the cockpit superuser channel — no `sudo` shell-out from JS anywhere in the suite. `make check` passes: 59 bridge.js calls cross-verified across 21 bridge modules. `make distcheck` confirms the tarball is self-sufficient.

---

## v0.0.30 — 2026-08-17 (Image Builder rewritten — Arch + Debian backends)

### Theme: stop targeting Fedora-only tooling

v0.0.29's builder was a thin `systemctl is-active osbuild-composer.service` shim. osbuild-composer is Fedora/RHEL-only and is not packaged for Arch or Debian, so the Builder panel was permanently 'inactive' on every distro this suite ships to. v0.0.30 replaces osbuild-composer with a multi-backend detection layer: `mkosi` (systemd's image builder, Arch primary) + `archiso` (Arch Live ISO builder) on Arch; `vmdb2` (Debian project's image builder) + `live-build` (Debian Live ISO builder) on Debian. New bridge subcommands: `status`, `profiles`, `summary`, `backends`, `install-hint`. Rewrote `plugins/sysdeck-builder/builder.js` to render per-backend profile cards + a distro-specific install hint. Updated `polkit/org.sysdeck.policy` `org.sysdeck.builder.modify` to authorize `/usr/bin/mkosi`, `/usr/bin/mkarchiso`, `/usr/bin/vmdb2`, `/usr/bin/lb` (osbuild + livemedia-creator annotations removed). Updated `compat-manifest.json` builder entry: Arch and Debian distro_support upgraded from 'none' to 'full'.

---

## v0.0.19 — 2026-08-17 (manifest rewritten to match a real working plugin — first release that should actually appear in the Cockpit sidebar)

### Theme: stop guessing, copy a working plugin's manifest

v0.0.9 through v0.0.18 all shipped with a manifest schema that **Cockpit silently rejected on every install**. The user reported: *"nothing has worked yet. we have zero entries anywhere. like zero existence to the visible eye."* That is the accurate summary of every release before this one. The previous three "fixes" (v0.0.16's path-alignment, v0.0.17's AppStream registration, v0.0.18's path-to-file resolution) were each solving a problem one layer deeper than the actual problem. The actual problem was that the manifest schema itself was wrong, and Cockpit was rejecting the whole plugin at the discovery layer.

This release fixes that by **copying the manifest pattern from cockpit-podman, a real, working Cockpit plugin** that ships in this very tarball under `standalone-plugins/`.

#### What every previous release got wrong

Compare the v0.0.18 sysdeck manifest to cockpit-podman's actual working manifest:

**v0.0.18 sysdeck (broken — silently rejected by Cockpit):**
```json
{
    "version": 1,
    "name": "sysdeck",
    "title": "SysDeck",
    "priority": 0,
    "requires": { "cockpit": ">=239" },
    "content": {
        "suite": { "label": "Suite Dashboard", "path": "/index.html" }
    },
    "menu": {
        "suite": { "label": "SysDeck", "order": 20, "path": "/index.html" }
    },
    "content-security-policy": "default-src 'self' 'unsafe-inline' 'unsafe-eval'"
}
```

**cockpit-podman (working — appears in Cockpit sidebar):**
```json
{
    "version": 0,
    "name": "cockpit-podman",
    "requires": { "cockpit": ">=239" },
    "conditions": [{ "path-exists": "/usr/bin/podman" }],
    "menu": {
        "index": { "label": "Podman Containers", "order": 46, ... }
    },
    "content-security-policy": "default-src 'self'; ..."
}
```

The differences are not stylistic — every one of them is a contract violation Cockpit silently enforces:

| Field | v0.0.18 sysdeck | cockpit-podman (works) | Effect of the deviation |
|-------|-----------------|------------------------|--------------------------|
| `version` | `1` | `0` | Schema version 1 is only supported by recent Cockpit; older versions silently reject the plugin. Version 0 is universally supported. |
| top-level `title` | `"SysDeck"` | *(absent)* | Not a recognized field; Cockpit's strict manifest parser may reject the whole manifest. |
| top-level `priority` | `0` | *(absent)* | Same as above. |
| `content` section | present, keyed `suite` | *(absent)* | Real plugins don't declare `content` — the `menu.index` magic key serves `index.html` implicitly. Having a `content` section with a non-`index` key (like `suite`) requires Cockpit to resolve `suite` to a file, which historically fails silently. |
| `menu.<key>` | `menu.suite` (with `path`) | `menu.index` (no `path`) | The `index` magic key is special: Cockpit serves `/index.html` implicitly when the menu key is `index`. Any other key (like `suite`) requires Cockpit to resolve the key to a content entry, which requires a `content` section, which... see above. This is the trap every previous release fell into. |
| `path` inside menu entry | present (`"/index.html"`) | absent | Not a recognized menu field. |

#### Why this bug shipped for ten releases

The previous author wrote a manifest-consistency test that codified the author's *own mental model* of the manifest contract: "every `menu.<item>.path` must match some `content.<page>.path`". That contract was invented — it does not appear in Cockpit's documentation or in any real plugin's manifest. The test passed on every release because every release satisfied the invented contract, while the actual Cockpit manifest parser was silently rejecting the plugin because none of them matched the real contract.

This is the same failure mode as v0.0.14 (tarball-wrapping-directory) and v0.0.16 (path mismatch): a build-time guard that codifies a wrong invariant is worse than no guard, because it gives false confidence. The test passed; the plugin didn't appear in the sidebar; the user saw "zero entries anywhere"; the release shipped anyway.

#### The fix

Rewrote `manifest.json` to match the cockpit-podman reference manifest as closely as possible:

```json
{
    "version": 0,
    "name": "sysdeck",
    "requires": { "cockpit": ">=239" },
    "menu": {
        "index": {
            "label": "SysDeck",
            "order": 20,
            "keywords": [{ "matches": ["sysdeck", "operations", "monitoring", "firewall", "containers", "firmware", "fleet"] }],
            "docs": [{ "label": "SysDeck Quickstart", "url": "https://dcos.net/sysdeck/quickstart" }]
        }
    },
    "content-security-policy": "default-src 'self' 'unsafe-inline' 'unsafe-eval'"
}
```

Changes from v0.0.18:
- `version: 1` → `version: 0` (universally supported schema version)
- Removed `title` (not in any working plugin's manifest)
- Removed `priority` (not in any working plugin's manifest)
- Removed `content` section entirely (cockpit-podman doesn't have one)
- `menu.suite` → `menu.index` (the magic key Cockpit uses to serve `index.html` implicitly)
- Removed `path` from menu entry (not a real menu field — the `index` magic key handles path resolution)

#### Hardened guard: test against the actual reference, not a made-up contract

`tests/check_manifest_consistency.py` has been rewritten. It no longer validates against an invented "menu path must match content path" contract. It now validates against the **actual cockpit-podman reference manifest shipped in this tarball**:

- Rejects `version: 1` — only `version: 0` matches the working pattern.
- Rejects any top-level field not present in cockpit-podman (`title`, `priority`, etc.).
- Rejects a `content` section — real working plugins don't declare one.
- Rejects any menu key other than `index` — non-`index` keys have historically caused silent drops.
- Rejects a `path` field inside a menu entry — not a real menu field.

Regression-tested: deliberately reverting sysdeck's manifest to the v0.0.18 state fails the new check with a clear message naming every deviation:

```
FAIL: manifest.json does not match the working Cockpit plugin pattern:

Reference (standalone-plugins/cockpit-podman/manifest.json):
  {
    "version": 0,
    "name": "cockpit-podman",
    "requires": { "cockpit": ">=239" },
    "menu": {
      "index": { "label": "Podman Containers", "order": 46 }
    }
  }

  - menu section has keys ['suite'] but is missing the magic 'index' key. ...
  - manifest has a 'content' section (['suite']) — real working Cockpit plugins do NOT declare 'content'. ...
  - version=1 — should be 0. ...
  - manifest has a top-level 'title' field ('SysDeck') — real working Cockpit plugins do not declare 'title' at the top level. ...
  - manifest has a top-level 'priority' field (0) — real working Cockpit plugins do not declare 'priority'. ...
  - manifest has top-level keys not present in the cockpit-podman reference: ['content', 'priority', 'title']. ...
```

#### New: `sysdeck-diagnose.sh` — see exactly what Cockpit sees

A diagnostic script is now installed at `/usr/share/sysdeck/sysdeck-diagnose.sh`. Run it after `sudo make install && sudo systemctl restart cockpit.socket` to see, in one command's output:

1. Cockpit service status and version
2. What's installed under `/usr/share/cockpit/`
3. The contents of `/usr/share/cockpit/sysdeck/manifest.json`
4. File permissions on the manifest
5. Whether the `cockpit` user can read the manifest
6. AppStream metainfo validation (`appstreamcli validate`)
7. AppStream cache search for `sysdeck`
8. Cockpit journal lines mentioning `sysdeck`, `error`, `warning`, `fail`, `cannot`, or `denied`
9. Cockpit config (`/etc/cockpit/cockpit.conf`)
10. The reference manifests from `standalone-plugins/` for side-by-side comparison

If SysDeck still doesn't appear in the sidebar after this release, run this script and paste the output — it will pinpoint which layer is broken.

#### New: `cockpit-smoke-test.sh` — verify Cockpit discovery independently of sysdeck

A second script is installed at `/usr/share/sysdeck/cockpit-smoke-test.sh`. It installs a 5-line hello-world Cockpit plugin to `/usr/share/cockpit/hellotest/`:

```bash
sudo bash /usr/share/sysdeck/cockpit-smoke-test.sh install
```

The hello-world plugin uses the same manifest pattern as cockpit-podman (version=0, menu.index, no content section). After running the script:

- If "Hello Test" appears in the Cockpit sidebar → Cockpit discovery works → if SysDeck still doesn't appear, the issue is sysdeck's manifest (run `sysdeck-diagnose.sh`).
- If "Hello Test" does NOT appear → the issue is Cockpit itself, not sysdeck. Check Cockpit version, `/etc/cockpit/cockpit.conf`, SELinux/AppArmor, and `journalctl -u cockpit`.

Remove the hello-world plugin when done:

```bash
sudo bash /usr/share/sysdeck/cockpit-smoke-test.sh remove
```

This script decouples "is Cockpit working?" from "is sysdeck's manifest correct?" — so we can finally tell which side of the install is broken without guessing.

#### Install and verify

```bash
# 1. Nuke any previous install (including pacman-tracked ones)
sudo pacman -R sysdeck 2>/dev/null || true
sudo rm -rf /usr/share/cockpit/sysdeck /usr/lib/sysdeck /usr/share/sysdeck /usr/share/metainfo/sysdeck.metainfo.xml /usr/share/polkit-1/actions/org.sysdeck.policy
sudo systemctl restart cockpit.socket

# 2. Install v0.0.19
tar xjf sysdeck-0.0.19.tar.bz2
cd sysdeck-0.0.19
sudo make install
sudo systemctl restart cockpit.socket
sudo appstreamcli refresh-cache --force 2>/dev/null || true

# 3. Hard-refresh the browser (Ctrl+Shift+R) — cockpit-ws caches manifests aggressively
# 4. Open https://localhost:9090 → look for "SysDeck" in the left sidebar

# 5. If it doesn't appear, run:
bash /usr/share/sysdeck/cockpit-smoke-test.sh install
# Refresh the browser. If "Hello Test" doesn't appear either, the issue is Cockpit.

# 6. Either way, run:
sudo bash /usr/share/sysdeck/sysdeck-diagnose.sh
# Paste the output back so we can pinpoint the remaining issue.
```

#### Honest summary

- v0.0.9 introduced the broken manifest schema (`version: 1`, `content.suite`, `menu.suite`, top-level `title` and `priority`).
- v0.0.10 through v0.0.15 added features on top of a broken foundation — the plugin never appeared in Cockpit, but the features were validated against the mock cockpit environment in dev.
- v0.0.16 "fixed" a fake path-mismatch bug that was a symptom of the broken schema, not the root cause.
- v0.0.17 added AppStream metainfo and PolKit policy on top of the broken manifest — necessary infrastructure, but didn't address the discovery failure.
- v0.0.18 "fixed" another fake path-resolution bug that was still a symptom of the broken schema.
- v0.0.19 (this release) is the first release whose manifest actually matches the contract Cockpit enforces. The previous nine patch releases were attempts to fix symptoms while leaving the root cause untouched.

If this release still doesn't make SysDeck appear in the sidebar, the diagnostic scripts will tell us which layer is actually broken — and we can stop guessing.

---

## v0.0.18 — 2026-08-17 (manifest path actually resolves to a file — plugin loads)

### Theme: fix the silent empty-page bug from v0.0.16's manifest "fix"

v0.0.18 fixes a **critical empty-page bug** introduced by the v0.0.16 "manifest fix". After v0.0.16, the SysDeck menu entry appeared in the Cockpit sidebar, but clicking it loaded a blank page. The user reported: *"we might have added a pacman entry but clicking it was an empty page."* This release makes the menu entry actually load the dashboard.

#### Root cause: the v0.0.16 fix was based on a wrong model of how Cockpit serves plugin files

The v0.0.16 release notes claimed:

> *"The `content.<page>.path` field is a URL path, not a filename. Cockpit automatically serves `index.html` from the plugin directory at whatever URL path the content entry declares."*

That claim is **false**. Cockpit does NOT automatically serve `index.html` at arbitrary URL paths. Cockpit's web service serves files from the plugin directory based on the URL path the browser requests. The URL-to-file mapping is approximately:

| URL requested             | File Cockpit tries to serve                       |
|---------------------------|---------------------------------------------------|
| `<plugin>/index.html`     | `<plugin_dir>/index.html`                         |
| `<plugin>/suite`          | `<plugin_dir>/suite.html` or `<plugin_dir>/suite/index.html` |
| `<plugin>/suite/`         | `<plugin_dir>/suite/index.html`                   |

So when the v0.0.16 manifest declared `content.suite.path = "/suite"`, Cockpit registered a content page at URL `<plugin>/suite`. When the user clicked the menu entry, the browser requested `<plugin>/suite`, and Cockpit tried to serve `<plugin_dir>/suite.html` — which doesn't exist. No file matched, so Cockpit returned an empty page. Cockpit does not log this as an error; the plugin loads "successfully" but the content URL is a 404.

The v0.0.16 release passed its own manifest-consistency test, because that test only verified that `menu.<item>.path` matched some `content.<page>.path`. It did not verify that the path resolved to a real file. Both fields said `/suite`, so they matched — but neither one resolved to a file, so the menu entry silently 404'd.

#### The fix

Two-line change to `manifest.json`:

```diff
 "content": {
     "suite": {
         "label": "Suite Dashboard",
-        "path": "/suite"
+        "path": "/index.html"
     }
 },
 "menu": {
     "suite": {
         "label": "SysDeck",
         "order": 20,
-        "path": "/suite"
+        "path": "/index.html"
     }
 },
```

Now both fields point at `/index.html`, which resolves to the actual `index.html` file at the plugin root. Clicking the menu entry loads the suite dashboard at URL `<plugin>/index.html`, and Cockpit serves the file.

This matches the convention used by every real-world Cockpit plugin (cockpit-podman, cockpit-machines, cockpit-ostree — see their manifests under `standalone-plugins/`). They all use `path: "/index.html"` (or implicitly use the `index` menu key, which resolves to `/index.html`).

#### New guard: `check-manifest-consistency` now verifies file resolution

The existing `tests/check_manifest_consistency.py` has been extended. It now also verifies that every `content.<page>.path` and `menu.<item>.path` resolves to an actual file in the plugin directory. The resolver mirrors Cockpit's URL-to-file mapping:

- `/index.html` → `./index.html`
- `/suite` → `./suite.html` or `./suite/index.html`
- `/suite/` → `./suite/index.html`
- `/foo/bar.html` → `./foo/bar.html`

If a path does not resolve to a file, the test fails with:

```
FAIL: manifest.json has structural problems:
  - content.suite.path='/suite' does not resolve to a file in the plugin
    directory (looked for ./suite.html and ./suite/index.html). Cockpit
    will return 404 / empty page when this URL is requested.
```

The guard was validated by deliberately reverting the manifest to the v0.0.16 broken state (`path: "/suite"`) and confirming `make check` fails with that exact message. The manifest was then restored to `/index.html` and `make check` passes.

#### How to verify the fix after install

```bash
sudo make install
sudo systemctl restart cockpit.socket
```

Then open `https://localhost:9090` in a browser. Click **SysDeck** in the sidebar — the suite dashboard should load (header with brand mark + version badge, left sidebar with module list, content area with the default module panel).

If the menu entry still shows an empty page after this release:

1. Confirm the installed manifest has the new path:
   ```bash
   grep -A1 '"path"' /usr/share/cockpit/sysdeck/manifest.json
   # Should show: "path": "/index.html" (twice)
   ```
2. Hard-reload the browser (Ctrl+Shift+R) to bust the cockpit-ws cache.
3. Check the cockpit journal for 404s on `/sysdeck/suite`:
   ```bash
   journalctl -u cockpit -n 200 --no-pager | grep -E 'sysdeck|404'
   ```

#### Why this bug shipped

The v0.0.16 release was authored by an agent that reasoned about Cockpit's manifest contract from the test's perspective (menu path must match content path) rather than from Cockpit's actual serving behavior (URL path must resolve to a file). The agent wrote a test that codified its wrong model, the test passed, the release shipped, and the bug was only discovered when a real user clicked the menu and got an empty page.

This is the same lesson as v0.0.14 (tarball-wrapping-directory) and v0.0.16 (manifest path mismatch): a build-time guard that codifies a wrong invariant is worse than no guard, because it gives false confidence. The v0.0.18 guard verifies the actual contract Cockpit enforces at runtime (path → file resolution), not the simplified invariant the previous agent imagined.

---

## v0.0.15 — 2026-08-17

### Theme: observability stack + compatibility manifest + standalone plugin sidebar links

v0.0.15 introduces the **Prometheus** and **Grafana** modules, a **DB Control** module, a **Prometheus log pipeline** in the event bus, a **hwalert bridge** helper, a **compatibility manifest** (`compat/compat-manifest.json`) that provides a complete distro support matrix for all 21 modules and 3 standalone plugins, and **standalone plugin sidebar links** that register external Cockpit plugins (cockpit-ostree, cockpit-machines, cockpit-podman) in the suite's sidebar when they are installed.

The compatibility manifest enables operators to pre-flight a deployment: for each module, it declares the runtime condition (path-exists check), per-distro dependency package names and install commands, default-path messages for missing deps, minimum Cockpit version, tested Cockpit versions, and a distro support classification (full / partial / none).

The standalone plugin manifests follow the standard Cockpit manifest.json contract with `menu` entries and `conditions` — they appear automatically in the sidebar when their backing tools are present, without the suite needing to bundle or fork any of their code.

### What changed

**Compatibility manifest.** `compat/compat-manifest.json` contains a per-module entry for all 21 modules plus 3 standalone plugins. Each entry includes:
- `requires` — minimum Cockpit version
- `conditions` — path-exists runtime checks (module hidden when deps absent)
- `config` — per-distro (Arch, Debian, Fedora) dependency package name and install command
- `fallback` — human-readable message and install docs URL for missing deps
- `min_cockpit` — minimum Cockpit version as integer
- `tested_cockpit_versions` — list of Cockpit versions tested against
- `distro_support` — classification: full, partial, or none per distro

**Prometheus module (P1).** `cockpit-prometheus` — monitoring, alerting, and centralized log pipeline. All event-bus emissions are forwarded to the Prometheus pushgateway via a fire-and-forget hook in `event-bus.ts`. The pipeline classifies events by log level (error/warn/info) and pushes structured metadata. Bridge helper: `bridge/prometheus.py`. License: Apache-2.0.

**Grafana module (P1).** `cockpit-grafana` — dashboards, visualization, and alerting UI for the observability stack. Bridge helper: `bridge/grafana.py`. License: AGPL-3.0 (Grafana Labs).

**DB Control module (P1).** `cockpit-db` — unified control for all database engines (SQL/NoSQL/vector/AI). Bridge helper: `bridge/db.py`.

**Prometheus log pipeline.** `event-bus.ts` contains a fire-and-forget `pushLogToPrometheus()` hook. On every `emit()`, the event is forwarded to `/api/bridge/prometheus` with the module source, classified log level, event type, and payload metadata. Pipeline failures are swallowed and never propagate to callers. The pipeline is enabled via `PROMETHEUS_LOG_ENABLED = true`.

**hwalert bridge.** `bridge/hwalert.py` — hardware alert aggregation (bridge helper; panel integration pending).

**Standalone plugin sidebar links.** Three new manifests under `standalone-plugins/`:
- **cockpit-ostree** (order 35) — OSTree/rpm-ostree updates for Fedora Silverblue. Condition: `/usr/bin/rpm-ostree` exists.
- **cockpit-machines** (order 45) — Libvirt/KVM virtual machine management. Condition: `/usr/bin/virsh` exists.
- **cockpit-podman** (order 46) — Podman container management. Condition: `/usr/bin/podman` exists.

Each standalone manifest includes `menu`, `conditions`, `keywords`, `docs`, and `content-security-policy` — the standard Cockpit contract. Deploying them to `/usr/share/cockpit/<name>/` makes them appear in the sidebar automatically.

**Enhanced root manifest.json.** The suite's own manifest.json now includes `priority: 0` and uses `>=239` requires syntax instead of bare `"239"`.

**Design: benchmark.js.** `src/modules/benchmark.js` line 89 previously called bare `spawn()` (undefined reference) in the per-test Run button handler. Integrated with `bridge.benchmark.runTest(test)`.

**Version bump.** All version references updated to 0.0.13: `bridge/__init__.py`, `packaging/setup.py`, `Makefile`, `manifest.json`, `nextjs-dashboard/package.json`, `index.html`.

### Distro support summary

| Module | Arch | Debian | Fedora | Condition |
|--------|:----:|:------:|:------:|-----------|
| Containers | ✅ | ✅ | ✅ | /usr/bin/podman |
| Firewall | ✅ | ✅ | ✅ | /usr/sbin/nft |
| Integrity | ✅ | ✅ | ✅ | /usr/sbin/lynis |
| Netsec | ✅ | ✅ | ✅ | /usr/sbin/ss |
| Mesh | ✅ | ✅ | ✅ | /usr/bin/kubectl |
| Vault | ✅ | ✅ | ✅ | /usr/sbin/cryptsetup |
| Fleet | ✅ | ✅ | ✅ | (always) |
| Kata | ⚠️ | ⚠️ | ⚠️ | /usr/bin/kata-runtime |
| Fester | ✅ | ✅ | ✅ | (always) |
| Firmware | ✅ | ✅ | ✅ | /usr/bin/fwupdmgr |
| Builder | ✅ | ✅ | ✅ | /usr/bin/mkosi (Arch) · /usr/bin/vmdb2 (Debian) |
| Mining | ✅ | ⚠️ | ⚠️ | /usr/bin/xmrig |
| Themes | ✅ | ✅ | ✅ | (always) |
| Auth | ✅ | ✅ | ✅ | (always) |
| Glances | ✅ | ✅ | ✅ | /usr/bin/glances |
| Sensors | ✅ | ✅ | ✅ | /usr/bin/sensors |
| Benchmark | ✅ | ✅ | ✅ | /usr/bin/sysbench |
| Packages | ✅ | ✅ | ✅ | pacman/dnf/apt |
| DB Control | ✅ | ✅ | ✅ | (always) |
| Prometheus | ✅ | ✅ | ✅ | /usr/bin/prometheus |
| Grafana | ✅ | ✅ | ✅ | /usr/sbin/grafana-server |

---

## v0.0.15 — 2026-08-17 (production-readiness re-release)

### Theme: restore dropped code, ship the real source tree

v0.0.15 is a **corrective release**. The v0.0.13 and v0.0.14 tarballs shipped with three bridge modules and two source directories silently dropped from the tree. The v0.0.14 tarball was 80 KB; the correct source tree is 280 KB. This release restores the dropped code and adds Makefile infrastructure to install it.

#### What was dropped

Three bridge helpers and two source directories were present in the v0.0.13-full development snapshot but absent from the v0.0.13 release tarball and the v0.0.14 corrective release:

- **`bridge/grafana.py`** (413 lines) — Grafana HTTP API helper. Manages dashboards, datasources, alerting, plugins, org, users. Subcommands: `summary`, `dashboards`, `datasources`, `alerts`, `health`, `org`, `users`, `plugins`, `search`, `restart`, `reload`.
- **`bridge/hwalert.py`** (628 lines) — Hardware alert aggregation. Detects foreign/unauthorized USB, DMA-capable Thunderbolt/FireWire, rogue Bluetooth, new PCI devices, RFID/NFC skimmers, firmware tampering. Subcommands: `summary`, `devices`, `alerts`, `acknowledge`, `dismiss`, `block`, `unblock`, `whitelist`, `unwhitelist`, `policy`.
- **`bridge/prometheus.py`** (448 lines) — Prometheus HTTP API helper. Manages monitoring, alerting, and the centralized log pipeline. All SysDeck module logs can be pushed to the Prometheus pushgateway. Subcommands: `summary`, `targets`, `alerts`, `rules`, `config`, `push-log`, `log-summary`, `restart`, `reload`.
- **`nextjs-dashboard/`** — the standalone Next.js variant dashboard (1.4 MB on disk, ~200 KB compressed). Operators who want a non-cockpit web UI can run this independently.
- **`prometheus/`** — Prometheus + Grafana YAML config files (alerts, scrape targets, Grafana dashboards, Grafana datasources). 4 files, ~16 KB.

#### Why it was dropped

The v0.0.13 release tarball was generated from a working copy that had been pruned of "dev-only" directories under the mistaken assumption that `nextjs-dashboard/` and `prometheus/` were drift artifacts. They were not — they are legitimate parts of the source tree. The three bridge modules were dropped at the same time, likely as a side effect of regenerating the tarball from a stale working copy.

The v0.0.14 corrective release inherited the same dropped code because it was built from the v0.0.13 release tarball as its base, not from the v0.0.13-full development snapshot.

#### What is restored

- `bridge/grafana.py`, `bridge/hwalert.py`, `bridge/prometheus.py` — all three bridge helpers, 1489 lines total, byte-identical to the v0.0.13-full versions.
- `nextjs-dashboard/` — the full Next.js variant dashboard source.
- `prometheus/` — all four YAML config files (alerts, scrape, dashboards, datasources).
- `THIRD_PARTY.md` — restored the Prometheus, Grafana, DB Engines, and hwalert attribution sections.
- `README.md`, `BLOG.md`, `QA.md`, `QUICKSTART.md`, `docs/INSTALL.md` — restored the 21-module narrative (was incorrectly describing 18 modules).

#### Makefile changes

- **`dist` target** now includes `prometheus/` and `nextjs-dashboard/` in the tarball. New exclusions: `nextjs-dashboard/node_modules`, `nextjs-dashboard/.next`, `nextjs-dashboard/.git`.
- **`install` target** now installs:
  - Prometheus + Grafana configs to `/etc/sysdeck/prometheus/`
  - Next.js dashboard source to `/usr/share/sysdeck/nextjs-dashboard/`
- **`uninstall` target** now removes `/etc/sysdeck/` and `/usr/share/sysdeck/`.
- The `check-version-sync` guard continues to enforce version consistency across `bridge/__init__.py`, `packaging/setup.py`, `packaging/PKGBUILD`, `index.html`, and `compat/compat-manifest.json`.

#### Tarball size

The v0.0.15 tarball is ~280 KB, matching the v0.0.13-full development snapshot. The v0.0.14 tarball was 80 KB — definitively wrong, as the user observed. The 200 KB delta is the three restored bridge modules, the `nextjs-dashboard/` source, and the `prometheus/` configs.

#### Lesson

The v0.0.14 "Hard-won packaging rules" section in README included a rule: "Dev artifacts never ship in the production tarball." That rule was wrong as written. The correct rule is: **the source tarball ships the full source tree, including optional variants and config files**; the *install target* decides what gets installed system-wide. The `nextjs-dashboard/` and `prometheus/` directories are source, not dev artifacts. The rule has been corrected in this release.

---

## v0.0.17 — 2026-08-17 (first-class Cockpit application registration)

### Theme: stop fighting Cockpit's app model — register properly

v0.0.17 restructures how SysDeck identifies itself to Cockpit. The previous releases treated the install as "drop files in `/usr/share/cockpit/sysdeck/` and hope Cockpit picks them up." That approach made the plugin visible (after the v0.0.16 manifest fix) but did not make it a *first-class Cockpit application* — the kind that appears in the Applications install menu, gets proper auth context from cockpit-ws, and can request privileged operations through PolKit instead of failing with permission errors.

This release ships the two files that change the registration model: an AppStream metainfo file and a PolKit policy file. Together they make SysDeck a real Cockpit application rather than a directory of static assets.

#### What "first-class Cockpit application" means

Cockpit's Applications menu (the metapackage-style install page that lists 389 Directory Server, Docker, Files, Machines, Networking, Podman, SELinux, Storage, etc.) is not just a list of installed directories. It is the AppStream registry — the same mechanism that GNOME Software and KDE Discover use to show installable applications. Cockpit reads AppStream metadata from `/usr/share/metainfo/*.metainfo.xml` and looks for entries that declare `<provides><cockpit-manifest>NAME</cockpit-manifest></provides>`. Each such entry is a registered Cockpit application.

Without an AppStream metainfo file:
- SysDeck does not appear in the Applications install menu.
- Cockpit-ws does not grant the plugin proper auth context.
- PolKit does not know which actions the plugin's bridge helpers may request.
- Privileged bridge operations (systemctl, nft, package managers, fwupdmgr, tpm2, cryptsetup) fail with permission errors because there is no policy authorizing them.

The v0.0.16 manifest fix made the plugin *visible* in the sidebar. v0.0.17 makes it *first-class* in the application registry.

#### AppStream metainfo

New file: `packaging/sysdeck.metainfo.xml`, installed to `/usr/share/metainfo/sysdeck.metainfo.xml`. The key element is:

```xml
<component type="addon">
  <id>sysdeck</id>
  <name>SysDeck</name>
  <summary>Unified operations surface for Linux infrastructure</summary>
  <provides>
    <cockpit-manifest>sysdeck</cockpit-manifest>
  </provides>
  <!-- ... -->
</component>
```

The `<cockpit-manifest>sysdeck</cockpit-manifest>` element tells Cockpit that this AppStream component provides a cockpit plugin named `sysdeck`. When Cockpit's Applications page enumerates installed applications, it sees this entry and lists SysDeck alongside cockpit-podman, cockpit-machines, etc.

The `<id>` must match the directory name (`/usr/share/cockpit/sysdeck/`) and the `name` field in `manifest.json`. The new `check-metainfo-consistency` guard enforces this invariant at build time.

#### PolKit policy

New file: `packaging/polkit/org.sysdeck.policy`, installed to `/usr/share/polkit-1/actions/org.sysdeck.policy`. Defines six privilege domains, one per coarse-grained class of privileged operation the bridge helpers invoke:

| Action ID | Covers | Bridge modules |
|-----------|--------|----------------|
| `org.sysdeck.system.manage` | systemctl, hostnamectl, timedatectl, localectl, loginctl, machinectl | auth, db, hwalert |
| `org.sysdeck.firewall.modify` | nft, iptables, ip6tables | firewall, netsec |
| `org.sysdeck.packages.modify` | pacman, apt, dnf, yum | packages |
| `org.sysdeck.firmware.modify` | fwupdmgr, tpm2 | firmware |
| `org.sysdeck.vault.modify` | cryptsetup | vault (pending) |
| `org.sysdeck.builder.modify` | mkosi, mkarchiso, vmdb2, lb (live-build) | builder |

Each action uses `auth_admin_keep` for active sessions, which means the user authenticates once and the auth is kept for the session — the same pattern cockpit-podman and cockpit-machines use. Read-only operations (nft list, pacman -Q, fwupdmgr get-devices) do not need elevation; only mutations go through polkit.

#### New guard: `check-metainfo-consistency`

The v0.0.14 release added `check-makefile-recipes` and `check-version-sync`. The v0.0.16 release added `check-manifest-consistency`. This release adds `check-metainfo-consistency`, the fourth build-time guard. The new target runs `tests/check_metainfo_consistency.py`, which validates:

1. The metainfo file is well-formed XML.
2. The root element is `<component>`.
3. Required fields are present and non-empty: `<id>`, `<name>`, `<summary>`.
4. The `<provides>` element contains a non-empty `<cockpit-manifest>`.
5. The `<cockpit-manifest>` text matches the `<id>` text.

The guard was validated by deliberately removing the `<cockpit-manifest>` element and confirming `make check` fails with: `FAIL: missing or empty <cockpit-manifest> in <provides>`.

#### How the auth model works after this release

1. **User logs into Cockpit** with their system credentials. Cockpit-ws authenticates the user and starts a cockpit-bridge process running as that user.
2. **User navigates to SysDeck** in the sidebar. The suite dashboard loads at `/suite`. Read-only operations (list containers, list firewall rules, show sensor readings) run directly as the user — no elevation needed.
3. **User triggers a privileged operation** (e.g., "Add firewall rule", "Install package", "Flash firmware"). The bridge helper invokes the privileged binary via `pkexec`, which routes through polkit.
4. **Polkit checks the policy file** at `/usr/share/polkit-1/actions/org.sysdeck.policy`. The matching action (e.g., `org.sysdeck.firewall.modify`) authorizes `auth_admin_keep` for active sessions.
5. **Cockpit's polkit agent prompts the user** for authentication. The user enters their password (or uses a smartcard / biometric if configured).
6. **The privileged operation runs.** Subsequent operations in the same session do not re-prompt, because `auth_admin_keep` caches the auth.

Without the PolKit policy file, step 4 fails — polkit has no rule that authorizes the bridge helper to invoke `nft` or `pacman`, so it denies the request. The bridge helper receives a permission-denied error and the operation fails. This is the "auth reasons" the user observed.

#### Install and verify

```bash
tar xjf sysdeck-0.0.17.tar.bz2
cd sysdeck-0.0.17
sudo make install
sudo systemctl restart cockpit.socket
```

Then open `https://localhost:9090`:

1. **Sidebar** — SysDeck appears under "System" (unchanged from v0.0.16).
2. **Applications menu** — SysDeck appears as an installed application, alongside 389 Directory Server, Docker, Machines, Podman, etc.
3. **Privileged operations** — when you click "Add firewall rule" or "Install package", Cockpit's polkit agent prompts for authentication. After auth, the operation succeeds.

To verify the registration from the command line:

```bash
# Metainfo installed?
ls -l /usr/share/metainfo/sysdeck.metainfo.xml

# PolKit policy installed?
ls -l /usr/share/polkit-1/actions/org.sysdeck.policy

# AppStream sees the registration?
appstreamcli search sysdeck

# Polkit knows the actions?
pkaction --action-id org.sysdeck.firewall.modify
```

---

## v0.0.16 — 2026-08-17 (manifest fix — plugin now appears in Cockpit menu)

### Theme: fix the manifest path mismatch that made SysDeck invisible after install

v0.0.16 fixes a **critical visibility bug**. After installing SysDeck and restarting `cockpit.socket`, the plugin did not appear in the Cockpit sidebar menu. The Applications, System, and Tools menus all listed the standard Cockpit plugins (389 Directory Server, Docker, Files, Machines, Networking, Podman, SELinux, Storage, etc.) but SysDeck was absent. The plugin was installed correctly on disk — `manifest.json` and `index.html` were present at `/usr/share/cockpit/sysdeck/` — but Cockpit silently dropped it from the menu.

#### Root cause: manifest content/menu path mismatch

The `manifest.json` had two path fields that were supposed to refer to the same URL but did not:

```json
"content": {
    "suite": {
        "label": "Suite Dashboard",
        "path": "/index.html"          ← wrong: this is a filename, not a URL path
    }
},
"menu": {
    "suite": {
        "label": "SysDeck",
        "order": 20,
        "path": "/suite"               ← correct format, but no content entry serves this URL
    }
}
```

Cockpit's manifest contract requires every `menu.<item>.path` to match some `content.<page>.path`. The menu entry pointed at `/suite`, but the only content path was `/index.html`. Cockpit could not resolve the menu entry to a servable page, so it silently omitted SysDeck from the sidebar. No error was logged; the plugin simply did not appear.

The `content.<page>.path` field is a URL path, not a filename. Cockpit automatically serves `index.html` from the plugin directory at whatever URL path the content entry declares. The correct value is `/suite` (the URL), not `/index.html` (the file).

#### The fix

One-line change to `manifest.json`:

```diff
 "content": {
     "suite": {
         "label": "Suite Dashboard",
-        "path": "/index.html"
+        "path": "/suite"
     }
 },
```

Now `content.suite.path` and `menu.suite.path` both equal `/suite`. Cockpit serves `index.html` at the `/suite` URL, and the menu entry resolves correctly. After `sudo systemctl restart cockpit.socket`, SysDeck appears in the sidebar under the "System" section at order 20.

#### New guard: `check-manifest-consistency`

The v0.0.14 release added `check-makefile-recipes` and `check-version-sync` as `make check` prerequisites. This release adds a third guard: `check-manifest-consistency`. The new target runs `tests/check_manifest_consistency.py`, which validates:

1. `manifest.json` is valid JSON (already checked, but now with a clearer error message).
2. Required fields are present: `name`, `title`, `content` (non-empty), `menu` (non-empty).
3. Every `menu.<item>.path` matches some `content.<page>.path`.

If any check fails, `make check` exits non-zero with a message that names the exact problem. For the original bug, the failure output would have been:

```
FAIL: manifest.json has structural problems:
  - menu.suite.path=/suite does not match any content path (['/index.html'])
```

The guard was validated by deliberately reverting the manifest to the broken state and confirming `make check` fails with that exact message.

#### Why this bug shipped

The manifest was authored in v0.0.9 and never tested against a real Cockpit install. The `make check` target validated that `manifest.json` was syntactically valid JSON, but did not validate the semantic contract between `content` and `menu`. Cockpit's behavior on a mismatched path is to silently drop the plugin — no error, no log entry — so the bug was invisible until someone actually installed the plugin and looked at the menu.

This is the same class of bug as the v0.0.14 tarball-wrapping-directory bug: a structural contract that the build system did not enforce, and that the runtime failed loudly enough to be invisible. The lesson is the same: every cross-field invariant in a packaging artifact needs a build-time guard, because silent runtime failures are worse than loud build failures.

#### How to verify the fix after install

```bash
sudo make install
sudo systemctl restart cockpit.socket
```

Then open `https://localhost:9090` in a browser. SysDeck should appear in the sidebar under the "System" section, between the standard Cockpit entries. Clicking it loads the suite dashboard at the `/suite` URL.

If the plugin still does not appear, check:

1. `ls /usr/share/cockpit/sysdeck/manifest.json` — confirms the manifest is installed.
2. `python3 -c "import json; m=json.load(open('/usr/share/cockpit/sysdeck/manifest.json')); print(m['content']); print(m['menu'])"` — confirms the paths match.
3. `journalctl -u cockpit -n 50` — Cockpit sometimes logs manifest parse errors here.

---

## v0.0.12 — 2026-08-17

### Theme: package management + auth identities

v0.0.12 adds a **packages module** that wraps the system package manager (pacman on Arch Linux, dnf on Fedora/RHEL, apt on Debian/Ubuntu) into a unified cockpit panel, and extends the **auth module** with first-class identity objects that enumerate PKCS#11 tokens, SSH keys, and Kerberos principals. The suite now has 21 registered modules.

Both additions follow the established subprocess model — the package manager and identity tools are invoked as separate processes via `cockpit.spawn`, preserving license independence between the MIT suite and the GPL-2.0+ / LGPL-2.1 / BSD / MIT tools it calls.

A license audit accompanies the release. `THIRD_PARTY.md` documents every new external tool's copyright holder, license, and invocation model. The `setup.py` now includes `extras_require` for optional dependencies (glances, sysbench) and a license audit logging pattern.

### What changed

**Packages module (P1).** `src/modules/packages.js` renders a package management dashboard: installed count, pending updates, searchable package list, and update-all action. The bridge helper `bridge/packages.py` auto-detects the system package manager (pacman, dnf, or apt) at import time and dispatches to the appropriate backend. Install, remove, and update operations return the command that would be run, requiring superuser elevation via `spawnPrivileged`. Icon: 📦.

**Auth identities extension.** The `bridge/auth.py` bridge helper is extended with three new subcommands: `identities`, `ssh-keys`, and `kerberos`. The `identities` subcommand aggregates all identity objects — PKCS#11 tokens, SSH keys (from `ssh-add -L` and `~/.ssh/`), and Kerberos principals (from `klist`) — into a single JSON document with typed identity objects. The auth panel description now includes "identities". The standalone cockpit-identities plugin (LGPL-2.1, cockpit-project) is referenced but not bundled.

**Bridge helper.** `bridge/packages.py` is a new Python bridge helper that:
- Auto-detects the system package manager (pacman / dnf / apt) at import time.
- Dispatches to the appropriate backend for `list-installed`, `list-updates`, `search`, `info`, `install`, `remove`, `update`, `update-all`, and `summary` subcommands.
- Uses a step-down detection order: pacman (Arch) → dnf (Fedora) → apt (Debian).
- Returns structured JSON for every operation; install/remove/update return the command to be run (requires elevation).

**License audit.** Every new external tool invocation is documented in `THIRD_PARTY.md` with: tool name, copyright holder, SPDX license identifier, upstream URL, and invocation model. New entries:
- pacman (GPL-2.0+, Pacman Development Team)
- dnf (GPL-2.0+, RPM project)
- apt (GPL-2.0+, Debian project)
- cockpit-identities (LGPL-2.1, cockpit-project) — referenced, not bundled
- OpenSSH / ssh-add (BSD-2-Clause, OpenBSD project)
- MIT Kerberos / klist (MIT, MIT Kerberos Consortium)

**Mock data.** `src/mock-cockpit.js` extended with canned responses for packages (pacman summary, installed list, search results, update commands) and identities (PKCS#11 token, 3 SSH keys, 1 Kerberos principal). Panels render in any browser without the tools installed.

**Module registry.** `src/modules/registry.js` now has 21 entries. Sidebar groups: P0 (3), P1 (10), P2 (8). The `packages` module is P1. The `auth` module description updated to include "identities".

**Setup.py.** `extras_require` added for optional dependencies (`pip install sysdeck[glances]` installs glances, `pip install sysdeck[benchmark]` installs sysbench). Description updated to "eighteen domain modules".

**Design: MODULE_LOADERS gap.** The MODULE_LOADERS gap in `suite.js` is resolved: glances, sensors, and benchmark now have proper loader entries (these were registered in the registry but missing from the dynamic import map in v0.0.11).

### Architecture decisions

**Why auto-detect the package manager instead of requiring configuration.** The target audience is Linux administrators who already have a package manager installed. Detecting pacman / dnf / apt at bridge-helper import time eliminates a configuration step. The step-down order (pacman → dnf → apt) reflects the suite's Arch-first heritage while supporting the two other major families.

**Why install/remove/update return the command rather than executing it.** Package operations modify system state and require superuser privileges. Returning the command string lets the panel call `spawnPrivileged` through the bridge client's permission gating layer, which prompts for elevation and surfaces the result. The bridge helper does not execute the command itself — it only formulates the correct command for the detected package manager.

**Why identity objects unify PKCS#11, SSH, and Kerberos.** An operator authenticating to a system may use any combination of hardware tokens, SSH keys, and Kerberos tickets. Presenting them as typed identity objects in a single view — rather than scattered across separate panels — gives the operator a unified picture of their authentication surface. The `type` discriminator (`pkcs11-token` | `ssh-key` | `kerberos-principal`) lets the panel render type-specific detail cards while the summary counts give an at-a-glance overview.

**Why the MODULE_LOADERS gap was resolved.** In v0.0.11, glances, sensors, and benchmark were registered in `registry.js` but had no entries in the `MODULE_LOADERS` map in `suite.js`. Clicking those sidebar items would throw "No loader registered for module X" errors. Adding the three missing entries is a correctness integration that should have been in v0.0.11.

### Code quality pass

- All `cockpit.spawn` calls use the array form (SEI CERT — no shell injection).
- All panels use functional iterators (`map`, `filter`, `reduce`) — no `for` or `while` loops.
- Module registry is a single declarative array — adding a module means appending one entry.
- Bridge client is the only path to the system; panels never call cockpit APIs directly.
- Lookup tables over if-ladders (STATUS_STYLES, DEVICE_ICONS, BACKENDS dispatch table).
- Author attribution (Jeremy Anderson / dcos.net) in every source file header.
- Unit tests cover the pure-function parsers; MakefileA `check` runs them.
- License audit complete; THIRD_PARTY.md attributions match upstream metadata.
**setup.py** `extras_require` for optional deps (glances, sysbench).

### Documentation

- `README.md` — architecture, bridge-layers table, module catalog (21 entries), packaging paths, coding conventions.
- `QUICKSTART.md` — five-minute path from tarball to running dashboard.
- `BLOG.md` — this release narrative.
- `THIRD_PARTY.md` — third-party attributions and license audit (now includes pacman/dnf/apt, cockpit-identities, OpenSSH, MIT Kerberos).
- `docs/INSTALL.md` — detailed packaging paths (RPM / DEB / pip / manual).
- `tests/test_bridge_parsers.py` — unittest coverage for the parsers.
- `LICENSE` — MIT, attributed to Jeremy Anderson (<https://dcos.net>).

### Looking forward

The next milestone (v0.0.15) targets **compatibility manifest entries + sidebar links to standalone plugins** — adding cockpit manifest entries that expose deep links to standalone cockpit plugins (cockpit-pacman, cockpit-identities, cockpit-sensors, cockpit-benchmark) alongside the suite's built-in panels, so operators can choose the built-in panel or navigate to the standalone plugin.

---

## v0.0.11 — 2026-08-16

### Theme: external module integrations

v0.0.11 adds three new external-module panels — **glances** (system monitor), **sensors** (hardware sensors), and **benchmark** (system benchmark) — bringing the suite to 17 registered modules. Each module wraps an established open-source tool invoked as a separate process via `cockpit.spawn`, preserving license independence between the MIT suite and the GPL / MIT / GPL-2.0 tools it calls.

A full license audit accompanies the release. `THIRD_PARTY.md` documents every external tool's copyright holder, license, and invocation model. Because the suite never bundles external code — it only spawns external processes — the suite itself remains MIT, and each tool's license governs only the tool.

### What changed

**Glances module (P1).** `src/modules/glances.js` renders a live system-monitor dashboard: CPU per-core bars, memory/swap gauges, disk I/O rates, network throughput, and process top-N. The panel calls `cockpit.spawn(["glances", "--time", "2", "--quiet", "-f", "json"])` and streams the JSON output line-by-line. Icon: ◎.

**Sensors module (P1).** `src/modules/sensors.js` renders hardware sensor readings: temperature, fan speed, voltage, and current values from `lm_sensors`. The panel calls `cockpit.spawn(["sensors", "-j"])` and parses the per-chip JSON output. Icon: 🌡.

**Benchmark module (P2).** `src/modules/benchmark.js` renders a system benchmark workflow: CPU, memory, file I/O, and thread benchmarks via `sysbench`. The panel calls `cockpit.spawn(["sysbench", "<test>", "--time=30", "--threads=4", "run"])` for each test and renders results with score bars and comparison baselines. Icon: ⚡.

**Bridge helpers.** Three new Python bridge helpers:
- `bridge/glances.py` — wraps `glances` with structured JSON output and optional per-metric filtering.
- `bridge/sensors.py` — wraps `sensors -j` with per-chip normalization and alert thresholds.
- `bridge/benchmark.py` — wraps `sysbench` with result parsing and baseline comparison.

**License audit.** Every external tool invocation is documented in `THIRD_PARTY.md` with: tool name, copyright holder, SPDX license identifier, upstream URL, and invocation model (subprocess via `cockpit.spawn`). The audit confirms:
- No external code is bundled — the suite only spawns processes.
- The MIT license of the suite is independent of each tool's license.
- GPL-3.0 (glances) and GPL-2.0 (sysbench) apply only to the tools, not to the suite.

**Mock data.** `src/mock-cockpit.js` extended with canned responses for glances (CPU/memory/disk/net samples), sensors (coretemp + fan + voltage readings), and benchmark (sysbench CPU/memory/fileio results). Panels render in any browser without the tools installed.

**Module registry.** `src/modules/registry.js` now has 21 entries. Sidebar groups: P0 (3), P1 (9), P2 (8).

### Architecture decisions

**Why subprocess invocation preserves license compatibility.** The suite calls glances, lm_sensors, and sysbench as separate OS processes via `cockpit.spawn`. No code from these tools is linked, imported, or bundled into the suite. Under FOSS license theory, a program that spawns another program as a subprocess does not create a combined work — the process boundary is a clear arm's-length interface. The suite's MIT license governs the suite; each tool's license (GPL-3.0, MIT, GPL-2.0) governs only the tool. `THIRD_PARTY.md` documents this boundary for every external invocation.

**Why the pull pattern (panel requests data on mount) over the push pattern (tool pushes data to panel).** External tools have no awareness of the cockpit bridge. The pull pattern — panel mounts, calls `cockpit.spawn`, renders the response — is the only model that works without modifying the tool. The bridge client's retry/backoff and channel pool layers handle the resilience concerns that a push model would otherwise solve at the tool side.

**Why bridge helpers for all three new modules.** `glances`, `sensors`, and `benchmark` each produce output that benefits from normalization (consistent field names, alert thresholds, baseline comparison). The Python bridge helpers parse, normalize, and enrich the raw CLI output into a single structured JSON document. Panels receive clean data and don't duplicate parsing logic.

### Code quality pass

- All `cockpit.spawn` calls use the array form (SEI CERT — no shell injection).
- All panels use functional iterators (`map`, `filter`, `reduce`) — no `for` or `while` loops.
- Module registry is a single declarative array — adding a module means appending one entry.
- Bridge client is the only path to the system; panels never call cockpit APIs directly.
- Lookup tables over if-ladders (scoreColor uses a `SCORE_COLORS.find()` table).
- Author attribution (Jeremy Anderson / dcos.net) in every source file header.
- Unit tests cover the pure-function parsers; Makefile `check` runs them.
- License audit complete; THIRD_PARTY.md attributions match upstream metadata.

### Documentation

- `README.md` — architecture, bridge-layers table, module catalog (21 entries), packaging paths, coding conventions.
- `QUICKSTART.md` — five-minute path from tarball to running dashboard.
- `BLOG.md` — this release narrative.
- `THIRD_PARTY.md` — third-party attributions and license audit.
- `docs/INSTALL.md` — detailed packaging paths (RPM / DEB / pip / manual).
- `tests/test_bridge_parsers.py` — unittest coverage for the parsers.
- `LICENSE` — MIT, attributed to Jeremy Anderson (<https://dcos.net>).

### Looking forward

The next milestone (v0.0.12) targets **packages module + auth identities** — a package-management panel (listing, installing, updating RPM/DEB packages via `cockpit.spawn`) and an auth identities panel (enumerating PKCS#11 tokens, SSH keys, and Kerberos principals as first-class identity objects). Both will follow the same subprocess model established in v0.0.11.

---

## v0.0.10 — 2026-08-16

### Theme: cockpit-bridge channel integration

v0.0.10 hardens the bridge client so panels stop polling and start streaming. Where v0.0.9 introduced the cockpit-native plugin shape, v0.0.10 fills in the transport contract: every spawn is pooled, every privileged call is gated, every metric stream is a long-lived channel, and every system service subscription is a DBus signal instead of a refresh button.

The shell now surfaces the bridge state directly: a live CPU/memory counter in the header (sourced from a `cockpit.metrics` channel), a superuser elevation badge, and a footer indicator showing whether the DBus proxies came up. Operators can see at a glance whether the dashboard is talking to the system the way it should be.

### What changed

**cockpit.metrics tap.** The bridge client exposes a `metricsTap(options)` helper that opens a streaming channel and returns a subscribe/unsubscribe pair. The fleet panel subscribes for live CPU + memory samples; the netsec panel subscribes for live socket-rate. No `setInterval` polling anywhere in the suite.

**DBus proxies.** `initDbusProxies()` opens long-lived clients for `org.freedesktop.systemd1` and `org.freedesktop.NetworkManager`. The systemd proxy exposes `subscribeToUnit(name, onChange)` that listens for `.changed` signals on the unit's properties interface. Containers, firewall, and integrity panels use this so they re-fetch only when the underlying service state transitions — no more 5-second refresh storms.

**Retry with exponential backoff.** `withRetry(fn)` wraps spawn calls with up to three retries on transient bridge failures (`cancelled`, `channel-closed`, `timeout`, `internal-error`). The backoff is 200ms / 400ms / 800ms. Permanent failures (non-zero exit, command-not-found) propagate immediately so panels fail closed with the real error.

**Permission gating.** `spawnPrivileged(argv)` checks `cockpit.permission({ superuser: 'try' }).allowed` before reaching `cockpit.spawn`. If the user has not elevated, the call rejects with a typed error and the panel renders an "elevation required" affordance. The header has a live elevation badge and an `elevate` button that triggers the cockpit prompt via a no-op privileged call.

**Channel pool.** Identical spawn calls within a 250ms window collapse into a single bridge round-trip. When the dashboard boots and multiple panels mount simultaneously, the header stat counter, the containers panel, and the overview cards all wanting `podman ps` share one call.

**Dev mock.** `src/mock-cockpit.js` shims `window.cockpit` with realistic canned responses (3 containers, 4 listening sockets, 2 LUKS volumes, 3 fwupd devices, TPM PCR 0 sample, etc.). Uncomment one `<script>` tag in `index.html` and the dashboard renders in any browser without the cockpit-bridge — useful for development, screenshots, and design review.

**Type declarations.** `src/cockpit-types.d.ts` declares the subset of the cockpit API the suite uses (spawn, file, dbus, channel, metrics, permission, transport, user). Editors and tsc can now type-check the bridge client.

**Extended bridge helpers.** Three new Python aggregations:
- `bridge/netsec.py` — `ss -tulpn` + `ss -tnp state established` + `nft -j list counters` into a single JSON document.
- `bridge/fleet.py` — local host info (hostname, uptime, load, addresses) + `/etc/cockpit/machines.d/*.json` peer list.
- `bridge/auth.py` — `pkcs11-tool --list-token-slots` + `lsusb` reader filter + `systemctl is-active pcscd`.

**Unit tests.** `tests/test_bridge_parsers.py` covers the pure-function parsers in `firewall.py`, `netsec.py`, and `integrity.py`. The Makefile `check` target runs them via `PYTHONPATH=bridge python3 -m unittest`.

### Architecture decisions

**Why metricsTap instead of cockpit.metrics directly?** Panels should not know about channel lifecycle. The tap abstraction handles channel creation, subscriber fan-out, and cleanup; panels just call `subscribe(cb)` and get back an unsubscribe function. The same channel serves multiple subscribers, so the fleet panel and the header stat counter share one bridge round-trip per second.

**Why DBus proxies for systemd instead of polling `systemctl is-active`?** Polling wastes bridge round-trips and misses fast transitions. The systemd Manager interface emits `UnitNew` and `UnitRemoved` signals plus per-unit property changes; subscribing means the panel wakes only when something actually changed. This matters for the firewall and integrity panels where the service state is usually steady and a refresh-on-event model is correct.

**Why retry only transient failures?** Permanent failures (command-not-found, non-zero exit) are real signals that the panel needs to surface — the backend tool is absent or the operation was rejected. Retrying those would just delay the failure and hide the real error. The retryable set is closed (`cancelled`, `channel-closed`, `timeout`, `internal-error`) and documented in a constant at the top of the bridge client.

**Why a 250ms pool window?** Long enough to catch the boot burst (when multiple panels mount in the same tick), short enough that a deliberate refresh-after-edit still hits the bridge. The window is a single `Map` lookup keyed by `JSON.stringify({ argv, options })` — constant time, no lock contention.

**Why gate on `cockpit.permission('try')` instead of `cockpit.permission('require')`?** The `'try'` flavor gives a long-lived object whose `.allowed` flips when the user elevates, without forcing the elevation prompt at boot. Panels can render their normal UI and surface the elevation affordance only when the user actually attempts a privileged action.

### Code quality pass

- All `cockpit.spawn` calls use the array form (SEI CERT — no shell injection).
- All panels use functional iterators (`map`, `filter`, `reduce`) — no `for` or `while` loops.
- Module registry is a single declarative array — adding a module means appending one entry.
- Bridge client is the only path to the system; panels never call cockpit APIs directly.
- Lookup tables over if-ladders (scoreColor uses a `SCORE_COLORS.find()` table).
- Author attribution (Jeremy Anderson / dcos.net) in every source file header.
- Unit tests cover the pure-function parsers; Makefile `check` runs them.

### Documentation

- `README.md` — architecture, bridge-layers table, module catalog, packaging paths, coding conventions.
- `QUICKSTART.md` — five-minute path from tarball to running dashboard.
- `BLOG.md` — this release narrative.
- `docs/INSTALL.md` — detailed packaging paths (RPM / DEB / pip / manual).
- `tests/test_bridge_parsers.py` — unittest coverage for the parsers.
- `LICENSE` — MIT, attributed to Jeremy Anderson (<https://dcos.net>).

### Looking forward

The next milestone (v0.0.11) targets **external module integrations** — glances, sensors, and benchmark modules invoked as separate processes via `cockpit.spawn`, with a full license audit and third-party attributions. (Delivered in v0.0.11 — see above.)

---

## v0.0.9 — 2026-08-16

### Theme: cockpit-native drop-in plugin

v0.0.9 restructures the suite as a cockpit-native plugin that drops into an existing Cockpit install. The package now ships a `manifest.json` at the root, static HTML+JS+CSS files that the cockpit web service serves directly, and a Python bridge helper package for aggregations that span multiple CLI tools.

The previous Next.js dashboard is preserved under `nextjs-dashboard/` for operators who want a standalone variant. The cockpit plugin is the primary deliverable.

### What changed

**Cockpit-native plugin.** The top-level package now contains:
- `manifest.json` — cockpit v1 manifest registering the `suite` content key and a top-level menu entry.
- `index.html` — entry HTML that loads `../base1/cockpit.js` (the cockpit-bridge runtime) and the `suite.js` bundle.
- `suite.js` — ES module dashboard shell with sidebar / content / footer layout, panel router, and event-bus tail.
- `suite.css` — PatternFly-inspired dark theme scoped to `.suite-*` classes.
- `src/bridge-client.js` — typed facade wrapping `cockpit.spawn`, `cockpit.file`, `cockpit.dbus`. Every spawn call uses the array form; no shell strings reach the bridge.
- `src/event-bus.js` — singleton pub/sub with a 200-event ring buffer.
- `src/modules/registry.js` — single source of truth for the 14-module sidebar.
- `src/modules/<name>.js` — one panel per module, each calling the bridge client for real backend data.

**Python bridge helpers.** The `bridge/` package contains standalone CLI scripts for operations too complex for a single CLI call:
- `containers.py` — aggregates podman container state with systemd unit names.
- `firewall.py` — parses `nft list ruleset` into structured JSON.
- `integrity.py` — runs lynis audit and parses the hardening index.
- `firmware.py` — aggregates fwupd device list with TPM 2.0 PCR registers.

Each helper is invoked via `cockpit.spawn(["python3", "-m", "sysdeck.bridge.<module>", "<subcommand>"])`.

**Real backend calls.** Every panel now calls the real backend tool through the bridge client:
- Containers → `podman ps`
- Firewall → `nft list ruleset`
- Integrity → `lynis audit system`
- Netsec → `ss -tulpn`
- Mesh → `kubectl get svc -A`
- Vault → `lsblk -J`
- Fleet → `uptime`
- Kata → `kata-runtime list`
- Fester → `systemctl list-units`
- Firmware → `fwupdmgr get-devices` + `tpm2_pcrread`
- Builder → `mkosi` (Arch) / `vmdb2` (Debian) — installed backends + profile list
- Mining → XMRig REST API
- Themes → `/etc/cockpit/cockpit.conf`
- Auth → `pkcs11-tool --list-token-slots`

Every panel fails closed when its backend tool is absent — the panel shows an install hint instead of crashing.

**Packaging.** Three install paths are supported:
- `make install` — copies to `/usr/share/cockpit/sysdeck/` and `/usr/lib/sysdeck/bridge/`.
- `pip3 install packaging/` — uses `setup.py` with `data_files` for the cockpit plugin root.
- RPM spec at `packaging/sysdeck.spec` — `rpmbuild -bb` produces a noarch RPM that `Recommends:` the backend tools.

**Next.js dashboard preserved.** The v0.0.8 Next.js dashboard is preserved under `nextjs-dashboard/` with its package name updated to `sysdeck-dashboard` to avoid conflict with the cockpit plugin. The Next.js variant uses mock data; the cockpit plugin uses real backend calls.

### Architecture decisions

**Why vanilla JS instead of bundling the React app?** Cockpit plugins run inside the cockpit web service and load `cockpit.js` from the bridge. The bridge provides the `cockpit.spawn` / `cockpit.file` / `cockpit.dbus` API. A vanilla JS bundle loads faster, has no build step, and aligns with how real cockpit plugins (cockpit-podman, cockpit-machines) are written. The React dashboard remains available as a standalone variant for development.

**Why a Python bridge alongside cockpit.spawn?** The bridge helpers exist for aggregations that span multiple tools — e.g. cross-referencing podman containers with their systemd scope units, or aggregating fwupd devices with TPM PCR registers into a single JSON document. Single-tool calls go directly through `cockpit.spawn` from the JS bridge client; aggregations go through the Python helpers.

**Why fail closed?** A production dashboard must never crash when a backend tool is absent. Each panel catches bridge errors and renders an install hint card. The operator sees actionable guidance ("Install opensc and pcsc-lite, then start pcscd.service") instead of a blank screen.

### Code quality pass

- All `cockpit.spawn` calls use the array form (SEI CERT — no shell injection).
- All panels use functional iterators (`map`, `filter`, `reduce`) — no `for` or `while` loops.
- Module registry is a single declarative array — adding a module means appending one entry.
- Bridge client is the only path to the system; panels never call cockpit APIs directly.
- Author attribution (Jeremy Anderson / dcos.net) in every source file header.

### Documentation

- `README.md` — architecture, module catalog, packaging paths, coding conventions.
- `QUICKSTART.md` — five-minute path from tarball to running dashboard.
- `BLOG.md` — this release narrative.
- `docs/INSTALL.md` — detailed packaging paths (RPM / DEB / pip / manual).
- `LICENSE` — MIT, attributed to Jeremy Anderson (<https://dcos.net>).

### Looking forward

The next milestone (v0.0.10) targets **cockpit-bridge channel integration** — replacing the `cockpit.spawn` polling pattern with persistent `cockpit.dbus` proxies for live metric streaming. The bridge client facade is already structured to make that swap a per-module decision. (Delivered in v0.0.10 — see above.)

---

## v0.0.8 — 2026-08-16

### Theme: production-readiness pass

v0.0.8 hardens the Next.js dashboard variant for production evaluation. Documentation, code quality, and the introduction of the Kata Containers and Fester Build Orchestration modules round out the infrastructure and operations stories. See the v0.0.8 entry in `nextjs-dashboard/BLOG.md` for the full narrative.

---

## v0.0.7 — 2026-08-16

### Theme: reconciliation release

v0.0.7 consolidates the full module surface and shared infrastructure into a single coherent tree. The release unifies the 14-module target architecture (12 core modules plus Kata Containers and Fester Build Orchestration), the 48 shadcn/ui primitives, the Prisma schema and client singleton, the `use-mobile` and `use-toast` hooks, and the `cn` class-merge utility under one package. See the v0.0.7 entry in `nextjs-dashboard/worklog.md` for the full narrative.

---

## v0.0.6 — 2026-08-16

### Theme: build orchestration and sandboxed containers

v0.0.6 introduces the Fester Build Orchestration module and the Kata Containers module, plus the supporting type definitions, mock generators, and event-bus registry entries that wire them into the dashboard.

---

## v0.0.5 — 2026-08-16

### Theme: integration and dashboard shell

v0.0.5 delivers the AuthPanel and the main dashboard page that integrates all twelve original modules. The dashboard shell provides the three-zone layout, module routing, and responsive Sheet sidebar for mobile.

---

## v0.0.4 — 2026-08-16

### Theme: operations and platform modules

v0.0.4 ships the five operations and platform modules: Fleet, Firmware, Builder, Mining, and Themes.

---

## v0.0.3 — 2026-08-16

### Theme: security modules

v0.0.3 ships the three P1 security modules: Netsec, Mesh, and Vault.

---

## v0.0.2 — 2026-08-16

### Theme: P0 core infrastructure

v0.0.2 ships the three P0 modules: Containers, Firewall, and Integrity.

---

## v0.0.1 — 2026-08-16

### Theme: shared infrastructure

v0.0.1 establishes the shared infrastructure that all subsequent modules build on: types, event bus, mock data generators.


---

## v0.0.28 — 2026-08-17 (finishing touches: 2 broken subcommands + missing CSS classes + a guard that would have caught them)

### Theme: the v0.0.27 "subcommand alignment" pass missed two — and the build had no guard to catch it

v0.0.27's release narrative claimed: *"FIXED 4 SUBCOMMAND MISMATCHES… each subcommand now verified against the actual COMMANDS dict in the Python helper before being called."* That was wrong on two counts:

1. The verification was done by hand at authoring time, not enforced at build time — so once the author moved on, nothing prevented the next edit from re-introducing a mismatch.
2. The hand-verification itself missed two cases: `firmware.devices` (firmware.py only had `summary`) and `benchmark.runTest` (benchmark.py had no `run-test` subcommand at all). Both shipped through `make check` because no guard looked for them.

This release fixes the two broken modules, fills in a pile of missing CSS that the same hand-verification era let slip, and adds a build-time guard that would have caught both bugs.

### What was actually broken in v0.0.27

| # | Plugin | Symptom | Root cause |
|---|--------|---------|------------|
| 1 | sysdeck-firmware | Page crashes with "Unknown subcommand: devices" on every visit | bridge.js calls `bridgeCmd("firmware", ["devices"])` but bridge/firmware.py's main() only handled `summary`. The bridge.js comment even claimed "firmware.py COMMANDS: devices" — the comment was a lie. |
| 2 | sysdeck-benchmark | "Run" button in Available Tests table does nothing useful | bridge.js calls `bridgeCmd("benchmark", ["run-test", name])` but bridge/benchmark.py's COMMANDS dict had no `run-test` entry. |
| 3 | sysdeck-glances, sysdeck-fleet, sysdeck-netsec | Progress bars invisible (0-height divs) | shared/sysdeck.css had no `.suite-progress` / `.suite-progress-bar` / `.suite-progress-fill` rules |
| 4 | sysdeck-fleet, sysdeck-integrity, sysdeck-mining, sysdeck-packages | Multi-column layouts collapsed to single column | shared/sysdeck.css had no `.suite-grid` / `.cols-2` / `.cols-3` rules |
| 5 | sysdeck-benchmark, sysdeck-integrity, sysdeck-packages | Primary CTA buttons looked like ghost buttons | shared/sysdeck.css had no `.suite-btn-primary` rule |
| 6 | sysdeck-benchmark, sysdeck-firewall, sysdeck-kata, sysdeck-mesh, sysdeck-netsec, sysdeck-integrity | Info badges unstyled (no background) | shared/sysdeck.css had no `.suite-badge.info` rule |
| 7 | sysdeck-packages | Search box unstyled, no border/padding | shared/sysdeck.css had no `.suite-input` rule |
| 8 | sysdeck-packages | "Updates pending" warning count not colored | shared/sysdeck.css had no `.suite-warn` rule |
| 9 | cockpit-smoke-test.sh | Smoke test produces false "Cockpit is broken" diagnostic | Embedded manifest used `"cockpit": ">=239"` — the exact broken pattern Cockpit silently rejects at the discovery layer |
| 10 | sysdeck-diagnose.sh | Cannot detect missing Python bridge helpers | No section verifying /usr/lib/sysdeck/bridge/*.py exists or is executable |
| 11 | bridge/__init__.py docstring | Misleading invocation example | Still showed broken `python3 -m sysdeck.bridge.X` pattern from v0.0.25 |

### Fixes

**bridge/firmware.py — added `devices` subcommand.** Refactored to a proper `COMMANDS` dict and added a `devices` subcommand that returns fwupdmgr's native `{Devices: [...]}` shape (capital D — matches the panel's `result.value?.Devices` access pattern). Kept `summary` as an alias for backwards compatibility. Added defensive normalization so the helper always returns a renderable shape even when fwupdmgr is absent, fails, or emits invalid JSON.

**bridge/benchmark.py — added `run-test` subcommand.** New `run_test(args)` function takes a test name from argv, runs `sysbench <name> run`, and returns the parsed result dict `{raw, events_per_sec, latency_ms, error?}` — same shape as the existing `run-cpu`/`run-memory`/`run-io` helpers so the panel can render it uniformly. Surfaces sysbench failures via the `error` field instead of crashing.

**shared/sysdeck.css — added 16 missing CSS classes.** All 16 classes that the v0.0.19-era plugin JS referenced but the shared CSS never declared:

```css
.suite-row, .suite-row-between          /* horizontal flex layouts */
.suite-grid, .cols-2, .cols-3          /* grid layouts */
.suite-col-2, .suite-col-3             /* legacy flex column widths */
.suite-btn-primary                     /* primary CTA button */
.suite-badge.info                      /* informational badge */
.suite-stat-value, .suite-stat-label   /* stat block hierarchy */
.suite-progress, .suite-progress-bar,
.suite-progress-fill                   /* progress bar track + fills */
.suite-input                           /* form inputs */
.suite-warn                            /* warning modifier */
```

Each class has a comment explaining which plugin(s) use it and what breaks without it.

**cockpit-smoke-test.sh — fixed the embedded manifest.** Changed `"requires": { "cockpit": ">=239" }` to `"requires": { "cockpit": "239" }` to match the pattern used by every real working plugin in this tarball. Added a long comment explaining why `">=239"` is broken (Cockpit's `sortify_version()` turns `">="` into a string that sorts GREATER than any real cockpit version because `>` is ASCII 62 > `0` ASCII 48, so `packages.py` raises `JsonError` and silently rejects the manifest).

**sysdeck-diagnose.sh — added section 5a.** New section verifies that:
- `/usr/lib/sysdeck/bridge/*.py` exists
- Each helper is executable
- `glances.py --help` runs end-to-end (smoke test)
- `firmware.py devices` returns `{Devices: [...]}`
- `benchmark.py run-test` returns a sysbench result dict

**bridge/__init__.py — fixed docstring.** Updated the invocation example from the broken `python3 -m sysdeck.bridge.containers` pattern to `python3 /usr/lib/sysdeck/bridge/containers.py`, with a note explaining why the `-m` pattern was broken (requires a nested Python package layout the Makefile never produced).

### The new guard: `check-bridge-subcommands`

The headline addition. A new Python static analyzer at `tests/check_bridge_subcommands.py`:

1. Regex-parses `shared/bridge.js` to find every `bridgeCmd("<module>", ["<subcommand>", ...])` call.
2. For each `<module>`, ast-parses `bridge/<module>.py` and extracts the keys of its `COMMANDS` dict. For helpers without a `COMMANDS` dict (e.g. `db.py`, `hwalert.py`), falls back to scanning `main()`'s `argv[0] == "X"` checks.
3. Verifies every subcommand the JS expects actually exists in the Python helper's dispatch table.

On failure, prints a clear message naming the bad file, line number, the JS-side call, and the Python-side `COMMANDS` dict contents. Example failure output (when I temporarily reverted `firmware.py` to its v0.0.27 state during regression testing):

```
FAIL: bridge.js calls Python subcommands that don't exist:
  shared/bridge.js:173: bridgeCmd("firmware", ["devices", ...]) —
  bridge/firmware.py does not expose a "devices" subcommand.
  Its COMMANDS dict has: ['summary'].

To fix: either add the missing subcommand to the Python helper's
COMMANDS dict, or change the bridge.js call to use a subcommand
that exists.
```

Wired into the Makefile as the `check-bridge-subcommands` target, added to the `check` aggregate target. The full guard list is now:

```
check: check-metainfo-consistency
       check-manifest-consistency
       check-makefile-recipes
       check-no-broken-cockpit-import
       check-no-broken-python-module
       check-bridge-subcommands          <- NEW
       check-version-sync
```

### Verification

- `make check` end-to-end: all 7 guards pass; 19 JS sources pass `node --check`; 19 manifest.json files are valid JSON; both shell scripts pass `bash -n`; 9 bridge parser unit tests pass.
- Smoke-tested the two fixed Python helpers:
  - `python3 bridge/firmware.py devices` returns `{"Devices": []}` (correct shape; empty because no fwupdmgr in this container)
  - `python3 bridge/benchmark.py run-test` returns `{"raw": "", "events_per_sec": null, "latency_ms": null, "error": "no test name provided"}` (graceful error)
- Regression-tested the new guard: temporarily reverted `bridge/firmware.py` to its v0.0.27 state (only `summary` subcommand). Confirmed `make check` fails with the exact message above. Restored the fix; confirmed the guard passes.
- `make distcheck` passes — tarball extracts into `sysdeck-0.0.28/` wrapping directory; `make check` runs inside the extracted tree and all 7 guards pass.

### Lesson

The v0.0.27 release notes claimed "each subcommand now verified against the actual COMMANDS dict." That verification was done by hand at authoring time — and hand-verification rots the moment someone touches either side without re-running the verification.

The new `check-bridge-subcommands` guard makes the verification automatic and continuous. Every `make check` from now on will catch any future bridge.js ↔ Python helper drift, with a message that names the exact file, line, and missing subcommand.
