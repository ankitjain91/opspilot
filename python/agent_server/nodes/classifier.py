from ..state import AgentState
from ..llm import call_llm
import json

CLASSIFIER_PROMPT = """You are a Kubernetes Intent Classifier.
Your job is to route the user's query to the correct handler.

QUERY: {query}

CATEGORIES:
1. "chat": Greetings, definitions, general questions, or off-topic.
   - Examples: "hello", "what is a pod?", "explain sidecars", "write a poem"
   
2. "simple": Single-step resource retrieval or status checks.
   - Examples: "get pods", "list nodes", "check status of api-server", "find failing pods"
   - Criteria: Can be answered with 1-2 kubectl commands. Known resource types.

3. "complex": Debugging, troubleshooting, "why" questions, or multi-step investigations.
   - Examples: "why is pod X crashing?", "troubleshoot network issue", "perform deep dive", "fix the broken release"
   - Criteria: Requires reasoning, logs analysis, or multiple steps.

4. "navigation": UI navigation requests (if applicable, otherwise treat as chat).

OUTPUT JSON:
{{
    "intent": "chat" | "simple" | "complex",
    "reason": "Brief explanation",
    "confidence": 0.0 to 1.0
}}
"""

async def classifier_node(state: AgentState) -> dict:
    """
    Fast routing node for greetings. All other queries go directly to supervisor.

    NOTE (High #10 fix): Classification output was unused by supervisor, causing wasted LLM calls.
    Now simplified to only handle greetings, everything else routes to supervisor.
    """
    # Native AI Refactor: Bypass brittle hardcoded classifier
    # We send EVERYTHING to the Supervisor, which is smart enough to handle greetings.
    return {"next_action": "supervisor"}
