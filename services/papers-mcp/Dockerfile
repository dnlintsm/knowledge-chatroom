# The paper search MCP server (papers_mcp/server.py) for docker-compose.yml's
# `papers` profile. It builds from the repository root, the uv workspace that
# also holds packages/knowledge-py:
#
#   docker build -f services/papers-mcp/Dockerfile -t knowledge-chatroom-papers-mcp .

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
COPY services/papers-mcp/pyproject.toml ./services/papers-mcp/
RUN uv sync --frozen --no-dev --package papers-mcp
COPY services/papers-mcp/papers_mcp ./services/papers-mcp/papers_mcp

WORKDIR /app/services/papers-mcp
ENV PATH="/app/.venv/bin:$PATH" PAPERS_HOST=0.0.0.0 PAPERS_PORT=9200
EXPOSE 9200
USER nobody
CMD ["python", "-m", "papers_mcp.server"]
