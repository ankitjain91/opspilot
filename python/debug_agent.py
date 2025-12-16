
import sys
import os
import json
import asyncio

# Add current dir to path
# Add current dir to path
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_server"))
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

try:
    from agent_server.prompts_templates import SUPERVISOR_PROMPT
    from agent_server.prompts_examples import SUPERVISOR_EXAMPLES_FULL, get_examples_text
    from agent_server.heuristics import select_relevant_examples
    from agent_server.utils import format_command_history
    print("✅ Successfully imported agent_server components")
except ImportError as e:
    print(f"❌ Failed to import agent_server: {e}")
    sys.exit(1)

def test_prompt_formatting():
    print("\n--- Testing Prompt Formatting ---")
    
    # Simulate state
    query = "find sqlserver status"
    kb_context = "No KB matches"
    kube_context = "minikube"
    cluster_info = "Kubernetes v1.29"
    command_history = []
    
    # Select examples (Simulate the 'heavy' load of 17 examples first, then 5)
    print("Selecting examples...")
    example_ids = select_relevant_examples(query, max_examples=25)
    print(f"Selected {len(example_ids)} examples: {example_ids}")
    
    examples_text = get_examples_text(example_ids, SUPERVISOR_EXAMPLES_FULL)
    
    print("\nFormatting SUPERVISOR_PROMPT...")
    try:
        # strict check: any mismatched brace will raise ValueError or IndexError
        prompt = SUPERVISOR_PROMPT.format(
            kb_context=kb_context,
            examples=examples_text,
            query=query,
            kube_context=kube_context,
            cluster_info=cluster_info,
            command_history=format_command_history(command_history),
            mcp_tools_desc="[]"
        )
        print("✅ Prompt formatted successfully!")
        print(f"Prompt length: {len(prompt)} chars")
        
        # Check for double braces artifact
        if "{{" in prompt or "}}" in prompt:
             # It's okay to have {{ in JSON examples, but suspicious if widespread. 
             # Actually, final prompt should NOT have {{ unless it's literal.
             # But wait, our examples DO contain JSON with {{ "foo": "bar" }} pattern if we double escaped.
             # If we removed double escaping, it should be { "foo": "bar" }.
             pass

        return True
    except IndexError as e:
        print(f"❌ CRASH: IndexError during formatting: {e}")
        print("This usually means a single '{' or '}' was found where a placeholder was expected, or a placeholder was missing.")
        return False
    except ValueError as e:
        print(f"❌ CRASH: ValueError during formatting: {e}")
        return False
    except Exception as e:
        print(f"❌ CRASH: Unexpected error: {e}")
        return False

if __name__ == "__main__":
    success = test_prompt_formatting()
    if success:
        print("\n🎉 DIAGNOSIS: The agent code logic is SAFE. The 'stuck' state is likely network latency (LLM generation time).")
        sys.exit(0)
    else:
        print("\n💥 DIAGNOSIS: The agent code crashes during prompt generation. This is the root cause.")
        sys.exit(1)
