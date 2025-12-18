#!/bin/bash
export LLM_HOST="http://20.56.146.53:11434"
export LLM_MODEL="opspilot-brain:latest"
export EXECUTOR_MODEL="qwen2.5:72b"
source venv/bin/activate
python -m uvicorn agent_server.server:app --host 0.0.0.0 --port 8766 --log-level info
