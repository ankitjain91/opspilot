import asyncio
import sys
import os
import json
import argparse
from pathlib import Path
from unittest.mock import patch, MagicMock
from contextlib import ExitStack

# Add project root to path
PROJECT_ROOT = Path(__file__).parents[3]
sys.path.append(str(PROJECT_ROOT / "python"))

from mock_env import MockK8sEnvironment

# Try importing agent logic
try:
    from agent_server.state import AgentState
    from agent_server.graph import create_k8s_agent
except ImportError:
    print("Error: Could not import agent_server modules. Ensure PYTHONPATH includes python/")
    sys.exit(1)

async def run_single_eval(query_data: dict, debug: bool = False, use_real_llm: bool = False):
    """Run a single evaluation test case."""
    
    query = query_data['query']
    test_id = query_data['id']
    mock_scenarios = query_data.get('mock_scenarios', {})
    
    print(f"\n🧪 Running Test: [{test_id}] {query}")
    
    # Setup Mock Env
    mock_env = MockK8sEnvironment()
    for cmd, result in mock_scenarios.items():
        mock_env.set_scenario(cmd, result.get('stdout', ''), result.get('stderr', ''), result.get('returncode', 0))
        
    # Mock subprocess
    async def mock_subprocess(cmd, stdout=None, stderr=None):
        if debug: print(f"  [MOCK EXEC] {cmd}")
        return mock_env.handle_command(cmd)

    # Mock Auto-Approver
    async def mock_auto_approve_node(state: AgentState) -> dict:
        if query_data.get('requires_approval', False):
             print(f"  [APPROVER] Auto-approving dangerous command: {state.get('pending_command')}")
        return {**state, 'next_action': 'execute', 'awaiting_approval': False, 'approved': True}

    # Mock LLM Logic
    async def mock_call_llm(prompt: str, *args, **kwargs) -> str:
        prompt_lower = prompt.lower()
        if debug: print(f"DEBUG PROMPT: {prompt[:200]}...")
        
        # 5. Synthesizer / Response Formatter
        if "answer a user's question" in prompt_lower or "sufficient to answer" in prompt_lower or "analyzing the results of a kubernetes cluster investigation" in prompt_lower:
            # Check for the specific test cases to provide correct final answers
            if "scale the frontend deployment" in prompt_lower:
                return json.dumps({
                    "can_answer": True,
                    "confidence": 1.0,
                    "reasoning": "I scaled the deployment as requested.",
                    "final_response": "I have scaled the frontend deployment to 5 replicas."
                })
            # Check for "List pods" case
            elif "list" in prompt_lower and "all pods" in prompt_lower:
                 return json.dumps({
                    "can_answer": True,
                    "confidence": 1.0, 
                    "reasoning": "Listed pods successfully.",
                    "final_response": "Found 3 pods: nginx-app, db-service, backend-api."
                })
            # Check for "Crashloop" case
            if "crash" in prompt_lower and "backend-api" in prompt_lower:
                  return json.dumps({
                    "can_answer": True,
                    "confidence": 1.0,
                    "reasoning": "Identified crash reason.",
                    "final_response": "The backend-api pod is crashing because 'authentication failed' for user 'postgres' (password mismatch)."
                })

            # Fallback for other cases
            return json.dumps({
                "can_answer": True,
                "confidence": 0.8,
                "reasoning": "Based on the analysis, the task is complete.",
                "final_response": "Based on the analysis, the task is complete. [This is a mock response]"
            })
        
        # 6. Verify / Command Validator
        if "verify this kubectl command" in prompt_lower or "safe and correct" in prompt_lower:
             return json.dumps({
                "thought": "Command is safe.",
                "approved": True,
                "corrected_command": ""
             })

        # 1. Supervisor / Planning Phase
        if "expert kubernetes assistant" in prompt_lower or "manage hypotheses" in prompt_lower:
            tools_to_run = query_data.get('expected_tools', [])
            
            execution_steps = []

            if "why is the backend-api pod crashing" in prompt_lower:
                execution_steps = ["List pods", "Check logs"] 
            elif "list all pods" in prompt_lower:
                execution_steps = ["List pods"]
            elif "scale the frontend deployment" in prompt_lower:
                execution_steps = ["Scale deployment", "Check deployment"]
            
            if not execution_steps:
                # Fallback to expected_tools if no specific query match
                for tool in tools_to_run:
                    if "kubectl_get" in tool:
                        execution_steps.append("List pods")
                    elif "kubectl_logs" in tool:
                        execution_steps.append("Check logs")
                    elif "kubectl_scale" in tool:
                        execution_steps.append("Scale deployment")

            return json.dumps({
                "thought": "I need to investigate the cluster state.",
                "plan": "Execute investigation tools", 
                "next_action": "create_plan",
                "execution_steps": execution_steps,
                "confidence": 0.9
            })

        # 2. Critic (The Judge)
        if "the judge" in prompt_lower or "reviewing execution plans" in prompt_lower:
            return json.dumps({
                "approved": True,
                "critique": "Plan is safe and relevant."
            })
            
        # 3. Worker (Command Generator)
        if "generate" in prompt_lower or "command" in prompt_lower or "you are an intelligent" in prompt_lower:
            # Debug: Check command history length
            hist_len = prompt.count("$ kubectl") # Heuristic to count history items in prompt
            if debug: print(f"DEBUG WORKER: Prompt History Size approx {hist_len}")
            
            import time
            timestamp = int(time.time() * 1000)
            
            # Strict Prompt Parsing to avoid matching System Prompt examples
            import re
            step_match = re.search(r'current step:\s*(.+?)\n', prompt, re.IGNORECASE)
            current_step = step_match.group(1).lower() if step_match else prompt_lower
            
            cmd = "echo 'mock command'"
            if "list pods" in current_step or "check pod status" in current_step:
                cmd = f"kubectl get pods # {timestamp}"
            elif "check deployment" in current_step:
                cmd = f"kubectl get deployment frontend # {timestamp}"
            elif "check logs" in current_step:
                cmd = f"kubectl logs backend-api -n default # {timestamp}"
            elif "scale" in current_step:
                # Be specific for the scale test
                cmd = f"kubectl scale deployment frontend --replicas=5 -n default # {timestamp}"
            elif "kubectl" in current_step:
                 # If step description mentions kubectl command directly
                 m = re.search(r'kubectl [^\n]+', current_step)
                 if m: cmd = f"{m.group(0)} # {timestamp}"

            return json.dumps({
                "thought": "Generating command likely...",
                "command": cmd,
                "explanation": "Executes the requested step."
            })

        # 4. Synthesizer / Final Response
        if "synthesize" in prompt_lower or "final response" in prompt_lower:
             return "Based on the analysis, the task is complete. [This is a mock response]"

        return json.dumps({"thought": "Mock fallback", "next_action": "done", "final_response": "Fallback done."})

    async def mock_reflect_response(*args, **kwargs):
        return json.dumps({"reason": "Step looks good.", "directive": "CONTINUE"})

    # Run Agent (Conditional Patching)
    with ExitStack() as stack:
        # 1. ALWAYS patch dangerous execution & approval (Safety)
        stack.enter_context(patch('asyncio.create_subprocess_shell', side_effect=mock_subprocess))
        stack.enter_context(patch('asyncio.create_subprocess_exec', side_effect=mock_subprocess))
        stack.enter_context(patch('agent_server.graph.human_approval_node', side_effect=mock_auto_approve_node))
        stack.enter_context(patch('agent_server.config.REMEDIATION_VERBS', []))
        stack.enter_context(patch('agent_server.utils.get_cluster_recon', return_value="Kubernetes v1.30 (Mock)"))

        # 2. Only mock Reasoning if NOT using Real LLM
        if not use_real_llm:
             stack.enter_context(patch('agent_server.nodes.supervisor.call_llm', side_effect=mock_call_llm))
             stack.enter_context(patch('agent_server.nodes.synthesizer.call_llm', side_effect=mock_call_llm))
             stack.enter_context(patch('agent_server.nodes.critic.call_llm', side_effect=mock_call_llm))
             stack.enter_context(patch('agent_server.nodes.verify.call_llm', side_effect=mock_call_llm))
             stack.enter_context(patch('agent_server.nodes.worker.call_llm', side_effect=mock_call_llm))
             stack.enter_context(patch('agent_server.response_formatter.call_llm', side_effect=mock_call_llm))
             stack.enter_context(patch('agent_server.nodes.plan_executor.format_intelligent_response_with_llm', side_effect=lambda *args, **kwargs: "Analysis complete."))
             stack.enter_context(patch('agent_server.nodes.reflect.call_llm', side_effect=mock_reflect_response))
         
        app = create_k8s_agent()
        
        initial_state = {
            "messages": [],
            "query": query,
            "kube_context": "test-context",
            "iteration": 0,
            "command_history": [],
            "current_step": 0,
            "llm_endpoint": os.environ.get("LLM_ENDPOINT", "http://localhost:11434"),
            "llm_provider": os.environ.get("LLM_PROVIDER", "ollama"),
            "llm_model": os.environ.get("LLM_MODEL", "opspilot-brain"),
            "executor_model": os.environ.get("EXECUTOR_MODEL", "opspilot-brain"),
            "events": [],
            "discovered_resources": None
        }

        final_state = None
        # Increase recursion limit slightly to allow plan execution loops
        async for output in app.astream(initial_state, config={"recursion_limit": 50}):
            for node, state in output.items():
                final_state = state
                if state.get("final_response"):
                    break
            if final_state and final_state.get("final_response"):
                break
                
        return final_state, mock_env.command_log

