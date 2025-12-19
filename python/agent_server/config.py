
import os
from datetime import datetime, timezone
from typing import TypedDict, Literal, List, Dict, Optional, Any

# Prompts removed from config to avoid circular imports / legacy usage
from .prompts_examples import SUPERVISOR_EXAMPLES_FULL

# =============================================================================
# CONFIGURATION
# =============================================================================

# Dangerous write-verbs for kubectl (Strictly Blocked by default)
# Dangerous write-verbs for kubectl (Strictly Blocked by default)
DANGEROUS_VERBS = [
    'apply', 'edit', 'replace',
    'create', 'cordon', 'drain', 'taint', 'annotate',
    'label', 'cp'
]

# Remediation verbs (Allowed with explicit tool usage + Human Approval)
REMEDIATION_VERBS = [
    'delete', 'rollout', 'scale', 'set'
]

# Azure CLI mutation verbs (ALWAYS BLOCKED - only read operations allowed)
AZURE_MUTATION_VERBS = [
    'create', 'delete', 'update', 'set', 'add', 'remove',
    'attach', 'detach', 'deploy', 'provision', 'deallocate',
    'start', 'stop', 'restart', 'reset', 'purge', 'revoke',
    'grant', 'assign', 'lock', 'unlock', 'move', 'invoke',
    'register', 'unregister', 'approve', 'reject', 'cancel',
    'failover', 'restore', 'upgrade', 'scale', 'reimage'
]

# Azure CLI read-only commands (SAFE - allowed for Crossplane resource inspection)
AZURE_SAFE_COMMANDS = [
    'az account show', 'az account list', 'az account get-access-token',
    'az group show', 'az group list', 'az group exists',
    'az resource show', 'az resource list',
    'az network vnet show', 'az network vnet list', 'az network vnet subnet show', 'az network vnet subnet list',
    'az network nsg show', 'az network nsg list', 'az network nsg rule show', 'az network nsg rule list',
    'az network public-ip show', 'az network public-ip list',
    'az network lb show', 'az network lb list', 'az network lb address-pool show',
    'az network application-gateway show', 'az network application-gateway list',
    'az network private-endpoint show', 'az network private-endpoint list',
    'az storage account show', 'az storage account list', 'az storage account keys list',
    'az storage container show', 'az storage container list',
    'az storage blob show', 'az storage blob list',
    'az keyvault show', 'az keyvault list', 'az keyvault secret show', 'az keyvault secret list',
    'az keyvault key show', 'az keyvault key list',
    'az cosmosdb show', 'az cosmosdb list', 'az cosmosdb database show', 'az cosmosdb database list',
    'az aks show', 'az aks list', 'az aks get-credentials',
    'az aks nodepool show', 'az aks nodepool list',
    'az vm show', 'az vm list', 'az vm get-instance-view',
    'az vmss show', 'az vmss list', 'az vmss list-instances',
    'az disk show', 'az disk list',
    'az snapshot show', 'az snapshot list',
    'az identity show', 'az identity list',
    'az role assignment list', 'az role definition list',
    'az policy assignment list', 'az policy state list',
    'az monitor metrics list', 'az monitor activity-log list',
    'az acr show', 'az acr list', 'az acr repository list', 'az acr repository show-tags',
    'az servicebus namespace show', 'az servicebus namespace list',
    'az servicebus queue show', 'az servicebus queue list',
]

# Commands that are SAFE but return large, complex output and require approval
# Note: Removed 'get events' and 'events -A' - these are safe read-only queries for troubleshooting
LARGE_OUTPUT_VERBS = [
    'get all', 'top', 'logs -f', 'get --watch'
]

MAX_ITERATIONS = 20  # Safety limit only - LLM decides when to stop, not hardcoded iteration limits
MAX_OUTPUT_LENGTH = 8000

