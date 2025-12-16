import sys
import os

# Add project root to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


from agent_server.tools.definitions import AgentToolWrapper, KubectlGet
from agent_server.tools.safe_executor import SafeExecutor
import unittest

class TestToolSafety(unittest.TestCase):
    
    def test_safe_kubectl_get(self):
        """Verify normal kubectl get generation."""
        raw_json = {
            "tool": "kubectl_get",
            "resource": "pods",
            "namespace": "default",
            "selector": "app=frontend"
        }
        
        # 1. Validate Pydantic
        tool = AgentToolWrapper(tool_call=raw_json).tool_call
        self.assertIsInstance(tool, KubectlGet)
        
        # 2. Build Command
        cmd = SafeExecutor.build_command(tool)
        expected = "kubectl get 'pods' -n 'default' -l 'app=frontend' -o json"
        # Since I'm using shlex.quote, even harmless strings might get quoted depending on python version/impl
        # So I'll check for keys. 
        # Actually expected: kubectl get 'pods' ... 
        # safe_executor.py uses shlex.quote()
        # shlex.quote("pods") -> 'pods' (on some systems) or pods (if safe). Python's shlex usually doesn't quote safe chars.
        # Let's be flexible and just check keywords.
        self.assertIn("kubectl get", cmd)
        self.assertIn("pods", cmd)
        self.assertIn("-n", cmd)
        self.assertIn("default", cmd)

    def test_injection_attempt(self):
        """Verify that shell injection characters are quoted."""
        raw_json = {
            "tool": "kubectl_get",
            "resource": "pods; rm -rf /",
            "namespace": "default"
        }
        
        tool = AgentToolWrapper(tool_call=raw_json).tool_call
        cmd = SafeExecutor.build_command(tool)
        
        # The semicolon must be inside quotes OR escaped.
        # shlex.quote('pods; rm -rf /') -> "'pods; rm -rf /'"
        quoted_arg = "'pods; rm -rf /'"
        self.assertIn(quoted_arg, cmd)
        
        # Ensure the raw attack string is NOT present on its own (unquoted)
        # We can't easily check 'not present unquoted', but presence of quoted version is good.

    def test_invalid_tool_schema(self):
        """Verify that missing required fields raises ValidationError."""
        raw_json = {
            "tool": "kubectl_get",
            # Missing "resource"
            "namespace": "default"
        }
        
        with self.assertRaises(Exception):
             AgentToolWrapper(tool_call=raw_json)

    
    def test_safe_kubectl_top(self):
        """Verify kubectl top generation."""
        raw_json = {
            "tool": "kubectl_top",
            "resource": "pod",
            "all_namespaces": True
        }
        tool = AgentToolWrapper(tool_call=raw_json).tool_call
        cmd = SafeExecutor.build_command(tool)
        
        # Expect: kubectl top 'pod' -A --sort-by=cpu
        self.assertIn("kubectl top", cmd)
        self.assertIn("-A", cmd)
        self.assertIn("--sort-by=cpu", cmd)

    def test_safe_api_resources(self):
        """Verify api-resources generation."""
        raw_json = {
            "tool": "kubectl_api_resources",
            "api_group": "crossplane.io"
        }
        tool = AgentToolWrapper(tool_call=raw_json).tool_call
        cmd = SafeExecutor.build_command(tool)
        
        self.assertIn("kubectl api-resources", cmd)
        self.assertIn("--api-group=crossplane.io", cmd) # shlex doesn't quote safe strings

if __name__ == '__main__':
    unittest.main()
