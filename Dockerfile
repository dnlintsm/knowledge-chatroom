# Images for the demo stack in docker-compose.yml (`--profile demo`).
#
#   docker build --target app   -t knowledge-chatroom-app .
#   docker build --target agent -t knowledge-chatroom-agent .
#
# Both build from the repository root: it is one pnpm workspace, and the UI and
# the agent share packages/contracts. The agent runs from source with tsx, as
# `pnpm -C agent start` does.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
# pnpm at the version in package.json "packageManager".
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# --- UI: Next.js standalone server ---
FROM base AS app-build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY agent/package.json ./agent/
COPY packages/contracts/package.json ./packages/contracts/
# Only the UI and what it uses: the agent's packages stay out of this image.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "knowledge-chatroom..."
COPY . .
# The root tsconfig also type-checks the agent and tests, which the UI image
# doesn't need (and whose agent packages this stage doesn't install).
RUN rm -rf agent tests e2e
# NEXT_PUBLIC_* values are fixed at build time (see next.config.ts).
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM ${NODE_IMAGE} AS app
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=app-build --chown=node:node /src/.next/standalone ./
COPY --from=app-build --chown=node:node /src/.next/static ./.next/static
COPY --from=app-build --chown=node:node /src/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]

# --- Agent: Claude Agent SDK over AG-UI, plus the storage API ---
# `pnpm deploy` copies the agent with only its own dependencies (and
# packages/contracts) into /out; a filtered install would also bring the UI's.
FROM base AS agent-build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY agent/package.json ./agent/
COPY packages/contracts/package.json ./packages/contracts/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch
COPY packages/contracts ./packages/contracts
COPY agent ./agent
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter ./agent deploy /out

FROM ${NODE_IMAGE} AS agent
WORKDIR /app/agent
COPY --from=agent-build /out ./
# Search by meaning downloads its model once into this folder (a volume in compose).
ENV NODE_ENV=production EMBEDDING_CACHE_DIR=/var/lib/knowledge/models
RUN mkdir -p /var/lib/knowledge/models && chown -R node:node /var/lib/knowledge
USER node
EXPOSE 8000
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
