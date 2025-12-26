"""
Intent Classification Chain - Structured multi-step query understanding

This replaces the monolithic supervisor prompt with a reliable 3-step chain:
1. Intent Classifier: What is the user asking?
2. Context Resolver: Do we have specific targets from previous context?
3. Command Planner: Generate commands for the intent

Benefits:
- Each step is small, focused, and hard to fail
- Explicit intent visible in logs for debugging
- Can validate/retry each step independently
- ~90% reduction in prompt complexity per step
"""

from dataclasses import dataclass
from typing import List, Optional, Literal
import json
from .llm import call_llm


# ============================================================================
# STEP 1: Intent Classification
# ============================================================================

IntentType = Literal[
    "service_exposure",      # Check Services, Ingress, LoadBalancers
    "gateway_check",         # Check Istio/Nginx/API gateways
    "pod_health",           # Check pod status, crashes, restarts
    "deployment_status",    # Check deployments, rollouts
    "resource_list",        # List resources (pods, services, etc.)
    "troubleshoot_issue",   # Debug/troubleshoot a problem
    "network_connectivity", # DNS, NetworkPolicy, connectivity
    "storage_check",        # PVCs, StorageClasses
    "rbac_check",           # RBAC, permissions
    "cluster_health",       # Overall cluster health
    "custom_resource",      # CRDs, Crossplane, custom resources
    "greeting",             # Hello, hi, etc.
    "explanation",          # What is X?
    "off_topic"             # Non-K8s queries
]

@dataclass
class IntentResult:
    """Output of intent classification"""
    intent: IntentType
    target_resources: List[str]  # K8s resource types to check (e.g., ['services', 'ingress'])
    confidence: float
    reasoning: str


INTENT_RESOURCE_MAP = {
    "service_exposure": ["services", "ingress", "ingress.networking.k8s.io"],
    "gateway_check": ["gateways.networking.istio.io", "virtualservices.networking.istio.io", "ingress"],
    "pod_health": ["pods", "events"],
    "deployment_status": ["deployments", "replicasets", "pods"],
    "resource_list": [],  # Determined by query
    "troubleshoot_issue": [],  # Determined by symptoms
    "network_connectivity": ["services", "networkpolicies", "pods"],
    "storage_check": ["persistentvolumeclaims", "persistentvolumes", "storageclasses"],
    "rbac_check": ["roles", "rolebindings", "clusterroles", "clusterrolebindings", "serviceaccounts"],
    "cluster_health": ["nodes", "pods", "events", "componentstatuses"],
    "custom_resource": [],  # Determined by query
    "greeting": [],
    "explanation": [],
    "off_topic": []
}


async def classify_intent(
    query: str,
    llm_endpoint: str,
    llm_model: str,
    llm_provider: str,
    api_key: Optional[str] = None
) -> IntentResult:
    """
    Step 1: Classify user intent into a specific category.

    Uses a focused prompt that maps queries to intents reliably.
    """

    prompt = f"""Classify the user's intent for this Kubernetes query.

Query: "{query}"

Choose ONE intent from this list:
- service_exposure: User wants to check Services, Ingress, LoadBalancers (e.g., "verify service exposures", "check exposed services", "what services are external")
- gateway_check: User wants to check gateways (Istio, Nginx, API Gateway) (e.g., "find gateway issues", "check istio gateway", "gateway status")
- pod_health: User wants to check pod status, crashes, restarts (e.g., "check pod health", "failing pods", "crashlooping pods")
- deployment_status: User wants to check deployments, rollouts (e.g., "deployment status", "check deployments", "rollout status")
- resource_list: User wants to list resources (e.g., "list pods", "show services", "get nodes")
- troubleshoot_issue: User wants to debug/troubleshoot a problem (e.g., "why is X failing", "debug issue", "troubleshoot problem")
- network_connectivity: User wants to check DNS, NetworkPolicy, connectivity (e.g., "network issues", "dns problems", "connectivity check")
- storage_check: User wants to check PVCs, volumes, storage (e.g., "storage issues", "check pvc", "volume status")
- rbac_check: User wants to check RBAC, permissions (e.g., "rbac issues", "check permissions", "who can access")
- cluster_health: User wants overall cluster health (e.g., "cluster health", "cluster status", "overall health")
- custom_resource: User mentions CRDs, Crossplane, custom resources (e.g., "check crossplane", "custom resources", "CRD status")
- greeting: User is greeting (e.g., "hello", "hi", "hey")
- explanation: User wants an explanation (e.g., "what is a pod?", "explain ingress")
- off_topic: Non-Kubernetes query

Reply in JSON format:
{{
  "intent": "<one of the intents above>",
  "confidence": <0.0-1.0>,
  "reasoning": "<1 sentence explaining why>"
}}

JSON:"""

    try:
        response = await call_llm(
            prompt,
            llm_endpoint,
            llm_model,
            llm_provider,
            temperature=0.1,
            api_key=api_key
        )

        # Parse JSON
        result = json.loads(response.strip())
        intent = result["intent"]
        confidence = float(result["confidence"])
        reasoning = result["reasoning"]

        # Map intent to target resources
        target_resources = INTENT_RESOURCE_MAP.get(intent, [])

        return IntentResult(
            intent=intent,
            target_resources=target_resources,
            confidence=confidence,
            reasoning=reasoning
        )

    except Exception as e:
        print(f"[intent_chain] [WARN] Intent classification failed: {e}", flush=True)
        # Fallback: assume troubleshooting intent
        return IntentResult(
            intent="troubleshoot_issue",
            target_resources=[],
            confidence=0.3,
            reasoning=f"Failed to classify intent: {e}"
        )


