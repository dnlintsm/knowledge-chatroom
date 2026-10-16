# The sample's MCP server (lab_tools/server.py) for docker-compose.yml's
# `python-sample` profile:  docker build -t knowledge-chatroom-lab-tools examples/python-agent
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY lab_tools ./lab_tools

ENV LAB_TOOLS_HOST=0.0.0.0 LAB_TOOLS_PORT=9100
EXPOSE 9100
USER nobody
CMD ["python", "-m", "lab_tools.server"]