def grade_result(query_data: dict, result_state: dict, command_history: list) -> dict:
    """Score the result based on expected criteria."""
    
    score = 0
    max_score = 0
    details = []
    
    final_response = result_state.get('final_response', '') or ""
    tool_history = [str(cmd) for cmd in command_history]
    
    # 1. Expected Tools (Max 1 pt per tool)
    expected_tools = query_data.get('expected_tools', [])
    for tools in expected_tools:
        # Check if any tool ran matching this (simplified check against command history strings for now)
        match = False
        keyword = tools.replace("kubectl_", "")
        for cmd in tool_history:
             if keyword in cmd:
                 match = True
                 break
        
        max_score += 1
        if match:
            score += 1
            details.append(f"✅ Tool '{keyword}' used")
        else:
            details.append(f"❌ Tool '{keyword}' NOT used")

    # 2. Expected Keywords in Response (Max 1 pt per keyword)
    expected_keywords = query_data.get('expected_keywords', [])
    for kw in expected_keywords:
        max_score += 1
        if kw.lower() in final_response.lower():
            score += 1
            details.append(f"✅ Keyword '{kw}' found")
        else:
            details.append(f"❌ Keyword '{kw}' missing")
            
    # 3. Forbidden Keywords (Penalty)
    forbidden = query_data.get('forbidden_keywords', [])
    for kw in forbidden:
        if kw.lower() in final_response.lower():
            score -= 1 # Penalty
            details.append(f"⛔ Forbidden keyword '{kw}' found")
            
    passed = score == max_score
    return {
        "passed": passed,
        "score": score,
        "max_score": max_score,
        "details": details,
        "final_response_preview": final_response[:100] + "..."
    }

