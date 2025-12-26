
import subprocess
import time
import os
import signal
import sys
from pathlib import Path

def test_binary_startup():
    """
    Verifies that the agent-server binary can start up successfully.
    Checks for the specific success message 'Starting Agent Server on port'
    and ensures the process doesn't crash immediately.
    """
    # Find the binary
    repo_root = Path(__file__).parent.parent.parent
    binary_path = repo_root / "src-tauri" / "binaries" / "agent-server-aarch64-apple-darwin"
    
    if not binary_path.exists():
        print(f"❌ Binary not found at: {binary_path}")
        return False

    print(f"[RUN] Testing binary at: {binary_path}")
    
    # Start process
    process = subprocess.Popen(
        [str(binary_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        cwd=repo_root # Run from repo root to find knowledge/ etc if needed
    )

    startup_success = False
    error_output = []
    
    try:
        # Monitor output for up to 10 seconds
        start_time = time.time()
        while time.time() - start_time < 10:
            if process.poll() is not None:
                # Process died
                print(f"❌ Process died unexpectedly with exit code {process.returncode}")
                stdout, stderr = process.communicate()
                print("STDOUT:", stdout)
                print("STDERR:", stderr)
                return False

            # Read line by line (non-blocking simulation)
            line = process.stdout.readline()
            if line:
                print(f"[Binary Output] {line.strip()}")
                if "Starting Agent Server on port" in line:
                    print("✅ Found startup success message!")
                    startup_success = True
                    break
            
            time.sleep(0.1)
            
        if not startup_success:
            print("❌ Timed out waiting for startup message")
            return False

        # If we got here, it started up. Let's let it run for 2 more seconds to catch immediate crashes
        time.sleep(2)
        if process.poll() is not None:
             print(f"❌ Process crashed after startup with exit code {process.returncode}")
             return False
        
        print("✅ Binary is stable.")
        return True

    finally:
        # Cleanup
        if process.poll() is None:
            print("🧹 Killing test process...")
            os.kill(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutError:
                os.kill(process.pid, signal.SIGKILL)

if __name__ == "__main__":
    success = test_binary_startup()
    sys.exit(0 if success else 1)
