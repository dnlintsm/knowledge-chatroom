# The Python API server (api_py/app.py, issue #190) for docker-compose.yml's
# `api` service. It sits in front of the TypeScript agent server and passes it
# every route not ported yet. It builds from the repository root, the uv
# workspace that also holds packages/knowledge-py:
#
#   docker build -f services/api-py/Dockerfile -t knowledge-chatroom-api-py .
#
# The image carries the agent server's SQL migrations, so it can check that the
# database has exactly the ones it was built for (the TypeScript server applies them),
# and its built-in skills.

ARG PYTHON_IMAGE=python:3.12-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.32
FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE}
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
# Dependencies first (from uv.lock), so code changes reuse this layer.
COPY pyproject.toml uv.lock ./
COPY packages/knowledge-py ./packages/knowledge-py
COPY services/api-py/pyproject.toml ./services/api-py/
RUN uv sync --frozen --no-dev --package api-py
COPY apps/agent/src/storage/migrations ./migrations
# The built-in skills /skills lists, as the agent server ships them.
COPY apps/agent/skills ./skills
COPY services/api-py/api_py ./services/api-py/api_py

RUN useradd --create-home --uid 10001 api \
  && mkdir -p /var/lib/knowledge/models && chown -R api:api /var/lib/knowledge
WORKDIR /app/services/api-py
# The embedding model for search by meaning is downloaded there on first use.
ENV PATH="/app/.venv/bin:$PATH" API_PY_HOST=0.0.0.0 API_PY_PORT=8000 MIGRATIONS_DIR=/app/migrations BUILTIN_SKILLS_DIR=/app/skills \
  EMBEDDING_CACHE_DIR=/var/lib/knowledge/models
EXPOSE 8000
USER api
CMD ["python", "-m", "api_py.app"]
