
import re

# Mocked from config.py
DANGEROUS_VERBS = [
    'apply', 'edit', 'replace',
    'create', 'cordon', 'drain', 'taint', 'annotate',
    'label', 'cp'
]

REMEDIATION_VERBS = [
    'delete', 'rollout', 'scale', 'set'
]

AZURE_MUTATION_VERBS = [
    'create', 'delete', 'update', 'set', 'add', 'remove',
    'attach', 'detach', 'deploy', 'provision', 'deallocate',
    'start', 'stop', 'restart', 'reset', 'purge', 'revoke',
    'grant', 'assign', 'lock', 'unlock', 'move', 'invoke',
    'register', 'unregister', 'approve', 'reject', 'cancel',
    'failover', 'restore', 'upgrade', 'scale', 'reimage'
]

LARGE_OUTPUT_VERBS = [
    'get all', 'top', 'events -A', 'logs -f', 'get --watch', 'get events'
]

AZURE_SAFE_COMMANDS = ['az aks show', 'az aks list'] 

def is_safe_command(cmd: str) -> tuple[bool, str]:
    lower = cmd.lower().strip()

     # Azure CLI command detection and validation
    if lower.startswith('az '):
        # Check if it's a whitelisted safe command (starts with any safe prefix)
        is_safe_az = any(lower.startswith(safe_cmd.lower()) for safe_cmd in AZURE_SAFE_COMMANDS)

        if not is_safe_az:
            # Check if it contains mutation verbs
            has_mutation = any(re.search(rf'\b{verb}\b', lower) for verb in AZURE_MUTATION_VERBS)
            if has_mutation:
                return False, "AZURE_MUTATING"

            # If not explicitly safe and not clearly mutating, default to blocking
            # This is a security-first approach for Azure
            return False, "AZURE_UNKNOWN"

        # Safe Azure read command
        return True, "SAFE"

    # kubectl command validation
    if any(re.search(rf'\b{verb}\b', lower) for verb in DANGEROUS_VERBS):
        match = next(verb for verb in DANGEROUS_VERBS if re.search(rf'\b{verb}\b', lower))
        return False, f"MUTATING ({match})"

    # Check for remediation verbs
    if any(re.search(rf'\b{verb}\b', lower) for verb in REMEDIATION_VERBS):
        match = next(verb for verb in REMEDIATION_VERBS if re.search(rf'\b{verb}\b', lower))
        return False, f"REMEDIATION ({match})"

    if any(verb in lower for verb in LARGE_OUTPUT_VERBS):
        match = next(verb for verb in LARGE_OUTPUT_VERBS if verb in lower)
        return False, f"LARGE_OUTPUT ({match})"

    return True, "SAFE"

test_cases = [
    ("kubectl get pods", True, "SAFE"),
    ("kubectl get CustomerCluster", True, "SAFE"),
    ("kubectl --context=foo get pods -A", True, "SAFE"),
    ("kubectl delete pod foo", False, "REMEDIATION"),
    ("kubectl apply -f foo.yaml", False, "MUTATING"),
    ("kubectl get all", False, "LARGE_OUTPUT"),
    ("kubectl logs -f pod1", False, "LARGE_OUTPUT"),
    ("az aks show --name foo", True, "SAFE"),
    ("az aks delete --name foo", False, "AZURE_MUTATING"),
    ("az vm create --name foo", False, "AZURE_MUTATING"),
    ("az unknown command", False, "AZURE_UNKNOWN"),
    # The tricky case user reported
    ("kubectl --context=dedicated-aks-dev-eastus-ankitj get CustomerCluster -A -o json", True, "SAFE")
]

print("Running Safety Logic Verification...")
failures = 0
for cmd, expected_safe, expected_reason_prefix in test_cases:
    safe, reason = is_safe_command(cmd)
    
    # Check safety
    if safe != expected_safe:
        print(f"[X] FAIL: '{cmd}' -> Safe={safe}, Expected={expected_safe}")
        failures += 1
        continue
        
    # Check reason (loose match)
    if expected_reason_prefix not in reason and reason not in expected_reason_prefix: 
        # allow SAFE vs SAFE match
        if not (reason == "SAFE" and expected_reason_prefix == "SAFE"): 
            print(f"[X] FAIL: '{cmd}' -> Reason='{reason}', Expected='{expected_reason_prefix}'")
            failures += 1
            continue

    print(f"[OK] PASS: '{cmd}'")

if failures == 0:
    print("\nALL TESTS PASSED")
else:
    print(f"\n{failures} TESTS FAILED")
