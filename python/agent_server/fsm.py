"""
Finite State Machine (FSM) Enforcement for CRD Debugging

This module enforces strict phase progression for CRD troubleshooting.
Prevents the agent from skipping mandatory steps or transitioning prematurely.

Debug Phases:
1. INIT -> Resource not yet discovered
2. DISCOVER -> Finding resource location (namespace + name)
3. STATUS_CHECK -> Extracting status fields and error messages
4. CONTROLLER_SEARCH -> Finding the controller managing the CRD
5. LOG_ANALYSIS -> Checking controller logs for the resource
6. ROOT_CAUSE -> Root cause identified
"""

from typing import Tuple, Optional, Dict, List


class CRDDebuggingFSM:
    """Finite State Machine for CRD debugging workflow"""

    PHASES = [
        'INIT',
        'DISCOVER',
        'STATUS_CHECK',
        'CONTROLLER_SEARCH',
        'LOG_ANALYSIS',
        'ROOT_CAUSE'
    ]

    REQUIRED_EVIDENCE = {
        'DISCOVER': ['crd_type', 'resource_name', 'namespace'],
        'STATUS_CHECK': ['status_state'],
        'CONTROLLER_SEARCH': ['controller_pod', 'controller_namespace'],
        'LOG_ANALYSIS': ['controller_logs_checked'],
        'ROOT_CAUSE': ['error_message'],
    }

    def __init__(self):
        self.current_phase = 'INIT'

    def get_current_phase(self, debugging_context: Dict) -> str:
        """
        Determine current phase based on debugging context.

        This infers the phase from what evidence has been collected.
        """
        if not debugging_context:
            return 'INIT'

        # Check what evidence we have
        has_discovery = all(
            debugging_context.get(field)
            for field in self.REQUIRED_EVIDENCE['DISCOVER']
        )
        has_status = debugging_context.get('status_state')
        has_controller = debugging_context.get('controller_pod')
        has_logs = debugging_context.get('controller_logs_checked')
        has_root_cause = (
            debugging_context.get('root_cause_identified') or
            debugging_context.get('error_message')
        )

        # Determine phase based on evidence
        if has_root_cause:
            return 'ROOT_CAUSE'
        elif has_logs:
            return 'LOG_ANALYSIS'
        elif has_controller:
            return 'CONTROLLER_SEARCH'
        elif has_status:
            return 'STATUS_CHECK'
        elif has_discovery:
            return 'DISCOVER'
        else:
            return 'INIT'

    def can_transition_to_done(self, debugging_context: Dict) -> Tuple[bool, Optional[str]]:
        """
        Check if we can transition to DONE state.

        Returns (allowed, error_message)
        """
        current_phase = self.get_current_phase(debugging_context)

        # Can only finish from ROOT_CAUSE phase
        if current_phase != 'ROOT_CAUSE':
            return False, f"Cannot finish from {current_phase} - must reach ROOT_CAUSE first"

        # Verify we have root cause
        has_root_cause = (
            debugging_context.get('root_cause_identified') or
            debugging_context.get('error_message')
        )

        if not has_root_cause:
            return False, "Cannot finish without identifying root cause"

        return True, None

    def get_missing_evidence(self, debugging_context: Dict) -> List[str]:
        """Get list of missing evidence fields for current phase"""
        current_phase = self.get_current_phase(debugging_context)

        if current_phase not in self.REQUIRED_EVIDENCE:
            return []

        required = self.REQUIRED_EVIDENCE[current_phase]
        missing = []

        for field in required:
            if not debugging_context.get(field):
                missing.append(field)

        return missing

    def next_required_action(self, debugging_context: Dict, query: str) -> str:
        """
        Return what action MUST happen next based on current phase.

        This generates specific instructions for the worker/supervisor.
        """
        current_phase = self.get_current_phase(debugging_context)
        missing = self.get_missing_evidence(debugging_context)

        if current_phase == 'INIT':
            # Extract resource type from query
            q_lower = query.lower()
            if 'customercluster' in q_lower:
                resource_type = 'customercluster'
            elif 'composition' in q_lower:
                resource_type = 'composition'
            elif 'claim' in q_lower:
                resource_type = 'claim'
            else:
                resource_type = '<resource>'

            return f"DISCOVER phase: Find {resource_type} with: kubectl get {resource_type}s -A | grep <name>"

        elif current_phase == 'DISCOVER':
            if 'resource_name' in missing:
                return "DISCOVER incomplete: Must find resource name and namespace"
            else:
                crd_type = debugging_context.get('crd_type', '<type>')
                name = debugging_context.get('resource_name', '<name>')
                ns = debugging_context.get('namespace', '<namespace>')
                return f"STATUS_CHECK phase: Extract status with: kubectl get {crd_type} {name} -n {ns} -o json | jq '.status'"

        elif current_phase == 'STATUS_CHECK':
            crd_type = debugging_context.get('crd_type', '<type>')
            name = debugging_context.get('resource_name', '<name>')
            ns = debugging_context.get('namespace', '<namespace>')
            return f"CONTROLLER_SEARCH phase: Find controller using all 4 methods (label-based, namespace-based, owner-ref, keyword)"

        elif current_phase == 'CONTROLLER_SEARCH':
            if 'controller_pod' in missing:
                return "CONTROLLER_SEARCH incomplete: Must try all 4 controller discovery methods"
            else:
                controller = debugging_context.get('controller_pod', '<controller>')
                controller_ns = debugging_context.get('controller_namespace', 'upbound-system')
                name = debugging_context.get('resource_name', '<resource>')
                return f"LOG_ANALYSIS phase: Check logs with: kubectl logs {controller} -n {controller_ns} --tail=500 | grep -i '{name}'"

        elif current_phase == 'LOG_ANALYSIS':
            return "ROOT_CAUSE phase: Analyze logs and identify root cause from error messages"

        elif current_phase == 'ROOT_CAUSE':
            return "CRD debugging complete - root cause identified"

        return f"Unknown phase: {current_phase}"

    def validate_transition(self, debugging_context: Dict, proposed_action: str) -> Tuple[bool, Optional[str]]:
        """
        Validate if a proposed action is valid for the current phase.

        Returns (allowed, error_message)
        """
        current_phase = self.get_current_phase(debugging_context)
        missing = self.get_missing_evidence(debugging_context)

        # Check if we're trying to skip phases
        if proposed_action == 'respond' or proposed_action == 'done':
            if current_phase != 'ROOT_CAUSE':
                return False, f"Cannot respond from {current_phase}. Must complete: {self.next_required_action(debugging_context, '')}"

        # Check if we have all evidence for current phase
        if missing:
            return False, f"Missing evidence for {current_phase}: {missing}"

        return True, None


