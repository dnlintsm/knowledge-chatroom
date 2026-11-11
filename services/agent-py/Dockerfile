# The Python chat agent (agent_py/app.py) for docker-compose.yml's `python-agent`
# profile. It builds from the repository root, the uv workspace that also holds
# packages/knowledge-py:
#
#   docker build -f services/agent-py/Dockerfile -t knowledge-chatroom-agent-py .
#
# The Claude Agent SDK's wheel brings its own Claude Code binary, so the image
# needs no Node.js.

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
COPY services/agent-py/pyproject.toml ./services/agent-py/
RUN uv sync --frozen --no-dev --package agent-py
COPY services/agent-py/agent_py ./services/agent-py/agent_py

# Claude Code keeps its settings in the user's home; each chat user's working
# folder (with their skills) goes in AGENT_PY_WORKDIR.
RUN useradd --create-home --uid 10001 agent \
  && mkdir -p /var/lib/agent-py && chown agent /var/lib/agent-py
WORKDIR /app/services/agent-py
ENV PATH="/app/.venv/bin:$PATH" AGENT_PY_HOST=0.0.0.0 AGENT_PY_PORT=9300 AGENT_PY_WORKDIR=/var/lib/agent-py
EXPOSE 9300
USER agent
CMD ["python", "-m", "agent_py.app"]
