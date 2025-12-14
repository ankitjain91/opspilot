
import httpx
import asyncio
import json

async def call_llm(prompt: str, endpoint: str, model: str, provider: str = "ollama", temperature: float = 0.3, force_json: bool = True) -> str:
    """Call the LLM endpoint (Ollama or OpenAI-compatible).

    Args:
        force_json: If True, forces JSON output format. Set to False for freeform markdown/text responses.
    """
    async with httpx.AsyncClient() as client:
        for attempt in range(3):
            try:
                if provider == "ollama":
                    # Ollama /api/generate
                    clean_endpoint = endpoint.rstrip('/').removesuffix('/v1').rstrip('/')
                    url = f"{clean_endpoint}/api/generate"
                    print(f"DEBUG: Calling Ollama: {url} | Model: {model} | JSON: {force_json}", flush=True)
                    print(f"DEBUG: Waiting for massive 70B model response (this can take 30-60s)...", flush=True)

                    payload = {
                        "model": model,
                        "prompt": prompt,
                        "stream": False,
                        "options": {
                            "num_predict": 4096,
                            "temperature": temperature,
                        }
                    }

                    # Only add format:json if explicitly requested
                    if force_json:
                        payload["format"] = "json"

                    response = await client.post(
                        url,
                        json=payload,
                        timeout=300.0
                    )
                    if response.status_code != 200:
                         print(f"Ollama Call Failed ({response.status_code}): {response.text}", flush=True)
                    
                    response.raise_for_status()
                    return response.json()['response']
                
                else:
                    # OpenAI-compatible
                    clean_endpoint = endpoint.rstrip('/')
                    url = f"{clean_endpoint}/chat/completions"
                    print(f"DEBUG: Calling OpenAI-compat: {url} | Model: {model}", flush=True)
                    
                    response = await client.post(
                        url,
                        json={
                            "model": model,
                            "messages": [{"role": "user", "content": prompt}],
                            "temperature": temperature,
                            "max_tokens": 4096,
                            "response_format": { "type": "json_object" }
                        },
                        timeout=60.0,
                        headers={"Authorization": "Bearer optional_key"}
                    )
                    
                    if response.status_code != 200:
                        print(f"LLM ERROR {response.status_code}: {response.text}", flush=True)
                        response.raise_for_status()

                    result = response.json()
                    res_text = result['choices'][0]['message']['content']
                    return res_text

            except Exception as e:
                print(f"LLM Call Failed (Attempt {attempt+1}): {e}", flush=True)
                if attempt == 2:
                    return f"Error calling LLM: {e}"
                await asyncio.sleep(2)
        return "Error: Max retries exhausted"
