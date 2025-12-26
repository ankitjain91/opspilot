from typing import Dict, Any
from ..state import AgentState
from ..prompts.architect.main import ARCHITECT_PROMPT
from ..llm import call_llm
from ..utils import emit_event
from ..tools.kb_search import get_relevant_kb_snippets

async def architect_node(state: AgentState) -> Dict[str, Any]:
    """
    The Architect: specialized node for Generative IaC.
    Uses Crossplane knowledge to generate valid YAML manifests.
    """
    query = state.get('query', '')
    events = list(state.get('events', []))
    
    print(f"[architect] [BUILD] Designing infrastructure for: '{query}'", flush=True)
    events.append(emit_event("progress", {"message": "[BUILD] Architecting solution..."}))

    # 1. Retrieve Knowledge (XRDs/Schemas)
    # We search specifically for infrastructure definitions
    kb_context = await get_relevant_kb_snippets(query, state, max_results=3, min_similarity=0.25)
    
    if not kb_context:
        print(f"[architect] [WARN] No specific infrastructure definitions found in KB.", flush=True)
        kb_context = "No specific Crossplane definitions found. Use standard Kubernetes resources."

    # 2. Call LLM to generate YAML
    prompt = ARCHITECT_PROMPT.format(
        query=query,
        kb_context=kb_context
    )

    try:
        response = await call_llm(
            prompt, 
            state['llm_endpoint'], 
            # Use specific coding model if available, else fall back to main model
            # For now use the main model (70B is good at code)
            state['llm_model'], 
            state.get('llm_provider', 'ollama'),
            temperature=0.1, # Low temp for deterministic code
            api_key=state.get('api_key')
        )

        # 3. Format Output
        # In the future, we will route this to GitCommit. 
        # For now, we return it as the final response.
        
        print(f"[architect] [OK] YAML generated.", flush=True)
        events.append(emit_event("progress", {"message": "[OK] Infrastructure design complete."}))

        return {
            **state,
            "final_response": response,
            "next_action": "done",
            "events": events
        }

    except Exception as e:
        print(f"[architect] [ERROR] Generation failed: {e}", flush=True)
        return {
            **state,
            "error": f"Architect failed: {e}",
            "next_action": "done", # Or route to specific error handler
            "events": events
        }
