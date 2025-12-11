#!/usr/bin/env python3
"""
LangGraph K8s Troubleshooting Agent Server

FastAPI server that runs a LangGraph-based agent for Kubernetes troubleshooting.
Communicates with the Tauri app via HTTP.

Features:
- Self-reflection loop (Supervisor/Llama 3.3 70B)
- Server-Sent Events (SSE) for real-time streaming
- Human Approval Gate for large-output commands
- Embeddings-based RAG over JSON knowledge base
- Optimized planning for simple Q&A and complex filtering (Crossplane support)
"""

import asyncio
import subprocess
import re
import json
import os
import math
import warnings
from typing import TypedDict, Literal, AsyncGenerator
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import httpx

from langgraph.graph import StateGraph, END, START

# Suppress Pydantic V1 compatibility warnings from LangChainRep
warnings.filterwarnings("ignore", category=UserWarning, message=".*Pydantic V1.*")

# =============================================================================
# CONFIGURATION
# =============================================================================

# Dangerous write-verbs
DANGEROUS_VERBS = [
    'delete', 'apply', 'edit', 'scale', 'patch', 'replace',
    'create', 'rollout', 'cordon', 'drain', 'taint', 'annotate',
    'label', 'set', 'cp'
]

# Commands that are SAFE but return large, complex output and require approval
LARGE_OUTPUT_VERBS = [
    'get all', 'top', 'events -A', 'logs -f', 'get --watch', 'get events'
]

MAX_ITERATIONS = 10
MAX_OUTPUT_LENGTH = 8000

# ---- Embeddings RAG config ----
KB_DIR = os.environ.get("K8S_AGENT_KB_DIR", "./kb")  # directory with JSON KB files
EMBEDDING_MODEL = os.environ.get("K8S_AGENT_EMBED_MODEL", "nomic-embed-text")
EMBEDDING_ENDPOINT = os.environ.get("K8S_AGENT_EMBED_ENDPOINT", "")  # if empty, reuse llm_endpoint
KB_MAX_MATCHES = 5
KB_MIN_SIMILARITY = 0.25  # cosine similarity threshold

# ---- Logging Config ----
LOG_DIR = os.environ.get("K8S_AGENT_LOG_DIR", "./logs")
LOG_FILE = "agent_history.jsonl"

# In-memory KB index
kb_entries: list[dict] = []
kb_embeddings: list[list[float]] = []
kb_loaded = False
kb_lock = asyncio.Lock()


def log_session(state: 'AgentState', duration: float, status: str = "COMPLETED"):
    """Log the session execution details to a JSONL file."""
    import uuid
    import time
    
    try:
        # Ensure log directory exists
        os.makedirs(LOG_DIR, exist_ok=True)
        log_path = os.path.join(LOG_DIR, LOG_FILE)
        
        # Extract meaningful command steps
        steps = []
        for i, cmd in enumerate(state.get('command_history', []), 1):
            steps.append({
                "iteration": i,
                "command": cmd.get('command'),
                "output": truncate_output(cmd.get('output', ''), 500), # Truncate for log size
                "error": cmd.get('error'),
                "assessment": cmd.get('assessment'),
                "reasoning": cmd.get('reasoning')
            })

        entry = {
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "query": state.get('query'),
            "duration_seconds": round(duration, 2),
            "status": status,
            "final_response": state.get('final_response'),
            "steps": steps,
            "reflection_reasoning": state.get('reflection_reasoning'),
            "context": state.get('kube_context'),
            "error": state.get('error')
        }
        
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
            
        print(f"[agent-sidecar] Session logged to {log_path}", flush=True)
    except Exception as e:
        print(f"[agent-sidecar] Failed to log session: {e}", flush=True)

# =============================================================================
# STATE DEFINITION
# =============================================================================

class CommandHistory(TypedDict):
    """Stores the execution and reflection result of a single command."""
    command: str
    output: str
    error: str | None
    assessment: str | None  # Self-reflection assessment
    useful: bool | None

class AgentState(TypedDict):
    """State for the K8s troubleshooting agent."""
    query: str
    kube_context: str
    command_history: list[CommandHistory]
    iteration: int
    next_action: Literal['analyze', 'execute', 'reflect', 'respond', 'done', 'human_approval', 'delegate']
    pending_command: str | None
    final_response: str | None
    error: str | None
    reflection_reasoning: str | None
    continue_path: bool
    llm_endpoint: str
    llm_provider: str
    llm_model: str
    executor_model: str
    current_plan: str | None
    cluster_info: str | None
    events: list[dict]
    awaiting_approval: bool
    approved: bool

# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def is_safe_command(cmd: str) -> tuple[bool, str]:
    """Check if a kubectl command is safe (read-only) and requires approval."""
    lower = cmd.lower()
    
    if any(re.search(rf'\b{verb}\b', lower) for verb in DANGEROUS_VERBS):
        return False, "MUTATING"

    if any(verb in lower for verb in LARGE_OUTPUT_VERBS):
        return False, "LARGE_OUTPUT"

    return True, "SAFE"

def truncate_output(text: str, max_len: int = MAX_OUTPUT_LENGTH) -> str:
    """Truncate output while preserving beginning and end."""
    if not text:
        return '(no output)'
    if len(text) <= max_len:
        return text
    half = max_len // 2
    return f"{text[:half]}\n\n... [truncated {len(text) - max_len} chars] ...\n\n{text[-half:]}"

def format_command_history(history: list[CommandHistory]) -> str:
    """Format command history for the LLM prompt."""
    if not history:
        return '(none yet)'
    lines = []
    for i, h in enumerate(history, 1):
        result = f"ERROR: {h['error']}" if h.get('error') else truncate_output(h['output'], 20000)
        assessment = f"\nREFLECTION: {h['assessment']} - {h.get('reasoning', '')}" if h.get('assessment') else ""
        lines.append(f"[{i}] $ {h['command']}\n{result}{assessment}")
    return '\n\n'.join(lines)

async def call_llm(prompt: str, endpoint: str, model: str, provider: str = "ollama") -> str:
    """Call the LLM endpoint (Ollama or OpenAI-compatible)."""
    async with httpx.AsyncClient() as client:
        for attempt in range(3):
            try:
                if provider == "ollama":
                    # Ollama /api/generate
                    clean_endpoint = endpoint.rstrip('/').removesuffix('/v1').rstrip('/')
                    response = await client.post(
                        f"{clean_endpoint}/api/generate",
                        json={
                            "model": model,
                            "prompt": prompt,
                            "stream": False,
                            "format": "json",
                            "options": {
                                "num_predict": 4096,
                            }
                        },
                        timeout=300.0
                    )
                    response.raise_for_status()
                    return response.json()['response']
                
                else:
                    # OpenAI-compatible
                    clean_endpoint = endpoint.rstrip('/')
                    url = f"{clean_endpoint}/chat/completions"
                    
                    response = await client.post(
                        url,
                        json={
                            "model": model,
                            "messages": [{"role": "user", "content": prompt}],
                            "temperature": 0.0,
                            "max_tokens": 4096,
                            "response_format": { "type": "json_object" }
                        },
                        timeout=60.0,
                        headers={"Authorization": "Bearer optional_key"}
                    )
                    
                    if response.status_code != 200:
                        print(f"LLM ERROR {response.status_code}: {response.text}", flush=True)
                        response.raise_for_status()

                    result = response.json()
                    res_text = result['choices'][0]['message']['content']
                    return res_text

            except Exception as e:
                print(f"LLM Call Failed (Attempt {attempt+1}): {e}", flush=True)
                if attempt == 2:
                    return f"Error calling LLM: {e}"
                await asyncio.sleep(2)
        return "Error: Max retries exhausted"

