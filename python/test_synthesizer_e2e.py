#!/usr/bin/env python3
"""
End-to-End Test for Synthesizer Node

Tests the complete flow:
1. Query submission
2. Evidence collection
3. Synthesizer decision (can answer?)
4. Response quality

Uses remote model at http://20.56.146.53:11434
"""

import asyncio
import httpx
import json
import sys

# Remote LLM endpoint
REMOTE_ENDPOINT = "http://20.56.146.53:11434"
AGENT_SERVER = "http://localhost:8765"

# Test query
TEST_QUERY = "find cluster issues"
TEST_CONTEXT = "dedicated-aks-dev-eastus-ankitj"

async def test_query_flow():
    """Test end-to-end query flow with Synthesizer."""

    print("=" * 80)
    print("🧪 SYNTHESIZER END-TO-END TEST")
    print("=" * 80)
    print(f"Remote LLM: {REMOTE_ENDPOINT}")
    print(f"Agent Server: {AGENT_SERVER}")
    print(f"Query: '{TEST_QUERY}'")
    print(f"Context: {TEST_CONTEXT}")
    print("=" * 80)
    print()

    # Check remote LLM is accessible
    print("1️⃣ Checking remote LLM connectivity...")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{REMOTE_ENDPOINT}/api/tags")
            if response.status_code == 200:
                models = response.json().get('models', [])
                print(f"✅ Remote LLM accessible - {len(models)} models available")
                for model in models[:3]:
                    print(f"   - {model.get('name', 'unknown')}")
            else:
                print(f"❌ Remote LLM returned {response.status_code}")
                return False
    except Exception as e:
        print(f"❌ Cannot reach remote LLM: {e}")
        return False

    print()

    # Send query to agent
    print("2️⃣ Sending query to agent server...")

    payload = {
        "query": TEST_QUERY,
        "kube_context": TEST_CONTEXT,
        "llm_endpoint": REMOTE_ENDPOINT,
        "llm_provider": "ollama",
        "llm_model": "opspilot-brain:latest",
        "executor_model": "k8s-cli:latest",
        "embedding_model": "nomic-embed-text",
        "embedding_endpoint": REMOTE_ENDPOINT,
    }

    events = []
    synthesizer_logs = []
    response_quality_logs = []

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            print(f"📤 POST {AGENT_SERVER}/analyze")
            print(f"   Payload: {json.dumps(payload, indent=2)}")
            print()

            async with client.stream('POST', f"{AGENT_SERVER}/analyze", json=payload) as stream_response:
                if stream_response.status_code != 200:
                    print(f"❌ Agent server returned {stream_response.status_code}")
                    return False

                print("📊 Streaming events:")
                print("-" * 80)

                async for line in stream_response.aiter_lines():
                    if not line or not line.startswith('data:'):
                        continue

                    data_str = line[5:].strip()  # Remove 'data:' prefix
                    if not data_str:
                        continue

                    try:
                        event = json.loads(data_str)
                        events.append(event)

                        event_type = event.get('type')
                        data = event.get('data', {})

                        # Log all events
                        if event_type == 'progress':
                            msg = data.get('message', '')
                            print(f"  🔄 {msg}")

                            # Track synthesizer activity
                            if 'synthesiz' in msg.lower():
                                synthesizer_logs.append(msg)

                        elif event_type == 'reflection':
                            assessment = data.get('assessment', '')
                            reasoning = data.get('reasoning', '')
                            print(f"  🧠 Reflection: {assessment}")
                            if reasoning:
                                print(f"     Reason: {reasoning[:100]}")

                        elif event_type == 'final_response':
                            response = data.get('response', '')
                            print(f"  ✅ FINAL RESPONSE:")
                            print(f"     {response[:200]}...")
                            response_quality_logs.append(response)

                        elif event_type == 'error':
                            print(f"  ❌ ERROR: {data.get('message', 'unknown')}")

                    except json.JSONDecodeError:
                        continue

                print("-" * 80)

    except httpx.TimeoutException:
        print("❌ Request timed out after 120s")
        return False
    except Exception as e:
        print(f"❌ Error during query: {e}")
        import traceback
        traceback.print_exc()
        return False

    print()
    print("=" * 80)
    print("📈 TEST RESULTS")
    print("=" * 80)

    # Analyze results
    print(f"\n1. Total Events: {len(events)}")
    print(f"2. Synthesizer Activity: {len(synthesizer_logs)} events")
    for log in synthesizer_logs:
        print(f"   - {log}")

    print(f"\n3. Final Responses: {len(response_quality_logs)}")
    if response_quality_logs:
        response = response_quality_logs[0]
        print(f"   Length: {len(response)} chars")
        print(f"   Preview: {response[:300]}...")

        # Check quality markers
        has_issues_section = any(marker in response for marker in ['issues', 'problems', 'errors'])
        has_vague_language = any(phrase in response.lower() for phrase in ['some components', 'certain issues', 'various problems'])
        is_specific = any(word in response for word in ['Node', 'Pod', 'name:', 'namespace'])

        print(f"\n4. Quality Checks:")
        print(f"   ✅ Has issues section: {has_issues_section}")
        print(f"   {'❌' if has_vague_language else '✅'} Avoids vague language: {not has_vague_language}")
        print(f"   ✅ Is specific: {is_specific}")

        # Overall assessment
        if has_issues_section and not has_vague_language and is_specific:
            print(f"\n✅ OVERALL: Response quality is GOOD")
            return True
        else:
            print(f"\n⚠️  OVERALL: Response quality needs improvement")
            return False
    else:
        print("❌ No final response received")
        return False


async def main():
    success = await test_query_flow()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    asyncio.run(main())
