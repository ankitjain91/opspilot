#!/usr/bin/env python3
"""
Test script to validate Azure resources query handling.

Tests the agent's response when querying for Azure resources that don't exist,
to ensure proper fallback messaging instead of "Agent completed without a final response".
"""

import os
import sys
import httpx
import json
import time

# Configuration
AGENT_URL = "http://localhost:8899/investigate"
QUERY = "find all azure resources running in the cluster"

def test_azure_query():
    """Test Azure resources query via agent endpoint."""

    print("=" * 80)
    print("🧪 TESTING AZURE RESOURCES QUERY")
    print("=" * 80)
    print(f"\n📝 Query: '{QUERY}'")
    print(f"🔗 Endpoint: {AGENT_URL}")
    print("\n" + "-" * 80)

    payload = {
        "query": QUERY,
        "conversation_id": f"test-azure-{int(time.time())}",
        "context_name": "default",
        "namespace": "default"
    }

    try:
        print("\n🚀 Sending request...")

        with httpx.Client(timeout=120.0) as client:
            response = client.post(AGENT_URL, json=payload)

            print(f"\n✅ Response Status: {response.status_code}")

            if response.status_code == 200:
                # Parse SSE stream
                lines = response.text.strip().split('\n')
                final_answer = None
                commands_executed = []

                for line in lines:
                    if line.startswith('data: '):
                        try:
                            data = json.loads(line[6:])  # Remove 'data: ' prefix

                            if data.get('type') == 'command':
                                cmd = data.get('data', {}).get('command', 'N/A')
                                commands_executed.append(cmd)
                                print(f"  🔧 Command: {cmd}")

                            elif data.get('type') == 'answer':
                                final_answer = data.get('data', {}).get('message', '')

                            elif data.get('type') == 'error':
                                print(f"  ❌ Error: {data.get('data', {}).get('message', 'Unknown error')}")

                        except json.JSONDecodeError:
                            continue

                print("\n" + "=" * 80)
                print("📊 TEST RESULTS")
                print("=" * 80)

                print(f"\n✅ Commands Executed: {len(commands_executed)}")
                for i, cmd in enumerate(commands_executed, 1):
                    print(f"  {i}. {cmd}")

                print("\n📝 Final Answer:")
                print("-" * 80)
                if final_answer:
                    print(final_answer)

                    # Validate answer quality
                    if "Agent completed without a final response" in final_answer:
                        print("\n❌ TEST FAILED: Got catastrophic failure message!")
                        return False
                    elif not final_answer.strip():
                        print("\n❌ TEST FAILED: Empty response!")
                        return False
                    elif "No Azure resources found" in final_answer or "Azure" in final_answer:
                        print("\n✅ TEST PASSED: Got meaningful Azure-specific response!")
                        return True
                    else:
                        print("\n⚠️  TEST UNCLEAR: Got response but no Azure-specific messaging")
                        return True
                else:
                    print("❌ NO FINAL ANSWER RECEIVED!")
                    return False

            else:
                print(f"\n❌ HTTP Error: {response.status_code}")
                print(response.text)
                return False

    except httpx.ConnectError:
        print("\n❌ Connection Error: Agent server not running!")
        print("💡 Start it with: npm run tauri dev")
        return False

    except Exception as e:
        print(f"\n❌ Test Error: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    success = test_azure_query()
    sys.exit(0 if success else 1)
