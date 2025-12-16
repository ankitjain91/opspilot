
import httpx
import asyncio
import json
import os
from typing import Optional, Dict, Any, List

class SmartLLMClient:
    """Resilient LLM Client with automatic provider fallback."""
    
    def __init__(self):
        self.openai_api_key = os.environ.get("OPENAI_API_KEY")
        self.groq_api_key = os.environ.get("GROQ_API_KEY")
        
        # Track provider status to avoid retrying dead providers repeatedly in a loop
        # Track provider status to avoid retrying dead providers repeatedly in a loop
        # Default to True (optimistic) - we only mark False if a call actually fails.
        # This is critical for dynamic API keys where env var might be missing but UI passes a key.
        self.provider_health = {
            "ollama": True,
            "groq": True,
            "openai": True
        }

    async def call(self, prompt: str, endpoint: str, model: str, provider: str = "ollama", temperature: float = 0.3, force_json: bool = True, api_key: str | None = None) -> str:
        """Call LLM with fallback logic: Primary -> Groq -> OpenAI."""
        
        # 1. Try Primary Provider
        try:
            # If an explicit API key is provided, reset health for that provider
            if provider == "groq" and api_key:
                self.provider_health["groq"] = True
            if provider == "openai" and api_key:
                self.provider_health["openai"] = True

            if provider == "ollama" and self.provider_health["ollama"]:
                result = await self._call_ollama(prompt, endpoint, model, temperature, force_json)
                self.provider_health["ollama"] = True
                return result
            elif provider == "groq":
                 # Use passed key or env key
                 effective_key = api_key or self.groq_api_key
                 if effective_key and self.provider_health["groq"]:
                     result = await self._call_groq(prompt, model, temperature, force_json, effective_key, endpoint)
                     self.provider_health["groq"] = True
                     return result
                 else:
                     print(f"DEBUG: Skipping Groq - Key: {bool(effective_key)}, Health: {self.provider_health['groq']}", flush=True)
            elif provider == "openai":
                 effective_key = api_key or self.openai_api_key
                 if effective_key and self.provider_health["openai"]:
                     result = await self._call_openai(prompt, model, temperature, force_json, effective_key, endpoint)
                     self.provider_health["openai"] = True
                     return result
                 else:
                     print(f"DEBUG: Skipping OpenAI - Key: {bool(effective_key)}, Health: {self.provider_health['openai']}", flush=True)
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout) as e:
            print(f"⚠️ Primary provider ({provider}) failed: {e}. Switching to fallback...", flush=True)
            self.provider_health[provider] = False
        except Exception as e:
            print(f"⚠️ Primary provider ({provider}) error: {e}", flush=True)
            self.provider_health[provider] = False
        
        # 2. First Fallback: Groq (Fast & Cheap)
        # Note: We probably don't have a fallback key if the primary key failed, but we check env
        if provider != "groq" and self.provider_health["groq"] and self.groq_api_key:
            print(f"🔄 Attempting fallback to Groq (llama3-70b-8192)...", flush=True)
            try:
                # Default to a strong model for fallback
                return await self._call_groq(prompt, "llama3-70b-8192", temperature, force_json, self.groq_api_key)
            except Exception as e:
                print(f"⚠️ Groq fallback failed: {e}", flush=True)
                self.provider_health["groq"] = False

        # 3. Final Fallback: OpenAI (Reliable)
        if provider != "openai" and self.provider_health["openai"] and self.openai_api_key:
            print(f"🔄 Attempting fallback to OpenAI (gpt-4o-mini)...", flush=True)
            try:
                return await self._call_openai(prompt, "gpt-4o-mini", temperature, force_json, self.openai_api_key)
            except Exception as e:
                 return f"Error: All providers failed. Primary: {provider}. Fallback (OpenAI): {e}"
        return f"Error: LLM call failed and no working fallback available. Primary: {provider}"

    async def _call_ollama(self, prompt: str, endpoint: str, model: str, temperature: float, force_json: bool) -> str:
        async with httpx.AsyncClient() as client:
            clean_endpoint = endpoint.rstrip('/').removesuffix('/v1').rstrip('/')
            url = f"{clean_endpoint}/api/generate"
            
            payload = {
                "model": model,
                "prompt": prompt,
                "stream": False,
                "keep_alive": -1,  # Keep model loaded in memory indefinitely
                "options": {
                    "num_predict": 4096,
                    "temperature": temperature,
                }
            }
            if force_json:
                payload["format"] = "json"

            print(f"DEBUG: Calling Ollama: {url} | Model: {model} | JSON: {force_json}", flush=True)
            response = await client.post(url, json=payload, timeout=300.0)
            
            if response.status_code != 200:
                raise Exception(f"Ollama API Error ({response.status_code}): {response.text}")
            
            return response.json()['response']

    async def _call_groq(self, prompt: str, model: str, temperature: float, force_json: bool, api_key: str, endpoint: str | None = None) -> str:
        async with httpx.AsyncClient() as client:
            # Use provided endpoint if it's set and not the Ollama default, otherwise use official API
            if endpoint and "localhost" not in endpoint and "127.0.0.1" not in endpoint:
                 url = f"{endpoint.rstrip('/')}/chat/completions"
            else:
                 url = "https://api.groq.com/openai/v1/chat/completions"

            payload = {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": temperature,
                "max_tokens": 4096,
            }
            if force_json:
                payload["response_format"] = { "type": "json_object" }

            safe_key = f"...{api_key[-4:]}" if api_key and len(api_key)>4 else "INVALID/SHORT"
            print(f"DEBUG: Calling Groq: {url} | Model: {model} | JSON: {force_json} | Key: {safe_key}", flush=True)
            
            response = await client.post(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=30.0
            )

            # Retry logic for 400 Bad Request (often JSON mode validation failure)
            if response.status_code == 400 and force_json:
                print(f"DEBUG: Groq 400 Error (JSON Mode validation?): {response.text}. Retrying without forced JSON mode...", flush=True)
                
                # Create a fresh payload for retry to avoid mutating the original (cleaner reference)
                retry_payload = payload.copy()
                if "response_format" in retry_payload:
                    del retry_payload["response_format"]
                
                response = await client.post(
                    url,
                    json=retry_payload,
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=30.0
                )

            if response.status_code != 200:
                print(f"DEBUG: Groq Error ({response.status_code}): {response.text}", flush=True)
                raise Exception(f"Groq API Error ({response.status_code}): {response.text}")

            result = response.json()
            return result['choices'][0]['message']['content']

    async def _call_openai(self, prompt: str, model: str, temperature: float, force_json: bool, api_key: str, endpoint: str | None = None) -> str:
        async with httpx.AsyncClient() as client:
            # Use provided endpoint if set and not Ollama default
            if endpoint and "localhost" not in endpoint and "127.0.0.1" not in endpoint:
                # If endpoint ends with /v1, don't append it again? Standardize on user providing base URL
                base = endpoint.rstrip('/')
                url = f"{base}/chat/completions" if "/chat/completions" not in base else base
            else:
                url = "https://api.openai.com/v1/chat/completions"

            payload = {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": temperature,
                "max_tokens": 4096,
            }
            if force_json:
                payload["response_format"] = { "type": "json_object" }

            response = await client.post(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=30.0
            )

            if response.status_code != 200:
                raise Exception(f"OpenAI API Error ({response.status_code}): {response.text}")

            result = response.json()
            return result['choices'][0]['message']['content']

    async def list_models(self, provider: str, api_key: str | None = None, base_url: str | None = None) -> List[str]:
        """Fetch available models from the provider."""
        try:
            async with httpx.AsyncClient() as client:
                if provider == "groq":
                    key = api_key or self.groq_api_key
                    if not key: return []
                    url = "https://api.groq.com/openai/v1/models"
                    resp = await client.get(url, headers={"Authorization": f"Bearer {key}"}, timeout=10.0)
                    if resp.status_code == 200:
                        return sorted([m["id"] for m in resp.json().get("data", [])])
                
                elif provider == "openai":
                    key = api_key or self.openai_api_key
                    if not key: return []
                    url = "https://api.openai.com/v1/models"
                    resp = await client.get(url, headers={"Authorization": f"Bearer {key}"}, timeout=10.0)
                    if resp.status_code == 200:
                        # Filter for gpt models to avoid embedding/dall-e noise
                        return sorted([m["id"] for m in resp.json().get("data", []) if "gpt" in m["id"]])

                elif provider == "anthropic":
                     # Anthropic doesn't have a public models endpoint that lists them easily like OpenAI format
                     # usually, but let's skip or hardcode popular ones if we want, or just return empty.
                     # For now, return empty as they don't have a dynamic list endpoint in the same way.
                     pass

                elif provider == "ollama" or provider == "local":
                    # Ollama endpoint
                    endpoint = base_url or "http://localhost:11434"
                    clean_endpoint = endpoint.rstrip('/').removesuffix('/v1').rstrip('/')
                    url = f"{clean_endpoint}/api/tags"
                    resp = await client.get(url, timeout=5.0)
                    if resp.status_code == 200:
                        return sorted([m["name"] for m in resp.json().get("models", [])])
        except Exception as e:
            print(f"Error fetching models for {provider}: {e}")
        
        return []

# Global singleton
_client = SmartLLMClient()

async def call_llm(prompt: str, endpoint: str, model: str, provider: str = "ollama", temperature: float = 0.3, force_json: bool = True, api_key: str | None = None) -> str:
    """Public wrapper for the smart client."""
    return await _client.call(prompt, endpoint, model, provider, temperature, force_json, api_key)

async def list_available_models(provider: str, api_key: str | None = None, base_url: str | None = None) -> List[str]:
    """Public wrapper to fetch available models."""
    return await _client.list_models(provider, api_key, base_url)
