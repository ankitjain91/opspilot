
import sys
import os

# Add the current directory to sys.path to ensure agent_server package can be imported
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# HOTFIX: Patch missing langgraph.cache module in langgraph 1.0.5
import sys
from types import ModuleType
try:
    import langgraph.cache
except ImportError:
    # Create dummy langgraph.cache.base module
    m_base = ModuleType("langgraph.cache.base")
    class BaseCache: pass
    m_base.BaseCache = BaseCache
    sys.modules["langgraph.cache.base"] = m_base
    
    # Create dummy langgraph.cache module
    m_pkg = ModuleType("langgraph.cache")
    m_pkg.base = m_base
    sys.modules["langgraph.cache"] = m_pkg


try:
    from agent_server.server import app
    import agent_server
    print(f"Loaded agent_server from: {agent_server.__file__}", flush=True)
except ImportError as e:
    print(f"Error importing agent_server package: {e}", flush=True)
    # Fallback debug info
    print(f"sys.path: {sys.path}", flush=True)
    try:
        print(f"Contents of {os.path.dirname(__file__)}: {os.listdir(os.path.dirname(__file__))}", flush=True)
    except Exception as dir_err:
        print(f"Could not list dir: {dir_err}", flush=True)
    sys.exit(1)

if __name__ == "__main__":
    import uvicorn

    PORT = 8765

    print(f"Starting Agent Server on port {PORT}...")

    # NOTE: Port cleanup is handled by the Rust supervisor (agent_sidecar.rs)
    # Do NOT kill processes here - it causes race conditions where a newly
    # healthy agent gets killed by a second spawned instance

    # Run server
    uvicorn.run(app, host="0.0.0.0", port=PORT)
