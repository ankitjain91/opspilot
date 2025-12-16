"""
Response Formatter - Turn Raw Data into Intelligent Insights

Instead of dumping kubectl output, provide analyzed, actionable answers.
Uses LLM to synthesize findings instead of hardcoded keyword matching.
"""

import re
from typing import List, Dict, Any, Tuple
from .llm import call_llm


async def format_intelligent_response_with_llm(
    query: str,
    command_history: List[Dict],
    discovered_resources: Dict[str, List[str]],
    hypothesis: str = None,
    accumulated_evidence: List[str] = None,
    llm_endpoint: str = None,
    llm_model: str = None,
    llm_provider: str = "ollama",
    api_key: str | None = None
) -> str:
    """
    LLM-driven response synthesis - NO hardcoded keyword matching!

    Uses the brain model to analyze command history with assessments and
    generate an intelligent, comprehensive final response.
    """

    # Build context from command history with assessments
    investigation_context = []
    for idx, cmd_entry in enumerate(command_history, 1):
        cmd = cmd_entry.get('command', '')
        output = cmd_entry.get('output', '')[:1000]  # Limit output length
        error = cmd_entry.get('error', '')
        assessment = cmd_entry.get('assessment', '')
        reasoning = cmd_entry.get('reasoning', '')

        investigation_context.append(f"""
Step {idx}: {cmd}
Output: {output if output else '(empty)'}
{f'Error: {error}' if error else ''}
{f'Assessment: {assessment}' if assessment else ''}
{f'Reasoning: {reasoning}' if reasoning else ''}
""".strip())

    context_text = "\n\n".join(investigation_context)

    # Format accumulated evidence chain
    evidence_text = ""
    if accumulated_evidence:
        evidence_text = "Verified Facts (Accumulated Evidence):\n" + "\n".join([f"- {fact}" for fact in accumulated_evidence])

    # Prepare discovered resources summary
    resources_summary = ""
    if discovered_resources:
        resources_summary = "Discovered Resources:\n"
        for res_type, names in discovered_resources.items():
            resources_summary += f"- {res_type}: {len(names)} found\n"

    prompt = f"""You are analyzing the results of a Kubernetes cluster investigation.

**User Query:** {query}

**Investigation Steps Completed:**
{context_text}

{evidence_text}

{resources_summary}

{f'**Working Hypothesis:** {hypothesis}' if hypothesis else ''}

**Task:** You are writing THE ANSWER to the user's question based on the evidence above. NOT a summary of what was investigated, but the ACTUAL ANSWER they asked for.

**CRITICAL RESPONSE PHILOSOPHY:**
- **You are answering their question directly** - NOT summarizing the investigation
- **Use the evidence to answer** - Don't describe what you did, describe what EXISTS in the cluster
- **Be a knowledge source** - Answer as if you already knew the answer (don't mention investigation steps)
- **Present facts directly** - "The cluster has 3 pods running" NOT "I found 3 pods during investigation"

**ANSWER vs SUMMARY - THE DIFFERENCE:**
❌ WRONG (Summary): "Based on my investigation, I executed kubectl get pods and found 3 pods..."
✅ RIGHT (Answer): "Your cluster has 3 pods currently running: app-1, app-2, app-3."

❌ WRONG: "The investigation revealed no vclusters in the cluster..."
✅ RIGHT: "No vclusters are installed. The vcluster CRD is not present in your cluster."

❌ WRONG: "After checking events, I can report that..."
✅ RIGHT: "Here are the recent cluster events: ..."

**Response Style:**
1. **Answer-focused** - Write THE ANSWER, not a report about finding the answer
2. **Conversational and natural** - Like explaining something you know
3. **Concise** - 3-5 sentences for simple queries, 1-2 paragraphs for complex ones
4. **Direct** - Start with the answer, NOT "Based on investigation..." or "I found that..."
5. **Specific** - Use exact names, numbers, and status from the evidence
6. **Actionable** - If issues found, suggest what to do next (briefly)

**MANDATORY: IF ISSUES ARE FOUND, YOU MUST SUGGEST A FIX:**
- If you diagnosed a problem, provide the EXACT `kubectl` command to fix it.
- Examples: "Run `kubectl delete pod X` to restart it", "Edit the deployment with `kubectl edit deployment Y`".
- Do NOT be shy - the user wants to solve the problem.

**ABSOLUTELY BANNED PHRASES & PATTERNS - NEVER USE:**
- "Goal status: NOT MET"
- "investigation" (in any form)
- "Agent has not exhausted"
- "recommend extending"
- "unable to determine"
- "insufficient information"
- "Based on my investigation"
- "The investigation revealed"
- "Analysis shows"
- "After checking"
- "I executed"
- "I found that"
- "My findings"
- "Investigation steps"
- "Next steps" (this is investigative, not an answer!)
- Technical component names without explaining WHAT THEY MEAN (kube-apiserver, etcd, etc.)

**USER-FRIENDLY REQUIREMENTS:**
- Explain technical terms in plain English ("the control plane manages your cluster" NOT "kube-apiserver is down")
- Say "Your cluster has a problem" NOT "Control-plane components are Unknown"
- If something is broken, say WHAT IT MEANS for the user, not just the status code

**CRITICAL:** Output ONLY the final markdown response - NO JSON, NO function calls, NO code blocks around it!

**MANDATORY OUTPUT FORMAT - FILL IN THE BLANKS:**

For health/status queries, use EXACTLY this template:
```
[STATUS EMOJI] **Your cluster [is healthy / has problems].**

[IF PROBLEMS:]
The following issues were detected:
- [Issue 1 in plain English]
- [Issue 2 in plain English]

**Recommended Fix:**
[Provide the exact kubectl command or action to resolve the issue]

This means [what it means for the user in ONE sentence].
```

For "status of [resource]" queries (asking about a specific resource's status):
```
**[Resource Name] Status:**

[Parse the kubectl JSON output and extract the .status field]
[Present status conditions/phase/state in readable format]
[Show key status fields like ready, available, conditions, etc.]

[If status shows problems, explain what they mean]
```

**CRITICAL for status queries:**
- ALWAYS extract and parse the `.status` field from kubectl JSON output
- Show actual status values (phase, conditions, ready state, etc.)
- DO NOT just list the resource name and namespace
- Present status in plain English

For "find/list" queries, use EXACTLY this template:
```
**Found [NUMBER] [RESOURCE TYPE]:**
- [Name 1]
- [Name 2]
...

[OR if nothing found:]
No [RESOURCE TYPE] found in your cluster.
```

Generate ONLY the filled template (no JSON, no code fence, no extra text):"""

    max_retries = 2
    for attempt in range(max_retries):
        try:
            response = await call_llm(
                prompt,
                llm_endpoint,
                llm_model,
                llm_provider,
                temperature=0.3,
                force_json=False,
                api_key=api_key,
            )

            # Clean up any JSON wrapper if LLM returned it despite instructions
            cleaned = response.strip()

            # Remove code fences if present
            if cleaned.startswith('```'):
                lines = cleaned.split('\n')
                if lines[0].startswith('```'):
                    lines = lines[1:]
                if lines and lines[-1].startswith('```'):
                    lines = lines[:-1]
                cleaned = '\n'.join(lines)

            # Remove JSON wrapper if present
            if cleaned.startswith('{') and '"type":' in cleaned[:100]:
                # LLM returned JSON instead of markdown - extract from it
                import json
                try:
                    data = json.loads(cleaned)
                    # Try common keys where the actual response might be
                    for key in ['response', 'content', 'final_response', 'answer', 'result']:
                        if key in data:
                            cleaned = data[key]
                            break
                except:
                    pass  # Keep original if JSON parsing fails

            # DEBUG: Log raw LLM response before validation
            print(f"[response_formatter] DEBUG - Raw LLM response (attempt {attempt + 1}):", flush=True)
            print(f"--- START LLM RESPONSE ---", flush=True)
            print(cleaned[:500], flush=True)  # First 500 chars
            if len(cleaned) > 500:
                print(f"... (truncated, total {len(cleaned)} chars)", flush=True)
            print(f"--- END LLM RESPONSE ---", flush=True)

            # Validate response quality (includes banned phrase check)
            is_valid, error_msg = validate_response_quality(cleaned, query)

            if is_valid:
                print(f"[response_formatter] ✅ Validation PASSED - using LLM response", flush=True)
                return cleaned.strip()
            else:
                print(f"[response_formatter] ❌ Attempt {attempt + 1} FAILED validation: {error_msg}", flush=True)
                if attempt < max_retries - 1:
                    # Add stronger reminder to prompt for retry
                    prompt += f"\n\n**CRITICAL RETRY INSTRUCTION:** Previous response failed because: {error_msg}. Be EXTREMELY POSITIVE and solution-focused!"
                    continue
                else:
                    # Last attempt failed validation
                    print(f"[response_formatter] ⚠️  All {max_retries} attempts failed validation.", flush=True)
                    
                    # If response is empty or very short, force fallback
                    if not cleaned or len(cleaned) < 5:
                         print("[response_formatter] Response too short/empty after retries, using fallback.", flush=True)
                         return _format_simple_fallback(query, command_history, discovered_resources)
                    
                    # Otherwise return the "imperfect" response
                    return cleaned.strip()

        except Exception as e:
            print(f"[response_formatter] LLM synthesis failed (attempt {attempt + 1}): {e}", flush=True)
            if attempt == max_retries - 1:
                return _format_simple_fallback(query, command_history, discovered_resources)
            continue

    # Shouldn't reach here, but fallback just in case
    return _format_simple_fallback(query, command_history, discovered_resources)


