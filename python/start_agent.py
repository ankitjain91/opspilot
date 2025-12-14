
import sys
import os

# Add the current directory to sys.path to ensure agent_server package can be imported
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

try:
    from agent_server.server import app, kill_process_on_port
except ImportError as e:
    print(f"Error importing agent_server package: {e}", flush=True)
    # Fallback debug info
    print(f"sys.path: {sys.path}", flush=True)
    sys.exit(1)

if __name__ == "__main__":
    import uvicorn
    import time
    
    PORT = 8765
    
    print(f"Starting Agent Server on port {PORT}...")
    
    # Kill any zombie/unhealthy process on the port (but not ourselves)
    if kill_process_on_port(PORT):
        # Give the OS time to release the port
        time.sleep(1.0)
    
    # Run server
    uvicorn.run(app, host="0.0.0.0", port=PORT)
