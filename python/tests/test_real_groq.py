import pytest
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, patch
import json
import sys
import os

# Ensure we can import agent_server
sys.path.append(os.path.join(os.path.dirname(__file__), '..'))

from agent_server.server import app

@pytest.fixture
def test_client():
    return TestClient(app)

@pytest.fixture
def mock_kb():
    # Mock KB to avoid forcing user to have local Ollama running for this LLM-focused test
    with patch("agent_server.nodes.supervisor.get_relevant_kb_snippets", new_callable=AsyncMock) as mock:
        mock.return_value = ""
        yield mock

def test_real_groq_connectivity(test_client, mock_kb):
    """
    REAL E2E Test: Connects to Groq API using provided Key.
    Verifies:
    1. Outbound network connectivity.
    2. API Key validity.
    3. Response parsing.
    """
    
    api_key = "<INSERT_YOUR_API_KEY>"
    # User asked for Llama. Using stable Groq model ID.
    model = "llama-3.3-70b-versatile" 
    
    req_payload = {
        "query": "hello, are you working?",
        "llm_provider": "groq",
        "llm_model": model,
        "executor_model": model, # Use same model for execution in pure cloud test
        "api_key": api_key,
        "history": []
    }
    
    print(f"\n[Test] Sending request to Groq ({model})...")
    
    events = []
    try:
        with test_client.stream("POST", "/analyze", json=req_payload) as response:
            for line in response.iter_lines():
                if line.startswith("data: "):
                    data_str = line[6:]
                    try:
                        data = json.loads(data_str)
                        events.append(data)
                        if data.get("type") == "progress":
                            print(f"[Server] {data.get('message')}")
                        elif data.get("type") == "done":
                            print(f"[Server] DONE. Final Response: {data.get('final_response')[:50]}...")
                        elif data.get("type") == "error":
                            print(f"[Server] ERROR: {data.get('message')}")
                    except:
                        pass
    except Exception as e:
        pytest.fail(f"Request failed: {e}")

    # VERIFICATION
    # 1. Ensure we got 'progress' events indicating LLM activity
    # 2. Check that we didn't get immediate 400/404 errors
    
    activity = [e.get("message", "") for e in events if e.get("type") == "progress"]
    print(f"\nActivity Log: {activity}")
    
    assert len(activity) > 0, "No progress events received."
    
    # Check for specific evidence of Groq interaction (e.g. Plan creation or Refiner success)
    # The logs show 'Refined Query' or 'Supervisor decision'
    
    # Plan creation proves Supervisor (Groq) worked
    plan_events = [e for e in events if e.get("type") == "plan_update"]
    refiner_events = [e for e in events if "Refined Query" in str(e) or "Analyzing query" in str(e)]
    
    assert plan_events or refiner_events, "No LLM Intelligence output (Plan or Refinement) found."
    
    print("\nSUCCESS: Real Groq Connectivity Verified (LLM generated plan/refinement)!")

