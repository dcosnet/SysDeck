# SysDeck Web Edition

The browser-native rendition of SysDeck: 28 bridge modules behind one
console — real /proc + /sys collectors where the host allows, honest demo
datasets (clearly badged) where backends are absent, and the Fester DAG
orchestrator vendored as a dedicated service (`mini-services/fester`).

## Run (Bun)

    bun install
    bun run db:push                        # create + migrate db/custom.db (SQLite)
    (cd mini-services/fester && bun install)
    bun run dev                            # Next.js on :3000
    (cd mini-services/fester && bun run dev)   # fester service on :3010

Then open http://localhost:3000. The Fester panel proxies REST through
`/api/fester` and streams WebSocket events through the gateway
(`/?XTransformPort=3010`).

## Layout

- `src/lib/sysdeck/` — module registry + bridge dispatcher modules
- `src/app/api/bridge` — the bridge endpoint (POST {module, command, args})
- `src/app/api/fester` — server-side proxy to the fester service
- `src/app/api/release` — master-tarball release metadata
- `src/components/sysdeck/` — panels + shared UI primitives
- `mini-services/fester` — the vendored Fester service (own package, v0.2.1)

`db/custom.db` is created by `bun run db:push` using `DATABASE_URL` from
`.env`. The master tarball builder lives at `scripts/make-master-tarball.sh`
in the canonical development tree.
