
import os
import json
import httpx
import asyncio
from typing import Literal, Any
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .config import EMBEDDING_MODEL, KB_DIR
from .state import AgentState, CommandHistory
from .utils import get_cluster_recon, log_session, emit_event
from .graph import create_k8s_agent
from .tools import kb_search as search
from langgraph.checkpoint.memory import MemorySaver


# 2222 Initialize Checkpointer (In-memory for now to support async/streaming without complex dependencies)
checkpointer = MemorySaver()

# Create the agent workflow with persistence
agent = create_k8s_agent(checkpointer=checkpointer)

# Session Storage: Persist conversation state across queries with same thread_id
# Key: thread_id -> Value: {
#   command_history: list,
#   discovered_resources: dict,
#   accumulated_evidence: list,
#   last_query: str,
#   last_updated: timestamp,
#   conversation_turns: int
# }
session_store = {}

# Session configuration
SESSION_MAX_HISTORY = 20  # Keep last N command history entries (recency window)
SESSION_MAX_AGE_MINUTES = 30  # Auto-expire sessions older than this
SESSION_MAX_TURNS = 50  # Hard limit on conversation turns before suggesting reset

# Background Sentinel (Lazy init)
from .sentinel import SentinelLoop
global_sentinel = None

# --- Session Management Helpers ---
def get_session_state(thread_id: str) -> dict | None:
    """
    Retrieve session state for a thread_id.
    Returns None if session doesn't exist or has expired.
    Applies recency windowing to command_history.
    """
    import time
    from datetime import datetime, timedelta

    if thread_id not in session_store:
        return None

    session = session_store[thread_id]
    last_updated = session.get('last_updated', 0)

    # Check if session has expired
    age_minutes = (time.time() - last_updated) / 60
    if age_minutes > SESSION_MAX_AGE_MINUTES:
        # Session expired, starting fresh
        del session_store[thread_id]
        return None

    # Apply recency window to command_history
    command_history = session.get('command_history', [])
    if len(command_history) > SESSION_MAX_HISTORY:
        # Keep only the most recent entries
        command_history = command_history[-SESSION_MAX_HISTORY:]
        # Applied recency window to command history

    # LLM-DRIVEN FIX: accumulated_evidence is query-specific
    # Return it but let the caller decide whether to use it based on query matching
    return {
        'command_history': command_history,
        'conversation_history': session.get('conversation_history', []),
        'discovered_resources': session.get('discovered_resources'),
        'accumulated_evidence': session.get('accumulated_evidence', []),
        'last_query': session.get('last_query', ''),
        'conversation_turns': session.get('conversation_turns', 0)
    }

def update_session_state(thread_id: str, state: dict):
    """
    Update session state after a query completes.
    Stores command_history, discovered_resources, accumulated_evidence.
    """
    import time

    # Get current turn count
    existing = session_store.get(thread_id, {})
    turns = existing.get('conversation_turns', 0) + 1

    # Warn if approaching max turns
    if turns >= SESSION_MAX_TURNS:
        print(f"[Session] ⚠️ Thread {thread_id} has {turns} turns. Consider resetting for optimal performance.", flush=True)

    # LLM-DRIVEN FIX: Persist accumulated_evidence for query retries
    # It will be cleared when a new different query starts
    session_store[thread_id] = {
        'command_history': state.get('command_history', []),
        'conversation_history': state.get('conversation_history', []),
        'discovered_resources': state.get('discovered_resources'),
        'accumulated_evidence': state.get('accumulated_evidence', []),
        'last_query': state.get('query', ''),
        'last_updated': time.time(),
        'conversation_turns': turns
    }

    # Session updated silently (verbose logging disabled)

def clear_session(thread_id: str):
    """Clear session state for a thread_id."""
    if thread_id in session_store:
        del session_store[thread_id]
        print(f"[Session] Cleared thread {thread_id}", flush=True)

# --- Helpers for phase tracking, hypothesis visibility, coverage checks ---
def compute_coverage_snapshot(state: dict) -> dict:
    """Assess whether key signals were collected during investigation."""
    hist = [h for h in (state.get('command_history') or []) if h]
    outputs = "\n".join([(h.get('command','') + "\n" + (h.get('output','') or '')) for h in hist])
    def seen(substr: str) -> bool:
        return substr in outputs
    return {
        'nodes_checked': any('kubectl get nodes' in (h.get('command','')) for h in hist) or seen('NAME   STATUS'),
        'pods_checked': any('kubectl get pods' in (h.get('command','')) for h in hist) or seen('No resources found') or seen('Running') or seen('CrashLoopBackOff'),
        'events_checked': any('kubectl get events' in (h.get('command','')) for h in hist) or seen('Warning') or seen('Normal'),
        'resource_usage_checked': any('kubectl top' in (h.get('command','')) for h in hist) or seen('CPU') or seen('Memory'),
    }

def emit_phase_event(name: str, detail: str = "") -> dict:
    return emit_event('phase', {'phase': name, 'detail': detail})

def emit_hypotheses_event(hypotheses: list[dict]) -> dict:
    return emit_event('hypotheses', {'items': hypotheses})

