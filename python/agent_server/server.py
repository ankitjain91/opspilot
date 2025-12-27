
import os
import sys

# OS-specific PATH initialization
def init_system_path():
    """Ensure common binary paths are in os.environ['PATH'] for all platforms."""
    import os
    import sys
    
    current_path = os.environ.get("PATH", "")
    new_paths = []
    
    if sys.platform == 'darwin':
        new_paths = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
            # Add common K8s tool paths
            os.path.expanduser("~/.krew/bin"),
            os.path.expanduser("~/.rd/bin"),
            os.path.expanduser("~/.opspilot/bin"),
        ]
    elif sys.platform == 'win32':
        new_paths = [
            os.path.expanduser("~\\AppData\\Roaming\\npm"),
            "C:\\Program Files\\nodejs",
            "C:\\Program Files (x86)\\nodejs",
            os.path.expanduser("~\\.opspilot\\bin")
        ]
    else: # Linux/Other
        new_paths = [
            "/opt/homebrew/bin",  # Homebrew on Apple Silicon
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            os.path.expanduser("~/.local/bin"),
            os.path.expanduser("~/.npm-global/bin"),
            # Add common K8s tool paths
            os.path.expanduser("~/.krew/bin"),
            os.path.expanduser("~/.rd/bin"), # Rancher Desktop
            os.path.expanduser("~/.opspilot/bin"),
        ]

    # Prepend and filter out duplicates or non-existent paths to keep it clean
    path_list = current_path.split(os.pathsep)
    for p in reversed(new_paths):
        if p and p not in path_list:
            path_list.insert(0, p)
            
    os.environ["PATH"] = os.pathsep.join(path_list)
    print(f"[config] Updated PATH for {sys.platform}: {os.environ['PATH'][:80]}...", flush=True)

init_system_path()
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
# keyring removed - using local encrypted file storage instead
from typing import Any, Literal
import httpx
import json

from .config import EMBEDDING_MODEL, KB_DIR
from .state import AgentState, CommandHistory
from .utils import get_cluster_recon, log_session, emit_event
from .graph import create_k8s_agent
from .tools import kb_search as search
from langgraph.checkpoint.memory import MemorySaver

# Import direct_agent prompts at module load time to prevent PyInstaller decompression issues
# (PyInstaller can fail on lazy imports due to compressed archive extraction timing)
from .prompts.direct_agent import DIRECT_AGENT_SYSTEM_PROMPT, DIRECT_AGENT_USER_PROMPT
from .prompts.modular_builder import build_system_prompt, get_prompt_stats

# Version is auto-generated at build time - see _version.py
try:
    from ._version import __version__ as AGENT_VERSION
except ImportError:
    # Fallback for development - read from package.json or use env
    AGENT_VERSION = os.environ.get("AGENT_VERSION", "0.0.0-dev")


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
import threading
session_store = {}
session_lock = threading.Lock()  # Thread-safe access to session_store

# Session configuration
SESSION_MAX_HISTORY = 20  # Keep last N command history entries (recency window)
SESSION_MAX_AGE_MINUTES = 30  # Auto-expire sessions older than this
SESSION_MAX_TURNS = 50  # Hard limit on conversation turns before suggesting reset

# Background Sentinel (Lazy init)
from .sentinel import SentinelLoop
global_sentinel = None
global_sentinel_task = None

# Claude Code Background Compaction
from .claude_code_backend import get_claude_code_backend
global_compaction_task = None

async def background_claude_compaction():
    """Periodic task to compact Claude Code conversations in the background."""
    print("[Claude] Background compaction task started", flush=True)
    while True:
        try:
            # Wait 5 minutes between runs
            await asyncio.sleep(300)
            backend = get_claude_code_backend()
            if backend and backend.session_id:
                # Silently compact
                await backend.compact()
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[Claude] Compaction error: {e}", flush=True)
            await asyncio.sleep(60) # Wait a bit before retry on error

# --- Session Management Helpers ---
def get_session_state(thread_id: str) -> dict | None:
    """
    Retrieve session state for a thread_id.
    Returns None if session doesn't exist or has expired.
    Applies recency windowing to command_history.
    Thread-safe: uses session_lock.
    """
    import time

    with session_lock:
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

        # Return a copy to avoid external mutation
        return {
            'command_history': list(command_history),
            'conversation_history': list(session.get('conversation_history', [])),
            'discovered_resources': session.get('discovered_resources'),
            'accumulated_evidence': list(session.get('accumulated_evidence', [])),
            'last_query': session.get('last_query', ''),
            'conversation_turns': session.get('conversation_turns', 0)
        }

def update_session_state(thread_id: str, state: dict):
    """
    Update session state after a query completes.
    Stores command_history, discovered_resources, accumulated_evidence.
    Thread-safe: uses session_lock.
    """
    import time

    with session_lock:
        # Get current turn count
        existing = session_store.get(thread_id, {})
        turns = existing.get('conversation_turns', 0) + 1

        # Warn if approaching max turns
        if turns >= SESSION_MAX_TURNS:
            print(f"[Session] WARNING: Thread {thread_id} has {turns} turns. Consider resetting for optimal performance.", flush=True)

        # LLM-DRIVEN FIX: Persist accumulated_evidence for query retries
        # It will be cleared when a new different query starts
        session_store[thread_id] = {
            'command_history': list(state.get('command_history', [])),
            'conversation_history': list(state.get('conversation_history', [])),
            'discovered_resources': state.get('discovered_resources'),
            'accumulated_evidence': list(state.get('accumulated_evidence', [])),
            'last_query': state.get('query', ''),
            'last_updated': time.time(),
            'conversation_turns': turns
        }

def clear_session(thread_id: str):
    """Clear session state for a thread_id. Thread-safe: uses session_lock."""
    with session_lock:
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


def _generate_fast_mode_suggestions(query: str, command_history: list[dict], final_answer: str) -> list[str]:
    """Generate quick context-aware suggestions for Fast Mode without LLM call.

    Uses heuristics based on:
    - What was asked
    - What commands were run
    - What resources were mentioned
    """
    suggestions = []
    query_lower = query.lower()
    answer_lower = final_answer.lower() if final_answer else ""

    # Extract resource types mentioned
    commands_str = " ".join([h.get('command', '') for h in (command_history or [])])
    outputs_str = " ".join([h.get('output', '')[:500] for h in (command_history or [])])

    # Pod-related suggestions
    if 'pod' in query_lower or 'pod' in commands_str:
        if 'log' not in query_lower and 'log' not in commands_str:
            suggestions.append("Show pod logs")
        if 'describe' not in commands_str:
            suggestions.append("Describe the pod")
        if 'event' not in query_lower and 'event' not in commands_str:
            suggestions.append("Check related events")

    # Deployment-related
    if 'deployment' in query_lower or 'deploy' in commands_str:
        if 'rollout' not in commands_str:
            suggestions.append("Check rollout status")
        if 'replica' not in query_lower:
            suggestions.append("Show replica count")

    # Error/crash related
    if any(x in query_lower or x in answer_lower for x in ['crash', 'error', 'fail', 'oom', 'restart']):
        if 'log' not in commands_str:
            suggestions.append("Get container logs")
        if 'previous' not in commands_str:
            suggestions.append("Check previous logs")
        suggestions.append("Show resource limits")

    # Service/networking
    if 'service' in query_lower or 'endpoint' in query_lower or 'svc' in commands_str:
        if 'endpoint' not in commands_str:
            suggestions.append("Check service endpoints")
        suggestions.append("Test connectivity")

    # General follow-ups if nothing specific
    if not suggestions:
        if 'get' in commands_str and 'describe' not in commands_str:
            suggestions.append("Describe the resource")
        suggestions.append("Show recent events")
        suggestions.append("Check resource health")

    # Limit to 3 and dedupe
    seen = set()
    unique = []
    for s in suggestions:
        if s.lower() not in seen:
            seen.add(s.lower())
            unique.append(s)

    return unique[:3]


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
    HEARTBEAT_INTERVAL = 15  # Send heartbeat every 15 seconds

    def __init__(self):
        self._queues = set()
        self._history = CircularBuffer(100) # Keep last 100 events

    async def subscribe(self):
        q = asyncio.Queue()
        self._queues.add(q)
        try:
            # Send immediate ping to establish connection and flush headers
            yield {"data": json.dumps({"type": "ping", "message": "connected"})}

            # Replay history first
            for event in self._history.get_all():
                yield {"data": json.dumps(event)}

            # Then stream new events with periodic heartbeats
            while True:
                try:
                    # Wait for message with timeout for heartbeat
                    msg = await asyncio.wait_for(q.get(), timeout=self.HEARTBEAT_INTERVAL)
                    yield msg
                except asyncio.TimeoutError:
                    # No message received, send heartbeat to keep connection alive
                    heartbeat = {"data": json.dumps({"type": "heartbeat", "timestamp": int(asyncio.get_event_loop().time())})}
                    yield heartbeat
        except asyncio.CancelledError:
            pass
        finally:
            # Always clean up the queue
            if q in self._queues:
                self._queues.remove(q)

    async def broadcast(self, event: dict):
        # Store in history
        self._history.add(event)

        # Format as SSE data
        import json
        payload = {"data": json.dumps(event)}
        # Send to all connected clients
        for q in list(self._queues):  # Copy to avoid modification during iteration
            try:
                await q.put(payload)
            except Exception:
                pass  # Queue might be closed

broadcaster = GlobalBroadcaster()


# --- Background preloading ---
_preload_tasks: dict[str, asyncio.Task] = {}  # context -> task
_preload_status: dict[str, str] = {}  # context -> status ("loading", "ready", "error")


async def _background_preload_kb(kube_context: str):
    """Background task to preload KB for a context."""
    global _preload_status
    try:
        _preload_status[kube_context] = "loading"
        print(f"[KB] [SYNC] Background preloading KB for context '{kube_context}'...", flush=True)

        from .tools import ingest_cluster_knowledge

        # Create minimal state for ingestion
        state = {"kube_context": kube_context}
        await ingest_cluster_knowledge(state, force_refresh=False)

        _preload_status[kube_context] = "ready"
        print(f"[KB] [OK] Background preload complete for context '{kube_context}'", flush=True)
    except Exception as e:
        _preload_status[kube_context] = f"error: {e}"
        print(f"[KB] [ERROR] Background preload failed for '{kube_context}': {e}", flush=True)


def trigger_background_preload(kube_context: str) -> bool:
    """Trigger background KB preload for a context. Returns True if started."""
    global _preload_tasks

    # Already loading or done?
    if kube_context in _preload_tasks:
        task = _preload_tasks[kube_context]
        if not task.done():
            print(f"[KB] [WAIT] Preload already in progress for {kube_context}", flush=True)
            return False  # Already loading
        else:
            print(f"[KB] [RESET] Previous preload task done, starting new one for {kube_context}", flush=True)

    # Start new preload task
    print(f"[KB] [START] Starting background preload task for {kube_context}", flush=True)
    task = asyncio.create_task(_background_preload_kb(kube_context))
    _preload_tasks[kube_context] = task
    return True


# --- startup ---

# Global flag to track Claude CLI auth status
_claude_auth_status = {"authenticated": None, "error": None, "version": None, "last_check": 0, "consecutive_failures": 0}

# Lock for thread-safe auth status updates
import threading
_claude_auth_lock = threading.Lock()


async def _check_claude_auth(force_recheck: bool = False) -> tuple[bool, str | None]:
    """Check if Claude CLI is authenticated by running a simple command.

    Args:
        force_recheck: If True, skip cache and always check. Otherwise uses 60s cache.

    Returns tuple: (is_authenticated: bool, error_message: str or None)
    """
    import asyncio
    import time

    global _claude_auth_status

    # Check cache (60 second TTL) unless force_recheck
    now = time.time()
    if not force_recheck and _claude_auth_status.get("last_check", 0) > now - 60:
        return _claude_auth_status.get("authenticated", False), _claude_auth_status.get("error")

    claude_bin = find_executable_path("claude")
    if not claude_bin:
        return False, "Claude CLI not installed"

    # Try multiple verification methods for maximum reliability
    methods = [
        # Method 1: Quick version check (doesn't require API auth)
        (["--version"], 10.0, False),
        # Method 2: Print mode with minimal prompt (tests API auth)
        (["-p", "--output-format", "json", "Say 'ok'"], 30.0, True),
    ]

    version_ok = False
    api_auth_ok = False
    last_error = None

    for args, timeout, is_api_check in methods:
        try:
            process = await asyncio.create_subprocess_exec(
                claude_bin, *args,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**dict(os.environ), "CI": "true", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"},
            )

            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout
            )

            stdout_text = stdout.decode('utf-8', errors='replace').strip()
            stderr_text = stderr.decode('utf-8', errors='replace').strip()

            if process.returncode == 0:
                if is_api_check:
                    api_auth_ok = True
                    print(f"[Claude] Auth check passed (API verified)", flush=True)
                else:
                    version_ok = True
                    print(f"[Claude] Version check passed: {stdout_text[:50]}", flush=True)
            else:
                # Analyze the error
                combined = (stdout_text + " " + stderr_text).lower()
                if "not logged in" in combined or "authentication" in combined or "unauthorized" in combined:
                    last_error = "Not authenticated. Run 'claude login' in your terminal."
                elif "rate limit" in combined or "429" in combined:
                    last_error = "Rate limited. Please wait a few minutes."
                elif "keychain" in combined or "keyring" in combined or "password" in combined:
                    last_error = "Keychain access required. Grant access when prompted or run 'claude login'."
                elif "network" in combined or "connection" in combined or "timeout" in combined:
                    last_error = "Network error. Check your internet connection."
                else:
                    last_error = f"CLI error (code {process.returncode}): {stderr_text[:150]}"

        except asyncio.TimeoutError:
            last_error = f"CLI timed out after {timeout}s (may be waiting for keychain)"
        except BrokenPipeError:
            last_error = "CLI crashed (BrokenPipe). Try: 'claude logout && claude login'"
        except FileNotFoundError:
            last_error = "Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"
        except PermissionError:
            last_error = "Permission denied running Claude CLI. Check file permissions."
        except Exception as e:
            last_error = f"Unexpected error: {str(e)}"

    # Determine final status
    # If version works but API doesn't, we need auth
    # If both work, we're good
    # If neither works, CLI is broken
    is_authenticated = api_auth_ok  # API auth is what matters
    final_error = None if is_authenticated else last_error

    # Update cache with thread safety
    with _claude_auth_lock:
        if is_authenticated:
            _claude_auth_status["consecutive_failures"] = 0
        else:
            _claude_auth_status["consecutive_failures"] = _claude_auth_status.get("consecutive_failures", 0) + 1

        _claude_auth_status.update({
            "authenticated": is_authenticated,
            "error": final_error,
            "last_check": time.time(),
            "version_ok": version_ok,
        })

    return is_authenticated, final_error


