
import httpx
import asyncio
import time
import json

OLLAMA_URL = "http://172.190.203.19:11434"
MODEL = "llama3.3:70b" # Or whatever model is expected, testing connection first.

async def test_ollama():
    print(f"--- Testing Ollama at {OLLAMA_URL} ---")
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        # 1. Test Connectivity / Version
        try:
            print("1. Checking version...")
            start = time.time()
            resp = await client.get(f"{OLLAMA_URL}/api/version")
            resp.raise_for_status()
            print(f"✅ Online! Version: {resp.json().get('version')} (Latency: {time.time() - start:.2f}s)")
        except Exception as e:
            print(f"❌ Failed to connect: {e}")
            return

        # 2. Test Model List
        try:
            print("\n2. Checking available models...")
            start = time.time()
            resp = await client.get(f"{OLLAMA_URL}/api/tags")
            resp.raise_for_status()
            models = [m['name'] for m in resp.json().get('models', [])]
            print(f"✅ Found {len(models)} models: {', '.join(models[:5])}...")
            print(f"   Latency: {time.time() - start:.2f}s")
        except Exception as e:
            print(f"❌ Failed to list models: {e}")
            return

        # 3. Test Generation (Small Prompt)
        target_model = models[0] if models else "llama3.3:70b"
        # Try to find the requested model or fallback
        if "ops-pilot-brain:latest" in models:
             target_model = "ops-pilot-brain:latest"
        elif "llama3.3:70b" in models:
             target_model = "llama3.3:70b"
        
        print(f"\n3. Testing generation with model '{target_model}'...")
        prompt = "What is 2+2? Answer in one word."
        
        try:
            start = time.time()
            resp = await client.post(
                f"{OLLAMA_URL}/api/generate",
                json={
                    "model": target_model,
                    "prompt": prompt,
                    "stream": False
                },
                timeout=60.0
            )
            resp.raise_for_status()
            data = resp.json()
            response_text = data.get('response', '').strip()
            total_time = time.time() - start
            
            print(f"✅ Response: '{response_text}'")
            print(f"   Total Time: {total_time:.2f}s")
            
            if total_time > 10:
                print("⚠️  Warning: Response was slow (>10s).")
            else:
                print("🚀 Fast response (<10s).")
                
        except httpx.ReadTimeout:
             print(f"❌ Timed out waiting for response (>60s). The model might be loading or too heavy.")
        except Exception as e:
            print(f"❌ Generation failed: {e}")

if __name__ == "__main__":
    asyncio.run(test_ollama())
