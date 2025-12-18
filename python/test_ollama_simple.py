"""
Simple test with Ollama to verify SmartExecutor fix
"""
import asyncio
import httpx
import os
import json

AGENT_SERVER_URL = "http://localhost:8766"
BRAIN_MODEL = "llama-3.3-70b-versatile"
EXECUTOR_MODEL = "qwen2.5:32b"
KUBE_CONTEXT = "vcluster_management-cluster_taasvstst_dedicated-aks-dev-eastus-ankitj"
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
LLM_HOST = "http://20.56.146.53:11434"  # Still used for executor

async def run_test():
    """Run simple test to check SmartExecutor commands."""
    query = "find eventhubs"
    print(f"\n{'='*80}")
    print(f"TEST: {query}")
    print(f"Using Groq: Brain={BRAIN_MODEL}, Executor={EXECUTOR_MODEL} (Ollama)")
    print(f"{'='*80}\n")

    client = httpx.AsyncClient(timeout=120.0)
    commands_seen = []

    try:
        async with client.stream(
            "POST",
            f"{AGENT_SERVER_URL}/analyze",
            json={
                "query": query,
                "thread_id": "test_groq_simple",
                "kube_context": KUBE_CONTEXT,
                "llm_endpoint": "https://api.groq.com/openai/v1",
                "llm_provider": "groq",
                "llm_model": BRAIN_MODEL,
                "executor_model": EXECUTOR_MODEL,
                "api_key": GROQ_API_KEY,
            }
        ) as stream_response:
            async for line in stream_response.aiter_lines():
                if not line.startswith("data: "):
                    continue

                event_data = line[6:]
                if event_data == "[DONE]":
                    break

                try:
                    event = json.loads(event_data)

                    # Track all commands
                    if event.get("type") == "command_execution":
                        cmd = event.get('data', {}).get('command', 'unknown')
                        commands_seen.append(cmd)
                        print(f"   [{len(commands_seen)}] {cmd}")

                    # Show intent
                    if event.get("type") == "intent":
                        intent = event.get("data", {}).get("message", "")
                        print(f"   💡 {intent[:100]}")

                except json.JSONDecodeError:
                    continue

        # Check results
        print(f"\n{'='*80}")
        print(f"Total commands: {len(commands_seen)}")

        # Check if we're using specific eventhubs commands (not generic azure)
        eventhub_specific = any('eventhub' in cmd.lower() for cmd in commands_seen)
        if eventhub_specific:
            print(f"✅ GOOD - Using eventhub-specific commands")
        else:
            print(f"⚠️  WARNING - Only generic azure commands, no eventhub-specific")

        print(f"\nCommands executed:")
        for i, cmd in enumerate(commands_seen, 1):
            print(f"  {i}. {cmd}")

    except Exception as e:
        print(f"\n❌ EXCEPTION: {e}")
    finally:
        await client.aclose()

if __name__ == "__main__":
    asyncio.run(run_test())
