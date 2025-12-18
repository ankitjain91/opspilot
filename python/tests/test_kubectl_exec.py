import unittest
from agent_server.tools.definitions import KubectlExec
from agent_server.tools.safe_executor import SafeExecutor

class TestKubectlExec(unittest.TestCase):
    def test_basic_exec(self):
        tool = KubectlExec(
            tool="kubectl_exec",
            pod_name="my-pod",
            command=["ls", "-la"]
        )
        cmd = SafeExecutor.build_command(tool, kube_context="my-ctx")
        expected = "kubectl --context=my-ctx exec my-pod -- ls -la"
        self.assertEqual(cmd, expected)

    def test_exec_with_namespace_and_container(self):
        tool = KubectlExec(
            tool="kubectl_exec",
            pod_name="my-pod",
            namespace="my-ns",
            container="my-container",
            command=["cat", "/var/log/app.log"]
        )
        cmd = SafeExecutor.build_command(tool)
        # Context is optional
        expected = "kubectl exec my-pod -n my-ns -c my-container -- cat /var/log/app.log"
        self.assertEqual(cmd, expected)

    def test_exec_with_complex_args(self):
        import shlex
        tool = KubectlExec(
            tool="kubectl_exec",
            pod_name="pod",
            command=["sh", "-c", "echo 'hello world' | grep hello"]
        )
        cmd = SafeExecutor.build_command(tool)
        
        # Construct expected string using same logic as implementation
        # usage: kubectl exec pod -- sh -c <quoted_arg>
        expected_arg = shlex.quote("echo 'hello world' | grep hello")
        expected = f"kubectl exec pod -- sh -c {expected_arg}"
        
        self.assertEqual(cmd, expected)

if __name__ == '__main__':
    unittest.main()
