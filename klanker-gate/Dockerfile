# syntax=docker/dockerfile:1

# --- Stage 1: build the Control UI bundle (Vite/React/TS) INSIDE the image ---
# The runtime no longer depends on a prebuilt apps/control-ui/dist on the host
# (which, on Windows, can be locked by Defender / Docker file-sharing and block
# `deno task build-ui`). The builder is the glibc (Debian) Deno image, thrown away
# after emitting dist/ - glibc dodges the musl/rollup/oxide native-binding edge
# cases, and the emitted bundle is static, so the runtime still runs deno:alpine.
# There is no npm in the repo: the UI builds THROUGH Deno via npm: specifiers.
FROM denoland/deno:2.9.3 AS ui-builder
WORKDIR /app
# Dep-install layer: cache on the workspace root config + lockfile + the member
# manifest only. `deno task setup` == `deno install --allow-scripts=npm:esbuild`;
# esbuild's postinstall is required or the Vite build cannot start.
COPY deno.jsonc deno.lock ./
COPY apps/control-ui/package.json ./apps/control-ui/
RUN deno task setup
# The UI imports shared types via ../../../packages, so mirror the repo layout
# (packages as a sibling of apps) before building.
COPY packages ./packages
COPY apps/control-ui ./apps/control-ui
RUN deno task build-ui

# --- Stage 2: Deno runtime ---
# Deno 2 base image (decision D3). The previous 1.40.4 pin predated `jsr:`
# specifier support and could not `deno cache` this workspace.
FROM denoland/deno:alpine-2.9.3

WORKDIR /app

COPY deno.jsonc deno.lock ./
# deno.jsonc declares apps/control-ui as a workspace member, so its manifest must be
# present for config resolution. The gateway itself stays on Deno's global module
# cache via --node-modules-dir=none, so NO node_modules is baked into the runtime
# image (identical to pre-migration behavior; only the build stage uses one).
COPY apps/control-ui/package.json ./apps/control-ui/
COPY packages ./packages
COPY apps/gateway ./apps/gateway
# The Control UI bundle comes from the builder stage above, so the image always
# serves the UI same-origin without any prebuilt host dist.
COPY --from=ui-builder /app/apps/control-ui/dist ./apps/control-ui/dist

COPY deploy/docker-entrypoint.sh /usr/local/bin/frosty-entrypoint

RUN deno cache --node-modules-dir=none apps/gateway/main.ts \
  && mkdir -p /app/data \
  && chmod +x /usr/local/bin/frosty-entrypoint \
  && chown -R deno:deno /app

EXPOSE 8080
USER deno

# The entrypoint mirrors the `start` task in deno.jsonc and permissions.md, and
# adds a Deno-scoped --allow-run only when FROSTY_WORKERS>1. --unstable-net is
# REQUIRED for multi-process serving: Deno.serve({reusePort:true}) throws
# "Unstable API 'Deno.listen({ reusePort: true })'" without it.
ENTRYPOINT ["/usr/local/bin/frosty-entrypoint"]
