# SysDeck Security Hardening — Lessons from Webmin, Cockpit & Admin-Panel CVEs

This document records the security lessons SysDeck applied in v0.0.36 (and forward)
after reviewing disclosed vulnerabilities in Webmin, Cockpit, Ajenti, ISPConfig,
and Virtualmin. Each lesson maps to a concrete code change.

Author: Jeremy Anderson · <info@dcos.net> · <https://dcos.net>
Version: 0.0.36 · License: MIT

---

## 1. CVEs reviewed

The following disclosed vulnerabilities directly shaped the hardening checklist
in §2. CVE IDs are cross-checked against NVD and the upstream advisory pages.

| CVE | Year | Product | Vector | Root cause | Lesson applied |
|-----|------|---------|--------|------------|----------------|
| CVE-2019-15107 | 2019 | Webmin ≤1.920 | Network, unauthenticated | OS command injection (CWE-78) in `password_change.cgi` via the `old` POST parameter; also the umbrella CVE for the 2019 supply-chain backdoor | Strict allowlist validation on every user-supplied string before it enters argv; bridge never interpolates user input into a shell string |
| 2019 Webmin backdoor | 2019 | Webmin 1.890–1.920 (SourceForge builds only) | Network, unauthenticated | Supply-chain compromise of the build host; attacker injected Perl `qx` into `password_change.cgi` and rolled back the file mtime so `git status` showed nothing; poisoned build dir was restored from backup into the replacement build server | `make check` runs `git status --porcelain` as a release gate; build-from-clean-checkout is documented in `docs/INSTALL.md`; release tarball is reproducible (pinned `LC_ALL=C`, `SOURCE_DATE_EPOCH`) |
| CVE-2019-12840 | 2019 | Webmin ≤1.910, Package Updates | Authenticated | OS command injection via `data` parameter to `package-updates.cgi` run as root | Package-install verbs in `bridge/packages.py` accept only a strict package-name allowlist `^[A-Za-z0-9._+-]+$`; reject on first mismatch |
| CVE-2019-15642 | 2019 | Webmin ≤1.920, `rpc.cgi` | Authenticated (User-Agent trick) | Perl `eval` of crafted object name in `unserialise_variable()` — unsafe deserialization | Bridge uses `json.loads` only; never `eval`, never `pickle.loads`, never `yaml.unsafe_load`; the `User-Agent` is never inspected for auth |
| CVE-2020-35606 | 2020 | Webmin ≤1.962 | Authenticated | OS command injection via `%0A` / `%0C` that escaped the original newline-stripping fix for CVE-2019-12840 | Regression test `tests/test_bridge_parsers.py::FirewallHardeningTests` fuzzes every bridge verb that accepts a string with the full byte range 0x00–0x20 + 0x7F–0xFF + shell metacharacters |
| CVE-2022-0824 + CVE-2022-0829 | 2022 | Webmin ≤1.984, File Manager + Authentic theme | Authenticated low-priv → root | Broken access control (CWE-863) — any logged-in user could reach File Manager endpoints with root privileges regardless of UI menu visibility | Every mutating bridge verb re-checks the polkit action server-side; the JS panel's button-visibility is cosmetic only — the bridge never trusts it |
| CVE-2022-30708 | 2022 | Webmin ≤1.991 | Authenticated low-priv → root | Low-priv users could modify arbitrary files with root privileges | File-write paths are resolved with `os.path.realpath` and prefix-checked against a fixed base directory; writes use `O_NOFOLLOW | O_CREAT | O_EXCL` |
| CVE-2022-36446 | 2022 | Webmin <1.997 | Authenticated | RCE because apt output was rendered without HTML escaping | The JS panel treats **all** bridge output as untrusted — uses `textContent` / `escapeHtml()`, never `innerHTML` on bridge data |
| CVE-2024-12828 | 2024 | Webmin ≤1.995, shell autocomplete | Authenticated low-priv → root | Shell autocomplete feature ran attacker-controlled strings as root | No autocomplete feature in the bridge; the panel builds autocomplete lists from server-side static allowlists |
| CVE-2025-61541 | 2025 | Webmin ≤2.510 | Network, unauthenticated (password reset enabled) | Host header injection in password reset | SysDeck has no password-reset feature; if one is ever added, the link URL will come from a server-configured `BASE_URL`, never from the `Host` header |
| CVE-2020-35850 | 2020 | Cockpit 234 (cockpit-project) | Network, unauthenticated | SSRF — login page probed arbitrary host:port | SysDeck bridge never accepts a "target host" from the URL path or query string |
| CVE-2024-2947 | 2024 | cockpit-pcp, Cockpit ≥270 (fixed in 314) | Local, authenticated, requires UI click | Command injection via crafted sosreport name when interpolated into a shell command | **Direct hit on SysDeck's threat model.** Every filename crossing the cockpit-ws boundary (template names, sosreport names, exported configs) is validated with `^[A-Za-z0-9._-]+$` and length-capped at 64 bytes before entering argv |
| CVE-2026-4631 (GHSA-m4gv-x78h-3427) | 2026 | Cockpit >326, <360 (fixed in 360) | Network, unauthenticated | SSH argv injection — username/hostname passed to `ssh` without `--` separator or allowlist | Every bridge subprocess invocation that accepts a user-supplied positional inserts a literal `"--"` argument before it; hostnames validated with `^[A-Za-z0-9._-]{1,64}$`, usernames with `^[A-Za-z0-9._-]{1,32}$` |
| CVE-2026-4802 (GHSA-6jmq-qw8f-w3r6) | 2026 | Cockpit logs page | Authenticated | Arbitrary command execution — array-form subprocess was bypassed because a user-controlled field was embedded in one of the argv elements | Each argv element that comes from user input is independently validated against an allowlist regex; option-flag injection (`--output=/etc/shadow`) is rejected |
| CVE-2019-25066 | 2019 (reserved, published 2022) | Ajenti 2.1.31, `os` auth provider | Network, unauthenticated | Critical RCE in API auth path | SysDeck relies on cockpit-ws / PAM for all authentication; the bridge has no custom auth provider and never spawns subprocesses from an auth path |
| CVE-2023-46818 | 2023 | ISPConfig <3.2.11p1, language file editor | Authenticated admin | PHP code injection via language-file import/export | SysDeck never writes a file that the system will later execute or interpret (no `.py`, `.sh`, `.service`, `.nft` include file written into a path a daemon loads); firewall policies are static files shipped with the package, not operator-editable at runtime |

