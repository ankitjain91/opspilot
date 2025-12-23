"""
Lightweight KB/RAG system using embeddings for semantic search.

This module provides semantic search over the knowledge base using:
- Ollama embeddings API (nomic-embed-text)
- In-memory vector storage with cosine similarity
- Lazy loading and caching of embeddings
"""

import os
import json
import httpx
import asyncio
import subprocess
import time
import hashlib
from typing import List, Dict, Optional, Tuple
from pathlib import Path

from ..config import EMBEDDING_MODEL, CACHE_DIR, KB_DIR, KB_MAX_DOC_TOKENS
from ..discovery import list_crds

# Simple in-memory cache
# _kb_cache is now context-aware: {"default": [...], "context-name": [...]}
_kb_cache: Optional[Dict[str, List[Dict]]] = {}
_kb_cache_timestamps: Dict[str, float] = {}  # Track cache age per context
_embeddings_cache: Optional[Dict[str, List[float]]] = None
# Cache for keyword/BM25 index
_bm25_index = None
_bm25_corpus_tokens: Optional[List[List[str]]] = None
_bm25_entries: Optional[List[Dict]] = None
embedding_model_available = False # State tracker for UI checks

# CRD cache TTL in seconds (5 minutes)
CRD_CACHE_TTL = 300


def get_cached_crds(kube_context: str = 'default') -> Tuple[List, float]:
    """
    Get cached CRDs for a context if available.

    Returns:
        Tuple of (list of CRDInfo objects, cache_age_seconds)
        Returns ([], -1) if no cache exists.

    This is used by CR Health scan to reuse CRDs already fetched by KB preload,
    avoiding duplicate kubectl calls.
    """
    global _kb_cache, _kb_cache_timestamps
    from ..discovery import CRDInfo

    try:
        current_time = time.time()
        cache_age = current_time - _kb_cache_timestamps.get(kube_context, 0)

        # Debug: Log cache state
        cached_contexts = list(_kb_cache.keys())
        print(f"[KB] 🔍 get_cached_crds called for '{kube_context}', available contexts: {cached_contexts}", flush=True)

        # Check if we have cached entries for this context and it's not expired
        if kube_context in _kb_cache and cache_age < CRD_CACHE_TTL:
            # Extract CRD names from the cached KB entries
            # KB entries for CRDs have IDs like "live-crd-<crd-name>"
            cached_entries = _kb_cache[kube_context]
            crd_names = []
            for entry in cached_entries:
                entry_id = entry.get('id', '')
                if entry_id.startswith('live-crd-'):
                    # Extract CRD name from ID (e.g., "live-crd-postgresclusters.acid.zalan.do")
                    crd_name = entry_id[len('live-crd-'):]
                    if crd_name:
                        crd_names.append(crd_name)

            if crd_names:
                print(f"[KB] ♻️ Reusing {len(crd_names)} cached CRDs (age: {int(cache_age)}s)", flush=True)
                # Reconstruct CRDInfo objects from names
                crds = []
                for crd_name in crd_names:
                    parts = crd_name.split('.')
                    plural = parts[0] if parts else crd_name
                    group = '.'.join(parts[1:]) if len(parts) > 1 else ''
                    # Kind is typically the singular of plural
                    kind = entry.get('kind')
                    if not kind:
                         # Fallback heuristic
                         kind = plural.rstrip('s').title() if plural else crd_name

                    crds.append(CRDInfo(
                        name=crd_name,
                        group=group,
                        version=entry.get('version', 'v1'),
                        kind=kind
                    ))
                return crds, cache_age
            else:
                print(f"[KB] ⚠️ Cache exists but no live-crd- entries found (total entries: {len(cached_entries)})", flush=True)
        else:
            if kube_context not in _kb_cache:
                print(f"[KB] ℹ️ Context '{kube_context}' not in cache", flush=True)
            elif cache_age >= CRD_CACHE_TTL:
                print(f"[KB] ℹ️ Cache expired for '{kube_context}' (age: {int(cache_age)}s >= TTL: {CRD_CACHE_TTL}s)", flush=True)

        return [], -1
    except Exception as e:
        print(f"[KB] ⚠️ get_cached_crds failed: {e}", flush=True)
        return [], -1


def cosine_similarity(a: List[float], b: List[float]) -> float:
    """Compute cosine similarity between two vectors."""
    dot_product = sum(x * y for x, y in zip(a, b))
    mag_a = sum(x * x for x in a) ** 0.5
    mag_b = sum(x * x for x in b) ** 0.5

    if mag_a == 0 or mag_b == 0:
        return 0.0

    return dot_product / (mag_a * mag_b)


