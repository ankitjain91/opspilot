import sys
import os

# Ensure we can import the agent code
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../agent_server')))

from agent_server.prompts.supervisor import SUPERVISOR_PROMPT

def test_supervisor_prompt_formatting():
    """
    Verify that the SUPERVISOR_PROMPT can be formatted with its expected arguments
    without crashing due to unescaped braces (e.g. 'Replacement index 0 out of range').
    """
    print("Testing SUPERVISOR_PROMPT formatting...")
    
    # Dummy data representing what supervisor_node passes to format()
    dummy_args = {
        "kb_context": "KB Context Placeholder",
        "examples": "Examples Placeholder",
        "query": "Query Placeholder",
        "kube_context": "test-context",
        "cluster_info": "Cluster Info Placeholder",
        "discovered_context": "Discovered Context Placeholder",
        "conversation_context": "Conversation Context Placeholder",
        "command_history": "Command History Placeholder",
        "mcp_tools_desc": "[]"
    }

    try:
        formatted = SUPERVISOR_PROMPT.format(**dummy_args)
        print("✅ SUPERVISOR_PROMPT formatted successfully!")
        print(f"Length: {len(formatted)} chars")
    except Exception as e:
        print(f"❌ Formatting FAILED: {e}")
        # Fail the test
        sys.exit(1)

if __name__ == "__main__":
    test_supervisor_prompt_formatting()
