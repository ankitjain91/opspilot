
import asyncio
import sys
import os
import json
import pytest
from unittest.mock import patch, MagicMock, AsyncMock
from typing import Dict, Any, List

# Add current dir to path to allow imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from agent_server.state import AgentState
    import agent_server.nodes.worker as worker_module
except ImportError:
    # If running from root
    sys.path.append(os.path.join(os.getcwd(), 'python'))
    from agent_server.state import AgentState
    import agent_server.nodes.worker as worker_module

# =============================================================================
# MOCK INFRASTRUCTURE
# =============================================================================

class MockProcess:
    def __init__(self, stdout: str = "", stderr: str = "", returncode: int = 0):
        self.stdout_data = stdout.encode('utf-8')
        self.stderr_data = stderr.encode('utf-8')
        self.returncode = returncode

    async def communicate(self):
        return self.stdout_data, self.stderr_data

    def kill(self):
        pass

    async def wait(self):
        return self.returncode

class MockK8sEnvironment:
    """Simulates a Kubernetes cluster state and responds to commands."""
    
    def __init__(self):
        self.scenarios = {} # Map command substring to (stdout, stderr, returncode)
        self.default_response = ("", "Error: resource not found", 1)
        self.command_log = []

    def set_scenario(self, command_pattern: str, stdout: str, stderr: str = "", returncode: int = 0):
        self.scenarios[command_pattern.lower()] = (stdout, stderr, returncode)

    def handle_command(self, command: str) -> MockProcess:
        self.command_log.append(command)
        cmd_lower = command.lower()
        
        # Find best matching scenario
        matched_result = None
        
        # Exact match first or contain match
        for pattern, result in self.scenarios.items():
            if pattern in cmd_lower:
                matched_result = result
                break
                
        if matched_result:
            return MockProcess(*matched_result)
            
        # Fallback for common things if not explicitly mocked
        if "get pods" in cmd_lower:
             return MockProcess("NAME                     READY   STATUS    RESTARTS   AGE\nsimple-pod               1/1     Running   0          5m", "", 0)
        
        return MockProcess(*self.default_response)

# =============================================================================
# TEST HELPERS
# =============================================================================

async def run_agent_eval(query: str, mock_k8s: MockK8sEnvironment):
    """Run the agent with a real LLM but mock K8s execution."""
    
    # Mock asyncio.create_subprocess_shell
    async def mock_subprocess(cmd, stdout=None, stderr=None):
        return mock_k8s.handle_command(cmd)

    # Mock human_approval_node implementation
    async def mock_auto_approve_node(state: AgentState) -> dict:
        print(f"\n[TEST] 🟢 Auto-approving command: {state.get('pending_command')}")
        return {
            **state,
            'next_action': 'execute',
            'awaiting_approval': False,
            'approved': True 
        }

    # Patch the worker execution and verification node
    with patch('asyncio.create_subprocess_shell', side_effect=mock_subprocess), \
         patch('agent_server.nodes.verify.human_approval_node', side_effect=mock_auto_approve_node):
        
        # Import inside the patch context to ensure we get the patched version
        from agent_server.graph import create_k8s_agent
        
        # Also patch get_cluster_recon to avoid initial real calls
        with patch('agent_server.utils.get_cluster_recon', return_value="Kubernetes v1.28.0 (Mock)"):
            
            # Create the agent graph inside the patched environment
            app = create_k8s_agent()
            
            # Initial State
            initial_state = {
                "messages": [],
                "query": query,
                "kube_context": "test-context",
                "iteration": 0,
                "command_history": [],
                "current_step": 0,
                "llm_endpoint": os.environ.get("LLM_ENDPOINT", "http://172.190.53.1:11434"),
                "llm_provider": os.environ.get("LLM_PROVIDER", "ollama"),
                "executor_model": os.environ.get("EXECUTOR_MODEL", "opspilot-brain"),
                "llm_model": os.environ.get("LLM_MODEL", "opspilot-brain"),
                "events": [],
                "discovered_resources": None
            }
            
            # Run the agent
            config = {"recursion_limit": 150}
            result_state = None
            
            # Iterate through the graph
            async for output in app.astream(initial_state, config=config):
                # The output contains the state updates from the last node
                for node_name, state_update in output.items():
                    print(f"\n--- Node: {node_name} ---")
                    if "next_action" in state_update:
                         print(f"Next Action: {state_update['next_action']}")
                    if "pending_command" in state_update:
                         print(f"Pending Command: {state_update['pending_command']}")
                    
                    result_state = state_update
                    
                    if "final_response" in state_update and state_update["final_response"]:
                         return state_update
                         
    return result_state
                         
    return result_state

# =============================================================================
# ACTUAL TESTS
# =============================================================================

