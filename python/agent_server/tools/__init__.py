"""
Tools package for K8s agent.

Contains:
- kb_search: Knowledge base semantic search using embeddings
"""

from .kb_search import get_relevant_kb_snippets, clear_cache, ingest_cluster_knowledge

__all__ = ['get_relevant_kb_snippets', 'clear_cache', 'ingest_cluster_knowledge']