async def get_embedding(text: str, endpoint: str, model: str = "nomic-embed-text") -> Optional[List[float]]:
    """Get embedding vector from Ollama API."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{endpoint}/api/embeddings",
                json={"model": model, "prompt": text}
            )

            if response.status_code == 200:
                data = response.json()
                return data.get("embedding")
            else:
                print(f"[KB] Embedding API error: {response.status_code}", flush=True)
                return None

    except Exception as e:
        # Catch specific httpx/anyio errors that cause crashes
        error_msg = str(e)
        if "must be a non-empty sequence" in error_msg:
             # This is the specific anyio/httpx bug when dns fails or host unreachable
             print(f"[KB] Connection failed (likely DNS/Host issue): {e}", flush=True)
        else:
             import traceback
             full_trace = traceback.format_exc()
             print(f"[KB] Failed to get embedding: {e}\n{full_trace}", flush=True)
        return None


def entry_to_searchable_text(entry: Dict) -> str:
    """Convert KB entry to searchable text for embedding."""
    if not isinstance(entry, dict):
        return ""

    parts = []

    # ID and category
    if 'id' in entry:
        parts.append(str(entry['id']).replace('-', ' '))
    if 'category' in entry:
        parts.append(str(entry['category']))

    # Symptoms (most important for query matching)
    if 'symptoms' in entry and isinstance(entry['symptoms'], list):
        parts.extend([str(s) for s in entry['symptoms']])

    # Root cause
    if 'root_cause' in entry:
        parts.append(str(entry['root_cause']))

    # Investigation steps
    if 'investigation' in entry and isinstance(entry['investigation'], list):
        parts.extend([str(i) for i in entry['investigation'][:3]])  # First 3 investigation steps

    return ' | '.join(parts)


def load_kb_entries(kb_dir: str) -> List[Dict]:
    """Load all KB entries from JSONL files (static knowledge base)."""
    global _kb_cache

    # Static KB is stored under "default" key
    if "default" in _kb_cache:
        return _kb_cache["default"]

    entries = []
    kb_path = Path(kb_dir)

    if not kb_path.exists():
        print(f"[KB] Warning: KB directory not found: {kb_dir}", flush=True)
        _kb_cache["default"] = []
        return []

    # Load all .jsonl files
    for jsonl_file in kb_path.glob("*.jsonl"):
        try:
            with open(jsonl_file, 'r') as f:
                line_num = 0
                for line in f:
                    line_num += 1
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        entry = json.loads(line)
                        if isinstance(entry, dict):
                             entries.append(entry)
                        else:
                             print(f"[KB] Skipping non-dict entry in {jsonl_file.name}:{line_num}", flush=True)
                    except json.JSONDecodeError as e:
                        print(f"[KB] Invalid JSON in {jsonl_file.name}:{line_num}: {e}", flush=True)

        except Exception as e:
            print(f"[KB] Error loading {jsonl_file.name}: {e}", flush=True)

    # Load user-verified solutions (Adaptive Learning)
    solutions_dir = os.path.expanduser("~/.opspilot/knowledge/solutions")
    if os.path.exists(solutions_dir):
        for sol_file in Path(solutions_dir).glob("*.json"):
            try:
                with open(sol_file, 'r') as f:
                    sol = json.load(f)
                    entry = {
                        "id": f"solution-{sol.get('id', 'unknown')}",
                        "category": "UserVerifiedSolution",
                        "symptoms": [sol.get('query', '')],
                        "root_cause": f"✅ VERIFIED SOLUTION\n\n{sol.get('solution', '')}",
                        "investigation": [],
                        "fixes": [],
                        "description": f"User verified solution for query: {sol.get('query', '')}"
                    }
                    entries.append(entry)
            except Exception as e:
                print(f"[KB] Error loading solution {sol_file.name}: {e}", flush=True)

    print(f"[KB] Loaded {len(entries)} knowledge base entries (including user solutions)", flush=True)
    _kb_cache["default"] = entries
    return entries


# =============================================================================
# CRD INGESTION WITH CACHING & PARALLEL EXECUTION
# =============================================================================

# Cache directory for kubectl explain results
EXPLAIN_CACHE_DIR = os.path.join(CACHE_DIR, "crd_schemas")
EXPLAIN_CACHE_TTL = 86400  # 24 hours in seconds

# Persistent CRD Cache Directory
CRD_DISK_CACHE_DIR = os.path.join(CACHE_DIR, "crds_persistent")


def _get_crd_hash(kube_context: str) -> str:
    """
    Get a lightweight hash of the current CRDs in the cluster.
    Used to detect if we need to re-ingest without fetching full details.
    """
    try:
        cmd = ["kubectl"]
        if kube_context:
            cmd.extend(["--context", kube_context])
        # Fetch just names and versions - fast
        cmd.extend(["get", "crds", "--no-headers", "-o", "custom-columns=NAME:.metadata.name,VERSION:.spec.versions[0].name"])
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            # Hash the output string
            return hashlib.md5(result.stdout.encode()).hexdigest()
        return ""
    except Exception as e:
        print(f"[KB] Failed to compute CRD hash: {e}", flush=True)
        return ""

def _load_crd_disk_cache(kube_context: str) -> Tuple[List[Dict], str]:
    """Load CRDs from persistent disk cache. Returns (entries, hash)."""
    if not os.path.exists(CRD_DISK_CACHE_DIR):
        return [], ""
        
    cache_file = os.path.join(CRD_DISK_CACHE_DIR, f"{kube_context}.json")
    if not os.path.exists(cache_file):
        return [], ""
        
    try:
        with open(cache_file, 'r') as f:
            data = json.load(f)
            return data.get('entries', []), data.get('hash', "")
    except Exception as e:
        print(f"[KB] Failed to load disk cache: {e}", flush=True)
        return [], ""

def _save_crd_disk_cache(kube_context: str, entries: List[Dict], crd_hash: str):
    """Save CRDs to persistent disk cache."""
    if not os.path.exists(CRD_DISK_CACHE_DIR):
        os.makedirs(CRD_DISK_CACHE_DIR, exist_ok=True)
        
    cache_file = os.path.join(CRD_DISK_CACHE_DIR, f"{kube_context}.json")
    try:
        with open(cache_file, 'w') as f:
            json.dump({
                'hash': crd_hash,
                'entries': entries,
                'timestamp': time.time()
            }, f)
        print(f"[KB] 💾 Persisted {len(entries)} CRDs to disk for '{kube_context}'", flush=True)
    except Exception as e:
        print(f"[KB] Failed to save disk cache: {e}", flush=True)

def _get_cached_explain(crd_name: str) -> Optional[str]:
    """Get cached kubectl explain output if available and fresh."""
    if not os.path.exists(EXPLAIN_CACHE_DIR):
        os.makedirs(EXPLAIN_CACHE_DIR, exist_ok=True)
        return None

    # Use hash of CRD name as filename to handle special characters
    cache_key = hashlib.md5(crd_name.encode()).hexdigest()
    cache_file = os.path.join(EXPLAIN_CACHE_DIR, f"{cache_key}.txt")

    if not os.path.exists(cache_file):
        return None

    # Check if cache is stale (TTL expired)
    file_age = time.time() - os.path.getmtime(cache_file)
    if file_age > EXPLAIN_CACHE_TTL:
        return None

    try:
        with open(cache_file, 'r') as f:
            return f.read()
    except Exception:
        return None

def _cache_explain(crd_name: str, output: str):
    """Cache kubectl explain output."""
    if not os.path.exists(EXPLAIN_CACHE_DIR):
        os.makedirs(EXPLAIN_CACHE_DIR, exist_ok=True)

    cache_key = hashlib.md5(crd_name.encode()).hexdigest()
    cache_file = os.path.join(EXPLAIN_CACHE_DIR, f"{cache_key}.txt")

    try:
        with open(cache_file, 'w') as f:
            f.write(output)
    except Exception as e:
        print(f"[KB] Failed to cache explain for {crd_name}: {e}", flush=True)

async def _get_crd_schema(crd_name: str, semaphore: asyncio.Semaphore, context: Optional[str] = None) -> str:
    """Get CRD schema using kubectl explain with caching and concurrency control."""
    # Check cache first
    cached = _get_cached_explain(crd_name)
    if cached is not None:
        return cached

    # Acquire semaphore to limit concurrent kubectl calls
    async with semaphore:
        # Run kubectl explain asynchronously
        try:
            cmd = ["kubectl"]
            if context:
                cmd.extend(["--context", context])
            cmd.extend(["explain", crd_name, "--recursive=false"])
            
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=5.0)

            if proc.returncode == 0:
                output = stdout.decode('utf-8').strip()
                # Extract first 15 lines
                lines = output.split('\n')[:15]
                schema_info = '\n'.join(lines)

                # Cache the result
                _cache_explain(crd_name, schema_info)
                return schema_info
            else:
                return ""
        except asyncio.TimeoutError:
            print(f"[KB] kubectl explain {crd_name} timed out", flush=True)
            return ""
        except Exception as e:
            print(f"[KB] Failed to explain {crd_name}: {e}", flush=True)
            return ""

async def _ingest_crds_parallel(crd_list: List[str], context: Optional[str] = None, progress_callback=None) -> List[Dict]:
    """Ingest CRDs with basic info only (instant startup).

    Schema enrichment is skipped for fast startup to avoid kubectl explain timeouts.
    Agent works fine with basic CRD info.

    Args:
        crd_list: List of CRD names to ingest
        context: Kubernetes context name
        progress_callback: Optional async function(current, total, message) to report progress
    """
    if not crd_list:
        return []

    total = len(crd_list)
    print(f"[KB] ⚡ Ingesting {total} CRDs (fast mode - no schema enrichment)...", flush=True)

    if progress_callback:
        await progress_callback(0, total, f"Starting CRD ingestion for {total} resources...")

    # Build knowledge entries without kubectl explain (instant)
    entries = []
    for idx, item in enumerate(crd_list, 1):
        # Handle both list of strings and list of CRDInfo objects
        if hasattr(item, 'name'):
            crd = item.name
            real_kind = getattr(item, 'kind', None)
            real_version = getattr(item, 'version', None)
        else:
            crd = str(item)
            real_kind = None
            real_version = None

        name = crd.split('.')[0]
        group = '.'.join(crd.split('.')[1:])

        # Build comprehensive symptoms including provider/category detection
        symptoms = [
            f"list {name}",
            f"get {name}",
            f"find {name}",
            f"show {name}",
            f"status of {name}",
            f"debug {name}",
            f"investigate {name}",
            f"controller for {name}",
            f"operator for {name}",
            f"reconcile {name}",
            f"who manages {name}",
            f"what controls {name}",
            f"{name} controller",
            f"{name} operator"
        ]

        # Detect provider and add collective symptoms
        is_crossplane = any(kw in group for kw in ['upbound.io', 'crossplane.io', 'azure.upbound.io', 'aws.upbound.io', 'gcp.upbound.io'])
        is_azure = 'azure' in group.lower() or 'azure' in name.lower()
        is_aws = 'aws' in group.lower() or 'aws' in name.lower()
        is_gcp = 'gcp' in group.lower() or 'gcp' in name.lower()

        if is_crossplane:
            symptoms.extend([
                f"crossplane {name}",
                f"crossplane resources",
                f"managed resources",
                f"infrastructure resources",
                f"find crossplane resources",
                f"list crossplane resources"
            ])

        if is_azure:
            symptoms.extend([
                f"azure {name}",
                f"azure resources",
                f"managed azure resources",
                f"find azure resources",
                f"list azure resources",
                f"azure infrastructure"
            ])

        if is_aws:
            symptoms.extend([
                f"aws {name}",
                f"aws resources",
                f"managed aws resources",
                f"find aws resources"
            ])

        if is_gcp:
            symptoms.extend([
                f"gcp {name}",
                f"gcp resources",
                f"managed gcp resources",
                f"find gcp resources"
            ])

        entry = {
            "id": f"live-crd-{crd}",  # Use full CRD name (e.g., postgresclusters.acid.zalan.do) for proper group reconstruction
            "category": "LiveResource",
            "symptoms": symptoms,
            "root_cause": f"✅ KUBERNETES CUSTOM RESOURCE: '{name}' (API: {crd})\n\nThis is a standard Kubernetes resource that works with ALL kubectl commands:\n- kubectl get {name} -A (list all)\n- kubectl get {name} <name> -n <namespace> (get specific)\n- kubectl get {name} <name> -n <namespace> -o yaml (full details)\n- kubectl describe {name} <name> -n <namespace> (detailed status)\n- kubectl explain {name} (see schema)\n\n**FINDING THE CONTROLLER/OPERATOR**:\nCustom Resources are managed by controllers/operators. To find the controller:\n1. Check pods with labels: kubectl get pods -A -l 'app.kubernetes.io/name' -o wide | grep -i {name}\n2. Search by API group: kubectl get pods -A -o yaml | grep -i {group}\n3. Look for operator pods: kubectl get pods -A | grep -i '{name.rstrip('s')}'\n4. Common patterns: {name}-controller, {name}-operator, {group.split('.')[0]}-operator\n\n**BULK DISCOVERY** (when asked for 'all azure resources', 'all crossplane resources', etc.):\n- Use kubectl api-resources | grep -i azure to find ALL Azure resource types\n- Then iterate: for TYPE in $(kubectl api-resources | grep azure | awk '{{print $1}}'); do echo \"=== $TYPE ===\"; kubectl get $TYPE -A 2>/dev/null; done",
            "investigation": [
                f"kubectl get {name} -A -o wide",
                f"kubectl get {name} -A -o json | jq '.items[] | {{name: .metadata.name, namespace: .metadata.namespace, status: .status}}'",
                f"kubectl describe {name} -A",
                f"kubectl get pods -A | grep -i '{name.rstrip('s')}'  # Find controller pod",
                f"kubectl get pods -A -o yaml | grep -i '{group}'  # Search by API group",
                f"kubectl api-resources | grep -i {group.split('.')[0] if '.' in group else name}  # Find related resources"
            ],
            "fixes": [
                f"kubectl edit {name} <name> -n <namespace>",
                f"kubectl delete {name} <name> -n <namespace>",
                f"kubectl apply -f <yaml-file>"
            ],
            "description": f"🔧 Cluster Capability: {name} ({group}) - Custom Resource managed by a controller/operator. API Group: {group}. Use kubectl get {name} -A to list instances."
        }
        
        # Store metadata for cache reconstruction
        if real_kind:
            entry['kind'] = real_kind
        if real_version:
            entry['version'] = real_version

        entries.append(entry)

        # Report progress after each CRD
        if progress_callback:
            await progress_callback(idx, total, f"Ingested {name} ({idx}/{total})")

    print(f"[KB] ✅ Ingested {len(entries)} CRDs instantly", flush=True)

    # Final completion callback
    if progress_callback:
        await progress_callback(total, total, f"Completed: {total} CRDs ingested")

    return entries


async def ingest_cluster_knowledge(state: Dict, force_refresh: bool = False, progress_callback=None) -> List[Dict]:
    """
    LIVE RAG: Dynamically discover what's in the cluster and add to knowledge base.
    Fetches CRDs and ingests them as 'tools/capabilities' so the agent knows what it can do.

    Args:
        state: Agent state
        force_refresh: If True, bypass cache and re-fetch CRDs
        progress_callback: Optional async function(current, total, message) for progress reporting
    """
    global _kb_cache, _kb_cache_timestamps
    try:
        kube_context = state.get('kube_context', 'default')

        # Check cache age (TTL-based caching)
        current_time = time.time()
        cache_age = current_time - _kb_cache_timestamps.get(kube_context, 0)

        # Check if we already have dynamic knowledge in cache for this context
        if not force_refresh:
            # 1. OPTIMIZED: Check Persistent Disk Cache first (survives restarts)
            cached_entries, cached_hash = _load_crd_disk_cache(kube_context)
            
            if cached_entries:
                # 2. Smart Check: Is the cache still valid? 
                # We compute the current CRD hash (cheap) and compare with stored hash.
                print(f"[KB] 🕵️ Checking if CRD cache is stale for '{kube_context}'...", flush=True)
                current_hash = _get_crd_hash(kube_context)
                
                if current_hash and current_hash == cached_hash:
                     print(f"[KB] ✅ CRDs unchanged (hash match). Using persistent cache ({len(cached_entries)} entries).", flush=True)
                     # Hydrate in-memory cache
                     static_kb = load_kb_entries(state.get('kb_dir') or KB_DIR)
                     _kb_cache[kube_context] = static_kb + cached_entries
                     _kb_cache_timestamps[kube_context] = time.time()
                     return _kb_cache[kube_context]
                else:
                    print(f"[KB] ♻️ CRD change detected (hash mismatch). Refreshing...", flush=True)
            
            # 3. Fallback to in-memory TTL check if disk cache empty/stale
            elif kube_context in _kb_cache and cache_age < CRD_CACHE_TTL:
                print(f"[KB] ✅ Using in-memory cached CRDs for context '{kube_context}' (age: {int(cache_age)}s, TTL: {CRD_CACHE_TTL}s)", flush=True)
                return _kb_cache[kube_context]

        if cache_age >= CRD_CACHE_TTL:
            print(f"[KB] ⏰ CRD cache expired (age: {int(cache_age)}s), refreshing...", flush=True)

        print(f"[KB] 🧠 Ingesting live cluster knowledge (CRDs) for context '{kube_context}'...", flush=True)
        
        # We need to run kubectl. We can't use the state's SafeExecutor directly because of async context,
        # so we'll use a subprocess call here or try to reuse the mechanism if possible.
        # For simplicity/safety, we'll shell out to kubectl directly using safe wrapper conventions.
        import subprocess
        
        # Get current context from state if available for correct routing
        # But for discovery, we usually want to know what's in the *connected* cluster
        kube_context = state.get('kube_context')
        
        # Use centralized discovery module
        # Use centralized discovery module
        print(f"[KB] 🔍 Fetching CRDs using discovery module...", flush=True)
        found_crds = list_crds(kube_context)
        # Pass full objects to preserve Kind/Version info, but keep list of names for bulk patterns
        crd_list = [c.name for c in found_crds]
        
        # Fast basic ingestion (no kubectl explain - instant startup)
        # Parallel kubectl explain execution with caching
        live_entries = await _ingest_crds_parallel(found_crds, context=kube_context, progress_callback=progress_callback)

        # Add meta-entries for bulk discovery patterns
        azure_crds = [c for c in crd_list if 'azure' in c.lower()]
        aws_crds = [c for c in crd_list if 'aws' in c.lower()]
        gcp_crds = [c for c in crd_list if 'gcp' in c.lower()]
        crossplane_crds = [c for c in crd_list if any(kw in c for kw in ['upbound.io', 'crossplane.io'])]

        if azure_crds:
            azure_types_list = ', '.join([c.split('.')[0] for c in azure_crds[:15]])
            if len(azure_crds) > 15:
                azure_types_list += '...'

            method2_queries = '\n'.join([f'kubectl get {c.split(".")[0]} -A' for c in azure_crds[:10]])

            live_entries.append({
                "id": "meta-azure-bulk-discovery",
                "category": "BulkDiscovery",
                "symptoms": [
                    "find all azure resources",
                    "list all azure resources",
                    "show azure resources",
                    "managed azure resources",
                    "crossplane azure resources",
                    "all azure managed resources",
                    "what azure resources exist"
                ],
                "root_cause": f"✅ BULK AZURE RESOURCE DISCOVERY\n\nFound {len(azure_crds)} Azure CRD types in cluster. To list ALL Azure managed resources:\n\n**METHOD 1: Shell loop (recommended)**\n```bash\nfor TYPE in $(kubectl api-resources | grep -i azure | awk '{{print $1}}'); do\n  echo \"=== $TYPE ===\"\n  kubectl get $TYPE -A 2>/dev/null | grep -v '^No resources'\ndone\n```\n\n**METHOD 2: Individual queries**\n{method2_queries}\n\nAvailable Azure types: {azure_types_list}",
                "investigation": [
                    "kubectl api-resources | grep -i azure",
                    "for TYPE in $(kubectl api-resources | grep -i azure | awk '{print $1}'); do echo \"=== $TYPE ===\"; kubectl get $TYPE -A 2>/dev/null; done"
                ],
                "fixes": [],
                "description": f"Bulk discovery pattern for {len(azure_crds)} Azure managed resources"
            })

        if crossplane_crds:
            live_entries.append({
                "id": "meta-crossplane-bulk-discovery",
                "category": "BulkDiscovery",
                "symptoms": [
                    "find all crossplane resources",
                    "list all crossplane resources",
                    "show crossplane resources",
                    "managed crossplane resources",
                    "all crossplane managed resources",
                    "what crossplane resources exist"
                ],
                "root_cause": f"✅ BULK CROSSPLANE RESOURCE DISCOVERY\n\nFound {len(crossplane_crds)} Crossplane CRD types. Use kubectl get managed -A OR iterate through specific types.",
                "investigation": [
                    "kubectl get managed -A",
                    "kubectl get composite -A",
                    "kubectl get claim -A"
                ],
                "fixes": [],
                "description": f"Bulk discovery pattern for {len(crossplane_crds)} Crossplane managed resources"
            })

        # --- CROSSPLANE INTEGRATION ---
        print("[KB] 🧠 Ingesting Crossplane Infrastructure Definitions (XRDs)...", flush=True)
        cmd_xrd = ["kubectl"]
        if kube_context:
            cmd_xrd.extend(["--context", kube_context])
        cmd_xrd.extend(["get", "xrd", "--no-headers", "-o", "custom-columns=NAME:.metadata.name"])
        
        try:
            result_xrd = subprocess.run(cmd_xrd, capture_output=True, text=True, timeout=10)
            if result_xrd.returncode == 0:
                xrd_list = result_xrd.stdout.strip().split('\n')
                xrd_list = [x.strip() for x in xrd_list if x.strip()]
                
                for xrd in xrd_list:
                    # XRD name e.g. "postgresqlinstances.database.example.org"
                    # The "claim" name is usually the plural of the kind
                    name = xrd.split('.')[0] 
                    group = '.'.join(xrd.split('.')[1:])
                    
                    entry = {
                        "id": f"live-xrd-{name}",
                        "category": "InfrastructureDefinition",
                        "symptoms": [f"I want to create {name}", f"Provision {name}", f"Need a {name}"],
                        "root_cause": f"Crossplane XRD available: {xrd}",
                        "investigation": [
                            f"kubectl get {name} -A",
                            f"kubectl describe {name} <name>",
                            f"kubectl get xrd {xrd} -o yaml"
                        ],
                        "fixes": [
                            f"Create a Claim for {name}", 
                            f"Check Crossplane Sync status: kubectl get {name}",
                            f"Check Composition health"
                        ],
                        "description": f"Available Infrastructure: You can provision {name} ({group}) using Crossplane."
                    }
                    live_entries.append(entry)
                print(f"[KB] ✅ Ingested {len(xrd_list)} Crossplane XRDs.", flush=True)
        except FileNotFoundError:
            print("[KB] kubectl not found, skipping XRD ingestion", flush=True)
        except Exception as e:
            # Crossplane might not be installed, which is fine
            print(f"[KB] Crossplane XRD discovery skipped (not installed?): {e}", flush=True)

        print(f"[KB] ✅ Ingested total {len(live_entries)} live resources into Brain.", flush=True)

        # Load static KB if not already loaded
        if "default" not in _kb_cache:
            kb_dir = state.get('kb_dir') or os.environ.get('K8S_AGENT_KB_DIR') or KB_DIR
            load_kb_entries(kb_dir) # Load static first

        # Store context-specific cache (static KB + live CRDs for this context)
        static_kb = _kb_cache.get("default", [])
        _kb_cache[kube_context] = static_kb + live_entries

        # Update cache timestamp
        _kb_cache_timestamps[kube_context] = time.time()
        
        # 4. Save to Persistent Disk Cache
        # Calculate hash for future checks
        crd_hash = _get_crd_hash(kube_context) 
        _save_crd_disk_cache(kube_context, live_entries, crd_hash)
        
        print(f"[KB] 💾 Cached {len(_kb_cache[kube_context])} entries for context '{kube_context}' (TTL: {CRD_CACHE_TTL}s)", flush=True)

        # Invalidate embedding cache for these new entries (they will be computed on demand)
        # We don't need to do anything as _embeddings_cache uses IDs, and these are new IDs.

        return _kb_cache[kube_context]
        
    except Exception as e:
        print(f"[KB] Live ingestion failed: {e}", flush=True)
        return _kb_cache or []



def entry_to_searchable_text(entry: Dict) -> str:
    """Convert KB entry to searchable text for embedding."""
    parts = []

    # ID and category
    if 'id' in entry:
        parts.append(entry['id'].replace('-', ' '))
    if 'category' in entry:
        parts.append(entry['category'])

    # Symptoms (most important for query matching)
    if 'symptoms' in entry and isinstance(entry['symptoms'], list):
        parts.extend(entry['symptoms'])

    # Root cause
    if 'root_cause' in entry:
        parts.append(entry['root_cause'])

    # Investigation steps
    if 'investigation' in entry and isinstance(entry['investigation'], list):
        parts.extend(entry['investigation'][:3])  # First 3 investigation steps

    return ' | '.join(parts)


async def get_relevant_kb_snippets(
    query: str,
    state: Dict,
    max_results: int = None,  # Uses KB_MAX_MATCHES from config
    min_similarity: float = None  # Uses KB_MIN_SIMILARITY from config
) -> str:
    """
    Semantic search over KB to find relevant troubleshooting patterns.

    Uses query expansion, semantic caching, and query coalescing for performance.

    Args:
        query: User's query
        state: Agent state (contains llm_endpoint)
        max_results: Maximum number of results to return
        min_similarity: Minimum cosine similarity threshold

    Returns:
        Formatted string with relevant KB snippets
    """
    global _embeddings_cache

    # Import query cache for performance optimization
    from .query_cache import get_query_cache, get_query_coalescer

    # Get config from state - check explicit state override first, then fall back to config global
    from ..config import EMBEDDING_ENDPOINT as GLOBAL_EMBEDDING_ENDPOINT, KB_MAX_MATCHES, KB_MIN_SIMILARITY

    # Apply config defaults if not specified
    if max_results is None:
        max_results = KB_MAX_MATCHES
    if min_similarity is None:
        min_similarity = KB_MIN_SIMILARITY

    # Priority: State override > Config Global (which handles cloud logic) > Default
    llm_endpoint = state.get('embedding_endpoint') or GLOBAL_EMBEDDING_ENDPOINT or 'http://localhost:11434'
    kb_dir = state.get('kb_dir', os.environ.get('K8S_AGENT_KB_DIR', '/Users/ankitjain/lens-killer/knowledge'))
    embedding_model = state.get('embedding_model', os.environ.get('K8S_AGENT_EMBED_MODEL', 'nomic-embed-text'))

    # Check query cache first (5x faster for repeated queries)
    cache = get_query_cache()
    cached = cache.get(query)
    if cached is not None:
        results, _ = cached
        print(f"[KB] Cache HIT for query: '{query[:50]}...' (stats: {cache.get_stats()['hit_rate_percent']}% hit rate)", flush=True)
        return results

    # Load KB entries
    entries = load_kb_entries(kb_dir)
    if not entries:
        return ""

    # Use query coalescer to prevent duplicate in-flight computations
    coalescer = get_query_coalescer()

    async def compute_kb_results(q: str) -> str:
        return await _compute_kb_search(q, entries, llm_endpoint, embedding_model, max_results, min_similarity)

    # Execute with coalescing (deduplicates concurrent identical queries)
    result = await coalescer.execute(query, compute_kb_results)

    # Cache the result with embedding for semantic matching
    async def get_query_embedding(q: str):
        return await get_embedding(q, llm_endpoint, embedding_model)

    embedding = await get_query_embedding(query)
    cache.set(query, result, embedding)

    return result


async def _compute_kb_search(
    query: str,
    entries: List[Dict],
    llm_endpoint: str,
    embedding_model: str,
    max_results: int = 5,
    min_similarity: float = 0.35
) -> str:
    """
    Internal function to compute KB search results.
    Separated from get_relevant_kb_snippets for caching.
    """
    global _embeddings_cache

    # QUERY EXPANSION: Generate query variants with synonyms
    from ..heuristics import expand_query
    query_variants = expand_query(query)

    if len(query_variants) > 1:
        print(f"[KB] Query expansion: '{query}' → {len(query_variants)} variants", flush=True)

    # Get embeddings for all query variants
    query_embeddings = []
    for variant in query_variants:
        embedding = await get_embedding(variant, llm_endpoint, embedding_model)
        if embedding:
            query_embeddings.append(embedding)

    if not query_embeddings:
        print(f"[KB] Failed to generate query embeddings, skipping KB search", flush=True)
        return ""

    # Compute or retrieve embeddings for all entries
    if _embeddings_cache is None:
        _embeddings_cache = {}

    # Build/refresh BM25 index lazily for keyword-based scoring
    # We use a light tokenizer (split on non-word) to capture K8s jargon, error codes, names
    # Build/refresh BM25 index lazily for keyword-based scoring
    # We use a light tokenizer (split on non-word) to capture K8s jargon, error codes, names
    global _bm25_index, _bm25_corpus_tokens, _bm25_entries
    
    # Simple Pure-Python Token Overlap Score (Replaces heavy rank_bm25+numpy)
    if _bm25_corpus_tokens is None or _bm25_entries is None or len(_bm25_entries) != len(entries):
        _bm25_entries = entries
        _bm25_corpus_tokens = []
        import re
        for e in entries:
            text = entry_to_searchable_text(e)
            tokens = set(t.lower() for t in re.split(r"[^A-Za-z0-9_.-]+", text) if t)
            _bm25_corpus_tokens.append(tokens)

    # Tokenize query
    import re as _re
    query_tokens = set(t.lower() for t in _re.split(r"[^A-Za-z0-9_.-]+", query) if t)
    
    # Calculate simple Jaccard-like overlap and scale to emulate BM25
    bm25_scores = []
    for doc_tokens in _bm25_corpus_tokens:
        if not doc_tokens or not query_tokens:
            bm25_scores.append(0.0)
            continue
        # Intersection count
        overlap = len(doc_tokens.intersection(query_tokens))
        # Simple score: overlap count + bonus for exact subset
        score = float(overlap)
        if overlap > 0:
             # Boost closer matches
             score += 0.5 * (overlap / len(query_tokens))
        bm25_scores.append(score)

    results: List[Tuple[float, Dict]] = []

    # Precompute normalization for BM25
    max_bm25 = max(bm25_scores) if len(bm25_scores) > 0 else 1.0

    for idx, entry in enumerate(entries):
        entry_id = entry.get('id', '')

        # Check cache
        if entry_id in _embeddings_cache:
            entry_embedding = _embeddings_cache[entry_id]
        else:
            # Generate and cache
            searchable_text = entry_to_searchable_text(entry)
            entry_embedding = await get_embedding(searchable_text, llm_endpoint, embedding_model)

            if entry_embedding:
                _embeddings_cache[entry_id] = entry_embedding
            else:
                continue

        # Compute semantic similarity against ALL query variants (use max similarity)
        max_similarity = 0.0
        for query_emb in query_embeddings:
            sim = cosine_similarity(query_emb, entry_embedding)
            max_similarity = max(max_similarity, sim)

        similarity = max_similarity

        # Hybrid fusion: combine semantic similarity with BM25 keyword score
        # Normalize BM25 by max to [0,1] to combine fairly
        bm_score = 0.0
        if len(bm25_scores) > 0:
            bm_score = bm25_scores[idx] / max_bm25 if max_bm25 > 0 else 0.0

        # Fusion score: weighted sum prioritizing semantic while ensuring keyword hits boost
        fusion = (0.7 * similarity) + (0.3 * bm_score)

        if similarity >= min_similarity or bm_score > 0.6:
            results.append((fusion, entry))
        

    # Sort by fusion score (descending)
    results.sort(key=lambda x: x[0], reverse=True)

    # Take top N
    top_results = results[:max_results]

    if not top_results:
        return ""

    # Token optimization: Truncate long documents to save tokens
    def truncate_text(text: str, max_chars: int = KB_MAX_DOC_TOKENS * 4) -> str:
        """Truncate text to approximate token limit (assuming ~4 chars per token)."""
        if not text or len(text) <= max_chars:
            return text
        # Keep first portion and indicate truncation
        return text[:max_chars] + "..."

    # Format as context string with truncation
    context_parts = ["## Relevant Knowledge Base Patterns\n"]

    for fusion_score, entry in top_results:
        context_parts.append(f"### {entry.get('id', 'Unknown')} (relevance: {fusion_score:.2f})")
        context_parts.append(f"**Category:** {entry.get('category', 'N/A')}")

        if 'symptoms' in entry:
            symptoms = entry['symptoms']
            if isinstance(symptoms, list):
                # Limit symptoms to save tokens
                context_parts.append(f"**Symptoms:** {', '.join(symptoms[:3])}")

        if 'root_cause' in entry:
            # Truncate long root causes
            root_cause = truncate_text(str(entry['root_cause']))
            context_parts.append(f"**Cause:** {root_cause}")

        if 'investigation' in entry:
            investigation = entry['investigation']
            if isinstance(investigation, list) and investigation:
                # Only show first investigation step, truncated
                context_parts.append(f"**Investigation:** {truncate_text(str(investigation[0]), 500)}")

        if 'fixes' in entry:
            fixes = entry['fixes']
            if isinstance(fixes, list) and fixes:
                context_parts.append(f"**Fix:** {truncate_text(str(fixes[0]), 300)}")

        context_parts.append("")  # Blank line

    result = "\n".join(context_parts)

    print(f"[KB] Found {len(top_results)} relevant patterns (top fusion: {top_results[0][0]:.2f})", flush=True)

    return result



async def check_embedding_model_available(endpoint: str, model_name: str | None = None) -> bool:
    """Check if the embedding model is pulled and available."""
    global embedding_model_available
    
    target_model = model_name or EMBEDDING_MODEL
    # Strip tag for looser matching if specific version not found
    base_name = target_model.split(':')[0]
    
    clean_endpoint = endpoint.rstrip('/').removesuffix('/v1').rstrip('/')
    url = f"{clean_endpoint}/api/tags"

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                models = resp.json().get("models", [])
                # Check for exact match or base name match
                for m in models:
                    name = m.get("name", "")
                    if name == target_model or name == base_name or name.startswith(base_name + ":"):
                        embedding_model_available = True
                        return True
    except Exception as e:
        print(f"[KB] Failed to check model status: {e}", flush=True)

    embedding_model_available = False
    return False

def get_kb_cache_path() -> str:
    """Get path to the KB embeddings cache file."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, "kb_embeddings.json")