async def _attempt_auto_recovery() -> tuple[bool, str]:
    """Attempt automatic recovery when Claude auth fails.

    Returns tuple: (recovered: bool, message: str)
    """
    global _claude_auth_status

    consecutive_failures = _claude_auth_status.get("consecutive_failures", 0)

    # Only attempt recovery after multiple failures
    if consecutive_failures < 2:
        return False, "Not enough failures to trigger recovery"

    print(f"[Claude] Attempting auto-recovery after {consecutive_failures} failures...", flush=True)

    claude_bin = find_executable_path("claude")
    if not claude_bin:
        return False, "CLI not installed"

    recovery_steps = []

    # Step 1: Try clearing any stale sessions
    try:
        # Check if there's a stuck process
        import subprocess
        result = subprocess.run(
            ["pgrep", "-f", "claude"],
            capture_output=True,
            timeout=5
        )
        if result.stdout:
            recovery_steps.append("Found existing Claude processes")
    except Exception:
        pass

    # Step 2: Verify CLI can start at all
    try:
        process = await asyncio.create_subprocess_exec(
            claude_bin, "--help",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**dict(os.environ), "CI": "true"},
        )
        await asyncio.wait_for(process.communicate(), timeout=10.0)
        if process.returncode == 0:
            recovery_steps.append("CLI responds to --help")
        else:
            recovery_steps.append("CLI --help failed")
    except Exception as e:
        recovery_steps.append(f"CLI check failed: {e}")

    # Step 3: Re-check auth after brief pause
    await asyncio.sleep(2)
    is_auth, error = await _check_claude_auth(force_recheck=True)

    if is_auth:
        print(f"[Claude] Auto-recovery successful!", flush=True)
        return True, "Recovery successful - auth restored"
    else:
        msg = f"Recovery attempted but auth still failing. Steps: {', '.join(recovery_steps)}. Error: {error}"
        print(f"[Claude] {msg}", flush=True)
        return False, msg

async def _warmup_claude_cli():
    """Run claude --version at startup to trigger keyring permission dialog early.

    Retries until successful or max attempts reached, giving user time to approve keyring access.
    Also checks authentication status and caches it for /status endpoint.
    """
    import asyncio
    global _claude_auth_status

    claude_bin = find_executable_path("claude")
    if not claude_bin:
        print("[Claude] CLI not found - install with: npm install -g @anthropic-ai/claude-code", flush=True)
        with _claude_auth_lock:
            _claude_auth_status.update({
                "authenticated": False,
                "error": "CLI not installed",
                "version": None,
                "last_check": 0
            })
        return

    print(f"[Claude] Warming up CLI at: {claude_bin}", flush=True)

    max_attempts = 10
    retry_delay = 3  # seconds between retries
    version_found = None

    for attempt in range(1, max_attempts + 1):
        try:
            process = await asyncio.create_subprocess_exec(
                claude_bin, "--version",
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**dict(os.environ), "CI": "true", "PYTHONIOENCODING": "utf-8"},
            )

            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=15.0
            )

            if process.returncode == 0:
                version_found = stdout.decode('utf-8', errors='replace').strip()
                print(f"[Claude] CLI ready: {version_found}", flush=True)
                break  # Success - exit retry loop
            else:
                err = stderr.decode('utf-8', errors='replace').strip()
                print(f"[Claude] Attempt {attempt}/{max_attempts} failed: {err}", flush=True)

        except asyncio.TimeoutError:
            print(f"[Claude] Attempt {attempt}/{max_attempts} timed out (waiting for keyring permission?)", flush=True)
        except BrokenPipeError:
            print(f"[Claude] Attempt {attempt}/{max_attempts} broken pipe (keyring permission pending or auth required?)", flush=True)
        except Exception as e:
            print(f"[Claude] Attempt {attempt}/{max_attempts} error: {e}", flush=True)

        if attempt < max_attempts:
            print(f"[Claude] Retrying in {retry_delay}s... (grant keyring access if prompted)", flush=True)
            await asyncio.sleep(retry_delay)

    if not version_found:
        print(f"[Claude] CLI warmup failed after {max_attempts} attempts", flush=True)
        with _claude_auth_lock:
            _claude_auth_status.update({
                "authenticated": False,
                "error": "CLI warmup failed - may need reinstall",
                "version": None,
                "last_check": 0
            })
        return

    # Now check authentication status using the comprehensive check
    print("[Claude] Checking authentication status...", flush=True)
    is_auth, auth_error = await _check_claude_auth(force_recheck=True)

    # Update with version info
    with _claude_auth_lock:
        _claude_auth_status["version"] = version_found

    if is_auth:
        print(f"[Claude] ✓ Authenticated and ready! Version: {version_found}", flush=True)
    else:
        print(f"[Claude] ⚠ WARNING: Not authenticated - {auth_error}", flush=True)
        print(f"[Claude] Chat will fail until you run 'claude login' in your terminal", flush=True)
        # Don't block startup, but schedule a background retry
        asyncio.create_task(_background_auth_retry())


async def _background_auth_retry():
    """Background task that periodically retries auth check until successful.

    This runs in the background after startup if auth initially failed,
    automatically detecting when the user has logged in.
    """
    import asyncio

    max_retries = 30  # Try for up to 5 minutes (30 * 10s)
    retry_interval = 10  # Check every 10 seconds

    print("[Claude] Starting background auth monitor...", flush=True)

    for attempt in range(1, max_retries + 1):
        await asyncio.sleep(retry_interval)

        # Check if already authenticated (user might have run claude login)
        is_auth, error = await _check_claude_auth(force_recheck=True)

        if is_auth:
            print(f"[Claude] ✓ Background auth check successful! Claude is now ready.", flush=True)
            return

        # Log progress periodically
        if attempt % 6 == 0:  # Every minute
            print(f"[Claude] Background auth check {attempt}/{max_retries}: still waiting for login... ({error})", flush=True)

    print(f"[Claude] Background auth monitor stopped after {max_retries} attempts. User needs to run 'claude login'.", flush=True)


async def _check_secrets_access():
    """Check secrets storage at startup and log status."""
    print("[Secrets] Checking local secrets storage...", flush=True)

    # Test reading the github_token
    token = get_secret("github_token")
    if token:
        print(f"[Secrets] ✓ GitHub token found ({len(token)} chars)", flush=True)
    else:
        print(f"[Secrets] No GitHub token configured yet", flush=True)
        print(f"[Secrets] Add your GitHub PAT in Settings -> Code Search", flush=True)


async def ensure_claude_authenticated() -> tuple[bool, str | None]:
    """Ensure Claude is authenticated before making a request.

    Call this before any Claude API operation. It will:
    1. Check cached auth status
    2. If not authenticated, attempt recovery
    3. Return current status

    Returns: (is_authenticated, error_message)
    """
    global _claude_auth_status

    # Quick check from cache
    is_auth = _claude_auth_status.get("authenticated")
    if is_auth:
        return True, None

    # Force recheck
    is_auth, error = await _check_claude_auth(force_recheck=True)
    if is_auth:
        return True, None

    # Attempt auto-recovery if multiple failures
    recovered, recovery_msg = await _attempt_auto_recovery()
    if recovered:
        return True, None

    return False, error or "Authentication failed"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    print("K8s Agent Server starting...")

    # Initialize Sentinel with broadcaster for K8s event monitoring
    global global_sentinel
    global global_sentinel_task
    try:
        global_sentinel = SentinelLoop(kube_context=None, broadcaster=broadcaster)
        global_sentinel_task = asyncio.create_task(global_sentinel.start())
        print("[Sentinel] Started successfully", flush=True)
    except Exception as e:
        print(f"[Sentinel] Failed to start (cluster may be unavailable): {e}", flush=True)
        global_sentinel = None

    # Start Claude background compaction
    global global_compaction_task
    global_compaction_task = asyncio.create_task(background_claude_compaction())

    # Warmup Claude CLI (triggers keyring permission dialog early)
    await _warmup_claude_cli()

    # Check secrets storage and log status
    await _check_secrets_access()

    # Write server info for frontend discovery
    import json
    import os
    info_path = os.path.expanduser("~/.opspilot/server-info.json")
    try:
        os.makedirs(os.path.dirname(info_path), exist_ok=True)
        with open(info_path, "w") as f:
            json.dump({"port": 8765, "pid": os.getpid(), "version": AGENT_VERSION}, f)
        print(f"[Server] Wrote connection info to {info_path}", flush=True)
    except Exception as e:
        print(f"[Server] Failed to write connection info: {e}", flush=True)

    yield

    print("K8s Agent Server shutting down...")
    
    # Cleanup server info
    try:
        if os.path.exists(info_path):
            os.remove(info_path)
    except Exception as e:
        print(f"[Server] Failed to clean up info file: {e}", flush=True)

    if global_sentinel:
        await global_sentinel.stop()
    if global_sentinel_task:
        global_sentinel_task.cancel()
        try:
            await global_sentinel_task
        except asyncio.CancelledError:
            pass

    # Cancel any pending preload tasks
    for task in _preload_tasks.values():
        if not task.done():
            task.cancel()

app = FastAPI(
    title="K8s Troubleshooting Agent",
    description="LangGraph-based Kubernetes troubleshooting agent (Dual Model, Embeddings RAG)",
    version="3.0.0",
    lifespan=lifespan,
)

# --- Installer Endpoint ---
class InstallRequest(BaseModel):
    package: str = "claude-code"

@app.post("/setup/install")
async def install_package(req: InstallRequest):
    """Auto-install dependencies like Claude Code."""
    if req.package != "claude-code":
        return {"success": False, "error": "Only claude-code installation is supported"}

    import shutil
    import subprocess
    
    # Check for npm
    npm_path = shutil.which("npm")
    if not npm_path:
        return {"success": False, "error": "NPM is not installed. Please install Node.js first."}

    # Install to ~/.opspilot/bin to avoid permission issues
    install_dir = os.path.expanduser("~/.opspilot")
    bin_dir = os.path.join(install_dir, "bin")
    os.makedirs(bin_dir, exist_ok=True)

    print(f"[Installer] Installing {req.package} to {install_dir}...", flush=True)
    
    try:
        # Use npm install --prefix
        # Note: --prefix with -g installs to {prefix}/lib/node_modules and puts bin in {prefix}/bin
        # We need to ensure we invoke npm correctly cross-platform
        cmd = [npm_path, "install", "-g", "@anthropic-ai/claude-code", "--prefix", install_dir]
        
        # On Windows, npm is a cmd file
        if os.name == 'nt':
            cmd = ["cmd", "/c", npm_path, "install", "-g", "@anthropic-ai/claude-code", "--prefix", install_dir]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(os.environ),
        )
        stdout, stderr = await proc.communicate()
        
        if proc.returncode != 0:
            err_msg = stderr.decode()
            print(f"[Installer] Failed: {err_msg}", flush=True)
            return {"success": False, "error": f"NPM install failed: {err_msg}"}

        return {"success": True, "path": os.path.join(bin_dir, "claude")}

    except Exception as e:
        print(f"[Installer] Internal error: {e}", flush=True)
        return {"success": False, "error": str(e)}


# --- Claude Login Endpoint ---
@app.post("/setup/claude-login")
async def trigger_claude_login():
    """Trigger Claude CLI login process.

    This will launch 'claude login' which opens a browser for OAuth.
    The user must complete the login flow in the browser.

    Returns immediately with status - poll /status to check when login completes.
    """
    global _claude_auth_status

    claude_bin = find_executable_path("claude")
    if not claude_bin:
        return {
            "success": False,
            "error": "Claude CLI not installed. Install with: npm install -g @anthropic-ai/claude-code"
        }

    print(f"[Claude] Triggering login via: {claude_bin}", flush=True)

    try:
        # Launch claude login in a subprocess
        # This will open a browser for OAuth - we can't automate this part
        process = await asyncio.create_subprocess_exec(
            claude_bin, "login",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**dict(os.environ), "CI": "true"},
        )

        # Wait up to 60 seconds for login to complete
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=60.0
            )

            stdout_text = stdout.decode('utf-8', errors='replace').strip()
            stderr_text = stderr.decode('utf-8', errors='replace').strip()

            if process.returncode == 0:
                print(f"[Claude] Login successful!", flush=True)

                # Re-check auth status with force to update cache
                is_auth, auth_error = await _check_claude_auth(force_recheck=True)

                return {
                    "success": True,
                    "message": "Login successful! Claude is now authenticated.",
                    "output": stdout_text,
                    "authenticated": is_auth
                }
            else:
                print(f"[Claude] Login failed: {stderr_text}", flush=True)
                return {
                    "success": False,
                    "error": stderr_text or "Login failed",
                    "hint": "Please try running 'claude login' manually in your terminal"
                }

        except asyncio.TimeoutError:
            # Login didn't complete in time - might need browser interaction
            print(f"[Claude] Login timed out - browser interaction may be needed", flush=True)
            return {
                "success": False,
                "error": "Login timed out",
                "hint": "Please open a terminal and run 'claude login' to complete authentication"
            }

    except Exception as e:
        print(f"[Claude] Login error: {e}", flush=True)
        return {
            "success": False,
            "error": str(e),
            "hint": "Please try running 'claude login' manually in your terminal"
        }


@app.get("/setup/claude-status")
async def get_claude_status():
    """Get Claude CLI authentication status.

    Returns current auth status without triggering any prompts.
    """
    import time

    return {
        "authenticated": _claude_auth_status.get("authenticated"),
        "error": _claude_auth_status.get("error"),
        "version": _claude_auth_status.get("version"),
        "version_ok": _claude_auth_status.get("version_ok"),
        "installed": find_executable_path("claude") is not None,
        "consecutive_failures": _claude_auth_status.get("consecutive_failures", 0),
        "last_check_ago": int(time.time() - _claude_auth_status.get("last_check", 0)) if _claude_auth_status.get("last_check") else None,
    }