@pytest.mark.asyncio
async def test_shallow_investigation_proficiency():
    """
    Eval: Can the agent perform a simple 'shallow' investigation?
    Task: List pods in the default namespace.
    Success: Agent runs 'kubectl get pods' and returns the list.
    """
    print("\n\n=== TEST: Shallow Investigation (Listing Pods) ===")
    
    mock_env = MockK8sEnvironment()
    mock_env.set_scenario("get pods", 
        stdout="NAME           READY   STATUS    RESTARTS   AGE\nbackend-api    1/1     Running   0          10m\nfrontend-ui    1/1     Running   0          10m",
        returncode=0
    )
    
    result = await run_agent_eval("List all running pods", mock_env)
    
    print(f"Final Response: {result.get('final_response')}")
    print(f"Command History: {[x['command'] for x in result.get('command_history', [])]}")
    
    # Assertions
    history = result.get('command_history', [])
    assert any("get pods" in cmd['command'] for cmd in history), "Agent should have run 'kubectl get pods'"
    assert "backend-api" in result['final_response'] or "backend-api" in str(history), "Result should mention backend-api"
    assert "frontend-ui" in result['final_response'] or "frontend-ui" in str(history), "Result should mention frontend-ui"


@pytest.mark.asyncio
async def test_deep_investigation_proficiency():
    """
    Eval: Can the agent perform a 'deep' investigation?
    Task: Diagnose a crashing pod.
    Success: Agent notices CrashLoopBackOff -> Checks Logs -> IDs Root Cause.
    """
    print("\n\n=== TEST: Deep Investigation (Crashing Pod) ===")
    
    mock_env = MockK8sEnvironment()
    
    # 1. Initial State: Pod is crashing
    # Matches "get pods", "get pods -A", etc.
    output_crash = "NAME           READY   STATUS             RESTARTS   AGE\npayment-svc    0/1     CrashLoopBackOff   5          2m"
    mock_env.set_scenario("get pods", stdout=output_crash, returncode=0)
    mock_env.set_scenario("payment-svc", stdout=output_crash, returncode=0) # Catch-all for simple greps

    # 2. Agent should describe or get logs. Let's mock both.
    mock_env.set_scenario("describe pod payment-svc", 
        stdout="... State: Waiting\n Reason: CrashLoopBackOff\n ... Last State: Terminated\n Reason: Error ...", 
        returncode=0
    )
    
    log_output = "[INFO] Starting payment service...\n[ERROR] ConnectionRefused: Could not connect to database at db-host:5432\n[FATAL] Exiting..."
    
    mock_env.set_scenario("logs payment-svc", stdout=log_output, returncode=0)
    mock_env.set_scenario("logs 0/1", stdout=log_output, returncode=0) # If it uses the READY count as name?
    mock_env.set_scenario("logs", stdout=log_output, returncode=0) # Broad catch-all for logs command if it contains 'logs'
    
    # Handle variations
    mock_env.set_scenario("logs -p payment-svc", stdout="... previous logs ...", returncode=0)
    
    # Handle get pod specific
    mock_env.set_scenario("get pod payment-svc", stdout=output_crash, returncode=0)

    result = await run_agent_eval("Why is the payment-svc crashing?", mock_env)
    
    response = result.get('final_response', '')
    history = result.get('command_history', [])
    
    print(f"Final Response: {response}")
    
    # Assertions
    # 1. Did it find the pod?
    assert any("payment-svc" in h['command'] for h in history), "Agent should target the specific pod"
    
    # 2. Did it run logs?
    assert any("logs" in h['command'] for h in history), "Agent should check logs for crashing pod"
    
    # 3. Did it find the root cause (database)?
    # Matches "database", "connection", "db-host"
    assert "database" in response.lower() or "connection" in response.lower(), "Agent should identify database connection issue"
    