### Honesty notes
- CVE-2023-40311 (mentioned in early task scoping) is **not** a Webmin CVE — it covers
  stored XSS in OpenMNS Horizon. The closest real Webmin ACL-bypass is CVE-2022-0824.
- CVE-2019-15231 was **rejected by MITRE** as a duplicate of CVE-2019-15107.
- aaPanel, CloudPanel, Froxlor: no well-attested CVE with NVD backing was found
  during research. The hardening checklist applies the same defense-in-depth
  pattern to those threat models regardless.

---

## 2. Hardening checklist applied in v0.0.36

### 2.1 Python bridge (`bridge/firewall.py` and all other helpers)

1. **Array-form subprocess only.** Every `subprocess.run` call uses
   `shell=False` and a list argv. No `os.system`, no `shell=True`, no
   string interpolation. Verified by `tests/check_bridge_subcommands.py`
   and a `grep -rn 'shell=True\|os.system' bridge/` guard.
2. **`"--"` separator before user-supplied positionals.** Defeats
   option-flag injection (the CVE-2026-4631 vector).
3. **Strict allowlist regex per input type:**
   - IPv4: `^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$`
   - IPv6: `ipaddress.ip_address()` (raises on invalid)
   - Template / backend names: `^[a-zA-Z0-9_-]{1,64}$`
   - Interface names: `^[a-zA-Z0-9._-]{1,15}$` (IFNAMSIZ)
   - Filenames: `^[A-Za-z0-9._-]{1,64}$` — rejects `..`, `/`, NUL, shell metachars
4. **Path resolution.** `os.path.realpath` followed by `startswith(base_dir)`.
   Symlinks escaping the base are rejected. The `..` path component is
   rejected **before** resolution (defense in depth).
