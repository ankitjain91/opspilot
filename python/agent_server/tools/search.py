
import os
import json
import math
import asyncio
import httpx
try:
    import chromadb
except ImportError:
    chromadb = None

from ..config import (
    EMBEDDING_MODEL, EMBEDDING_ENDPOINT, KB_DIR, 
    KB_MAX_MATCHES, KB_MIN_SIMILARITY, USE_CHROMADB
)
from ..state import AgentState

# Global state for KB/RAG
kb_lock = asyncio.Lock()
embedding_model_available = None
kb_loaded = False
kb_entries = []
kb_embeddings = []
chroma_client = None
chroma_collection = None

def kb_entry_to_text(entry: dict) -> str:
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

async def check_embedding_model_available(endpoint: str, model_name: str = None) -> bool:
    """Check if the embedding model is available.
    
    If it's an Ollama model (nomic, mxbai, etc.), check /api/tags on localhost.
    If it's a Cloud model (text-embedding-3...), assume available (hard to check via tags).
    """
    global embedding_model_available
    
    target_model = model_name or EMBEDDING_MODEL
    
    # Heuristic: Known local models
    is_local_model = any(x in target_model.lower() for x in ['nomic', 'mxbai', 'minilm', 'llama', 'mistral', 'gemma', 'phi'])
    
    # Heuristic: Known cloud models
    is_cloud_model = 'text-embedding' in target_model.lower() or 'davinci' in target_model.lower()

    # Determine effective endpoint
    
    # Heuristic: If it's a local model but endpoint is Cloud, fallback to localhost.
    # But if user provided a specific endpoint (that isn't cloud brain), respect it.
    is_brain_endpoint = any(x in (endpoint or '').lower() for x in ['api.groq', 'api.openai', 'api.anthropic'])
    
    if is_local_model:
        if is_brain_endpoint or not endpoint:
            clean_endpoint = "http://localhost:11434"
        else:
            clean_endpoint = endpoint.rstrip('/').removesuffix('/v1').rstrip('/')
    elif is_cloud_model:
        # We can't use /api/tags for OpenAI. Assume true for now or skip check.
        # This function is primarily for "Do we need to download this local model?"
        print(f"[KB] Assuming cloud embedding model '{target_model}' is available", flush=True)
        embedding_model_available = True
        return True
    else:
        # Fallback: maintain existing behavior
        base = endpoint or ""
        clean_endpoint = base.rstrip('/').removesuffix('/v1').rstrip('/') if base else "http://localhost:11434"

    async with httpx.AsyncClient() as client:
        try:
            print(f"[KB] Checking models at: {clean_endpoint}/api/tags", flush=True)
            resp = await client.get(f"{clean_endpoint}/api/tags", timeout=5.0)
            if resp.status_code == 200:
                models = resp.json().get("models", [])
                model_names = [m.get("name", "").split(":")[0] for m in models]
                # Also check full names
                full_names = [m.get("name", "") for m in models]
                
                print(f"[KB] Found models: {model_names}", flush=True)

                if target_model.split(":")[0] in model_names or target_model in full_names:
                    print(f"[KB] Embedding model '{target_model}' is available", flush=True)
                    embedding_model_available = True
                    return True
            else:
                 # If we get 404 from localhost, maybe Ollama isn't running
                 pass

            # Model not available - UI should prompt user to download
            print(f"[KB] Embedding model '{target_model}' not found. KB RAG disabled until user downloads it.", flush=True)
            embedding_model_available = False
            return False

        except Exception as e:
            # If we fail to connect to localhost, and we thought it was local -> Fail
            # If we fail to connect to custom endpoint -> Fail
            print(f"[KB] Cannot check embedding model: {e}", flush=True)
            embedding_model_available = False
            return False

