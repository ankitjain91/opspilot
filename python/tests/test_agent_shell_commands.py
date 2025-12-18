#!/usr/bin/env python3
"""
Integration tests for ShellCommand tool usage with real LLMs.
Tests that the agent properly uses ShellCommand for CRD error extraction.

Usage:
    export GROQ_API_KEY="your-key-here"
    export LLM_PROVIDER="groq"
    export LLM_ENDPOINT="https://api.groq.com/openai/v1"
    export LLM_MODEL="llama-3.3-70b-versatile"
    export EXECUTOR_MODEL="qwen3-32b"

    python3 tests/test_agent_shell_commands.py
"""

import os
import sys
import asyncio
import json
from typing import Dict, Any

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from agent_server.llm import call_llm
from agent_server.tools.definitions import (
    AgentToolWrapper, ShellCommand, KubectlGet
)


class TestShellCommandSelection:
    """Test that LLM chooses ShellCommand tool for appropriate scenarios."""

    def __init__(self):
        self.llm_endpoint = os.environ.get("LLM_ENDPOINT", "http://localhost:11434")
        self.llm_provider = os.environ.get("LLM_PROVIDER", "ollama")
        self.llm_model = os.environ.get("EXECUTOR_MODEL", "qwen2.5:72b")
        self.api_key = os.environ.get("GROQ_API_KEY")

        # Get tool schema for the LLM
        self.tool_schema = AgentToolWrapper.model_json_schema()

    async def _call_executor(self, prompt: str) -> Dict[str, Any]:
        """Call the executor LLM and parse tool selection."""

        # Build the full prompt with tool schema
        full_prompt = f"""You are a Kubernetes CLI executor. Given a task, select the appropriate tool.

Available tools:
{json.dumps(self.tool_schema, indent=2)}

CRITICAL: When debugging CRDs or extracting error messages, use 'shell_command' with jq/grep pipes.
When listing resources, use 'kubectl_get'.

Task: {prompt}

Respond with ONLY a valid JSON tool call in this format:
{{"tool_call": {{"tool": "shell_command", "command": "kubectl get ...", "purpose": "..."}}}}
OR
{{"tool_call": {{"tool": "kubectl_get", "resource": "...", ...}}}}
"""

        response = await call_llm(
            prompt=full_prompt,
            endpoint=self.llm_endpoint,
            model=self.llm_model,
            provider=self.llm_provider,
            temperature=0.0,
            force_json=True,
            api_key=self.api_key
        )

        return json.loads(response)

    async def test_crd_error_extraction_uses_shell_command(self):
        """TEST 1: CRD error extraction should use ShellCommand with jq."""

        print("\n" + "="*80)
        print("TEST 1: CRD Error Extraction - Should use ShellCommand")
        print("="*80)

        prompt = """
        The CustomerCluster 'taasvstst' in namespace 'taasvstst' is in ASFailed state.
        Extract the error message from status.message or status.errorMessage to understand why it failed.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command[:200]}...")

        # Assertions
        assert tool_type == "shell_command", f"❌ FAILED: Expected 'shell_command', got '{tool_type}'"
        assert "jq" in command or "|" in command, "❌ FAILED: Expected pipe or jq usage"
        assert "status" in command, "❌ FAILED: Expected status field extraction"
        assert "taasvstst" in command, "❌ FAILED: Expected resource name in command"

        print("\n✅ PASSED: Correctly selected ShellCommand with jq/pipes for CRD error extraction")
        return True

    async def test_simple_list_uses_kubectl_get(self):
        """TEST 2: Simple listing should use KubectlGet, not ShellCommand."""

        print("\n" + "="*80)
        print("TEST 2: Simple Resource List - Should use KubectlGet")
        print("="*80)

        prompt = "List all customer clusters across all namespaces."

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Full tool call: {json.dumps(result, indent=2)}")

        # Assertions
        assert tool_type == "kubectl_get", f"❌ FAILED: Expected 'kubectl_get', got '{tool_type}'"

        print("\n✅ PASSED: Correctly selected KubectlGet for simple list operation")
        return True

    async def test_filtering_uses_shell_command(self):
        """TEST 3: Filtering/grep operations should use ShellCommand."""

        print("\n" + "="*80)
        print("TEST 3: Filtering with grep - Should use ShellCommand")
        print("="*80)

        prompt = "Find all pods that have 'error' or 'failed' in their name across all namespaces."

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # Assertions
        assert tool_type == "shell_command", f"❌ FAILED: Expected 'shell_command', got '{tool_type}'"
        assert "grep" in command or "|" in command, "❌ FAILED: Expected grep or pipe usage"

        print("\n✅ PASSED: Correctly selected ShellCommand for filtering operation")
        return True

    async def test_jsonpath_extraction_uses_shell_command(self):
        """TEST 4: JSONPATH field extraction should use ShellCommand with jq."""

        print("\n" + "="*80)
        print("TEST 4: JSONPATH Extraction - Should use ShellCommand with jq")
        print("="*80)

        prompt = """
        Get the 'currentState' field from the CustomerCluster status.
        The resource is 'customerclusters.dedicated.uipath.com/taasvstst' in namespace 'taasvstst'.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # Assertions
        assert tool_type == "shell_command", f"❌ FAILED: Expected 'shell_command', got '{tool_type}'"
        assert "jq" in command or "jsonpath" in command, "❌ FAILED: Expected jq or jsonpath usage"
        assert "currentState" in command or "status" in command, "❌ FAILED: Expected field extraction"

        print("\n✅ PASSED: Correctly selected ShellCommand for JSONPATH extraction")
        return True

    async def test_multi_step_pipeline_uses_shell_command(self):
        """TEST 5: Multi-step pipelines should use ShellCommand."""

        print("\n" + "="*80)
        print("TEST 5: Multi-step Pipeline - Should use ShellCommand")
        print("="*80)

        prompt = """
        Find all pods in Failed state, then extract just their names and namespaces.
        Use a pipeline to filter and transform the output.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # Assertions
        assert tool_type == "shell_command", f"❌ FAILED: Expected 'shell_command', got '{tool_type}'"
        assert "|" in command, "❌ FAILED: Expected pipe usage for multi-step pipeline"

        print("\n✅ PASSED: Correctly selected ShellCommand for multi-step pipeline")
        return True

    async def test_debug_customercluster_real_scenario(self):
        """TEST 6: Real-world CustomerCluster debugging - extract all status fields."""

        print("\n" + "="*80)
        print("TEST 6: Debug CustomerCluster (Real-world) - Extract Status Details")
        print("="*80)

        prompt = """
        The CustomerCluster 'taasvstst' in namespace 'taasvstst' is showing ASFailed state.
        I need to understand what went wrong. Extract ALL relevant status information including:
        - currentState
        - message or errorMessage
        - Any other error-related fields in the status
        Use the most efficient method to get this information.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # Assertions
        assert tool_type == "shell_command", f"❌ FAILED: Expected 'shell_command', got '{tool_type}'"
        assert "taasvstst" in command, "❌ FAILED: Expected resource name in command"
        assert "status" in command.lower(), "❌ FAILED: Expected status field extraction"
        assert ("jq" in command or "jsonpath" in command or "|" in command), "❌ FAILED: Expected data extraction tool (jq/jsonpath/pipes)"

        print("\n✅ PASSED: Correctly selected ShellCommand for real CustomerCluster debugging")
        return True

    async def test_vcluster_crossplane_resource_debugging(self):
        """TEST 7: Multi-step - Connect to vcluster and debug failing Crossplane resource."""

        print("\n" + "="*80)
        print("TEST 7: vcluster + Crossplane Debugging - Multi-step Scenario")
        print("="*80)

        prompt = """
        I need to debug a failing Crossplane Managed Resource in a vcluster.
        First, I should connect to vcluster context 'vc-prod-useast', then
        extract the status.conditions from the ManagedResource 'postgres-db-instance'
        in namespace 'databases' to see why it's failing.
        Give me the command to extract the failure conditions.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # Assertions
        assert tool_type == "shell_command", f"❌ FAILED: Expected 'shell_command', got '{tool_type}'"
        assert "postgres-db-instance" in command, "❌ FAILED: Expected resource name in command"
        assert ("jq" in command or "jsonpath" in command), "❌ FAILED: Expected jq/jsonpath for status.conditions extraction"
        assert "conditions" in command.lower() or "status" in command.lower(), "❌ FAILED: Expected conditions/status extraction"

        print("\n✅ PASSED: Correctly selected ShellCommand for Crossplane resource debugging")
        return True

    async def test_simple_list_pods_easy(self):
        """TEST 8: Easy scenario - Simple pod listing."""

        print("\n" + "="*80)
        print("TEST 8: Easy Scenario - List Pods in Namespace")
        print("="*80)

        prompt = "List all pods in the 'production' namespace."

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Full tool call: {json.dumps(result, indent=2)}")

        # Assertions
        assert tool_type == "kubectl_get", f"❌ FAILED: Expected 'kubectl_get', got '{tool_type}'"
        assert result.get("tool_call", {}).get("resource") == "pods", "❌ FAILED: Expected resource='pods'"
        assert result.get("tool_call", {}).get("namespace") == "production", "❌ FAILED: Expected namespace='production'"

        print("\n✅ PASSED: Correctly selected KubectlGet for simple pod listing")
        return True

    async def test_extract_configmap_field_easy(self):
        """TEST 9: Easy scenario - Extract specific field from ConfigMap."""

        print("\n" + "="*80)
        print("TEST 9: Easy Scenario - Extract Field from ConfigMap")
        print("="*80)

        prompt = """
        I need to get the value of the 'database.host' key from the ConfigMap named
        'app-config' in the 'default' namespace.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # Assertions
        assert tool_type == "shell_command", f"❌ FAILED: Expected 'shell_command', got '{tool_type}'"
        assert "app-config" in command, "❌ FAILED: Expected ConfigMap name in command"
        assert ("jq" in command or "jsonpath" in command), "❌ FAILED: Expected jq/jsonpath for field extraction"
        assert "database.host" in command or "data" in command.lower(), "❌ FAILED: Expected field extraction from data"

        print("\n✅ PASSED: Correctly selected ShellCommand with jq/jsonpath for ConfigMap field extraction")
        return True

    async def test_show_secret_decoded_easy(self):
        """TEST 10: Easy scenario - Show decoded secret value."""

        print("\n" + "="*80)
        print("TEST 10: Easy Scenario - Decode and Show Secret Value")
        print("="*80)

        prompt = """
        I need to see the actual decoded value of the 'password' field from the Secret
        named 'db-credentials' in the 'production' namespace.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # Assertions
        assert tool_type == "shell_command", f"❌ FAILED: Expected 'shell_command', got '{tool_type}'"
        assert "db-credentials" in command, "❌ FAILED: Expected secret name in command"
        assert "base64" in command, "❌ FAILED: Expected base64 decoding"
        assert ("jq" in command or "jsonpath" in command or "|" in command), "❌ FAILED: Expected data extraction with pipes/jq"

        print("\n✅ PASSED: Correctly selected ShellCommand with base64 decode for secret extraction")
        return True

    async def test_debug_pod_crash_loop(self):
        """TEST 11: Complex scenario - Debug pod in CrashLoopBackOff."""

        print("\n" + "="*80)
        print("TEST 11: Complex Scenario - Debug CrashLoopBackOff Pod")
        print("="*80)

        prompt = """
        There's a pod named 'frontend-app-xyz123' in namespace 'production' that's in
        CrashLoopBackOff. I need to find out why by getting the last 50 lines of logs
        from the previous container instance (before it crashed).
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Full tool call: {json.dumps(result, indent=2)}")

        # For this scenario, both kubectl_logs and shell_command are valid
        assert tool_type in ["kubectl_logs", "shell_command"], f"❌ FAILED: Expected 'kubectl_logs' or 'shell_command', got '{tool_type}'"

        if tool_type == "kubectl_logs":
            assert result.get("tool_call", {}).get("previous") == True, "❌ FAILED: Expected previous=True for crashed container"
            assert result.get("tool_call", {}).get("tail") == 50, "❌ FAILED: Expected tail=50"

        print("\n✅ PASSED: Correctly selected appropriate tool for pod crash debugging")
        return True

    async def test_correlate_events_with_pod(self):
        """TEST 12: Complex scenario - Correlate events with failing pod."""

        print("\n" + "="*80)
        print("TEST 12: Complex Scenario - Correlate Events with Failing Resource")
        print("="*80)

        prompt = """
        The deployment 'api-server' in namespace 'backend' is having issues.
        I need to see all Warning events related to this deployment or its pods
        in the last hour to understand what's happening.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Full tool call: {json.dumps(result, indent=2)}")

        # Both kubectl_events and shell_command are valid
        assert tool_type in ["kubectl_events", "shell_command"], f"❌ FAILED: Expected 'kubectl_events' or 'shell_command', got '{tool_type}'"

        if tool_type == "kubectl_events":
            assert result.get("tool_call", {}).get("only_warnings") == True, "❌ FAILED: Expected only_warnings=True"

        print("\n✅ PASSED: Correctly selected appropriate tool for event correlation")
        return True

    async def test_multi_resource_investigation(self):
        """TEST 13: Complex scenario - Multi-resource investigation with data aggregation."""

        print("\n" + "="*80)
        print("TEST 13: Complex Scenario - Multi-Resource Investigation")
        print("="*80)

        prompt = """
        I need to investigate resource consumption issues. Find all pods in the 'production'
        namespace that are using more than 80% of their CPU limit. I need their names,
        current CPU usage, and limit values.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # This requires shell command with pipes and math/filtering
        assert tool_type == "shell_command", f"❌ FAILED: Expected 'shell_command', got '{tool_type}'"
        assert "|" in command, "❌ FAILED: Expected pipes for multi-step processing"
        # Should involve kubectl top, awk/jq for calculation, and filtering
        assert ("kubectl top" in command or "metrics" in command.lower()), "❌ FAILED: Expected metrics/top command"

        print("\n✅ PASSED: Correctly selected ShellCommand for complex multi-resource investigation")
        return True

    async def test_crossplane_resource_discovery(self):
        """TEST 14: Crossplane resource discovery - Find storage account managed resources."""

        print("\n" + "="*80)
        print("TEST 14: Crossplane Resource Discovery - Find Storage Account Resources")
        print("="*80)

        prompt = """
        I need to find Crossplane managed resources related to Azure Storage Accounts.
        Search across all Crossplane providers and managed resources to find any
        storage account resources in the cluster. Use the vcluster context
        'vcluster_management-cluster_dedalp5_dedicated-aks-dev-eastus2-0'.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # For Crossplane resource discovery, both kubectl_get and shell_command are valid
        # kubectl_get is simpler for basic listing, shell_command needed for filtering
        assert tool_type in ["kubectl_get", "shell_command", "kubectl_api_resources"], \
            f"❌ FAILED: Expected 'kubectl_get', 'shell_command', or 'kubectl_api_resources', got '{tool_type}'"

        if tool_type == "shell_command":
            # Should involve grep/jq for filtering storage account resources
            assert ("|" in command or "grep" in command.lower() or "storage" in command.lower()), \
                "❌ FAILED: Expected filtering for storage account resources"

        print("\n✅ PASSED: Correctly selected appropriate tool for Crossplane resource discovery")
        return True

    async def test_extract_specific_field_from_crd_array(self):
        """TEST 15: Extract specific field from CRD status array using jq."""

        print("\n" + "="*80)
        print("TEST 15: Extract Specific Field from CRD Array - Advanced jq")
        print("="*80)

        prompt = """
        I need to extract all 'reason' fields from the status.conditions array
        in a Crossplane ManagedResource named 'azure-storageaccount-prod' in namespace
        'crossplane-system'. The conditions array has multiple objects, and I need
        just the reasons from conditions where type='Ready' and status='False'.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # This requires shell command with jq array filtering
        assert tool_type == "shell_command", f"❌ FAILED: Expected 'shell_command', got '{tool_type}'"
        assert "jq" in command, "❌ FAILED: Expected jq for array filtering"
        assert ("conditions" in command.lower() or "status" in command.lower()), \
            "❌ FAILED: Expected conditions/status array extraction"
        assert ("select" in command or "map" in command or "[" in command), \
            "❌ FAILED: Expected jq array operations (select/map/[])"

        print("\n✅ PASSED: Correctly selected ShellCommand with jq array filtering")
        return True

    async def test_simple_one_word_command(self):
        """TEST 16: Very simple - Single word command 'pods'."""

        print("\n" + "="*80)
        print("TEST 16: Simple One-Word Command - 'pods'")
        print("="*80)

        prompt = "pods"

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Full tool call: {json.dumps(result, indent=2)}")

        # Should use kubectl_get for simple listing
        assert tool_type == "kubectl_get", f"❌ FAILED: Expected 'kubectl_get', got '{tool_type}'"
        assert result.get("tool_call", {}).get("resource") == "pods", "❌ FAILED: Expected resource='pods'"

        print("\n✅ PASSED: Correctly handled single-word command")
        return True

    async def test_multi_step_root_cause_analysis(self):
        """TEST 17: Complex multi-step - Root cause analysis workflow."""

        print("\n" + "="*80)
        print("TEST 17: Complex Multi-Step - Root Cause Analysis")
        print("="*80)

        prompt = """
        A deployment named 'payment-service' in namespace 'prod' is experiencing intermittent
        failures. I need to perform a comprehensive root cause analysis:
        1. Check if pods are crashing (look at restart counts)
        2. Get recent logs from failed containers
        3. Check for resource constraints (CPU/memory limits vs usage)
        4. Look for related warning events in the last hour
        5. Verify if the service endpoints are healthy
        Start with the first step - checking pod restart counts.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # For checking restart counts, should use either kubectl_get or shell_command with parsing
        assert tool_type in ["kubectl_get", "shell_command"], \
            f"❌ FAILED: Expected 'kubectl_get' or 'shell_command', got '{tool_type}'"

        if tool_type == "shell_command":
            # Should involve extracting restart counts
            assert ("restart" in command.lower() or "status" in command.lower()), \
                "❌ FAILED: Expected restart count extraction"

        print("\n✅ PASSED: Correctly selected tool for multi-step root cause analysis")
        return True

    async def test_aggregation_across_namespaces(self):
        """TEST 18: Aggregation - Count resources across all namespaces."""

        print("\n" + "="*80)
        print("TEST 18: Aggregation - Count Resources Across Namespaces")
        print("="*80)

        prompt = """
        I need to generate a summary report:
        Count how many pods are in each phase (Running, Pending, Failed, etc.)
        across all namespaces. Group by phase and show counts.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # This requires shell command with aggregation (awk/sort/uniq or jq grouping)
        assert tool_type == "shell_command", f"❌ FAILED: Expected 'shell_command', got '{tool_type}'"
        assert "|" in command, "❌ FAILED: Expected pipes for aggregation"
        # Should involve grouping/counting
        assert any(x in command.lower() for x in ["group", "count", "uniq", "sort", "awk"]), \
            "❌ FAILED: Expected aggregation operations (group/count/uniq/sort/awk)"

        print("\n✅ PASSED: Correctly selected ShellCommand for aggregation")
        return True

    async def test_time_based_filtering(self):
        """TEST 19: Time-based filtering - Events in last N minutes."""

        print("\n" + "="*80)
        print("TEST 19: Time-Based Filtering - Recent Events")
        print("="*80)

        prompt = """
        Show me all Warning events that occurred in the last 15 minutes
        across all namespaces, sorted by timestamp.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # Both kubectl_events and shell_command are valid
        assert tool_type in ["kubectl_events", "shell_command"], \
            f"❌ FAILED: Expected 'kubectl_events' or 'shell_command', got '{tool_type}'"

        if tool_type == "shell_command":
            # Should involve time filtering
            assert any(x in command.lower() for x in ["time", "timestamp", "last", "recent"]), \
                "❌ FAILED: Expected time-based filtering"

        print("\n✅ PASSED: Correctly selected tool for time-based filtering")
        return True

    async def test_comparative_analysis(self):
        """TEST 20: Comparative analysis - Compare resource across environments."""

        print("\n" + "="*80)
        print("TEST 20: Comparative Analysis - Compare Across Contexts")
        print("="*80)

        prompt = """
        Compare the 'api-gateway' deployment configuration between the 'staging'
        and 'production' namespaces. I want to see differences in replicas,
        image tags, and resource limits.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Full tool call: {json.dumps(result, indent=2)}")

        # kubectl_diff or shell_command with diff/comparison
        assert tool_type in ["kubectl_diff", "shell_command"], \
            f"❌ FAILED: Expected 'kubectl_diff' or 'shell_command', got '{tool_type}'"

        print("\n✅ PASSED: Correctly selected tool for comparative analysis")
        return True

    async def test_network_connectivity_debugging(self):
        """TEST 21: Network debugging - Test connectivity between pods."""

        print("\n" + "="*80)
        print("TEST 21: Network Debugging - Pod-to-Pod Connectivity")
        print("="*80)

        prompt = """
        I need to test network connectivity from pod 'frontend-xyz' in namespace 'web'
        to the 'backend-service' service. Run a curl command from inside the pod
        to check if the service is reachable.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Full tool call: {json.dumps(result, indent=2)}")

        # Should use kubectl_exec or kubectl_exec_shell
        assert tool_type in ["kubectl_exec", "kubectl_exec_shell"], \
            f"❌ FAILED: Expected 'kubectl_exec' or 'kubectl_exec_shell', got '{tool_type}'"

        print("\n✅ PASSED: Correctly selected exec tool for network debugging")
        return True

    async def test_resource_cleanup_identification(self):
        """TEST 22: Resource cleanup - Find unused resources."""

        print("\n" + "="*80)
        print("TEST 22: Resource Cleanup - Find Unused ConfigMaps")
        print("="*80)

        prompt = """
        Find all ConfigMaps in the 'default' namespace that are not being used
        by any pods. I need to identify orphaned ConfigMaps for cleanup.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # This requires shell command with complex filtering
        assert tool_type == "shell_command", f"❌ FAILED: Expected 'shell_command', got '{tool_type}'"
        assert "|" in command, "❌ FAILED: Expected pipes for multi-step filtering"

        print("\n✅ PASSED: Correctly selected ShellCommand for resource cleanup identification")
        return True

    async def test_security_audit_rbac(self):
        """TEST 23: Security audit - Check RBAC permissions."""

        print("\n" + "="*80)
        print("TEST 23: Security Audit - RBAC Permissions Check")
        print("="*80)

        prompt = """
        Check what permissions the service account 'app-sa' in namespace 'production'
        has. List all ClusterRoles and Roles bound to this service account.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # Should use shell_command or kubectl_get for rolebindings
        assert tool_type in ["kubectl_get", "shell_command"], \
            f"❌ FAILED: Expected 'kubectl_get' or 'shell_command', got '{tool_type}'"

        print("\n✅ PASSED: Correctly selected tool for RBAC audit")
        return True

    async def test_batch_operation_multiple_resources(self):
        """TEST 24: Batch operation - Check status of multiple resources."""

        print("\n" + "="*80)
        print("TEST 24: Batch Operation - Check Multiple Resource Types")
        print("="*80)

        prompt = """
        For the application stack 'ecommerce', check the status of all related resources:
        - Deployment 'ecommerce-api'
        - Service 'ecommerce-api-svc'
        - Ingress 'ecommerce-ingress'
        - ConfigMap 'ecommerce-config'
        All in namespace 'apps'. Show me if any of these have issues.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Full tool call: {json.dumps(result, indent=2)}")

        # Could use kubectl_get with label selector or shell_command with multiple gets
        assert tool_type in ["kubectl_get", "shell_command"], \
            f"❌ FAILED: Expected 'kubectl_get' or 'shell_command', got '{tool_type}'"

        print("\n✅ PASSED: Correctly selected tool for batch operation")
        return True

    async def test_performance_bottleneck_analysis(self):
        """TEST 25: Performance analysis - Identify resource bottlenecks."""

        print("\n" + "="*80)
        print("TEST 25: Performance Analysis - Identify Resource Bottlenecks")
        print("="*80)

        prompt = """
        I'm experiencing slow response times. Analyze the 'database' namespace
        and identify any pods that are:
        1. Using more than 90% of their CPU limit
        2. Using more than 90% of their memory limit
        3. Being throttled (check for CPU throttling metrics)
        Start by checking CPU and memory usage.
        """

        result = await self._call_executor(prompt)

        tool_type = result.get("tool_call", {}).get("tool")
        command = result.get("tool_call", {}).get("command", "")

        print(f"\n✓ Selected tool: {tool_type}")
        print(f"✓ Command: {command}")

        # Should use shell_command with kubectl top and calculations
        assert tool_type == "shell_command", f"❌ FAILED: Expected 'shell_command', got '{tool_type}'"
        assert "|" in command, "❌ FAILED: Expected pipes for metrics analysis"
        assert "top" in command.lower() or "metrics" in command.lower(), \
            "❌ FAILED: Expected metrics/top command for resource usage"

        print("\n✅ PASSED: Correctly selected ShellCommand for performance bottleneck analysis")
        return True


