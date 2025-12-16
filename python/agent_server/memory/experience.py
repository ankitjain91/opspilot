
import os
import json
import httpx
import time
from typing import List, Dict, Optional, Tuple
from pydantic import BaseModel
from ..config import EMBEDDING_MODEL, CACHE_DIR, EMBEDDING_ENDPOINT

# Experience Schema
class AgentExperience(BaseModel):
    id: str
    timestamp: str
    query: str
    plan: str
    outcome: str  # SUCCESS, FAILURE, PARTIAL
    analysis: str # "Deleted pod X and it restarted successfully"
    similarity: float = 0.0 # Field for search results

# Paths
EXPERIENCE_FILE = os.path.join(CACHE_DIR, "experiences.jsonl")
EMBEDDINGS_FILE = os.path.join(CACHE_DIR, "experience_embeddings.json")

# In-memory Cache
_experience_cache: List[Dict] = []
_exp_embeddings_cache: Dict[str, List[float]] = {}

def get_experience_memory() -> List[Dict]:
    """Load experiences from disk."""
    global _experience_cache
    if _experience_cache:
        return _experience_cache
        
    if not os.path.exists(EXPERIENCE_FILE):
        return []
        
    loaded = []
    try:
        with open(EXPERIENCE_FILE, 'r') as f:
            for line in f:
                if line.strip():
                    loaded.append(json.loads(line))
    except Exception as e:
        print(f"[Experience] Failed to load experiences: {e}", flush=True)
        
    _experience_cache = loaded
    return loaded

def save_experience(experience: Dict):
    """Save a new experience to persistence."""
    global _experience_cache, _exp_embeddings_cache
    
    # Validation
    if 'id' not in experience:
        experience['id'] = str(time.time())
    
    # Append to file
    try:
        os.makedirs(os.path.dirname(EXPERIENCE_FILE), exist_ok=True)
        with open(EXPERIENCE_FILE, 'a') as f:
            f.write(json.dumps(experience) + "\n")
            
        # Update cache
        if _experience_cache is None:
            _experience_cache = []
        _experience_cache.append(experience)
        
        print(f"[Experience] Saved experience: {experience['id']}", flush=True)
        
    except Exception as e:
        print(f"[Experience] Failed to save: {e}", flush=True)

async def get_embedding(text: str) -> Optional[List[float]]:
    """Helper to get embedding (reused logic could be refactored, but copying for isolation)."""
    # Use global config default
    endpoint = EMBEDDING_ENDPOINT or 'http://localhost:11434'
    model = EMBEDDING_MODEL or 'nomic-embed-text'
    
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{endpoint}/api/embeddings",
                json={"model": model, "prompt": text}
            )
            if response.status_code == 200:
                return response.json().get("embedding")
    except Exception as e:
        pass # Silent fail
    return None

def cosine_similarity(a: List[float], b: List[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    mag_a = sum(x * x for x in a) ** 0.5
    mag_b = sum(x * x for x in b) ** 0.5
    if mag_a == 0 or mag_b == 0: return 0.0
    return dot / (mag_a * mag_b)

async def search_experiences(query: str, max_results: int = 3, min_similarity: float = 0.5) -> List[AgentExperience]:
    """Find similar past experiences."""
    global _exp_embeddings_cache
    
    experiences = get_experience_memory()
    if not experiences:
        return []
        
    query_vec = await get_embedding(query)
    if not query_vec:
        return []
        
    results = []
    
    # Basic embedding cache management involved here? 
    # For now, re-compute lazily if missing in memory. 
    # Real app should persist embeddings map too.
    
    for exp in experiences:
        eid = exp['id']
        
        # Check cache
        if eid in _exp_embeddings_cache:
            vec = _exp_embeddings_cache[eid]
        else:
            # Generate
            text = f"{exp.get('query')} | {exp.get('outcome')} | {exp.get('analysis')}"
            vec = await get_embedding(text)
            if vec:
                _exp_embeddings_cache[eid] = vec
            else:
                continue
                
        sim = cosine_similarity(query_vec, vec)
        if sim >= min_similarity:
            # Convert to Pydantic
            obj = AgentExperience(
                id=exp['id'],
                timestamp=exp.get('timestamp', ''),
                query=exp.get('query', ''),
                plan=exp.get('plan', ''),
                outcome=exp.get('outcome', 'UNKNOWN'),
                analysis=exp.get('analysis', ''),
                similarity=sim
            )
            results.append(obj)
            
    # Sort
    results.sort(key=lambda x: x.similarity, reverse=True)
    return results[:max_results]