async def get_cluster_recon(context: str = "") -> str:
    """Gather basic cluster info (Version, Nodes, Health) for the Supervisor."""
    try:
        cmd_prefix = f"kubectl --context={context} " if context else "kubectl "
        
        v_res = subprocess.run(f"{cmd_prefix}version --client=false -o json", shell=True, capture_output=True, text=True, timeout=5)
        v_info = "Unknown"
        if v_res.returncode == 0:
            try:
                v_json = json.loads(v_res.stdout)
                v_info = v_json.get('serverVersion', {}).get('gitVersion', 'Unknown')
            except Exception:
                pass

        n_res = subprocess.run(f"{cmd_prefix}get nodes --no-headers", shell=True, capture_output=True, text=True, timeout=5)
        nodes = n_res.stdout.strip().split('\n') if n_res.returncode == 0 and n_res.stdout.strip() else []
        node_count = len(nodes)
        not_ready = [n for n in nodes if "NotReady" in n]
        
        recon = f"Kubernetes v{v_info} | Nodes: {node_count} ({len(not_ready)} NotReady)"
        if not_ready:
            recon += f"\nWARNING: Unhealthy Nodes identified: {not_ready[:2]}"
            
        return recon
    except Exception as e:
        return f"Recon failed: {e}"

def emit_event(event_type: str, data: dict) -> dict:
    """Create an SSE event."""
    return {
        "type": event_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **data
    }

def clean_json_response(response: str) -> str:
    """Extract the first valid JSON object using brace counting."""
    text = response.strip()
    match = re.search(r'```(?:json)?\s*(\{.*)', text, re.DOTALL)
    if match:
        text = match.group(1)
    
    start = text.find('{')
    if start == -1:
        return response
        
    count = 0
    in_string = False
    escape = False
    
    for i, char in enumerate(text[start:], start):
        if char == '"' and not escape:
            in_string = not in_string
        elif char == '\\' and in_string:
            escape = not escape
        else:
            escape = False
            
        if not in_string:
            if char == '{':
                count += 1
            elif char == '}':
                count -= 1
                
            if count == 0:
                return text[start:i+1]
                
    match = re.search(r'(\{.*\})', response, re.DOTALL)
    return match.group(1) if match else response

def parse_supervisor_response(response: str) -> dict:
    """Parse the Brain's JSON response."""
    try:
        cleaned = clean_json_response(response)
        data = json.loads(cleaned)
        return {
            "thought": data.get("thought", ""),
            "plan": data.get("plan", ""),
            "next_action": data.get("next_action", "respond"),
            "final_response": data.get("final_response"),
        }
    except Exception as e:
        print(f"Error parsing supervisor output: {e}\nRaw: {response}")
        return {
            "thought": "Failed to parse brain response. Defaulting to final response.",
            "plan": "Error in planning.",
            "next_action": "respond",
            "final_response": f'I had an internal error planning the next step. Raw: {response}',
        }

def parse_worker_response(response: str) -> dict:
    """Parse the Worker's JSON response to get command and thought."""
    try:
        cleaned = clean_json_response(response)
        data = json.loads(cleaned)
        cmd = data.get("command", "")
        thought = data.get("thought", "Translating plan to command...")
        
        if not cmd:
            raise ValueError("No command found in worker response")
            
        return {"command": cmd, "thought": thought}
    except Exception as e:
        print(f"Error parsing worker output: {e}\nRaw: {response}")
        match = re.search(r'(kubectl\s+[\w-]+\s+.+?)(?:\n|$)', response, re.IGNORECASE)
        if match:
            return {"command": match.group(1).strip(), "thought": "Extracted command from raw text."}
        return {"command": "", "thought": "Failed to parse command."}

def parse_reflection(response: str) -> dict:
    """Parse the reflection JSON."""
    try:
        cleaned = clean_json_response(response)
        data = json.loads(cleaned)
        return {
            "thought": data.get("thought", ""),
            "found_solution": data.get("found_solution", False),
            "final_response": data.get("final_response", ""),
            "next_step_hint": data.get("next_step_hint", "")
        }
    except Exception as e:
        return {
            "thought": f"Failed to parse reflection: {e}",
            "found_solution": False,
            "final_response": "",
            "next_step_hint": "Check output manually",
        }

# =============================================================================
# EMBEDDINGS RAG IMPLEMENTATION
# =============================================================================

def _kb_entry_to_text(entry: dict) -> str:
    """Flatten a KB JSON entry into a single text chunk to embed."""
    parts = []
    if entry.get("id"):
        parts.append(f"ID: {entry['id']}")
    if entry.get("category"):
        parts.append(f"Category: {entry['category']}")
    if entry.get("symptoms"):
        parts.append("Symptoms: " + "; ".join(entry["symptoms"]))
    if entry.get("root_cause"):
        parts.append(f"Root cause: {entry['root_cause']}")
    if entry.get("investigation"):
        # Keep investigation short-ish
        if isinstance(entry["investigation"], list):
            parts.append("Investigation steps: " + "; ".join(entry["investigation"]))
        else:
            parts.append("Investigation: " + str(entry["investigation"]))
    if entry.get("fixes"):
        if isinstance(entry["fixes"], list):
            parts.append("Fixes: " + "; ".join(entry["fixes"]))
        else:
            parts.append("Fixes: " + str(entry["fixes"]))
    if entry.get("related_patterns"):
        parts.append("Related patterns: " + ", ".join(entry["related_patterns"]))
    return "\n".join(parts)

async def _embed_texts(texts: list[str], endpoint: str) -> list[list[float]]:
    """Call local embedding model (e.g., Ollama /api/embeddings)."""
    if not texts:
        return []

    async with httpx.AsyncClient() as client:
        # Decide which endpoint to call
        base = endpoint or ""
        clean_endpoint = base.rstrip('/').removesuffix('/v1').rstrip('/') if base else "http://localhost:11434"
        url = f"{clean_endpoint}/api/embeddings"

        resp = await client.post(
            url,
            json={"model": EMBEDDING_MODEL, "prompt": texts if len(texts) > 1 else texts[0]},
            timeout=120.0,
        )
        resp.raise_for_status()
        data = resp.json()
        # Ollama returns {"embedding": [...]} or {"embeddings":[...]}
        if "embedding" in data:
            return [data["embedding"]]
        if "embeddings" in data:
            return data["embeddings"]
        raise ValueError("Unexpected embedding response format")

def _cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two vectors."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)

async def _ensure_kb_loaded(embed_endpoint: str):
    """Load KB JSON files and their embeddings once."""
    global kb_loaded, kb_entries, kb_embeddings

    async with kb_lock:
        if kb_loaded:
            return

        entries: list[dict] = []
        if os.path.isdir(KB_DIR):
            for name in os.listdir(KB_DIR):
                if not name.lower().endswith(".json"):
                    continue
                path = os.path.join(KB_DIR, name)
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        if isinstance(data, list):
                            entries.extend(data)
                        else:
                            entries.append(data)
                except Exception as e:
                    print(f"[KB] Failed to load {path}: {e}", flush=True)
        else:
            print(f"[KB] KB_DIR does not exist: {KB_DIR}", flush=True)

        kb_entries = entries
        if not entries:
            kb_embeddings = []
            kb_loaded = True
            print("[KB] No KB entries loaded", flush=True)
            return

        texts = [_kb_entry_to_text(e) for e in entries]
        try:
            kb_embeddings = await _embed_texts(texts, embed_endpoint)
            print(f"[KB] Loaded {len(kb_entries)} entries with embeddings", flush=True)
        except Exception as e:
            print(f"[KB] Failed to embed KB entries: {e}", flush=True)
            kb_embeddings = []
        kb_loaded = True

async def get_relevant_kb_snippets(query: str, state: AgentState) -> str:
    """
    Retrieve top-k KB entries using embeddings and format as a context string.
    This is read-only and used as RAG context for the supervisor.
    """
    embed_endpoint = EMBEDDING_ENDPOINT or state.get("llm_endpoint", "")
    await _ensure_kb_loaded(embed_endpoint)

    if not kb_entries or not kb_embeddings:
        return "(no KB context loaded)"

    try:
        q_embs = await _embed_texts([query], embed_endpoint)
    except Exception as e:
        print(f"[KB] Query embedding failed: {e}", flush=True)
        return "(KB unavailable due to embedding error)"

    q_vec = q_embs[0]
    scored = []
    for idx, vec in enumerate(kb_embeddings):
        sim = _cosine(q_vec, vec)
        scored.append((sim, idx))
    scored.sort(reverse=True, key=lambda x: x[0])

    top = [s for s in scored[:KB_MAX_MATCHES] if s[0] >= KB_MIN_SIMILARITY]
    if not top:
        return "(no strong KB matches for this query)"

    lines = []
    for sim, idx in top:
        e = kb_entries[idx]
        lines.append(f"- [KB:{e.get('id', f'entry-{idx}')}] (similarity {sim:.2f})")
        if e.get("symptoms"):
            lines.append("  Symptoms: " + "; ".join(e["symptoms"]))
        if e.get("root_cause"):
            lines.append("  Root cause: " + str(e["root_cause"]))
        if e.get("investigation"):
            if isinstance(e["investigation"], list):
                lines.append("  Investigation: " + "; ".join(e["investigation"]))
            else:
                lines.append("  Investigation: " + str(e["investigation"]))
        if e.get("fixes"):
            if isinstance(e["fixes"], list):
                lines.append("  Fixes: " + "; ".join(e["fixes"]))
            else:
                lines.append("  Fixes: " + str(e["fixes"]))
        lines.append("")  # blank line between entries

    return "\n".join(lines) if lines else "(no KB context)"

