"""
Semantic Query Cache - High-performance caching for KB queries

Provides:
- LRU cache for query embeddings
- Semantic deduplication (similar queries return cached results)
- TTL-based expiration
- Batch embedding pre-computation for common queries
"""

import hashlib
import time
import asyncio
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, field
from collections import OrderedDict


@dataclass
class CacheEntry:
    """Single cache entry with metadata."""
    query: str
    embedding: Optional[List[float]]
    results: Optional[str]
    timestamp: float
    hit_count: int = 0


class SemanticQueryCache:
    """
    LRU cache with TTL for semantic query results.

    Features:
    - Exact match caching (hash-based)
    - Semantic similarity caching (embedding-based)
    - TTL expiration (default 5 minutes)
    - Max size with LRU eviction
    """

    def __init__(
        self,
        max_size: int = 100,
        ttl_seconds: int = 300,
        similarity_threshold: float = 0.95
    ):
        self.max_size = max_size
        self.ttl_seconds = ttl_seconds
        self.similarity_threshold = similarity_threshold

        # Exact match cache (hash -> entry)
        self._exact_cache: OrderedDict[str, CacheEntry] = OrderedDict()

        # Embedding cache for semantic matching
        self._embedding_cache: Dict[str, List[float]] = {}

        # Statistics
        self._stats = {
            'hits': 0,
            'misses': 0,
            'semantic_hits': 0,
            'evictions': 0
        }

    def _get_hash(self, query: str) -> str:
        """Get hash key for query."""
        normalized = query.lower().strip()
        return hashlib.sha256(normalized.encode()).hexdigest()[:16]

    def _is_expired(self, entry: CacheEntry) -> bool:
        """Check if entry has expired."""
        return (time.time() - entry.timestamp) > self.ttl_seconds

    def _evict_oldest(self):
        """Evict oldest entry when cache is full."""
        if len(self._exact_cache) >= self.max_size:
            # Remove oldest entry (first item in OrderedDict)
            oldest_key = next(iter(self._exact_cache))
            del self._exact_cache[oldest_key]
            self._stats['evictions'] += 1

    def _cosine_similarity(self, a: List[float], b: List[float]) -> float:
        """Compute cosine similarity between two vectors."""
        if not a or not b or len(a) != len(b):
            return 0.0

        dot_product = sum(x * y for x, y in zip(a, b))
        mag_a = sum(x * x for x in a) ** 0.5
        mag_b = sum(x * x for x in b) ** 0.5

        if mag_a == 0 or mag_b == 0:
            return 0.0

        return dot_product / (mag_a * mag_b)

    def get(self, query: str) -> Optional[Tuple[str, List[float]]]:
        """
        Get cached result for query.

        Returns:
            Tuple of (results, embedding) if found, None otherwise
        """
        query_hash = self._get_hash(query)

        # Check exact match first
        if query_hash in self._exact_cache:
            entry = self._exact_cache[query_hash]

            if self._is_expired(entry):
                # Expired - remove and return None
                del self._exact_cache[query_hash]
                self._stats['misses'] += 1
                return None

            # Cache hit - move to end (most recently used)
            self._exact_cache.move_to_end(query_hash)
            entry.hit_count += 1
            self._stats['hits'] += 1

            return (entry.results, entry.embedding)

        self._stats['misses'] += 1
        return None

    async def get_or_compute(
        self,
        query: str,
        compute_fn: callable,
        embedding_fn: callable = None
    ) -> Tuple[str, Optional[List[float]]]:
        """
        Get cached result or compute if not found.

        Args:
            query: The search query
            compute_fn: Async function to compute results if not cached
            embedding_fn: Optional async function to compute query embedding

        Returns:
            Tuple of (results, embedding)
        """
        # Try cache first
        cached = self.get(query)
        if cached is not None:
            return cached

        # Compute embedding if function provided
        embedding = None
        if embedding_fn:
            embedding = await embedding_fn(query)

            # Check for semantic match with existing entries
            if embedding:
                for entry in self._exact_cache.values():
                    if entry.embedding and not self._is_expired(entry):
                        similarity = self._cosine_similarity(embedding, entry.embedding)
                        if similarity >= self.similarity_threshold:
                            # Semantic hit - return cached results
                            entry.hit_count += 1
                            self._stats['semantic_hits'] += 1
                            return (entry.results, embedding)

        # Compute results
        results = await compute_fn(query)

        # Store in cache
        self.set(query, results, embedding)

        return (results, embedding)

    def set(
        self,
        query: str,
        results: str,
        embedding: Optional[List[float]] = None
    ):
        """
        Store result in cache.

        Args:
            query: The search query
            results: The computed results
            embedding: Optional query embedding for semantic matching
        """
        query_hash = self._get_hash(query)

        # Evict if needed
        self._evict_oldest()

        # Store entry
        self._exact_cache[query_hash] = CacheEntry(
            query=query,
            embedding=embedding,
            results=results,
            timestamp=time.time()
        )

        # Also store embedding in separate cache
        if embedding:
            self._embedding_cache[query_hash] = embedding

    def invalidate(self, query: str = None):
        """
        Invalidate cache entries.

        Args:
            query: Specific query to invalidate, or None to clear all
        """
        if query is None:
            self._exact_cache.clear()
            self._embedding_cache.clear()
        else:
            query_hash = self._get_hash(query)
            if query_hash in self._exact_cache:
                del self._exact_cache[query_hash]
            if query_hash in self._embedding_cache:
                del self._embedding_cache[query_hash]

    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        total_requests = self._stats['hits'] + self._stats['misses']
        hit_rate = (self._stats['hits'] / total_requests * 100) if total_requests > 0 else 0

        return {
            **self._stats,
            'size': len(self._exact_cache),
            'max_size': self.max_size,
            'hit_rate_percent': round(hit_rate, 2),
            'total_requests': total_requests
        }

    def cleanup_expired(self) -> int:
        """Remove all expired entries. Returns number removed."""
        expired_keys = [
            key for key, entry in self._exact_cache.items()
            if self._is_expired(entry)
        ]

        for key in expired_keys:
            del self._exact_cache[key]
            if key in self._embedding_cache:
                del self._embedding_cache[key]

        return len(expired_keys)