def format_intelligent_response(
    query: str,
    command_history: List[Dict],
    discovered_resources: Dict[str, List[str]],
    hypothesis: str = None
) -> str:
    """
    Synchronous wrapper - creates simple summary without LLM.
    For LLM-driven synthesis, use format_intelligent_response_with_llm()
    """
    return _format_simple_fallback(query, command_history, discovered_resources)


def _format_simple_fallback(query: str, command_history: List[Dict], discovered_resources: Dict) -> str:
    """
    CRITICAL FAILSAFE: This function MUST ALWAYS return a useful response.
    Called when LLM formatting fails or returns empty results.

    Handles ALL edge cases:
    - No commands executed
    - All commands failed
    - All commands returned empty
    - Partial data available
    """

    # EDGE CASE 1: No commands executed at all
    if not command_history:
        return f"⚠️ Unable to investigate '{query}' - no commands were executed. Please check the cluster connection or try rephrasing your question."

    # EDGE CASE 2: Check if ALL commands failed with errors
    all_failed = all(cmd.get('error') for cmd in command_history)
    if all_failed:
        errors = [cmd.get('error', 'Unknown error') for cmd in command_history]
        unique_errors = list(set(errors))[:3]  # Show up to 3 unique errors
        return f"❌ **Unable to complete investigation** due to errors:\n\n" + "\n".join(f"- {e}" for e in unique_errors) + "\n\n💡 **Suggestion**: Check cluster connectivity and permissions."

    # EDGE CASE 3: Check if ALL commands returned empty (no output)
    all_empty = all(not cmd.get('output') or cmd.get('output').strip() == '' for cmd in command_history)
    if all_empty:
        # This is the Azure resources case - commands ran but found nothing
        query_lower = query.lower()

        # Provide helpful context based on query type
        if 'azure' in query_lower:
            return f"**No Azure resources found** in the cluster.\n\n**Possible reasons**:\n- Azure Crossplane provider is not installed\n- No Azure resources have been provisioned\n- Resources exist but use different naming/CRDs\n\n💡 **Try**: `kubectl get providers` to check installed Crossplane providers, or `kubectl api-resources | grep azure` to see available Azure resource types."

        elif any(word in query_lower for word in ['crossplane', 'managed', 'claim']):
            return f"**No Crossplane resources found** matching '{query}'.\n\n**Possible reasons**:\n- Crossplane is not installed in the cluster\n- No managed resources have been created\n- Resource type doesn't exist\n\n💡 **Try**: `kubectl get providers` or `kubectl get crd | grep crossplane`"

        else:
            # Generic empty result
            return f"**No resources found** matching '{query}'.\n\n**What I checked**:\n" + "\n".join(f"- `{cmd.get('command', 'N/A')}`" for cmd in command_history[-3:]) + f"\n\n💡 **Suggestion**: The requested resources may not exist in the cluster, or they use different names/types."

    # EDGE CASE 4: Some commands succeeded, some failed - partial data
    successful_commands = [cmd for cmd in command_history if cmd.get('output') and cmd.get('output').strip()]
    failed_commands = [cmd for cmd in command_history if cmd.get('error') or not cmd.get('output')]

    query_lower = query.lower()

    # Detect query type and format appropriately
    # Health/Status queries
    if any(word in query_lower for word in ['health', 'status', 'issue', 'problem', 'wrong']):
        has_errors = False
        error_summary = []

        for cmd in successful_commands[-5:]:
            output = cmd.get('output', '').lower()
            if any(bad in output for bad in ['crashloop', 'error', 'failed', 'unknown', 'imagepullbackoff', 'pending']):
                has_errors = True
                if 'unknown' in output:
                    error_summary.append("⚠️ Some components are not reporting healthy status")
                if 'crashloop' in output:
                    error_summary.append("❌ Containers are crash-looping")
                if 'imagepullbackoff' in output:
                    error_summary.append("❌ Image pull failures")

        if has_errors:
            response = "**Your cluster has issues:**\n\n"
            response += "\n".join(set(error_summary))
            response += "\n\n**What this means:** These problems will prevent workloads from running properly."
        else:
            response = "✅ **Your cluster appears healthy** based on the components I was able to check."

        if failed_commands:
            response += f"\n\n⚠️ Note: {len(failed_commands)} check(s) failed - some components couldn't be verified."

        return response

    # "Find/List" queries
    elif any(word in query_lower for word in ['find', 'list', 'show', 'get', 'all']):
        if discovered_resources:
            response = "**Here's what I found:**\n\n"
            for res_type, names in discovered_resources.items():
                if names:
                    response += f"- **{res_type}**: {', '.join(names[:5])}"
                    if len(names) > 5:
                        response += f" (and {len(names) - 5} more)"
                    response += "\n"
        else:
            # No discovered_resources, but we have outputs - format them
            response = "**Investigation Results:**\n\n"
            for cmd in successful_commands[-3:]:
                output = cmd.get('output', '').strip()
                if output:
                    # Check if output looks like kubectl table format
                    if '\n' in output and ('NAME' in output or 'NAMESPACE' in output):
                        lines = output.split('\n')
                        resource_count = len([l for l in lines if l.strip() and not l.startswith('NAME')])
                        response += f"Found {resource_count} resource(s):\n```\n{output[:500]}\n```\n\n"
                    else:
                        response += f"```\n{output[:300]}\n```\n\n"

        if failed_commands:
            response += f"\n⚠️ Note: {len(failed_commands)} command(s) failed during investigation."

        return response.strip() if response.strip() else f"I didn't find specific resources for '{query}'."

    # Generic fallback - show whatever we have
    if successful_commands:
        last_output = successful_commands[-1].get('output', '')[:500]
        response = f"**Based on cluster investigation:**\n\n```\n{last_output}\n```\n\n"
        if failed_commands:
            response += f"⚠️ Note: {len(failed_commands)} additional check(s) failed.\n\n"
        response += "💡 **For more details**, try a more specific query."
        return response

    # Absolute last resort - we have NOTHING useful
    return f"⚠️ **Unable to provide a definitive answer** for '{query}'.\n\n**What happened**: Investigation completed but results were inconclusive.\n\n💡 **Try**: Rephrasing your question or checking cluster connectivity."


