"""
CLI Command Validator - Common validation for all CLI-based agents (Claude Code, Codex, etc.)

This module provides a unified command validation layer that intercepts and validates
commands before they are executed by any CLI-based agent backend.

Key Features:
1. Blocks all mutation operations (kubectl apply/delete, helm install, etc.)
2. Blocks dangerous shell operations (rm, chmod, etc.)
3. Validates Azure CLI commands (read-only only)
4. Validates MCP tool calls (blocks create/update/delete patterns)
5. Returns structured validation results with reasons
"""

import re
from typing import Tuple, Optional, List
from dataclasses import dataclass
from enum import Enum


class ValidationResult(Enum):
    """Result of command validation."""
    ALLOWED = "allowed"
    BLOCKED = "blocked"
    REQUIRES_APPROVAL = "requires_approval"


@dataclass
class CommandValidation:
    """Result of validating a command."""
    result: ValidationResult
    reason: str
    command: str
    suggestion: Optional[str] = None


# ============================================================================
# DANGEROUS COMMANDS - ALWAYS BLOCKED
# ============================================================================

# Kubectl mutation verbs - ALWAYS BLOCKED
KUBECTL_MUTATION_VERBS = [
    'apply', 'create', 'delete', 'patch', 'edit', 'replace',
    'set', 'annotate', 'label', 'taint', 'cordon', 'drain',
    'scale', 'rollout', 'autoscale', 'run', 'expose', 'cp'
]

# Helm mutation verbs - ALWAYS BLOCKED
HELM_MUTATION_VERBS = [
    'install', 'upgrade', 'uninstall', 'delete', 'rollback',
    'repo add', 'repo remove', 'repo update', 'plugin install'
]

# Safe helm verbs - ALLOWED
HELM_SAFE_VERBS = [
    'list', 'ls', 'status', 'get', 'show', 'search',
    'history', 'repo list', 'env', 'version'
]

# Azure CLI mutation verbs - ALWAYS BLOCKED
AZURE_MUTATION_VERBS = [
    'create', 'delete', 'update', 'start', 'stop', 'restart',
    'scale', 'resize', 'set', 'add', 'remove', 'attach', 'detach',
    'deallocate', 'redeploy', 'reimage'
]

# Azure CLI safe commands (prefixes) - ALLOWED
AZURE_SAFE_COMMANDS = [
    'az account show', 'az account list',
    'az aks show', 'az aks list', 'az aks get-credentials',
    'az vm show', 'az vm list',
    'az network show', 'az network list',
    'az storage account show', 'az storage account list',
    'az resource show', 'az resource list',
    'az group show', 'az group list',
    'az monitor', 'az log', 'az advisor',
    'az version', 'az --version'
]

# Dangerous shell commands - ALWAYS BLOCKED
DANGEROUS_SHELL_COMMANDS = [
    r'\brm\s+-rf\b', r'\brm\s+-r\b', r'\brm\s+--recursive\b',
    r'\bchmod\s+777\b', r'\bchmod\s+-R\b',
    r'\bchown\b', r'\bmkfs\b', r'\bdd\s+if=',
    r'\b:(){ :|:& };:\b',  # Fork bomb
    r'\bshutdown\b', r'\breboot\b', r'\bhalt\b',
    r'\bcurl\s+.*\|\s*sh\b', r'\bcurl\s+.*\|\s*bash\b',  # Pipe to shell
    r'\bwget\s+.*\|\s*sh\b', r'\bwget\s+.*\|\s*bash\b',
    r'>\s*/dev/sd[a-z]', r'>\s*/dev/null\s*2>&1\s*&',  # Background with output suppression
]

# MCP tool patterns - BLOCKED (mutations)
MCP_BLOCKED_PATTERNS = [
    # Generic mutation patterns (apply to all MCP servers)
    r'mcp__\w+__create_',
    r'mcp__\w+__update_',
    r'mcp__\w+__delete_',
    r'mcp__\w+__write_',
    r'mcp__\w+__push_',
    r'mcp__\w+__post_',
    r'mcp__\w+__put_',
    r'mcp__\w+__patch_',
    r'mcp__\w+__add_',
    r'mcp__\w+__remove_',
    r'mcp__\w+__set_',
    r'mcp__\w+__assign_',
    # Jira MCP - specific write operations
    r'mcp__jira__add_comment',
    r'mcp__jira__transition_issue',
    r'mcp__jira__assign_issue',
    # GitHub MCP - specific write operations
    r'mcp__github__create_',
    r'mcp__github__merge_',
    r'mcp__github__close_',
    # Azure DevOps MCP - specific write operations (ALL mutations blocked)
    r'mcp__azuredevops__create_work_item',
    r'mcp__azuredevops__update_work_item',
    r'mcp__azuredevops__create_pull_request',
    r'mcp__azuredevops__complete_pull_request',
    r'mcp__azuredevops__abandon_pull_request',
    r'mcp__azuredevops__queue_build',
    r'mcp__azuredevops__cancel_build',
    r'mcp__azuredevops__approve_',
    r'mcp__azuredevops__reject_',
    r'mcp__azuredevops__add_reviewer',
    r'mcp__azuredevops__remove_reviewer',
    r'mcp__azuredevops__add_comment',
    r'mcp__azuredevops__update_comment',
    r'mcp__azuredevops__delete_comment',
    # AKS MCP - specific write operations
    r'mcp__aks__start_',
    r'mcp__aks__stop_',
    r'mcp__aks__scale_',
    r'mcp__aks__upgrade_',
]

