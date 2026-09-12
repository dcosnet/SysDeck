# arch/ — Arch Linux packaging for klanker-gate

Turns the vendored Frosty Deno tree into a pacman package + hardened
systemd service. Zero upstream source changes required (see
INSTALL-ARCH.md section 0 for the porting verdict and evidence).

**Upstream attribution:** klanker-gate is **not** SysDeck code — it is
the "Frosty Deno" LLM gateway by **TykoDev**
(https://github.com/TykoDev/klanker-gate, Apache-2.0), vendored
unmodified. Only this `arch/` directory is SysDeck packaging; see
`../ATTRIBUTION.md`.

- `PKGBUILD` — self-packaging (files come from the tree this lives in)
- `klanker-gate.service` — hardened systemd unit (StateDirectory, env file)
- `run.sh` — /usr/bin/klanker-gate wrapper: cache warmup + scoped --allow-run
- `sysusers.conf`, `tmpfiles.conf` — the `klanker` system user + dirs
- `env.example` — becomes /etc/klanker-gate/env (backup'd)
- `INSTALL-ARCH.md` — the full runbook incl. postgres + SysDeck wiring
