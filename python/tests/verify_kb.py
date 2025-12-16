import sys
import os
import asyncio
import json
from unittest.mock import patch, MagicMock

# Add project root to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from agent_server.tools import search
from agent_server.state import AgentState

async def mock_embed_texts(texts, endpoint):
    """Return dummy embeddings for testing."""
    # Return a vector of size 768 (standard)
    return [[0.1] * 768 for _ in texts]

async def mock_check_avail(endpoint):
    return True

async def verify_kb():
    print("--- Starting KB Verification ---")
    
    # 1. Inspect KB_DIR
    from agent_server.config import KB_DIR
    print(f"Configured KB_DIR: {KB_DIR}")
    
    if not os.path.isdir(KB_DIR):
        print("❌ KB_DIR does not exist. Test will fail.")
        return

    # 2. Check for expected file
    expected_file = os.path.join(KB_DIR, "crossplane_azure_patterns.jsonl")
    if os.path.exists(expected_file):
        print(f"✅ Found expected knowledge file: {expected_file}")
    else:
        print(f"⚠️ Warning: {expected_file} not found. Loading might yield empty results.")

    # 3. Mock Embeddings to test loading logic without Ollama
    with patch('agent_server.tools.search.embed_texts', side_effect=mock_embed_texts):
        with patch('agent_server.tools.search.check_embedding_model_available', side_effect=mock_check_avail):
            
            # Reset globals
            search.kb_loaded = False
            search.kb_entries = []
            
            # Load KB
            print("Loading KB...")
            await search.ensure_kb_loaded("http://mock-endpoint")
            
            print(f"Entries Loaded: {len(search.kb_entries)}")
            
            if len(search.kb_entries) == 0:
                print("❌ No entries loaded.")
                return

            # Print first entry title/source
            first = search.kb_entries[0]
            print(f"Sample Entry: {first.get('title', 'No Title')} (from {first.get('_source_file', 'unknown')})")

            # Check if all files are represented
            sources = set()
            for e in search.kb_entries:
                if "_source_file" in e:
                    sources.add(e["_source_file"])
            
            print(f"Unique Sources Loaded: {sources}")
            expected_files = ["azure_resources_patterns.jsonl", "cncf_argocd_patterns.jsonl", "crossplane_advanced_patterns.jsonl", "crossplane_azure_patterns.jsonl"]
            
            missing = [f for f in expected_files if f not in sources]
            if missing:
                print(f"❌ FAIL: The following files are NOT being used: {missing}")
                print("Reason: Agent is loading stale 'kb_embeddings.json' and ignoring 'knowledge/' directory.")
            else:
                 print("✅ SUCCESS: All files loaded.")

            # 4. Test Retrieval
            print("Testing Retrieval for query 'crossplane'...")
            
            # We need to mock cosine similarity to return high score for checking plumbing
            # But since we set all embeddings to [0.1...], similarity will be 1.0 for everything.
            # So we should get results.
            
            state = AgentState(
                query="crossplane azure mystery",
                llm_endpoint="http://mock",
                llm_model="mock",
                kube_context="default", 
                command_history=[],
                discovered_resources={},
                conversation_history=[],
                iteration=0,
                start_time=0.0
            ) 
            
            snippets = await search.get_relevant_kb_snippets("crossplane", state)
            
            print("\n--- Retrieval Result ---")
            print(snippets[:500] + "..." if len(snippets) > 500 else snippets)
            
            if "(no KB" in snippets:
                print("\n❌ Retrieval returned no matches.")
            else:
                print("\n✅ Retrieval successful! Snippets returned.")

if __name__ == "__main__":
    asyncio.run(verify_kb())
