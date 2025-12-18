
import unittest
import sys
import os

# Add project root to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../..')))

from python.agent_server.routing import classify_query_complexity

class TestRoutingLogic(unittest.TestCase):
    def test_standard_resources_simple(self):
        """Standard resources should be routed to SIMPLE (Fast Model)."""
        queries = [
            "list pods",
            "get services",
            "show nodes",
            "list deployments -n default",
            "get events --sort-by=.lastTimestamp",
            "list namespaces",
            "get pvc",
        ]
        for q in queries:
            complexity, reason = classify_query_complexity(q, [])
            self.assertEqual(complexity, "simple", f"Query '{q}' should be SIMPLE but got {complexity} ({reason})")

    def test_custom_resources_complex(self):
        """Custom/Unknown resources should be routed to COMPLEX (Brain Model)."""
        queries = [
            "list vclusters",
            "get certificaterequests",
            "list kustomizations",
            "show argocd applications",
            "get prometheusrules",
            "list SEALEDSECRETS", # Case insensitivity check
        ]
        for q in queries:
            complexity, reason = classify_query_complexity(q, [])
            self.assertEqual(complexity, "complex", f"Query '{q}' should be COMPLEX but got {complexity} ({reason})")
            self.assertIn("requires knowledge context", reason)

    def test_mixed_queries(self):
        """Edge cases and mixed queries."""
        # "all" is standard
        complexity, _ = classify_query_complexity("get all", [])
        self.assertEqual(complexity, "simple")

        # Debugging keywords override simple listings
        complexity, _ = classify_query_complexity("why are pods crashing", [])
        self.assertEqual(complexity, "complex")

        # Non-listing simple queries
        complexity, _ = classify_query_complexity("kubectl version", [])
        self.assertEqual(complexity, "simple")

if __name__ == '__main__':
    unittest.main()