def _format_discovery_response(query: str, command_history: List[Dict], discovered_resources: Dict) -> str:
    """Format 'find/list' query responses"""

    # Extract what was found from command outputs
    findings = []
    for cmd_entry in command_history:
        output = cmd_entry.get('output', '')
        if output and output.strip() and 'No resources found' not in output:
            findings.append({
                'command': cmd_entry['command'],
                'output': output
            })

    if not findings:
        return f"**No resources found** matching '{query}'.\n\nThe cluster doesn't contain any resources that match your search criteria."

    # Build intelligent summary
    response = f"## 🔍 Search Results: {query}\n\n"

    # Summarize discoveries
    if discovered_resources:
        response += "**Discovered Resources:**\n"
        for resource_type, names in discovered_resources.items():
            if names:
                response += f"- **{resource_type.title()}**: {len(names)} found\n"
                if len(names) <= 10:
                    response += f"  - {', '.join(names)}\n"
                else:
                    response += f"  - {', '.join(names[:10])}, ... ({len(names) - 10} more)\n"
        response += "\n"

    # Show detailed output
    response += "**Details:**\n\n"
    for finding in findings[-3:]:  # Show last 3 commands
        response += f"```\n{finding['output'][:1500]}\n```\n\n"

    return response.strip()


def _format_debugging_response(query: str, command_history: List[Dict], discovered_resources: Dict, hypothesis: str) -> str:
    """Format 'why/debug/troubleshoot' query responses"""

    # Extract errors and issues from command history
    issues = []
    root_causes = []

    for cmd_entry in command_history:
        output = cmd_entry.get('output', '')
        error = cmd_entry.get('error')

        # Look for common failure patterns
        if 'CrashLoopBackOff' in output:
            issues.append({'type': 'CrashLoopBackOff', 'details': _extract_crashloop_details(output)})
        if 'OOMKilled' in output or 'Exit 137' in output:
            root_causes.append({'cause': 'Out of Memory', 'details': 'Container exceeded memory limits'})
        if 'ImagePullBackOff' in output:
            issues.append({'type': 'ImagePullBackOff', 'details': _extract_image_error(output)})
        if 'Liveness probe failed' in output or 'Readiness probe failed' in output:
            issues.append({'type': 'Probe Failure', 'details': _extract_probe_failure(output)})
        if 'ASFailed' in output or 'Failed' in output:
            issues.append({'type': 'Resource Failed', 'details': _extract_resource_status(output)})

    if not issues and not root_causes:
        return _format_no_issues_found(query, command_history)

    # Build intelligent debugging response
    response = f"## 🔍 Investigation: {query}\n\n"

    # Show hypothesis if exists
    if hypothesis:
        response += f"**Hypothesis:** {hypothesis}\n\n"

    # Critical Issues
    if root_causes:
        response += "### ❌ **Root Causes Identified:**\n\n"
        for idx, cause in enumerate(root_causes, 1):
            response += f"{idx}. **{cause['cause']}**\n"
            response += f"   - {cause['details']}\n\n"

    # Issues Found
    if issues:
        response += "### ⚠️ **Issues Detected:**\n\n"
        for idx, issue in enumerate(issues, 1):
            response += f"{idx}. **{issue['type']}**\n"
            response += f"   - {issue['details']}\n\n"

    # Recommendations
    response += "### 💡 **Recommended Actions:**\n\n"
    response += _generate_recommendations(issues, root_causes)

    return response.strip()


