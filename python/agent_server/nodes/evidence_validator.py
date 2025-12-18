"""
Evidence Validator Node - LLM-Driven Quality Gate

This node acts as a simple pass-through gate before the synthesizer.
Decision-making about evidence sufficiency is handled by the LLM in supervisor/synthesizer.

Key responsibilities:
1. Log validation checkpoint
2. Pass state to synthesizer for LLM-driven sufficiency check
"""

from typing import Dict
from ..state import AgentState
from ..utils import emit_event


async def evidence_validator_node(state: AgentState) -> Dict:
    """
    Evidence Validator: Simple pass-through gate.

    LLM-DRIVEN: All evidence sufficiency decisions are made by supervisor/synthesizer LLMs.
    This node just logs the checkpoint and passes state through.
    """
    query = state.get('query', '')
    iteration = state.get('iteration', 0)
    events = list(state.get('events', []))

    print(f"[evidence_validator] 🛡️ Checkpoint for query: '{query}' (iteration {iteration})", flush=True)

    # LLM-DRIVEN: No hardcoded validation rules
    # Synthesizer LLM will determine if evidence is sufficient

    events.append(emit_event("validation", {
        "status": "checkpoint",
        "iteration": iteration
    }))

    return {
        **state,
        'events': events,
        'next_action': 'synthesizer',
        'evidence_validation_passed': True
    }
