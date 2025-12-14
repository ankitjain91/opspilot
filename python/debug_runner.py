
import subprocess
import os
import sys

binary_path = os.path.abspath("./src-tauri/binaries/agent-server-aarch64-apple-darwin")
print(f"Running binary: {binary_path}", flush=True)

try:
    # Run the binary and capture output
    result = subprocess.run(
        [binary_path], 
        capture_output=True, 
        text=True,
        timeout=10 # Wait up to 10 seconds, it should fail fast if broken
    )
    with open("/Users/ankitjain/lens-killer/crash_log.txt", "w") as f:
        f.write("--- STDOUT ---\n")
        f.write(result.stdout)
        f.write("\n--- STDERR ---\n")
        f.write(result.stderr)
        f.write(f"\n--- EXIT CODE: {result.returncode} ---\n")
    print("Wrote output", flush=True)

except subprocess.TimeoutExpired as e:
    with open("/Users/ankitjain/lens-killer/crash_log.txt", "w") as f:
        f.write("TIMEOUT EXPIRED\n")
        if e.stdout: f.write(e.stdout.decode('utf-8'))
        if e.stderr: f.write(e.stderr.decode('utf-8'))
    print("Wrote output (timeout)", flush=True)

except Exception as e:
    print(f"Failed to run: {e}", flush=True)
