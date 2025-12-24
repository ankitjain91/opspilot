"""
Claude Code CLI Backend Integration

This module provides an async interface to Claude Code CLI, allowing the agent
to use Claude Code as an LLM backend instead of direct API calls.

Key Features:
1. Subprocess-based execution of `claude` CLI
2. Streaming output parsing
3. JSON response extraction
4. Session management for multi-turn conversations
5. Tool use extraction for command execution
6. Response caching for identical queries (token optimization)
"""

import asyncio
import json
import re
import subprocess
import hashlib
import time
from typing import AsyncIterator, Dict, Any, Optional, List, Tuple
from dataclasses import dataclass, field
from collections import OrderedDict


# ============================================================================
# RESPONSE CACHE - Token Optimization
# ============================================================================

class ResponseCache:
    """
    LRU cache for full Claude Code responses.

    Caches responses for identical queries to avoid redundant LLM calls.
    TTL-based expiration ensures fresh data for cluster state queries.
    """

    def __init__(self, max_size: int = 50, ttl_seconds: int = 120):
        self.max_size = max_size
        self.ttl_seconds = ttl_seconds
        self._cache: OrderedDict[str, Tuple[str, float]] = OrderedDict()
        self._hits = 0
        self._misses = 0

    def _get_key(self, prompt: str, context: str = "") -> str:
        """Generate cache key from prompt and context."""
        combined = f"{prompt}|{context}"
        return hashlib.sha256(combined.encode()).hexdigest()[:24]

    def get(self, prompt: str, context: str = "") -> Optional[str]:
        """Get cached response if available and not expired."""
        key = self._get_key(prompt, context)

        if key in self._cache:
            response, timestamp = self._cache[key]
            if time.time() - timestamp < self.ttl_seconds:
                # Move to end (most recently used)
                self._cache.move_to_end(key)
                self._hits += 1
                return response
            else:
                # Expired - remove
                del self._cache[key]

        self._misses += 1
        return None

    def set(self, prompt: str, response: str, context: str = ""):
        """Store response in cache."""
        key = self._get_key(prompt, context)

        # Evict oldest if full
        while len(self._cache) >= self.max_size:
            self._cache.popitem(last=False)

        self._cache[key] = (response, time.time())

    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics."""
        total = self._hits + self._misses
        hit_rate = (self._hits / total * 100) if total > 0 else 0
        return {
            'hits': self._hits,
            'misses': self._misses,
            'size': len(self._cache),
            'hit_rate_percent': round(hit_rate, 2)
        }

    def clear(self):
        """Clear all cached responses."""
        self._cache.clear()


# Global response cache instance
_response_cache: Optional[ResponseCache] = None


def get_response_cache() -> ResponseCache:
    """Get or create the global response cache."""
    global _response_cache
    if _response_cache is None:
        _response_cache = ResponseCache(
            max_size=50,  # Cache last 50 unique queries
            ttl_seconds=120  # 2 minute TTL for cluster state freshness
        )
    return _response_cache


@dataclass
class TokenUsage:
    """Token usage statistics."""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def add(self, other: 'TokenUsage') -> None:
        """Accumulate usage from another TokenUsage instance."""
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.cache_creation_tokens += other.cache_creation_tokens

    def to_dict(self) -> Dict[str, int]:
        return {
            'input_tokens': self.input_tokens,
            'output_tokens': self.output_tokens,
            'cache_read_tokens': self.cache_read_tokens,
            'cache_creation_tokens': self.cache_creation_tokens,
            'total_tokens': self.total_tokens
        }


@dataclass
class ClaudeCodeResponse:
    """Structured response from Claude Code CLI."""
    content: str
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    thinking: str = ""
    is_complete: bool = False
    raw_output: str = ""
    usage: Optional[TokenUsage] = None


class ClaudeCodeBackend:
    """
    Backend wrapper for Claude Code CLI.

    Usage:
        backend = ClaudeCodeBackend()
        response = await backend.call("What pods are failing?", system_prompt="You are a K8s expert")
    """

    def __init__(self, working_dir: str = None):
        self.working_dir = working_dir
        self.session_id: Optional[str] = None
        self.session_usage: TokenUsage = TokenUsage()  # Accumulated usage for current session
        self._check_claude_installed()

    def _check_claude_installed(self) -> bool:
        """Check if claude CLI is available."""
        try:
            result = subprocess.run(
                ["claude", "--version"],
                capture_output=True,
                text=True,
                timeout=5
            )
            return result.returncode == 0
        except (subprocess.SubprocessError, FileNotFoundError):
            return False

    def _build_json_agent_prompt(self, prompt: str, system_prompt: str = None) -> str:
        """Build a prompt that forces JSON-only output for K8s agent mode."""
        json_instructions = """You are a K8s JSON agent. Output ONLY valid JSON in this exact format, nothing else:

{"thought": "your reasoning", "next_action": "delegate", "plan": "{\\\"tool\\\": \\\"run_k8s_python\\\", \\\"code\\\": \\\"python code here\\\"}"}

