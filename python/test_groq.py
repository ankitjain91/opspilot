"""
Test with Groq instead of Ollama for faster supervisor calls
"""
import asyncio
import httpx
import json
import os
import sys

AGENT_SERVER_URL = "http://localhost:8766"
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
BRAIN_MODEL = "llama-3.3-70b-versatile"  # Groq's 70B model for supervisor
EXECUTOR_MODEL = "qwen-2.5-coder-32b-instruct"  # Groq's Qwen 32B for executor
KUBE_CONTEXT = "vcluster_management-cluster_taasvstst_dedicated-aks-dev-eastus-ankitj"

async def run_test():
    """Run test with Groq for supervisor."""
    query = "find eventhubs"
    print(f"\n{'='*80}")
    print(f"TEST: {query}")
    print(f"Using Groq: Brain={BRAIN_MODEL}, Executor={EXECUTOR_MODEL}")
    print(f"{'='*80}\n")

    client = httpx.AsyncClient(timeout=300.0)
    command_count = 0
    actual_routing = None

    try:
        async with client.stream(
            "POST",
            f"{AGENT_SERVER_URL}/analyze",
            json={
                "query": query,
                "thread_id": "test_groq",
                "kube_context": KUBE_CONTEXT,
                "llm_endpoint": "https://api.groq.com/openai/v1",  # Groq official API
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

                    # Track commands
                    if event.get("type") == "command_execution":
                        command_count += 1
                        cmd = event.get('data', {}).get('command', 'unknown')
                        print(f"   [{command_count}] {cmd}")

                    # Detect routing
                    if event.get("type") == "intent":
                        intent_msg = event.get("data", {}).get("message", "")
                        if "SmartExecutor activated" in intent_msg:
                            actual_routing = "smart_executor"
                            print(f"   🎯 Routing: smart_executor")
                        elif "Creating plan" in intent_msg or "Plan created" in intent_msg:
                            actual_routing = "create_plan"
                            print(f"   📋 Routing: create_plan")

                    # Show final answer
                    if event.get("type") == "final_answer":
                        answer = event.get("data", {}).get("answer", "")
                        print(f"\n   💬 Answer: {answer[:300]}...")

                except json.JSONDecodeError:
                    continue

        # Result
        print(f"\n{'='*80}")
        if command_count <= 3 and actual_routing == "smart_executor":
            print(f"✅ PASS - {command_count} commands, routing={actual_routing}")
            return True
        else:
            print(f"❌ FAIL - {command_count} commands, routing={actual_routing}")
            return False

    except Exception as e:
        print(f"\n❌ EXCEPTION: {e}\n")
        return False
    finally:
        await client.aclose()


if __name__ == "__main__":
    result = asyncio.run(run_test())
    sys.exit(0 if result else 1)
