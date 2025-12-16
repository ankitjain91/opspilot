
from agent_server.graph import create_k8s_agent
import sys

try:
    graph = create_k8s_agent()
    print("Graph compiled successfully.")
    # Maybe listing nodes?
    # print(graph.nodes.keys())
except Exception as e:
    print(f"Graph compilation failed: {e}")
    sys.exit(1)
