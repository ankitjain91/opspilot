
import json
import unittest
from agent_server.utils import parse_kubectl_json_output

class TestMicroscope(unittest.TestCase):
    def test_pod_parsing(self):
        mock_pod_list = json.dumps({
            "apiVersion": "v1",
            "kind": "List",
            "items": [
                {
                    "apiVersion": "v1",
                    "kind": "Pod",
                    "metadata": {"name": "good-pod", "namespace": "default"},
                    "status": {
                        "phase": "Running",
                        "containerStatuses": [{"name": "c1", "ready": True, "state": {"running": {}}}]
                    }
                },
                {
                    "apiVersion": "v1",
                    "kind": "Pod",
                    "metadata": {"name": "bad-pod", "namespace": "default"},
                    "status": {
                        "phase": "Running", # Technically running but container crashed
                        "containerStatuses": [{"name": "c1", "ready": False, "restartCount": 5, "state": {"waiting": {"reason": "CrashLoopBackOff"}}}]
                    }
                }
            ]
        })
        
        summary = parse_kubectl_json_output(mock_pod_list)
        print("\n--- Pod Summary ---")
        print(summary)
        
        self.assertIn("Found 2 Pods", summary)
        self.assertIn("1 Unhealthy", summary)
        self.assertIn("bad-pod", summary)
        self.assertIn("CrashLoopBackOff", summary)
        self.assertIn("5 restarts", summary)

    def test_event_parsing(self):
        mock_event_list = json.dumps({
            "apiVersion": "v1",
            "kind": "List",
            "items": [
                {
                    "kind": "Event",
                    "type": "Warning",
                    "reason": "FailedScheduling",
                    "message": "0/3 nodes are available",
                    "involvedObject": {"kind": "Pod", "name": "pending-pod"},
                    "count": 10
                }
            ]
        })
        
        summary = parse_kubectl_json_output(mock_event_list)
        print("\n--- Event Summary ---")
        print(summary)
        
        self.assertIn("Found 1 Warning events", summary)
        self.assertIn("FailedScheduling", summary)
        self.assertIn("x10", summary)

if __name__ == '__main__':
    unittest.main()
