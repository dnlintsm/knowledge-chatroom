# The paper search MCP server (papers_mcp/server.py) for docker-compose.yml's
# `papers` profile:  docker build -t knowledge-chatroom-papers examples/papers-mcp
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY papers_mcp ./papers_mcp

ENV PAPERS_HOST=0.0.0.0 PAPERS_PORT=9200
EXPOSE 9200
USER nobody
CMD ["python", "-m", "papers_mcp.server"]
