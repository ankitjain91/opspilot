
import asyncio
import subprocess
import re
from ..state import AgentState
from ..prompts_templates import WORKER_PROMPT
from ..llm import call_llm
from ..parsing import parse_worker_response
from ..utils import (
    truncate_output, smart_truncate_output, emit_event,
    get_cached_result, cache_command_result
)
from ..context_builder import (
    build_discovered_context,
    extract_resources_from_output,
    merge_discovered_resources
)

def normalize_command(cmd: str) -> str:
    """Normalize kubectl command for duplicate detection.

    This prevents loop detection bypass via minor whitespace/parameter variations:
    - Collapses multiple spaces
    - Normalizes --tail=N values
    - Converts to lowercase

    Examples:
        "kubectl get pods" == "kubectl  get  pods " (extra spaces)
        "kubectl logs pod --tail=50" == "kubectl logs pod --tail=100" (different tail)
    """
    # 1. Lowercase and collapse spaces
    normalized = re.sub(r'\s+', ' ', cmd.lower().strip())

    # 2. Normalize tail argument to generic marker (ignore specific count)
    # Replaces --tail=100 with --tail=N
    normalized = re.sub(r'--tail=\d+', '--tail=N', normalized)
    normalized = re.sub(r'--tail \d+', '--tail N', normalized)

    # 3. Remove --context flags (handled by server state)
    normalized = re.sub(r'--context=\S+', '', normalized)
    normalized = re.sub(r'--context \S+', '', normalized)

    return normalized.strip()

async def worker_node(state: AgentState) -> dict:
    """Worker Node (executor model): Translates plan into kubectl command."""
    events = list(state.get('events', []))
    plan = state.get('current_plan', 'Check failing pods and cluster events')

    last_cmd = state['command_history'][-1] if state['command_history'] else None
    last_cmd_str = f"{last_cmd['command']} (Output: {truncate_output(last_cmd.get('output',''), 500)})" if last_cmd else "None"

    recent_commands = [h['command'] for h in state['command_history'][-5:]] if state['command_history'] else []
    avoid_commands_str = "\n".join([f"  - {cmd}" for cmd in recent_commands]) if recent_commands else "None"

    # Build context from discovered resources - THIS IS THE KEY FIX!
    discovered_context_str = build_discovered_context(state.get('discovered_resources'))

    prompt = WORKER_PROMPT.format(
        plan=plan,
        kube_context=state['kube_context'] or 'default',
        last_command_info=last_cmd_str,
        avoid_commands=avoid_commands_str,
        discovered_context=discovered_context_str,
    )

    try:
        executor_model = state.get('executor_model', 'k8s-cli')
        response = await call_llm(prompt, state['llm_endpoint'], executor_model, state.get('llm_provider', 'ollama'), temperature=0.1)
        parsed = parse_worker_response(response)
        command = parsed['command']
        thought = parsed['thought']

        events.append(emit_event("reflection", {"assessment": "EXECUTING", "reasoning": f"🔧 Executor Plan: {thought}"}))

        # Use normalized command comparison to catch variations (whitespace, --tail=N, etc.)
        normalized_new = normalize_command(command)
        normalized_history = [normalize_command(h['command']) for h in state['command_history'][-5:]] if state['command_history'] else []
        if normalized_new in normalized_history:
            events.append(emit_event("blocked", {"command": command, "reason": "loop_detected"}))
            return {
                **state,
                'next_action': 'supervisor',
                'command_history': state['command_history'] + [
                    {'command': command, 'output': '', 'error': f'LOOP DETECTED: Command "{command}" was already executed. You MUST try a different approach.'}
                ],
                'events': events,
            }

        events.append(emit_event("command_selected", {"command": command}))
        return {
            **state,
            'next_action': 'verify',
            'pending_command': command,
            'events': events,
        }
    except Exception as e:
        events.append(emit_event("error", {"message": f"Worker Error: {e}"}))
        return {
            **state,
            'next_action': 'supervisor',
            'command_history': state['command_history'] + [
                {'command': '(worker error)', 'output': '', 'error': str(e)}
            ],
            'events': events,
        }