class QueryCoalescer:
    """
    Coalesces duplicate in-flight queries to prevent redundant computation.

    If the same query is being computed, subsequent requests wait for
    the first one to complete instead of computing again.
    """

    def __init__(self):
        self._pending: Dict[str, asyncio.Event] = {}
        self._results: Dict[str, Any] = {}
        self._lock = asyncio.Lock()

    def _get_hash(self, query: str) -> str:
        """Get hash key for query."""
        return hashlib.sha256(query.lower().strip().encode()).hexdigest()[:16]

    async def execute(
        self,
        query: str,
        compute_fn: callable
    ) -> Any:
        """
        Execute query with coalescing.

        If query is already being computed, wait for result.
        Otherwise, compute and share result with any waiting callers.
        """
        query_hash = self._get_hash(query)

        async with self._lock:
            # Check if query is already being computed
            if query_hash in self._pending:
                event = self._pending[query_hash]

        # If pending, wait for result
        if query_hash in self._pending:
            await self._pending[query_hash].wait()
            return self._results.get(query_hash)

        # Otherwise, compute
        async with self._lock:
            if query_hash in self._pending:
                # Double-check after acquiring lock
                event = self._pending[query_hash]
                await event.wait()
                return self._results.get(query_hash)

            # Mark as pending
            event = asyncio.Event()
            self._pending[query_hash] = event

        try:
            # Compute result
            result = await compute_fn(query)

            # Store result
            self._results[query_hash] = result

            return result
        finally:
            # Signal completion
            event.set()

            # Cleanup after small delay (allow waiters to read result)
            async def cleanup():
                await asyncio.sleep(0.1)
                async with self._lock:
                    if query_hash in self._pending:
                        del self._pending[query_hash]
                    if query_hash in self._results:
                        del self._results[query_hash]

            asyncio.create_task(cleanup())


# Global instances
_query_cache: Optional[SemanticQueryCache] = None
_query_coalescer: Optional[QueryCoalescer] = None


def get_query_cache() -> SemanticQueryCache:
    """Get or create the global query cache instance.

    Token Optimization: Lower similarity threshold (0.92) means more cache hits
    for semantically similar queries like "failing pods" vs "pods that are failing".
    """
    global _query_cache
    if _query_cache is None:
        _query_cache = SemanticQueryCache(
            max_size=200,  # Increased from 100 for better hit rate
            ttl_seconds=300,  # 5 minutes
            similarity_threshold=0.92  # Lowered from 0.95 for more semantic matches
        )
    return _query_cache


def get_query_coalescer() -> QueryCoalescer:
    """Get or create the global query coalescer instance."""
    global _query_coalescer
    if _query_coalescer is None:
        _query_coalescer = QueryCoalescer()
    return _query_coalescer


# Common K8s queries to pre-compute embeddings for
COMMON_QUERIES = [
    "Pod CrashLoopBackOff",
    "Deployment replicas not ready",
    "ImagePullBackOff",
    "Node NotReady",
    "PVC pending",
    "OOMKilled",
    "DiskPressure",
    "failing pods",
    "cluster health",
    "resource usage",
    "network connectivity",
    "service unavailable",
    "certificate expired",
    "connection refused",
    "timeout errors"
]


async def preload_common_queries(
    embedding_fn: callable,
    search_fn: callable
):
    """
    Pre-compute embeddings and search results for common queries.
    Call this during server startup for faster cold-start queries.
    """
    cache = get_query_cache()

    print(f"[QueryCache] Pre-loading {len(COMMON_QUERIES)} common queries...", flush=True)

    for query in COMMON_QUERIES:
        try:
            await cache.get_or_compute(
                query,
                compute_fn=search_fn,
                embedding_fn=embedding_fn
            )
        except Exception as e:
            print(f"[QueryCache] Failed to preload '{query}': {e}", flush=True)

    print(f"[QueryCache] Pre-loaded {cache.get_stats()['size']} queries", flush=True)