@app.post("/setup/claude-recheck")
async def recheck_claude_auth():
    """Re-check Claude authentication status.

    Call this after user has logged in via browser to refresh the cached status.
    """
    claude_bin = find_executable_path("claude")
    if not claude_bin:
        with _claude_auth_lock:
            _claude_auth_status.update({
                "authenticated": False,
                "error": "CLI not installed",
                "version": None,
                "last_check": 0
            })
        return dict(_claude_auth_status)

    print("[Claude] Re-checking authentication status (force)...", flush=True)
    is_auth, auth_error = await _check_claude_auth(force_recheck=True)

    return {
        "authenticated": is_auth,
        "error": auth_error,
        "version": _claude_auth_status.get("version"),
        "consecutive_failures": _claude_auth_status.get("consecutive_failures", 0)
    }


@app.post("/setup/claude-recover")
async def recover_claude_connection():
    """Attempt to recover Claude connection after failures.

    Triggers the auto-recovery mechanism which:
    1. Checks for stale processes
    2. Verifies CLI health
    3. Re-authenticates if possible
    """
    print("[Claude] Manual recovery triggered by user...", flush=True)

    # Force a failure count to trigger recovery
    with _claude_auth_lock:
        _claude_auth_status["consecutive_failures"] = 3

    recovered, message = await _attempt_auto_recovery()

    return {
        "recovered": recovered,
        "message": message,
        "authenticated": _claude_auth_status.get("authenticated"),
        "error": _claude_auth_status.get("error")
    }


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Global Exception Handler ---
# Ensures CORS headers are ALWAYS sent, even on 500 errors
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

class SafeExceptionMiddleware(BaseHTTPMiddleware):
    """
    Catches ALL exceptions and returns a proper JSON response with CORS headers.
    This prevents the browser from seeing CORS errors when the server crashes.
    """
    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except Exception as e:
            print(f"[Server] [ERROR] Unhandled exception on {request.url.path}: {e}", flush=True)
            import traceback
            traceback.print_exc()
            return JSONResponse(
                status_code=500,
                content={
                    "error": "Internal server error",
                    "detail": str(e),
                    "path": str(request.url.path),
                    "recoverable": True
                },
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "*",
                    "Access-Control-Allow-Headers": "*",
                }
            )

# Add BEFORE CORS middleware so it catches exceptions from all routes
app.add_middleware(SafeExceptionMiddleware)


# --- Robust Health & Status Endpoints ---
@app.get("/health")
async def health_check():
    """
    Simple health check - ALWAYS returns 200 if server is running.
    Use this for connectivity checks before other operations.
    """
    return {"status": "ok", "version": AGENT_VERSION}


@app.get("/status")
async def server_status():
    """
    Detailed status check with component health.
    Returns degraded status if some components are down, but still 200.
    """
    components = {
        "server": "ok",
        "sentinel": "unknown",
        "kb_search": "unknown",
        "claude": "unknown",
    }

    # Check Sentinel
    try:
        if global_sentinel:
            components["sentinel"] = "running" if global_sentinel_task and not global_sentinel_task.done() else "stopped"
        else:
            components["sentinel"] = "not_initialized"
    except Exception as e:
        components["sentinel"] = f"error: {e}"

    # Check KB search
    try:
        components["kb_search"] = "available" if search.embedding_model_available else "unavailable"
    except Exception as e:
        components["kb_search"] = f"error: {e}"

    # Check Claude CLI auth status
    if _claude_auth_status.get("authenticated") is True:
        components["claude"] = "authenticated"
    elif _claude_auth_status.get("authenticated") is False:
        components["claude"] = f"not_authenticated: {_claude_auth_status.get('error', 'unknown')}"
    else:
        components["claude"] = "checking"

    overall = "ok" if all(v in ["ok", "running", "available", "authenticated"] for v in components.values()) else "degraded"

    return {
        "status": overall,
        "components": components,
        "version": AGENT_VERSION,
        "claude_status": _claude_auth_status
    }


@app.post("/restart-sentinel")
async def restart_sentinel():
    """
    User-triggered restart of the Sentinel component.
    Use this to recover from Sentinel failures without restarting the server.
    """
    global global_sentinel
    global global_sentinel_task

    try:
        # Get current context before stopping
        current_context = global_sentinel.kube_context if global_sentinel else None
        print(f"[Sentinel] User-triggered restart for context: {current_context}", flush=True)

        # Stop existing task
        if global_sentinel_task:
            global_sentinel_task.cancel()
            try:
                await global_sentinel_task
            except asyncio.CancelledError:
                pass
            except Exception as e:
                print(f"[Sentinel] Warning during task cancellation: {e}", flush=True)
            global_sentinel_task = None

        # Stop old sentinel
        if global_sentinel:
            await global_sentinel.stop()

        # Create fresh sentinel with same context
        global_sentinel = SentinelLoop(kube_context=current_context, broadcaster=broadcaster)
        global_sentinel_task = asyncio.create_task(global_sentinel.start())

        print(f"[Sentinel] Restarted successfully", flush=True)
        return {"success": True, "message": f"Sentinel restarted for context: {current_context or 'default'}"}
    except Exception as e:
        print(f"[Sentinel] [ERROR] Restart failed: {e}", flush=True)
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e), "recoverable": True}


@app.get("/events")
async def events_stream():
    """Global event stream for background alerts (Sentinel)."""
    return EventSourceResponse(broadcaster.subscribe())


class PreloadRequest(BaseModel):
    kube_context: str


@app.post("/preload")
async def preload_context(request: PreloadRequest):
    """
    Trigger background KB preloading for a context.
    Call this when user switches contexts to warm the cache.
    """
    try:
        print(f"[KB] [RECV] Preload request received for context: {request.kube_context}", flush=True)
        started = trigger_background_preload(request.kube_context)
        status = _preload_status.get(request.kube_context, "pending")
        print(f"[KB] [RECV] Preload started={started}, status={status}", flush=True)
        return {
            "context": request.kube_context,
            "started": started,
            "status": status
        }
    except Exception as e:
        print(f"[KB] [ERROR] Preload error: {e}", flush=True)
        return {
            "context": request.kube_context,
            "started": False,
            "status": "error",
            "error": str(e)
        }


@app.get("/preload/status/{kube_context}")
async def preload_status(kube_context: str):
    """Check preload status for a context."""
    status = _preload_status.get(kube_context, "not_started")
    task = _preload_tasks.get(kube_context)
    is_loading = task and not task.done() if task else False
    return {
        "context": kube_context,
        "status": status,
        "is_loading": is_loading
    }


@app.post("/sentinel/context")
async def update_sentinel_context(request: PreloadRequest):
    """
    Update the Sentinel's kube context to match the UI's current context.
    Call this when the user switches clusters.
    """
    global global_sentinel
    global global_sentinel_task

    try:
        old_context = global_sentinel.kube_context if global_sentinel else None

        # Check if context actually changed
        if old_context == request.kube_context:
            return {"success": True, "context": request.kube_context, "previous": old_context, "restarted": False}

        print(f"[Sentinel] Context switching: {old_context} -> {request.kube_context}", flush=True)

        # Cancel existing task first
        if global_sentinel_task:
            global_sentinel_task.cancel()
            try:
                await global_sentinel_task
            except asyncio.CancelledError:
                pass
            except Exception as e:
                print(f"[Sentinel] Warning: Error during task cancellation: {e}", flush=True)
            global_sentinel_task = None

        # Stop old sentinel
        if global_sentinel:
            await global_sentinel.stop()

        # Create a fresh SentinelLoop with the new context
        # This ensures clean state (no stale connections, fresh backoff counters)
        global_sentinel = SentinelLoop(kube_context=request.kube_context, broadcaster=broadcaster)

        # Start new task
        global_sentinel_task = asyncio.create_task(global_sentinel.start())

        print(f"[Sentinel] New loop started for context: {request.kube_context}", flush=True)
        return {"success": True, "context": request.kube_context, "previous": old_context, "restarted": True}

    except Exception as e:
        print(f"[Sentinel] Error updating context: {e}", flush=True)
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}


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
    provider: Literal["groq", "openai", "ollama", "anthropic", "claude-code", "codex-cli"]
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None

@app.post("/llm/test")
async def test_llm_connection(request: TestRequest):
    """Test connectivity and credentials for the given LLM provider.

    For Groq/OpenAI: attempts to list models and perform a tiny completion.
    For Ollama: checks /api/tags and performs a tiny generate.
    For Claude Code: checks if CLI is installed and responsive.
    """
    try:
        # Special handling for Claude Code and Codex CLI
        if request.provider == "claude-code":
            return await _test_claude_code_connection()
        if request.provider == "codex-cli":
            return await _test_codex_connection()

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


# --- CLI Discovery Helper ---
def find_executable_path(exe_name: str) -> str | None:
    """Find executable in PATH or common locations."""
    import shutil
    import os
    
    # 1. Check system PATH first
    path = shutil.which(exe_name)
    if path: return path
    
    # 2. Check common locations
    common_dirs = [
        os.path.expanduser("~/.npm-global/bin"),
        os.path.expanduser("~/.local/bin"),
        os.path.expanduser("~/.cargo/bin"),
        os.path.expanduser("~/.opspilot/bin"), # OpsPilot managed bin
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/usr/bin",
        "/bin",
        # Windows specific
        os.path.expanduser("~\\AppData\\Roaming\\npm"),
    ]
    
    for d in common_dirs:
        if not d or not os.path.isdir(d):
            continue
            
        # Check standard name
        p = os.path.join(d, exe_name)
        if os.path.exists(p) and os.access(p, os.X_OK):
            return p
            
        # Check extensions (Windows/all)
        exts = [".cmd", ".exe", ".ps1", ".bat"] if sys.platform == "win32" else [""]
        for ext in exts:
            p_ext = p + ext
            if os.path.exists(p_ext) and (sys.platform == "win32" or os.access(p_ext, os.X_OK)):
                return p_ext
            
    return None

# Cache for Claude CLI test results to avoid repeated keyring prompts
_claude_test_cache: dict = {"result": None, "timestamp": 0, "ttl": 300}  # 5 min cache

async def _test_claude_code_connection():
    """Test Claude Code CLI availability WITHOUT triggering keyring access.

    Strategy:
    1. Check cache first (5 min TTL)
    2. Just verify the executable exists and is executable (no subprocess call)
    3. Only call CLI if we need to verify version (which shouldn't need keyring)

    This avoids the macOS keyring permission prompt that happens when spawning
    the Claude CLI subprocess from a different process context.
    """
    import time

    # Check cache first - if we have a recent result, return it
    global _claude_test_cache
    now = time.time()
    if _claude_test_cache["result"] and (now - _claude_test_cache["timestamp"]) < _claude_test_cache["ttl"]:
        cached = _claude_test_cache["result"]
        print(f"[claude-test] Returning cached result (age: {int(now - _claude_test_cache['timestamp'])}s)", flush=True)
        return cached

    config = load_opspilot_config()
    claude_bin = config.get("claude_cli_path")
    if not claude_bin or claude_bin == "claude":
        claude_bin = find_executable_path("claude")

    if not claude_bin:
        return {
            "provider": "claude-code",
            "connected": False,
            "models_count": 0,
            "completion_ok": False,
            "error": "Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
            "completion_error": "CLI not installed",
        }

    # Simple file-based check: if the executable exists and is executable, assume it works
    # This avoids spawning a subprocess which can trigger keyring prompts
    if os.path.isfile(claude_bin) and os.access(claude_bin, os.X_OK):
        print(f"[claude-test] Claude CLI found at: {claude_bin} (file check only, no subprocess)", flush=True)
        success_result = {
            "provider": "claude-code",
            "connected": True,
            "models_count": 2,
            "completion_ok": True,
            "error": None,
            "completion_error": None,
            "version": "installed",  # We don't call --version to avoid keyring
        }
        # Cache the result
        _claude_test_cache["result"] = success_result
        _claude_test_cache["timestamp"] = time.time()
        return success_result

    # Executable not found or not executable
    print(f"[claude-test] Claude CLI not executable at: {claude_bin}", flush=True)
    return {
        "provider": "claude-code",
        "connected": False,
        "models_count": 0,
        "completion_ok": False,
        "error": f"Claude CLI found but not executable: {claude_bin}",
        "completion_error": "CLI not executable",
    }

async def _test_codex_connection():
    """Quick test for Codex CLI availability."""
    import asyncio

    try:
        # Quick check: run 'codex --version'
        codex_bin = find_executable_path("codex") or "codex"

        # Use DEVNULL for stdin to prevent broken pipe errors
        process = await asyncio.create_subprocess_exec(
            codex_bin, "--version",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(os.environ),
        )

        stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=10.0
        )

        if process.returncode == 0:
            version_info = stdout.decode('utf-8', errors='replace').strip()
            return {
                "provider": "codex-cli",
                "connected": True,
                "models_count": 1, 
                "completion_ok": True,
                "error": None,
                "completion_error": None,
                "version": version_info,
            }
        else:
            error_msg = stderr.decode('utf-8', errors='replace').strip() or "CLI returned non-zero exit code"
            return {
                "provider": "codex-cli",
                "connected": False,
                "models_count": 0,
                "completion_ok": False,
                "error": error_msg,
                "completion_error": error_msg,
            }

    except asyncio.TimeoutError:
        return {
            "provider": "codex-cli",
            "connected": False,
            "models_count": 0,
            "completion_ok": False,
            "error": "Codex CLI timed out (>10s)",
            "completion_error": "CLI unresponsive",
        }
    except FileNotFoundError:
        return {
            "provider": "codex-cli",
            "connected": False,
            "models_count": 0,
            "completion_ok": False,
            "error": "Codex CLI not found. Install with: npm install -g @openai/codex-cli",
            "completion_error": "CLI not installed",
        }
    except Exception as e:
        return {
            "provider": "codex-cli",
            "connected": False,
            "models_count": 0,
            "completion_ok": False,
            "error": str(e),
            "completion_error": str(e),
        }

# --- OpsPilot Config Management (GitHub, MCP, etc.) ---

