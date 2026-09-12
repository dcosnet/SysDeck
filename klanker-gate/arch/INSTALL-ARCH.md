# Installing klanker-gate (Frosty Deno) on Arch Linux

The complete Arch port runbook. Read section 0 first — it records the
actual porting verdict, because it is probably not what you expected.

> **Upstream attribution:** klanker-gate is **not SysDeck's code**. It
> is the "Frosty Deno" LLM gateway by **TykoDev** —
> https://github.com/TykoDev/klanker-gate — licensed Apache-2.0 and
> vendored unmodified. This `arch/` directory is SysDeck packaging;
> see `../ATTRIBUTION.md` for the full credit and license notes.

## 0. The porting verdict: zero source changes

klanker-gate is **not a Windows codebase**. It is a Deno 2 + TypeScript
monorepo, and Deno runs identically on Windows, macOS and Linux — the
Windows mentions in the tree are accommodations for a *second-class Windows
dev platform*, not Windows-first code:

| Evidence (upstream file) | What it says |
| --- | --- |
| `apps/gateway/cluster.ts` | `reusePortSupported()` returns true **only for linux/darwin**. Windows is locked to single-process; the failure message literally says "Use Docker/Linux for multi-process". |
| `Dockerfile` | Both stages are Linux images (`denoland/deno:2.9.3`, `denoland/deno:alpine-2.9.3`). The Windows mention is a comment about Defender locking files on a Windows *host*. |
| `deploy/docker-entrypoint.sh` | POSIX `/bin/sh` entrypoint. |
| `deno.lock` win32 entries | Automatic cross-platform lockfile records — present in every project using npm-native deps, on every OS. |
| `scripts/` | `.sh` + Deno `.ts` tasks; no `.bat`/`.ps1` anywhere in the 448-file tree. |

So "porting to Arch Linux" is a **packaging exercise, not a code exercise**:
install Deno + PostgreSQL, manage the process with systemd. The arch/ files
in this tree do exactly that. Moving to Arch even *unlocks* a feature —
`FROSTY_WORKERS` multi-process serving via `SO_REUSEPORT`, which the
Windows platform cannot do at all.

Estimated effort if you do it by hand (no packaging): **~30 minutes**.
With this package: ~5 minutes, below.

## 1. Install the package

```bash
pacman -S --needed deno base-devel     # deno is in [extra]
cd klanker-gate/arch
makepkg -si
```

What lands where:

| Path | Contents |
| --- | --- |
| `/usr/share/klanker-gate` | the gateway tree (Deno runs the TypeScript directly) |
| `/usr/bin/klanker-gate` | ExecStart wrapper: cache warmup + scoped `--allow-run` when `FROSTY_WORKERS>1` |
| `/etc/klanker-gate/env` | operator EnvironmentFile (pacman `backup=()` — survives upgrades) |
| `/usr/lib/systemd/system/klanker-gate.service` | hardened service unit |
| `/var/lib/klanker-gate` | StateDirectory: `data/` + the deno module cache (DENO_DIR) |

The unit is hardened (`ProtectSystem=full`, `PrivateTmp`, empty
`CapabilityBoundingSet`, …) but deliberately does **not** use
`MemoryDenyWriteExecute` — V8's JIT needs W^X pages — and defers
`SystemCallFilter` until it is validated against the Code Mode worker.

## 2. Provision PostgreSQL (local state store)

Either run your own, or use the shipped compose file
(`docker compose up -d postgres` from the tree root). Local Arch postgres:

```bash
pacman -S postgresql
sudo -u postgres initdb -D /var/lib/postgres/data
sudo systemctl enable --now postgresql

sudo -u postgres psql <<'SQL'
CREATE ROLE klanker LOGIN PASSWORD 'CHANGE_ME';
CREATE DATABASE klanker OWNER klanker;
SQL
```

Frosty's durable state (providers, virtual keys, budgets, logs, cache,
pricing) all lives in this one database. A remote `FROSTY_PG_URL`, PgBouncer
in front, or the compose service are equally supported.

## 3. Configure

```bash
sudoedit /etc/klanker-gate/env
```

Minimum viable: `FROSTY_PG_URL` plus one provider credential. For SysDeck
operation also set `FROSTY_ADMIN_TOKEN` (the module reads the operator API
with it). **The package requires the token anyway** — see §9 before you
template that file. The full knob reference is
`/usr/share/klanker-gate/docs/reference/environment-variables.md`.

## 4. Start + verify

```bash
sudo systemctl enable --now klanker-gate
systemctl status klanker-gate          # boot log states API-only mode
curl http://localhost:8080/healthz     # {"ok":true,...}
curl http://localhost:8080/v1/models   # configured model catalog
```

First start fetches the module cache (network needed once); later starts
are served warm from `/var/lib/klanker-gate/.cache/deno`.

## 5. Multi-process serving (the Arch bonus)

```bash
# /etc/klanker-gate/env
FROSTY_WORKERS=4
```