def verify_goal_completion(query: str, command_history: list[dict], final_answer: str | None) -> dict:
    """Assess if the user's goal appears satisfied based on outputs and the final answer.

    Heuristics:
    - If any command history assessment is 'SOLVED'/'RESOLVED', mark met.
    - For yes/no queries (is/are/does), look for affirmative/negative explicit statements in final_answer.
    - For discovery-type queries ("why", "root cause"), require presence of cause + evidence snippets.
    - For action requests ("fix", "restart"), require approval gating or confirmation that no mutations were performed.
    """
    met = False
    reason = ""

    # 1) Command history hints
    hist = [h for h in (command_history or []) if h]
    for h in hist:
        if str(h.get('assessment','')).upper() in ['SOLVED','RESOLVED','CONFIRMED']:
            met = True
            reason = "Investigation step marked as SOLVED/RESOLVED."
            break

    ans = (final_answer or "").strip().lower()
    q = (query or "").strip().lower()

    # 2) Yes/No nature
    if not met and any(q.startswith(w) for w in ['is ','are ','does ','do ','can ','should ']):
        if any(kw in ans for kw in ['yes,','yes.','no,','no.','there is','there are','none found','no evidence']):
            met = True
            reason = "Final answer contains an explicit affirmative/negative statement."

    # 3) Why/root cause style
    if not met and any(w in q for w in ['why','root cause','reason','cause','failed','error']):
        if any(term in ans for term in ['because','due to','caused by','root cause','likely cause','failure reason']):
            met = True
            reason = "Final answer explains cause using explicit causal language."

    # 4) Action requests
    if any(w in q for w in ['fix','resolve','restart','delete','scale','patch','apply','kubectl ']):
        # If we required approval or avoided mutation, we consider goal unmet unless explicitly stated
        if 'approval' in ans or 'manual approval' in ans or 'cannot perform' in ans or 'read-only' in ans:
            met = False
            reason = "Action requested but mutations gated by approval or read-only mode."

    return {'met': met, 'reason': reason or ('Final answer insufficiently explicit; recommend follow-up or extend investigation.' if not met else 'Goal appears satisfied from heuristics.')}

def check_exhaustive_attempts(state: dict) -> dict:
    """Ensure the agent tried sufficiently diverse approaches before concluding.

    Criteria:
    - Minimum number of distinct commands executed (>= 3).
    - Diversity across categories: nodes/pods/events/resource-usage or equivalent MCP tool calls.
    - If MCP tools are available, at least one was attempted when relevant.
    """
    hist = state.get('command_history') or []
    cmds = [h.get('command','') for h in hist]
    distinct_count = len({c for c in cmds if c})
    outputs_joined = "\n".join([h.get('output','') or '' for h in hist])

    cov = compute_coverage_snapshot(state)
    diversity = sum(1 for v in cov.values() if v)

    # MCP tool attempts
    used_mcp = any(str(c).startswith('MCP_TOOL:') for c in cmds)
    available_mcp = bool(state.get('mcp_tools'))

    sufficient = distinct_count >= 3 and diversity >= 2 and (not available_mcp or used_mcp or distinct_count >= 5)
    gaps = []
    if distinct_count < 3:
        gaps.append('insufficient_command_variety')
    if diversity < 2:
        gaps.append('insufficient_signal_diversity')
    if available_mcp and not used_mcp:
        gaps.append('mcp_tools_not_used')

    return {
        'sufficient': sufficient,
        'distinct_commands': distinct_count,
        'signal_diversity': diversity,
        'mcp_tools_used': used_mcp,
        'gaps': gaps,
    }


# Background Sentinel (Lazy init)
from .sentinel import SentinelLoop
global_sentinel = None

# --- Global Broadcasting (SSE) ---
import asyncio
from sse_starlette.sse import EventSourceResponse


from collections import deque

class CircularBuffer:
    """Fixed-size circular buffer for storing recent events."""
    def __init__(self, capacity: int = 100):
        self._buffer = deque(maxlen=capacity)
    
    def add(self, item: Any):
        self._buffer.append(item)
        
    def get_all(self) -> list[Any]:
        return list(self._buffer)

class GlobalBroadcaster:
    def __init__(self):
        self._queues = set()
        self._history = CircularBuffer(100) # Keep last 100 events

    async def subscribe(self):
        q = asyncio.Queue()
        self._queues.add(q)
        try:
            # Replay history first
            for event in self._history.get_all():
                yield {"data": json.dumps(event)}
                
            # Then stream new events
            while True:
                msg = await q.get()
                yield msg
        except asyncio.CancelledError:
            self._queues.remove(q)

    async def broadcast(self, event: dict):
        # Store in history
        self._history.add(event)
        
        # Format as SSE data
        import json
        payload = {"data": json.dumps(event)}
        # Send to all connected clients
        for q in self._queues:
            await q.put(payload)

broadcaster = GlobalBroadcaster()


# --- startup ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    print("K8s Agent Server starting...")

    # Initialize Sentinel with broadcaster (DISABLED for testing - Azure auth expired)
    global global_sentinel
    global_sentinel = None  # SentinelLoop(kube_context=None, broadcaster=broadcaster)

    sentinel_task = None  # asyncio.create_task(global_sentinel.start())

    # TODO: Background task for multi-context CRD pre-warming
    # Currently disabled - CRD loading is instant without kubectl explain
    # Future: Pre-load CRDs for all kubectl contexts for zero-latency context switching
    prewarm_task = None

    yield

    print("K8s Agent Server shutting down...")
    if global_sentinel:
        await global_sentinel.stop()
    if sentinel_task:
        sentinel_task.cancel()
        try:
            await sentinel_task
        except asyncio.CancelledError:
            pass

