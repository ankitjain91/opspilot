
import unittest
from agent_server.tools.safe_executor import SafeExecutor
from agent_server.tools.definitions import KubectlDelete, KubectlScale, KubectlGet

class TestMirror(unittest.TestCase):
    def test_delete_verification(self):
        tool = KubectlDelete(tool="kubectl_delete", resource="pod", name="bad-pod", namespace="default")
        
        verify_cmd = SafeExecutor.get_verification_command(tool)
        print(f"Delete Verify Cmd: {verify_cmd}")
        
        self.assertIn("kubectl get pod bad-pod", verify_cmd)
        self.assertIn("-o json", verify_cmd)

    def test_scale_verification(self):
        tool = KubectlScale(tool="kubectl_scale", resource="deployment", name="app", replicas=3, namespace="prod")
        
        verify_cmd = SafeExecutor.get_verification_command(tool, kube_context="ctx1")
        print(f"Scale Verify Cmd: {verify_cmd}")
        
        
        self.assertIn("--context=ctx1", verify_cmd) # shlex.quote adds quotes if needed. ctx1 is safe but safe_executor might quote it.
        # Wait, safe_executor uses shlex.quote. shlex.quote("ctx1") -> "ctx1" (no quotes on mac usually if simple).
        
        self.assertIn("get deployment app", verify_cmd)
        self.assertIn("-o json", verify_cmd)

    def test_get_verification_is_none(self):
        # Read-only tools should NOT have verification
        tool = KubectlGet(tool="kubectl_get", resource="pod")
        verify_cmd = SafeExecutor.get_verification_command(tool)
        self.assertIsNone(verify_cmd)

if __name__ == '__main__':
    unittest.main()