def _format_health_response(query: str, command_history: List[Dict], discovered_resources: Dict) -> str:
    """Format cluster health check responses"""

    response = "## 🏥 Cluster Health Report\n\n"

    # Analyze health from command outputs
    healthy_count = 0
    unhealthy_count = 0
    warnings = []

    for cmd_entry in command_history:
        output = cmd_entry.get('output', '')

        # Count healthy vs unhealthy
        if 'Running' in output:
            healthy_count += output.count('Running')
        if any(status in output for status in ['CrashLoopBackOff', 'Error', 'Failed', 'Pending', 'Evicted', 'DiskPressure', 'EvictionThresholdMet', 'FreeDiskSpaceFailed']):
            unhealthy_count += 1
            warnings.append(_extract_warning(output))

    # Overall status
    if unhealthy_count == 0:
        response += "### ✅ **Status: Healthy**\n\n"
        response += "No critical issues detected in the cluster.\n\n"
    else:
        response += "### ⚠️ **Status: Issues Detected**\n\n"
        response += f"- Healthy resources: {healthy_count}\n"
        response += f"- Issues found: {unhealthy_count}\n\n"

    # Warnings
    if warnings:
        response += "### ⚠️ **Warnings:**\n\n"
        for warning in warnings[:5]:
            if warning:
                response += f"- {warning}\n"
        response += "\n"

    # Resource summary from discovered resources
    if discovered_resources:
        response += "### 📊 **Discovered Resources:**\n\n"
        for resource_type, names in discovered_resources.items():
            response += f"- **{resource_type.title()}**: {len(names)}\n"
        response += "\n"

    return response.strip()