Rules:
- Output ONLY the JSON object, no markdown, no explanation
- The "plan" field must be a JSON STRING (escaped) containing tool and code
- next_action: "delegate" to run Python code, "respond" to give final answer
- When next_action is "respond", include "final_response" field instead of plan
- Do NOT use Bash, kubectl, or any shell commands
- The Python environment has pre-loaded: v1 (CoreV1Api), apps_v1, batch_v1, networking_v1, custom
- Always use print() for output in Python code
- IMPORTANT: The "plan" value must be a string, not an object. Escape the inner JSON.

Example for delegate:
{"thought": "Need to count pods", "next_action": "delegate", "plan": "{\\\"tool\\\": \\\"run_k8s_python\\\", \\\"code\\\": \\\"pods = v1.list_pod_for_all_namespaces()\\\\nprint(len(pods.items))\\\"}"}

Example for respond:
{"thought": "Analysis complete", "next_action": "respond", "final_response": "Your cluster has 50 pods running."}

"""
        if system_prompt:
            json_instructions += f"\nAdditional context:\n{system_prompt}\n\n"

        return f"{json_instructions}Query: {prompt}"

    async def call(
        self,
        prompt: str,
        system_prompt: str = None,
        force_json: bool = False,
        temperature: float = 0.3,
        continue_session: bool = False,
        timeout: float = 90.0
    ) -> str:
        """
        Call Claude Code CLI with prompt and return response.

        Args:
            prompt: User prompt/question
            system_prompt: System instructions (appended to prompt if provided)
            force_json: Request JSON output format
            temperature: Not directly supported, included for API compatibility
            continue_session: Continue previous conversation
            timeout: Command timeout in seconds

        Returns:
            Response text from Claude Code
        """
        # Build the command
        cmd = ["claude", "-p"]  # -p for print mode (non-interactive)
        cmd.append("--verbose")  # Required for stream-json output

        # Add output format for structured parsing
        cmd.extend(["--output-format", "stream-json"])

        # Permission mode - accept edits for agent automation
        cmd.extend(["--permission-mode", "acceptEdits"])

        # Continue session if requested
        if continue_session and self.session_id:
            cmd.extend(["--continue", self.session_id])

        # Build full prompt with JSON agent instructions
        if force_json:
            # Wrap prompt with explicit JSON-only instructions
            full_prompt = self._build_json_agent_prompt(prompt, system_prompt)
        else:
            full_prompt = prompt
            if system_prompt:
                full_prompt = f"{system_prompt}\n\n---\n\n{prompt}"

        # Add the prompt
        cmd.append(full_prompt)

        try:
            # Run claude CLI as subprocess
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.working_dir,
                # Don't inherit stdin to prevent waiting for input
                stdin=asyncio.subprocess.DEVNULL
            )

            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout
            )

            output = stdout.decode('utf-8', errors='replace')
            error_output = stderr.decode('utf-8', errors='replace')

            if error_output:
                print(f"[claude-code] stderr: {error_output[:500]}", flush=True)

            # Parse the stream-json output
            response = self._parse_stream_json_output(output)

            # Extract session ID for continuation
            session_match = re.search(r'session[_-]?id["\s:]+([a-zA-Z0-9_-]+)', output, re.IGNORECASE)
            if session_match:
                self.session_id = session_match.group(1)

            # Strip markdown code blocks if present (Claude often wraps JSON in ```json...```)
            content = self._strip_markdown_code_blocks(response.content)
            print(f"[claude-code] 📤 Response content ({len(content)} chars): {content[:500]}...", flush=True)

            # Validate JSON if force_json was requested
            if force_json and content:
                try:
                    # Try to parse as JSON to validate
                    parsed = json.loads(content)
                    print(f"[claude-code] ✅ Valid JSON with keys: {parsed.keys() if isinstance(parsed, dict) else 'not-dict'}", flush=True)
                    if isinstance(parsed, dict) and 'plan' in parsed:
                        print(f"[claude-code] 📋 Plan field ({len(str(parsed['plan']))} chars): {str(parsed['plan'])[:300]}", flush=True)
                except json.JSONDecodeError as e:
                    # JSON is invalid/truncated - try to fix common issues
                    print(f"[claude-code] Warning: Invalid JSON response, attempting repair: {e}", flush=True)
                    print(f"[claude-code] 🔍 Pre-repair content ({len(content)} chars): {content[:600]}...", flush=True)
                    content = self._attempt_json_repair(content)
                    print(f"[claude-code] 🔧 Post-repair content ({len(content)} chars): {content[:600]}...", flush=True)

            return content

        except asyncio.TimeoutError:
            return f"Error: Claude Code CLI timed out after {timeout} seconds"
        except Exception as e:
            return f"Error calling Claude Code CLI: {str(e)}"

    async def call_streaming(
        self,
        prompt: str,
        system_prompt: str = None,
        force_json: bool = False,
        continue_session: bool = False
    ) -> AsyncIterator[str]:
        """
        Stream responses from Claude Code CLI.

        Yields chunks of response as they arrive.
        """
        cmd = ["claude", "-p", "--output-format", "stream-json", "--permission-mode", "acceptEdits"]

        if continue_session and self.session_id:
            cmd.extend(["--continue", self.session_id])

        full_prompt = prompt
        if system_prompt:
            full_prompt = f"{system_prompt}\n\n---\n\n{prompt}"

        if force_json:
            full_prompt += "\n\nRespond with valid JSON only."

        cmd.append(full_prompt)

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.working_dir
        )

        accumulated_content = ""

        async for line in process.stdout:
            line_str = line.decode('utf-8', errors='replace').strip()
            if not line_str:
                continue

            try:
                event = json.loads(line_str)
                event_type = event.get('type', '')

                if event_type == 'assistant':
                    # Assistant message content
                    content = event.get('message', {}).get('content', [])
                    for block in content:
                        if block.get('type') == 'text':
                            text = block.get('text', '')
                            accumulated_content += text
                            yield text

                elif event_type == 'content_block_delta':
                    # Streaming delta
                    delta = event.get('delta', {})
                    if delta.get('type') == 'text_delta':
                        text = delta.get('text', '')
                        accumulated_content += text
                        yield text

            except json.JSONDecodeError:
                # Non-JSON line, might be raw output
                if line_str and not line_str.startswith('{'):
                    yield line_str + "\n"

        await process.wait()

    async def compact(self) -> str:
        """Run /compact slash command to reduce context size."""
        if not self.session_id:
            return "No active session to compact"
        
        print(f"[claude-code] 🧹 Compacting session {self.session_id}", flush=True)
        return await self.call("/compact", continue_session=True, timeout=30.0)

    async def get_usage(self) -> Dict[str, Any]:
        """Get usage info including session token counts and /cost command output."""
        result = {
            "session_tokens": self.session_usage.to_dict(),
            "cost_info": None,
            "subscription_type": "unknown"
        }

        # Run /cost slash command to get billing info
        cmd = ["claude", "-p", "/cost", "--output-format", "stream-json", "--verbose"]

        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.DEVNULL,
                cwd=self.working_dir
            )

            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=10.0)
            output = stdout.decode('utf-8', errors='replace')

            # Parse the output for cost info
            for line in output.split('\n'):
                if not line.strip(): continue
                try:
                    event = json.loads(line)
                    if event.get('type') == 'user':
                        content = event.get('message', {}).get('content', '')
                        if '<local-command-stdout>' in content:
                            cost_text = content.replace('<local-command-stdout>', '').replace('</local-command-stdout>', '').strip()
                            result["cost_info"] = cost_text
                            # Detect subscription type
                            if "Claude Max subscription" in cost_text or "subscription includes" in cost_text:
                                result["subscription_type"] = "max"
                            elif "$" in cost_text or "cost" in cost_text.lower():
                                result["subscription_type"] = "api"
                except:
                    continue

        except Exception as e:
            result["cost_info"] = f"Error fetching usage: {e}"

        return result

    def get_session_usage(self) -> Dict[str, int]:
        """Get current session token usage."""
        return self.session_usage.to_dict()

    def reset_session_usage(self) -> None:
        """Reset session token counters."""
        self.session_usage = TokenUsage()

    async def call_streaming_with_tools(
        self,
        prompt: str,
        system_prompt: str = None,
        tool_executor: callable = None,
        temperature: float = 0.2,
        kube_context: str = None,
        session_id: str = None,
        conversation_history: List[Dict[str, str]] = None,
        mcp_config: dict = None,  # MCP server config to pass to Claude CLI
        restricted_tools: bool = False,  # If True, blocks kubectl and other non-search commands
        working_dir: str = None  # Override working directory for this call
    ) -> AsyncIterator[dict]:
        """
        Stream responses from Claude Code CLI with native tool execution.

        Claude Code handles its own tool loop internally. We just:
        1. Set up the environment (kubeconfig)
        2. Pass the prompt with system context
        3. Stream back events as Claude Code executes tools

        The key is that Claude Code uses its native Bash tool to run kubectl/python.

        Args:
            session_id: Optional session ID to continue conversation (uses --resume)
            conversation_history: List of previous messages [{"role": "user/assistant", "content": "..."}]
                                 When provided, history is prepended to the prompt for context.

        Yields event dicts with types:
        - {'type': 'thinking', 'content': '...'}
        - {'type': 'tool_use', 'tool': '...', 'input': {...}}
        - {'type': 'tool_result', 'output': '...'}
        - {'type': 'text', 'content': '...'}
        - {'type': 'error', 'message': '...'}
        - {'type': 'done', 'final_text': '...'}
        """
        # Build command with streaming output
        # IMPORTANT: Use bypassPermissions to allow kubectl execution without prompts
        cmd = [
            "claude", "-p",
            "--output-format", "stream-json",
            "--permission-mode", "bypassPermissions",
            "--verbose",
            # Block all write operations - READ ONLY mode for safety
            # Each tool must be a separate --disallowedTools argument
            "--disallowedTools", "Edit",
            "--disallowedTools", "Write",
            "--disallowedTools", "NotebookEdit",
        ]

        # Add MCP server config if provided - merge with user's existing config
        mcp_config_file = None
        if mcp_config:
            import tempfile
            import os as _os
            try:
                # Start with user's existing ~/.claude/settings.json
                user_config_path = _os.path.expanduser("~/.claude/settings.json")
                merged_config = {}

                if _os.path.exists(user_config_path):
                    try:
                        with open(user_config_path, 'r') as f:
                            merged_config = json.load(f)
                        print(f"[claude-code-streaming] 📄 Loaded existing config from {user_config_path}", flush=True)
                    except Exception as e:
                        print(f"[claude-code-streaming] ⚠️ Could not read existing config: {e}", flush=True)

                # Merge OpsPilot's MCP servers with existing ones (OpsPilot servers take precedence)
                existing_mcp = merged_config.get('mcpServers', {})
                opspilot_mcp = mcp_config.get('mcpServers', {})
                merged_mcp = {**existing_mcp, **opspilot_mcp}
                merged_config['mcpServers'] = merged_mcp

                # Write merged config to a temp file
                fd, mcp_config_file = tempfile.mkstemp(suffix='.json', prefix='opspilot_mcp_')
                with _os.fdopen(fd, 'w') as f:
                    json.dump(merged_config, f, indent=2)

                cmd.extend(["--mcp-config", mcp_config_file])
                # Use strict mode so Claude uses ONLY this merged config file
                cmd.append("--strict-mcp-config")

                print(f"[claude-code-streaming] 🔌 MCP config file: {mcp_config_file}", flush=True)
                print(f"[claude-code-streaming] 🔌 Existing servers: {list(existing_mcp.keys())}", flush=True)
                print(f"[claude-code-streaming] 🔌 OpsPilot servers: {list(opspilot_mcp.keys())}", flush=True)
                print(f"[claude-code-streaming] 🔌 Merged total: {list(merged_mcp.keys())}", flush=True)
            except Exception as e:
                print(f"[claude-code-streaming] ⚠️ Failed to write MCP config file: {e}", flush=True)
                mcp_config_file = None

        # Continue session if session_id provided
        if session_id and self.session_id:
            cmd.extend(["--resume", self.session_id])

        # Block MCP write operations - common patterns across MCP servers
        # Format: mcp__<server>__<tool> - we block dangerous patterns
        mcp_write_patterns = [
            # GitHub MCP write operations
            "mcp__github__create_issue",
            "mcp__github__create_pull_request",
            "mcp__github__update_issue",
            "mcp__github__create_or_update_file",
            "mcp__github__push_files",
            "mcp__github__create_branch",
            "mcp__github__fork_repository",
            "mcp__github__create_repository",
            # Jira MCP write operations
            "mcp__jira__create_issue",
            "mcp__jira__update_issue",
            "mcp__jira__add_comment",
            "mcp__jira__transition_issue",
            # Generic patterns for other MCPs (create/update/delete/write)
            "mcp__*__create_*",
            "mcp__*__update_*",
            "mcp__*__delete_*",
            "mcp__*__write_*",
            "mcp__*__push_*",
            "mcp__*__post_*",
            "mcp__*__put_*",
        ]
        for pattern in mcp_write_patterns:
            cmd.extend(["--disallowedTools", pattern])

        # Append system prompt if provided
        # CRITICAL: Comprehensive read-only enforcement - kubectl mutations are STRICTLY FORBIDDEN
        strict_read_only = """