def find_precomputed_embeddings() -> Optional[str]:
    """Look for bundled pre-computed embeddings."""
    # Check regular cache first
    cache_path = get_kb_cache_path()
    if os.path.isfile(cache_path):
        return cache_path
        
    # Check bundled (e.g. in dist/ or alongside script)
    candidates = [
        os.path.join(os.path.dirname(__file__), "..", "kb_embeddings.json"),
        os.path.join(os.getcwd(), "kb_embeddings.json"),
    ]
    for p in candidates:
        if os.path.isfile(p):
            return p
    return None

async def generate_kb_embeddings_generator(endpoint: str, model_name: str | None = None):
    """Generator that yields SSE events while generating embeddings."""
    try:
        model = model_name or EMBEDDING_MODEL

        # Clear KB cache to force reload from disk (user is explicitly regenerating)
        clear_cache()

        entries = load_kb_entries(KB_DIR)

        if not entries:
            yield f"data: {json.dumps({'status': 'error', 'message': f'No KB entries found in {KB_DIR}. Ensure .jsonl files exist in the knowledge directory.'})}\n\n"
            return

        total = len(entries)
        processed = 0
        embeddings_map = {}
        
        yield f"data: {json.dumps({'status': 'starting', 'total': total, 'message': 'Starting embedding generation...'})}\n\n"

        for i, entry in enumerate(entries):
            entry_id = entry.get('id', str(i))
            text = entry_to_searchable_text(entry)
            
            # rate limit / yield control
            if i % 5 == 0:
                await asyncio.sleep(0.01)

            emb = await get_embedding(text, endpoint, model)
            if emb:
                embeddings_map[entry_id] = emb
                processed += 1
            
            # Emit progress every 10% or at least every 5 items
            if i % 5 == 0 or i == total - 1:
                percent = round((i + 1) / total * 100, 1)
                yield f"data: {json.dumps({'status': 'processing', 'completed': i + 1, 'total': total, 'percent': percent})}\n\n"

        # Save to cache
        cache_path = get_kb_cache_path()
        output_data = {
            "generated_at": str(asyncio.get_running_loop().time()),
            "model": model,
            "documents": entries, # Save the docs to avoid re-parsing
            "embeddings": embeddings_map # Save the map
        }
        
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(output_data, f)
            
        yield f"data: {json.dumps({'status': 'success', 'message': f'Generated {processed} embeddings', 'path': cache_path})}\n\n"
        
        # Update in-memory cache
        # Update in-memory cache
        global _kb_cache, _embeddings_cache
        if _kb_cache is None:
            _kb_cache = {}
        _kb_cache["default"] = entries
        _embeddings_cache = embeddings_map

    except Exception as e:
        import traceback
        trace = traceback.format_exc()
        print(f"[KB] Generation failed: {trace}", flush=True)
        yield f"data: {json.dumps({'status': 'error', 'message': str(e)})}\n\n"

def clear_cache():
    """Clear KB and embeddings cache (useful for testing)."""
    global _kb_cache, _embeddings_cache
    _kb_cache = {}
    _embeddings_cache = None
    print("[KB] Cache cleared", flush=True)