def _format_generic_response(query: str, command_history: List[Dict], discovered_resources: Dict) -> str:
    """Generic response for other query types"""

    if not command_history:
        return "No information gathered yet. Please run some kubectl commands first."

    # Show last command output with some context
    last_cmd = command_history[-1]
    output = last_cmd.get('output', '')

    if not output or output.strip() == '':
        return "No data found for your query."

    response = f"## Results for: {query}\n\n"
    response += f"```\n{output[:2000]}\n```\n\n"

    if discovered_resources:
        response += "**Discovered Resources:**\n"
        for resource_type, names in discovered_resources.items():
            response += f"- {resource_type}: {len(names)}\n"

    return response.strip()


def _format_no_issues_found(query: str, command_history: List[Dict]) -> str:
    """Response when debugging but no issues found"""

    response = f"## ✅ Investigation Complete: {query}\n\n"
    response += "**No critical issues detected.**\n\n"

    # Show what was checked
    response += "**Checks Performed:**\n"
    for cmd_entry in command_history[-5:]:
        command = cmd_entry.get('command', '')
        if 'get' in command:
            response += f"- ✓ Checked: `{command}`\n"

    response += "\n**Conclusion:** The resources appear to be functioning normally."

    return response


# Helper functions for extracting specific details

def _extract_crashloop_details(output: str) -> str:
    """Extract details from CrashLoopBackOff errors"""
    lines = output.split('\n')
    for line in lines:
        if 'CrashLoopBackOff' in line:
            parts = line.split()
            if len(parts) >= 2:
                return f"Pod `{parts[1] if len(parts) > 1 else 'unknown'}` is crash looping"
    return "Containers are crash looping"