OPSPILOT_CONFIG_PATH = os.path.expanduser("~/.opspilot/config.json")
OPSPILOT_CONFIG_LEGACY_PATH = os.path.expanduser("~/.opspilot.json")
OPSPILOT_SECRETS_PATH = os.path.expanduser("~/.opspilot/secrets.enc")

def _get_machine_key() -> bytes:
    """Get a machine-specific key for obfuscating secrets.

    Uses a combination of username and home directory to create a stable key.
    This is NOT cryptographically secure - just obfuscation to prevent casual reading.
    """
    import hashlib
    # Use stable machine identifiers
    identity = f"{os.getenv('USER', 'user')}:{os.path.expanduser('~')}:opspilot"
    return hashlib.sha256(identity.encode()).digest()

def _obfuscate(plaintext: str) -> str:
    """Obfuscate a string using XOR with machine key + base64."""
    import base64
    key = _get_machine_key()
    data = plaintext.encode('utf-8')
    # XOR with repeating key
    obfuscated = bytes(b ^ key[i % len(key)] for i, b in enumerate(data))
    return base64.b64encode(obfuscated).decode('ascii')

def _deobfuscate(encoded: str) -> str:
    """Deobfuscate a string."""
    import base64
    key = _get_machine_key()
    obfuscated = base64.b64decode(encoded.encode('ascii'))
    # XOR with repeating key (same operation reverses it)
    data = bytes(b ^ key[i % len(key)] for i, b in enumerate(obfuscated))
    return data.decode('utf-8')

def _load_local_secrets() -> dict:
    """Load secrets from local encrypted file."""
    if not os.path.exists(OPSPILOT_SECRETS_PATH):
        return {}
    try:
        with open(OPSPILOT_SECRETS_PATH, 'r') as f:
            encoded_data = json.load(f)
        # Decode each secret
        return {k: _deobfuscate(v) for k, v in encoded_data.items()}
    except Exception as e:
        print(f"[secret] Failed to load local secrets: {e}", flush=True)
        return {}

def _save_local_secrets(secrets: dict):
    """Save secrets to local encrypted file."""
    try:
        os.makedirs(os.path.dirname(OPSPILOT_SECRETS_PATH), exist_ok=True)
        # Encode each secret
        encoded_data = {k: _obfuscate(v) for k, v in secrets.items()}
        with open(OPSPILOT_SECRETS_PATH, 'w') as f:
            json.dump(encoded_data, f)
        # Set restrictive permissions (owner read/write only)
        os.chmod(OPSPILOT_SECRETS_PATH, 0o600)
        print(f"[secret] Saved secrets to local file", flush=True)
    except Exception as e:
        print(f"[secret] Failed to save local secrets: {e}", flush=True)

def get_secret(key: str) -> str | None:
    """Retrieve a secret from local encrypted file or environment variables.

    Priority order:
    1. Local encrypted file (~/.opspilot/secrets.enc) - primary storage
    2. Environment variables (GITHUB_TOKEN or OPSPILOT_GITHUB_TOKEN)
    """
    # 1. Try local encrypted file first (primary storage)
    local_secrets = _load_local_secrets()
    if key in local_secrets and local_secrets[key]:
        return local_secrets[key]

    # 2. Fallback to environment variable
    env_key = key.upper()
    env_value = os.environ.get(env_key)
    if env_value:
        print(f"[secret] Using fallback: ${env_key} environment variable", flush=True)
        return env_value

    # Also try OPSPILOT_ prefixed version
    prefixed_key = f"OPSPILOT_{env_key}"
    prefixed_value = os.environ.get(prefixed_key)
    if prefixed_value:
        print(f"[secret] Using fallback: ${prefixed_key} environment variable", flush=True)
        return prefixed_value

    return None

def set_secret(key: str, value: str):
    """Store a secret in local encrypted file."""
    local_secrets = _load_local_secrets()
    local_secrets[key] = value
    _save_local_secrets(local_secrets)

def delete_secret(key: str):
    """Remove a secret from local storage."""
    local_secrets = _load_local_secrets()
    if key in local_secrets:
        del local_secrets[key]
        _save_local_secrets(local_secrets)

def load_opspilot_config() -> dict:
    """Load OpsPilot config from ~/.opspilot/config.json or legacy ~/.opspilot.json"""
    config = {}
    
    # Try preferred path first
    if os.path.exists(OPSPILOT_CONFIG_PATH):
        try:
            with open(OPSPILOT_CONFIG_PATH) as f:
                config = json.load(f)
        except Exception as e:
            print(f"[config] Failed to load config from {OPSPILOT_CONFIG_PATH}: {e}", flush=True)
    
    # Fallback to legacy path if preferred doesn't exist or is empty
    if not config and os.path.exists(OPSPILOT_CONFIG_LEGACY_PATH):
        try:
            with open(OPSPILOT_CONFIG_LEGACY_PATH) as f:
                config = json.load(f)
                print(f"[config] Loaded from legacy path: {OPSPILOT_CONFIG_LEGACY_PATH}", flush=True)
        except Exception as e:
            print(f"[config] Failed to load legacy config: {e}", flush=True)

    # Overlay secrets from Keyring
    pat = get_secret("github_token")
    if pat:
        config["github_pat"] = pat
        
    return config

def save_opspilot_config(config: dict):
    """Save OpsPilot config to ~/.opspilot/config.json, securing secrets in Keyring."""
    os.makedirs(os.path.dirname(OPSPILOT_CONFIG_PATH), exist_ok=True)
    
    config_to_save = config.copy()
    
    # Extract and secure GitHub PAT
    if "github_pat" in config_to_save:
        pat = config_to_save.pop("github_pat")
        if pat:
            set_secret("github_token", pat)
        else:
            delete_secret("github_token")
    
    with open(OPSPILOT_CONFIG_PATH, 'w') as f:
        json.dump(config_to_save, f, indent=2)
    print(f"[config] Saved sanitized config to {OPSPILOT_CONFIG_PATH}", flush=True)

# write_mcp_config removed - replaced by native `github_smart_search` tool


class GitHubConfigRequest(BaseModel):
    pat_token: str | None = None
    default_repos: list[str] = []
    search_all_repos: bool = True  # When True, search all accessible repos instead of specific ones
    claude_cli_path: str | None = None


@app.get("/github-config")
async def get_github_config():
    """Get GitHub integration config (without exposing the PAT)."""
    config = load_opspilot_config()
    return {
        "configured": bool(config.get("github_pat")),
        "default_repos": config.get("github_repos", []),
        "search_all_repos": config.get("github_search_all_repos", True),
        "claude_cli_path": config.get("claude_cli_path", "claude")
    }


@app.post("/github-config")
async def set_github_config(request: GitHubConfigRequest):
    """Set GitHub PAT and default repos."""
    config = load_opspilot_config()

    if request.pat_token:
        config["github_pat"] = request.pat_token
    elif request.pat_token == "":
        # Empty string means clear the PAT
        config.pop("github_pat", None)

    config["github_repos"] = request.default_repos
    config["github_search_all_repos"] = request.search_all_repos
    
    if request.claude_cli_path:
        config["claude_cli_path"] = request.claude_cli_path
        
    save_opspilot_config(config)

    # Write MCP config for Claude Code
    # write_mcp_config(config.get("github_pat")) # REMOVED: Replaced by local search tool logic

    return {"status": "ok", "configured": bool(config.get("github_pat"))}


class LocalReposConfigRequest(BaseModel):
    local_repos: list[str]


@app.get("/local-repos-config")
async def get_local_repos_config():
    """Get configured local repositories."""
    config = load_opspilot_config()
    return {"local_repos": config.get("local_repos", [])}


@app.post("/local-repos-config")
async def set_local_repos_config(request: LocalReposConfigRequest):
    """Set configured local repositories."""
    config = load_opspilot_config()
    config["local_repos"] = request.local_repos
    save_opspilot_config(config)
    return {"status": "ok", "local_repos": request.local_repos}


@app.post("/github-config/test")
async def test_github_connection():
    """Test GitHub PAT is valid by calling GitHub API."""
    config = load_opspilot_config()
    pat = config.get("github_pat")

    if not pat:
        return {"connected": False, "error": "No PAT configured", "user": None}

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                "https://api.github.com/user",
                headers={
                    "Authorization": f"Bearer {pat}",
                    "Accept": "application/vnd.github.v3+json"
                }
            )
            if resp.status_code == 200:
                user = resp.json()
                return {
                    "connected": True,
                    "user": user.get("login"),
                    "error": None
                }
            elif resp.status_code == 401:
                return {
                    "connected": False,
                    "user": None,
                    "error": "Invalid or expired token"
                }
            else:
                return {
                    "connected": False,
                    "user": None,
                    "error": f"GitHub API error: {resp.status_code}"
                }
    except Exception as e:
        return {
            "connected": False,
            "user": None,
            "error": str(e)
        }


@app.get("/github/orgs")
async def list_github_groups():
    """List GitHub organizations and the user's personal account."""
    config = load_opspilot_config()
    pat = config.get("github_pat")
    if not pat:
        raise HTTPException(status_code=400, detail="GitHub PAT not configured")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            headers = {
                "Authorization": f"Bearer {pat}",
                "Accept": "application/vnd.github.v3+json"
            }
            
            # Fetch user info
            user_resp = await client.get("https://api.github.com/user", headers=headers)
            user_resp.raise_for_status()
            user = user_resp.json()
            
            groups = [{
                "id": user["login"],
                "name": f"{user['login']} (Personal)",
                "type": "user",
                "avatar_url": user.get("avatar_url")
            }]
            
            # Fetch organizations
            orgs_resp = await client.get("https://api.github.com/user/orgs", headers=headers)
            orgs_resp.raise_for_status()
            orgs = orgs_resp.json()
            
            for org in orgs:
                groups.append({
                    "id": org["login"],
                    "name": org.get("name", org["login"]),
                    "type": "org",
                    "avatar_url": org.get("avatar_url")
                })
                
            return groups
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch GitHub organizations: {str(e)}")