# ============================================================================
# STEP 2: Context Resolution
# ============================================================================

@dataclass
class ContextResult:
    """Output of context resolution"""
    needs_clarification: bool
    clarification_message: Optional[str]
    specific_targets: List[str]  # Specific resources from context (e.g., ["gateway/frontend@tetris"])
    reasoning: str


async def resolve_context(
    query: str,
    intent_result: IntentResult,
    conversation_history: List[dict],
    llm_endpoint: str,
    llm_model: str,
    llm_provider: str,
    api_key: Optional[str] = None
) -> ContextResult:
    """
    Step 2: Resolve context - check if we have specific targets or need clarification.

    Checks previous conversation for specific resources mentioned.
    """

    # Format conversation history
    context_str = ""
    if conversation_history:
        recent = conversation_history[-6:]  # Last 3 exchanges
        for msg in recent:
            role = msg.get('role', '').upper()
            content = msg.get('content', '')[:200]  # First 200 chars
            if role in ['USER', 'ASSISTANT']:
                context_str += f"{role}: {content}\n"

    if not context_str:
        context_str = "(No previous context)"

    prompt = f"""Check if we have specific targets from previous context or if we need clarification.

Current Query: "{query}"
Intent: {intent_result.intent}
Target Resource Types: {intent_result.target_resources}

Previous Conversation:
{context_str}

Answer these questions:

Q1: Does the previous conversation mention specific resource names/namespaces related to this query?
    (e.g., "gateway frontend in tetris namespace", "service myapp", "pod xyz-123")

Q2: Is the query ambiguous and needs clarification?
    (e.g., "gateway" could mean Istio, Nginx, or API Gateway)

Q3: Based on Q1-Q2, what should we do?

Reply in JSON:
{{
  "needs_clarification": true/false,
  "clarification_message": "message to ask user (null if not needed)",
  "specific_targets": ["resource/name@namespace", ...],
  "reasoning": "1-2 sentences explaining Q1-Q3"
}}

JSON:"""

    try:
        response = await call_llm(
            prompt,
            llm_endpoint,
            llm_model,
            llm_provider,
            temperature=0.2,
            api_key=api_key
        )

        result = json.loads(response.strip())

        return ContextResult(
            needs_clarification=result["needs_clarification"],
            clarification_message=result.get("clarification_message"),
            specific_targets=result.get("specific_targets", []),
            reasoning=result["reasoning"]
        )

    except Exception as e:
        print(f"[intent_chain] [WARN] Context resolution failed: {e}", flush=True)
        # Fallback: no clarification needed, no specific targets
        return ContextResult(
            needs_clarification=False,
            clarification_message=None,
            specific_targets=[],
            reasoning=f"Failed to resolve context: {e}"
        )


# ============================================================================
# STEP 3: Integration Helper
# ============================================================================

@dataclass
class ChainResult:
    """Complete chain output"""
    intent: IntentResult
    context: ContextResult

    def should_respond_immediately(self) -> bool:
        """Check if we should respond immediately (greeting, clarification, etc.)"""
        return (
            self.context.needs_clarification or
            self.intent.intent in ["greeting", "explanation", "off_topic"]
        )

    def get_immediate_response(self) -> Optional[str]:
        """Get immediate response if applicable"""
        if self.context.needs_clarification:
            return self.context.clarification_message
        return None

    def get_planning_context(self) -> dict:
        """Get enriched context for command planning"""
        return {
            "intent": self.intent.intent,
            "target_resources": self.intent.target_resources,
            "specific_targets": self.context.specific_targets,
            "reasoning": f"Intent: {self.intent.reasoning} | Context: {self.context.reasoning}"
        }


async def run_intent_chain(
    query: str,
    conversation_history: List[dict],
    llm_endpoint: str,
    llm_model: str,
    llm_provider: str,
    api_key: Optional[str] = None
) -> ChainResult:
    """
    Run the complete intent classification chain.

    Returns enriched context that makes command planning much easier.
    """

    print(f"[intent_chain] [LINK] Starting intent chain for query: '{query}'", flush=True)

    # Step 1: Classify intent
    intent_result = await classify_intent(query, llm_endpoint, llm_model, llm_provider, api_key)
    print(f"[intent_chain] [LOC] Intent: {intent_result.intent} (confidence: {intent_result.confidence:.2f})", flush=True)
    print(f"[intent_chain]    Reasoning: {intent_result.reasoning}", flush=True)
    print(f"[intent_chain]    Target resources: {intent_result.target_resources}", flush=True)

    # Step 2: Resolve context
    context_result = await resolve_context(
        query, intent_result, conversation_history,
        llm_endpoint, llm_model, llm_provider, api_key
    )
    print(f"[intent_chain] [TARGET] Context: needs_clarification={context_result.needs_clarification}", flush=True)
    print(f"[intent_chain]    Specific targets: {context_result.specific_targets}", flush=True)
    print(f"[intent_chain]    Reasoning: {context_result.reasoning}", flush=True)

    return ChainResult(intent=intent_result, context=context_result)