async def main():
    """Run all integration tests."""

    print("\n" + "="*80)
    print("SHELL COMMAND TOOL INTEGRATION TESTS")
    print("="*80)
    print(f"\nLLM Provider: {os.environ.get('LLM_PROVIDER', 'ollama')}")
    print(f"LLM Model: {os.environ.get('EXECUTOR_MODEL', 'qwen2.5:72b')}")
    print(f"LLM Endpoint: {os.environ.get('LLM_ENDPOINT', 'http://localhost:11434')}")

    if os.environ.get("LLM_PROVIDER") == "groq" and not os.environ.get("GROQ_API_KEY"):
        print("\n❌ ERROR: GROQ_API_KEY not set but LLM_PROVIDER=groq")
        print("Set GROQ_API_KEY environment variable or switch to ollama")
        sys.exit(1)

    tester = TestShellCommandSelection()

    tests = [
        # Original tests (1-5)
        tester.test_crd_error_extraction_uses_shell_command,
        tester.test_simple_list_uses_kubectl_get,
        tester.test_filtering_uses_shell_command,
        tester.test_jsonpath_extraction_uses_shell_command,
        tester.test_multi_step_pipeline_uses_shell_command,
        # Real-world scenarios (6-10)
        tester.test_debug_customercluster_real_scenario,
        tester.test_vcluster_crossplane_resource_debugging,
        tester.test_simple_list_pods_easy,
        tester.test_extract_configmap_field_easy,
        tester.test_show_secret_decoded_easy,
        # Complex scenarios (11-15)
        tester.test_debug_pod_crash_loop,
        tester.test_correlate_events_with_pod,
        tester.test_multi_resource_investigation,
        tester.test_crossplane_resource_discovery,
        tester.test_extract_specific_field_from_crd_array,
        # Comprehensive coverage (16-25)
        tester.test_simple_one_word_command,
        tester.test_multi_step_root_cause_analysis,
        tester.test_aggregation_across_namespaces,
        tester.test_time_based_filtering,
        tester.test_comparative_analysis,
        tester.test_network_connectivity_debugging,
        tester.test_resource_cleanup_identification,
        tester.test_security_audit_rbac,
        tester.test_batch_operation_multiple_resources,
        tester.test_performance_bottleneck_analysis,
    ]

    results = []
    for test in tests:
        try:
            result = await test()
            results.append((test.__name__, result))
        except AssertionError as e:
            print(f"\n❌ FAILED: {e}")
            results.append((test.__name__, False))
        except Exception as e:
            print(f"\n❌ ERROR: {e}")
            import traceback
            traceback.print_exc()
            results.append((test.__name__, False))

    # Summary
    print("\n" + "="*80)
    print("TEST SUMMARY")
    print("="*80)

    passed = sum(1 for _, result in results if result)
    total = len(results)

    for name, result in results:
        status = "✅ PASSED" if result else "❌ FAILED"
        print(f"{status}: {name}")

    print(f"\n{passed}/{total} tests passed")

    if passed == total:
        print("\n🎉 ALL TESTS PASSED!")
        sys.exit(0)
    else:
        print("\n❌ SOME TESTS FAILED")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