@app.get("/github/repos/{group_id}")
async def list_github_repos(group_id: str):
    """List repositories for a GitHub user or organization."""
    config = load_opspilot_config()
    pat = config.get("github_pat")
    if not pat:
        raise HTTPException(status_code=400, detail="GitHub PAT not configured")

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            headers = {
                "Authorization": f"Bearer {pat}",
                "Accept": "application/vnd.github.v3+json"
            }

            # First, check user login to see if group_id is the user
            user_resp = await client.get("https://api.github.com/user", headers=headers)
            user_resp.raise_for_status()
            user = user_resp.json()

            all_repos = []

            if user.get("login") == group_id:
                # For the authenticated user, fetch ALL accessible repos (owner, collaborator, org member)
                # This includes repos from all orgs the user has access to
                page = 1
                while True:
                    url = f"https://api.github.com/user/repos?per_page=100&page={page}&sort=updated"
                    repos_resp = await client.get(url, headers=headers)
                    repos_resp.raise_for_status()
                    repos = repos_resp.json()
                    if not repos:
                        break
                    all_repos.extend(repos)
                    if len(repos) < 100:
                        break
                    page += 1
                    if page > 10:  # Safety limit: 1000 repos max
                        break
            else:
                # For organizations, fetch org repos with pagination
                page = 1
                while True:
                    url = f"https://api.github.com/orgs/{group_id}/repos?per_page=100&page={page}&sort=updated"
                    repos_resp = await client.get(url, headers=headers)

                    if repos_resp.status_code == 404:
                        # Not an org, try as a user
                        url = f"https://api.github.com/users/{group_id}/repos?per_page=100&page={page}&sort=updated"
                        repos_resp = await client.get(url, headers=headers)

                    repos_resp.raise_for_status()
                    repos = repos_resp.json()
                    if not repos:
                        break
                    all_repos.extend(repos)
                    if len(repos) < 100:
                        break
                    page += 1
                    if page > 10:  # Safety limit: 1000 repos max
                        break

            print(f"[github] Fetched {len(all_repos)} repos for {group_id}", flush=True)
            return [repo["full_name"] for repo in all_repos]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch GitHub repositories: {str(e)}")


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
    project_mappings: list[dict] = [] # Image pattern -> Local path mappings

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
async def pull_embedding_model(
    llm_endpoint: str = "http://localhost:11434",
    embedding_endpoint: str | None = None,
    model_name: str | None = None
):
    """Pull/download the embedding model with user consent."""

    # Use provided model_name or fall back to config default
    target_model = model_name or EMBEDDING_MODEL

    target_endpoint = embedding_endpoint or llm_endpoint
    base = target_endpoint or ""
    clean_endpoint = base.rstrip('/').removesuffix('/v1').rstrip('/') if base else "http://localhost:11434"

    print(f"[embedding-pull] [RECV] Pulling model '{target_model}' from {clean_endpoint}", flush=True)

    async def stream_progress():
        async with httpx.AsyncClient() as client:
            try:
                # Start pull with streaming
                async with client.stream(
                    "POST",
                    f"{clean_endpoint}/api/pull",
                    json={"name": target_model, "stream": True},
                    timeout=600.0  # 10 min timeout
                ) as response:
                    if response.status_code != 200:
                        error_text = await response.aread()
                        err_msg = 'HTTP ' + str(response.status_code) + ': ' + error_text.decode()
                        yield f"data: {json.dumps({'status': 'error', 'message': err_msg})}\n\n"
                        return

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
                    success_msg = 'Model ' + target_model + ' ready'
                    yield f"data: {json.dumps({'status': 'success', 'message': success_msg})}\n\n"

            except httpx.ConnectError as e:
                err_msg = 'Cannot connect to Ollama at ' + clean_endpoint + '. Is Ollama running?'
                yield f"data: {json.dumps({'status': 'error', 'message': err_msg})}\n\n"
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
                print(f"[Query Rewriter] [OK] Rewrote query (confidence: {rewritten.confidence})", flush=True)
                print(f"[Query Rewriter] Detected resources: {rewritten.detected_resources}", flush=True)
                print(f"[Query Rewriter] New query: {rewritten.rewritten_query}", flush=True)
                final_query = rewritten.rewritten_query
            else:
                print(f"[Query Rewriter] [WARN] Low confidence ({rewritten.confidence}), using original query", flush=True)
                final_query = original_query

        except Exception as e:
            print(f"[Query Rewriter] [ERROR] Failed: {e}, using original query", flush=True)
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
            # Claude Code fast path
            "embedded_tool_call": None,
            "embedded_tool_call": None,
            "project_mappings": request.project_mappings or load_opspilot_config().get("project_mappings", []),
            "workspace_roots": local_repos,  # Zero-Config: all configured local repos are search targets
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
            yield f"data: {json.dumps(emit_event('progress', {'message': '[BRAIN] Starting analysis...'}))}\n\n"

            # Transparent Intelligence: Immediate "Warm-up" signals
            # These give the user immediate feedback that the system is active and aware
            yield f"data: {json.dumps(emit_event('progress', {'message': '[SHIELD] Verifying permissions...'}))}\n\n"
            await asyncio.sleep(0.1)
            yield f"data: {json.dumps(emit_event('progress', {'message': '[SEARCH] Integrating Cluster Knowledge...'}))}\n\n"
            await asyncio.sleep(0.1)

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
                    msg = '[BRAIN] Loading model' + '.' * dots + ' (' + str(elapsed) + 's)'
                    await heartbeat_queue.put(f"data: {json.dumps(emit_event('progress', {'message': msg}))}\n\n")

            try:
                for attempt in range(max_attempts):
                    # If retrying, inject a hint into the query
                    if attempt > 0:
                     print(f"[SYNC] Backtracking Attempt {attempt+1}/{max_attempts}...", flush=True)
                     retry_msg = 'Previous path failed. Backtracking (Attempt ' + str(attempt+1) + ')...'
                     yield f"data: {json.dumps(emit_event('status', {'message': retry_msg, 'type': 'retry'}))}\n\n"

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
                            thinking_msg = '[BRAIN] Thinking' + dots + ' (' + str(elapsed) + 's)'
                            yield f"data: {json.dumps(emit_event('progress', {'message': thinking_msg}))}\n\n"
                            last_heartbeat = current_time

                        # Handle Tool Starts for "Glass Box" transparency
                        if kind == "on_tool_start":
                            tool_data = event.get('data', {})
                            tool_name = event.get('name', '')
                            
                            # Map raw tool names to user-friendly "Thoughts"
                            # This replaces the generic spinner with specific actions
                            friendly_message = None
                            if tool_name == 'kb_search':
                                friendly_message = '[KB] Consulting Knowledge Base...'
                            elif tool_name == 'list_k8s_resources':
                                friendly_message = '[SEARCH] Scouting Cluster Resources...'
                            elif tool_name == 'get_resource_details':
                                friendly_message = '[LIST] Inspecting Resource Details...'
                            elif tool_name == 'get_pod_logs':
                                friendly_message = '[LOG] Reading Logs...'
                            elif tool_name == 'kubectl_command':
                                friendly_message = '[RUN] Executing Command...'
                            
                            if friendly_message:
                                yield f"data: {json.dumps(emit_event('progress', {'message': friendly_message}))}\n\n"
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
                                        print(f"[OK] FINAL RESPONSE from {event['name']}", flush=True)
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
                                        detail_str = 'node=' + event['name']
                                        yield f"data: {json.dumps(emit_phase_event(phase_name, detail=detail_str))}\n\n"

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
                                            print(f"[server] [ERROR] CRITICAL: Approval loop detected ({approval_loop_count} iterations). Breaking loop with fallback response.", flush=True)

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
                                                print(f"[server] [ERROR] Fallback generation failed: {e}", flush=True)
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
                                            print(f"[server] [WARN] Approval needed (iteration {approval_loop_count}). Waiting for user...", flush=True)
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
                        print(f"[ERROR] Attempt {attempt+1} failed to produce final_response. Current keys: {initial_state.keys()}", flush=True)
                        if 'error' in initial_state:
                             print(f"[ERROR] State Error: {initial_state['error']}", flush=True)

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
                    print(f"[WARN] Using error as final_answer: {initial_state['error']}", flush=True)
                    final_answer = f"Error: {initial_state['error']}"
                elif not final_answer:
                    # Synthesize a useful final response from command history
                    print(f"[WARN] No final_answer from nodes, generating fallback response with {len(initial_state.get('command_history', []))} commands", flush=True)
                    try:
                        from .response_formatter import format_intelligent_response_with_llm
                        print(f"[SYNC] Calling format_intelligent_response_with_llm...", flush=True)
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
                        print(f"[OK] Fallback response generated: {final_answer[:100]}...", flush=True)
                    except Exception as e:
                        # Fallback simple summary
                        print(f"[ERROR] format_intelligent_response_with_llm failed: {e}, using simple fallback", flush=True)
                        from .response_formatter import format_intelligent_response
                        final_answer = format_intelligent_response(
                            query=initial_state.get('query', ''),
                            command_history=initial_state.get('command_history', []),
                            discovered_resources=initial_state.get('discovered_resources') or {},
                            hypothesis=initial_state.get('current_hypothesis') or None,
                        )
                        print(f"[OK] Simple fallback response: {final_answer[:100]}...", flush=True)

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

                # Check if agent actually solved the problem (for "Mark as Solution" button)
                is_solution = any(
                    str(h.get('assessment', '')).upper() in ['SOLVED', 'AUTO_SOLVED']
                    for h in initial_state.get('command_history', [])
                )

                # Agent completed successfully
                if final_answer:
                    print(f"   Preview: {final_answer[:150]}...", flush=True)
                if suggested_next_steps:
                    print(f"   [TIP] Suggestions: {suggested_next_steps}", flush=True)

                yield f"data: {json.dumps(emit_event('done', {'final_response': final_answer, 'suggested_next_steps': suggested_next_steps, 'is_solution': is_solution}))}\n\n"

            except Exception as e:
                import traceback
                print(f"[ERROR] Error in event_generator: {e}", flush=True)
                print(f"[ERROR] Full traceback:\n{traceback.format_exc()}", flush=True)
                # Ensure we yield a final error event if something crashed
                err_msg = 'Internal Error: ' + str(e)
                yield f"data: {json.dumps(emit_event('status', {'message': err_msg, 'type': 'error'}))}\n\n"

            except Exception as e:
                # Handle errors in backtracking/retry loop
                print(f"[event_generator] Error during graph execution: {e}", flush=True)
                err_msg = 'Investigation error: ' + str(e)
                yield f"data: {json.dumps(emit_event('error', {'message': err_msg}))}\n\n"

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

        err_msg = 'Server Error: ' + str(e)
        return StreamingResponse(
            iter([f"data: {json.dumps(emit_event('error', {'message': err_msg}))}\n\n"]),
            media_type="text/event-stream"
        )


# =============================================================================
# DIRECT AGENT ENDPOINT - Single Claude Code call (fast path)
# =============================================================================

class McpServerConfig(BaseModel):
    """MCP server configuration."""
    name: str
    command: str
    args: list[str] = []
    env: dict[str, str] = {}


class DirectAgentRequest(BaseModel):
    """Request for direct Claude Code agent."""
    query: str
    kube_context: str = ""
    thread_id: str = "default_session"
    llm_provider: str | None = None
    tool_subset: str | None = None  # "full", "code_search", "k8s_only"
    fast_mode: bool = False
    resource_context: str | None = None  # e.g. "Pod/nginx-1 namespace:default"
    mcp_servers: list[McpServerConfig] = []  # Connected MCP servers to pass to Claude


# =============================================================================
# CONTROLLER DISCOVERY & HEALTH (Async with Background Processing)
# =============================================================================

