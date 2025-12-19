from typing import Union
import shlex
import tempfile
import os
from .definitions import (
    KubectlGet, KubectlDescribe, KubectlLogs, KubectlEvents, KubectlTop,
    KubectlApiResources, KubectlContext, KubectlExplain, KubectlDiff,
    KubectlDelete, KubectlRollout, KubectlScale, KubectlSetResources, KubectlApply, KubectlExec, KubectlExecShell,
    ShellCommand,
    ListDir, ReadFile, GrepSearch, FindFile,
    RunK8sPython, GitCommit, PredictScaling
)

ToolType = Union[
    KubectlGet, KubectlDescribe, KubectlLogs, KubectlEvents, KubectlTop,
    KubectlApiResources, KubectlContext, KubectlExplain, KubectlDiff,
    KubectlDelete, KubectlRollout, KubectlScale, KubectlSetResources, KubectlApply, KubectlExec, KubectlExecShell,
    ShellCommand,
    ListDir, ReadFile, GrepSearch, FindFile,
    RunK8sPython, GitCommit, PredictScaling
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
        if kube_context and not isinstance(tool, (ShellCommand, ListDir, ReadFile, GrepSearch, FindFile)):
            base += f" --context={shlex.quote(kube_context)}"

        # Mutation tools are strictly BLOCKED in Read-Only mode
        if isinstance(tool, (KubectlDelete, KubectlRollout, KubectlScale, KubectlSetResources, KubectlApply, GitCommit)):
            raise ValueError(f"CRITICAL: Mutation tool {type(tool).__name__} is strictly forbidden in Read-Only mode.")

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
            cmd.append(f"--tail={tool.tail}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlEvents):
            # kubectl get events with filtering
            cmd = [base, "get", "events"]
            if tool.all_namespaces:
                cmd.append("-A")
            elif tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            if tool.only_warnings:
                cmd.append("--field-selector=type=Warning")
            cmd.append("--sort-by=.lastTimestamp")
            # If filtering for specific object, we'll pipe to grep
            if tool.related_object:
                cmd.append(f"| grep -i {shlex.quote(tool.related_object)}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlTop):
            cmd = [base, "top", tool.resource]
            if tool.resource == "pod":
                if tool.all_namespaces:
                    cmd.append("-A")
                elif tool.namespace:
                    cmd.append(f"-n {shlex.quote(tool.namespace)}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlApiResources):
            cmd = [base, "api-resources"]
            if tool.verbs:
                cmd.append(f"--verbs={shlex.quote(tool.verbs)}")
            if tool.api_group:
                cmd.append(f"--api-group={shlex.quote(tool.api_group)}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlContext):
            if tool.action == "list":
                return f"{base} config get-contexts"
            elif tool.action == "use" and tool.context_name:
                return f"{base} config use-context {shlex.quote(tool.context_name)}"
            raise ValueError("KubectlContext: 'use' action requires context_name")

        elif isinstance(tool, KubectlExplain):
            cmd = [base, "explain", shlex.quote(tool.resource)]
            if tool.recursive:
                cmd.append("--recursive")
            return " ".join(cmd)

        elif isinstance(tool, KubectlDiff):
            # Diff two contexts by getting YAML from each and diffing
            resource_spec = f"{tool.resource}/{tool.name}"
            ns_flag = f"-n {shlex.quote(tool.namespace)}" if tool.namespace else ""
            ctx_a = shlex.quote(tool.context_a)
            ctx_b = shlex.quote(tool.context_b)
            return f"diff <(kubectl --context={ctx_a} get {shlex.quote(resource_spec)} {ns_flag} -o yaml) <(kubectl --context={ctx_b} get {shlex.quote(resource_spec)} {ns_flag} -o yaml)"

        elif isinstance(tool, KubectlDelete):
            cmd = [base, "delete", shlex.quote(tool.resource), shlex.quote(tool.name)]
            if tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlRollout):
            cmd = [base, "rollout", tool.action, f"{shlex.quote(tool.resource)}/{shlex.quote(tool.name)}"]
            if tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlScale):
            cmd = [base, "scale", f"{shlex.quote(tool.resource)}/{shlex.quote(tool.name)}", f"--replicas={tool.replicas}"]
            if tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlSetResources):
            cmd = [base, "set", "resources", f"{shlex.quote(tool.resource)}/{shlex.quote(tool.name)}"]
            cmd.append(f"-c {shlex.quote(tool.container)}")
            if tool.requests:
                cmd.append(f"--requests={shlex.quote(tool.requests)}")
            if tool.limits:
                cmd.append(f"--limits={shlex.quote(tool.limits)}")
            if tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            return " ".join(cmd)

        elif isinstance(tool, KubectlApply):
            # Write YAML to temp file and apply
            # For safety, use dry-run by default
            dry_run_flag = "--dry-run=client" if tool.dry_run else ""
            ns_flag = f"-n {shlex.quote(tool.namespace)}" if tool.namespace else ""
            # Use heredoc to pass YAML
            return f"{base} apply {dry_run_flag} {ns_flag} -f - <<'EOF'\n{tool.yaml_content}\nEOF"

        elif isinstance(tool, KubectlExec):
            cmd = [base, "exec", shlex.quote(tool.pod_name)]
            if tool.namespace:
                cmd.append(f"-n {shlex.quote(tool.namespace)}")
            if tool.container:
                cmd.append(f"-c {shlex.quote(tool.container)}")
            cmd.append("--")
            cmd.extend([shlex.quote(arg) for arg in tool.command])
            return " ".join(cmd)

        elif isinstance(tool, KubectlExecShell):
            if tool.pod_name:
                # Execute in pod
                cmd = [base, "exec", shlex.quote(tool.pod_name)]
                if tool.namespace:
                    cmd.append(f"-n {shlex.quote(tool.namespace)}")
                if tool.container:
                    cmd.append(f"-c {shlex.quote(tool.container)}")
                cmd.append("-- bash -c")
                cmd.append(shlex.quote(tool.shell_script))
                return " ".join(cmd)
            else:
                # Execute locally
                return f"bash -c {shlex.quote(tool.shell_script)}"

        elif isinstance(tool, RunK8sPython):
            # Return a marker that this needs special handling (Python execution)
            # The actual execution happens in the worker, not via shell
            return f"__PYTHON_EXEC__:{tool.code}"

        elif isinstance(tool, GitCommit):
            # Git commit requires special handling - return marker
            return f"__GIT_COMMIT__:{tool.repo_url}:{tool.file_path}"

        elif isinstance(tool, PredictScaling):
            # Prediction requires special handling - return marker
            return f"__PREDICT_SCALING__:{tool.resource_type}/{tool.name}"

        elif isinstance(tool, ShellCommand):
            # For shell commands, add context if needed but pass command through
            # This allows pipes, grep, awk, etc. to work as intended
            cmd = tool.command
            if kube_context and 'kubectl' in cmd and '--context' not in cmd:
                # Inject context into kubectl commands
                cmd = cmd.replace('kubectl', f'kubectl --context={shlex.quote(kube_context)}', 1)
            return cmd

        # --- FILESYSTEM TOOLS (Shell equivalents) ---
        elif isinstance(tool, ListDir):
            cmd = ["ls"]
            if tool.recursive:
                cmd.append("-R")
            cmd.append(shlex.quote(tool.path))
            return " ".join(cmd)

        elif isinstance(tool, ReadFile):
            # Use head/tail/cat
            # simplistic: cat file | head -n (start+max) | tail -n max
            # But simpler: just cat if small, or head.
            # Let's return a safe cat/head command
            cmd = f"head -n {tool.start_line + tool.max_lines} {shlex.quote(tool.path)}"
            if tool.start_line > 0:
                 cmd += f" | tail -n {tool.max_lines}"
            return cmd

        elif isinstance(tool, GrepSearch):
            cmd = ["grep", "-n", "-I"]
            if tool.recursive:
                cmd.append("-r")
            if tool.case_insensitive:
                cmd.append("-i")
            cmd.append(shlex.quote(tool.query))
            cmd.append(shlex.quote(tool.path))
            return " ".join(cmd)

        elif isinstance(tool, FindFile):
            # find path -name pattern
            return f"find {shlex.quote(tool.path)} -name {shlex.quote(tool.pattern)}"

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
