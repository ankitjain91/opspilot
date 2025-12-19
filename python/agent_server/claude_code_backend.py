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
"""

import asyncio
import json
import re
import subprocess
from typing import AsyncIterator, Dict, Any, Optional, List, Tuple
from dataclasses import dataclass, field


@dataclass
class ClaudeCodeResponse:
    """Structured response from Claude Code CLI."""
    content: str
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    thinking: str = ""
    is_complete: bool = False
    raw_output: str = ""


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
            print("[claude-code] WARNING: claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code", flush=True)
            return False

    async def call(
        self,
        prompt: str,
        system_prompt: str = None,
        force_json: bool = False,
        temperature: float = 0.3,
        continue_session: bool = False,
        timeout: float = 120.0
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

        # Add output format for structured parsing
        cmd.extend(["--output-format", "stream-json"])

        # Permission mode - accept edits for agent automation
        cmd.extend(["--permission-mode", "acceptEdits"])

        # Continue session if requested
        if continue_session and self.session_id:
            cmd.extend(["--continue", self.session_id])

        # Build full prompt with system instructions
        full_prompt = prompt
        if system_prompt:
            full_prompt = f"{system_prompt}\n\n---\n\n{prompt}"

        if force_json:
            full_prompt += "\n\nRespond with valid JSON only. No markdown, no explanation outside JSON."

        # Add the prompt
        cmd.append(full_prompt)

        print(f"[claude-code] Executing: claude -p --output-format stream-json ...", flush=True)

        try:
            # Run claude CLI as subprocess
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.working_dir
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

            return response.content

        except asyncio.TimeoutError:
            print(f"[claude-code] Timeout after {timeout}s", flush=True)
            return f"Error: Claude Code CLI timed out after {timeout} seconds"
        except Exception as e:
            print(f"[claude-code] Error: {e}", flush=True)
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

    async def execute_tool(
        self,
        tool_name: str,
        tool_input: Dict[str, Any]
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
            return await handler(tool_input)
        else:
            return f"Unknown tool: {tool_name}"

    async def _handle_bash_tool(self, input_data: Dict) -> str:
        """Execute bash command."""
        command = input_data.get('command', '')
        if not command:
            return "Error: No command provided"

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
        """Search file contents."""
        pattern = input_data.get('pattern', '')
        path = input_data.get('path', '.')

        try:
            cmd = f"grep -rn '{pattern}' {path} | head -50"
            process = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, _ = await process.communicate()
            return stdout.decode('utf-8', errors='replace')
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
