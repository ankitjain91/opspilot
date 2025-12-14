
import os
import json
import httpx
from typing import Literal
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .config import EMBEDDING_MODEL, KB_DIR
from .state import AgentState, CommandHistory
from .utils import get_cluster_recon, log_session, emit_event
from .graph import create_k8s_agent
from .tools import search

# Create the agent workflow
agent = create_k8s_agent()

# --- Helpers for phase tracking, hypothesis visibility, coverage checks ---
def compute_coverage_snapshot(state: dict) -> dict:
    """Assess whether key signals were collected during investigation."""
    hist = state.get('command_history') or []
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
    for h in command_history or []:
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

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    print("K8s Agent Server starting...")
    yield
    print("K8s Agent Server shutting down...")

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

class AgentRequest(BaseModel):
    """Request to run the agent."""
    query: str
    kube_context: str = ""
    llm_endpoint: str = "http://localhost:11434"
    llm_provider: str = "ollama"
    llm_model: str = "opspilot-brain"
    executor_model: str = "k8s-cli"
    history: list[CommandHistory] = []
    conversation_history: list[dict] = []  # Multi-turn context
    approved_command: bool = False
    mcp_tools: list[dict] = []
    tool_output: dict | None = None  

@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}

@app.get("/embedding-model/status")
async def embedding_model_status(llm_endpoint: str = "http://localhost:11434"):
    """Check if the embedding model is available."""
    
    # Use the shared state from search module (it manages the global var)
    is_available = await search.check_embedding_model_available(llm_endpoint)
    
    # We still need to get model size info for the UI
    base = llm_endpoint or ""
    clean_endpoint = base.rstrip('/').removesuffix('/v1').rstrip('/') if base else "http://localhost:11434"
    model_size = None

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{clean_endpoint}/api/tags", timeout=10.0)
            if resp.status_code == 200:
                models = resp.json().get("models", [])
                for m in models:
                    if m.get("name", "").split(":")[0] == EMBEDDING_MODEL.split(":")[0]:
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
async def pull_embedding_model(llm_endpoint: str = "http://localhost:11434"):
    """Pull/download the embedding model with user consent."""
    
    base = llm_endpoint or ""
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
async def generate_kb_embeddings(llm_endpoint: str = "http://localhost:11434"):
    """Generate KB embeddings using local Ollama and cache them."""
    return StreamingResponse(search.generate_kb_embeddings_generator(llm_endpoint), media_type="text/event-stream")


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

        # Detect explicit extend directive in the query
        extend_mode = False
        qtext = (request.query or "").strip()
        if qtext.startswith("[EXTEND]"):
            extend_mode = True

        initial_state: AgentState = {
            "query": request.query,
            "kube_context": request.kube_context,
            "command_history": request.history or [],
            "conversation_history": request.conversation_history or [],
            "iteration": 0,
            "next_action": 'supervisor',
            "pending_command": None,
            "final_response": None,
            "error": None,
            "reflection_reasoning": None,
            "continue_path": True,
            "llm_endpoint": request.llm_endpoint,
            "llm_provider": request.llm_provider,
            "llm_model": request.llm_model,
            "executor_model": request.executor_model,
            "current_plan": None,
            "cluster_info": cluster_info,
            "events": [],
            "awaiting_approval": False,
            "approved": request.approved_command,
            "mcp_tools": request.mcp_tools,
            "pending_tool_call": None,
            "execution_plan": None,  # ReAct plan tracking
            "current_step": None,  # Current step number in plan
            "discovered_resources": None,
            "pending_batch_commands": None,
            "batch_results": None,
            "confidence_score": None,
            "current_hypothesis": "",
            "extend": extend_mode,
            # Planner preferences used by downstream graph components
            "preferred_checks": ["nodes", "pods", "events", "resource-usage"] if extend_mode else None,
            "prefer_mcp_tools": extend_mode,
        }

        # If resuming from a tool execution, inject the result into history
        if request.tool_output:
            tool_name = request.tool_output.get("tool", "unknown")
            output = request.tool_output.get("output", "")
            error = request.tool_output.get("error")
            initial_state["command_history"].append({
                "command": f"MCP_TOOL: {tool_name}",
                "output": output,
                "error": error,
                "assessment": "EXECUTED",
                "useful": True
            })

        async def event_generator():
            import time
            start_time = time.time()
            emitted_events_count = 0 
            last_heartbeat = time.time()
            heartbeat_interval = 5 
            thinking_dots = 0

            # Send initial progress event immediately
            yield f"data: {json.dumps(emit_event('progress', {'message': '🧠 Starting analysis...'}))}\n\n"

            # Increase recursion/effort in extend mode
            config = {"recursion_limit": 250} if initial_state.get("extend") else {"recursion_limit": 150}
            if initial_state.get("extend"):
                # Inform client that we are extending investigation rigor
                yield f"data: {json.dumps(emit_event('hint', {'action': 'extend', 'reason': 'User requested extended investigation'}))}\n\n"
                # Provide planner guidance so downstream nodes can prioritize missing signals and MCP tools
                yield f"data: {json.dumps(emit_event('plan_bias', {'preferred_checks': initial_state.get('preferred_checks'), 'prefer_mcp_tools': True}))}\n\n"
            async for event in agent.astream_events(initial_state, version="v1", config=config):
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
                    if event['name'] in ['supervisor', 'worker', 'verify', 'human_approval', 'execute', 'batch_execute', 'reflect', 'validate_plan_step', 'execute_plan_step']:
                        node_update = event['data'].get('output') if event.get('data') else None

                        if node_update is None:
                            continue

                        if isinstance(node_update, dict):
                            # Simplistic merge for flat fields
                            initial_state.update(node_update)

                            # Phase tracking: emit phase markers when moving through key nodes
                            phase_map = {
                                'supervisor': 'discovery',
                                'worker': 'evidence',
                                'verify': 'validation',
                                'reflect': 'hypothesis',
                                'execute_plan_step': 'recommendation',
                            }
                            phase_name = phase_map.get(event['name'])
                            if phase_name:
                                yield f"data: {json.dumps(emit_phase_event(phase_name, detail=f'node={event['name']}'))}\n\n"

                            if node_update.get('events'):
                                current_events = node_update['events']
                                # Only emit new events
                                if len(current_events) > emitted_events_count:
                                    for new_evt in current_events[emitted_events_count:]:
                                        yield f"data: {json.dumps(new_evt)}\n\n"
                                        last_heartbeat = time.time()
                                    emitted_events_count = len(current_events)

                            # Hypothesis visibility: stream ranked hypotheses if present
                            ranked = node_update.get('ranked_hypotheses') or node_update.get('hypotheses')
                            if ranked and isinstance(ranked, list):
                                try:
                                    yield f"data: {json.dumps(emit_hypotheses_event(ranked))}\n\n"
                                except Exception:
                                    pass

                            if node_update.get('next_action') == 'human_approval' and node_update.get('awaiting_approval') is True:
                                # Approval context summary with risk and rationale
                                approval_ctx = {
                                    'command': node_update.get('pending_command'),
                                    'reason': node_update.get('approval_reason') or 'Manual approval required for mutative action',
                                    'risk': node_update.get('risk_level') or 'unknown',
                                    'impact': node_update.get('expected_impact') or 'unspecified',
                                }
                                yield f"data: {json.dumps(emit_event('approval_needed', approval_ctx))}\n\n"
                                return

            # Fallback: If ended with approval needed (Graph interruption)
            if initial_state.get('next_action') == 'human_approval' and initial_state.get('awaiting_approval'):
                 cmd = initial_state.get('pending_command') or (initial_state.get('command_history')[-1].get('command') if initial_state.get('command_history') else "Unknown Command")
                 yield f"data: {json.dumps(emit_event('approval_needed', {'command': cmd}))}\n\n"
                 return

            # Final response
            final_answer = initial_state.get('final_response')
            if not final_answer and initial_state.get('error'):
                final_answer = f"Error: {initial_state['error']}"
            elif not final_answer:
                # Synthesize a useful final response from command history
                try:
                    from .response_formatter import format_intelligent_response_with_llm
                    final_answer = await format_intelligent_response_with_llm(
                        query=initial_state.get('query', ''),
                        command_history=initial_state.get('command_history', []),
                        discovered_resources=initial_state.get('discovered_resources') or {},
                        hypothesis=initial_state.get('current_hypothesis') or None,
                        llm_endpoint=initial_state.get('llm_endpoint'),
                        llm_model=initial_state.get('llm_model'),
                        llm_provider=initial_state.get('llm_provider') or 'ollama'
                    )
                except Exception:
                    # Fallback simple summary
                    from .response_formatter import format_intelligent_response
                    final_answer = format_intelligent_response(
                        query=initial_state.get('query', ''),
                        command_history=initial_state.get('command_history', []),
                        discovered_resources=initial_state.get('discovered_resources') or {},
                        hypothesis=initial_state.get('current_hypothesis') or None,
                    )

            # Coverage checks: emit warnings if key signals are missing
            cov = compute_coverage_snapshot(initial_state)
            missing = [k for k,v in cov.items() if not v]
            if missing:
                yield f"data: {json.dumps(emit_event('coverage', {'missing': missing, 'message': 'Key signals missing, investigation may be incomplete'}))}\n\n"

            # Adaptive iteration hint: recommend extension if warnings found
            try:
                had_warnings = any('Warning' in (h.get('output','')) for h in (initial_state.get('command_history') or []))
                if had_warnings and missing:
                    yield f"data: {json.dumps(emit_event('hint', {'action': 'extend', 'reason': 'Warnings detected with incomplete coverage'}))}\n\n"
            except Exception:
                pass

            # Goal verification: ensure we state whether the user's goal seems met
            try:
                # First, enforce exhaustive attempt check
                attempts = check_exhaustive_attempts(initial_state)
                if not attempts.get('sufficient'):
                    # Encourage extension before concluding
                    yield f"data: {json.dumps(emit_event('hint', {'action': 'extend', 'reason': 'Exhaustive attempts insufficient', 'details': attempts}))}\n\n"

                verification = verify_goal_completion(
                    query=initial_state.get('query',''),
                    command_history=initial_state.get('command_history',[]),
                    final_answer=final_answer
                )
                # If attempts insufficient, force NOT MET unless explicitly SOLVED earlier
                if not attempts.get('sufficient') and not any(str(h.get('assessment','')).upper() in ['SOLVED','RESOLVED'] for h in (initial_state.get('command_history') or [])):
                    verification['met'] = False
                    verification['reason'] = 'Agent has not exhausted available methods; recommend extending investigation.'
                yield f"data: {json.dumps(emit_event('verification', verification))}\n\n"
                # Prefix the final answer with a concise status line
                status_line = f"Goal status: {'MET' if verification.get('met') else 'NOT MET'} — {verification.get('reason','')}\n\n"
                final_answer = status_line + (final_answer or '')
            except Exception:
                pass

            # LOGGING
            duration = time.time() - start_time
            log_session(initial_state, duration, status="COMPLETED" if initial_state.get('final_response') else "FAILED")

            # Ensure a minimal thoughtful delay before completing
            MIN_RUNTIME_SEC = 3
            remaining = max(0, MIN_RUNTIME_SEC - duration)
            if remaining > 0:
                import asyncio
                try:
                    await asyncio.sleep(remaining)
                except Exception:
                    pass

            yield f"data: {json.dumps(emit_event('done', {'final_response': final_answer}))}\n\n"

        return StreamingResponse(event_generator(), media_type="text/event-stream")

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