# =============================================================================
# QUERY AUTO-CORRECTION
# =============================================================================

TYPO_CORRECTIONS = {
    # Kubernetes core
    "kuberntes": "kubernetes", "kubernets": "kubernetes", "kuberentes": "kubernetes",
    "kubenetes": "kubernetes", "kubernete": "kubernetes", "k8": "kubernetes",
    "deploymnet": "deployment", "deployemnt": "deployment", "deploment": "deployment",
    "servcie": "service", "serivce": "service", "servic": "service",
    "namepsace": "namespace", "namesapce": "namespace", "namspace": "namespace",
    "configmap": "configmap", "confimap": "configmap", "configmp": "configmap",
    "secert": "secret", "secrete": "secret", "scret": "secret",
    "ingres": "ingress", "ingerss": "ingress", "ingess": "ingress",
    "replicaest": "replicaset", "replicast": "replicaset",
    "statefullset": "statefulset", "statefuset": "statefulset",
    "daemonet": "daemonset", "deamonset": "daemonset",
    "persistentvolume": "persistentvolume", "presistentvolume": "persistentvolume",
    "pv": "pv", "pvs": "pvs", "pvc": "pvc",
    "horizotnal": "horizontal", "horizantal": "horizontal",
    "autoscal": "autoscale", "autosclaer": "autoscaler",

    # CNCF Projects
    "crossplanr": "crossplane", "crossplnae": "crossplane", "crossplae": "crossplane",
    "crosspane": "crossplane", "corssplane": "crossplane",
    "promethues": "prometheus", "prometeus": "prometheus", "promethus": "prometheus",
    "promethesu": "prometheus", "promtheus": "prometheus",
    "certmanager": "cert-manager", "cert-manger": "cert-manager", "certmanger": "cert-manager",
    "isito": "istio", "isto": "istio", "itsio": "istio",
    "argocd": "argocd", "argo-cd": "argocd", "argcod": "argocd",
    "fluxcd": "flux", "fulx": "flux", "flxu": "flux",
    "velro": "velero", "veleor": "velero", "velaro": "velero",
    "kead": "keda", "kdea": "keda",
    "exteranl": "external", "extenral": "external", "exernal": "external",
    "sealded": "sealed", "selaed": "sealed",
    "cilum": "cilium", "cillium": "cilium", "cilim": "cilium",
    "knavite": "knative", "kantive": "knative", "knateive": "knative",
    "linekrd": "linkerd", "linkred": "linkerd", "linekerd": "linkerd",
    "gatway": "gateway", "gatewya": "gateway", "gaetway": "gateway",
    "kafak": "kafka", "kafkaa": "kafka", "kakfa": "kafka",
    "strimizi": "strimzi", "strimi": "strimzi",

    # Common command typos
    "kubctl": "kubectl", "kubetcl": "kubectl", "kubeclt": "kubectl", "kuectl": "kubectl",
    "proviosned": "provisioned", "provisoined": "provisioned", "provisoned": "provisioned",
    "resouces": "resources", "resoruces": "resources", "resourcs": "resources",
    "clsuter": "cluster", "clusetr": "cluster", "culster": "cluster",
    "endpionts": "endpoints", "endpoitns": "endpoints", "edpoints": "endpoints",
    "conatiners": "containers", "containres": "containers", "contianers": "containers",
}

def autocorrect_query(query: str) -> tuple[str, list[str]]:
    """Auto-correct common typos in the query.

    Returns (corrected_query, list_of_corrections_made)
    """
    import re
    corrected = query
    corrections = []

    words = re.findall(r'\b\w+\b', query.lower())
    for word in words:
        if word in TYPO_CORRECTIONS:
            correct = TYPO_CORRECTIONS[word]
            pattern = re.compile(re.escape(word), re.IGNORECASE)
            corrected = pattern.sub(correct, corrected)
            corrections.append(f"{word} → {correct}")

    return corrected, corrections

# =============================================================================
# DYNAMIC EXAMPLE SELECTION
# =============================================================================

EXAMPLE_CATEGORIES = {
    "core": {
        "keywords": [],
        "examples": ["1", "2", "3", "4", "5", "6", "7", "8", "8e", "8f", "8g"],
    },
    "crossplane": {
        "keywords": ["crossplane", "composition", "xrd", "provider", "managed resource", "claim"],
        "examples": ["9", "9b", "9c", "10"],
    },
    "cert_manager": {
        "keywords": ["cert", "certificate", "tls", "ssl", "issuer", "letsencrypt", "acme"],
        "examples": ["15"],
    },
    "argocd": {
        "keywords": ["argo", "argocd", "gitops", "sync", "application"],
        "examples": ["16", "30"],
    },
    "prometheus": {
        "keywords": ["prometheus", "servicemonitor", "podmonitor", "alertmanager", "metrics", "scrape", "monitoring"],
        "examples": ["18", "18b"],
    },
    "velero": {
        "keywords": ["velero", "backup", "restore", "disaster recovery", "dr"],
        "examples": ["19", "19b"],
    },
    "keda": {
        "keywords": ["keda", "autoscal", "scaledobject", "scaledjob", "trigger"],
        "examples": ["20", "20b"],
    },
    "flux": {
        "keywords": ["flux", "gitrepository", "kustomization", "helmrelease", "gitops"],
        "examples": ["21", "21b"],
    },
    "external_secrets": {
        "keywords": ["external secret", "secretstore", "vault", "aws secret"],
        "examples": ["22", "22b"],
    },
    "sealed_secrets": {
        "keywords": ["sealed secret", "bitnami", "kubeseal"],
        "examples": ["23"],
    },
    "cilium": {
        "keywords": ["cilium", "network policy", "cnp", "hubble"],
        "examples": ["24"],
    },
    "knative": {
        "keywords": ["knative", "serverless", "ksvc", "revision"],
        "examples": ["25", "25b"],
    },
    "linkerd": {
        "keywords": ["linkerd", "service mesh", "proxy", "sidecar"],
        "examples": ["26"],
    },
    "gateway_api": {
        "keywords": ["gateway api", "httproute", "grpcroute", "gateway.networking"],
        "examples": ["27"],
    },
    "cluster_api": {
        "keywords": ["cluster api", "capi", "machine", "machinedeployment", "capz", "capa"],
        "examples": ["28"],
    },
    "kafka": {
        "keywords": ["kafka", "strimzi", "kafkatopic", "kafkauser"],
        "examples": ["29"],
    },
    "istio": {
        "keywords": ["istio", "virtualservice", "destinationrule", "envoy", "service mesh"],
        "examples": ["14"],
    },
    "error_patterns": {
        "keywords": ["crashloop", "imagepull", "pending", "oom", "evict", "error", "fail", "crash", "stuck", "not ready", "backoff"],
        "examples": ["31", "32", "33", "34", "35", "36"],
    },
    "relationships": {
        "keywords": ["endpoint", "service", "ingress", "503", "pvc", "pv", "hpa", "deployment", "replicaset"],
        "examples": ["37", "38", "39", "40", "41"],
    },
    "health_check": {
        "keywords": ["health", "broken", "unhealthy", "everything", "cluster", "overview"],
        "examples": ["17", "42", "43", "44"],
    },
    "quantitative": {
        "keywords": ["restart", "count", "how many", "utilization", "resource", "cpu", "memory", "top", "hot"],
        "examples": ["47", "48", "49", "50"],
    },
    "network": {
        "keywords": ["dns", "network", "connect", "reach", "policy", "rbac", "permission"],
        "examples": ["51", "53", "54"],
    },
    "admission": {
        "keywords": ["webhook", "reject", "denied", "admission", "validating", "mutating"],
        "examples": ["55"],
    },
}

