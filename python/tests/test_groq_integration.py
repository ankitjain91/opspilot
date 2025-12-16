import pytest
import os
from unittest.mock import MagicMock, patch, AsyncMock
from agent_server.llm import SmartLLMClient
from agent_server.tools.search import embed_texts, check_embedding_model_available

@pytest.mark.asyncio
async def test_smart_llm_client_dynamic_key():
    """Verify SmartLLMClient attempts Groq call when key is passed explicitly."""
    
    with patch.dict(os.environ, {}, clear=True):
        client = SmartLLMClient()
        assert client.provider_health["groq"] is True
        
        # Mock _call_groq specifically
        with patch.object(client, '_call_groq', new_callable=AsyncMock) as mock_groq:
            mock_groq.return_value = '{"response": "Success"}'
            
            await client.call(
                prompt="test", 
                endpoint="", 
                model="llama3-70b-8192", 
                provider="groq", 
                api_key="gsk_test_key_123"
            )
            
            mock_groq.assert_called_once()
            # Assert API key was passed (5th argument)
            call_args = mock_groq.call_args
            assert call_args[0][4] == 'gsk_test_key_123'

@pytest.mark.asyncio
async def test_embedding_routing_local_override():
    """Verify 'nomic-embed-text' is routed to localhost even if endpoint is Cloud."""
    
    # Setup Mock Response
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"models": [{"name": "nomic-embed-text:latest"}], "embedding": [0.1]}
    mock_resp.raise_for_status = MagicMock()

    # Setup Async Client Mock
    mock_client = AsyncMock()
    mock_client.get.return_value = mock_resp
    mock_client.post.return_value = mock_resp
    
    # Patch the class to return our mock on __aenter__
    with patch("httpx.AsyncClient") as mock_cls:
        mock_cls.return_value.__aenter__.return_value = mock_client
        
        # Call with a CLOUD endpoint but LOCAL model
        await embed_texts(
            texts=["test query"], 
            endpoint="https://api.groq.com/openai/v1", 
            model_name="nomic-embed-text"
        )
        
        # Check the POST call URL
        post_calls = mock_client.post.call_args_list
        url = post_calls[0][0][0]
        assert "localhost:11434" in url
        assert "/api/embeddings" in url
        # Verify payload has model
        json_body = post_calls[0].kwargs['json']
        assert json_body['model'] == 'nomic-embed-text'

@pytest.mark.asyncio
async def test_embedding_routing_cloud_openai():
    """Verify 'text-embedding-3-small' is routed to OpenAI with auth header."""
    
    # Mock Response
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    # Provide valid OpenAI format structure
    mock_resp.json.return_value = {"data": [{"embedding": [0.9, 0.8]}]}
    mock_resp.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post.return_value = mock_resp

    with patch("httpx.AsyncClient") as mock_cls:
        mock_cls.return_value.__aenter__.return_value = mock_client

        # Call with OpenAI model and Key
        await embed_texts(
            texts=["test"], 
            endpoint="", 
            model_name="text-embedding-3-small",
            api_key="sk-test-key"
        )
        
        # Verify URL is OpenAI
        post_calls = mock_client.post.call_args_list
        url = post_calls[0][0][0]
        assert "api.openai.com/v1/embeddings" in url
        
        # Verify Headers contained Key
        headers = post_calls[0].kwargs['headers']
        assert headers['Authorization'] == "Bearer sk-test-key"