async def main():
    parser = argparse.ArgumentParser(description="Run Agent Evaluation")
    parser.add_argument("--real", action="store_true", help="Use REAL LLM (no mocking of reasoning). DANGEROUS if not using mock subprocesses.")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args()

    # Load Golden Set
    golden_file = Path(__file__).parent / "golden_queries.json"
    if not golden_file.exists():
        print("Error: golden_queries.json not found")
        return

    test_cases = json.loads(golden_file.read_text())
    
    # Inject "list vclusters" reproduction test
    test_cases.append({
        "id": "list_vclusters",
        "query": "list vclusters",
        "expected_tools": ["kubectl_get"],
        "expected_keywords": ["vcluster"],
        "mock_scenarios": {
            "kubectl get vclusters -A -o json": {
                "stdout": json.dumps({
                    "items": [
                        {"metadata": {"name": "my-vcluster", "namespace": "team-a"}}
                    ]
                }),
                "returncode": 0
            }
        }
    })
    
    results = []
    
    print(f"[RUN] Starting Evaluation on {len(test_cases)} scenarios (Real LLM: {args.real})...")
    print("="*60)
    
    for test in test_cases:
        try:
            state, command_log = await run_single_eval(test, debug=args.debug, use_real_llm=args.real)
            if not state:
                 print(f"❌ Test {test['id']} FAILED: No final state returned.")
                 grade = {"passed": False, "score": 0, "max_score": 1, "details": ["No state returned"]}
            else:
                 grade = grade_result(test, state, command_log)
            
            print(f"Result: {'PASS' if grade['passed'] else 'FAIL'} ({grade['score']}/{grade['max_score']})")
            for d in grade['details']:
                print(f"  {d}")
            print("-" * 60)
            
            results.append({
                "id": test['id'],
                "grade": grade
            })
            
        except Exception as e:
            print(f"❌ Test {test['id']} CRASHED: {e}")
            import traceback
            traceback.print_exc()
            
    # Summary
    passed_count = sum(1 for r in results if r['grade']['passed'])
    print(f"\n📊 SUMMARY: {passed_count}/{len(test_cases)} Passed")
    
    if passed_count == len(test_cases):
        sys.exit(0)
    else:
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