def select_relevant_examples(query: str, max_examples: int = 15) -> list[str]:
    """Select the most relevant example numbers based on query keywords."""
    query_lower = query.lower()
    selected = set()

    # Always include core examples
    selected.update(EXAMPLE_CATEGORIES["core"]["examples"])

    category_scores = []
    for cat_name, cat_data in EXAMPLE_CATEGORIES.items():
        if cat_name == "core":
            continue
        score = sum(1 for kw in cat_data["keywords"] if kw in query_lower)
        if score > 0:
            category_scores.append((score, cat_name, cat_data["examples"]))

    category_scores.sort(reverse=True, key=lambda x: x[0])

    for score, cat_name, examples in category_scores:
        if len(selected) >= max_examples:
            break
        for ex in examples:
            if len(selected) >= max_examples:
                break
            selected.add(str(ex))

    def sort_key(x: str):
        import re
        match = re.match(r'(\d+)([a-z]*)', x)
        if match:
            return (int(match.group(1)), match.group(2))
        return (999, x)

    return sorted(selected, key=sort_key)

def get_examples_text(example_ids: list[str], full_examples: str) -> str:
    """Extract specific examples from the full examples string by their IDs."""
    import re
    pattern = r'(EXAMPLE\s+(\d+[a-z]?):[^\n]*\n(?:.*?\n)*?(?=EXAMPLE\s+\d|# ===|$))'
    matches = re.findall(pattern, full_examples, re.DOTALL)

    example_dict = {}
    for match in matches:
        full_match, example_id = match
        example_dict[example_id] = full_match.strip()

    selected_texts = []
    for eid in example_ids:
        if eid in example_dict:
            selected_texts.append(example_dict[eid])

    return '\n\n'.join(selected_texts)

# =============================================================================
# PROMPT DEFINITIONS (SUPERVISOR_EXAMPLES_FULL OMITTED HERE FOR BREVITY)
# NOTE: Use the same SUPERVISOR_EXAMPLES_FULL content you already have.
# =============================================================================

SUPERVISOR_EXAMPLES_FULL = """
EXAMPLE 1: Simple listing (stop after one command)
User: "List pods in namespace payments"
Command History:
(none yet)

Thought:
- This is a simple listing query.
- Only need one command: get pods in the requested namespace.
- No logs, no describe, no deep debugging.

Plan:
- Ask the worker to run:
  kubectl get pods -n payments -o wide

Brain JSON:
{
  "thought": "User wants a simple list of pods in a known namespace. Single get is enough.",
  "plan": "Run `kubectl get pods -n payments -o wide` and then respond with the table.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 2: Pure explanation (no kubectl needed)
User: "What is a Kubernetes StatefulSet and when should I use it?"
Command History:
(none)

Thought:
- This is a conceptual question.
- No need to talk to the cluster.
- Answer directly with explanation and examples.

Brain JSON:
{
  "thought": "Question is purely definitional. I should explain StatefulSets without running kubectl.",
  "plan": "Explain what a StatefulSet is, how it differs from a Deployment, and when to use it.",
  "next_action": "respond",
  "final_response": "A StatefulSet is a controller that manages pods with stable identities and persistent storage. Use it for databases like Cassandra, etc..."
}

---

EXAMPLE 3: Basic CrashLoopBackOff debugging
User: "My app pod is in CrashLoopBackOff, why?"
Command History:
1) $ kubectl get pods -A | grep my-app
   NAMESPACE   NAME          READY   STATUS             RESTARTS   AGE
   web         my-app-7c9d   0/1     CrashLoopBackOff   5          3m

Thought:
- We already know the pod and namespace.
- Next step: logs (including previous container) and describe.
- One batched command is efficient.

Plan:
- Ask worker to run:
  kubectl logs my-app-7c9d -n web --tail=100 --previous && kubectl describe pod my-app-7c9d -n web

Brain JSON:
{
  "thought": "CrashLoopBackOff needs logs and describe to find root cause.",
  "plan": "Get previous logs and describe the pod in namespace web.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 8: Existence / discovery only (stop when found)
User: "Where is the Deployment called checkout-service?"
Command History:
(none yet)

Thought:
- User only wants to know where the resource exists.
- Step 1: search across namespaces.
- Once found, respond. No describe/logs needed.

Plan:
- Ask worker to run:
  kubectl get deploy -A | grep checkout-service

Brain JSON:
{
  "thought": "We just need namespace and existence for this deployment.",
  "plan": "Find the Deployment by name across all namespaces, then respond with namespace and ready status.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 9: Crossplane discovery (must use api-resources first)
User: "List all Crossplane compositions and show me if any are failing."
Command History:
(none yet)

Thought:
- Crossplane uses CRDs, not core types.
- Never guess names like managedresources.
- First: discover CRDs via api-resources.
- Then: list compositions and check Ready conditions.

Plan:
1) Ask worker to run:
   kubectl api-resources | grep -i crossplane
2) Next step (after we see the real Kind names) will be:
   kubectl get compositions -A -o wide
   ...and check status conditions.

Brain JSON:
{
  "thought": "Need to discover Crossplane CRDs first using api-resources, then list compositions and inspect Ready conditions.",
  "plan": "Run `kubectl api-resources | grep -i crossplane` to discover composition and related types.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 14: Istio VirtualService / DestinationRule routing issue
User: "Requests to /api fail, I think it's an Istio problem."
Command History:
1) $ kubectl get virtualservice -A | grep api
   istio-system   api-vs   1h
2) $ kubectl get destinationrule -A | grep api
   istio-system   api-dr   1h

Thought:
- We found relevant Istio resources.
- Need to describe and inspect hosts, subsets, and labels.
- Also check Service and Endpoints.

Plan:
- Ask worker to run:
  kubectl describe virtualservice api-vs -n istio-system && \
  kubectl describe destinationrule api-dr -n istio-system

Brain JSON:
{
  "thought": "The user suspects Istio. We must check VirtualService and DestinationRule routing and subsets.",
  "plan": "Describe the VS and DR for api and then correlate with Service/Endpoints.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 18: Prometheus ServiceMonitor not scraping
User: "My metrics aren't showing up in Prometheus."
Command History:
1) $ kubectl api-resources | grep -i monitor
   servicemonitors.monitoring.coreos.com
   podmonitors.monitoring.coreos.com
2) $ kubectl get servicemonitors -A | grep my-app
   monitoring   my-app-sm   10m

Thought:
- ServiceMonitor exists.
- Next: describe it and ensure its selector matches the Service.
- Also verify the Service has the right port name.

Plan:
- Ask worker to run:
  kubectl describe servicemonitor my-app-sm -n monitoring

Brain JSON:
{
  "thought": "ServiceMonitor exists; now we must check its selector and endpoints.",
  "plan": "Describe the ServiceMonitor to confirm it selects the correct Service and port.",
  "next_action": "delegate",
  "final_response": null
}

---

EXAMPLE 31: Direct OOMKilled diagnosis (instant solution)
User: "Why does this pod keep restarting?"
Command History:
1) $ kubectl describe pod api-6b8d -n payments
   ...
   State:       Terminated
     Reason:    OOMKilled
     Exit Code: 137
   ...

Thought:
- Output clearly shows OOMKilled.
- Root cause is memory limit too low or memory leak.
- We can respond immediately with fix suggestions.

Brain JSON:
{
  "thought": "Describe output shows OOMKilled with exit code 137.",
  "plan": "Explain that the pod is being killed due to memory limits and suggest increasing resources or investigating leaks.",
  "next_action": "respond",
  "final_response": "The pod is restarting because it is OOMKilled (Out Of Memory). In the describe output you can see 'Reason: OOMKilled, Exit Code: 137'. This means the container exceeded its memory limit. Fix: increase the container memory limit in the Deployment/StatefulSet spec, or reduce memory usage in the application. After updating the manifest, redeploy and verify the pod stays Running."
}

---

EXAMPLE 37: Service has no endpoints (selector mismatch)
User: "Why is my Service returning 503?"
Command History:
1) $ kubectl get svc -n web | grep checkout
   checkout-svc   ClusterIP   10.0.0.42   <none>   8080/TCP
2) $ kubectl describe svc checkout-svc -n web
   ...
   Endpoints: <none>
   Selector: app=checkout, tier=frontend
   ...

Thought:
- Endpoints are empty → Service has no backing pods.
- Root cause is usually label mismatch or pods not Ready.
- We can already respond with explanation.

Brain JSON:
{
  "thought": "The Service has Endpoints: <none>, which means it has no backing pods to route to.",
  "plan": "Explain that the Service selector doesn't match any Ready pods and how to fix labels/selectors.",
  "next_action": "respond",
  "final_response": "The 503 comes from the Service having no endpoints. In `kubectl describe svc checkout-svc -n web` you can see `Endpoints: <none>`. This means no pods with labels `app=checkout, tier=frontend` are Ready. Fix: ensure the Deployment pods have matching labels and are Ready, or update the Service selector to match the existing pods."
}

---

EXAMPLE 42: Cluster-wide health overview
User: "Is anything broken in my cluster right now?"
Command History:
1) $ kubectl get nodes
2) $ kubectl get pods -A | grep -v Running
3) $ kubectl get events -A --field-selector type=Warning --sort-by=.lastTimestamp | tail -n 20

Thought:
- We collected a basic cluster overview.
- Now summarize node health, non-Running pods, and recent warnings.
- Respond with a concise health report.

Brain JSON:
{
  "thought": "We have a good overview of nodes, non-Running pods, and warnings. Time to summarize.",
  "plan": "Summarize node readiness, highlight problematic pods, and mention the most recent Warning events.",
  "next_action": "respond",
  "final_response": "Here is your cluster snapshot: Nodes: 3 (all Ready). Non-Running pods: 2 in namespace web (api-xyz in CrashLoopBackOff, worker-abc Pending). Recent warnings: FailedScheduling for worker-abc due to Insufficient CPU on all nodes. Next steps: either increase node resources or reduce requested CPU for worker-abc."
}

---

EXAMPLE 51: DNS / network issue
User: "My pod can't reach the database endpoint."
Command History:
1) $ kubectl logs api-7f9d -n web --tail=50
   ...
   dial tcp db.svc.cluster.local:5432: i/o timeout
   ...
2) $ kubectl get svc -n web | grep db
   db         ClusterIP   10.0.0.55   <none>   5432/TCP
3) $ kubectl get endpoints db -n web
   NAME   ENDPOINTS   AGE
   db     <none>      5m

Thought:
- DNS is resolving (we see db.svc.cluster.local), but Service has no endpoints.
- Root cause is the same as Service selector mismatch or pods not Ready.
- We can answer now.

Brain JSON:
{
  "thought": "Connection timeout combined with Service having no endpoints indicates no healthy DB pods behind the Service.",
  "plan": "Explain that the DB Service has no endpoints and suggest checking pod labels and readiness.",
  "next_action": "respond",
  "final_response": "Your API pod can't reach the DB because the `db` Service has no endpoints. `kubectl get endpoints db -n web` shows `<none>`, meaning no Ready pods match its selector. Fix: ensure the DB Deployment pods have the correct labels and are Running/Ready, or update the Service selector."
}

---

EXAMPLE 55: Admission webhook denial
User: "Why can't I apply this Deployment?"
Command History:
1) $ kubectl apply -f deploy.yaml
   Error from server (BadRequest): error when creating "deploy.yaml":
   admission webhook "policy.example.com" denied the request:
   containers must not run as root

Thought:
- The error clearly mentions an admission webhook and exact policy.
- Root cause is violating the policy (runAsNonRoot).
- We can respond with the exact fix.

Brain JSON:
{
  "thought": "Apply failed due to an admission webhook enforcing a 'must not run as root' policy.",
  "plan": "Explain that a ValidatingWebhook denies the Deployment and show how to set runAsNonRoot / securityContext.",
  "next_action": "respond",
  "final_response": "The Deployment is rejected by an admission webhook (`policy.example.com`) that forbids containers running as root. The error message says `containers must not run as root`. Fix: update your Pod template in deploy.yaml to set `securityContext.runAsNonRoot: true` and optionally `runAsUser` to a non-zero UID. Then apply again."
}
"""

