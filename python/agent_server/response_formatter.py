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
    llm_endpoint: str = None,
    llm_model: str = None,
    llm_provider: str = "ollama"
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

{resources_summary}

{f'**Working Hypothesis:** {hypothesis}' if hypothesis else ''}

**Task:** Synthesize ALL the findings above into a comprehensive, user-friendly final response for the user.

**CRITICAL:** Output ONLY the final markdown response - NO JSON, NO function calls, NO code blocks around it!

**Requirements:**
1. **Analyze the assessments and reasoning** from each step (don't just repeat raw kubectl output)
2. **Identify key findings** - what did we discover? Any issues, warnings, or patterns?
3. **Root cause analysis** - if problems found, explain WHY they're happening based on evidence
4. **Be specific** - mention exact resource names (pods, nodes, deployments, etc.) and error messages
5. **Provide actionable recommendations** if issues detected
6. **Structure clearly** with markdown headers (##, ###) and bullet points

**Output Format (direct markdown, NO JSON wrapper):**
- Start with ## heading summarizing the investigation
- Use emoji indicators: ✅ (healthy), ⚠️ (warning), ❌ (critical issue)
- Include specific details from command outputs (resource names, statuses, error messages)
- End with recommendations if issues found

Generate ONLY the markdown response (no JSON, no code fence):"""

    try:
        response = await call_llm(prompt, llm_endpoint, llm_model, llm_provider, temperature=0.3, force_json=False)

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

        return cleaned.strip()
    except Exception as e:
        print(f"[response_formatter] LLM synthesis failed: {e}, falling back to simple summary", flush=True)
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
    """Simple fallback summary when LLM synthesis is not available"""

    if not command_history:
        return "No investigation steps completed yet."

    response = f"## Investigation Results: {query}\n\n"

    # Summarize command executions
    response += f"**Commands Executed:** {len(command_history)}\n\n"

    # Show discovered resources
    if discovered_resources:
        response += "**Discovered Resources:**\n"
        for res_type, names in discovered_resources.items():
            if names:
                response += f"- {res_type}: {len(names)} found\n"
        response += "\n"

    # Show last few command outputs with assessments
    response += "**Recent Findings:**\n\n"
    for cmd_entry in command_history[-3:]:
        cmd = cmd_entry.get('command', '')
        output = cmd_entry.get('output', '')[:500]
        assessment = cmd_entry.get('assessment', '')

        response += f"- Command: `{cmd}`\n"
        if assessment:
            response += f"  - Assessment: {assessment}\n"
        if output:
            response += f"  - Output: {output[:200]}...\n"
        response += "\n"

    return response.strip()


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
    Validate that the response meets quality standards.

    Returns: (is_valid, error_message)
    """
    query_lower = query.lower()

    # Response should not be too short
    if len(response.strip()) < 20:
        return False, "Response too short - needs more detail"

    # For debugging queries, should have analysis
    if any(word in query_lower for word in ['why', 'debug', 'troubleshoot', 'failing', 'issue']):
        # Should have either root cause section or "No issues" message
        has_root_cause = '❌' in response or 'Root Cause' in response or 'No issues' in response or 'No critical issues' in response
        if not has_root_cause:
            return False, "Debugging response missing root cause analysis"

    # For "find" queries, should have findings
    if any(word in query_lower for word in ['find', 'list', 'show']):
        # Should have either resources listed or "No resources found"
        has_findings = '**Discovered Resources:**' in response or 'No resources found' in response or '```' in response
        if not has_findings:
            return False, "Discovery response missing actual findings"

    # Should not contain raw placeholder markers
    if any(placeholder in response for placeholder in ['<pod-name>', '<namespace>', '[namespace]', '${', '$NS']):
        return False, "Response contains unresolved placeholders"

    # Success
    return True, ""
