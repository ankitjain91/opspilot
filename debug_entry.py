
import sys
import os
import traceback

sys.path.append(os.getcwd() + "/python")
print(f"Python executable: {sys.executable}")
print(f"CWD: {os.getcwd()}")
print(f"Path: {sys.path}")

try:
    print("Attempting to import agent_server.server...")
    import agent_server.server
    print("Import successful!")
except Exception:
    print("Import failed!")
    traceback.print_exc()
