import pytest
from unittest.mock import AsyncMock, patch
from agent_server.nodes.classifier import classifier_node, CLASSIFIER_PROMPT
from agent_server.prompts.supervisor import SUPERVISOR_PROMPT
from agent_server.state import AgentState

@pytest.mark.asyncio
async def test_supervisor_prompt_format():
    """Test that the supervisor prompt format string is valid and safely handles braces in regex cheatsheet."""
    # We don't need real values, just strings that don't trigger format errors themselves
    prompt = SUPERVISOR_PROMPT.format(
        kb_context="{}", # Should handle injected content
        examples="{}", 
        query="test query",
        kube_context="default",
        cluster_info="cluster info",
        discovered_context="discovered",
        conversation_context="{}",
        command_history="{}",
        mcp_tools_desc="{}"
    )
    assert "REGULAR EXPRESSION" in prompt or "REGEX" in prompt
    assert "{2,4}" in prompt # Should be literally present (from regex cheatsheet)
    assert "{" in prompt

@pytest.mark.asyncio
async def test_classifier_prompt_format():
    """Test that the classifier prompt format string is valid and handles json braces correctly."""
    query = "why is my pod crashing?"
    # This should NOT raise KeyError
    formatted = CLASSIFIER_PROMPT.format(query=query)
    assert query in formatted
    assert '"intent":' in formatted
    assert '{' in formatted # Should have single braces in final string

@pytest.mark.asyncio
async def test_reflect_prompt_format():
    """Test that the reflect prompt format string is valid."""
    from agent_server.prompts.reflect.main import REFLECT_PROMPT
    args = {
        "query": "foo",
        "last_command": "kubectl get pods",
        "result": "No resources",
        "hypothesis": "None",
        "discovered_context": "",
        "accumulated_evidence": "",
        "current_step": "Step 1"
    }
    # This should NOT raise KeyError
    prompt = REFLECT_PROMPT.format(**args)
    assert "foo" in prompt
    assert "\"directive\":" in prompt # JSON key
    assert "{" in prompt

@pytest.mark.asyncio
async def test_classifier_node_chat_intent():
    """Test classifier routing for chat intent."""
    state = AgentState(
        query="hello",
        llm_endpoint="http://mock",
        llm_model="mock-model"
    )
    
    # "hello" hits the fast path string check
    result = await classifier_node(state)
    assert result["next_action"] == "respond"
    assert "Hello" in result["final_response"]

@pytest.mark.asyncio
async def test_classifier_node_complex_intent():
    """Test classifier routing for complex intent via LLM mock."""
    state = AgentState(
        query="debug pod failure",
        llm_endpoint="http://mock",
        llm_model="mock-model"
    )

    # Mock call_llm
    with patch("agent_server.nodes.classifier.call_llm", new_callable=AsyncMock) as mock_llm:
        mock_llm.return_value = '{"intent": "complex", "reason": "test"}'
        
        result = await classifier_node(state)
        
        assert result["next_action"] == "supervisor"
        assert result.get("classification") == "complex"
        
        # Verify prompt format was called correctly
        _, kwargs = mock_llm.call_args
        assert "debug pod failure" in kwargs['prompt'] # prompt