@app.get("/analyze-controllers")
async def analyze_controllers_endpoint(kube_context: str = "", force_refresh: bool = False):
    """
    Analyze Controller/Operator topology and health.

    Returns cached data immediately if available.
    If not cached or force_refresh=True, starts background scan and returns partial data.

    Response includes:
    - status: "complete" | "scanning" | "empty"
    - data: controller/CRD data (may be partial during scanning)
    - progress: scan progress if scanning
    """
    from .discovery import (
        discovery_cache, get_discovery_status,
        run_full_discovery_async
    )

    print(f"[discovery] [SEARCH] Controller Analysis request for context: {kube_context}, force={force_refresh}")

    try:
        # Check cache first
        if not force_refresh:
            cached = discovery_cache.get(kube_context)
            if cached:
                print(f"[discovery] [OK] Returning cached data")
                return {
                    "status": "complete",
                    "controllers": cached.get("controllers", []),
                    "crds": cached.get("crds", []),
                    "mapping": cached.get("mapping", {}),
                    "unhealthy_crs": cached.get("unhealthy_crs", [])
                }

        # Check if scan is in progress
        if discovery_cache.is_scanning(kube_context):
            progress = discovery_cache.get_scan_progress(kube_context)
            print(f"[discovery] [WAIT] Scan in progress: {progress.get('scanned_crds', 0)}/{progress.get('total_crds', 0)}")
            return {
                "status": "scanning",
                "progress": {
                    "scanned": progress.get("scanned_crds", 0),
                    "total": progress.get("total_crds", 0)
                },
                "controllers": progress.get("controllers", []),
                "crds": progress.get("crds", []),
                "mapping": progress.get("mapping", {}),
                "unhealthy_crs": progress.get("unhealthy_crs", [])
            }

        # Start new background scan
        print(f"[discovery] [START] Starting background discovery...")

        # Run the discovery in background (fire and forget)
        asyncio.create_task(run_full_discovery_async(kube_context))

        # Return immediately with empty/scanning status
        return {
            "status": "scanning",
            "progress": {"scanned": 0, "total": 0},
            "controllers": [],
            "crds": [],
            "mapping": {},
            "unhealthy_crs": []
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[discovery] [ERROR] Error in analyze-controllers: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Controller Analysis Failed: {str(e)}")


@app.get("/controller-discovery-status")
async def controller_discovery_status(kube_context: str = ""):
    """
    Get the current status of controller discovery.
    Use this for polling during background scans.
    """
    from .discovery import get_discovery_status

    status = get_discovery_status(kube_context)
    return status


# =============================================================================
# CUSTOM RESOURCE HEALTH (Crossplane, Upbound, and Custom CRDs)
# =============================================================================

# Cache for custom resource health
_cr_health_cache: dict = {}
_cr_health_scanning: dict = {}
_cr_health_progress: dict = {}  # Progressive scan state: scanned CRDs, partial results

# System API groups to exclude
SYSTEM_API_GROUPS = {
    'kubernetes.io', 'k8s.io', 'apiextensions.k8s.io',
    'admissionregistration.k8s.io', 'authentication.k8s.io',
    'authorization.k8s.io', 'autoscaling', 'batch',
    'certificates.k8s.io', 'coordination.k8s.io',
    'discovery.k8s.io', 'events.k8s.io', 'extensions',
    'flowcontrol.apiserver.k8s.io', 'networking.k8s.io',
    'node.k8s.io', 'policy', 'rbac.authorization.k8s.io',
    'scheduling.k8s.io', 'storage.k8s.io',
    'internal.apiserver.k8s.io', 'metrics.k8s.io',
}

# Provider categories for grouping
PROVIDER_CATEGORIES = {
    'crossplane.io': {'label': 'Crossplane Core', 'color': 'purple', 'icon': '🔄'},
    'upbound.io': {'label': 'Upbound', 'color': 'blue', 'icon': '☁️'},
    'azure.upbound.io': {'label': 'Azure (Upbound)', 'color': 'sky', 'icon': '☁️'},
    'aws.upbound.io': {'label': 'AWS (Upbound)', 'color': 'amber', 'icon': '☁️'},
    'gcp.upbound.io': {'label': 'GCP (Upbound)', 'color': 'red', 'icon': '☁️'},
    'pkg.crossplane.io': {'label': 'Crossplane Packages', 'color': 'indigo', 'icon': '📦'},
}


def get_provider_category(group: str) -> dict:
    """Get provider category info for an API group."""
    # Check exact match first
    if group in PROVIDER_CATEGORIES:
        return {**PROVIDER_CATEGORIES[group], 'group': group}

    # Check suffix matches (e.g., azure.upbound.io)
    for pattern, info in PROVIDER_CATEGORIES.items():
        if group.endswith(f'.{pattern}') or group == pattern:
            return {**info, 'group': group}

    # Check if it's a Crossplane provider (*.crossplane.io)
    if group.endswith('.crossplane.io'):
        provider = group.replace('.crossplane.io', '').split('.')[-1]
        return {'label': f'{provider.title()} (Crossplane)', 'color': 'purple', 'icon': '🔄', 'group': group}

    # Check if it's an Upbound provider (*.upbound.io)
    if group.endswith('.upbound.io'):
        parts = group.replace('.upbound.io', '').split('.')
        provider = parts[-1] if parts else 'unknown'
        return {'label': f'{provider.title()} (Upbound)', 'color': 'blue', 'icon': '☁️', 'group': group}

    # Default: custom CRD
    return {'label': group.split('.')[0].title() if group else 'Custom', 'color': 'zinc', 'icon': '📦', 'group': group}


def is_system_api_group(group: str) -> bool:
    """Check if an API group is a Kubernetes system group."""
    if not group:
        return True  # Core API is system
    for sys_group in SYSTEM_API_GROUPS:
        if group == sys_group or group.endswith(f'.{sys_group}'):
            return True
    return False


async def _run_progressive_cr_scan(cache_key: str, kube_context: str):
    """
    Background task to progressively scan CRDs in parallel batches.
    Updates _cr_health_progress with partial results as they come in.
    """
    from .discovery import list_crds, scan_cr_health
    from .tools.kb_search import get_cached_crds
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import asyncio
    import time

    BATCH_SIZE = 8  # Scan 8 CRDs in parallel at a time

    try:
        # Initialize progress state
        _cr_health_progress[cache_key] = {
            'status': 'discovering',
            'phase': 'Checking cached CRDs...',
            'totalCRDs': 0,
            'scannedCRDs': 0,
            'currentCRD': '',
            'groups': {},  # group_key -> group data
            'totalInstances': 0,
            'healthyInstances': 0,
            'degradedInstances': 0,
            'progressingInstances': 0,
        }

        # Check if KB preload is in progress or needs to be triggered
        preload_status = _preload_status.get(kube_context, "")
        print(f"[cr-health] [SEARCH] Preload status for {kube_context}: '{preload_status}'")

        if preload_status == "":
            # Preload hasn't been triggered yet - trigger it now but DO NOT WAIT
            # The health dashboard doesn't need semantic embeddings, it just needs raw counts
            print(f"[cr-health] [RECV] Triggering background KB preload for {kube_context} (non-blocking)...")
            trigger_background_preload(kube_context)

        # DELETED: The 10s wait loop that was blocking the UI
        # We proceed immediately to scanning CRDs


        # Try to reuse CRDs from KB cache first (avoids duplicate kubectl call)
        print(f"[cr-health] [LIST] Phase 1: Getting CRDs (checking KB cache first)...")
        cached_crds, cache_age = get_cached_crds(kube_context)

        if cached_crds:
            print(f"[cr-health] [RESET] Reusing {len(cached_crds)} CRDs from KB cache (age: {int(cache_age)}s)")
            crds = cached_crds
        else:
            print(f"[cr-health] [SYNC] No cached CRDs found, fetching fresh...")
            _cr_health_progress[cache_key]['phase'] = 'Discovering CRDs from cluster...'
            crds = list_crds(kube_context)

        # Debug: Log some sample CRDs to understand filtering
        if crds:
            sample_crds = crds[:5]
            print(f"[cr-health] Sample CRDs before filter: {[(c.name, c.group) for c in sample_crds]}", flush=True)

        custom_crds = [crd for crd in crds if not is_system_api_group(crd.group)]
        total_crds = len(custom_crds)

        # Debug: Log what was filtered
        filtered_count = len(crds) - len(custom_crds)
        if filtered_count > 0 and filtered_count == len(crds):
            # ALL CRDs were filtered - this is a problem
            filtered_sample = crds[:10]
            print(f"[cr-health] [WARN] ALL {len(crds)} CRDs were filtered as 'system'! Sample groups: {set(c.group for c in filtered_sample)}", flush=True)
        elif filtered_count > 0:
            print(f"[cr-health] Filtered {filtered_count} system CRDs, keeping {total_crds} custom CRDs", flush=True)

        print(f"[cr-health] Found {total_crds} custom CRDs to scan")

        _cr_health_progress[cache_key].update({
            'status': 'scanning',
            'phase': f'Scanning {total_crds} CRD types...',
            'totalCRDs': total_crds,
        })

        # Initialize group structures
        groups_map = {}
        for crd in custom_crds:
            category = get_provider_category(crd.group)
            if crd.group not in groups_map:
                groups_map[crd.group] = {
                    'group': crd.group,
                    'label': category['label'],
                    'color': category['color'],
                    'icon': category['icon'],
                    'crds': [],
                    'totalInstances': 0,
                    'healthyInstances': 0,
                    'degradedInstances': 0,
                }

        _cr_health_progress[cache_key]['groups'] = groups_map

        # Scan in parallel batches
        def scan_one_crd(crd):
            """Scan a single CRD and return summary."""
            try:
                instances = scan_cr_health(crd.name, kube_context)
                return {
                    'crd': crd,
                    'instances': instances,
                    'error': None
                }
            except Exception as e:
                return {
                    'crd': crd,
                    'instances': [],
                    'error': str(e)
                }

        scanned = 0
        with ThreadPoolExecutor(max_workers=BATCH_SIZE) as executor:
            # Submit all CRDs
            futures = {executor.submit(scan_one_crd, crd): crd for crd in custom_crds}

            for future in as_completed(futures):
                result = future.result()
                crd = result['crd']
                instances = result['instances']

                # Build CRD summary
                crd_summary = {
                    'name': crd.name,
                    'group': crd.group,
                    'kind': crd.kind,
                    'version': crd.version,
                    'total': len(instances),
                    'healthy': sum(1 for i in instances if i.status == 'Healthy'),
                    'degraded': sum(1 for i in instances if i.status == 'Degraded'),
                    'progressing': sum(1 for i in instances if i.status == 'Progressing'),
                    'unknown': sum(1 for i in instances if i.status == 'Unknown'),
                    'instances': [
                        {
                            'name': inst.name,
                            'namespace': inst.namespace,
                            'kind': inst.kind,
                            'group': crd.group,
                            'version': crd.version,
                            'status': inst.status,
                            'message': inst.message,
                        }
                        for inst in instances
                    ]
                }

                # Update group
                group = groups_map[crd.group]
                group['crds'].append(crd_summary)
                group['totalInstances'] += crd_summary['total']
                group['healthyInstances'] += crd_summary['healthy']
                group['degradedInstances'] += crd_summary['degraded']

                # Update progress totals
                scanned += 1
                progress = _cr_health_progress[cache_key]
                progress['scannedCRDs'] = scanned
                progress['currentCRD'] = crd.kind
                progress['totalInstances'] += crd_summary['total']
                progress['healthyInstances'] += crd_summary['healthy']
                progress['degradedInstances'] += crd_summary['degraded']
                progress['progressingInstances'] += crd_summary['progressing']
                progress['phase'] = f'Scanned {scanned}/{total_crds} CRDs ({crd.kind})'
                progress['groups'] = groups_map

                # Log progress every 10 CRDs
                if scanned % 10 == 0 or scanned == total_crds:
                    print(f"[cr-health] Progress: {scanned}/{total_crds} CRDs scanned")

        # Finalize - convert groups to sorted list
        groups = sorted(groups_map.values(), key=lambda g: g['totalInstances'], reverse=True)

        final_result = {
            "status": "complete",
            "groups": groups,
            "totalCRDs": total_crds,
            "scannedCRDs": total_crds,
            "totalInstances": _cr_health_progress[cache_key]['totalInstances'],
            "healthyInstances": _cr_health_progress[cache_key]['healthyInstances'],
            "degradedInstances": _cr_health_progress[cache_key]['degradedInstances'],
            "progressingInstances": _cr_health_progress[cache_key]['progressingInstances'],
        }

        # Cache the final result
        _cr_health_cache[cache_key] = {
            'timestamp': time.time(),
            'data': final_result
        }

        _cr_health_progress[cache_key] = final_result
        print(f"[cr-health] [OK] Scan complete: {total_crds} CRDs, {final_result['totalInstances']} instances")

    except Exception as e:
        import traceback
        traceback.print_exc()
        _cr_health_progress[cache_key] = {
            'status': 'error',
            'error': str(e),
            'groups': [],
            'totalCRDs': 0,
            'scannedCRDs': 0,
        }
        print(f"[cr-health] [ERROR] Scan failed: {e}")
    finally:
        _cr_health_scanning[cache_key] = False


@app.get("/custom-resource-health")
async def custom_resource_health_endpoint(
    background_tasks: BackgroundTasks,
    kube_context: str = "",
    force_refresh: bool = False
):
    """
    Progressive scan of custom resources (Crossplane, Upbound, custom CRDs).

    Returns immediately with either:
    - Cached complete data (if available and fresh)
    - Current progress state (if scan in progress)
    - Starts background scan and returns "scanning" status

    Frontend should poll this endpoint to get updates during scanning.
    """
    import time
    cache_key = f"cr_health:{kube_context}"

    # Return cached data if fresh and not forcing refresh
    if not force_refresh and cache_key in _cr_health_cache:
        cached = _cr_health_cache[cache_key]
        if cached.get('timestamp', 0) > time.time() - 300:  # 5 min TTL
            print(f"[cr-health] [OK] Returning cached data")
            return cached['data']

    # If scan is in progress, return current progress
    if _cr_health_scanning.get(cache_key):
        progress = _cr_health_progress.get(cache_key, {})
        groups_map = progress.get('groups', {})

        # Convert groups dict to sorted list for frontend
        if isinstance(groups_map, dict):
            groups = sorted(groups_map.values(), key=lambda g: g.get('totalInstances', 0), reverse=True)
        else:
            groups = groups_map if isinstance(groups_map, list) else []

        return {
            "status": progress.get('status', 'scanning'),
            "phase": progress.get('phase', 'Initializing...'),
            "groups": groups,
            "totalCRDs": progress.get('totalCRDs', 0),
            "scannedCRDs": progress.get('scannedCRDs', 0),
            "currentCRD": progress.get('currentCRD', ''),
            "totalInstances": progress.get('totalInstances', 0),
            "healthyInstances": progress.get('healthyInstances', 0),
            "degradedInstances": progress.get('degradedInstances', 0),
            "progressingInstances": progress.get('progressingInstances', 0),
        }

    # Start background scan
    print(f"[cr-health] [START] Starting progressive scan for context: {kube_context}")
    _cr_health_scanning[cache_key] = True
    _cr_health_progress[cache_key] = {
        'status': 'starting',
        'phase': 'Initializing scan...',
        'groups': [],
        'totalCRDs': 0,
        'scannedCRDs': 0,
    }

    # Run scan in background
    import asyncio
    asyncio.create_task(_run_progressive_cr_scan(cache_key, kube_context))

    return {
        "status": "scanning",
        "phase": "Starting scan...",
        "groups": [],
        "totalCRDs": 0,
        "scannedCRDs": 0,
        "totalInstances": 0,
        "healthyInstances": 0,
        "degradedInstances": 0,
        "progressingInstances": 0,
    }


@app.get("/claude/usage")
async def get_claude_usage():
    """Get Claude Code usage information."""
    backend = get_claude_code_backend()
    usage = await backend.get_usage()
    return {"usage": usage}


@app.post("/analyze-direct")
async def analyze_direct(request: DirectAgentRequest):
    """
    Direct Claude Code agent.
    If fast_mode is True: Skips RAG/Context injection for max speed.
    Uses modular prompts to minimize token usage (40-60% savings).
    """
    # Note: DIRECT_AGENT_SYSTEM_PROMPT, DIRECT_AGENT_USER_PROMPT, build_system_prompt, get_prompt_stats
    # are imported at module level to prevent PyInstaller decompression issues

    # Imports backend dynamically based on provider
    backend = None
    if request.llm_provider == "codex-cli":
        from .codex_backend import get_codex_backend
        backend = get_codex_backend()
        print(f"[direct-agent] [BOT] Using Codex CLI backend", flush=True)
    else:
        from .claude_code_backend import get_claude_code_backend
        backend = get_claude_code_backend()
        print(f"[direct-agent] [BOT] Using Claude Code backend", flush=True)

    # Token Optimization: Use modular prompt builder for minimal prompts
    # This reduces token usage by 40-60% compared to monolithic prompts
    prompt_stats = get_prompt_stats(request.query)
    if prompt_stats["is_minimal"]:
        # For simple queries (greetings, off-topic), use ultra-minimal prompt
        system_prompt = build_system_prompt(request.query)
        print(f"[direct-agent] [RUN] Using minimal prompt ({prompt_stats['estimated_tokens']} tokens, modules: {prompt_stats['modules']})", flush=True)
    else:
        # For complex queries, use full direct agent prompt
        system_prompt = DIRECT_AGENT_SYSTEM_PROMPT

    if request.resource_context:
         system_prompt += f"\n\nIMPORTANT: The user is asking about a specific resource: {request.resource_context}. Keep your answer focused on this resource unless asked otherwise."

    mode_icon = "[RUN]" if request.fast_mode else "[OK]"
    print(f"[direct-agent] {mode_icon} Starting investigation: {request.query} (Fast: {request.fast_mode})", flush=True)
    print(f"[direct-agent] [LIST] Thread ID: {request.thread_id}", flush=True)

    # Load conversation history from session for context continuity
    session_state = get_session_state(request.thread_id)
    conversation_history = []
    if session_state:
        conversation_history = session_state.get('conversation_history', [])
        print(f"[direct-agent] [KB] Loaded {len(conversation_history)} messages from session history", flush=True)

    async def event_generator():
        try:
            # 1. Get cluster info
            cluster_info = await get_cluster_recon(request.kube_context)

            # 2. Fetch relevant KB context (SKIP IN FAST MODE)
            kb_context = ""
            if not request.fast_mode:
                try:
                    from .tools.kb_search import get_relevant_kb_snippets, ingest_cluster_knowledge
                    # Build minimal state for KB search
                    kb_state = {
                        'kube_context': request.kube_context or 'default',
                        'query': request.query
                    }
                    # First ensure CRDs are ingested (cached after first call)
                    await ingest_cluster_knowledge(kb_state)
                    # Search for relevant KB entries based on query
                    kb_context = await get_relevant_kb_snippets(
                        query=request.query,
                        state=kb_state,
                        max_results=3,  # Top 3 most relevant entries
                        min_similarity=0.3
                    )
                    if kb_context:
                        print(f"[direct-agent] [KB] Found relevant KB context ({len(kb_context)} chars)", flush=True)
                except Exception as kb_err:
                    print(f"[direct-agent] [WARN] KB search skipped: {kb_err}", flush=True)
            else:
                 print(f"[direct-agent] [SKIP] Fast Mode: Skipping KB Search", flush=True)

            # 3. Build the prompt with KB context
            user_prompt = DIRECT_AGENT_USER_PROMPT.format(
                kube_context=request.kube_context or "default",
                cluster_info=cluster_info or "(cluster info unavailable)",
                query=request.query
            )

            # Inject KB context if available (prepend to prompt)
            if kb_context:
                user_prompt = f"""## Pre-computed Knowledge (use this to save time)
{kb_context}

---

{user_prompt}"""

            # Load config and repos (needed for working_dir even in fast mode)
            opspilot_config = load_opspilot_config()

            # Check both local_repos and github_repos (user may have configured either)
            # github_repos are saved from the LLM Settings panel "Repository" field
            local_repos_config = opspilot_config.get("local_repos", [])
            github_repos_config = opspilot_config.get("github_repos", [])

            # Merge: combine both sources, remove duplicates
            local_repos = list(set(local_repos_config + github_repos_config))
            if local_repos:
                print(f"[direct-agent] [DIR] Configured repos: {local_repos}", flush=True)

            # Inject Local Repos context if configured (SKIP IN FAST MODE for prompt injection only)
            if not request.fast_mode:
                github_pat = opspilot_config.get("github_pat")  # Keep checking for PAT just in case we need it later

                if local_repos:
                    repos_str = "\n".join([f"- `{path}`" for path in local_repos])
                    github_context = f"""
## Local Codebase Access
You have access to the user's local source code repositories.
**Configured Repositories:**
{repos_str}

**Tools to use:**
- `fs_grep`: To search for patterns (e.g., error messages, variable names).
- `fs_read_file`: To read file contents.
- `fs_list_dir`: To list files in a directory.
- `run_command`: For advanced `find` or `grep` combinations if `fs_grep` is insufficient.

**CODE INVESTIGATION PROTOCOL (LOCAL):**
1. **STACK TRACE FIRST**: If you see a file path in a stack trace that matches one of the local repos (or looks relative to them), IMMEDIATELY read that file using `fs_read_file`.
   - e.g. `at com.app.Main.java:42` -> Find `Main.java` in the local repos.
   - You may need to use `run_command` with `find <repo> -name Main.java` first if the full path is unknown.

2. **EXACT STRINGS**: Use `fs_grep` or `grep -r` to find exact error messages.
   - e.g. `grep -r "Connection refused" /path/to/repo`

3. **IGNORE MCP**: Do NOT use `mcp__github__*` tools. Use local filesystem tools.
"""
                    user_prompt = github_context + user_prompt
                    print(f"[direct-agent] [LINK] Local Repos context injected", flush=True)
            else:
                print(f"[direct-agent] [SKIP] Fast Mode: Skipping Local Repo context", flush=True)


            yield f"data: {json.dumps(emit_event('status', {'message': 'Starting fast investigation...' if request.fast_mode else 'Starting investigation...', 'type': 'info'}))}\n\n"

            # 3. Call Backend (Claude Code or Codex) with streaming
            # backend is already instantiated above

            # Build MCP config from user-configured servers (SKIP IN FAST MODE)
            mcp_config = None
            if not request.fast_mode:
                mcp_servers_config = {}

                # Add user-configured MCP servers from the request
                if request.mcp_servers:
                    for srv in request.mcp_servers:
                        mcp_servers_config[srv.name] = {
                            "command": srv.command,
                            "args": srv.args,
                            "env": srv.env
                        }
                    print(f"[direct-agent] [PLUG] MCP servers from request: {list(mcp_servers_config.keys())}", flush=True)

                # Add GitHub MCP if configured (legacy support)
                if opspilot_config.get("github_pat"):
                    npx_cmd = "npx.cmd" if sys.platform == "win32" else "npx"
                    mcp_servers_config["github"] = {
                        "command": npx_cmd,
                        "args": ["-y", "@modelcontextprotocol/server-github"],
                        "env": {
                            "GITHUB_PERSONAL_ACCESS_TOKEN": opspilot_config["github_pat"]
                        }
                    }

                if mcp_servers_config:
                    mcp_config = {"mcpServers": mcp_servers_config}

            final_answer = ""
            command_history = []
            pending_command = None  # Track command from tool_use to pair with tool_result

            # Determine mode-specific settings
            system_prompt = DIRECT_AGENT_SYSTEM_PROMPT
            if request.fast_mode:
                system_prompt = """[RUN] FAST MODE [RUN]
You're the espresso shot of AI assistants right now - quick, strong, no filler.

Rules:
- Get to the point. Bullet points are your best friend.
- 2-3 tool calls max. You're a sniper, not a spray-and-pray.
- Don't have all the info? Wing it confidently with what you've got.
- Never mention fast mode unless asked - just be naturally speedy."""
            
            restricted_tools = False
            
            # Code Search Mode: Strict Read-Only, Local Only
            if request.tool_subset == "code_search":
                restricted_tools = True
                mcp_config = None # Disable GitHub MCP entirely
                system_prompt = """You are a specialized Code Search Agent.
Your ONLY goal is to find relevant code in the local repositories that explains the user's issue.

CRITICAL RESTRICTIONS:
1. READ ONLY: You may NOT edit files. Use `cat` or `read` to view files.
2. LOCAL TOOLS ONLY: Use `grep`, `find`, `ls` (via bash).
3. NO KUBERNETES: Do not run `kubectl`, `helm`, or any cluster commands.
4. NO EXTERNAL CALLS: Do not use git network commands.

Protocol:
1. Search for error messages or keywords from the user's query.
2. Read the relevant files to understand the context.
3. Suggest potential fixes based on the code logic (do NOT apply them).
"""
                print(f"[direct-agent] [LOCK] Code Search Mode enabled (No MCP, Read-Only, No Kubectl)", flush=True)

            final_answer = ""
            command_history = []
            pending_command = None  # Track command from tool_use to pair with tool_result

            # Determine working directory - use first configured repo if available
            working_dir = local_repos[0] if local_repos else None
            if working_dir:
                print(f"[direct-agent] [DIR] Setting working directory: {working_dir}", flush=True)

            async for event in backend.call_streaming_with_tools(
                prompt=user_prompt,
                system_prompt=system_prompt,
                kube_context=request.kube_context,
                temperature=0.2,
                session_id=request.thread_id,
                restricted_tools=restricted_tools,
                conversation_history=conversation_history,
                mcp_config=mcp_config,
                working_dir=working_dir
            ):
                event_type = event.get('type')

                if event_type == 'thinking':
                    # Claude is reasoning - emit as SUPERVISOR step for UI
                    thinking_text = event.get('content', 'Thinking...')
                    yield f"data: {json.dumps(emit_event('thinking', {'content': thinking_text}))}\n\n"

                elif event_type == 'tool_use':
                    # Claude is using a tool (Bash, Read, etc.)
                    tool_name = event.get('tool', 'tool')
                    tool_input = event.get('input', {})

                    # Extract actual command from Bash tool
                    # IMPORTANT: pending_command MUST match the command sent in command_selected
                    # so the frontend can pair command_selected with command_output
                    if tool_name == 'Bash':
                        cmd = tool_input.get('command', '')
                        pending_command = cmd  # Save for pairing with result
                        yield f"data: {json.dumps(emit_event('command_selected', {'command': cmd}))}\n\n"
                    elif tool_name == 'Read':
                        file_path = tool_input.get('file_path', '')
                        pending_command = f"Reading {file_path}"  # Must match command_selected
                        yield f"data: {json.dumps(emit_event('command_selected', {'command': pending_command}))}\n\n"
                    elif tool_name == 'Grep':
                        pattern = tool_input.get('pattern', '')
                        pending_command = f"Searching for {pattern}"  # Must match command_selected
                        yield f"data: {json.dumps(emit_event('command_selected', {'command': pending_command}))}\n\n"
                    else:
                        pending_command = f"Using {tool_name}"  # Must match command_selected
                        yield f"data: {json.dumps(emit_event('command_selected', {'command': pending_command}))}\n\n"

                elif event_type == 'tool_result':
                    # Tool execution completed - use pending_command for the actual command
                    output = event.get('output', '')
                    # Use the pending command if available, otherwise fall back to tool name
                    actual_command = pending_command or event.get('tool', 'command')

                    command_history.append({
                        'command': actual_command,
                        'output': output[:500] if output else '',
                        'error': None
                    })

                    # Emit command_output with actual command for UI to display
                    yield f"data: {json.dumps(emit_event('command_output', {'command': actual_command, 'output': output[:2000] if output else '(no output)'}))}\n\n"

                    # Clear pending command
                    pending_command = None

                elif event_type == 'text':
                    # Streaming text
                    final_answer += event.get('content', '')

                elif event_type == 'done':
                    # Final result from Claude Code
                    final_text = event.get('final_text', '')
                    if final_text:
                        final_answer = final_text

                elif event_type == 'usage':
                    # Token usage data from the request
                    usage_data = {'input_tokens': event.get('input_tokens', 0), 'output_tokens': event.get('output_tokens', 0), 'total_tokens': event.get('total_tokens', 0), 'session_total': event.get('session_total', 0)}
                    yield f"data: {json.dumps(emit_event('usage', usage_data))}\n\n"

                elif event_type == 'error':
                    yield f"data: {json.dumps(emit_event('error', {'message': event.get('message', 'Unknown error')}))}\n\n"

                elif event_type == 'investigation_plan':
                    # Code search investigation plan - show in UI
                    yield f"data: {json.dumps(emit_event('investigation_plan', {'plan': event.get('plan', ''), 'raw': event.get('raw', '')}))}\n\n"

                elif event_type == 'search_result':
                    # Code search result with confidence score
                    yield f"data: {json.dumps(emit_event('search_result', {'confidence': event.get('confidence', 0), 'raw': event.get('raw', '')}))}\n\n"

                elif event_type == 'command_blocked':
                    # Security: Command was blocked by validator
                    yield f"data: {json.dumps(emit_event('command_blocked', {'command': event.get('command', ''), 'reason': event.get('reason', ''), 'message': event.get('message', '')}))}\n\n"

                elif event_type == 'command_approval_required':
                    # Command requires user approval (future feature)
                    yield f"data: {json.dumps(emit_event('command_approval_required', {'command': event.get('command', ''), 'reason': event.get('reason', '')}))}\n\n"

            # 4. Return final answer and save session
            if final_answer:
                print(f"[direct-agent] [OK] Investigation complete ({len(final_answer)} chars)", flush=True)

                # Save conversation history for context continuity
                # Add user query and assistant response to history
                new_history = conversation_history.copy()
                new_history.append({"role": "user", "content": request.query})
                new_history.append({"role": "assistant", "content": final_answer[:2000]})  # Truncate to save tokens

                # Update session state for next query
                update_session_state(request.thread_id, {
                    'conversation_history': new_history,
                    'command_history': command_history,
                })
                print(f"[direct-agent] [SAVE] Saved session with {len(new_history)} messages", flush=True)

                # Check if this was a solution (direct agent doesn't have SOLVED assessments, so default false)
                is_solution = any(
                    str(h.get('assessment', '')).upper() in ['SOLVED', 'AUTO_SOLVED']
                    for h in command_history
                )

                # Generate quick context-aware suggestions for Fast Mode
                suggestions = _generate_fast_mode_suggestions(request.query, command_history, final_answer)

                yield f"data: {json.dumps(emit_event('done', {'final_response': final_answer, 'suggested_next_steps': suggestions, 'is_solution': is_solution}))}\n\n"
            else:
                yield f"data: {json.dumps(emit_event('error', {'message': 'No response generated'}))}\n\n"

        except Exception as e:
            import traceback
            print(f"[direct-agent] [ERROR] Error: {e}", flush=True)
            print(traceback.format_exc(), flush=True)
            err_msg = 'Investigation failed: ' + str(e)
            yield f"data: {json.dumps(emit_event('error', {'message': err_msg}))}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# =============================================================================
# RESOURCE CHAIN API - For UI resource traversal
# =============================================================================

class ResourceChainRequest(BaseModel):
    """Request for resource chain traversal."""
    kind: str  # Pod, Deployment, Service, etc.
    name: str
    namespace: str
    kube_context: str = ""
    include_events: bool = True


class ResourceRef(BaseModel):
    """Reference to a K8s resource."""
    kind: str
    name: str
    namespace: str = ""
    api_version: str = ""


class ResourceChainResponse(BaseModel):
    """Response with resource chain."""
    root: ResourceRef
    owners: list[ResourceRef] = []
    children: list[ResourceRef] = []
    related: list[ResourceRef] = []
    events: list[dict] = []
    summary: str = ""


@app.post("/resource-chain", response_model=ResourceChainResponse)
async def get_resource_chain(request: ResourceChainRequest):
    """
    Get the complete resource chain for a K8s resource.

    This endpoint allows the UI to:
    1. Click on a Pod -> See its owners (ReplicaSet, Deployment)
    2. Click on a Deployment -> See its owned resources (RS, Pods)
    3. See related ConfigMaps, Secrets, PVCs
    4. See warning events across the chain

    Example:
    POST /resource-chain
    {
        "kind": "Pod",
        "name": "myapp-abc123",
        "namespace": "default",
        "kube_context": "my-cluster"
    }
    """
    from kubernetes import client, config
    from .tools.resource_chain import build_resource_chain

    print(f"[resource-chain] [LINK] Building chain for {request.kind}/{request.name} in {request.namespace}", flush=True)

    try:
        # Load kubeconfig for the specified context
        context = request.kube_context if request.kube_context else None
        config.load_kube_config(context=context)

        v1 = client.CoreV1Api()
        apps_v1 = client.AppsV1Api()

        # Build the resource chain
        chain = build_resource_chain(
            v1=v1,
            apps_v1=apps_v1,
            kind=request.kind,
            name=request.name,
            namespace=request.namespace,
            include_events=request.include_events
        )

        print(f"[resource-chain] [OK] Found {len(chain.owners)} owners, {len(chain.children)} children, {len(chain.related)} related", flush=True)

        # Convert to response model
        return ResourceChainResponse(
            root=ResourceRef(
                kind=chain.root.kind,
                name=chain.root.name,
                namespace=chain.root.namespace,
                api_version=chain.root.api_version
            ),
            owners=[
                ResourceRef(kind=o.kind, name=o.name, namespace=o.namespace, api_version=o.api_version)
                for o in chain.owners
            ],
            children=[
                ResourceRef(kind=c.kind, name=c.name, namespace=c.namespace, api_version=c.api_version)
                for c in chain.children
            ],
            related=[
                ResourceRef(kind=r.kind, name=r.name, namespace=r.namespace, api_version=r.api_version)
                for r in chain.related
            ],
            events=chain.events,
            summary=chain.summary()
        )

    except Exception as e:
        import traceback
        print(f"[resource-chain] [ERROR] Error: {e}", flush=True)
        print(traceback.format_exc(), flush=True)
        # Return empty chain on error
        return ResourceChainResponse(
            root=ResourceRef(kind=request.kind, name=request.name, namespace=request.namespace),
            summary=f"Error building resource chain: {str(e)}"
        )


@app.get("/resource-chain/{namespace}/{kind}/{name}")
async def get_resource_chain_simple(namespace: str, kind: str, name: str, context: str = ""):
    """
    Simple GET endpoint for resource chain (easier for UI links).

    Example: GET /resource-chain/default/Pod/myapp-abc123
    """
    from kubernetes import client, config
    from .tools.resource_chain import build_resource_chain

    print(f"[resource-chain] [LINK] GET chain for {kind}/{name} in {namespace}", flush=True)

    try:
        config.load_kube_config(context=context if context else None)

        v1 = client.CoreV1Api()
        apps_v1 = client.AppsV1Api()

        chain = build_resource_chain(
            v1=v1,
            apps_v1=apps_v1,
            kind=kind,
            name=name,
            namespace=namespace,
            include_events=True
        )

        return {
            "root": chain.root.to_dict(),
            "owners": [o.to_dict() for o in chain.owners],
            "children": [c.to_dict() for c in chain.children],
            "related": [r.to_dict() for r in chain.related],
            "events": chain.events,
            "summary": chain.summary()
        }

    except Exception as e:
        return {"error": str(e), "root": {"kind": kind, "name": name, "namespace": namespace}}


# =============================================================================
# LOG ANALYSIS API - LLM-powered log analysis
# =============================================================================

class LogAnalysisRequest(BaseModel):
    """Request for LLM-based log analysis."""
    logs: str  # Raw log text (last N lines)
    pod_name: str = ""
    container_name: str = ""
    namespace: str = ""
    kube_context: str = ""
    fast_mode: bool = False


@app.post("/analyze-logs")
async def analyze_logs(request: LogAnalysisRequest):
    """
    Analyze logs using LLM. Supports 'fast_mode' for cheaper/quicker insights.
    Returns SSE stream with analysis progress and final result.
    """
    from .prompts.direct_agent import DIRECT_AGENT_SYSTEM_PROMPT
    from .claude_code_backend import get_claude_code_backend

    mode_icon = "[RUN]" if request.fast_mode else "[SEARCH]"
    print(f"[log-analysis] {mode_icon} Analyzing logs for {request.pod_name}/{request.container_name} (Fast: {request.fast_mode})", flush=True)

    async def event_generator():
        try:
            if request.fast_mode:
                # FAST MODE: Concise, direct, cheaper prompt
                log_analysis_system = "You are a log analysis expert. Identify the root cause immediately. Be extremely concise. Use bullet points."
                log_analysis_prompt = f"""Quickly analyze these logs for {request.pod_name} (last 200 lines).
Identify the ERROR/CRASH cause.
Logs:
```
{request.logs[:10000]}
```

Output Format:
**Root Cause**: [One sentence summary]
**Fix**: [One sentence command or action]
"""
            else:
                # DEEP MODE (Original): Detailed persona and structured output
                log_analysis_system = """You are a Principal SRE and Kubernetes troubleshooting expert. 
Your goal is to provide high-density, actionable insights from raw container logs.

Focus on:
- Startup failures (SIGTERM, SIGKILL, Exit Codes)
- Application stack traces and unhandled exceptions
- Connectivity issues (RDS, Redis, External APIs)
- Probing failures (Readiness/Liveness timeout/404)
- Resource exhaustion indicators (OOM, slow I/O)

Avoid fluff. Don't say "I've analyzed the logs." Instead, start directly with the findings.
Use a professional, expert tone."""
                
                log_analysis_prompt = f"""Analyze these Kubernetes pod logs and provide a high-level troubleshooting summary.

## Context
- **Pod:** {request.pod_name}
- **Container:** {request.container_name}
- **Namespace:** {request.namespace}

## Logs (last 200 lines)
```
{request.logs[:20000]}
```

## Your Task
Provide a concise, expert analysis for a DevOps engineer.
1. **The Lead**: What is the most critical thing happening right now? (e.g., "The pod is crashing due to a NullPointerException in the auth service")
2. **Key Evidence**: Highlight 2-3 specific log lines or patterns that prove this.
3. **Health Assessment**: Is this an isolated crash, a configuration error, or a systemic issue?
4. **Resolution Path**: Provide exact steps or commands to fix the issue.

Be authoritative and technical. Use markdown with bold highlights for critical terms."""

            yield f"data: {json.dumps({'type': 'progress', 'message': '[SEARCH] Analyzing logs...'})}\n\n"

            backend = get_claude_code_backend()
            final_analysis = ""

            async for event in backend.call_streaming_with_tools(
                prompt=log_analysis_prompt,
                system_prompt=log_analysis_system,
                kube_context=request.kube_context,
                temperature=0.3
            ):
                event_type = event.get('type')

                if event_type == 'thinking':
                    thinking = event.get('content', '')[:100]
                    yield f"data: {json.dumps({'type': 'progress', 'message': f'[BRAIN] {thinking}'})}\n\n"

                elif event_type == 'text':
                    text = event.get('content', '')
                    final_analysis += text
                    # Stream text chunks for real-time display
                    yield f"data: {json.dumps({'type': 'text', 'content': text})}\n\n"

                elif event_type == 'done':
                    final_text = event.get('final_text', '')
                    if final_text:
                        final_analysis = final_text

                elif event_type == 'error':
                    yield f"data: {json.dumps({'type': 'error', 'message': event.get('message', 'Analysis failed')})}\n\n"

            # Send final result
            if final_analysis:
                yield f"data: {json.dumps({'type': 'done', 'analysis': final_analysis})}\n\n"
            else:
                yield f"data: {json.dumps({'type': 'error', 'message': 'No analysis generated'})}\n\n"

        except Exception as e:
            import traceback
            print(f"[log-analysis] [ERROR] Error: {e}", flush=True)
            print(traceback.format_exc(), flush=True)
            yield f"data: {json.dumps({'type': 'error', 'message': f'Analysis failed: {str(e)}'})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


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

def print_access_urls(port):
    """Print available access URLs for the agent."""
    import socket
    
    print("\n" + "="*50)
    print(f"[START] OpsPilot Agent Server Running on Port {port}")
    print("="*50)
    print(f"Local:   http://127.0.0.1:{port}")
    
    try:
        # Get all network interfaces
        hostname = socket.gethostname()
        local_ip = socket.gethostbyname(hostname)
        # Try to find other IPs (this is a simple heuristic)
        # For a more robust solution, we'd iterate over interfaces,
        # but this usually catches the main LAN IP.
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            # doesn't even have to be reachable
            s.connect(('10.255.255.255', 1))
            IP = s.getsockname()[0]
        except Exception:
            IP = '127.0.0.1'
        finally:
            s.close()
            
        if IP != '127.0.0.1':
            print(f"Network: http://{IP}:{port}")
            print(f"\nTo connect from another machine, set 'Agent Server URL' to:")
            print(f"http://{IP}:{port}")
    except Exception as e:
        print(f"Could not determine network IP: {e}")
        
    print("="*50 + "\n")

# =============================================================================
# KNOWLEDGE BASE API - Adaptive Learning
# =============================================================================

class SolutionRequest(BaseModel):
    """Request to mark a response as a validated solution."""
    query: str
    solution: str
    metadata: dict = {}
    kube_context: str | None = None


@app.post("/knowledge/solution")
async def save_solution_endpoint(request: SolutionRequest):
    """
    Save a marked solution to the knowledge base.
    These solutions will be indexed and retrieved in future investigations.
    """
    import time
    import uuid
    import os
    import json
    
    # Ensure directory
    base_dir = os.path.expanduser("~/.opspilot/knowledge/solutions")
    try:
        os.makedirs(base_dir, exist_ok=True)
    except Exception as e:
        print(f"[KB] [ERROR] Failed to create solution directory: {e}", flush=True)
        return {"status": "error", "message": str(e)}
    
    # Create solution object
    solution_data = {
        "id": str(uuid.uuid4()),
        "query": request.query,
        "solution": request.solution,
        "metadata": request.metadata,
        "created_at": time.time(),
        "kube_context": request.kube_context,
        "source": "user_feedback"
    }
    
    # Save to JSON
    filename = f"{solution_data['id']}.json"
    path = os.path.join(base_dir, filename)
    
    try:
        with open(path, "w") as f:
            json.dump(solution_data, f, indent=2)
        print(f"[KB] [BRAIN] Saved solution {filename} for query: {request.query[:50]}...", flush=True)
    except Exception as e:
        print(f"[KB] [ERROR] Failed to save solution file: {e}", flush=True)
        return {"status": "error", "message": str(e)}
    
    # Invalidate cache to force reload of new solution
    try:
        from .tools import clear_cache
        clear_cache()
    except Exception as e:
        print(f"[KB] [WARN] Failed to clear cache: {e}", flush=True)
    
    return {"status": "saved", "id": solution_data["id"]}


# ============================================================================
# BUNDLE AI ANALYSIS (Token-Efficient)
# ============================================================================

class BundleAnalysisRequest(BaseModel):
    """Request for AI-powered support bundle analysis."""
    summary: str  # Pre-computed summary from frontend (500-1000 tokens)
    mode: Literal["initial_analysis", "question"] = "initial_analysis"
    question: str | None = None  # User question for follow-up
    conversation_history: list[dict] | None = None
    health_score: int | None = None
    failing_pods_count: int | None = None
    critical_alerts_count: int | None = None


BUNDLE_ANALYSIS_SYSTEM_PROMPT = """You are an expert Kubernetes SRE analyzing an OFFLINE support bundle snapshot.

CRITICAL: This is STATIC DATA from a support bundle file - NOT a live cluster.
- You CANNOT execute kubectl, helm, or any commands
- You CANNOT query the cluster - it may not even exist anymore
- You can ONLY analyze the data provided in the summary below
- Do NOT suggest running diagnostic commands - the user cannot run them on this bundle

Your role:
1. Identify root causes of failures from the provided data
2. Prioritize issues by severity
3. Provide actionable recommendations (what to fix when they have cluster access)
4. Be concise - the user already sees the raw data

Rules:
- Focus on actionable insights, not obvious observations
- Prioritize critical issues (CrashLoopBackOff, OOMKilled, FailedScheduling)
- Be specific about namespaces and resource names when mentioned
- Base ALL analysis on the provided summary data only
"""

BUNDLE_ANALYSIS_JSON_FORMAT = """{
  "summary": "1-2 sentence overview of cluster health",
  "rootCauses": [
    {"issue": "Brief description", "likelihood": "high|medium|low", "explanation": "Why this is likely"}
  ],
  "recommendations": [
    {"priority": "critical|high|medium|low", "action": "What to do", "rationale": "Why"}
  ],
  "affectedComponents": ["namespace/resource", ...]
}"""


@app.post("/analyze/bundle")
async def analyze_bundle(request: BundleAnalysisRequest):
    """
    Token-efficient AI analysis of support bundles.

    The frontend pre-computes a summary (~500-1000 tokens) from the bundle,
    so we only send the condensed context to the LLM instead of raw YAML.

    Modes:
    - initial_analysis: Generate structured root cause analysis
    - question: Answer a specific user question about the bundle
    """
    from .claude_code_backend import get_claude_code_backend

    print(f"[bundle-ai] [SEARCH] Analyzing bundle (mode: {request.mode})", flush=True)
    print(f"[bundle-ai] [STATS] Summary size: {len(request.summary)} chars", flush=True)

    try:
        backend = get_claude_code_backend()

        if request.mode == "initial_analysis":
            # Initial analysis - request structured JSON response
            # IMPORTANT: We use force_json=False because force_json=True triggers
            # the K8s agent prompt which tells Claude to use kubectl/tools.
            # Instead, we embed the JSON format request directly in the prompt.
            prompt = f"""{BUNDLE_ANALYSIS_SYSTEM_PROMPT}

## Support Bundle Data:

{request.summary}

## Metrics:
- Health Score: {request.health_score}/100
- Failing Pods: {request.failing_pods_count}
- Critical Alerts: {request.critical_alerts_count}

## Task:
Analyze this support bundle snapshot and provide your analysis as JSON in this exact format:
{BUNDLE_ANALYSIS_JSON_FORMAT}

Output ONLY the JSON object, no markdown code blocks, no explanation text.
Focus on the most impactful issues first."""

            response = await backend.call(
                prompt=prompt,
                system_prompt=None,  # System prompt is embedded in the prompt
                force_json=False,  # Don't use K8s agent JSON mode - it triggers tool use
                timeout=60.0
            )

            # Parse JSON response - strip any markdown if present
            response = response.strip()
            if response.startswith("```"):
                # Strip markdown code blocks
                lines = response.split('\n')
                if lines[0].startswith("```"):
                    lines = lines[1:]
                if lines and lines[-1].strip() == "```":
                    lines = lines[:-1]
                response = '\n'.join(lines)

            try:
                result = json.loads(response)
                print(f"[bundle-ai] [OK] Analysis complete: {len(result.get('rootCauses', []))} root causes found", flush=True)
                return result
            except json.JSONDecodeError as e:
                # If JSON parsing fails, return the raw response as summary
                print(f"[bundle-ai] [WARN] JSON parse failed: {e}", flush=True)
                print(f"[bundle-ai] [DOC] Raw response: {response[:500]}...", flush=True)
                return {
                    "summary": response[:500] if response else "Analysis failed",
                    "rootCauses": [],
                    "recommendations": [],
                    "affectedComponents": []
                }

        elif request.mode == "question":
            # Follow-up question - natural language response
            if not request.question:
                return {"error": "Question required for question mode"}

            # Build conversation context
            history_context = ""
            if request.conversation_history:
                history_context = "\n\nPrevious conversation:\n"
                for msg in request.conversation_history[-5:]:  # Last 5 messages
                    role = msg.get("role", "user").upper()
                    content = msg.get("content", "")[:500]  # Truncate long messages
                    history_context += f"[{role}]: {content}\n"

            # Use the same strong system prompt for questions to prevent tool suggestions
            prompt = f"""{BUNDLE_ANALYSIS_SYSTEM_PROMPT}

## Support Bundle Data:

{request.summary}
{history_context}

## User Question:
{request.question}

Provide a direct, helpful answer based ONLY on the bundle data above.
Do NOT suggest running kubectl or any other commands - this is static data from a bundle file."""

            response = await backend.call(
                prompt=prompt,
                system_prompt=None,  # System prompt is embedded
                force_json=False,  # Natural language response
                timeout=45.0
            )

            print(f"[bundle-ai] [OK] Question answered: {len(response)} chars", flush=True)
            return {"answer": response}

    except Exception as e:
        print(f"[bundle-ai] [ERROR] Error: {e}", flush=True)
        return {"error": str(e)}


if __name__ == "__main__":
    import uvicorn
    import time
    import sys

    PORT = 8765

    # Kill any zombie/unhealthy process on the port (but not ourselves)
    if kill_process_on_port(PORT):
        # Give the OS time to release the port
        time.sleep(1.0)
    
    print_access_urls(PORT)

    # Run server
    uvicorn.run(app, host="0.0.0.0", port=PORT)
