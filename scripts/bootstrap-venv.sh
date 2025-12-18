#!/usr/bin/env bash
set -euo pipefail

# Simple one-liner style bootstrap for local dev
# Creates .venv and installs agent dependencies

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

PYTHON=${PYTHON:-python3}
VENV_DIR=${VENV_DIR:-.venv}
REQ_FILE=${REQ_FILE:-python/requirements.txt}

if [ ! -d "$VENV_DIR" ]; then
  echo "Creating virtual environment in $VENV_DIR"
  "$PYTHON" -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

if [ -f "$REQ_FILE" ]; then
  echo "Installing dependencies from $REQ_FILE"
  python -m pip install --upgrade pip
  python -m pip install -r "$REQ_FILE"
else
  echo "requirements file not found at $REQ_FILE; installing minimal set"
  python -m pip install fastapi uvicorn httpx langgraph langchain-core pydantic kubernetes-asyncio sse-starlette aiohttp rank-bm25
fi

echo "Done. Activate with: source $VENV_DIR/bin/activate"
