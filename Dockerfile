# The UI image for the demo stack in docker-compose.yml (`--profile demo`).
#
#   docker build --target app -t knowledge-chatroom-app .
#
# It builds from the repository root: it is one pnpm workspace (apps/web,
# packages/contracts). The Python services have their own Dockerfiles.

ARG NODE_IMAGE=node:26-bookworm-slim

FROM ${NODE_IMAGE} AS base
# Node 25+ no longer bundles Corepack. Pin pnpm to package.json's packageManager.
RUN npm install --global --allow-scripts=pnpm pnpm@12.18.0

# --- UI: Next.js standalone server ---
FROM base AS app-build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@knowledge-chatroom/web..."
# Only what the UI build reads, so scripts/docker-changes.mjs can map a change to
# this image exactly: copy anything else the build starts to need here, and add it
# to that script's rules.
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
# NEXT_PUBLIC_* values are fixed at build time (see apps/web/next.config.ts).
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm -C apps/web build

FROM ${NODE_IMAGE} AS app
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
# The standalone build keeps the repository layout: the server is apps/web/server.js.
COPY --from=app-build --chown=node:node /src/apps/web/.next/standalone ./
COPY --from=app-build --chown=node:node /src/apps/web/.next/static ./apps/web/.next/static
COPY --from=app-build --chown=node:node /src/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