SUPERVISOR_PROMPT = """You are an Expert Kubernetes Assistant.
Your goal is to help the user with any Kubernetes task, from simple information retrieval to complex debugging.

You have access to two sources of truth:
1. **Live cluster output** from kubectl (highest priority when available).
2. **Knowledge Base (KB)** snippets below (curated troubleshooting playbooks).

ALWAYS:
- Treat KB snippets as **trusted patterns** and recommended investigations.
- If KB and live kubectl output disagree, trust **live cluster output** and explain the discrepancy.
- Prefer using KB investigation steps and fixes instead of inventing new ones.

---
KNOWLEDGE BASE CONTEXT (Top matches for this query):
{kb_context}

---
FEW-SHOT EXAMPLES (Decision patterns and JSON contract):
{examples}

---
CURRENT INVESTIGATION:
Query: {query}
Context: {kube_context}
Cluster: {cluster_info}

Command History:
{command_history}

---
INSTRUCTIONS:
1. ANALYZE the user's request, KB context, and command history.
2. CATEGORIZE the task:
   - **Simple Info**: (e.g., "List pods", "Get nodes") -> Plan a direct command.
   - **Search/Find**: (e.g., "Find custom resource", "Where is X?") -> Plan a filtered search. **STOP** once found.
   - **Debugging**: (e.g., "Why is it broken?") -> Plan an investigation step (Logs -> Describe -> Events).
   - **Explanation**: (e.g., "What is a pod?") -> **IMMEDIATE RESPOND** (Use Example 2 logic).
   - **Discovery**: (e.g., "Unknown resource") -> Plan `kubectl api-resources` to find the CRD.

3. **FINAL ANSWER RULES**:
   - If you found the answer, your `final_response` MUST include the **ACTUAL DATA** (e.g., list of names, specific error logs), not just a summary like "I found them".
   - Use Markdown tables or lists for resources.
   - If the user asked "Find X", SHOW X.
   - If KB already contains a named pattern that matches the situation (e.g., symptoms/root_cause), use it as part of your explanation and suggested fix.

4. **KEY RULES**:
   - **PRIORITIZE RESPONDING**: If you have the answer (e.g., from `command_history` or clearly from KB), DO NOT run more commands. Just `respond`.
   - **ROOT CAUSE**: If debugging, don't stop at "Error". Find the *Cause* (e.g., "OOMKilled" -> "Memory Limit too low").
   - **NO GUESSING**: If you are unsure, propose a command to verify.

RESPONSE FORMAT (JSON):
{{
    "thought": "Your analysis of the situation and user intent",
    "plan": "What the Worker should do next (natural language)",
    "next_action": "delegate" | "respond",
    "final_response": "Your complete answer (only when next_action=respond)"
}}

KEY RULES:
- **PRIORITIZE RESPOND**: If the answer is purely definitional or known from a single successful command output, use `next_action: "respond"`. This prevents unnecessary looping.
- **STOP IF FOUND**: If the user asked to "find", "list", or "check existence" of a resource, and you found it, DO NOT investigate further (no describe/logs) unless explicitly asked to "debug" or "check health".
- **BATCH COMMANDS**: To be efficient, you MAY instruct the worker to run multiple related checks in one step (e.g., "Get pod status AND logs").
- **NAMESPACE DISCOVERY FIRST**: When user mentions a resource name but NO namespace, NEVER guess the namespace (don't use -n default or random namespaces). First run `kubectl get <resource-type> -A | grep <name>` to discover which namespace contains it. Only then proceed with investigation using the discovered namespace.
- Find ROOT CAUSE - don't stop at symptoms

EARLY TERMINATION (CRITICAL - reduces steps by 40%):
- **LISTING QUERIES**: "list pods", "show services", "get nodes" → ONE command then RESPOND. No describe, no logs.
- **EXISTENCE CHECK**: "does X exist", "is there a Y" → ONE command then RESPOND with yes/no.
- **COUNT QUERIES**: "how many pods" → ONE command with count then RESPOND.
- **STATUS CHECK**: "what's the status of X" → ONE command then RESPOND with status.
- **INSTANT DIAGNOSIS**: If command output shows OOMKilled, ImagePullBackOff with 401/404, FailedScheduling with Insufficient, or "no endpoints" → RESPOND immediately with root cause. No more investigation.

EFFICIENT INVESTIGATION (for debugging queries only):
- **STEP 1**: Run batched diagnostic (get + describe + events in ONE command) when safe.
- **STEP 2**: If root cause visible in output → RESPOND immediately
- **STEP 3**: Only go deeper (logs, related resources) if step 2 didn't find cause
- **MAX 3 STEPS** for most issues. If not found in 3 steps, summarize findings and ask user for direction.

CRITICAL - CRD/Custom Resource Discovery:
- **NEVER GUESS RESOURCE NAMES**: Generic names like 'managedresources', 'compositeresources', 'customresources' DO NOT EXIST.
- **ALWAYS DISCOVER FIRST**: When asked about ANY of these CNCF projects, your FIRST action MUST be `kubectl api-resources | grep <keyword>`:
  - Crossplane: `grep crossplane` → compositions, providers, xrds
  - Prometheus: `grep -i monitor` → servicemonitors, podmonitors, prometheusrules
  - Cert-Manager: `grep cert-manager` → certificates, issuers, clusterissuers
  - Istio: `grep istio` → virtualservices, destinationrules, gateways
  - ArgoCD: `grep argoproj` → applications, applicationsets, appprojects
  - Flux: `grep toolkit.fluxcd` → gitrepositories, kustomizations, helmreleases
  - KEDA: `grep keda` → scaledobjects, scaledjobs, triggerauthentications
  - Velero: `grep velero` → backups, restores, schedules
  - External Secrets: `grep external` → externalsecrets, secretstores
  - Knative: `grep knative` → services, routes, revisions
  - Cilium: `grep cilium` → ciliumnetworkpolicies, ciliumendpoints
  - Gateway API: `grep gateway.networking` → gateways, httproutes
  - Cluster API: `grep cluster.x-k8s.io` → clusters, machines, machinedeployments
  - Strimzi/Kafka: `grep kafka` → kafkas, kafkatopics, kafkausers
- **CROSSPLANE SPECIFIC**: Crossplane has NO 'managedresources' type. Use `kubectl api-resources | grep crossplane` to find types like: compositions, providers, providerconfigs, xrds, etc.
- **OPERATOR PATTERN**: For any operator (redis-operator, prometheus-operator, etc.), always grep api-resources to find what CRDs it installed.
"""

