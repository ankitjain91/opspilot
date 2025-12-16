
import asyncio
import subprocess
import re
from ..state import AgentState
from ..prompts.worker.main import WORKER_PROMPT
from ..llm import call_llm
from ..parsing import parse_worker_response
from ..utils import (
    truncate_output, smart_truncate_output, emit_event,
    get_cached_result, cache_command_result, parse_kubectl_json_output
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

    # Format accumulated evidence for the prompt
    accumulated_evidence = state.get('accumulated_evidence', [])
    evidence_str = "\n".join([f"- {fact}" for fact in accumulated_evidence]) if accumulated_evidence else "None yet."

    # Hint from previous reflection (if retry)
    previous_reflection = state.get('last_reflection', {})
    retry_hint = ""
    if previous_reflection and previous_reflection.get('directive') == 'RETRY':
        hint_text = previous_reflection.get('next_command_hint') or previous_reflection.get('thought')
        if hint_text:
            retry_hint = f"\nADVICE FOR RETRY: {hint_text}"

    prompt = WORKER_PROMPT.format(
        plan=plan,
        current_step_description=state.get('current_plan', 'Execute command'),
        kube_context=state['kube_context'] or 'default',
        accumulated_evidence=evidence_str + retry_hint, # Append hint to evidence area or context
        last_command_info=last_cmd_str,
        avoid_commands=avoid_commands_str,
        discovered_context=discovered_context_str,
    )

    try:
        executor_model = state.get('executor_model', 'k8s-cli')
        response = await call_llm(prompt, state['llm_endpoint'], executor_model, state.get('llm_provider', 'ollama'), temperature=0.1, api_key=state.get('api_key'))
        parsed = parse_worker_response(response)
        
        # New Structured Tool Logic
        command = ""
        tool_call = parsed.get("tool_call")
        thought = parsed.get("thought", "Executing tool")
        context_override = None  # <-- MOVED HERE: Initialize at function scope

        if tool_call:
            try:
                from ..tools.definitions import AgentToolWrapper, KubectlContext, GitCommit, PredictScaling
                from ..tools.safe_executor import SafeExecutor
                
                # Validation (Discriminated Union)
                # Input: {"tool": "kubectl_get", "resource": "pods", ...}
                wrapper = AgentToolWrapper(tool_call=tool_call)
                tool_obj = wrapper.tool_call
                
                # Safe Construction
                command = SafeExecutor.build_command(tool_obj, kube_context=state['kube_context'])
                
                # 🪞 THE MIRROR: Automated Verification
                # If the tool implies a state change, append a verification step
                verify_cmd = SafeExecutor.get_verification_command(tool_obj, kube_context=state['kube_context'])
                if verify_cmd:
                    print(f"[agent-sidecar] 🪞 The Mirror: Appending verification: {verify_cmd}", flush=True)
                    events.append(emit_event("progress", {"message": "🪞 Appending active verification step..."}))
                    # Use '&&' to run verification only if mutation succeeds
                    # Add echo to separate output for clearer parsing
                    command = f"{command} && echo '\n--- VERIFICATION ---' && {verify_cmd}"

                # SPECIAL HANDLING: Context Switching
                # If the tool is KubectlContext(action='use'), we must update the agent's state
                if isinstance(tool_obj, KubectlContext) and tool_obj.action == "use" and tool_obj.context_name:
                    print(f"[agent-sidecar] 🔄 Switching context to: {tool_obj.context_name}", flush=True)
                    events.append(emit_event("progress", {"message": f"Switching context to {tool_obj.context_name}"}))
                    # Store context for return value (immutable pattern)
                    context_override = tool_obj.context_name

                # SPECIAL HANDLING: GitCommit (GitOps)
                # Instead of a shell command, we perform the git operation directly
                if isinstance(tool_obj, GitCommit):
                    print(f"[agent-sidecar] 🐙 Executing GitOps: {tool_obj.repo_url}", flush=True)
                    events.append(emit_event("progress", {"message": f"🐙 Creating Git Branch & Commit for {tool_obj.file_path}..."}))
                    
                    import tempfile
                    import os
                    import time
                    
                    # Generate branch name if missing
                    branch = tool_obj.branch_name or f"agent/patch-{int(time.time())}"
                    
                    with tempfile.TemporaryDirectory() as tmp_dir:
                        # 1. Clone
                        # Use subprocess for safety and simplicity
                        subprocess.run(["git", "clone", "--depth", "1", tool_obj.repo_url, tmp_dir], check=True, capture_output=True)
                        
                        # 2. Checkout Branch
                        subprocess.run(["git", "checkout", "-b", branch], cwd=tmp_dir, check=True, capture_output=True)
                        
                        # 3. Write File
                        full_path = os.path.join(tmp_dir, tool_obj.file_path)
                        os.makedirs(os.path.dirname(full_path), exist_ok=True)
                        with open(full_path, 'w') as f:
                            f.write(tool_obj.file_content)
                            
                        # 4. Git Add & Commit
                        subprocess.run(["git", "add", "."], cwd=tmp_dir, check=True, capture_output=True)
                        subprocess.run(["git", "commit", "-m", tool_obj.commit_message], cwd=tmp_dir, check=True, capture_output=True)
                        
                        # 5. Push
                        # Note: This might fail without auth. We catch exceptions.
                        subprocess.run(["git", "push", "origin", branch], cwd=tmp_dir, check=True, capture_output=True)
                        
                    # Return a virtual success command/result
                    # This tricks the supervisor into thinking a command ran successfully
                    result_msg = f"SUCCESS: Created branch '{branch}' and pushed commit to {tool_obj.repo_url}"
                    print(f"[agent-sidecar] ✅ GitOps Complete: {result_msg}", flush=True)
                    
                    # Create a virtual history entry
                    events.append(emit_event("command_output", {"command": f"git push origin {branch}", "output": result_msg}))
                    return {
                        **state,
                        'next_action': 'reflect', # Reflect on the success
                        'command_history': state['command_history'] + [
                            {'command': f"git push origin {branch}", 'output': result_msg, 'error': None}
                        ],
                        'pending_command': None,
                        'events': events,
                    }

                # SPECIAL HANDLING: PredictScaling (Time Lord)
                if isinstance(tool_obj, PredictScaling):
                    print(f"[agent-sidecar] 🔮 Time Lord: Predicting scaling for {tool_obj.name}...", flush=True)
                    events.append(emit_event("progress", {"message": f"🔮 Calculating scaling trend for {tool_obj.name}..."}))
                    
                    from ..tools.predictor import predict_scaling
                    
                    prediction = predict_scaling(
                        resource_type=tool_obj.resource_type,
                        name=tool_obj.name,
                        history=tool_obj.history,
                        horizon_minutes=tool_obj.horizon_minutes
                    )
                    
                    print(f"[agent-sidecar] 📈 Prediction Result:\n{prediction}", flush=True)
                    
                    # Return virtual command result
                    virtual_cmd = f"predict_scaling {tool_obj.resource_type}/{tool_obj.name}"
                    events.append(emit_event("command_output", {"command": virtual_cmd, "output": prediction}))
                    
                    return {
                        **state,
                        'next_action': 'reflect',
                        'command_history': state['command_history'] + [
                            {'command': virtual_cmd, 'output': prediction, 'error': None}
                        ],
                        'pending_command': None,
                        'events': events
                    }
                
            except Exception as e:
                print(f"Tool Execution Error: {e}", flush=True)
                # Fallback to legacy string command if present (backwards compat)
                command = parsed.get("command", "")
                if not command:
                     raise ValueError(f"Invalid tool call or execution failed: {e}")
        else:
            # Legacy Fallback
            command = parsed.get("command", "")

        if not command:
             raise ValueError("No command or tool call generated")

        events.append(emit_event("reflection", {"assessment": "EXECUTING", "reasoning": f"🔧 Executor Plan: {thought}"}))
        
        # --- SAFETY CHECK: REMEDIATION VERBS ---
        # Prevent execution of dangerous commands without checking config/state
        from ..config import REMEDIATION_VERBS, DANGEROUS_VERBS
        
        # Check against strict dangerous list (always block)
        if any(f"kubectl {verb}" in command or f" {verb} " in command for verb in DANGEROUS_VERBS):
             return {
                **state,
                'next_action': 'supervisor',
                'command_history': state['command_history'] + [
                    {'command': command, 'output': '', 'error': f'SECURITY BLOCK: Command "{command}" contains banned verb. Execution denied.'}
                ],
                'events': list(state.get('events', [])) + [emit_event("blocked", {"command": command, "reason": "dangerous_verb"})]
            }

        # Check against remediation list (require approval)
        # For now, we allow it ONLY if it came from a structured tool call (which we already validated)
        # AND we might want a "dry run" or specific flag in the future.
        # But since we defined specific Tool wrappers for these, we trust the Supervisor's intent 
        # IF the tool wrappers were used.
        # If raw string command was used, we BLOCK it.
        
        is_remediation = any(f"kubectl {verb}" in command or f" {verb} " in command for verb in REMEDIATION_VERBS)
        if is_remediation and not tool_call:
             return {
                **state,
                'next_action': 'supervisor',
                'command_history': state['command_history'] + [
                    {'command': command, 'output': '', 'error': f'SECURITY WARNING: remediation command "{command}" must be generated via precise tool calling, not raw text. Execution denied.'}
                ],
                'events': list(state.get('events', [])) + [emit_event("blocked", {"command": command, "reason": "unsafe_raw_remediation"})]
            }

        if is_remediation:
             print(f"[agent-sidecar] ⚠️ EXECUTING REMEDIATION COMMAND: {command}", flush=True)
             events.append(emit_event("warning", {"message": f"Executing remediation action: {command}"}))


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
        result = {
            **state,
            'next_action': 'verify',
            'pending_command': command,
            'events': events,
        }
        # Apply context override if set (immutable pattern)
        if context_override:
            result['kube_context'] = context_override
        return result
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

        # STRUCTURED OBSERVATION: Force JSON for simple GET commands
        # Logic: If it's a 'get' command, no pipes, no other output format -> append -o json
        if "kubectl get" in full_command and "|" not in full_command and "-o" not in full_command:
            full_command += " -o json"
            print(f"[agent-sidecar] ⚡ Upgraded command to JSON mode: {full_command}", flush=True)

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
        
        # STRUCTURED OBSERVATION LOGIC (Phase 2)
        # If this was a forced JSON command, parse it for the LLM
        output = raw_output
        is_json_output = False

        if "-o json" in full_command and returncode == 0 and stdout:
            try:
                # Try to parse and summarize
                summary = parse_kubectl_json_output(stdout)
                output = summary
                is_json_output = True
                print(f"[agent-sidecar] 🧠 Parsed JSON Output: {summary[:100]}...", flush=True)
            except Exception as e:
                # Medium #15 fix: Try partial JSON extraction before fallback
                print(f"[agent-sidecar] ⚠️ Full JSON parse failed: {e}", flush=True)
                import re
                json_match = re.search(r'\{[\s\S]*\}', stdout)
                if json_match:
                    try:
                        partial_summary = parse_kubectl_json_output(json_match.group(0))
                        output = partial_summary
                        is_json_output = True
                        print(f"[agent-sidecar] ✅ Partial JSON extraction succeeded", flush=True)
                    except:
                        output = smart_truncate_output(raw_output, max_chars=4000)
                else:
                    output = smart_truncate_output(raw_output, max_chars=4000)
        else:
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

        # NOTE: Removed duplicate auto-solve logic (High #7 fix)
        # Supervisor now handles all auto-solve decisions uniformly

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
    # Use index-based lookup to handle duplicate commands correctly
    all_combined = cached_results + execution_results
    cmd_to_results = {}
    for result in all_combined:
        cmd = result['command']
        if cmd not in cmd_to_results:
            cmd_to_results[cmd] = []
        cmd_to_results[cmd].append(result)

    # Build final list in original order, consuming one result per command occurrence
    all_results = []
    cmd_usage_count = {}
    for cmd in batch_commands:
        if cmd in cmd_to_results:
            idx = cmd_usage_count.get(cmd, 0)
            if idx < len(cmd_to_results[cmd]):
                all_results.append(cmd_to_results[cmd][idx])
                cmd_usage_count[cmd] = idx + 1

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