═══════════════════════════════════════════════════════════════════════════════
🔒 CRITICAL SECURITY: STRICT READ-ONLY MODE - ENFORCED BY SYSTEM
═══════════════════════════════════════════════════════════════════════════════

You are in STRICT READ-ONLY mode. ALL mutation operations are BLOCKED.

❌ KUBECTL MUTATIONS - ABSOLUTELY FORBIDDEN (will be rejected):
   • kubectl apply, kubectl create, kubectl delete, kubectl patch
   • kubectl edit, kubectl replace, kubectl set, kubectl annotate
   • kubectl label, kubectl taint, kubectl cordon, kubectl drain
   • kubectl scale, kubectl rollout, kubectl autoscale
   • kubectl cp, kubectl run, kubectl expose

❌ HELM MUTATIONS - FORBIDDEN:
   • helm install, helm upgrade, helm uninstall, helm rollback

❌ MCP WRITE OPERATIONS - FORBIDDEN:
   • Any create_*, update_*, delete_*, push_*, post_*, put_* MCP tools

✅ ALLOWED READ-ONLY OPERATIONS ONLY:
   • kubectl get, kubectl describe, kubectl logs, kubectl events
   • kubectl explain, kubectl api-resources, kubectl top
   • helm list, helm status, helm get
   • Any read/search/list/fetch MCP operations