WORKER_PROMPT = """
TASK: {plan}
CONTEXT: {kube_context}
LAST COMMAND: {last_command_info}

DO NOT REPEAT THESE COMMANDS (already executed):
{avoid_commands}

You are a read-only Kubernetes CLI executor.
Your job: translate the plan into a **single safe kubectl command** (you may batch with `&&`).

RESPONSE FORMAT (JSON ONLY):
{{
    "thought": "Reasoning for the command choice...",
    "command": "kubectl get pods -n default -o wide"
}}

RULES:
- **LISTING**: When asked to "list" or "find" resources, ALWAYS use `kubectl get <resource>`.
- **'LIST ALL'**: Avoid generic `get all`. Prefer specific resources (`get pods -A`, `get nodes`).
- **NO REPEATS**: Generate a DIFFERENT command than those listed above.
- **LOGS**: Use `--tail=100` or `--since=5m` to limit log output. Use `--previous` only for CrashLoopBackOff.
- **DESCRIBE**: Always include `-n <namespace>` for describe commands.
- **COUNTING**: For 'how many' / 'count', use `| wc -l` or similar.
- **DISCOVERY**:
  - To find by name across namespaces: `kubectl get <type> -A | grep <name>`
  - NEVER use invalid syntax like `kubectl get <name> -A`.

SAFE BATCHING (Efficiency + Safety):
- Use `&&` instead of `;` to chain commands, so later commands only run if earlier ones succeed.
- Group commands by resource, e.g.:
  - `kubectl get pod X -n NS -o wide && kubectl describe pod X -n NS && kubectl logs X -n NS --tail=50`
- Do NOT batch when still discovering the correct name or namespace (do discovery first in one step).

FORBIDDEN VERBS (do not generate commands that use these):
- delete, apply, edit, scale, patch, replace, create, rollout, cordon, drain, taint, annotate, label, set, cp
"""

REFLECT_PROMPT = """Analyze the command result and determine if we found the root cause.

ORIGINAL QUERY: {query}
COMMAND EXECUTED: {last_command}
OUTPUT:
{result}

INSTANT SOLUTION PATTERNS (set found_solution=TRUE immediately if you see these):
- "OOMKilled" or "Exit Code: 137" → Memory limit exceeded
- "ImagePullBackOff" + "401" → Registry auth failed
- "ImagePullBackOff" + "404" or "not found" → Image doesn't exist
- "FailedScheduling" + "Insufficient" → Not enough cluster resources
- "CrashLoopBackOff" + actual error in logs → Application crash with reason
- "CreateContainerConfigError" + "not found" → Missing Secret/ConfigMap
- "Evicted" + "node pressure" → Node resource pressure
- "connection refused" or "no route to host" → Network/DNS issue
- "forbidden" or "cannot" + RBAC → Permission denied
- "admission webhook" + "denied" → Policy rejection
- "Back-off pulling image" → Registry rate limit or network issue
- "0/N nodes are available" → Scheduling constraints
- "Endpoints: <none>" or "no endpoints" → Service selector mismatch

SIMPLE QUERY PATTERNS (set found_solution=TRUE for informational queries):
- User asked to "list" or "show" and output contains the resources → DONE
- User asked "how many" and output shows count → DONE
- User asked "does X exist" and output confirms existence → DONE
- User asked "what is the status" and output shows status → DONE

ASSESSMENT CRITERIA:
- found_solution=TRUE if output matches ANY instant pattern above
- found_solution=TRUE if user's informational query is answered
- found_solution=FALSE ONLY if output shows symptoms without root cause

BE AGGRESSIVE: If you can explain WHY something is broken with evidence from the output, mark it SOLVED.
Do NOT request more investigation if the answer is already visible.

RESPONSE FORMAT (JSON):
{{
    "thought": "What does this output tell us? Did we find the actual cause?",
    "found_solution": true | false,
    "final_response": "Complete answer with root cause and fix (only if found_solution=true)",
    "next_step_hint": "What specific thing to check next (only if found_solution=false)"
}}
"""

VERIFY_COMMAND_PROMPT = """Verify this kubectl command is safe and correct.

PLAN: {plan}
COMMAND: {command}

CHECK:
1. SAFE? No delete/edit/apply/patch (read-only operations only)
2. CORRECT? Valid kubectl syntax
3. RELEVANT? Matches the plan

RESPONSE FORMAT (JSON):
{{
    "thought": "Brief assessment",
    "approved": true | false,
    "corrected_command": "Fixed command if needed (empty if approved)"
}}
"""

# =============================================================================
# NODE FUNCTIONS
# =============================================================================