```bash
sudo systemctl restart klanker-gate
curl http://localhost:8080/api/runtime   # workers.effective == 4
```

Workers share :8080 through `SO_REUSEPORT` with fleet-wide budgets and
rate-limit windows through PostgreSQL. The wrapper grants `--allow-run`
scoped to the Deno binary **only** when `FROSTY_WORKERS>1` — mirroring the
upstream entrypoint's escalation policy.

## 6. Optional: the same-origin Control UI

The packaged gateway serves API-only until `apps/control-ui/dist` exists.
SysDeck's klanker module is the operator surface for this package, so
building the UI is optional. If you want it anyway:

```bash
cd /usr/share/klanker-gate
sudo -u klanker deno task setup      # one-time esbuild script dep
sudo -u klanker deno task build-ui   # emits apps/control-ui/dist
sudo systemctl restart klanker-gate
```

(Building inside the packaged tree; pacman will overwrite it on upgrade —
rebuild after upgrades, or keep a copy in /opt if you care.)

## 7. Wire it into SysDeck

Both SysDeck editions ship a klanker module (cockpit edition:
`bridge/klanker.py` + `plugins/sysdeck-klanker`; web edition: the AI Gateway
panel). Point either at the gateway:

**Cockpit edition** (bridge environment — e.g. the file cockpit sources
`bridge_env` from):

```bash
KLANKER_URL=http://127.0.0.1:8080
KLANKER_ADMIN_TOKEN=<same token as FROSTY_ADMIN_TOKEN>
```

**Web edition** (`.env` of the Next.js app, then restart it):

```bash
KLANKER_URL=http://127.0.0.1:8080
KLANKER_ADMIN_TOKEN=<same token>
```

The panels read `/healthz`, `/api/providers`, `/api/virtual-keys`,
`/api/logs`, `/api/analytics`, `/api/runtime`, `/v1/models` and drive
service control (`systemctl start/stop/restart`, journal tail) through the
sysdeck bridge. With the gateway down the panels degrade to clearly-badged
demo data instead of erroring.

## 8. Upgrades / removal

```bash
# upgrade: replace the tree, rebuild, reinstall
cd klanker-gate/arch && makepkg -si

# the operator env survives upgrades (backup'd); state lives in postgres
sudo systemctl stop klanker-gate
sudo pacman -Rns klanker-gate        # -n also drops the backup env copy
```

The `klanker` user and `/var/lib/klanker-gate` are owned by pacman-hygiene
tooling if you want them gone too (`sudo userdel klanker`).

## 9. Security notes (read before exposing the port)

The 0.3.0 SysDeck security audit reviewed the vendored upstream code
end-to-end. Full findings + suggested upstream patches live in
`arch/SECURITY-UPSTREAM.md` (installed at
`/usr/share/klanker-gate/SECURITY-UPSTREAM.md`). The operator-facing
summary:

1. **The gateway binds `0.0.0.0` by default** (upstream `Deno.serve({port})`
   — no hostname option exists in 0.9.0). On a single-user machine behind
   no firewall, treat :8080 as a LAN-exposed port. Keep it loopback with a
   firewall rule:

   ```bash
   # nftables: drop non-loopback ingress to the gateway
   sudo nft add rule inet filter input tcp dport 8080 ip saddr != 127.0.0.1 drop
   # or ufw:
   sudo ufw deny in to any port 8080
   sudo ufw allow in from 127.0.0.1 to any port 8080
   ```

2. **`FROSTY_ADMIN_TOKEN` is mandatory with this package.** Upstream's
   no-token "local-admin mode" serves the entire admin API (provider CRUD,
   key management, config export incl. secrets) unauthenticated; the
   packaged systemd unit refuses to start without the token
   (`ExecStartPre` guard — opt out via drop-in only on a firewalled host).

3. **Create a virtual key immediately after first start** if any provider
   account carries credentials: until the first vkey exists, upstream's
   governance layer passes `/v1/*` through *unauthenticated* (open proxy
   onto your provider spend):

   ```bash
   curl -H "Authorization: Bearer $FROSTY_ADMIN_TOKEN" \
        -H 'content-type: application/json' \
        -d '{"name":"console","limits":{}}' \
        http://127.0.0.1:8080/api/virtual-keys
   ```

4. Compose users: the upstream compose files publish Postgres (frosty/
   frosty) and the observability stack on all interfaces with default
   passwords — bind them to loopback or change the credentials before
   `docker compose up` on any shared network.

What this package already does for you: the service unit is hardened
(`ProtectSystem=full`, `PrivateTmp`, empty `CapabilityBoundingSet`,
`DevicePolicy=closed`, …), the Deno permission surface is scoped
(`--allow-net --allow-env --allow-read --allow-write=data`), secrets never
appear in the SysDeck panels (token travels in the `Authorization` header
only), and the vendored tree is byte-identical to upstream — all mitigations
live in this packaging layer, documented per finding.