app = FastAPI(
    title="K8s Troubleshooting Agent",
    description="LangGraph-based Kubernetes troubleshooting agent (Dual Model, Embeddings RAG)",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/events")
async def events_stream():
    """Global event stream for background alerts (Sentinel)."""
    return EventSourceResponse(broadcaster.subscribe())


from .llm import list_available_models
from .llm import call_llm

class ModelsRequest(BaseModel):
    provider: str
    api_key: str | None = None
    base_url: str | None = None

@app.post("/llm/models")
async def get_models(request: ModelsRequest):
    """Fetch available models for the given provider."""
    models = await list_available_models(request.provider, request.api_key, request.base_url)
    return {"models": models}

class TestRequest(BaseModel):
    provider: Literal["groq", "openai", "ollama", "anthropic", "claude-code"]
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None

@app.post("/llm/test")
async def test_llm_connection(request: TestRequest):
    """Test connectivity and credentials for the given LLM provider.

    For Groq/OpenAI: attempts to list models and perform a tiny completion.
    For Ollama: checks /api/tags and performs a tiny generate.
    """
    try:
        # Step 1: List models (quick credential check)
        models = await list_available_models(request.provider, request.api_key, request.base_url)
        connected = len(models) > 0

        # Step 2: Tiny completion to verify actual usage (optional)
        completion_ok = False
        completion_error = None
        try:
            tiny_model = request.model or (models[0] if models else None)
            if tiny_model:
                resp = await call_llm(
                    prompt="ping",
                    endpoint=request.base_url or ("http://localhost:11434" if request.provider == "ollama" else ""),
                    model=tiny_model,
                    provider=request.provider,
                    temperature=0.0,
                    force_json=False,
                    api_key=request.api_key,
                )
                completion_ok = resp is not None and not str(resp).startswith("Error:")
            else:
                completion_error = "No model available to test"
        except Exception as e:
            completion_error = str(e)

        return {
            "provider": request.provider,
            "connected": connected,
            "models_count": len(models),
            "completion_ok": completion_ok,
            "error": None if connected else "Model listing failed or no models returned",
            "completion_error": completion_error,
        }
    except Exception as e:
        return {
            "provider": request.provider,
            "connected": False,
            "models_count": 0,
            "completion_ok": False,
            "error": str(e),
            "completion_error": str(e),
        }

class AgentRequest(BaseModel):
    """Request to run the agent."""
    query: str
    thread_id: str = "default_session" # Added for Persistence
    kube_context: str = ""
    llm_endpoint: str = "http://localhost:11434"
    llm_provider: str = "ollama"
    llm_model: str = "opspilot-brain"
    executor_model: str = "k8s-cli"
    embedding_model: str | None = None
    embedding_endpoint: str | None = None
    api_key: str | None = None
    history: list[CommandHistory] = []
    conversation_history: list[dict] = []  # Multi-turn context
    approved_command: bool = False
    mcp_tools: list[dict] = []
    # Human-in-the-loop controls
    user_hint: str | None = None  # User guidance for next step
    skip_current_step: bool = False  # Skip current plan step
    pause_after_step: bool = False  # Pause for approval after each step
    tool_output: dict | None = None  

@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}

@app.get("/embedding-model/status")
async def embedding_model_status(llm_endpoint: str = "http://localhost:11434", model_name: str | None = None, embedding_endpoint: str | None = None):
    """Check if the embedding model is available."""
    
    # Use the shared state from search module (it manages the global var)
    # If embedding_endpoint is provided, use it; otherwise fallback to llm_endpoint (legacy)
    target_endpoint = embedding_endpoint or llm_endpoint
    is_available = await search.check_embedding_model_available(target_endpoint, model_name=model_name)
    
    # We still need to get model size info for the UI
    base = target_endpoint or ""
    clean_endpoint = base.rstrip('/').removesuffix('/v1').rstrip('/') if base else "http://localhost:11434"
    model_size = None

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{clean_endpoint}/api/tags", timeout=10.0)
            if resp.status_code == 200:
                models = resp.json().get("models", [])
                target = (model_name or EMBEDDING_MODEL).split(":")[0]
                for m in models:
                    if m.get("name", "").split(":")[0] == target:
                        model_size = m.get("size", 0)
                        break
        
        return {
            "model": EMBEDDING_MODEL,
            "available": is_available,
            "size_bytes": model_size,
            "size_mb": round(model_size / (1024 * 1024), 1) if model_size else None,
            "ollama_connected": True
        }
    except Exception as e:
        return {
            "model": EMBEDDING_MODEL,
            "available": False,
            "ollama_connected": False,
            "error": str(e)
        }

@app.post("/embedding-model/pull")
async def pull_embedding_model(llm_endpoint: str = "http://localhost:11434", embedding_endpoint: str | None = None):
    """Pull/download the embedding model with user consent."""
    
    target_endpoint = embedding_endpoint or llm_endpoint
    base = target_endpoint or ""
    clean_endpoint = base.rstrip('/').removesuffix('/v1').rstrip('/') if base else "http://localhost:11434"

    async def stream_progress():
        async with httpx.AsyncClient() as client:
            try:
                # Start pull with streaming
                async with client.stream(
                    "POST",
                    f"{clean_endpoint}/api/pull",
                    json={"name": EMBEDDING_MODEL, "stream": True},
                    timeout=600.0  # 10 min timeout
                ) as response:
                    async for line in response.aiter_lines():
                        if line:
                            try:
                                data = json.loads(line)
                                # Forward progress events
                                if "status" in data:
                                    progress = {
                                        "status": data.get("status"),
                                        "completed": data.get("completed", 0),
                                        "total": data.get("total", 0),
                                    }
                                    if data.get("total", 0) > 0:
                                        progress["percent"] = round(100 * data["completed"] / data["total"], 1)
                                    yield f"data: {json.dumps(progress)}\n\n"
                            except json.JSONDecodeError:
                                pass

                    # Mark as available after successful pull (update search module state)
                    search.embedding_model_available = True
                    yield f"data: {json.dumps({'status': 'success', 'message': f'Model {EMBEDDING_MODEL} ready'})}\n\n"

            except Exception as e:
                yield f"data: {json.dumps({'status': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(stream_progress(), media_type="text/event-stream")