⚠️ IF USER ASKS FOR MODIFICATIONS: Explain that you are in read-only mode and can only provide guidance. Suggest the exact commands they would need to run manually.

EFFICIENCY: Minimize token usage. Combine commands. Be concise.
═══════════════════════════════════════════════════════════════════════════════
"""
        if system_prompt:
            system_prompt += strict_read_only
            cmd.extend(["--append-system-prompt", system_prompt])
        else:
            cmd.extend(["--append-system-prompt", strict_read_only])

        # Build prompt with conversation history for context
        full_prompt = ""
        if conversation_history:
            full_prompt = "Previous conversation for context:\n"
            full_prompt += "-" * 40 + "\n"
            for msg in conversation_history[-10:]:  # Last 10 messages for good context continuity
                role = msg.get("role", "user").upper()
                content = msg.get("content", "")[:1500]  # Truncate long messages but keep more content
                full_prompt += f"[{role}]: {content}\n\n"
            full_prompt += "-" * 40 + "\n"
            full_prompt += f"Current question:\n{prompt}"
        else:
            full_prompt = prompt

        # Use -- to separate options from positional prompt argument
        cmd.append("--")
        cmd.append(full_prompt)

        # Set up environment with kubeconfig context
        env = None
        if kube_context:
            import os
            env = os.environ.copy()
            env['KUBECONFIG_CONTEXT'] = kube_context

        # Use provided working_dir or fall back to instance default
        effective_working_dir = working_dir or self.working_dir

        print(f"[claude-code-streaming] 🚀 Starting agentic call with native tools", flush=True)
        print(f"[claude-code-streaming] 📝 Prompt: {prompt[:200]}...", flush=True)
        if effective_working_dir:
            print(f"[claude-code-streaming] 📁 Working directory: {effective_working_dir}", flush=True)

        process = None
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.DEVNULL,
                cwd=effective_working_dir,
                env=env
            )

            final_text = ""
            current_tool = None

            async for line in process.stdout:
                line_str = line.decode('utf-8', errors='replace').strip()
                if not line_str:
                    continue

                # Debug log
                print(f"[claude-code-streaming] 📨 Event: {line_str[:200]}...", flush=True)

                try:
                    event = json.loads(line_str)
                    event_type = event.get('type', '')

                    if event_type == 'assistant':
                        # Assistant message - could contain text or tool_use
                        content = event.get('message', {}).get('content', [])
                        for block in content:
                            block_type = block.get('type')

                            if block_type == 'text':
                                text = block.get('text', '')
                                final_text += text
                                yield {'type': 'text', 'content': text}

                            elif block_type == 'thinking':
                                thinking = block.get('thinking', '')
                                yield {'type': 'thinking', 'content': thinking}

                            elif block_type == 'tool_use':
                                # Claude is using a tool (Bash, Read, etc.)
                                tool_name = block.get('name', '')
                                tool_input = block.get('input', {})
                                current_tool = tool_name
                                yield {'type': 'tool_use', 'tool': tool_name, 'input': tool_input}

                    elif event_type == 'error':
                        # Internal Claude Code error (like rate limits)
                        error_data = event.get('error', {})
                        message = error_data.get('message', '')
                        if not message:
                            message = event.get('message', 'Unknown Claude Code Error')
                        
                        # Log the full error for debugging
                        print(f"[claude-code-streaming] ❌ Claude Code Error: {message}", flush=True)
                        if 'error' in event:
                            print(f"[claude-code-streaming] ❌ Error details: {event['error']}", flush=True)
                        
                        yield {'type': 'error', 'message': f"Claude Code: {message}"}

                    elif event_type == 'content_block_delta':
                        # Streaming delta
                        delta = event.get('delta', {})
                        delta_type = delta.get('type', '')

                        if delta_type == 'text_delta':
                            text = delta.get('text', '')
                            final_text += text
                            yield {'type': 'text', 'content': text}

                        elif delta_type == 'thinking_delta':
                            thinking = delta.get('thinking', '')
                            yield {'type': 'thinking', 'content': thinking}

                    elif event_type == 'user':
                        # User message - could contain tool_result from Claude Code execution
                        content = event.get('message', {}).get('content', [])
                        for block in content:
                            if block.get('type') == 'tool_result':
                                # Tool execution completed
                                result = block.get('content', '')
                                yield {'type': 'tool_result', 'output': result, 'tool': current_tool}

                    elif event_type == 'tool_result':
                        # Legacy: Tool execution result (direct format)
                        result = event.get('result', '')
                        yield {'type': 'tool_result', 'output': result, 'tool': current_tool}

                    elif event_type == 'result':
                        # Final result - extract token usage
                        result_text = event.get('result', '')
                        usage_data = event.get('usage', {})
                        if usage_data:
                            request_usage = TokenUsage(
                                input_tokens=usage_data.get('input_tokens', 0),
                                output_tokens=usage_data.get('output_tokens', 0),
                                cache_read_tokens=usage_data.get('cache_read_input_tokens', 0),
                                cache_creation_tokens=usage_data.get('cache_creation_input_tokens', 0)
                            )
                            self.session_usage.add(request_usage)
                            yield {
                                'type': 'usage',
                                'input_tokens': request_usage.input_tokens,
                                'output_tokens': request_usage.output_tokens,
                                'total_tokens': request_usage.total_tokens,
                                'session_total': self.session_usage.total_tokens
                            }
                        if result_text:
                            # This is the final answer
                            yield {'type': 'done', 'final_text': result_text}

                except json.JSONDecodeError:
                    # Non-JSON output - might be raw text
                    if line_str and not line_str.startswith('{'):
                        yield {'type': 'text', 'content': line_str}

            # Wait for process to complete
            await process.wait()

            # Check for errors
            if process.returncode != 0:
                stderr = await process.stderr.read()
                stderr_text = stderr.decode('utf-8', errors='replace')
                print(f"[claude-code-streaming] ⚠️ stderr: {stderr_text}", flush=True)
                if stderr_text:
                    yield {'type': 'error', 'message': stderr_text}

        except asyncio.CancelledError:
            if process:
                try:
                    process.kill()
                    await process.wait()
                except Exception:
                    pass
            raise
        except BrokenPipeError:
            print(f"[claude-code-streaming] ❌ Broken pipe error - CLI likely crashed", flush=True)
            # Try to see if there's anything in stderr
            error_msg = "Claude Code CLI disconnected unexpectedly (Broken Pipe)."
            if process:
                try:
                    stderr = await process.stderr.read()
                    if stderr:
                        stderr_text = stderr.decode('utf-8', errors='replace')
                        error_msg = f"Claude Code CLI crashed: {stderr_text}"
                except:
                    pass
            yield {'type': 'error', 'message': error_msg}
        except Exception as e:
            print(f"[claude-code-streaming] ❌ Error in tool loop: {e}", flush=True)
            msg = str(e)
            if "broken pipe" in msg.lower():
                msg = "Claude Code connection lost (Broken Pipe). This usually happens when the CLI reaches a limit or crashes."
            yield {'type': 'error', 'message': f"Unexpected Error: {msg}"}
        finally:
            # Ensure process is cleaned up
            if process and process.returncode is None:
                try:
                    process.kill()
                    await process.wait()
                    print(f"[claude-code-streaming] 🧹 Cleaned up subprocess", flush=True)
                except Exception:
                    pass
            # Clean up temp MCP config file
            if mcp_config_file:
                try:
                    import os as _os
                    _os.unlink(mcp_config_file)
                    print(f"[claude-code-streaming] 🧹 Cleaned up MCP config file", flush=True)
                except Exception:
                    pass

    def _parse_stream_json_output(self, output: str) -> ClaudeCodeResponse:
        """
        Parse stream-json format output from Claude Code CLI.

        The stream-json format emits one JSON object per line with different event types:
        - system: System messages
        - assistant: Assistant responses
        - tool_use: Tool invocations
        - tool_result: Tool execution results
        - result: Final result
        """
        response = ClaudeCodeResponse(content="", raw_output=output)

        content_parts = []
        tool_calls = []
        thinking_parts = []

        for line in output.strip().split('\n'):
            if not line.strip():
                continue

            try:
                event = json.loads(line)
                event_type = event.get('type', '')

                if event_type == 'assistant':
                    # Extract content from assistant message
                    message = event.get('message', {})
                    content = message.get('content', [])
                    for block in content:
                        if block.get('type') == 'text':
                            content_parts.append(block.get('text', ''))
                        elif block.get('type') == 'tool_use':
                            tool_calls.append({
                                'id': block.get('id'),
                                'name': block.get('name'),
                                'input': block.get('input', {})
                            })

                elif event_type == 'content_block_delta':
                    delta = event.get('delta', {})
                    if delta.get('type') == 'text_delta':
                        content_parts.append(delta.get('text', ''))
                    elif delta.get('type') == 'thinking_delta':
                        thinking_parts.append(delta.get('thinking', ''))

                elif event_type == 'result':
                    # Final result - extract any remaining content
                    result_content = event.get('result', '')
                    if result_content and isinstance(result_content, str):
                        content_parts.append(result_content)
                    response.is_complete = True

                elif event_type == 'tool_use':
                    tool_calls.append({
                        'name': event.get('name'),
                        'input': event.get('input', {})
                    })

                elif event_type == 'error':
                    # Extract error message for the structured response
                    error_data = event.get('error', {})
                    msg = error_data.get('message', '')
                    if not msg:
                        msg = event.get('message', 'Unknown Claude Code Error')
                    content_parts.append(f"Claude Code Error: {msg}")

            except json.JSONDecodeError:
                # Not JSON, might be raw text output
                if line.strip() and not line.startswith('{'):
                    content_parts.append(line)

        response.content = ''.join(content_parts).strip()
        response.tool_calls = tool_calls
        response.thinking = ''.join(thinking_parts)

        # If we didn't extract structured content, use raw output
        if not response.content and output.strip():
            # Try to extract just the text response
            response.content = self._extract_plain_text(output)

        return response

    def _extract_plain_text(self, output: str) -> str:
        """Extract plain text content from mixed output."""
        # Remove JSON lines and keep text
        lines = []
        for line in output.split('\n'):
            line = line.strip()
            if not line:
                continue
            if line.startswith('{') and line.endswith('}'):
                try:
                    json.loads(line)
                    continue  # Skip valid JSON
                except:
                    pass
            lines.append(line)
        return '\n'.join(lines)

    def _strip_markdown_code_blocks(self, content: str) -> str:
        """
        Strip markdown code blocks from content.

        Claude Code CLI often wraps JSON responses in ```json...``` blocks.
        This method extracts the content from those blocks.
        """
        if not content:
            return content

        # Pattern to match ```json...``` or ```...``` blocks
        pattern = r'```(?:json|python|bash|sh|yaml)?\s*\n?(.*?)```'
        matches = re.findall(pattern, content, re.DOTALL)

        if matches:
            # Take only the first code block (avoid duplicates)
            return matches[0].strip()

        return content

    def _extract_first_json_object(self, content: str) -> Optional[str]:
        """Extract the best JSON object from content that looks like a valid agent response."""
        # Find ALL complete JSON objects
        all_jsons = self._extract_all_json_objects(content)

        if not all_jsons:
            return None

        # Look for the one that has agent response fields (thought, next_action, plan)
        for json_str in all_jsons:
            try:
                obj = json.loads(json_str)
                # Check if this looks like an agent response (has expected fields)
                if isinstance(obj, dict) and ('thought' in obj or 'next_action' in obj):
                    print(f"[claude-code] 🎯 Found valid agent response JSON ({len(json_str)} chars)", flush=True)
                    return json_str
            except:
                continue

        # Fallback: return the last complete JSON (most likely to be the actual response)
        if all_jsons:
            print(f"[claude-code] ⚠️ No agent response found, using last JSON ({len(all_jsons[-1])} chars)", flush=True)
            return all_jsons[-1]

        return None

    def _extract_all_json_objects(self, content: str) -> List[str]:
        """Extract all complete JSON objects from content."""
        results = []
        pos = 0

        while pos < len(content):
            start = content.find('{', pos)
            if start == -1:
                break

            brace_count = 0
            in_string = False
            escape = False
            found_end = False

            for i, char in enumerate(content[start:], start):
                if escape:
                    escape = False
                    continue

                if char == '\\' and in_string:
                    escape = True
                    continue

                if char == '"' and not escape:
                    in_string = not in_string
                    continue

                if in_string:
                    continue

                if char == '{':
                    brace_count += 1
                elif char == '}':
                    brace_count -= 1
                    if brace_count == 0:
                        json_str = content[start:i+1]
                        results.append(json_str)
                        pos = i + 1
                        found_end = True
                        break

            if not found_end:
                # No complete JSON found from this position
                break

        return results

    def _attempt_json_repair(self, content: str) -> str:
        """
        Attempt to repair truncated or malformed JSON.

        Common issues:
        - Multiple JSON objects (take first complete one)
        - Truncated at end (missing closing braces/brackets)
        - String not closed properly
        - Trailing commas
        """
        if not content:
            return content

        # First, try to extract the first complete JSON object
        first_json = self._extract_first_json_object(content)
        if first_json:
            try:
                json.loads(first_json)
                return first_json
            except json.JSONDecodeError:
                pass

        # Try to find the start of a JSON object
        start = content.find('{')
        if start == -1:
            return content

        # Count braces to find truncation point
        brace_count = 0
        bracket_count = 0
        in_string = False
        escape = False
        last_valid_pos = start

        for i, char in enumerate(content[start:], start):
            if escape:
                escape = False
                continue

            if char == '\\' and in_string:
                escape = True
                continue

            if char == '"' and not escape:
                in_string = not in_string
                continue

            if in_string:
                continue

            if char == '{':
                brace_count += 1
            elif char == '}':
                brace_count -= 1
                if brace_count == 0:
                    last_valid_pos = i + 1
            elif char == '[':
                bracket_count += 1
            elif char == ']':
                bracket_count -= 1

        # If balanced, return as-is
        if brace_count == 0 and bracket_count == 0:
            return content

        # Truncated - try to close properly
        truncated = content[:last_valid_pos] if last_valid_pos > start else content[start:]

        # Add missing closing braces/brackets
        repair = truncated.rstrip().rstrip(',')  # Remove trailing comma
        repair += ']' * bracket_count
        repair += '}' * brace_count

        # Validate repair
        try:
            json.loads(repair)
            return repair
        except json.JSONDecodeError:
            # Repair failed - return a safe error JSON
            return json.dumps({
                "thought": "JSON response was truncated",
                "next_action": "respond",
                "final_response": "I encountered an issue generating a complete response. Please try again."
            })

    async def execute_tool(
        self,
        tool_name: str,
        tool_input: Dict[str, Any],
        restricted_tools: bool = False
    ) -> str:
        """
        Execute a tool that Claude Code requested.

        This is for handling tool_use responses where Claude wants to run
        a command or read a file.
        """
        # Map common tool names to kubectl/shell commands
        tool_handlers = {
            'bash': self._handle_bash_tool,
            'read': self._handle_read_tool,
            'glob': self._handle_glob_tool,
            'grep': self._handle_grep_tool,
        }

        handler = tool_handlers.get(tool_name.lower())
        if handler:
            if tool_name.lower() == 'bash':
                return await handler(tool_input, restricted_tools)
            return await handler(tool_input)
        else:
            return f"Unknown tool: {tool_name}"

    async def _handle_bash_tool(self, input_data: Dict, restricted_tools: bool = False) -> str:
        """Execute bash command."""
        command = input_data.get('command', '')
        if not command:
            return "Error: No command provided"

        # Security check for local code search mode
        if restricted_tools:
            # Allow only strict read-only file search commands
            allowed_prefixes = ["grep", "find", "ls", "cat", "git grep", "fs_grep"]
            is_allowed = any(command.strip().startswith(prefix) for prefix in allowed_prefixes)
            
            # Explicitly block kubectl, helm, etc.
            if command.strip().startswith("kubectl") or not is_allowed:
                return (
                    f"Error: Command '{command}' is NOT allowed in Code Search mode. "
                    "You may ONLY use: grep, find, ls, cat, git grep. "
                    "Do NOT run kubectl commands."
                )

        try:
            process = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.working_dir
            )
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=30.0
            )
            result = stdout.decode('utf-8', errors='replace')
            if stderr:
                result += f"\nSTDERR: {stderr.decode('utf-8', errors='replace')}"
            return result
        except Exception as e:
            return f"Error executing command: {e}"

    async def _handle_read_tool(self, input_data: Dict) -> str:
        """Read file content."""
        file_path = input_data.get('file_path', '')
        if not file_path:
            return "Error: No file path provided"

        try:
            with open(file_path, 'r') as f:
                return f.read()
        except Exception as e:
            return f"Error reading file: {e}"

    async def _handle_glob_tool(self, input_data: Dict) -> str:
        """Find files by pattern."""
        import glob
        pattern = input_data.get('pattern', '')
        path = input_data.get('path', '.')

        try:
            full_pattern = f"{path}/{pattern}" if path else pattern
            matches = glob.glob(full_pattern, recursive=True)
            return '\n'.join(matches[:100])  # Limit to 100 results
        except Exception as e:
            return f"Error searching files: {e}"

    async def _handle_grep_tool(self, input_data: Dict) -> str:
        """Search file contents using a portable Python implementation."""
        pattern = input_data.get('pattern', '')
        path = input_data.get('path', '.')
        
        if not pattern:
            return "Error: No pattern provided"

        import re
        try:
            regex = re.compile(pattern, re.IGNORECASE)
            results = []
            max_results = 50
            
            # Walk directory
            for root, _, files in os.walk(path):
                for file in files:
                    if len(results) >= max_results:
                        break
                    
                    file_path = os.path.join(root, file)
                    try:
                        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                            for i, line in enumerate(f, 1):
                                if regex.search(line):
                                    results.append(f"{file_path}:{i}:{line.strip()}")
                                    if len(results) >= max_results:
                                        break
                    except Exception:
                        continue # Skip binaries or unreadable files
                
                if len(results) >= max_results:
                    break
            
            return '\n'.join(results) if results else "No matches found."
        except Exception as e:
            return f"Error searching: {e}"


# Global singleton for reuse
_claude_code_backend: Optional[ClaudeCodeBackend] = None


def get_claude_code_backend(working_dir: str = None) -> ClaudeCodeBackend:
    """Get or create the Claude Code backend singleton."""
    global _claude_code_backend
    if _claude_code_backend is None:
        _claude_code_backend = ClaudeCodeBackend(working_dir)
    return _claude_code_backend


async def call_claude_code(
    prompt: str,
    system_prompt: str = None,
    force_json: bool = False,
    temperature: float = 0.3,
    working_dir: str = None
) -> str:
    """
    Public wrapper to call Claude Code CLI.

    This function can be used as a drop-in replacement for call_llm
    when using claude-code as the provider.
    """
    backend = get_claude_code_backend(working_dir)
    return await backend.call(
        prompt=prompt,
        system_prompt=system_prompt,
        force_json=force_json,
        temperature=temperature
    )
