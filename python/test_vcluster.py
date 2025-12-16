#!/usr/bin/env python3
"""
Simple test for vcluster CRD query
"""

import asyncio
import httpx
import json

REMOTE_ENDPOINT = "http://20.56.146.53:11434"
AGENT_SERVER = "http://localhost:8765"
TEST_QUERY = "find vclusters"
TEST_CONTEXT = "dedicated-aks-dev-eastus-ankitj"

async def test_vcluster():
    print("=" * 60)
    print(f"Testing: {TEST_QUERY}")
    print("=" * 60)

    payload = {
        "query": TEST_QUERY,
        "kube_context": TEST_CONTEXT,
        "llm_endpoint": REMOTE_ENDPOINT,
        "llm_provider": "ollama",
        "llm_model": "opspilot-brain:latest",
        "executor_model": "k8s-cli:latest",
    }

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream('POST', f"{AGENT_SERVER}/analyze", json=payload) as response:
                if response.status_code != 200:
                    print(f"❌ Error: {response.status_code}")
                    return

                print("\n📊 Events:")
                async for line in response.aiter_lines():
                    if not line or not line.startswith('data:'):
                        continue

                    try:
                        event = json.loads(line[5:].strip())
                        event_type = event.get('type')

                        if event_type == 'progress':
                            print(f"  {event.get('data', {}).get('message', '')}")
                        elif event_type == 'final_response':
                            print(f"\n✅ RESPONSE:\n{event.get('data', {}).get('response', '')}")
                    except:
                        pass

    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    asyncio.run(test_vcluster())