async def embed_texts(texts: list[str], endpoint: str, model_name: str = None, api_key: str = None) -> list[list[float]]:
    """Call embedding API locally or cloud."""
    if not texts:
        return []

    target_model = model_name or EMBEDDING_MODEL
    
    # Heuristic logic for endpoint resolution
    is_local_model = any(x in target_model.lower() for x in ['nomic', 'mxbai', 'minilm', 'llama', 'mistral'])
    is_cloud_model = 'text-embedding' in target_model.lower()

    # CRITICAL FIX: If local model but endpoint is Cloud (Groq/OpenAI), force Localhost BEFORE checking format
    if is_local_model:
         is_brain_endpoint = any(x in (endpoint or '').lower() for x in ['api.groq', 'api.openai', 'api.anthropic'])
         if is_brain_endpoint or not endpoint:
             endpoint = "http://localhost:11434"

    # Now determine format based on the (possibly corrected) endpoint
    use_openai_format = is_cloud_model or 'openai' in (endpoint or '')
    
    # Resolving Endpoint logic
    headers = {}
    if use_openai_format:
         clean_endpoint = (endpoint or "https://api.openai.com/v1").rstrip('/')
         url = f"{clean_endpoint}/embeddings"
         headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    else:
         # Ollama native logic
         # We already corrected endpoint if it was brain endpoint, so just use it
         base = endpoint or ""
         clean_endpoint = base.rstrip('/').removesuffix('/v1').rstrip('/') if base else "http://localhost:11434"
         url = f"{clean_endpoint}/api/embeddings"

    # Execution Logic
    if use_openai_format:
        # OpenAI supports batching natively
        async with httpx.AsyncClient() as client:
            payload = {"model": target_model, "input": texts}
            resp = await client.post(url, json=payload, timeout=120.0, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            if "data" in data and isinstance(data["data"], list):
                 return [item["embedding"] for item in data["data"]]
            raise ValueError(f"Unexpected OpenAI response format: {data}")
            
    else:
        # Ollama / Local API - Requires manual batching (one prompt per request)
        if is_local_model and not await check_embedding_model_available(endpoint, target_model):
             raise ValueError(f"Embedding model '{target_model}' not available locally")

        async def _embed_single(text: str) -> list[float]:
            async with httpx.AsyncClient() as client:
                # Ollama embeddings endpoint expects 'input', not 'prompt'
                payload = {"model": target_model, "input": text}
                resp = await client.post(url, json=payload, timeout=60.0)
                try:
                    resp.raise_for_status()
                except httpx.HTTPStatusError:
                    # Improve diagnostics for common 500 errors
                    raise RuntimeError(f"Embedding request failed ({resp.status_code}): {resp.text}")
                data = resp.json()
                if "embedding" in data:
                    return data["embedding"]
                if "embeddings" in data:  # Some versions
                    return data["embeddings"]
                raise ValueError(f"Unexpected Ollama response: {data}")

        # Execute in parallel
        return await asyncio.gather(*[_embed_single(t) for t in texts])
        
        # Handle OpenAI response format
        if "data" in data and isinstance(data["data"], list):
             return [item["embedding"] for item in data["data"]]

        # Ollama response format
        if "embedding" in data:
            return [data["embedding"]]
        if "embeddings" in data:
            return data["embeddings"]
        raise ValueError(f"Unexpected embedding response format from {url}")

# ... (cosine_similarity, find_precomputed_embeddings, get_kb_cache_path ... remain same)

# ... (ensure_kb_loaded needs update to pass api_key? No, it uses cached.)

# ... (init_chromadb, query_chromadb remain same)

async def get_relevant_kb_snippets(query: str, state: AgentState) -> str:
    """
    Retrieve top-k KB entries using hybrid RAG (embeddings + keyword boosting).
    This is read-only and used as RAG context for the supervisor.
    """
    embed_endpoint = state.get("embedding_endpoint") or EMBEDDING_ENDPOINT or state.get("llm_endpoint", "")
    target_model = state.get("embedding_model") or EMBEDDING_MODEL
    api_key = state.get("api_key") 

    await ensure_kb_loaded(embed_endpoint, target_model)

    # Try ChromaDB first if available (10x faster)
    if USE_CHROMADB:
        await init_chromadb()
        chroma_results = await query_chromadb(query, n_results=KB_MAX_MATCHES)
        if chroma_results:
            print(f"[KB] Using ChromaDB: Found {len(chroma_results)} matches", flush=True)
            snippets = []
            for match in chroma_results[:KB_MAX_MATCHES]:
                entry = match['entry']
                score = match['score']
                snippets.append(kb_entry_to_text(entry))
            return "\n\n---\n\n".join(snippets) if snippets else "(no KB matches)"

    # Fallback to in-memory embeddings
    if not kb_entries or not kb_embeddings:
        return "(no KB context loaded)"

    try:
        q_embs = await embed_texts([query], embed_endpoint, target_model, api_key=api_key)
    except Exception as e:
        print(f"[KB] Query embedding failed: {e}", flush=True)
        return "(KB unavailable due to embedding error)"

    q_vec = q_embs[0]
    query_lower = (query or '').lower()  # Safety: handle None query

    # Hybrid RAG: embeddings + keyword boosting
    boost_keywords = {
        "crossplane": 0.15,
        "managed": 0.10,
        "synced": 0.10,
        "provider": 0.10,
        "azure": 0.12,
        "aws": 0.12,
        "gcp": 0.12,
        "roleassignment": 0.15,
        "reconcile": 0.10,
        "oomkilled": 0.15,
        "crashloop": 0.15,
        "imagepull": 0.15,
        "403": 0.12,
        "401": 0.12,
        "permission": 0.12,
        "cert-manager": 0.12,
        "certificate": 0.10,
        "argocd": 0.12,
        "istio": 0.12,
        "ingress": 0.10,
        "service mesh": 0.12,
    }

    scored = []
    for idx, vec in enumerate(kb_embeddings):
        sim = cosine_similarity(q_vec, vec)
        entry = kb_entries[idx]
        entry_text = kb_entry_to_text(entry).lower()
        boost = 0.0

        for keyword, boost_value in boost_keywords.items():
            if keyword in query_lower and keyword in entry_text:
                boost += boost_value

        final_score = min(1.0, sim + boost)
        scored.append((final_score, sim, idx))

    scored.sort(reverse=True, key=lambda x: x[0])

    top = [s for s in scored[:KB_MAX_MATCHES] if s[0] >= KB_MIN_SIMILARITY]
    if not top:
        return "(no strong KB matches for this query)"

    lines = []
    for final_score, orig_sim, idx in top:
        e = kb_entries[idx]
        lines.append(f"- [KB:{e.get('id', f'entry-{idx}')}] (score {final_score:.2f})")
        if e.get("symptoms"):
            lines.append("  Symptoms: " + "; ".join(e["symptoms"]))
        if e.get("root_cause"):
            lines.append("  Root cause: " + str(e["root_cause"]))
        if e.get("investigation"):
             val = "; ".join(e["investigation"]) if isinstance(e["investigation"], list) else str(e["investigation"])
             lines.append(f"  Investigation: {val}")
        if e.get("fixes"):
             val = "; ".join(e["fixes"]) if isinstance(e["fixes"], list) else str(e["fixes"])
             lines.append(f"  Fixes: {val}")
        lines.append("")

    return "\n".join(lines) if lines else "(no KB context)"

async def generate_kb_embeddings_generator(llm_endpoint: str, model_name: str = None, api_key: str = None):
    """Generator for creating KB embeddings and updating global state."""
    global kb_loaded, kb_entries, kb_embeddings

    target_model = model_name or EMBEDDING_MODEL

    # Check embedding model availability
    # (Checking avail for Cloud is simpler, assuming True if Key exists)
    if not await check_embedding_model_available(llm_endpoint, target_model):
        yield f"data: {json.dumps({'status': 'error', 'message': f'Embedding model {target_model} not available. Download it first.'})}\n\n"
        return

    yield f"data: {json.dumps({'status': 'starting', 'message': 'Loading knowledge base files...'})}\n\n"

    # ... (KB Loading Logic - Omitted for brevity, assumed unchanged in replacement unless I include it)
    # WAIT, I am replacing a huge chunk. I need to be careful not to delete the loading logic.
    # The loading logic was lines 506-547 in original file.
    # To be safe, I should view the chunks I am replacing or ensure I include the full body.
    # The tool `replace_file_content` replaces contiguous block.
    # If I use `multi_replace`, I can target specific functions.
    # Or `replace_file_content` targeting StartLine to EndLine.
    
    # I will split this into chunks using multi_replace_file_content to avoid rewriting the unchanged logic inside `generate_kb_embeddings_generator`.
    
    # Chunk 1: Update embed_texts signature and body.
    # Chunk 2: Update get_relevant_kb_snippets body (call site).
    # Chunk 3: Update generate_kb_embeddings_generator signature and call site within it.
    
    # This is safer.
    
    pass

def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two vectors."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)

def find_precomputed_embeddings() -> str | None:
    """Find pre-computed kb_embeddings.json in various locations."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.abspath(os.path.join(script_dir, "..", "..", ".."))

    candidates = [
        os.path.join(root_dir, "src-tauri", "resources", "kb_embeddings.json"),  # Dev
        os.path.join(script_dir, "resources", "kb_embeddings.json"),  # Bundled
        os.path.join(os.getcwd(), "src-tauri", "resources", "kb_embeddings.json"),  # CWD
        os.path.join(KB_DIR, "..", "src-tauri", "resources", "kb_embeddings.json") if KB_DIR else "",  # Relative to KB
    ]
    for path in candidates:
        if not path: continue
        abs_path = os.path.abspath(path)
        if os.path.isfile(abs_path):
            return abs_path
    return None

def get_kb_cache_path() -> str:
    """Get path for cached KB embeddings (user's local cache, not bundled)."""
    # Allow override via env var
    env_dir = os.environ.get("K8S_AGENT_CACHE_DIR")
    if env_dir:
        cache_dir = env_dir
    else:
        import platform
        system = platform.system()
        home = os.path.expanduser("~")

        if system == "Windows":
            # Use LOCALAPPDATA on Windows
            local_app_data = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
            cache_dir = os.path.join(local_app_data, "opspilot")
        elif system == "Darwin":
            # macOS: ~/Library/Application Support/opspilot
            cache_dir = os.path.join(home, "Library", "Application Support", "opspilot")
        else:
            # Linux/Unix: ~/.local/share/opspilot (XDG standard)
            xdg_data = os.environ.get("XDG_DATA_HOME", os.path.join(home, ".local", "share"))
            cache_dir = os.path.join(xdg_data, "opspilot")

    os.makedirs(cache_dir, exist_ok=True)
    return os.path.join(cache_dir, "kb_embeddings_cache.json")

async def ensure_kb_loaded(embed_endpoint: str, model_name: str = None):
    """Load pre-computed KB embeddings from kb_embeddings.json or user cache (no runtime embedding needed)."""
    global kb_loaded, kb_entries, kb_embeddings
    
    target_model = model_name or EMBEDDING_MODEL

    async with kb_lock:
        if kb_loaded:
            return

        # PRIORITY 1: Load from KB_DIR (Source of Truth) if it exists
        # We only use precomputed/bundled embeddings if we CANNOT load fresh files
        # or if the user explicitly wants to use cache (we can add a timestamp check later).
        # For now, to solve "are multiple files being used?", we must prioritize the files.
        
        has_kb_files = False
        if os.path.isdir(KB_DIR):
             # Check if any .jsonl/.json files exist
             for f in os.listdir(KB_DIR):
                 if f.endswith('.jsonl') or f.endswith('.json'):
                     has_kb_files = True
                     break
        
        if not has_kb_files:
            # Fallback to precomputed if no local files found
            # Try to load pre-computed embeddings first
            # Check both bundled path and user cache
            precomputed_path = find_precomputed_embeddings()
            user_cache_path = get_kb_cache_path()

            # Prefer user cache if it exists (more recent), then bundled
            paths_to_try = []
            if os.path.isfile(user_cache_path):
                paths_to_try.append(("user_cache", user_cache_path))
            if precomputed_path:
                paths_to_try.append(("bundled", precomputed_path))

            for source, emb_path in paths_to_try:
                try:
                    with open(emb_path, "r", encoding="utf-8") as f:
                        data = json.load(f)

                    # CHECK if the loaded embeddings match the requested model
                    cached_model = data.get("model", "")
                    # Allow fuzzy match (e.g. nomic-embed-text:latest vs nomic-embed-text)
                    if model_name and cached_model and not cached_model.startswith(target_model.split(':')[0]):
                        print(f"[KB] Cached embeddings model ({cached_model}) does not match requested ({target_model}). skipping cache.", flush=True)
                        continue # Try next source or fall back to runtime

                    docs = data.get("documents", [])
                    
                    # Reset globals
                    kb_entries.clear()
                    kb_embeddings.clear()

                    for doc in docs:
                        # Extract entry info for display
                        kb_entries.append({
                            "id": doc.get("id", ""),
                            "title": doc.get("title", ""),
                            "summary": doc.get("summary", doc.get("title", "")),
                            "file": doc.get("file", "")
                        })
                        kb_embeddings.append(doc.get("embedding", []))

                    print(f"[KB] Loaded {len(kb_entries)} embeddings from {source}: {emb_path} (Model: {cached_model or 'unknown'})", flush=True)
                    kb_loaded = True
                    return
                except Exception as e:
                    print(f"[KB] Failed to load embeddings from {source} ({emb_path}): {e}", flush=True)
        else:
            print(f"[KB] Found local knowledge files in {KB_DIR}. Ignoring outdated bundles.", flush=True)

        # Fallback: Load raw KB files and embed at runtime (requires Ollama nomic-embed-text)

        print("[KB] No pre-computed embeddings found, falling back to runtime embedding...", flush=True)
        entries: list[dict] = []
        if os.path.isdir(KB_DIR):
            for name in os.listdir(KB_DIR):
                path = os.path.join(KB_DIR, name)
                lower_name = name.lower()
                try:
                    if lower_name.endswith(".jsonl"):
                        with open(path, "r", encoding="utf-8") as f:
                            for line in f:
                                line = line.strip()
                                if line:
                                    e = json.loads(line)
                                    e['_source_file'] = name
                                    entries.append(e)
                        print(f"[KB] Loaded JSONL file: {name}", flush=True)
                    elif lower_name.endswith(".json"):
                        with open(path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                            if isinstance(data, list):
                                for item in data:
                                    item['_source_file'] = name
                                entries.extend(data)
                            else:
                                data['_source_file'] = name
                                entries.append(data)
                        print(f"[KB] Loaded JSON file: {name}", flush=True)
                except Exception as e:
                    print(f"[KB] Failed to load {path}: {e}", flush=True)
        else:
            print(f"[KB] KB_DIR does not exist: {KB_DIR}", flush=True)

        # Reset globals
        kb_entries.clear()
        kb_embeddings.clear()
        kb_entries.extend(entries)

        if not entries:
            kb_loaded = True
            print("[KB] No KB entries loaded", flush=True)
            return

        texts = [kb_entry_to_text(e) for e in entries]
        try:
            kb_embeddings.extend(await embed_texts(texts, embed_endpoint, target_model))
            print(f"[KB] Loaded {len(kb_entries)} entries with runtime embeddings", flush=True)
        except Exception as e:
            print(f"[KB] Failed to embed KB entries: {e}", flush=True)
        
        kb_loaded = True

async def init_chromadb():
    """Initialize ChromaDB persistent vector store (optional optimization)."""
    global chroma_client, chroma_collection

    if not USE_CHROMADB:
        return

    async with kb_lock:
        if chroma_client is not None:
            return  # Already initialized

        try:
            # Initialize ChromaDB in-memory or persistent mode
            persist_dir = os.environ.get("CHROMADB_PERSIST_DIR", "./chroma_db")
            os.makedirs(persist_dir, exist_ok=True)

            if chromadb:
                chroma_client = chromadb.PersistentClient(path=persist_dir)
                chroma_collection = chroma_client.get_or_create_collection(
                    name="k8s_kb",
                    metadata={"hnsw:space": "cosine"}
                )

                # Check if collection needs to be populated
                if chroma_collection.count() == 0:
                    # Load KB entries and add to ChromaDB
                    if not kb_entries:
                        print("[ChromaDB] No KB entries to index", flush=True)
                        return

                    documents = [kb_entry_to_text(e) for e in kb_entries]
                    ids = [str(i) for i in range(len(kb_entries))]
                    embeddings_list = kb_embeddings if kb_embeddings else None

                    chroma_collection.add(
                        documents=documents,
                        ids=ids,
                        embeddings=embeddings_list,
                        metadatas=[{"id": e.get("id", ""), "file": e.get("file", "")} for e in kb_entries]
                    )

                    print(f"[ChromaDB] Indexed {len(kb_entries)} KB entries in persistent store", flush=True)
                else:
                    print(f"[ChromaDB] Found existing index with {chroma_collection.count()} entries", flush=True)
            else:
                 print("[ChromaDB] chromadb module not found, skipping initialization.", flush=True)

        except Exception as e:
            print(f"[ChromaDB] Initialization failed: {e}. Falling back to in-memory.", flush=True)
            chroma_client = None
            chroma_collection = None

async def query_chromadb(query: str, n_results: int = 5) -> list[dict]:
    """Query ChromaDB for relevant KB entries."""
    if chroma_collection is None:
        return []

    try:
        results = chroma_collection.query(
            query_texts=[query],
            n_results=n_results
        )

        matched_entries = []
        if results['ids'] and len(results['ids']) > 0:
             for i, doc_id in enumerate(results['ids'][0]):
                idx = int(doc_id)
                if idx < len(kb_entries):
                    distance = results['distances'][0][i] if results.get('distances') else 0.0
                    matched_entries.append({
                        "entry": kb_entries[idx],
                        "distance": distance,
                        "score": 1.0 - distance
                    })

        return matched_entries

    except Exception as e:
        print(f"[ChromaDB] Query failed: {e}", flush=True)
        return []

async def get_relevant_kb_snippets(query: str, state: AgentState) -> str:
    """
    Retrieve top-k KB entries using hybrid RAG (embeddings + keyword boosting).
    This is read-only and used as RAG context for the supervisor.
    """
    embed_endpoint = EMBEDDING_ENDPOINT or state.get("llm_endpoint", "")
    target_model = state.get("embedding_model") or EMBEDDING_MODEL
    api_key = state.get("api_key")

    await ensure_kb_loaded(embed_endpoint, target_model)

    # Try ChromaDB first if available (10x faster)
    if USE_CHROMADB:
        await init_chromadb()
        chroma_results = await query_chromadb(query, n_results=KB_MAX_MATCHES)
        if chroma_results:
            print(f"[KB] Using ChromaDB: Found {len(chroma_results)} matches", flush=True)
            snippets = []
            for match in chroma_results[:KB_MAX_MATCHES]:
                entry = match['entry']
                score = match['score']
                snippets.append(kb_entry_to_text(entry))
            return "\n\n---\n\n".join(snippets) if snippets else "(no KB matches)"

    # Fallback to in-memory embeddings
    if not kb_entries or not kb_embeddings:
        return "(no KB context loaded)"

    try:
        q_embs = await embed_texts([query], embed_endpoint, target_model, api_key=api_key)
    except Exception as e:
        print(f"[KB] Query embedding failed: {e}", flush=True)
        return "(KB unavailable due to embedding error)"

    q_vec = q_embs[0]
    query_lower = (query or '').lower()  # Safety: handle None query

    # Hybrid RAG: embeddings + keyword boosting
    boost_keywords = {
        "crossplane": 0.15,
        "managed": 0.10,
        "synced": 0.10,
        "provider": 0.10,
        "azure": 0.12,
        "aws": 0.12,
        "gcp": 0.12,
        "roleassignment": 0.15,
        "reconcile": 0.10,
        "oomkilled": 0.15,
        "crashloop": 0.15,
        "imagepull": 0.15,
        "403": 0.12,
        "401": 0.12,
        "permission": 0.12,
        "cert-manager": 0.12,
        "certificate": 0.10,
        "argocd": 0.12,
        "istio": 0.12,
        "ingress": 0.10,
        "service mesh": 0.12,
    }

    scored = []
    for idx, vec in enumerate(kb_embeddings):
        sim = cosine_similarity(q_vec, vec)
        entry = kb_entries[idx]
        entry_text = kb_entry_to_text(entry).lower()
        boost = 0.0

        for keyword, boost_value in boost_keywords.items():
            if keyword in query_lower and keyword in entry_text:
                boost += boost_value

        final_score = min(1.0, sim + boost)
        scored.append((final_score, sim, idx))

    scored.sort(reverse=True, key=lambda x: x[0])

    top = [s for s in scored[:KB_MAX_MATCHES] if s[0] >= KB_MIN_SIMILARITY]
    if not top:
        return "(no strong KB matches for this query)"

    lines = []
    for final_score, orig_sim, idx in top:
        e = kb_entries[idx]
        # Show if boosted
        if final_score > orig_sim:
            lines.append(f"- [KB:{e.get('id', f'entry-{idx}')}] (score {final_score:.2f}, similarity {orig_sim:.2f}, boosted)")
        else:
            lines.append(f"- [KB:{e.get('id', f'entry-{idx}')}] (similarity {orig_sim:.2f})")
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

async def generate_kb_embeddings_generator(llm_endpoint: str, model_name: str = None, api_key: str = None):
    """Generator for creating KB embeddings and updating global state."""
    global kb_loaded, kb_entries, kb_embeddings

    target_model = model_name or EMBEDDING_MODEL

    # Check embedding model availability
    if not await check_embedding_model_available(llm_endpoint, target_model):
        yield f"data: {json.dumps({'status': 'error', 'message': f'Embedding model {target_model} not available. Download it first.'})}\n\n"
        return

    yield f"data: {json.dumps({'status': 'starting', 'message': 'Loading knowledge base files...'})}\n\n"

    # Load all KB entries from files
    entries: list[dict] = []
    if not os.path.isdir(KB_DIR):
        yield f"data: {json.dumps({'status': 'error', 'message': f'Knowledge base directory not found: {KB_DIR}'})}\n\n"
        return

    files_processed = 0
    for name in os.listdir(KB_DIR):
        path = os.path.join(KB_DIR, name)
        lower_name = name.lower()
        try:
            if lower_name.endswith(".jsonl"):
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            entry = json.loads(line)
                            entry["_source_file"] = name
                            entries.append(entry)
                files_processed += 1
            elif lower_name.endswith(".json") and name != "kb-index.json":
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, list):
                        for item in data:
                            item["_source_file"] = name
                        entries.extend(data if isinstance(data, list) else [data])
                    else:
                        data["_source_file"] = name
                        entries.append(data)
                files_processed += 1
            elif lower_name.endswith(".md"):
                with open(path, "r", encoding="utf-8") as f:
                    content = f.read()
                entries.append({
                    "id": name.replace(".md", ""),
                    "title": name.replace("-", " ").replace(".md", "").title(),
                    "content": content[:3000],
                    "_source_file": name
                })
                files_processed += 1
        except Exception as e:
            print(f"[KB] Failed to load {path}: {e}", flush=True)

    if not entries:
        yield f"data: {json.dumps({'status': 'error', 'message': 'No KB entries found to embed'})}\n\n"
        return

    yield f"data: {json.dumps({'status': 'progress', 'message': f'Loaded {len(entries)} entries from {files_processed} files', 'percent': 10})}\n\n"

    # Generate embeddings
    yield f"data: {json.dumps({'status': 'progress', 'message': 'Generating embeddings (this may take a minute)...', 'percent': 15})}\n\n"

    texts = [kb_entry_to_text(e) for e in entries]
    embeddings_list = []

    # Process in batches to show progress
    batch_size = 10
    total_batches = (len(texts) + batch_size - 1) // batch_size
    
    # We can reuse embed_texts but we want to yield progress, so we'll reimplement batching here or use chunks
    # For simplicity, call embed_texts in chunks
    
    for batch_idx in range(total_batches):
        start = batch_idx * batch_size
        end = min(start + batch_size, len(texts))
        batch_texts = texts[start:end]
        
        try:
            batch_output = await embed_texts(batch_texts, llm_endpoint, target_model, api_key=api_key)
            embeddings_list.extend(batch_output)
        except Exception as e:
             yield f"data: {json.dumps({'status': 'error', 'message': f'Embedding failed at batch {batch_idx}: {e}'})}\n\n"
             return

        # Progress update
        progress_pct = 15 + int(80 * (batch_idx + 1) / total_batches)
        yield f"data: {json.dumps({'status': 'progress', 'message': f'Embedded {end}/{len(texts)} entries', 'percent': progress_pct})}\n\n"

    # Build the cache structure
    documents = []
    for i, entry in enumerate(entries):
        doc = {
            "id": entry.get("id", f"entry-{i}"),
            "file": entry.get("_source_file", "unknown"),
            "title": entry.get("title", entry.get("root_cause", f"Entry {i}")),
            "summary": kb_entry_to_text(entry)[:500],
            "embedding": embeddings_list[i]
        }
        documents.append(doc)

    cache_data = {
        "model": target_model,
        "dimension": len(embeddings_list[0]) if embeddings_list else 768,
        "documents": documents,
        "tools": []  # Tools are optional, can be added later
    }

    # Save to cache
    cache_path = get_kb_cache_path()
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cache_data, f)

    yield f"data: {json.dumps({'status': 'progress', 'message': 'Saved embeddings to cache', 'percent': 98})}\n\n"

    # Reload into memory
    kb_entries.clear()
    kb_entries.extend(entries)
    
    kb_embeddings.clear()
    kb_embeddings.extend(embeddings_list)
    
    kb_loaded = True

    yield f"data: {json.dumps({'status': 'success', 'message': f'Generated embeddings for {len(entries)} KB entries', 'document_count': len(entries), 'percent': 100})}\n\n"
