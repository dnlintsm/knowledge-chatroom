# The python-agent sample's MCP server (lab_tools/server.py) for docker-compose.yml's
# `python-sample` profile. It builds from the repository root, the uv workspace that
# also holds packages/knowledge-py:
#
#   docker build -f services/lab-tools/Dockerfile -t knowledge-chatroom-lab-tools .

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
COPY services/lab-tools/pyproject.toml ./services/lab-tools/
RUN uv sync --frozen --no-dev --package lab-tools
COPY services/lab-tools/lab_tools ./services/lab-tools/lab_tools

WORKDIR /app/services/lab-tools
ENV PATH="/app/.venv/bin:$PATH" LAB_TOOLS_HOST=0.0.0.0 LAB_TOOLS_PORT=9100
EXPOSE 9100
USER nobody
CMD ["python", "-m", "lab_tools.server"]
