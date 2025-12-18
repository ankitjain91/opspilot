import pytest
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, patch, MagicMock
import json
import sys
import os

# Ensure we can import agent_server
sys.path.append(os.path.join(os.path.dirname(__file__), '..'))

from agent_server.server import app

# Helper to mock httpx response
class MockResponse:
    def __init__(self, status_code, json_data=None, text_data=""):
        self.status_code = status_code
        self._json = json_data or {}
        self.text = text_data or json.dumps(self._json)

    def json(self):
        return self._json
    
    def raise_for_status(self):
        if self.status_code >= 400:
            raise Exception(f"HTTP Error {self.status_code}")

@pytest.fixture
def test_client():
    return TestClient(app)

def test_embedding_endpoint_configuration_flow(test_client):
    """
    Backend E2E: Verify that passing 'embedding_endpoint' works and overrides heuristics.
    Simulates: UI -> /embedding-model/status -> search.py -> External API
    """
    
    # 1. Test with Explicit Endpoint (e.g. User sets remote Ollama)
    custom_endpoint = "http://192.168.1.100:11434"
    model = "nomic-embed-text"
    
    # We need to mock httpx inside search.py to capture the URL it tries to hit
    with patch("agent_server.tools.search.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        
        # Mock response for /api/tags
        mock_client.get.return_value = MockResponse(200, {"models": [{"name": "nomic-embed-text:latest"}]})
        
        # Call the API
        resp = test_client.get(
            f"/embedding-model/status",
            params={
                "llm_endpoint": "https://api.groq.com/openai/v1", # Fallback
                "model_name": model,
                "embedding_endpoint": custom_endpoint # Explicit
            }
        )
        
        assert resp.status_code == 200
        data = resp.json()
        assert data["available"] is True
        
        # VERIFICATION: Did usage of 'custom_endpoint' happen?
        # Check the URL passed to mock_client.get
        # The code usually calls f"{clean_endpoint}/api/tags"
        
        # We expect search.py to use `custom_endpoint` because it was explicitly provided,
        # ignoring the "is_local_model -> force localhost" heuristic properly now.
        
        calls = mock_client.get.call_args_list
        assert len(calls) > 0
        called_url = calls[0][0][0]
        assert "http://192.168.1.100:11434" in called_url
        assert "localhost" not in called_url

@pytest.fixture
def mock_deps():
    with patch("agent_server.nodes.supervisor.get_relevant_kb_snippets", new_callable=AsyncMock) as mock_kb, \
         patch("agent_server.nodes.classifier.call_llm", new_callable=AsyncMock) as mock_classifier_llm:
        
        mock_kb.return_value = ""
        # Mock classifier to force "complex" intent so we go to Supervisor where retry logic lives
        mock_classifier_llm.return_value = '{"intent": "complex", "reason": "test"}'
        yield mock_kb, mock_classifier_llm

def test_groq_retry_on_400_logic(test_client, mock_deps):
    """
    Backend E2E: Verify that a 400 Bad Request triggers a retry without JSON mode.
    """
    
    with patch("agent_server.llm.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        
        # Scenario:
        # Supervisor called.
        # 1st call: Returns 400 (Bad Request)
        # 2nd call: Returns 200 (OK)
        
        mock_client.post.side_effect = [
            MockResponse(400, text_data='{"error": {"message": "Output JSON was not found in prompt"}}'), # Fail (with force_json=True)
            MockResponse(200, json_data={"choices": [{"message": {"content": "{\"next_action\": \"done\", \"final_response\": \"Success\"}"}}]}) # Success (with force_json=False)
        ]
        
        req_payload = {
            "query": "complex query",
            "llm_provider": "groq",
            "llm_model": "llama3-70b-8192",
            "api_key": "gsk_fake_key"
        }

        try:
             with test_client.stream("POST", "/analyze", json=req_payload) as response:
                 for _ in response.iter_lines(): pass
        except Exception:
             pass 
             
        # VERIFICATION:
        assert mock_client.post.call_count >= 2
        
        # Check args of calls
        # Note: Depending on internals, other calls might happen. We look for the sequence.
        # We expect a call WITH response_format, then ONE WITHOUT.
        
        calls_with_json = [c for c in mock_client.post.call_args_list if "response_format" in c[1]['json']]
        calls_without_json = [c for c in mock_client.post.call_args_list if "response_format" not in c[1]['json']]
        
        assert len(calls_with_json) >= 1
        assert len(calls_without_json) >= 1
        print("\nSUCCESS: Groq retry logic verified!")

def test_api_key_propagation(test_client, mock_deps):
    """
    Backend E2E: Verify API Key is passed correctly to headers.
    """
    api_key = "gsk_secret_key_123"
    
    with patch("agent_server.llm.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client_cls.return_value.__aenter__.return_value = mock_client
        mock_client.post.return_value = MockResponse(200, json_data={"choices": [{"message": {"content": "{\"next_action\": \"done\", \"final_response\": \"ok\"}"}}]})

        req_payload = {
            "query": "complex query",
            "llm_provider": "groq",
            "api_key": api_key
        }
        
        with test_client.stream("POST", "/analyze", json=req_payload) as response:
             for _ in response.iter_lines(): break
             
        # Check headers of ANY call
        assert mock_client.post.called
        call_kwargs = mock_client.post.call_args[1]
        headers = call_kwargs['headers']
        assert headers["Authorization"] == f"Bearer {api_key}"