# Git mutation commands - BLOCKED
GIT_MUTATION_COMMANDS = [
    r'\bgit\s+push\b', r'\bgit\s+commit\b', r'\bgit\s+merge\b',
    r'\bgit\s+rebase\b', r'\bgit\s+reset\b', r'\bgit\s+checkout\s+-b\b',
    r'\bgit\s+branch\s+-[dD]\b', r'\bgit\s+tag\s+-d\b',
    r'\bgit\s+stash\s+drop\b', r'\bgit\s+clean\b',
]

# Git safe commands - ALLOWED
GIT_SAFE_COMMANDS = [
    'git status', 'git log', 'git show', 'git diff', 'git branch',
    'git remote', 'git fetch', 'git ls-files', 'git blame',
    'git rev-parse', 'git describe', 'git tag', 'git stash list'
]


def validate_command(command: str, allow_remediation: bool = False) -> CommandValidation:
    """
    Validate a command before execution.

    This is the main entry point for command validation. It checks the command
    against all safety rules and returns a structured result.

    Args:
        command: The command string to validate
        allow_remediation: If True, mutation commands will require approval instead of being blocked

    Returns:
        CommandValidation with result, reason, and optional suggestion
    """
    if not command or not command.strip():
        return CommandValidation(
            result=ValidationResult.ALLOWED,
            reason="empty_command",
            command=command
        )

    lower = command.lower().strip()

    # Check for dangerous shell commands first (highest priority)
    for pattern in DANGEROUS_SHELL_COMMANDS:
        if re.search(pattern, lower):
            return CommandValidation(
                result=ValidationResult.BLOCKED,
                reason="dangerous_shell",
                command=command,
                suggestion="This shell command is dangerous and blocked for safety."
            )

    # Check kubectl commands
    if 'kubectl' in lower:
        return _validate_kubectl(command, lower, allow_remediation)

    # Check helm commands
    if lower.startswith('helm '):
        return _validate_helm(command, lower, allow_remediation)

    # Check Azure CLI commands
    if lower.startswith('az '):
        return _validate_azure_cli(command, lower, allow_remediation)

    # Check git commands
    if lower.startswith('git '):
        return _validate_git(command, lower)

    # Check MCP tool calls (from tool_use events)
    if 'mcp__' in lower:
        return _validate_mcp_tool(command, lower)

    # Default: allow other commands (grep, cat, ls, find, etc.)
    return CommandValidation(
        result=ValidationResult.ALLOWED,
        reason="safe_command",
        command=command
    )


def _validate_kubectl(command: str, lower: str, allow_remediation: bool) -> CommandValidation:
    """Validate kubectl commands."""
    # Check for mutation verbs
    for verb in KUBECTL_MUTATION_VERBS:
        # Match verb as word boundary to avoid partial matches
        if re.search(rf'\bkubectl\s+{verb}\b', lower):
            if allow_remediation:
                return CommandValidation(
                    result=ValidationResult.REQUIRES_APPROVAL,
                    reason=f"kubectl_mutation_{verb}",
                    command=command,
                    suggestion=f"kubectl {verb} requires user approval."
                )
            return CommandValidation(
                result=ValidationResult.BLOCKED,
                reason=f"kubectl_mutation_{verb}",
                command=command,
                suggestion=f"kubectl {verb} is blocked. OpsPilot is in read-only mode. Run this command manually if needed."
            )

    # Check for exec with potentially dangerous commands
    if 'kubectl exec' in lower:
        dangerous_exec = ['rm ', 'chmod ', 'kill ', 'pkill ', 'mv ', 'dd ']
        for danger in dangerous_exec:
            if danger in lower:
                return CommandValidation(
                    result=ValidationResult.BLOCKED,
                    reason="kubectl_exec_dangerous",
                    command=command,
                    suggestion=f"kubectl exec with '{danger.strip()}' is blocked for safety."
                )

    # Safe kubectl command
    return CommandValidation(
        result=ValidationResult.ALLOWED,
        reason="kubectl_read_only",
        command=command
    )