async def test_complex_cluster_health_investigation():
    """Test agent's ability to perform a complex autonomous health check requiring multi-step plan execution."""
    print("\n=== TEST: Complex Cluster Health Investigation (Autonomous Deep Dive) ===")

    mock_env = MockK8sEnvironment()

    # Scenario: Cluster has multiple interconnected issues
    # 1. One node has DiskPressure
    # 2. Multiple pods evicted due to disk pressure
    # 3. A critical deployment has insufficient replicas due to evictions
    # 4. Recent warning events show cascading failures

    # Node status - one node has DiskPressure
    nodes_output = """NAME                                STATUS   ROLES   AGE   VERSION
aks-default-12345678-vmss000000     Ready    agent   30d   v1.27.7
aks-default-12345678-vmss000001     Ready,DiskPressure    agent   30d   v1.27.7
aks-default-12345678-vmss000002     Ready    agent   30d   v1.27.7"""

    mock_env.set_scenario("get nodes", stdout=nodes_output, returncode=0)
    mock_env.set_scenario("get node", stdout=nodes_output, returncode=0)

    # Failing/Evicted pods
    failing_pods = """NAMESPACE     NAME                          READY   STATUS    RESTARTS   AGE
kube-system   coredns-789d4bf8f-x7k9m       0/1     Evicted   0          2h
kube-system   coredns-789d4bf8f-p2l4n       0/1     Evicted   0          2h
production    api-server-6d8f9c-qw8rt       0/1     Evicted   0          1h
production    worker-5c7b8d-mn4kl           0/1     Evicted   0          1h"""

    mock_env.set_scenario("get pods -A | grep -vE 'Running|Completed'", stdout=failing_pods, returncode=0)
    mock_env.set_scenario("get pods -A", stdout=failing_pods + "\nproduction    api-server-6d8f9c-abc123      1/1     Running   0          5m", returncode=0)

    # Recent warning events showing disk pressure and evictions
    events_output = """NAMESPACE     LAST SEEN   TYPE      REASON                  OBJECT                          MESSAGE
kube-system   2m          Warning   FreeDiskSpaceFailed     node/vmss000001                 Failed to garbage collect required amount of images. Wanted to free 5367299072 bytes, but freed 0 bytes
kube-system   3m          Warning   EvictionThresholdMet    node/vmss000001                 Disk pressure: 85% disk usage
production    5m          Warning   Evicted                 pod/api-server-6d8f9c-qw8rt     The node was low on resource: ephemeral-storage
production    5m          Warning   Evicted                 pod/worker-5c7b8d-mn4kl         The node was low on resource: ephemeral-storage
kube-system   6m          Warning   Evicted                 pod/coredns-789d4bf8f-x7k9m     The node was low on resource: ephemeral-storage
kube-system   6m          Warning   Evicted                 pod/coredns-789d4bf8f-p2l4n     The node was low on resource: ephemeral-storage"""

    mock_env.set_scenario("get events", stdout=events_output, returncode=0)
    mock_env.set_scenario("events", stdout=events_output, returncode=0)

    # Deployment status showing insufficient replicas
    deployment_output = """NAME         READY   UP-TO-DATE   AVAILABLE   AGE
api-server   1/3     3            1           5d"""

    mock_env.set_scenario("get deployment", stdout=deployment_output, returncode=0)
    mock_env.set_scenario("get deployments", stdout=deployment_output, returncode=0)

    # Describe node showing disk pressure details
    node_describe = """Name:               vmss000001
Conditions:
  Type             Status  Reason                       Message
  ----             ------  ------                       -------
  MemoryPressure   False   KubeletHasSufficientMemory   kubelet has sufficient memory
  DiskPressure     True    KubeletHasDiskPressure       kubelet has disk pressure
  PIDPressure      False   KubeletHasSufficientPID      kubelet has sufficient PID
  Ready            True    KubeletReady                 kubelet is posting ready status
Capacity:
  ephemeral-storage:  129886128Ki
Allocatable:
  ephemeral-storage:  119716326508
Used:
  ephemeral-storage:  102958673Ki (86%)"""

    mock_env.set_scenario("describe node vmss000001", stdout=node_describe, returncode=0)
    mock_env.set_scenario("describe node", stdout=node_describe, returncode=0)

    # Run the test with a complex health check query
    result = await run_agent_eval("Perform an autonomous deep dive on the cluster health. Use the Autonomous Playbook.", mock_env)

    response = result.get('final_response', '')
    history = result.get('command_history', [])

    print(f"\n✓ Commands executed: {len(history)}")
    print(f"✓ Final Response Length: {len(response)} chars")
    print(f"\nFinal Response Preview:\n{response[:500]}...")

    # Assertions for complex investigation
    # 1. Should check nodes
    assert any("node" in h['command'].lower() for h in history), "Agent should check node status"

    # 2. Should check pods (failing/evicted)
    assert any("pod" in h['command'].lower() for h in history), "Agent should check pod status"

    # 3. Should check events
    assert any("event" in h['command'].lower() for h in history), "Agent should check cluster events"

    # 4. Should identify the root cause (disk pressure)
    assert any(keyword in response.lower() for keyword in ["disk pressure", "disk", "storage", "evict"]), \
        "Agent should identify disk pressure as root cause"

    # 5. Should identify affected node
    assert "vmss000001" in response or "000001" in response, \
        "Agent should identify the specific node with issues"

    # 6. Should mention evicted pods
    assert "evict" in response.lower(), \
        "Agent should mention pod evictions"

    # 7. Should provide a comprehensive summary (not just raw data)
    assert len(response) > 200, "Response should be comprehensive, not just raw kubectl output"

    # 8. Should have executed multiple commands (deep investigation)
    assert len(history) >= 3, "Deep dive should execute at least 3 investigation commands"

    print("\n[OK] TEST PASSED: Complex cluster health investigation successful")
    print(f"   - Checked {len(history)} different aspects")
    print(f"   - Identified disk pressure issue")
    print(f"   - Traced cascading pod evictions")
    print(f"   - Provided comprehensive health summary")

if __name__ == "__main__":
    # Allow running directly with python
    asyncio.run(test_shallow_investigation_proficiency())
    asyncio.run(test_deep_investigation_proficiency())
    asyncio.run(test_complex_cluster_health_investigation())