def is_crd_debugging_query(query: str) -> bool:
    """Check if this is a CRD debugging query that requires FSM enforcement"""
    q_lower = query.lower()

    # Check for troubleshooting keywords
    is_troubleshooting = any(word in q_lower for word in [
        'failing', 'failed', 'asfailed', 'why', 'troubleshoot',
        'investigate', 'debug', 'crashed', 'not working'
    ])

    # Check for CRD types
    is_crd = any(word in q_lower for word in [
        # Crossplane/Upbound
        'customercluster', 'composition', 'claim', 'managed resource',
        'xrd', 'composite', 'provider',
        # Azure Service Operator
        'azuredatabase', 'resourcegroup', 'storageaccount',
        'sqldatabase', 'cosmosdb', 'keyvault',
        # Other operators
        'application', 'appproject', 'virtualservice',
        'certificate', 'issuer', 'clusterissuer'
    ])

    return is_troubleshooting and is_crd


def enforce_fsm_rules(
    query: str,
    debugging_context: Dict,
    next_action: str,
    command_history: List[Dict]
) -> Tuple[bool, Optional[str], Optional[str]]:
    """
    Enforce FSM rules for CRD debugging.

    Args:
        query: User's query
        debugging_context: Current debugging context
        next_action: Proposed next action
        command_history: History of executed commands

    Returns:
        (allowed, error_message, required_action)
        - allowed: Whether the action is allowed
        - error_message: Why it's not allowed (if applicable)
        - required_action: What should happen instead
    """
    if not is_crd_debugging_query(query):
        return True, None, None  # Not a CRD query, no enforcement

    fsm = CRDDebuggingFSM()
    current_phase = fsm.get_current_phase(debugging_context or {})

    # Mark log analysis phase if we've checked logs
    if command_history:
        checked_logs = any('kubectl logs' in cmd.get('command', '') for cmd in command_history)
        if checked_logs and debugging_context:
            debugging_context['controller_logs_checked'] = True

    # Check if trying to finish prematurely
    if next_action in ['respond', 'done', 'synthesizer']:
        allowed, error = fsm.can_transition_to_done(debugging_context or {})
        if not allowed:
            required = fsm.next_required_action(debugging_context or {}, query)
            return False, error, required

    return True, None, None
