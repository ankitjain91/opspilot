"""
Simple smoke test to verify server and dependencies are working.
"""
import asyncio
import httpx
import json
import sys

AGENT_SERVER_URL = "http://localhost:8766"
LLM_HOST = "http://20.56.146.53:11434"
BRAIN_MODEL = "opspilot-brain:latest"
EXECUTOR_MODEL = "qwen2.5:72b"
KUBE_CONTEXT = "vcluster_management-cluster_taasvstst_dedicated-aks-dev-eastus-ankitj"


async def smoke_test():
    """Run a simple test to verify everything works."""
    print("🔥 SMOKE TEST")
    print("=" * 80)

    # Test 1: Health check
    print("\n1️⃣ Testing server health...")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{AGENT_SERVER_URL}/health")
            response.raise_for_status()
            print(f"   ✅ Server is healthy: {response.json()}")
    except Exception as e:
        print(f"   ❌ Health check failed: {e}")
        return False

    # Test 2: Simple query
    print("\n2️⃣ Testing simple query: 'list pods'...")
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            event_count = 0
            got_answer = False

            async with client.stream(
                "POST",
                f"{AGENT_SERVER_URL}/analyze",
                json={
                    "query": "list pods",
                    "thread_id": "smoke_test",
                    "kube_context": KUBE_CONTEXT,
                    "llm_endpoint": LLM_HOST,
                    "llm_provider": "ollama",
                    "llm_model": BRAIN_MODEL,
                    "executor_model": EXECUTOR_MODEL,
                }
            ) as stream_response:
                async for line in stream_response.aiter_lines():
                    if not line.startswith("data: "):
                        continue

                    event_data = line[6:]
                    if event_data == "[DONE]":
                        print(f"   ✅ Stream completed")
                        break

                    try:
                        event = json.loads(event_data)
                        event_count += 1
                        event_type = event.get("type", "unknown")

                        if event_type == "final_answer":
                            answer = event.get("data", {}).get("answer", "")
                            print(f"   ✅ Got final answer ({len(answer)} chars)")
                            got_answer = True
                        elif event_type == "command_execution":
                            cmd = event.get("data", {}).get("command", "unknown")
                            print(f"   📝 Command: {cmd}")
                        elif event_type == "intent":
                            msg = event.get("data", {}).get("message", "")
                            print(f"   💡 Intent: {msg}")
                    except json.JSONDecodeError:
                        continue

            print(f"   📊 Received {event_count} events total")

            if not got_answer:
                print(f"   ❌ No final answer received!")
                return False

    except Exception as e:
        print(f"   ❌ Query failed: {e}")
        import traceback
        traceback.print_exc()
        return False

    print("\n" + "=" * 80)
    print("✅ SMOKE TEST PASSED - Server and dependencies are working!")
    print("=" * 80)
    return True


async def main():
    success = await smoke_test()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    asyncio.run(main())
