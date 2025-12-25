
import asyncio
import os
import subprocess
import re
import time
import json
from ..state import AgentState
from ..prompts.worker.main import WORKER_PROMPT
from ..llm import call_llm
from ..parsing import parse_worker_response
from ..utils import (
    truncate_output, smart_truncate_output, emit_event,
    get_cached_result, cache_command_result, parse_kubectl_json_output
)
from ..tools.k8s_python import run_k8s_python
from ..context_builder import (
    build_discovered_context,
    extract_resources_from_output,
    merge_discovered_resources
)
from ..extraction import extract_structured_data

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
    start_ts = time.time()
    # events.append(emit_event("progress", {"message": f"[TRACE] worker:start {start_ts:.3f}"}))
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
        
        # Emit intent before generating command (Fix Dead Air)
        try:
             from ..server import broadcaster
             await broadcaster.broadcast(emit_event("intent", {"type": "generating_command", "message": "Translating plan to executable commands..."}))
        except Exception:
             pass

        # Prefer stricter few-shot system prompt for Qwen models
        system_prefix = ""
        try:
            from ..prompts.qwen_fewshot import QWEN_TOOL_SYSTEM_PROMPT
            if 'qwen' in (executor_model or '').lower():
                system_prefix = QWEN_TOOL_SYSTEM_PROMPT.strip() + "\n\n"
        except Exception:
            pass
        response = await call_llm(system_prefix + prompt, state['llm_endpoint'], executor_model, state.get('llm_provider', 'ollama'), temperature=0.1, api_key=state.get('api_key'))
        try:
            parsed = parse_worker_response(response)
        except Exception as e_parse:
            # Retry once with a smaller CLI executor if available
            mini_model = None
            if isinstance(executor_model, str) and 'k8s-cli' in executor_model:
                mini_model = executor_model.replace('k8s-cli', 'k8s-cli-mini')
            if mini_model and mini_model != executor_model:
                events.append(emit_event("progress", {"message": f"⚡ Executor parse failed, retrying with {mini_model}"}))
                response = await call_llm(system_prefix + prompt, state['llm_endpoint'], mini_model, state.get('llm_provider', 'ollama'), temperature=0.1, api_key=state.get('api_key'))
                parsed = parse_worker_response(response)
            else:
                raise e_parse
        
        # New Structured Tool Logic
        command = ""
        tool_call = parsed.get("tool_call")
        batch_calls = parsed.get("batch_tool_calls")
        thought = parsed.get("thought", "Executing tool")
        context_override = None

        # PARALLEL EXECUTION LOGIC
        if batch_calls:
            try:
                from ..tools.definitions import AgentToolWrapper, KubectlContext, RunK8sPython
                from ..tools.safe_executor import SafeExecutor
                
                valid_shell_commands = []
                executed_python_results = []
                
                for tc in batch_calls:
                    # Validate each tool
                    wrapper = AgentToolWrapper(tool_call=tc)
                    tool_obj = wrapper.tool_call
                    
                    # 1. Handle Python Tools IMMEDIATELY (Sequence)
                    # Python tools run in-process, so we execute them here instead of sending to shell batch node
                    if isinstance(tool_obj, RunK8sPython):
                        print(f"[worker] 🐍 Executing Batch Python: {tool_obj.code[:50]}...", flush=True)
                        events.append(emit_event("progress", {"message": f"🐍 Executing Python Logic..."}))
                        
                        try:
                            output = run_k8s_python(tool_obj.code, context_name=state.get('kube_context'))
                            cmd_str = f"python: {tool_obj.code}"
                            
                            # Add to history/events immediately
                            events.append(emit_event("command_output", {"command": cmd_str, "output": output}))
                            executed_python_results.append({
                                'command': cmd_str, 
                                'output': output, 
                                'error': None if not output.startswith("Error") else output
                            })
                        except Exception as e:
                             print(f"[worker] ❌ Python Batch Error: {e}", flush=True)
                             executed_python_results.append({
                                'command': f"python: {tool_obj.code}", 
                                'output': "", 
                                'error': str(e)
                            })
                        continue

                    # 2. Handle Shell Tools (Wait for Batch Node)
                    # Block write operations in batch
                    # We only allow discovery/read-only tools in batch for safety
                    # shell_command is allowed for efficient filtering with grep/awk/jq
                    if tool_obj.tool not in ['kubectl_get', 'kubectl_describe', 'kubectl_logs', 'kubectl_events', 'kubectl_top', 'kubectl_api_resources', 'shell_command']:
                        print(f"[worker] ⚠️ Skipping unsafe batch tool: {tool_obj.tool}", flush=True)
                        continue
                        
                    # Build command
                    cmd = SafeExecutor.build_command(tool_obj, kube_context=state['kube_context'])
                    if cmd:
                        valid_shell_commands.append(cmd)
                
                # Determine Next Action based on what was executed/prepared
                new_history = state['command_history'] + executed_python_results
                
                if valid_shell_commands:
                    print(f"[worker] 🚀 Prepared {len(valid_shell_commands)} parallel commands", flush=True)
                    events.append(emit_event("progress", {"message": f"🚀 Preparing {len(valid_shell_commands)} parallel discovery commands..."}))
                    
                    return {
                        **state,
                        'next_action': 'execute_batch', # NEW STATE for batch execution
                        'pending_batch_commands': valid_shell_commands,
                        'command_history': new_history,
                        'events': events,
                        'pending_command': None
                    }
                elif executed_python_results:
                     # Only Python tools ran, go straight to reflect (skip execute_batch)
                     return {
                        **state,
                        'next_action': 'reflect',
                        'command_history': new_history,
                        'events': events,
                        'pending_command': None
                    }
            except Exception as e:
                print(f"[worker] ❌ Batch processing failed: {e}", flush=True)
                # Fallback to single command flow if batch fails
                pass

        # DEDUPLICATION CHECK: Prevent executing same command multiple times
        recent_command_strings = [normalize_command(h['command']) for h in state['command_history'][-5:]] if state['command_history'] else []

        if tool_call:
            try:
                from ..tools.definitions import AgentToolWrapper, KubectlContext, GitCommit, PredictScaling, RunK8sPython
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
                    from time import time as get_timestamp

                    # Generate branch name if missing
                    branch = tool_obj.branch_name or f"agent/patch-{int(get_timestamp())}"

                    # CRITICAL FIX: Add try/except for GitOps operations to prevent crashes
                    try:
                        with tempfile.TemporaryDirectory() as tmp_dir:
                            # 1. Clone
                            # Use subprocess for safety and simplicity
                            subprocess.run(["git", "clone", "--depth", "1", tool_obj.repo_url, tmp_dir], check=True, capture_output=True, text=True)

                            # 2. Checkout Branch
                            subprocess.run(["git", "checkout", "-b", branch], cwd=tmp_dir, check=True, capture_output=True, text=True)

                            # 3. Write File
                            full_path = os.path.join(tmp_dir, tool_obj.file_path)
                            os.makedirs(os.path.dirname(full_path), exist_ok=True)
                            with open(full_path, 'w') as f:
                                f.write(tool_obj.file_content)

                            # 4. Git Add & Commit
                            subprocess.run(["git", "add", "."], cwd=tmp_dir, check=True, capture_output=True, text=True)
                            subprocess.run(["git", "commit", "-m", tool_obj.commit_message], cwd=tmp_dir, check=True, capture_output=True, text=True)

                            # 5. Push
                            # Note: This might fail without auth. We catch exceptions.
                            subprocess.run(["git", "push", "origin", branch], cwd=tmp_dir, check=True, capture_output=True, text=True)

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
                            'events': events # + [emit_event("progress", {"message": f"[TRACE] worker:end {time.time():.3f}"})],
                        }

                    except subprocess.CalledProcessError as e:
                        # Git operation failed (auth error, network error, etc.)
                        error_msg = f"GitOps failed: {e.stderr if e.stderr else str(e)}"
                        print(f"[agent-sidecar] ❌ GitOps Error: {error_msg}", flush=True)

                        events.append(emit_event("error", {"message": f"Git operation failed: {error_msg[:200]}"}))

                        # Return error state instead of crashing
                        return {
                            **state,
                            'next_action': 'reflect',
                            'command_history': state['command_history'] + [
                                {'command': f"git push origin {branch}", 'output': '', 'error': error_msg}
                            ],
                            'pending_command': None,
                            'events': events,
                            'error': error_msg
                        }

                    except Exception as e:
                        # Unexpected error (filesystem, network, etc.)
                        error_msg = f"Unexpected GitOps error: {str(e)}"
                        print(f"[agent-sidecar] ❌ GitOps Unexpected Error: {error_msg}", flush=True)

                        events.append(emit_event("error", {"message": f"Git operation failed unexpectedly"}))

                        return {
                            **state,
                            'next_action': 'reflect',
                            'command_history': state['command_history'] + [
                                {'command': f"git commit (failed)", 'output': '', 'error': error_msg}
                            ],
                            'pending_command': None,
                            'events': events,
                            'error': error_msg
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
                        'events': events # + [emit_event("progress", {"message": f"[TRACE] worker:end {time.time():.3f}"})]
                    }

                # SPECIAL HANDLING: Filesystem Tools (Native Python Execution)
                from ..tools.definitions import ListDir, ReadFile, GrepSearch, FindFile, LocateSource
                from ..tools.fs_tools import WriteFile, write_file
                
                if isinstance(tool_obj, (ListDir, ReadFile, GrepSearch, FindFile, WriteFile)):
                     from ..tools import fs_tools
                     
                     output = ""
                     cmd_str = ""
                     
                     if isinstance(tool_obj, ListDir):
                         output = fs_tools.list_dir(tool_obj.path, tool_obj.recursive)
                         cmd_str = f"ls {'-R ' if tool_obj.recursive else ''}{tool_obj.path}"
                     elif isinstance(tool_obj, ReadFile):
                         output = fs_tools.read_file(tool_obj.path, tool_obj.max_lines, tool_obj.start_line)
                         cmd_str = f"read {tool_obj.path}"
                     elif isinstance(tool_obj, GrepSearch):
                         output = fs_tools.grep_search(tool_obj.query, tool_obj.path, tool_obj.recursive, tool_obj.case_insensitive)
                         cmd_str = f"grep '{tool_obj.query}' {tool_obj.path}"
                     elif isinstance(tool_obj, FindFile):
                         output = fs_tools.find_files(tool_obj.pattern, tool_obj.path)
                         cmd_str = f"find {tool_obj.path} -name '{tool_obj.pattern}'"
                     elif isinstance(tool_obj, WriteFile):
                        output = write_file(tool_obj.path, tool_obj.content, tool_obj.overwrite)
                        cmd_str = f"write {tool_obj.path}"

                     print(f"[agent-sidecar] 📂 FS Tool Execution: {cmd_str}", flush=True)
                     events.append(emit_event("command_output", {"command": cmd_str, "output": output}))
                     
                     return {
                        **state,
                        'next_action': 'reflect',
                        'command_history': state['command_history'] + [
                            {'command': cmd_str, 'output': output, 'error': None if not output.startswith("Error:") else output}
                        ],
                        'pending_command': None,
                        'events': events
                    }
                
                # SPECIAL HANDLING: Code Navigation (Smart Discovery)
                if isinstance(tool_obj, LocateSource):
                     from ..tools.code_nav import locate_source
                     
                     print(f"[agent-sidecar] 🧭 Locating Source Code: {tool_obj.file_pattern}", flush=True)
                     events.append(emit_event("progress", {"message": f"🧭 Scanning local source code for {tool_obj.file_pattern}..."}))
                     
                     output = locate_source(
                         file_pattern=tool_obj.file_pattern,
                         line_number=tool_obj.line_number,
                         project_mappings=state.get('project_mappings', [])
                     )
                     
                     cmd_str = f"locate_source(pattern='{tool_obj.file_pattern}')"
                     
                     events.append(emit_event("command_output", {"command": cmd_str, "output": output}))
                     
                     return {
                        **state,
                        'next_action': 'reflect',
                        'command_history': state['command_history'] + [
                            {'command': cmd_str, 'output': output, 'error': None if not output.startswith("Could not find") else output}
                        ],
                        'pending_command': None,
                        'events': events
                    }



                # SPECIAL HANDLING: Python Execution (The 10X Tool)
                if isinstance(tool_obj, RunK8sPython):
                    print(f"[agent-sidecar] 🐍 Executing 10X Python Code...", flush=True)
                    events.append(emit_event("progress", {"message": f"🐍 Executing Python Logic on cluster..."}))
                    
                    # Execute
                    output = run_k8s_python(tool_obj.code, context_name=state.get('kube_context'))
                    
                    cmd_str = f"python: {tool_obj.code}"
                    print(f"[agent-sidecar] 🐍 Result: {output[:200]}...", flush=True)
                    
                    events.append(emit_event("command_output", {"command": cmd_str, "output": output}))
                     
                    return {
                        **state,
                        'next_action': 'reflect',
                        'command_history': state['command_history'] + [
                            {'command': cmd_str, 'output': output, 'error': None if not output.startswith("Error initializing") else output}
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

        # CRITICAL FIX: Smart deduplication - allow retries if last attempt failed
        # Only block if the SAME command succeeded recently (within last 3 commands)
        normalized_cmd = normalize_command(command)

        # SMART DEDUPLICATION: Check last 5 commands with context-aware logic
        duplicate_info = None
        if state['command_history']:
            for idx, cmd_entry in enumerate(state['command_history'][-5:]):
                past_cmd = normalize_command(cmd_entry.get('command', ''))
                if past_cmd == normalized_cmd:
                    past_error = cmd_entry.get('error')
                    past_assessment = cmd_entry.get('assessment')
                    past_output = cmd_entry.get('output', '')

                    # Case 1: Command SOLVED the query - definitely block
                    if past_assessment == 'SOLVED':
                        duplicate_info = {
                            'reason': 'already_solved',
                            'message': f"This command already solved the query. Output: {past_output[:100]}...",
                            'output': past_output
                        }
                        break

                    # Case 2: Command validated but never executed (stuck in validation loop)
                    # No assessment, no error, no output = execution broken
                    elif not past_assessment and not past_error and not past_output:
                        duplicate_info = {
                            'reason': 'execution_stuck',
                            'message': "Previous attempt validated but never executed. Graph routing may be broken. Try a different command approach."
                        }
                        break

                    # Case 3: Command BLOCKED or validation FAILED - don't retry same thing
                    elif past_assessment in ['BLOCKED', 'FAILED']:
                        duplicate_info = {
                            'reason': 'blocked_or_failed',
                            'message': f"Command was blocked/failed: {past_error or 'validation failed'}. Try alternative approach."
                        }
                        break

                    # Case 4: Command succeeded but reflection said RETRY - allow retry with modifications
                    elif past_assessment == 'RETRY':
                        # Check if query/context changed since last attempt
                        current_query = state.get('query', '')
                        # Allow retry if it's been flagged for retry by reflection
                        print(f"[worker] ℹ️ Allowing retry of command (reflection requested RETRY)", flush=True)
                        continue  # Don't block

                    # Case 5: Command succeeded (CONTINUE) with valid output - block duplicate
                    elif past_assessment == 'CONTINUE' and past_output:
                        duplicate_info = {
                            'reason': 'already_succeeded',
                            'message': f"This command already executed successfully. Output: {past_output[:100]}...",
                            'output': past_output
                        }
                        break

                    # Case 6: No clear assessment but has output - likely succeeded, block
                    elif not past_assessment and past_output and not past_error:
                        duplicate_info = {
                            'reason': 'likely_succeeded',
                            'message': f"Command likely succeeded (has output, no error). Output: {past_output[:100]}...",
                            'output': past_output
                        }
                        break

                    # Edge case: Error occurred but no assessment - allow retry after short commands
                    elif past_error and not past_assessment:
                        # Count how many times this exact error occurred
                        error_count = sum(1 for c in state['command_history'][-5:]
                                        if normalize_command(c.get('command', '')) == normalized_cmd
                                        and c.get('error'))

                        if error_count >= 2:
                            duplicate_info = {
                                'reason': 'repeated_errors',
                                'message': f"Command failed {error_count} times with errors. Try different approach."
                            }
                            break
                        else:
                            print(f"[worker] ℹ️ Allowing retry after single error: {past_error[:100]}", flush=True)
                            continue  # Allow one retry

        if duplicate_info:
            reason = duplicate_info['reason']
            message = duplicate_info['message']

            print(f"[worker] 🚫 Smart deduplication blocked command", flush=True)
            print(f"[worker]    Reason: {reason}", flush=True)
            
            # FIX: If command succeeded before, return cached output to satisfy agent and prevent loops
            if reason in ['already_succeeded', 'already_solved', 'likely_succeeded'] and duplicate_info.get('output'):
                 print(f"[worker]    🔄 Returning CACHED OUTPUT to prevent infinite loop.", flush=True)
                 cached_out = duplicate_info['output']
                 events.append(emit_event("command_output", {"command": command, "output": cached_out, "cached": True}))
                 return {
                     **state,
                     'next_action': 'reflect',
                     'command_history': state['command_history'] + [
                         {'command': command, 'output': cached_out, 'error': None, 'cached': True}
                     ],
                     'events': events,
                     'pending_command': None
                 }

            print(f"[worker]    Command: {command}", flush=True)

            events.append(emit_event("progress", {
                "message": f"⚠️ Duplicate detected: {message}"
            }))

            return {
                **state,
                'next_action': 'supervisor',
                'error': f"Smart deduplication ({reason}): {message}",
                'events': events,
                'pending_command': None
            }

        # Store raw tool JSON for self-correction/verification path
        if tool_call:
            try:
                events.append(emit_event("progress", {"message": "🛠️ Validating tool JSON..."}))
            except Exception:
                pass
            state['pending_tool_json'] = json.dumps(tool_call)

        events.append(emit_event("reflection", {"assessment": "EXECUTING", "reasoning": f"🔧 Executor Plan: {thought}"}))
        # events.append(emit_event("progress", {"message": f"[TRACE] worker:end {time.time():.3f}"}))
        
        # --- SAFETY CHECK: REMEDIATION VERBS ---
        # Prevent execution of dangerous commands without checking config/state

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
        # Only add --context if not already present in command
        if state['kube_context'] and '--context' not in command:
            full_command = command.replace('kubectl ', f"kubectl --context={state['kube_context']} ", 1)

        print(f"[agent-sidecar] 🚀 NOTE: Executing command with context: {full_command}", flush=True)

        # REMOVED: Don't force -o json - prefer shell filtering with grep/awk/jq
        # The prompts now instruct the LLM to use pipes for efficient filtering
        # Only use -o json if explicitly requested by the LLM

        # Emit executing intent (immediate UI feedback)
        try:
             from ..server import broadcaster
             await broadcaster.broadcast(emit_event("intent", {"type": "executing", "message": f"Executing: {full_command}", "command": full_command}))
        except Exception:
             pass

        # Use asyncio subprocess for non-blocking execution (allows parallelization in future)
        proc = await asyncio.create_subprocess_shell(
            full_command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(os.environ),
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

        # STRUCTURED EXTRACTION: Extract debugging context from kubectl output
        # Use executor_model for extraction (it's configured for fast local execution)
        try:
            current_debugging_context = state.get('debugging_context', {})
            updated_debugging_context = await extract_structured_data(
                command=command,
                output=raw_output,
                current_context=current_debugging_context,
                llm_endpoint=state['llm_endpoint'],
                llm_provider=state['llm_provider'],
                llm_model=state.get('executor_model', state['llm_model']),  # Use executor model for speed
                api_key=state.get('api_key')
            )
            updated_state['debugging_context'] = updated_debugging_context
            print(f"[agent-sidecar] 🧠 Extracted context: {updated_debugging_context}", flush=True)
        except Exception as e:
            print(f"[agent-sidecar] ⚠️  Extraction failed: {e}", flush=True)
            # Continue without extraction if it fails

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
                env=dict(os.environ),
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