async def supervisor_node(state: AgentState) -> dict:
    """Brain Node (70B): Analyzes history and plans the next step."""
    iteration = state.get('iteration', 0) + 1
    events = list(state.get('events', []))

    events.append(emit_event("progress", {"message": f"Supervisor Reasoning (iteration {iteration})..."}))

    # Max iteration guard
    if iteration > MAX_ITERATIONS:
        summary_parts = ["## Investigation Summary\n"]
        summary_parts.append(f"I've analyzed your query through {MAX_ITERATIONS} steps but haven't reached a definitive conclusion.\n")

        if state['command_history']:
            summary_parts.append("### Commands Executed:")
            for i, cmd in enumerate(state['command_history'][-5:], 1):
                summary_parts.append(f"- `{cmd.get('command', 'N/A')}`")

            last_cmd = state['command_history'][-1]
            if last_cmd.get('output'):
                output_content = last_cmd['output']
                if len(output_content) < 2000:
                    summary_parts.append(f"\n### Data Found:\n```\n{output_content}\n```")
                else:
                    summary_parts.append(f"\n### Data Found (Truncated):\n```\n{output_content[:1000]}\n...\n{output_content[-1000:]}\n```")

        summary_parts.append("\n### What to do next:")
        summary_parts.append("- Try asking a more specific question")
        summary_parts.append("- Focus on a particular resource or namespace")
        summary_parts.append("- Ask me to continue investigating from here")

        final_response = "\n".join(summary_parts)

        events.append(emit_event("done", {"reason": "max_iterations", "final_response": final_response}))
        return {
            **state,
            'iteration': iteration,
            'next_action': 'done',
            'final_response': final_response,
            'events': events,
        }

    # If reflection already marked solved, short-circuit to done
    if state['command_history']:
        last_entry = state['command_history'][-1]
        if last_entry.get('assessment') == 'SOLVED':
            reasoning = last_entry.get('reasoning', '')
            solution = reasoning.split("SOLUTION FOUND:", 1)[-1].strip() if "SOLUTION FOUND:" in reasoning else reasoning

            events.append(emit_event("progress", {"message": "Solution identified by Reflection. Wrapping up."}))
            return {
                **state,
                'iteration': iteration,
                'next_action': 'done',
                'final_response': solution,
                'events': events,
            }

    # Auto-correct query only on first iteration
    query = state['query']
    if iteration == 1:
        corrected_query, corrections = autocorrect_query(query)
        if corrections:
            corrections_str = ", ".join(corrections)
            events.append(emit_event("reflection", {
                "assessment": "AUTO-CORRECTED",
                "reasoning": f"Fixed typos in your query: {corrections_str}"
            }))
            query = corrected_query
            print(f"[agent-sidecar] Auto-corrected query: {corrections}", flush=True)

    # Embeddings RAG: fetch KB snippets for this query
    kb_context = await get_relevant_kb_snippets(query, state)

    # Dynamic example selection (max 25 examples)
    selected_example_ids = select_relevant_examples(query, max_examples=25)
    selected_examples = get_examples_text(selected_example_ids, SUPERVISOR_EXAMPLES_FULL)
    print(f"[agent-sidecar] Selected {len(selected_example_ids)} examples (Max 25)", flush=True)

    prompt = SUPERVISOR_PROMPT.format(
        kb_context=kb_context,
        examples=selected_examples,
        query=query,
        kube_context=state['kube_context'] or 'default',
        cluster_info=state.get('cluster_info', 'Not available'),
        command_history=format_command_history(state['command_history']),
    )

    try:
        response = await call_llm(prompt, state['llm_endpoint'], state['llm_model'], state.get('llm_provider', 'ollama'))
        result = parse_supervisor_response(response)
        
        if result['thought']:
            events.append(emit_event("reflection", {"assessment": "PLANNING", "reasoning": result['thought']}))
        
        if result['next_action'] == 'delegate':
            events.append(emit_event("progress", {"message": f"🧠 Brain Instruction: {result['plan']}"}))
            return {
                **state,
                'iteration': iteration,
                'next_action': 'delegate',
                'current_plan': result['plan'],
                'events': events,
            }
        else:
            events.append(emit_event("responding", {}))
            return {
                **state,
                'iteration': iteration,
                'next_action': 'done',
                'final_response': result['final_response'] or "Analysis complete.",
                'events': events,
            }

    except Exception as e:
        events.append(emit_event("error", {"message": f"Supervisor Error: {e}"}))
        return {
            **state,
            'iteration': iteration,
            'next_action': 'done',
            'error': str(e),
            'final_response': f'I encountered an error planning the next step: {e}',
            'events': events,
        }

async def worker_node(state: AgentState) -> dict:
    """Worker Node (executor model): Translates plan into kubectl command."""
    events = list(state.get('events', []))
    plan = state.get('current_plan', 'Check failing pods and cluster events')

    last_cmd = state['command_history'][-1] if state['command_history'] else None
    last_cmd_str = f"{last_cmd['command']} (Output: {truncate_output(last_cmd.get('output',''), 500)})" if last_cmd else "None"

    recent_commands = [h['command'] for h in state['command_history'][-5:]] if state['command_history'] else []
    avoid_commands_str = "\n".join([f"  - {cmd}" for cmd in recent_commands]) if recent_commands else "None"

    prompt = WORKER_PROMPT.format(
        plan=plan,
        kube_context=state['kube_context'] or 'default',
        last_command_info=last_cmd_str,
        avoid_commands=avoid_commands_str,
    )

    try:
        executor_model = state.get('executor_model', 'k8s-cli')
        response = await call_llm(prompt, state['llm_endpoint'], executor_model, state.get('llm_provider', 'ollama'))
        parsed = parse_worker_response(response)
        command = parsed['command']
        thought = parsed['thought']

        events.append(emit_event("reflection", {"assessment": "EXECUTING", "reasoning": f"🔧 Executor Plan: {thought}"}))

        recent_commands_lower = [h['command'].strip().lower() for h in state['command_history'][-5:]] if state['command_history'] else []
        if command.strip().lower() in recent_commands_lower:
            events.append(emit_event("blocked", {"command": command, "reason": "loop_detected"}))
            return {
                **state,
                'next_action': 'supervisor',
                'command_history': state['command_history'] + [
                    {'command': command, 'output': '', 'error': f'LOOP DETECTED: Command "{command}" was already executed. You MUST try a different approach.'}
                ],
                'events': events,
            }

        events.append(emit_event("command_selected", {"command": command}))
        return {
            **state,
            'next_action': 'verify',
            'pending_command': command,
            'events': events,
        }
    except Exception as e:
        events.append(emit_event("error", {"message": f"Worker Error: {e}"}))
        return {
            **state,
            'next_action': 'supervisor',
            'command_history': state['command_history'] + [
                {'command': '(worker error)', 'output': '', 'error': str(e)}
            ],
            'events': events,
        }

async def verify_command_node(state: AgentState) -> dict:
    """Verification Node (70B): Checks the worker's command and safety."""
    events = list(state.get('events', []))
    command = state.get('pending_command', '')

    if not command:
        return {**state, 'next_action': 'execute'}

    is_safe, reason = is_safe_command(command)
    
    if not is_safe and reason == "MUTATING":
        events.append(emit_event("blocked", {"command": command, "reason": "mutating"}))
        return {
            **state,
            'next_action': 'supervisor',
            'command_history': state['command_history'] + [
                {'command': command, 'output': '', 'error': 'Blocked: Command contains dangerous verbs (delete, apply, etc.)'}
            ],
            'events': events,
        }
    
    if not is_safe and reason == "LARGE_OUTPUT":
        events.append(emit_event("awaiting_approval", {"command": command, "reason": "large_output"}))
        return {
            **state,
            'next_action': 'human_approval',
            'awaiting_approval': True,
            'events': events,
        }

    prompt = VERIFY_COMMAND_PROMPT.format(
        plan=state.get('current_plan', 'Unknown'),
        command=command
    )
    
    try:
        response = await call_llm(prompt, state['llm_endpoint'], state['llm_model'], state.get('llm_provider', 'ollama'))
        
        try:
            cleaned = clean_json_response(response)
            data = json.loads(cleaned)
            approved_syntax = data.get("approved", True)
            thought = data.get("thought", "")
            corrected = data.get("corrected_command", "")
        except Exception:
            approved_syntax = True
            thought = "Failed to parse verification, assuming safe."
            corrected = ""

        if approved_syntax:
            events.append(emit_event("reflection", {"assessment": "VERIFIED", "reasoning": "Command looks good."}))
            return {**state, 'next_action': 'execute'}
        else:
            new_command = corrected if corrected.strip() else command
            events.append(emit_event("reflection", {"assessment": "CORRECTED", "reasoning": f"Modifying command: {thought}"}))
            return {
                **state, 
                'next_action': 'execute',
                'pending_command': new_command
            }

    except Exception:
        # On verifier errors, just execute to avoid blocking
        return {**state, 'next_action': 'execute'}

async def human_approval_node(state: AgentState) -> dict:
    """Node that stalls execution until user approval is received."""
    if state.get('approved'):
        events = list(state.get('events', []))
        events.append(emit_event("progress", {"message": "Human approved execution. Resuming."}))
        return {
            **state,
            'next_action': 'execute',
            'awaiting_approval': False,
            'approved': False,
            'events': events,
        }
    
    return {**state, 'next_action': 'human_approval'}

