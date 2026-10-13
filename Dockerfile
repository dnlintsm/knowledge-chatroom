# Images for the demo stack in docker-compose.yml (`--profile demo`).
#
#   docker build --target app   -t knowledge-chatroom-app .
#   docker build --target agent -t knowledge-chatroom-agent .
#
# Both build from the repository root because the UI and the agent share
# ../shared. The agent runs from source with tsx, as `npm --prefix agent start` does.

ARG NODE_IMAGE=node:22-bookworm-slim

# --- UI: Next.js standalone server ---
FROM ${NODE_IMAGE} AS app-build
WORKDIR /src
COPY package.json package-lock.json ./
# Skip postinstall: it installs the agent, which this image does not need.
RUN npm ci --ignore-scripts
COPY . .
# The root tsconfig also type-checks the agent and tests, which the UI image
# doesn't need (and whose agent packages this stage doesn't install).
RUN rm -rf agent tests e2e
# NEXT_PUBLIC_* values are fixed at build time (see next.config.ts).
ARG RUN_DIR_MARKERS=xdoe-report
ENV RUN_DIR_MARKERS=${RUN_DIR_MARKERS} NEXT_TELEMETRY_DISABLED=1
RUN npm run build

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
FROM ${NODE_IMAGE} AS agent
WORKDIR /app
COPY agent/package.json agent/package-lock.json ./agent/
RUN npm ci --prefix agent && npm cache clean --force
COPY shared ./shared
COPY agent ./agent
# Search by meaning downloads its model once into this folder (a volume in compose).
ENV NODE_ENV=production EMBEDDING_CACHE_DIR=/var/lib/knowledge/models
RUN mkdir -p /var/lib/knowledge/models && chown -R node:node /var/lib/knowledge
USER node
EXPOSE 8000
CMD ["npm", "--prefix", "agent", "start"]