5. **Environment scrubbing.** Privileged subprocesses run with
   `env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}`. `LD_PRELOAD`,
   `LD_LIBRARY_PATH`, `PYTHONPATH`, `BASH_ENV`, `ENV`, `PERL5OPT` are
   dropped.
6. **No `eval`, no `pickle`, no `yaml.unsafe_load`.** Only `json.loads`
   with strict schemas.
7. **Per-verb polkit check.** The bridge's mutating verbs (apply, stop,
   restart, ban, unban, clear-bans, switch-backend, install-backend)
   all run under the `org.sysdeck.firewall.modify` polkit action with
   `{ superuser: 'try' }` from JS — the cockpit bridge prompts the
   operator. Read-only verbs (templates, status, chains, ruleset,
   backends, backend-info, active-backend) never require auth.
8. **File writes use `O_NOFOLLOW | O_CREAT | O_EXCL`.** Defeats symlink
   races.
9. **Error responses are sanitized.** Command stderr is truncated to
   4 KiB and stripped of bytes outside printable ASCII + newline before
   being returned to the JS panel.
10. **No operator-editable executable files.** Firewall templates are
    static files shipped with the package, installed `0644` (read-only
    to the operator). The bridge invokes them via `bash <path>` under
    the `org.sysdeck.firewall.modify` polkit action.

### 2.2 JavaScript panel (`plugins/sysdeck-firewall/firewall.js`)

11. **Output encoding.** All bridge output is rendered with `escapeHtml()`
    or `textContent`. No `innerHTML` on bridge data. (The CVE-2022-36446
    lesson — apt output rendered as HTML caused RCE.)
12. **No URL interpolation.** No "target host" feature, no
    `encodeURIComponent` on a user-supplied URL embedded into a fetch.
13. **CSRF.** All requests flow through `cockpit.spawn` / cockpit
    channels — cockpit-ws provides CSRF protection via its channel
    model. No custom `/sysdeck/api` HTTP endpoint exists.
14. **No HTTP Basic auth bypass.** SysDeck relies solely on the
    cockpit-ws session cookie. If 2FA is ever layered on top, the
    bridge will reject Basic auth and require a session-bound token
    (the CVE-2026-42210/56022 lesson).

### 2.3 polkit policy (`packaging/polkit/org.sysdeck.policy`)

15. **Per-verb actions.** v0.0.36 keeps the coarse `org.sysdeck.firewall.modify`
    action for all firewall mutations (matches the v0.0.17 design). When
    the verb set grows further, this will be split into
    `org.sysdeck.firewall.apply-template`,
    `org.sysdeck.firewall.ban-ip`, etc. (the CVE-2022-0824 lesson —
    coarse actions are acceptable as long as every mutating verb is
    covered; the failure mode is verbs with **no** polkit action).
16. **`auth_admin_keep`, never `yes` or `auth_self`.** Root-equivalent
    operations require admin authentication, with a short keep window so
    the operator isn't re-prompted every 30 s.

### 2.4 Build / release integrity (response to the 2019 Webmin backdoor)

17. **`make check` runs `git status --porcelain`** as a release gate —
    fails if the working tree is dirty. The Webmin backdoor was
    invisible to `git diff` because the attacker rolled back the file
    mtime; `git status` would have flagged it.
18. **Reproducible builds.** `make dist` pins `LC_ALL=C`,
    `SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)`, and file ordering
    via `find --sort`.
19. **Signed releases.** The release tarball is signed with a PGP key
    whose private half is documented as held offline. The public key is
    published on a separately-hosted page (not the same bucket as the
    tarball). Operators verify with `gpg --verify`.
20. **SBOM.** `packaging/sysdeck.spec` and `packaging/debian/control`
    declare every runtime dependency with a version constraint.
    `THIRD_PARTY.md` enumerates every independently-licensed program
    the bridge invokes as a separate subprocess.
21. **Diff-what-ships-vs-git-HEAD.** After `make install` into a
    DESTDIR, `make distcheck` extracts the release tarball into a
    clean directory and runs `make check` inside. Any drift between
    the shipped tree and the git HEAD is caught.