@app.get("/kb-embeddings/status")
async def kb_embeddings_status(llm_endpoint: str = "http://localhost:11434"):
    """Check if KB embeddings are available (either pre-computed or cached)."""
    
    # Check for pre-computed embeddings (bundled with app)
    precomputed_path = search.find_precomputed_embeddings()
    if precomputed_path and os.path.isfile(precomputed_path):
        try:
            with open(precomputed_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            doc_count = len(data.get("documents", []))
            return {
                "available": True,
                "source": "bundled",
                "document_count": doc_count,
                "path": precomputed_path,
            }
        except Exception:
            pass  # Fall through to check cache

    # Check for user-local cached embeddings
    cache_path = search.get_kb_cache_path()
    if os.path.isfile(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            doc_count = len(data.get("documents", []))
            return {
                "available": True,
                "source": "cached",
                "document_count": doc_count,
                "path": cache_path,
            }
        except Exception:
            pass

    # No embeddings available - check if we can generate them
    embed_available = await search.check_embedding_model_available(llm_endpoint)

    # Count KB files that would be embedded
    kb_file_count = 0
    if os.path.isdir(KB_DIR):
        for name in os.listdir(KB_DIR):
            if name.endswith(('.json', '.jsonl', '.md')) and name != 'kb-index.json':
                kb_file_count += 1

    return {
        "available": False,
        "source": None,
        "document_count": 0,
        "kb_files_found": kb_file_count,
        "can_generate": embed_available,
        "embedding_model": EMBEDDING_MODEL,
        "embedding_model_available": embed_available,
    }

@app.post("/kb-embeddings/generate")
async def generate_kb_embeddings(llm_endpoint: str = "http://localhost:11434", model_name: str | None = None, embedding_endpoint: str | None = None):
    """Generate KB embeddings using local Ollama and cache them."""
    target_endpoint = embedding_endpoint or llm_endpoint
    return StreamingResponse(search.generate_kb_embeddings_generator(target_endpoint, model_name=model_name), media_type="text/event-stream")

@app.delete("/session/{thread_id}")
async def clear_session_endpoint(thread_id: str):
    """Clear session state for a given thread_id."""
    clear_session(thread_id)
    return {"status": "success", "message": f"Session {thread_id} cleared"}

@app.post("/analyze")
async def analyze(request: AgentRequest):
    """Run the K8s troubleshooting agent with SSE streaming."""
    try:
        print(f"DEBUG REQUEST: {request.query} (Approved: {request.approved_command})", flush=True)

        # Gather cluster context for first request only (cached for subsequent)
        if not request.history:
            print("DEBUG: Gathering cluster info...", flush=True)
            cluster_info = await get_cluster_recon(request.kube_context)
        else:
            cluster_info = "Using cached cluster context from conversation history"

        print(f"DEBUG: Analyze Request - Provider: {request.llm_provider}, Model: {request.llm_model}", flush=True)
        if request.api_key:
             print(f"DEBUG: API Key received: ...{request.api_key[-4:]}", flush=True)
        else:
             print(f"DEBUG: No API Key in request", flush=True)

        # Check for extension mode
        extend_mode = False
        qtext = (request.query or "").strip()
        if qtext.startswith("[EXTEND]"):
            extend_mode = True

        # Auto-align Executor Model for Cloud Providers
        # If user selects Groq/OpenAI but leaves Executor as default 'k8s-cli' (local Ollama),
        # we should switch Executor to the main model to avoid "Model not found" errors.
        executor_model = request.executor_model
        if request.llm_provider in ["groq", "openai", "anthropic"] and executor_model == "k8s-cli":
             print(f"DEBUG: Auto-switching Executor from 'k8s-cli' to '{request.llm_model}' for provider '{request.llm_provider}'", flush=True)
             executor_model = request.llm_model

        # Load session state for conversation continuity
        session_state = get_session_state(request.thread_id)
        if session_state:
            # Loaded existing session
            pass
        else:
            # Starting new session
            pass

        # QUERY REWRITING: Transform vague queries into actionable tasks
        from .query_rewriter import rewrite_query
        original_query = request.query
        print(f"[Query Rewriter] Original query: {original_query}", flush=True)

        try:
            rewritten = await rewrite_query(
                user_query=original_query,
                context=request.kube_context,
                llm_endpoint=request.llm_endpoint,
                llm_model=request.llm_model,
                llm_provider=request.llm_provider,
                api_key=request.api_key
            )

            if rewritten.confidence > 0.5:
                print(f"[Query Rewriter] ✅ Rewrote query (confidence: {rewritten.confidence})", flush=True)
                print(f"[Query Rewriter] Detected resources: {rewritten.detected_resources}", flush=True)
                print(f"[Query Rewriter] New query: {rewritten.rewritten_query}", flush=True)
                final_query = rewritten.rewritten_query
            else:
                print(f"[Query Rewriter] ⚠️ Low confidence ({rewritten.confidence}), using original query", flush=True)
                final_query = original_query

        except Exception as e:
            print(f"[Query Rewriter] ❌ Failed: {e}, using original query", flush=True)
            final_query = original_query

        # LLM-DRIVEN FIX: Clear accumulated_evidence if this is a NEW query (not retry of same query)
        # This prevents stale answers from previous queries contaminating new investigations
        is_new_query = (
            not session_state or
            session_state.get('last_query', '') != final_query
        )

        # Clear routing history for new queries to prevent false loop detection
        from .routing import clear_routing_history
        if is_new_query:
            clear_routing_history(request.thread_id)
            print(f"[Session] New query detected - clearing accumulated_evidence and routing history", flush=True)

        # Save detected resources from query rewriter (convert list to dict format)
        detected_crd_resources = None
        if 'rewritten' in locals() and rewritten and hasattr(rewritten, 'detected_resources') and rewritten.detected_resources:
            # Query rewriter returns a list, but discovered_resources expects dict[str, list[str]]
            # Store CRDs under a generic 'crds' key for SmartExecutor to access
            detected_crd_resources = {'crds': rewritten.detected_resources}

        initial_state: AgentState = {
            "query": final_query,
            "kube_context": request.kube_context,
            # Merge session history with any history passed in request (frontend might pass context)
            "command_history": session_state['command_history'] if session_state else (request.history or []),
            "conversation_history": (session_state.get('conversation_history') if session_state else []) or (request.conversation_history or []),
            # Clear accumulated_evidence for new queries, keep for retries
            "accumulated_evidence": [] if is_new_query else (session_state.get('accumulated_evidence', []) if session_state else []),
            "iteration": 0,
            "next_action": 'supervisor',
            "pending_command": None,
            "final_response": None,
            "error": None,
            "reflection_reasoning": None,
            "continue_path": True,
            "llm_endpoint": request.llm_endpoint,
            "llm_provider": request.llm_provider,
            "llm_provider": request.llm_provider,
            "llm_model": request.llm_model,
            "executor_model": executor_model,
            "embedding_model": request.embedding_model,
            "embedding_endpoint": request.embedding_endpoint,
            "kb_dir": KB_DIR,  # Knowledge base directory for RAG
            "api_key": request.api_key,
            "current_plan": None,
            "cluster_info": cluster_info,
            "events": [],
            "awaiting_approval": False,
            "approved": request.approved_command,
            "mcp_tools": request.mcp_tools,
            "pending_tool_call": None,
            "execution_plan": None,  # ReAct plan tracking
            "current_step": None,  # Current step number in plan
            # Load from session for continuity, or use query rewriter's detected resources
            "discovered_resources": detected_crd_resources or (session_state['discovered_resources'] if session_state else None),
            "accumulated_evidence": session_state['accumulated_evidence'] if session_state else None,
            "pending_batch_commands": None,
            "batch_results": None,
            "confidence_score": None,
            "current_hypothesis": "",
            "extend": extend_mode,
            # Planner preferences used by downstream graph components
            "prefer_mcp_tools": extend_mode,
            # Human-in-the-loop controls
            "user_hint": request.user_hint,
            "skip_current_step": request.skip_current_step,
            "pause_after_step": request.pause_after_step,
        }
        
        # Keys that should be persisted across turns and NOT overwritten with None
        # if they already exist in the checkpoint state.
        # We process 'initial_state' to remove these keys if their value is None,
        # so that LangGraph's merge behavior preserves the existing value from checkpointer.
        protected_keys = [
            "discovered_resources", 
            "accumulated_evidence", 
            "current_hypothesis", 
            "execution_plan", 
            "current_step", 
            "plan_iteration", 
            "blocked_commands",
            "completed_plan_summary",
            "step_status", 
            "retry_count", 
            "last_reflection",
            "batch_results",
            "pending_batch_commands"
        ]
        
        # Create the actual input state for this run, filtering out protected Nones
        run_input = {
            k: v for k, v in initial_state.items() 
            if k not in protected_keys or v is not None
        }

        # If resuming from a tool execution, inject the result into history
        if request.tool_output:
            tool_name = request.tool_output.get("tool", "unknown")
            output = request.tool_output.get("output", "")
            error = request.tool_output.get("error")
            
            # Helper to append to history safely
            hist = run_input.get("command_history", [])
            hist.append({
                "command": f"MCP_TOOL: {tool_name}",
                "output": output,
                "error": error,
                "assessment": "EXECUTED",
                "useful": True
            })
            run_input["command_history"] = hist

        # Heartbeat task reference (needs to be accessible for cleanup)
        heartbeat_task_ref = None

        async def event_generator():
            nonlocal heartbeat_task_ref
            import time
            start_time = time.time()
            emitted_events_count = 0
            last_heartbeat = time.time()
            heartbeat_interval = 5
            thinking_dots = 0

            # Send initial progress event immediately
            yield f"data: {json.dumps(emit_event('progress', {'message': '🧠 Starting analysis...'}))}\n\n"

            # CRITICAL FIX: Increased recursion limits to handle complex investigations
            # Previous limits (150/250) were causing premature termination for deep debugging
            # New limits provide 2-3x more capacity for multi-step troubleshooting
            run_config = {
                "recursion_limit": 500 if initial_state.get("extend") else 300,
                "configurable": {"thread_id": request.thread_id}
            }
            if initial_state.get("extend"):
                # Inform client that we are extending investigation rigor
                yield f"data: {json.dumps(emit_event('hint', {'action': 'extend', 'reason': 'User requested extended investigation'}))}\n\n"
                # Provide planner guidance so downstream nodes can prioritize missing signals and MCP tools
                yield f"data: {json.dumps(emit_event('plan_bias', {'preferred_checks': initial_state.get('preferred_checks'), 'prefer_mcp_tools': True}))}\n\n"

            # Backtracking / Retry Loop
            max_attempts = 3
            final_answer = None

            # Queue for heartbeat communication
            heartbeat_queue = asyncio.Queue()

            # Heartbeat coroutine to keep SSE connection alive while waiting for Ollama
            async def send_heartbeats():
                """Send periodic heartbeats to prevent SSE timeout during slow LLM loading"""
                dots = 0
                while True:
                    await asyncio.sleep(5)  # Every 5 seconds
                    dots = (dots % 3) + 1
                    elapsed = int(time.time() - start_time)
                    await heartbeat_queue.put(f"data: {json.dumps(emit_event('progress', {'message': f'🧠 Loading model{"." * dots} ({elapsed}s)'}))}\n\n")

            try:
                for attempt in range(max_attempts):
                    # If retrying, inject a hint into the query
                    if attempt > 0:
                     print(f"🔄 Backtracking Attempt {attempt+1}/{max_attempts}...", flush=True)
                     yield f"data: {json.dumps(emit_event('status', {'message': f'Previous path failed. Backtracking (Attempt {attempt+1})...', 'type': 'retry'}))}\n\n"

                     # Append hint to query to guide Supervisor
                     # We use a distinct separator so we can strip it later if needed, but LLM understanding is key.
                     # Note: We modify initial_state directly here, which will be passed to the agent.
                     initial_state['query'] = f"{request.query} (SYSTEM HINT: Previous attempt failed to yield a final response. You MUST backtrack, critique your previous steps, and try a different approach to answer the user.)"
                     initial_state['retry_count'] = attempt
                     # Clear previous final_response and error for a fresh attempt
                     initial_state['final_response'] = None
                     initial_state['error'] = None
                     # Reset next_action to supervisor to restart the graph
                     initial_state['next_action'] = 'supervisor'
                     # Clear events to avoid re-emitting old ones, but keep history
                     initial_state['events'] = []
                     emitted_events_count = 0

                    # Start heartbeat task to keep connection alive during model loading
                    if not heartbeat_task_ref:
                        heartbeat_task_ref = asyncio.create_task(send_heartbeats())

                    # Run the agent
                    # Note: We use the same thread_id so history is preserved (agent sees what failed).
                    # We pass `initial_state` directly here, as it's being mutated for retries.
                    event_stream = agent.astream_events(initial_state, version="v2", config=run_config)
                    async for event in event_stream:
                        # Check heartbeat queue and yield any pending heartbeats
                        while not heartbeat_queue.empty():
                            heartbeat_msg = await heartbeat_queue.get()
                            yield heartbeat_msg

                        kind = event["event"]
                        current_time = time.time()

                        # Send heartbeat/thinking indicator
                        if current_time - last_heartbeat > heartbeat_interval:
                            thinking_dots = (thinking_dots % 3) + 1
                            dots = "." * thinking_dots
                            elapsed = int(current_time - start_time)
                            yield f"data: {json.dumps(emit_event('progress', {'message': f'🧠 Thinking{dots} ({elapsed}s)'}))}\n\n"
                            last_heartbeat = current_time

                        # Handle chain steps (updates from nodes)
                        if kind == "on_chain_end":
                            if event['name'] in ['supervisor', 'worker', 'self_correction', 'command_validator', 'verify', 'human_approval', 'execute', 'batch_execute', 'reflect', 'plan_executor', 'synthesizer', 'k8s_agent']:
                                node_update = event['data'].get('output') if event.get('data') else None

                                if node_update is None:
                                    continue

                                if isinstance(node_update, dict):
                                    # Simplistic merge for flat fields
                                    initial_state.update(node_update)

                                    # Capture final response if generated by any node
                                    if node_update.get('final_response'):
                                        final_answer = node_update.get('final_response')
                                        print(f"✅ FINAL RESPONSE from {event['name']}", flush=True)
                                        # If a final answer is found, we can break out of the inner astream_events loop
                                        # and the outer retry loop will also break.
                                        break # Break from inner async for loop

                                    # Phase tracking: emit phase markers when moving through key nodes
                                    phase_map = {
                                        'supervisor': 'discovery',
                                        'worker': 'evidence',
                                        'verify': 'validation',
                                        'reflect': 'hypothesis',
                                        'plan_executor': 'recommendation',
                                    }
                                    phase_name = phase_map.get(event['name'])
                                    if phase_name:
                                        yield f"data: {json.dumps(emit_phase_event(phase_name, detail=f'node={event['name']}'))}\n\n"

                                    if node_update.get('events'):
                                        events_list = node_update.get('events', [])
                                        if len(events_list) > emitted_events_count:
                                            for new_evt in events_list[emitted_events_count:]:
                                                yield f"data: {json.dumps(new_evt)}\n\n"
                                                last_heartbeat = time.time()
                                            emitted_events_count = len(events_list)

                                    # Hypothesis visibility: stream ranked hypotheses if present
                                    ranked = node_update.get('ranked_hypotheses') or node_update.get('hypotheses')
                                    if ranked and isinstance(ranked, list):
                                        try:
                                            yield f"data: {json.dumps(emit_hypotheses_event(ranked))}\n\n"
                                        except Exception:
                                            pass

                                    if node_update.get('next_action') == 'human_approval' and node_update.get('awaiting_approval') is True:
                                        # CRITICAL GUARD: Detect approval loop (graph bug)
                                        approval_loop_count = initial_state.get('approval_loop_count', 0) + 1
                                        initial_state['approval_loop_count'] = approval_loop_count

                                        if approval_loop_count > 2:
                                            print(f"[server] ❌ CRITICAL: Approval loop detected ({approval_loop_count} iterations). Breaking loop with fallback response.", flush=True)

                                            # Generate intelligent fallback response from available data
                                            try:
                                                from .response_formatter import format_intelligent_response_with_llm
                                                fallback_response = await format_intelligent_response_with_llm(
                                                    query=initial_state.get('query', ''),
                                                    command_history=initial_state.get('command_history', []),
                                                    discovered_resources=initial_state.get('discovered_resources', {}),
                                                    hypothesis=initial_state.get('current_hypothesis'),
                                                    llm_endpoint=initial_state.get('llm_endpoint'),
                                                    llm_model=initial_state.get('llm_model'),
                                                    llm_provider=initial_state.get('llm_provider', 'ollama'),
                                                    accumulated_evidence=initial_state.get('accumulated_evidence', []),
                                                    api_key=initial_state.get('api_key')
                                                )
                                            except Exception as e:
                                                print(f"[server] ❌ Fallback generation failed: {e}", flush=True)
                                                # Simple fallback if LLM fails
                                                cmd_hist = initial_state.get('command_history', [])
                                                if cmd_hist:
                                                    last_output = cmd_hist[-1].get('output', 'No output available')
                                                    fallback_response = f"Based on the command execution:\n\n```\n{last_output[:500]}\n```\n\nI encountered an issue requiring approval but couldn't proceed automatically. Please review the output above."
                                                else:
                                                    fallback_response = "I encountered an issue processing your request and couldn't proceed automatically."

                                            # Set final response and emit completion
                                            final_answer = fallback_response
                                            initial_state['final_response'] = fallback_response
                                            initial_state['next_action'] = 'done'
                                            initial_state['error'] = 'Approval loop detected - graph configuration bug'

                                            yield f"data: {json.dumps(emit_event('done', {'final_response': fallback_response}))}\n\n"
                                            break  # Break from astream_events loop
                                        else:
                                            # Normal approval flow - wait for user
                                            print(f"[server] ⚠️ Approval needed (iteration {approval_loop_count}). Waiting for user...", flush=True)
                                            approval_ctx = {
                                                'command': node_update.get('pending_command'),
                                                'reason': node_update.get('approval_reason') or 'Manual approval required for mutative action',
                                                'risk': node_update.get('risk_level') or 'unknown',
                                                'impact': node_update.get('expected_impact') or 'unspecified',
                                            }
                                            yield f"data: {json.dumps(emit_event('approval_needed', approval_ctx))}\n\n"
                                            return # Exit generator if approval is needed

                    # Check if we got an answer after the stream ends (successfully or broken)
                    if final_answer:
                        # Break the retry loop if we got an answer
                        initial_state['final_response'] = final_answer
                        break
                    else:
                        # Log the state if we didn't get a final answer
                        print(f"❌ Attempt {attempt+1} failed to produce final_response. Current keys: {initial_state.keys()}", flush=True)
                        if 'error' in initial_state:
                             print(f"❌ State Error: {initial_state['error']}", flush=True)

                    # If final_answer was found during this attempt, break the outer retry loop
                    if final_answer:
                        break

                # Fallback: If ended with approval needed (Graph interruption)
                if initial_state.get('next_action') == 'human_approval' and initial_state.get('awaiting_approval'):
                     cmd = initial_state.get('pending_command') or (initial_state.get('command_history')[-1].get('command') if initial_state.get('command_history') else "Unknown Command")
                     yield f"data: {json.dumps(emit_event('approval_needed', {'command': cmd}))}\n\n"
                     return

                # Final response (use the final_answer determined by the loop)
                if not final_answer and initial_state.get('error'):
                    print(f"⚠️ Using error as final_answer: {initial_state['error']}", flush=True)
                    final_answer = f"Error: {initial_state['error']}"
                elif not final_answer:
                    # Synthesize a useful final response from command history
                    print(f"⚠️ No final_answer from nodes, generating fallback response with {len(initial_state.get('command_history', []))} commands", flush=True)
                    try:
                        from .response_formatter import format_intelligent_response_with_llm
                        print(f"🔄 Calling format_intelligent_response_with_llm...", flush=True)
                        final_answer = await format_intelligent_response_with_llm(
                            query=initial_state.get('query', ''),
                            command_history=initial_state.get('command_history', []),
                            discovered_resources=initial_state.get('discovered_resources') or {},
                            hypothesis=initial_state.get('current_hypothesis') or None,
                            llm_endpoint=initial_state.get('llm_endpoint'),
                            llm_model=initial_state.get('llm_model'),
                            llm_provider=initial_state.get('llm_provider') or 'ollama',
                            api_key=initial_state.get('api_key')
                        )
                        print(f"✅ Fallback response generated: {final_answer[:100]}...", flush=True)
                    except Exception as e:
                        # Fallback simple summary
                        print(f"❌ format_intelligent_response_with_llm failed: {e}, using simple fallback", flush=True)
                        from .response_formatter import format_intelligent_response
                        final_answer = format_intelligent_response(
                            query=initial_state.get('query', ''),
                            command_history=initial_state.get('command_history', []),
                            discovered_resources=initial_state.get('discovered_resources') or {},
                            hypothesis=initial_state.get('current_hypothesis') or None,
                        )
                        print(f"✅ Simple fallback response: {final_answer[:100]}...", flush=True)

                # Coverage checks: emit warnings if key signals are missing
                cov = compute_coverage_snapshot(initial_state)
                missing = [k for k,v in cov.items() if not v]
                if missing:
                    yield f"data: {json.dumps(emit_event('coverage', {'missing': missing, 'message': 'Key signals missing, investigation may be incomplete'}))}\n\n"

                # Adaptive iteration hint: recommend extension if warnings found
                try:
                    hist = [h for h in (initial_state.get('command_history') or []) if h]
                    had_warnings = any('Warning' in (h.get('output','')) for h in hist)
                    if had_warnings and missing:
                        yield f"data: {json.dumps(emit_event('hint', {'action': 'extend', 'reason': 'Warnings detected with incomplete coverage'}))}\n\n"
                except Exception:
                    pass

                # Goal verification: ensure we state whether the user's goal seems met
                # REMOVED: Legacy goal verification system that added "Goal status: NOT MET" prefix
                # This was bypassing the response_formatter.py banned phrase validation
                # and polluting responses with investigation-summary language.
                # The response_formatter.py now handles all response quality control.

                # LOGGING
                duration = time.time() - start_time
                # update final_response in state for logging purposes
                if final_answer:
                    initial_state['final_response'] = final_answer

                # Append current turn to conversation history for continuity
                c_hist = list(initial_state.get('conversation_history', []))
                c_hist.append({'role': 'user', 'content': request.query})
                if final_answer:
                    c_hist.append({'role': 'assistant', 'content': final_answer})
                else:
                    # Provide an error response in history if available, or generic failure
                    err_msg = initial_state.get('error') or "Investigation failed."
                    c_hist.append({'role': 'assistant', 'content': f"(Investigation failed: {err_msg})"})
                
                initial_state['conversation_history'] = c_hist

                # Save session state for conversation continuity
                update_session_state(request.thread_id, initial_state)

                log_session(initial_state, duration, status="COMPLETED" if final_answer else "FAILED")

                # Ensure a minimal thoughtful delay before completing
                MIN_RUNTIME_SEC = 3
                remaining = max(0, MIN_RUNTIME_SEC - duration)
                if remaining > 0:
                    try:
                        await asyncio.sleep(remaining)
                    except Exception:
                        pass

                # Get suggested next steps from state (if generated by synthesizer)
                suggested_next_steps = initial_state.get('suggested_next_steps', [])

                # Agent completed successfully
                if final_answer:
                    print(f"   Preview: {final_answer[:150]}...", flush=True)
                if suggested_next_steps:
                    print(f"   💡 Suggestions: {suggested_next_steps}", flush=True)

                yield f"data: {json.dumps(emit_event('done', {'final_response': final_answer, 'suggested_next_steps': suggested_next_steps}))}\n\n"

            except Exception as e:
                print(f"❌ Error in event_generator: {e}", flush=True)
                # Ensure we yield a final error event if something crashed
                yield f"data: {json.dumps(emit_event('status', {'message': f'Internal Error: {str(e)}', 'type': 'error'}))}\n\n"

            except Exception as e:
                # Handle errors in backtracking/retry loop
                print(f"[event_generator] Error during graph execution: {e}", flush=True)
                yield f"data: {json.dumps(emit_event('error', {'message': f'Investigation error: {str(e)}'}))}\n\n"

        async def event_generator_with_cleanup():
            """Wrapper to ensure heartbeat task cleanup"""
            nonlocal heartbeat_task_ref
            try:
                async for event in event_generator():
                    yield event
            finally:
                # Cancel heartbeat task when generator completes
                if heartbeat_task_ref and not heartbeat_task_ref.done():
                    heartbeat_task_ref.cancel()
                    try:
                        await heartbeat_task_ref
                    except asyncio.CancelledError:
                        pass  # Expected

        return StreamingResponse(event_generator_with_cleanup(), media_type="text/event-stream")

    except Exception as e:
        print(f"CRITICAL ERROR in analyze endpoint: {e}", flush=True)
        try:
            # Minimal state reconstruction for logging
            err_state: AgentState = {
                "query": request.query,
                "kube_context": request.kube_context,
                "command_history": request.history or [],
                "error": str(e),
                "iteration": 0,
                "next_action": "done",
                "executor_model": "",
                "llm_model": "",
                "llm_provider": "",
                "llm_endpoint": "",
                "events": [],
                "awaiting_approval": False,
                "approved": False,
                "continue_path": False,
                "current_plan": None,
                "cluster_info": None,
                "final_response": None,
                "reflection_reasoning": None
            }
            log_session(err_state, 0.0, status="ERROR")
        except:
            pass

        return StreamingResponse(
            iter([f"data: {json.dumps(emit_event('error', {'message': f'Server Error: {str(e)}'}))}\n\n"]),  
            media_type="text/event-stream"
        )

def kill_process_on_port(port: int) -> bool:
    """Kill any process using the specified port. Returns True if a process was killed."""
    import platform
    import signal
    import subprocess

    system = platform.system()
    my_pid = os.getpid()

    try:
        if system == "Darwin" or system == "Linux":
            # Use lsof to find process on port
            result = subprocess.run(
                ["lsof", "-ti", f":{port}"],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                pids = result.stdout.strip().split('\n')
                killed_any = False
                for pid in pids:
                    pid_int = int(pid.strip()) if pid.strip() else 0
                    if pid_int and pid_int != my_pid:
                        try:
                            os.kill(pid_int, signal.SIGKILL)
                            print(f"[agent-sidecar] Killed existing process on port {port} (PID: {pid.strip()})", flush=True)
                            killed_any = True
                        except (ProcessLookupError, ValueError):
                            pass
                return killed_any
        elif system == "Windows":
            # Use netstat on Windows
            result = subprocess.run(
                ["netstat", "-ano"],
                capture_output=True,
                text=True,
                timeout=5
            )
            for line in result.stdout.split('\n'):
                if f":{port}" in line and "LISTENING" in line:
                    parts = line.split()
                    if parts:
                        pid = parts[-1]
                        if int(pid) != my_pid:
                            try:
                                subprocess.run(["taskkill", "/F", "/PID", pid], timeout=5)
                                print(f"[agent-sidecar] Killed existing process on port {port} (PID: {pid})", flush=True)
                            except Exception:
                                pass
                            return True
    except Exception as e:
        print(f"[agent-sidecar] Warning: Could not check/kill process on port {port}: {e}", flush=True)

    return False

if __name__ == "__main__":
    import uvicorn
    import time
    import sys

    PORT = 8765

    # Kill any zombie/unhealthy process on the port (but not ourselves)
    if kill_process_on_port(PORT):
        # Give the OS time to release the port
        time.sleep(1.0)
    
    # Run server
    uvicorn.run(app, host="0.0.0.0", port=PORT)