async def execute_node(state: AgentState) -> dict:
    """Execute a kubectl command."""
    command = state.get('pending_command')
    if not command:
        return {
            **state,
            'next_action': 'reflect', # Go to reflect to mark step as failed or loop
            'command_history': state['command_history'] + [
                {'command': '(none)', 'output': '', 'error': 'No command to execute'}
            ],
        }

    # Check cache for discovery commands (session continuity)
    cached_output = get_cached_result(state, command)
    if cached_output:
        print(f"[agent-sidecar] ⚡ Using cached result for: {command}", flush=True)
        events = list(state.get('events', []))
        events.append(emit_event("command_output", {
            "command": command,
            "output": cached_output,
            "error": None,
            "cached": True
        }))

        return {
            **state,
            'next_action': 'reflect',
            'command_history': state['command_history'] + [
                {'command': command, 'output': cached_output, 'error': None, 'cached': True}
            ],
            'pending_command': None,
            'events': events,
        }

    try:
        full_command = command
        if state['kube_context']:
            full_command = command.replace('kubectl ', f"kubectl --context={state['kube_context']} ", 1)

        print(f"[agent-sidecar] 🚀 NOTE: Executing command with context: {full_command}", flush=True)

        # Use asyncio subprocess for non-blocking execution (allows parallelization in future)
        proc = await asyncio.create_subprocess_shell(
            full_command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=60.0)
            stdout = stdout_bytes.decode('utf-8', errors='replace') if stdout_bytes else ''
            stderr = stderr_bytes.decode('utf-8', errors='replace') if stderr_bytes else ''
            returncode = proc.returncode
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise subprocess.TimeoutExpired(full_command, 60)

        # Use smart truncation to keep only important rows (errors, failures)
        # This prevents overwhelming the context with thousands of healthy pods
        raw_output = stdout or stderr or '(no output)'
        output = smart_truncate_output(raw_output, max_chars=4000)
        error = stderr if returncode != 0 else None

        # Extract discovered resources from output - FEED THE AI!
        discovered_resources = extract_resources_from_output(command, raw_output)
        merged_resources = merge_discovered_resources(
            state.get('discovered_resources'),
            discovered_resources
        )

        print(f"[agent-sidecar] 🔍 Discovered resources: {discovered_resources}", flush=True)

        # Cache discovery command results for session continuity
        updated_state = cache_command_result(state, command, raw_output) if not error else state
        updated_state['discovered_resources'] = merged_resources

        events = list(state.get('events', []))
        events.append(emit_event("command_output", {"command": command, "output": output, "error": error}))

        # FIX 5: Skip reflection for trivial queries (30-40% speedup)
        # This prevents the agent from looping on simple GET commands
        query_lower = (state.get('query') or '').lower().strip()

        # Trivial patterns that don't need reflection
        trivial_keywords = ['list', 'show', 'get nodes', 'get pods', 'get services',
                            'get deployments', 'get namespaces']
        simple_resources = ['nodes', 'pods', 'services', 'deployments', 'namespaces', 'configmaps']

        is_trivial_listing = (
            any(kw in query_lower for kw in trivial_keywords) or
            query_lower in simple_resources
        )
        is_first_iteration = len(state.get('command_history', [])) == 0
        is_successful = not error and len(output.strip()) > 0

        skip_reflection = is_trivial_listing and is_first_iteration and is_successful

        if skip_reflection:
            # Mark as auto-solved, go straight to supervisor for formatting response
            print(f"[agent-sidecar] ⚡ Skipping reflection for trivial query '{state['query']}'", flush=True)

            updated_history = list(state['command_history']) + [
                {'command': command, 'output': output, 'error': error,
                 'assessment': 'AUTO_SOLVED',
                 'useful': True,
                 'reasoning': 'Trivial listing query - output is the answer'}
            ]

            return {
                **updated_state,
                'next_action': 'supervisor',  # Skip reflect, go straight back
                'command_history': updated_history,
                'pending_command': None,
                'events': events,
            }

        return {
            **updated_state,
            'next_action': 'reflect',
            'command_history': state['command_history'] + [
                {'command': command, 'output': output, 'error': error}
            ],
            'pending_command': None,
            'events': events,
        }
    except subprocess.TimeoutExpired:
        return {
            **state,
            'next_action': 'reflect',
            'command_history': state['command_history'] + [
                {'command': command, 'output': '', 'error': 'Command timed out after 60 seconds'}
            ],
            'pending_command': None,
        }
    except Exception as e:
        return {
            **state,
            'next_action': 'reflect',
            'command_history': state['command_history'] + [
                {'command': command, 'output': '', 'error': str(e)}
            ],
            'pending_command': None,
        }