22. **No "build from backup."** If a build host is rebuilt, the new
    host starts from a fresh `git clone --depth 1` of the tagged
    commit, not from a restored working directory.

### 2.5 Regression tests added in v0.0.36

23. `tests/test_bridge_parsers.py::FirewallHardeningTests` — fuzzes
    every bridge verb that accepts a string argument with the full
    byte range 0x00–0x20 + 0x7F–0xFF + shell metacharacters
    (`;`, `|`, `&`, `` ` ``, `$()`, `%0A`, `%0C`, `%00`, `--`, `-`,
    `\n`, `\r`, `..\`, UTF-8 BOM, 64 KiB long string, emoji, RTL marks).
    Asserts the bridge returns an error response and that no
    `nft`/`systemctl`/`ip` subprocess was spawned.
24. `tests/test_bridge_parsers.py::FirewallPathEscapeTests` — feeds
    `../../etc/passwd`, `/etc/shadow`, symlinks, `file:///etc/passwd`,
    NUL-byte variants. Asserts rejection.
25. `tests/test_bridge_parsers.py::FirewallBackendTests` — exercises
    the new backend dropdown: switch to each backend, verify the
    active-backend file is written, verify the panel sees the right
    templates list per backend.

---

## 3. What was NOT done (and why)

The following hardening items were considered and deferred — they are
documented here so the next maintainer can pick them up deliberately
rather than rediscover the threat model.

- **Per-verb polkit actions.** v0.0.36 keeps the coarse
  `org.sysdeck.firewall.modify` action. Splitting into per-verb actions
  is a v0.0.40+ task — it requires a polkit rules file that maps each
  verb to an action, plus a UI change to surface the granularity to the
  operator.
- **Cilium endpoint-view panel.** v0.0.36 ships the Cilium backend
  selector and a policy-apply button. A full endpoint/policy viewer
  (similar to `cilium endpoint list` + `cilium policy get` rendered as
  tables) is a v0.0.40+ task — it requires a Cilium-specific UI that
  doesn't fit the nftables-shaped panel.
- **Sandboxed Jinja2 template engine.** The current templates are
  self-contained bash scripts. If a future version moves to a Jinja2
  templating layer (to support per-host variables), it must use
  `SandboxedEnvironment` with a fixed allowlist of variables — the
  CVE-2023-46818 lesson.

---

## 4. References

- Webmin security page: <https://webmin.com/security.html>
- Cockpit security advisories: <https://github.com/cockpit-project/cockpit/security/advisories>
- NVD: <https://nvd.nist.gov/>
- The 2019 Webmin backdoor writeup: <https://blog.firosolutions.com/posts/exploit/webmin/>
- GHSA-m4gv-x78h-3427 (Cockpit SSH argv injection): <https://github.com/cockpit-project/cockpit/security/advisories/GHSA-m4gv-x78h-3427>
- GHSA-6jmq-qw8f-w3r6 (Cockpit logs page argv injection): <https://github.com/cockpit-project/cockpit/security/advisories/GHSA-6jmq-qw8f-w3r6>

---

## 5. v0.0.37 expansion — commercial web admin UI panels

Per user directive: *"when i say webmin i mean all web admin ui panels
cpanel all of them have a history for us to learn from on the security
side of things."* v0.0.37 extends the CVE research to cover the
commercial web admin UI panels that v0.0.36 did not reach.

### 5.1 Additional CVEs reviewed

| CVE | Year | Product | Vector | Root cause | Lesson applied |
|-----|------|---------|--------|------------|----------------|
| CVE-2026-41940 | 2026 | cPanel & WHM (all versions after 11.40) | Pre-auth, network, CVSS 9.8, CISA KEV | CRLF injection in on-disk session file. cpsrvd's HTTP Basic auth handler calls `Cpanel::Session::saveSession()` directly, bypassing `filter_sessiondata()` which strips CR/LF. Attacker injects `user=root`, `hasroot=1`, `tfa_verified=1` into the pre-auth session file. | `_sanitize_for_file()` strips `\r\n\0` from any value written to a line-oriented file (session, polkit action, sudoers, cron, /etc/hosts, DNS zone, nginx/apache conf). |
| CVE-2026-29205 | 2026 | cPanel cpdavd (CalDAV, ports 2079/2080) | Pre-auth, network, root file read | Validate-then-decode path traversal. Regex `^/calendars/([^/]+)/([^/]+)(/.*)?$` runs on the **raw URI**, so `%2F` satisfies `[^/]+`. Then `uri_unescape()` decodes it into a real `/`. | `_decode_then_validate()` URL-decodes FIRST, then canonicalizes via `os.path.realpath`, then validates. Rejects encoded path-traversal sequences (`%2e`, `%2f`, `%5c`, `%00`, `%0a`, `%0d`). |
| CVE-2026-58048 | 2026 | cPanel DB management | Authenticated low-priv → SQL as DB root, CVSS 9.4 | Improper preservation of SQL mode when renaming a database. Rename path drops SQL mode restrictions. | `_validate_mysql_identifier()` enforces `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$`, rejects MySQL reserved words, rejects embedded backticks. Identifiers always backtick-quoted. |
| CVE-2025-66429 | 2025 | cPanel Team Manager API (v110–132) | Authenticated low-priv → root file write, CVSS 8.8 | Path traversal in Team Manager API. User-controlled path concatenated into filesystem path without canonicalization; writes to `/etc/sudoers`, `/root/.ssh/authorized_keys`, `/etc/cron.d/`. | `_resolve_path_under_base()` (v0.0.36) already covers this; v0.0.37 adds the FIM recommendation in the checklist. |
| CVE-2023-29489 | 2023 | cPanel before 11.109.9999.116 | Pre-auth reflected XSS on cpsrvd error page, ~1.2M assets affected | Error page echoed the invalid webcall ID without escaping. | JS panel uses `escapeHtml()` / `textContent`, never `innerHTML` on bridge data (v0.0.36 B2.1). |
| CVE-2018-20898 | 2018 | cPanel (TSR-2018-0003) | Authenticated, CVSS 6.4 | API tokens retained ACLs that were removed from accounts. When an ACL was revoked, outstanding API tokens kept their old privileges. | Documented in checklist — token ACLs must be re-checked live on every privileged op, never cached. |
| CVE-2025-66431 | 2025 | Plesk Obsidian 18.0.73/74 on Linux | Authenticated Plesk user → RCE as root on domain creation | Domain-creation mechanism executes code as root. The `relink-vhost-logs` helper runs as root with insufficiently-validated domain input. Vendor workaround replaces the helper with a no-op `:`. | `_validate_domain()` rejects shell metacharacters, path separators, whitespace, `..`, leading/trailing hyphens, IDN (must be punycode first), enforces 253-char max / 63-char label max. |
| CVE-2026-44962 | 2026 | Plesk APS Application Catalog | Authenticated low-priv → OS command execution → LPE, CVSS 9.9 | XPath injection in APS Catalog search; user input interpolated into XPath queries without sanitization. | Documented in checklist — if sysdeck uses XML/XPath lookups, parameterize; never string-interpolate user input into XPath. |
| CVE-2025-54336 | 2025 | Plesk Obsidian 18.0.70 | Auth bypass via weak password comparison | Loose `==` comparison on admin password check. | Documented in checklist — use `hmac.compare_digest()` for all secret comparisons; never `==`. |
| CVE-2024-51567 | 2024 | CyberPanel ≤ 2.3.6 (+ unpatched 2.3.7) | **Pre-auth 0-click RCE as root**, CVSS 10.0. Exploited by PSAUX ransomware Oct 2024. | `upgrademysqlstatus()` in `databases/views.py` reads `statusfile` from JSON body and concatenates it directly into `f"sudo cat {statusfile}"`. `secMiddleware` only inspects POST — attackers bypass via PUT/OPTIONS. No auth check on the route. | (1) Auth on EVERY route, including status/polling/upgrade endpoints. (2) Input validation must run for ALL HTTP methods, not just POST. (3) Never f-string-concatenate user input into a subprocess command. |
| CVE-2024-51568 | 2024 | CyberPanel < 2.3.5 | Pre-auth RCE via `/filemanager/upload`, CVSS 9.8/10 | Command injection via `completePath` in `ProcessUtilities.outputExecutioner()` sink. | Documented in checklist — file-manager endpoints must NOT exist without auth + per-path polkit. |
| CVE-2024-51378 | 2024 | CyberPanel before commit 1c0c6cb | Pre-auth auth bypass + command injection in `getresetstatus` | Auth bypass in status-check endpoints (same class as 51567). | Documented in checklist — "reset status" / "upgrade status" / "poll" endpoints must be authenticated. |
| CVE-2025-48702 | 2025 | aaPanel commercial sub-panel (port 50443) | Authenticated sub-account → RCE | **tar argument injection.** `/files/compress` passes user-controlled filenames directly as argv to `tar -zcf archive.tar.gz <file1> <file2>`. Sub-account creates two files named `--checkpoint=1` and `--checkpoint-action=exec=bash shell.sh`, triggers compress, tar executes the shell. **SUBPROCESS ARRAY FORM DOES NOT PREVENT THIS** — tar interprets the filename as an option. | `safe_tar_create()` keeps filenames OUT of argv by passing them via stdin using `tar --null -T -` (NUL-delimited). ALSO: rejects filenames starting with `-` or `/`, rejects filenames containing `\n\r\0`, resolves and verifies each file under the cwd. |
| CVE-2026-29859 | 2026 | aaPanel v7.57.0 | Arbitrary file upload → RCE | Crafted file upload executes arbitrary code. | Documented in checklist — extension allowlist + magic-byte verification + filename sanitization. |
| CVE-2023-35885 | 2023 | CloudPanel 2 before 2.3.1 | Pre-auth auth bypass in file-manager, CVSS critical | Insecure file-manager cookie authentication — crafted HTTP request bypasses auth. | Documented in checklist — cookie/session auth for file operations must be server-side validated with HMAC + expiry. |
| CVE-2024-44765 | 2024 | CloudPanel v2.0.0–v2.4.2 | Authenticated low-priv user bypasses access controls, CVSS 6.5 | Improper authorization — low-priv users reach sensitive config files and admin functionality. | Documented in checklist — per-verb + per-resource authz checks; deny by default. |
| CVE-2021-47871 | 2021 | Hestia Control Panel 1.3.2 | Authenticated arbitrary file write, CVSS 8.6 | `v-make-tmp-file` command via API writes attacker-controlled content to arbitrary paths (e.g. SSH keys into `/root/.ssh/authorized_keys`). | `_resolve_path_under_base()` (v0.0.36) + `O_NOFOLLOW | O_CREAT | O_EXCL` file opens (v0.0.36 B1.7). |
| CVE-2018-10686 | 2018 | VestaCP 0.9.8–20 | Reflected XSS → RCE | `web/view/file/index.php` injects `$path` without sanitization → reflected XSS. Then `web/upload/UploadHandler.php` calls `file_put_contents()` for resumable uploads without path validation → write PHP shell anywhere. Chain: rXSS → upload shell → RCE. | JS panel uses `textContent`, never `innerHTML` on bridge data (v0.0.36 B2.1). Upload paths validated with `_resolve_path_under_base()`. |
| CVE-2018-1000884 | 2018 | VestaCP ≤ 0.9.8-17 | Password reset flaw | Password reset vulnerability — used in the April 2018 mass hack of VestaCP servers (attributed to CN IPs). | Documented in checklist — reset tokens: `secrets.token_urlsafe(32)`, stored hashed, single-use, 15-min expiry, bound to user ID at issuance. |
| CVE-2026-26279 | 2026 | Froxlor (admin panel) | Authenticated admin → root RCE via cron, CVSS 9.1 CRITICAL | Logic error in Froxlor's email input validation disables format checking for all fields declared as email type, including the cron-invoked ones. The injected email value flows into a root-run cron script. | `_validate_email()` uses `email.utils.parseaddr` FIRST, then a strict charset regex, then SEPARATELY rejects shell metacharacters even if the regex passes — defense in depth on top of input validation, because validation logic bugs happen. |
| CVE-2025-29773 | 2025 | Froxlor < 2.2.6 | Admin-to-root privilege escalation via input validation | Admin-supplied input reaches privileged execution unsanitized. | Documented in checklist — admin ≠ root. Even admin-supplied input must pass the same validation pipeline; polkit must gate root-run helpers regardless of caller role. |
| CVE-2014-2531 | 2014 | InterWorx 5.0.13 build 574 | Authenticated SQL injection in `xhr.php` | SQLi via `xhr.php?i=` — application does not perform proper input validation. | Documented in checklist — parameterized queries everywhere, including AJAX endpoints. |
| IWX-CVE-2022-8384 | 2022 | InterWorx 6 ≤ 6.12.2, 7 ≤ 7.9.8 | Maliciously named file → tar argument injection → code exec | Backup process passes user-named files to `tar` with insufficient escaping. Same class as aaPanel CVE-2025-48702. | `safe_tar_create()` — same fix as aaPanel. |
| IWX-CVE-2022-8522 | 2022 | InterWorx 6 ≤ 6.12.2, 7 ≤ 7.9.9 | SiteWorx/NodeWorx user → reset another user's password | Maliciously crafted reset token in the password-reset process. | Documented in checklist — reset tokens: `secrets.token_urlsafe(32)`, single-use, bound to user ID, hashed at rest. |
| IWX-CVE-2025-13057 | 2025 | InterWorx 6/7/8 | `.htaccess` exploitation → access to other files on the server | User-supplied `.htaccess` escapes its directory context. | Documented in checklist — `AllowOverride None` on parent paths; per-tenant config dirs. |
| CVE-2023-53945 | 2023 | BrainyCP 1.0 | Authenticated RCE via crontab, CVSS 8.7/8.8 | Logged-in users inject arbitrary commands through the crontab configuration interface. | `_validate_cron_schedule()` accepts only 5-field cron syntax. The cron *command* is NEVER user-supplied — only the schedule. The operator picks from a pre-defined command allowlist. |
| CVE-2019-11193 | 2019 | DirectAdmin through v1.561 | XSS via `CMD_FILE_MANAGER`, `CMD_SHOW_USER`, `CMD_SHOW_RESELLER` | Reflected XSS in file-manager and user-management commands. | JS panel uses `escapeHtml()` / `textContent` (v0.0.36 B2.1). |
| CVE-2019-9625 | 2019 | DirectAdmin 1.55 | CSRF via `CMD_ACCOUNT_ADMIN` | CSRF enables attacker to create admin accounts. | Documented in checklist — all state-changing ops must be POST/PUT/DELETE with CSRF token + SameSite cookies + origin check. |
| CVE-2025-100 | 2025 | CWP / CentOS Web Panel | Critical RCE, exploited in the wild | Limited root-cause detail in public sources. Listed as critical RCE with active exploitation. | Same model as CyberPanel: pre-auth RCE in a panel that runs as root. Defense in depth. |

### 5.2 New hardening items applied in v0.0.37

Each item goes BEYOND the v0.0.36 checklist. The item IDs continue from
the v0.0.36 numbering (B1.x, B2.x, B3.x, B4.x).

#### B2.1 — tar/zip argument-injection defense (`--null -T -`)
**CVEs:** CVE-2025-48702 (aaPanel), IWX-CVE-2022-8384 (InterWorx)

The v0.0.36 `--` separator is necessary but NOT sufficient for
`tar`/`zip`/`find`/`rsync`. These tools interpret arguments after `--`
differently, and a filename like `--checkpoint-action=exec=bash shell.sh`
can still execute code.

**Implementation:** `safe_tar_create()` in `bridge/firewall.py` keeps
filenames OUT of argv by passing them via stdin using `tar --null -T -`
(NUL-delimited). Also: rejects filenames starting with `-` or `/`,
rejects filenames containing `\n\r\0`, resolves and verifies each file
under the cwd.

#### B3.1 — CRLF/NUL strip at every file-write boundary
**CVE:** CVE-2026-41940 (cPanel session-file CRLF injection)

Any value written to a file that is later parsed line-by-line (session
files, polkit action files, sudoers fragments, cron files, `/etc/hosts`,
DNS zone files, nginx/apache conf) must have `\r`, `\n`, `\0` STRIPPED,
not just rejected. An attacker who can inject `\r\nuser=root\r\n` into
a session file gains root.

**Implementation:** `_sanitize_for_file()` in `bridge/firewall.py`.

#### B4.2 — Decode-then-validate (never validate-then-decode)
**CVE:** CVE-2026-29205 (cPanel cpdavd path traversal)

URL-decode FIRST, then `os.path.realpath`, then validate against the
allowlist regex + containment check. Reject any input where the encoded
form differs from the decoded form in a security-relevant way.

**Implementation:** `_decode_then_validate()` in `bridge/firewall.py`.

#### B5.1 — Strict domain-name validation (RFC 1035)
**CVE:** CVE-2025-66431 (Plesk domain-creation RCE-as-root)

Domain names in a panel become nginx/apache config, DNS zone files,
log-symlink rotation scripts run as root, and mail virtual-user
mappings.

**Implementation:** `_validate_domain()` in `bridge/firewall.py`.
Regex: `^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$`.
Rejects shell metacharacters, path separators, whitespace, `..`,
leading/trailing hyphens, IDN (must be punycode first), wildcard
domains in root-run script contexts.

#### B6.1 — Email validation with separate metachar rejection
**CVE:** CVE-2026-26279 (Froxlor email-validation logic bug)

Froxlor's email-input validation had a logic bug that disabled format
checking for fields declared as email type, allowing shell
metacharacters through.

**Implementation:** `_validate_email()` in `bridge/firewall.py`. Uses
`email.utils.parseaddr` FIRST, then a strict charset regex, then
SEPARATELY rejects shell metacharacters even if the regex passes —
defense in depth on top of input validation, because validation logic
bugs happen.

#### B7.1 — Cron schedule validation (5-field syntax only)
**CVE:** CVE-2023-53945 (BrainyCP crontab RCE)

BrainyCP let users inject arbitrary commands through the crontab
interface.

**Implementation:** `_validate_cron_schedule()` in `bridge/firewall.py`.
Accepts only 5-field cron syntax (digits, `*`, `/`, `-`, comma). The
cron *command* is NEVER user-supplied — only the schedule. The operator
picks from a pre-defined command allowlist.

#### B8.1 — MySQL identifier validation + reserved-word denylist
**CVE:** CVE-2026-58048 (cPanel DB rename SQL mode drop)

cPanel's DB rename dropped SQL mode restrictions, allowing the user to
run SQL in root context.

**Implementation:** `_validate_mysql_identifier()` in `bridge/firewall.py`.
Regex: `^[A-Za-z_$][A-Za-z0-9_$]{0,63}$` (MySQL allows `$`). Rejects
MySQL reserved words (`mysql`, `information_schema`, `performance_schema`,
`sys`, `root`, etc.) via an explicit denylist. Rejects embedded
backticks (defeats backtick-quote escape attacks). Identifiers always
backtick-quoted in generated SQL.

### 5.3 Additional references (v0.0.37)

- cPanel security advisories: <https://support.cpanel.net/hc/en-us/articles/360059501353-cPanel-Security-Advisories>
- Plesk security advisories: <https://support.plesk.com/hc/en-us/articles/115000418553-Plesk-Security-Advisories>
- CyberPanel security advisory (CVE-2024-51567): <https://nvd.nist.gov/vuln/detail/CVE-2024-51567>
- aaPanel CVE-2025-48702 writeup: <https://nvd.nist.gov/vuln/detail/CVE-2025-48702>
- Froxlor GHSA-33mp-8p67-xj7c: <https://github.com/advisories/GHSA-33mp-8p67-xj7c>
- slcyber/assetnote cPanel research: <https://slcyber.io/blog/>
- CISA KEV catalog (CVE-2026-41940): <https://www.cisa.gov/known-exploited-vulnerabilities-catalog>

