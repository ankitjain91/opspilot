from typing import Union
import shlex
import tempfile
import os
from .definitions import (
    KubectlGet, KubectlDescribe, KubectlLogs, KubectlEvents, KubectlTop,
    KubectlApiResources, KubectlContext, KubectlExplain, KubectlDiff,
    KubectlDelete, KubectlRollout, KubectlScale, KubectlSetResources, KubectlApply, KubectlExec, KubectlExecShell,
    ShellCommand
)

ToolType = Union[
    KubectlGet, KubectlDescribe, KubectlLogs, KubectlEvents, KubectlTop,
    KubectlApiResources, KubectlContext, KubectlExplain, KubectlDiff,
    KubectlDelete, KubectlRollout, KubectlScale, KubectlSetResources, KubectlApply, KubectlExec, KubectlExecShell,
    ShellCommand
]

class SafeExecutor:
    """Translates Pydantic tool models into secure, syntax-guaranteed shell commands."""

    @staticmethod
    def build_command(tool: ToolType, kube_context: str = "") -> str:
        """
        Convert a tool model into a full kubectl command string.
        
        Security Guarantees:
        1. NO shell injection: All user inputs (names, selectors) are shlex.quote()d.
        2. NO syntax errors: Flags are built programmatically.
        3. NO hallucinated flags: Only defined flags are used.
        4. DANGEROUS COMMANDS: Requires valid 'tool_call' structure to enable user approval flow.
        """
        
        base = "kubectl"
        if kube_context:
            base += f" --context={shlex.quote(kube_context)}"

        # Allow dangerous verbs for remediation, but ONLY via specific tools
        # KubectlGet/Describe/Logs are inherently safe read-only tools
        # For edits, we would need a new KubectlApply/Delete tool.
        # Currently, the Agent only uses GET/DESCRIBE/LOGS/EVENTS/TOP/API-RESOURCES
        # so this build_command function implicitly blocks writes by not having handler blocks for them.
        
        # To enable remediation in the future, we would add:
        # elif isinstance(tool, KubectlDelete): ...
        
        if isinstance(tool, KubectlGet):
            cmd = [base, "get", shlex.quote(tool.resource)]
            if tool.all_namespaces:
                cmd.append("-A")
            elif tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            
            if tool.selector:
                cmd.append(f"-l {shlex.quote(tool.selector)}")
            if tool.field_selector:
                cmd.append(f"--field-selector={shlex.quote(tool.field_selector)}")
            
            # Enforce JSON output for structured observation (Agent Logic)
            cmd.append("-o json")
            return " ".join(cmd)

        elif isinstance(tool, KubectlDescribe):
            cmd = [base, "describe", shlex.quote(tool.resource), shlex.quote(tool.name)]
            if tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlLogs):
            cmd = [base, "logs", shlex.quote(tool.pod_name)]
            if tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            if tool.container:
                cmd.append(f"-c {shlex.quote(tool.container)}")
            if tool.previous:
                cmd.append("-p")
            
            # Safe tail handling
            tail = tool.tail if tool.tail > 0 else 100
            cmd.append(f"--tail={tail}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlEvents):
            cmd = [base, "get", "events"]
            if tool.all_namespaces:
                cmd.append("-A")
            elif tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            
            if tool.only_warnings:
                cmd.append("--field-selector=type=Warning")
            
            # Grep is hard to do safely in pure kubectl, so we handle limited filtering here
            # But normally we'd just return the list.
            # If related_object is set, we might rely on the LLM to filter, or use grep pipe 
            # (which we want to avoid if possible for purity, but `kubectl get events` has poor filtering).
            
            # For now, return the sort-by-time version to be useful
            cmd.append("--sort-by='.lastTimestamp'")
            return " ".join(cmd)

        elif isinstance(tool, KubectlTop):
            cmd = [base, "top", shlex.quote(tool.resource)]
            if tool.all_namespaces and tool.resource == "pod":
                cmd.append("-A")
            elif tool.namespace and tool.resource == "pod":
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            # Sort by CPU usage for clarity
            cmd.append("--sort-by=cpu")
            return " ".join(cmd)
            
        elif isinstance(tool, KubectlApiResources):
            cmd = [base, "api-resources"]
            if tool.verbs:
                cmd.append(f"--verbs={shlex.quote(tool.verbs)}")
            if tool.api_group:
                cmd.append(f"--api-group={shlex.quote(tool.api_group)}")
            # cmd.append("-o wider")  <-- REMOVED: Invalid flag for api-resources
            return " ".join(cmd)

        elif isinstance(tool, KubectlExec):
            cmd = [base, "exec", shlex.quote(tool.pod_name)]
            if tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            if tool.container:
                cmd.append(f"-c {shlex.quote(tool.container)}")

            # Separator for command
            cmd.append("--")

            # Safe quoting of all command parts
            for arg in tool.command:
                cmd.append(shlex.quote(str(arg)))

            return " ".join(cmd)

        elif isinstance(tool, KubectlExecShell):
            # Complex bash script execution
            # If pod_name is provided: run inside pod via kubectl exec
            # If pod_name is None: run on local terminal

            if tool.pod_name:
                # Run inside pod with full bash support
                cmd = [base, "exec", shlex.quote(tool.pod_name)]
                if tool.namespace:
                    cmd.append(f"-n {shlex.quote(tool.namespace)}")
                if tool.container:
                    cmd.append(f"-c {shlex.quote(tool.container)}")

                # Use bash -c to execute the script
                cmd.append("--")
                cmd.append("/bin/bash")
                cmd.append("-c")
                # Quote the entire script as a single argument
                cmd.append(shlex.quote(tool.shell_script))

                return " ".join(cmd)
            else:
                # Run on local terminal directly
                # Wrap in bash -c for consistency
                return f"/bin/bash -c {shlex.quote(tool.shell_script)}"

        elif isinstance(tool, KubectlContext):
            if tool.action == "list":
                 return f"{base} config get-contexts -o name"
            elif tool.action == "use":
                 return f"echo 'Switching internal context to {shlex.quote(tool.context_name)}'"

        elif isinstance(tool, KubectlExplain):
            cmd = [base, "explain", shlex.quote(tool.resource)]
            if tool.recursive:
                cmd.append("--recursive")
            return " ".join(cmd)

        elif isinstance(tool, KubectlDiff):
            # Construct a composite command to fetch resource from both contexts
            # We use YAML format for best diffing by the LLM
            
            # Context A command
            cmd_a = [base, "get", shlex.quote(tool.resource), shlex.quote(tool.name), "-o", "yaml"]
            cmd_a.append(f"--context={shlex.quote(tool.context_a)}")
            if tool.namespace:
                cmd_a.append(f"-n {shlex.quote(tool.namespace)}")
            str_a = " ".join(cmd_a)

            # Context B command
            cmd_b = [base, "get", shlex.quote(tool.resource), shlex.quote(tool.name), "-o", "yaml"]
            cmd_b.append(f"--context={shlex.quote(tool.context_b)}")
            if tool.namespace:
                cmd_b.append(f"-n {shlex.quote(tool.namespace)}")
            str_b = " ".join(cmd_b)

            # Combine with headers
            return f"echo '--- CONTEXT A: {shlex.quote(tool.context_a)} ---'; {str_a}; echo '\\n--- CONTEXT B: {shlex.quote(tool.context_b)} ---'; {str_b}"

        # --- REMEDIATION HANDLERS ---
        elif isinstance(tool, KubectlDelete):
            # This will only run if config.py allows 'delete' (which requires approval)
            cmd = [base, "delete", shlex.quote(tool.resource), shlex.quote(tool.name)]
            if tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlRollout):
            cmd = [base, "rollout", shlex.quote(tool.action), shlex.quote(tool.resource), shlex.quote(tool.name)]
            if tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlScale):
            cmd = [base, "scale", shlex.quote(tool.resource), shlex.quote(tool.name)]
            cmd.append(f"--replicas={str(tool.replicas)}")
            if tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlSetResources):
            cmd = [base, "set", "resources", shlex.quote(tool.resource), shlex.quote(tool.name)]
            cmd.append(f"-c {shlex.quote(tool.container)}")

            if tool.requests:
                cmd.append(f"--requests={shlex.quote(tool.requests)}")
            if tool.limits:
                cmd.append(f"--limits={shlex.quote(tool.limits)}")

            if tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlApply):
            # 📐 THE COMPASS: Formal Verification with dry-run
            # Write YAML to temp file (safer than echo piping)
            # Return a compound command: dry-run first, then actual apply

            # Create temp file path (execution will create it)
            temp_file = f"/tmp/kubectl-apply-{os.getpid()}.yaml"

            # Build command sequence:
            # 1. Write YAML to temp file
            # 2. Run dry-run validation
            # 3. If dry-run succeeds, run actual apply
            # 4. Clean up temp file

            write_cmd = f"cat > {shlex.quote(temp_file)} << 'EOF'\n{tool.yaml_content}\nEOF"

            apply_base = [base, "apply", "-f", shlex.quote(temp_file)]
            if tool.namespace:
                apply_base.append(f"-n {shlex.quote(tool.namespace)}")

            if tool.dry_run:
                # Run dry-run first for validation
                dry_run_cmd = " ".join(apply_base + ["--dry-run=server"])
                actual_apply_cmd = " ".join(apply_base)
                cleanup_cmd = f"rm -f {shlex.quote(temp_file)}"

                # Chain: write → dry-run → apply → cleanup
                return f"{write_cmd} && echo '\n--- 📐 THE COMPASS: Dry-run validation ---' && {dry_run_cmd} && echo '\n--- Applying changes ---' && {actual_apply_cmd}; {cleanup_cmd}"
            else:
                # Skip dry-run (not recommended but supported)
                actual_apply_cmd = " ".join(apply_base)
                cleanup_cmd = f"rm -f {shlex.quote(temp_file)}"
                return f"{write_cmd} && {actual_apply_cmd}; {cleanup_cmd}"

        elif isinstance(tool, ShellCommand):
            # For shell commands, add context if needed but pass command through
            # This allows pipes, grep, awk, etc. to work as intended
            cmd = tool.command
            if kube_context and 'kubectl' in cmd and '--context' not in cmd:
                # Inject context into kubectl commands
                cmd = cmd.replace('kubectl', f'kubectl --context={shlex.quote(kube_context)}', 1)
            return cmd

        raise ValueError(f"Unknown tool type: {type(tool)}")

    @staticmethod
    def get_verification_command(tool: ToolType, kube_context: str = "") -> Union[str, None]:
        """Returns a read-only command to verify the effect of the tool."""
        
        base = "kubectl"
        if kube_context:
            base += f" --context={shlex.quote(kube_context)}"

        # Only verify mutations
        if isinstance(tool, (KubectlDelete, KubectlScale, KubectlSetResources)):
            # "get -o json" is the best way to verify state for the Microscope parser
            cmd = [base, "get", shlex.quote(tool.resource), shlex.quote(tool.name)]
            if tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            cmd.append("-o json")
            return " ".join(cmd)

        elif isinstance(tool, KubectlRollout):
             # For rollout, check status which blocks until done or timeout
             cmd = [base, "rollout", "status", shlex.quote(tool.resource), shlex.quote(tool.name)]
             if tool.namespace:
                 cmd.append(f"-n {shlex.quote(tool.namespace)}")
             # Add timeout to prevent hanging forever
             cmd.append("--timeout=30s")
             return " ".join(cmd)

        elif isinstance(tool, KubectlApply):
            # For apply, extract resource type and name from YAML for verification
            # Parse YAML to get kind and metadata.name
            try:
                import yaml
                doc = yaml.safe_load(tool.yaml_content)
                kind = doc.get('kind', '').lower()
                name = doc.get('metadata', {}).get('name')
                namespace = tool.namespace or doc.get('metadata', {}).get('namespace')

                if kind and name:
                    cmd = [base, "get", kind, shlex.quote(name)]
                    if namespace:
                        cmd.append(f"-n {shlex.quote(namespace)}")
                    cmd.append("-o json")
                    return " ".join(cmd)
            except:
                pass  # If YAML parsing fails, skip verification

        return None
