# Attribution

## Upstream project

This tree is a **vendored, unmodified copy** of **klanker-gate** — the
"Frosty Deno" LLM gateway — distributed inside the SysDeck master
tarball.

| Field         | Value                                                |
|---------------|------------------------------------------------------|
| **Project**   | klanker-gate (Frosty Deno LLM Gateway)               |
| **Author**    | **TykoDev**                                          |
| **Source**    | https://github.com/TykoDev/klanker-gate              |
| **License**   | Apache-2.0 (full text: [`LICENSE`](LICENSE))         |
| **Version**   | 0.9.0 (independent from SysDeck's version)           |

**klanker-gate is NOT SysDeck code.** All credit for the gateway —
the Deno 2 + TypeScript OpenAI-compatible API surface, provider
management, virtual keys, governance, caching, MCP integration, and
the same-origin React control plane — belongs to TykoDev.

## What SysDeck added

SysDeck's integration work is **additive only** — the upstream source
required zero changes (the "port" to Linux was packaging, not code):

- `arch/` — Arch Linux packaging (PKGBUILD, hardened systemd unit,
  sysusers/tmpfiles, run wrapper, `INSTALL-ARCH.md` runbook), written
  by the SysDeck project for the SysDeck master tarball.
- Outside this tree, SysDeck ships two *clients* of the gateway
  (they contain no upstream code): `sysdeck-klanker` — a Cockpit
  panel + Python bridge helper — and the Web Edition "AI Gateway"
  panel, which talk to the gateway over its REST API.

Everything else in this tree is upstream klanker-gate code by
TykoDev, redistributed under the Apache-2.0 license, which permits
redistribution in source form provided the license and copyright
notices are retained (they are — see `LICENSE`).

Upstream releases, issues, and development happen at
https://github.com/TykoDev/klanker-gate.