async def reflect_node(state: AgentState) -> dict:
    """Reflect Node (70B): Assesses the result."""
    events = list(state.get('events', []))
    last_cmd = state['command_history'][-1]
    last_output = last_cmd.get('output', '') or last_cmd.get('error', '(no output)')

    prompt = REFLECT_PROMPT.format(
        query=state['query'],
        last_command=last_cmd['command'],
        result=truncate_output(last_output, 8000),
    )

    try:
        response = await call_llm(prompt, state['llm_endpoint'], state['llm_model'], state.get('llm_provider', 'ollama'))
        reflection = parse_reflection(response)

        assessment = "SOLVED" if reflection["found_solution"] else "ANALYZING"
        events.append(emit_event("reflection", {
            "assessment": assessment,
            "reasoning": reflection["thought"],
            "found_solution": reflection["found_solution"],
        }))

        updated_history = list(state['command_history'])
        
        feedback = reflection["thought"]
        if reflection["found_solution"]:
            feedback += f"\nSOLUTION FOUND: {reflection['final_response']}"
        else:
            feedback += f"\nHINT: {reflection['next_step_hint']}"

        updated_history[-1] = {
            **updated_history[-1],
            'assessment': "SOLVED" if reflection["found_solution"] else "ANALYZED",
            'useful': True,
            'reasoning': feedback,
        }
        
        return {
            **state,
            'next_action': 'supervisor',
            'command_history': updated_history,
            'reflection_reasoning': reflection["thought"],
            'events': events,
        }
    except Exception as e:
        events.append(emit_event("error", {"message": f"Reflection error: {e}"}))
        return {
            **state,
            'next_action': 'supervisor',
            'events': events,
        }

async def execute_node(state: AgentState) -> dict:
    """Execute a kubectl command."""
    command = state['pending_command']
    if not command:
        return {
            **state,
            'next_action': 'supervisor',
            'command_history': state['command_history'] + [
                {'command': '(none)', 'output': '', 'error': 'No command to execute'}
            ],
        }

    try:
        full_command = command
        if state['kube_context']:
            full_command = command.replace('kubectl ', f"kubectl --context={state['kube_context']} ", 1)
        
        print(f"[agent-sidecar] 🚀 NOTE: Executing command with context: {full_command}", flush=True)

        result = subprocess.run(
            full_command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=60,
        )

        output = result.stdout or result.stderr or '(no output)'
        error = result.stderr if result.returncode != 0 else None
        
        events = list(state.get('events', []))
        events.append(emit_event("command_output", {"command": command, "output": output, "error": error}))

        return {
            **state,
            'next_action': 'reflect',
            'command_history': state['command_history'] + [
                {'command': command, 'output': output, 'error': error}
            ],
            'pending_command': None,
            'events': events,
        }
    except subprocess.TimeoutExpired:
        return {
            **state,
            'next_action': 'reflect',
            'command_history': state['command_history'] + [
                {'command': command, 'output': '', 'error': 'Command timed out after 60 seconds'}
            ],
            'pending_command': None,
        }
    except Exception as e:
        return {
            **state,
            'next_action': 'reflect',
            'command_history': state['command_history'] + [
                {'command': command, 'output': '', 'error': str(e)}
            ],
            'pending_command': None,
        }

# =============================================================================
# GRAPH CONSTRUCTION
# =============================================================================

def should_continue(state: AgentState) -> Literal['worker', 'done']:
    """Determine next node based on supervisor decision."""
    if state['next_action'] == 'delegate':
        return 'worker'
    return 'done'

def handle_approval(state: AgentState) -> Literal['execute', 'human_approval']:
    """Conditional edge for the Human Approval Gate."""
    if state['next_action'] == 'human_approval':
        return 'human_approval'
    return 'execute'

def create_k8s_agent():
    """Create the LangGraph agent workflow."""
    workflow = StateGraph(AgentState)

    workflow.add_node('supervisor', supervisor_node)
    workflow.add_node('worker', worker_node)
    workflow.add_node('verify', verify_command_node)
    workflow.add_node('human_approval', human_approval_node)
    workflow.add_node('execute', execute_node)
    workflow.add_node('reflect', reflect_node)

    workflow.add_edge(START, 'supervisor')
    workflow.add_conditional_edges('supervisor', should_continue, {
        'worker': 'worker',
        'done': END,
    })

    workflow.add_edge('worker', 'verify')
    
    workflow.add_conditional_edges('verify', handle_approval, {
        'human_approval': 'human_approval',
        'execute': 'execute',
    })
    
    workflow.add_conditional_edges('human_approval', handle_approval, {
        'human_approval': 'human_approval',
        'execute': 'execute',
    })

    workflow.add_edge('execute', 'reflect')
    workflow.add_edge('reflect', 'supervisor')

    return workflow.compile()

# =============================================================================
# FASTAPI SERVER
# =============================================================================

agent = create_k8s_agent()

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
    approved_command: bool = False 

@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}

@app.post("/analyze")
async def analyze(request: AgentRequest):
    """Run the K8s troubleshooting agent with SSE streaming."""
    try:
        print(f"DEBUG REQUEST: {request.query} (Approved: {request.approved_command})", flush=True)
        
        cluster_info = "Not gathered yet"
        if not request.history:
            print("DEBUG: Gathering cluster info...", flush=True)
            cluster_info = await get_cluster_recon(request.kube_context)

        initial_state: AgentState = {
            "query": request.query,
            "kube_context": request.kube_context,
            "command_history": request.history or [],
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
        }

        async def event_generator():
            import time
            start_time = time.time()
            emitted_events_count = 0 # Track how many events have been emitted from the state's event list
            
            async for event in agent.astream_events(initial_state, version="v1"):
                kind = event["event"]
                
                # Handle chain steps (updates from nodes)
                if kind == "on_chain_end":
                    # Check if this is a specialized node update
                    if event['name'] in ['supervisor', 'worker', 'verify', 'human_approval', 'execute', 'reflect']:
                        node_update = event['data']['output']
                        
                        # Apply update to our local state copy for logging
                        if isinstance(node_update, dict):
                            # Simplistic merge for flat fields
                            initial_state.update(node_update)

                        if node_update.get('events'):
                            current_events = node_update['events']
                            # Only emit new events
                            if len(current_events) > emitted_events_count:
                                for new_evt in current_events[emitted_events_count:]:
                                    yield f"data: {json.dumps(new_evt)}\n\n"
                                emitted_events_count = len(current_events)
                                
                        if node_update.get('next_action') == 'human_approval' and node_update.get('awaiting_approval') is True:
                            yield f"data: {json.dumps(emit_event('approval_needed', {'command': node_update.get('pending_command')}))}\n\n"
                            return
            
            # Final response
            final_answer = initial_state.get('final_response')
            if not final_answer and initial_state.get('error'):
                 final_answer = f"Error: {initial_state['error']}"
            elif not final_answer:
                 # Fallback if loop ended without explicit final_response
                 final_answer = "Investigation complete (check command history)."

            # LOGGING
            duration = time.time() - start_time
            log_session(initial_state, duration, status="COMPLETED" if initial_state.get('final_response') else "FAILED")
            
            yield f"data: {json.dumps(emit_event('done', {'final_response': final_answer}))}\n\n"

        return StreamingResponse(event_generator(), media_type="text/event-stream")

    except Exception as e:
        print(f"CRITICAL ERROR in analyze endpoint: {e}", flush=True)
        # Try to log the failure if we have a request
        try:
             # Minimal state reconstruction for logging
             err_state: AgentState = {
                 "query": request.query,
                 "kube_context": request.kube_context,
                 "command_history": request.history or [],
                 "error": str(e),
                 "iteration": 0, "next_action": "done", "executor_model": "", "llm_model": "", "llm_provider": "", "llm_endpoint": "", "events": [], "awaiting_approval": False, "approved": False, "continue_path": False
             }
             log_session(err_state, 0.0, status="ERROR")
        except:
             pass

        return StreamingResponse(
            iter([f"data: {json.dumps(emit_event('error', {'message': f'Server Error: {str(e)}'}))}\n\n"]), 
            media_type="text/event-stream"
        )

if __name__ == "__main__":
    import uvicorn