def _validate_helm(command: str, lower: str, allow_remediation: bool) -> CommandValidation:
    """Validate helm commands."""
    # Check for mutation verbs
    for verb in HELM_MUTATION_VERBS:
        if f'helm {verb}' in lower:
            if allow_remediation:
                return CommandValidation(
                    result=ValidationResult.REQUIRES_APPROVAL,
                    reason=f"helm_mutation_{verb.replace(' ', '_')}",
                    command=command,
                    suggestion=f"helm {verb} requires user approval."
                )
            return CommandValidation(
                result=ValidationResult.BLOCKED,
                reason=f"helm_mutation_{verb.replace(' ', '_')}",
                command=command,
                suggestion=f"helm {verb} is blocked. Run this command manually if needed."
            )

    # Check if it's a known safe command
    is_safe = any(f'helm {verb}' in lower for verb in HELM_SAFE_VERBS)
    if is_safe:
        return CommandValidation(
            result=ValidationResult.ALLOWED,
            reason="helm_safe",
            command=command
        )

    # Unknown helm command - block by default
    return CommandValidation(
        result=ValidationResult.BLOCKED,
        reason="helm_unknown",
        command=command,
        suggestion="Unknown helm command. Only read-only helm commands are allowed."
    )


def _validate_azure_cli(command: str, lower: str, allow_remediation: bool) -> CommandValidation:
    """Validate Azure CLI commands."""
    # Check if it's a whitelisted safe command
    is_safe = any(lower.startswith(safe_cmd.lower()) for safe_cmd in AZURE_SAFE_COMMANDS)

    if is_safe:
        return CommandValidation(
            result=ValidationResult.ALLOWED,
            reason="azure_safe",
            command=command
        )

    # Check for mutation verbs
    for verb in AZURE_MUTATION_VERBS:
        if re.search(rf'\b{verb}\b', lower):
            if allow_remediation:
                return CommandValidation(
                    result=ValidationResult.REQUIRES_APPROVAL,
                    reason=f"azure_mutation_{verb}",
                    command=command,
                    suggestion=f"az {verb} requires user approval."
                )
            return CommandValidation(
                result=ValidationResult.BLOCKED,
                reason=f"azure_mutation_{verb}",
                command=command,
                suggestion=f"az {verb} is blocked. Only read-only Azure commands are allowed."
            )

    # Unknown Azure command - block by default (security-first)
    return CommandValidation(
        result=ValidationResult.BLOCKED,
        reason="azure_unknown",
        command=command,
        suggestion="Unknown Azure CLI command. Only whitelisted read-only commands are allowed."
    )


def _validate_git(command: str, lower: str) -> CommandValidation:
    """Validate git commands."""
    # Check for mutation commands
    for pattern in GIT_MUTATION_COMMANDS:
        if re.search(pattern, lower):
            return CommandValidation(
                result=ValidationResult.BLOCKED,
                reason="git_mutation",
                command=command,
                suggestion="Git write operations are blocked. Use read-only git commands."
            )

    # Check if it's a known safe command
    is_safe = any(lower.startswith(safe_cmd) for safe_cmd in GIT_SAFE_COMMANDS)
    if is_safe:
        return CommandValidation(
            result=ValidationResult.ALLOWED,
            reason="git_safe",
            command=command
        )

    # Unknown git command - allow by default (git is mostly read-safe)
    return CommandValidation(
        result=ValidationResult.ALLOWED,
        reason="git_unknown_allowed",
        command=command
    )


def _validate_mcp_tool(command: str, lower: str) -> CommandValidation:
    """Validate MCP tool calls."""
    for pattern in MCP_BLOCKED_PATTERNS:
        if re.search(pattern, lower):
            return CommandValidation(
                result=ValidationResult.BLOCKED,
                reason="mcp_mutation",
                command=command,
                suggestion="MCP write operations are blocked. Only read-only MCP tools are allowed."
            )

    # Allow read-only MCP tools
    return CommandValidation(
        result=ValidationResult.ALLOWED,
        reason="mcp_safe",
        command=command
    )


def validate_bash_command(command: str) -> CommandValidation:
    """
    Validate a Bash command specifically.

    This is used by Claude Code/Codex backends to validate commands
    before they are executed via the Bash tool.
    """
    return validate_command(command, allow_remediation=False)


def extract_command_from_tool_use(tool_name: str, tool_input: dict) -> Optional[str]:
    """
    Extract the command string from a tool_use event.

    Handles different tool types:
    - Bash: tool_input.command
    - MCP tools: tool_name itself
    """
    if tool_name == 'Bash':
        return tool_input.get('command', '')
    elif tool_name.startswith('mcp__'):
        # For MCP tools, validate the tool name pattern
        return tool_name
    return None


def format_blocked_message(validation: CommandValidation) -> str:
    """Format a user-friendly message for blocked commands."""
    base = f"🛡️ **Command Blocked**: `{validation.command[:100]}{'...' if len(validation.command) > 100 else ''}`\n\n"
    base += f"**Reason**: {validation.reason.replace('_', ' ').title()}\n\n"
    if validation.suggestion:
        base += f"**Suggestion**: {validation.suggestion}\n\n"
    base += "_OpsPilot is in read-only mode for safety. Mutation commands must be run manually._"
    return base