# ---- Embeddings RAG config ----
def _find_kb_dir() -> str:
    """Find the knowledge directory in various possible locations.

    Priority:
    1. K8S_AGENT_KB_DIR environment variable (set by Tauri for bundled app)
    2. Development locations (relative to source)
    3. User home directory fallback (~/.opspilot/knowledge)
    """
    env_dir = os.environ.get("K8S_AGENT_KB_DIR")
    if env_dir and os.path.isdir(env_dir):
        print(f"[KB] Using KB from env var: {env_dir}", flush=True)
        return env_dir

    # Try multiple locations relative to script or CWD (development mode)
    candidates = [
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "knowledge")), # /python/../knowledge
        os.path.abspath(os.path.join(os.getcwd(), "knowledge")), # cwd/knowledge
        os.path.abspath(os.path.join(os.getcwd(), "..", "knowledge")), # If cwd is src-tauri, go up one level
    ]

    for path in candidates:
        if os.path.isdir(path):
            print(f"[KB] Found knowledge directory: {path}", flush=True)
            return path

    # Fallback to user home directory (will be empty but won't crash)
    fallback = os.path.join(os.path.expanduser("~"), ".opspilot", "knowledge")
    print(f"[KB] ⚠️ No bundled KB found, using fallback: {fallback}", flush=True)
    return fallback

KB_DIR = _find_kb_dir()
EMBEDDING_MODEL = os.environ.get("K8S_AGENT_EMBED_MODEL", "nomic-embed-text")

# Auto-detect if using Cloud LLM (Groq/OpenAI) and fallback to local Ollama for embeddings
_llm_endpoint = os.environ.get("LLM_HOST", "http://localhost:11434")
_is_cloud_llm = any(domain in _llm_endpoint for domain in ["groq.com", "openai.com", "anthropic.com"])

# If explicitly set, use it. If not set, use llm_endpoint UNLESS it's a cloud provider, then default to localhost
if os.environ.get("K8S_AGENT_EMBED_ENDPOINT"):
    EMBEDDING_ENDPOINT = os.environ.get("K8S_AGENT_EMBED_ENDPOINT")
elif _is_cloud_llm:
    print(f"[config] ☁️ Cloud LLM detected ({_llm_endpoint}). Forcing embeddings to local Ollama.", flush=True)
    EMBEDDING_ENDPOINT = "http://localhost:11434"
else:
    EMBEDDING_ENDPOINT = _llm_endpoint

KB_MAX_MATCHES = 5
KB_MIN_SIMILARITY = 0.35
USE_CHROMADB = os.environ.get("USE_CHROMADB", "true").lower() == "true"
CHROMADB_PERSIST_DIR = os.environ.get("CHROMADB_PERSIST_DIR", "./chroma_db")

# ---- Query Routing Config ----
# ---- Query Routing Config ----
ROUTING_ENABLED = False # Enforce Brain model for all queries
CONFIDENCE_THRESHOLD = float(os.environ.get("CONFIDENCE_THRESHOLD", "0.7"))

# ---- Logging Config ----
# Use user home directory for logs/cache to ensure writability in release builds
_home = os.path.expanduser("~")
_base_dir = os.path.join(_home, ".opspilot")

LOG_DIR = os.environ.get("K8S_AGENT_LOG_DIR", os.path.join(_base_dir, "logs"))
LOG_FILE = "agent_history.jsonl"
CACHE_DIR = os.environ.get("K8S_AGENT_CACHE_DIR", os.path.join(_base_dir, "cache"))
# Note: KB_DIR is already set above by _find_kb_dir() which respects K8S_AGENT_KB_DIR env var

# ---- Typo Corrections ----
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
    "nd": "find",
    "kubctl": "kubectl", "kubetcl": "kubectl", "kubeclt": "kubectl", "kuectl": "kubectl",
    "proviosned": "provisioned", "provisoined": "provisioned", "provisoned": "provisioned",
    "resouces": "resources", "resoruces": "resources", "resourcs": "resources",
    "clsuter": "cluster", "clusetr": "cluster", "culster": "cluster",
    "endpionts": "endpoints", "endpoitns": "endpoints", "edpoints": "endpoints",
    "conatiners": "containers", "containres": "containers", "contianers": "containers",
}