def _extract_image_error(output: str) -> str:
    """Extract details from ImagePullBackOff errors"""
    if '401' in output or 'unauthorized' in output.lower():
        return "Image pull failed: Authentication error (401)"
    elif '404' in output or 'not found' in output.lower():
        return "Image pull failed: Image not found (404)"
    else:
        return "Image pull failed: Check image name and registry access"


def _extract_probe_failure(output: str) -> str:
    """Extract probe failure details"""
    if '503' in output:
        return "Probe failed: Service unavailable (503) - container not ready"
    elif 'timeout' in output.lower():
        return "Probe failed: Timeout - container taking too long to respond"
    else:
        return "Health check probes are failing"


def _extract_resource_status(output: str) -> str:
    """Extract resource status details"""
    if 'ASFailed' in output:
        return "Automation Suite installation failed - check resource conditions"
    elif 'Failed' in output:
        # Try to extract namespace and name
        lines = output.split('\n')
        for line in lines:
            if 'Failed' in line:
                return f"Resource failure detected: {line.strip()[:100]}"
    return "Resource is in failed state"


def _extract_warning(output: str) -> str:
    """Extract warning message from output"""
    lines = output.split('\n')
    for line in lines:
        if any(word in line for word in ['Warning', 'Error', 'Failed', 'CrashLoop', 'Evicted', 'DiskPressure', 'FreeDiskSpaceFailed', 'EvictionThresholdMet']):
            return line.strip()[:300]  # Increased from 150 to 300 to show full event messages
    return None


def _generate_recommendations(issues: List[Dict], root_causes: List[Dict]) -> str:
    """Generate actionable recommendations based on issues"""

    recommendations = []

    # Recommendations for root causes
    for cause in root_causes:
        if 'Memory' in cause['cause']:
            recommendations.append("1. **Increase memory limits** in pod spec\n   - Check current usage with `kubectl top pods`")
        elif 'Image' in cause.get('details', ''):
            recommendations.append("1. **Fix image pull issues**\n   - Verify image name and tag\n   - Check registry credentials")

    # Recommendations for issues
    for issue in issues:
        if issue['type'] == 'Probe Failure':
            recommendations.append("2. **Investigate probe failures**\n   - Check application logs\n   - Verify liveness/readiness endpoints")
        elif issue['type'] == 'CrashLoopBackOff':
            recommendations.append("3. **Check container logs**\n   - Run `kubectl logs <pod> --previous` to see crash logs")
        elif issue['type'] == 'Resource Failed':
            recommendations.append("4. **Investigate resource failure**\n   - Run `kubectl describe` to see detailed error messages\n   - Check status.conditions and status.message fields")

    if not recommendations:
        recommendations.append("1. Review the detailed error messages above\n2. Check application logs for more context")

    return '\n'.join(recommendations[:5])  # Top 5 recommendations


def validate_response_quality(response: str, query: str) -> Tuple[bool, str]:
    """
    Validate response quality.
    
    Refactor (Native AI): Removed brittle banned phrase lists. 
    We trust the LLM's reasoning capabilities over hardcoded keywords.
    """
    
    # Basic sanity check: Response should not be empty or extremely short
    if len(response.strip()) < 5:
        return False, "Response too short"

    # Should not contain raw placeholder markers
    if any(placeholder in response for placeholder in ['<pod-name>', '<namespace>', '[namespace]', '${', '$NS']):
        return False, "Response contains unresolved placeholders"

    # Success
    return True, ""
