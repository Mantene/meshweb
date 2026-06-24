# syntax=docker/dockerfile:1.7
#
# Meshtastic web client + server-side serial bridge.
# Build context = the web/ monorepo root:
#   docker build -f apps/bridge/infra/Dockerfile -t meshtastic-web-bridge .
#
# Base is Debian (glibc) Node 22 on purpose:
#   - glibc: @serialport/bindings-cpp ships glibc prebuilds (Alpine/musl does not).
#   - Node 22: matches the repo's devcontainer and the prebuilt native ABI.

############################################
# Stage 1 — build static web client + bundle the bridge (pnpm workspace)
############################################
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo

# Whole repo (a .dockerignore at the root keeps this lean).
COPY . .

# Workspace install. allowBuilds:false skips serialport's native build here —
# that's fine: this stage only builds the web app and bundles the bridge JS
# (serialport is marked external in the bundle). The working native binding is
# produced in the `native` stage below.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Generate protobuf TS stubs. The local @meshtastic/protobufs workspace package
# re-exports generated code that is gitignored (not committed) and that the web
# app build resolves to. Uses buf with the remote `es` plugin → requires network
# to buf.build at build time. (The bridge itself doesn't need this; it uses the
# pre-generated JSR copy of the protobufs.)
RUN cd packages/protobufs && npx --yes @bufbuild/buf@latest generate

# Static web client -> apps/web/dist
# VITE_DISABLE_PWA: skip vite-plugin-pwa (unnecessary for a LAN deployment; its
#   service-worker build step is fragile under Vite 8 + rolldown in-container).
# NODE_OPTIONS: headroom for the large client chunks so a constrained host won't OOM.
RUN VITE_DISABLE_PWA=true NODE_OPTIONS=--max-old-space-size=4096 \
    pnpm -C apps/web build
# Bundled bridge      -> apps/bridge/dist/server.mjs  (serialport external)
RUN pnpm -C apps/bridge build

############################################
# Stage 2 — install serialport with a WORKING native binding (outside the workspace)
############################################
FROM node:22-bookworm-slim AS native
# Toolchain only as a from-source fallback if no prebuild matches the arch.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /native
# Minimal manifest with ONLY serialport — a plain npm install NOT governed by the
# workspace's allowBuilds:false, so the native binding builds/loads normally.
COPY apps/bridge/runtime.package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
 && node -e "import('serialport').then(()=>console.log('serialport OK')).catch(e=>{console.error(e);process.exit(1)})"

############################################
# Stage 3 — runtime (slim, glibc, Node 22, no toolchain)
############################################
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/dist \
    MESHTASTIC_SERIAL_PORT=/dev/ttyACM0 \
    MESHTASTIC_BAUD_RATE=115200
WORKDIR /app

# Working serialport (+ its native .node) from the native stage.
COPY --from=native /native/node_modules ./node_modules
# Bundled bridge server (resolves serialport from ./node_modules at runtime).
COPY --from=build /repo/apps/bridge/dist/server.mjs ./server.mjs
# Static web client.
COPY --from=build /repo/apps/web/dist ./dist

EXPOSE 8080
# Run as the built-in non-root user; it must be added to the serial device's
# group at runtime (compose `group_add` / `docker run --group-add`).
USER node
CMD ["node", "server.mjs"]