async def execute_batch_node(state: AgentState) -> dict:
    """
    Execute multiple kubectl commands in parallel.

    This provides 3-5x speedup for discovery queries where multiple independent
    commands can run simultaneously (e.g., get pods + get events + get nodes).
    """
    batch_commands = state.get('pending_batch_commands', [])
    if not batch_commands:
        return {**state, 'next_action': 'supervisor'}

    print(f"[agent-sidecar] 🚀 Executing {len(batch_commands)} commands in parallel...", flush=True)
    events = list(state.get('events', []))
    events.append(emit_event("batch_execution", {"count": len(batch_commands), "commands": batch_commands}))

    # Check cache for each command first
    cached_results = []
    uncached_commands = []

    for cmd in batch_commands:
        cached_output = get_cached_result(state, cmd)
        if cached_output:
            cached_results.append({'command': cmd, 'output': cached_output, 'error': None, 'cached': True})
        else:
            uncached_commands.append(cmd)

    # Execute uncached commands in parallel using asyncio.gather
    async def execute_single_command(command: str) -> dict:
        try:
            full_command = command
            if state['kube_context']:
                full_command = command.replace('kubectl ', f"kubectl --context={state['kube_context']} ", 1)

            proc = await asyncio.create_subprocess_shell(
                full_command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=60.0)
                stdout = stdout_bytes.decode('utf-8', errors='replace') if stdout_bytes else ''
                stderr = stderr_bytes.decode('utf-8', errors='replace') if stderr_bytes else ''
                returncode = proc.returncode
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                return {'command': command, 'output': '', 'error': 'Command timed out after 60 seconds'}

            raw_output = stdout or stderr or '(no output)'
            output = smart_truncate_output(raw_output, max_chars=4000)
            error = stderr if returncode != 0 else None

            return {'command': command, 'output': output, 'error': error, 'raw_output': raw_output}

        except Exception as e:
            return {'command': command, 'output': '', 'error': str(e)}

    # Execute all uncached commands concurrently
    execution_results = await asyncio.gather(*[execute_single_command(cmd) for cmd in uncached_commands])

    # Combine results maintaining original order from batch_commands
    # This ensures that if we put 'get pods' last, it stays last in history
    results_map = {r['command']: r for r in cached_results + execution_results}
    all_results = []
    for cmd in batch_commands:
        if cmd in results_map:
            all_results.append(results_map[cmd])

    # Cache successful results
    updated_state = state
    for result in execution_results:
        if not result.get('error') and result.get('raw_output'):
            updated_state = cache_command_result(updated_state, result['command'], result['raw_output'])

    # Add all results to command history
    new_history_entries = [
        {'command': r['command'], 'output': r['output'], 'error': r.get('error'), 'cached': r.get('cached', False)}
        for r in all_results
    ]

    events.append(emit_event("batch_complete", {
        "total": len(batch_commands),
        "cached": len(cached_results),
        "executed": len(execution_results),
        "successful": sum(1 for r in all_results if not r.get('error'))
    }))

    print(f"[agent-sidecar] ✅ Batch complete: {len(cached_results)} cached, {len(execution_results)} executed", flush=True)

    return {
        **updated_state,
        'next_action': 'reflect',
        'command_history': state['command_history'] + new_history_entries,
        'batch_results': all_results,
        'pending_batch_commands': None,
        'events': events,
    }
