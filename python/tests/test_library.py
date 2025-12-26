
import asyncio
import os
import shutil
from agent_server.memory.experience import save_experience, search_experiences, EXPERIENCE_FILE, EMBEDDINGS_FILE

# Use a test file location if possible, or clean up after
# We can just run it, assuming standard cache dir is safe to append test data?
# Better to mock or temporary patch CACHE_DIR?
# For now, we'll append a clearly marked TEST experience.

async def test_library():
    print("--- Testing The Library ---")
    
    # 1. Save Experience
    exp = {
        "id": "test-run-123",
        "timestamp": "2024-01-01T12:00:00Z",
        "query": "fix crashLoop on frontend",
        "plan": "Check logs, found OOM, increased limit",
        "outcome": "SUCCESS",
        "analysis": "Pod validation confirmed running"
    }
    
    print("Saving experience...")
    save_experience(exp)
    
    # Allow some time (async operations? no, save is sync file IO, embeddings might be lazy)
    
    # 2. Search
    print("Searching for 'frontend crash'...")
    results = await search_experiences("frontend crash", max_results=1)
    
    if results:
        top = results[0]
        print(f"Match Found: {top.id} (Sim: {top.similarity:.2f})")
        print(f"Query: {top.query}")
        print(f"Outcome: {top.outcome}")
        
        if top.id == "test-run-123":
            print("[OK] Successfully retrieved saved experience!")
        else:
            print("[WARN] Retrieved different experience (maybe existing data).")
    else:
        print("[X] No results found. (Embeddings might be down or not generated)")

if __name__ == "__main__":
    asyncio.run(test_library())
