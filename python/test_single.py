"""
Single Test Runner - Run one test at a time for iterative debugging
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

async def run_single_test(query: str, expected_max_commands: int = 10, expected_routing: str = "smart_executor"):
    """Run a single test and report results."""
    print(f"\n{'='*80}")
    print(f"TEST: {query}")
    print(f"Expected: {expected_routing}, ≤{expected_max_commands} commands")
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
                "thread_id": f"test_single",
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
                        elif "Delegating" in intent_msg:
                            actual_routing = "delegate"
                            print(f"   🔧 Routing: delegate")

                    # Show final answer
                    if event.get("type") == "final_answer":
                        answer = event.get("data", {}).get("answer", "")
                        print(f"\n   💬 Answer: {answer[:200]}...")

                except json.JSONDecodeError:
                    continue

        # Result
        print(f"\n{'='*80}")
        if command_count <= expected_max_commands and actual_routing == expected_routing:
            print(f"✅ PASS - {command_count} commands, routing={actual_routing}")
        else:
            print(f"❌ FAIL")
            if command_count > expected_max_commands:
                print(f"   • Too many commands: {command_count} > {expected_max_commands}")
            if actual_routing != expected_routing:
                print(f"   • Wrong routing: {actual_routing} ≠ {expected_routing}")
        print(f"{'='*80}\n")

        return command_count <= expected_max_commands and actual_routing == expected_routing

    except Exception as e:
        print(f"\n❌ EXCEPTION: {e}\n")
        return False
    finally:
        await client.aclose()


async def main():
    # Test the critical eventhub query
    query = sys.argv[1] if len(sys.argv) > 1 else "are all eventhub healthy in this cluster?"
    max_cmds = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    routing = sys.argv[3] if len(sys.argv) > 3 else "smart_executor"

    passed = await run_single_test(query, max_cmds, routing)
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    asyncio.run(main())
