#!/usr/bin/env python3
"""
Build script to create a standalone executable of the LangGraph agent server.
Uses PyInstaller to bundle Python and all dependencies.
"""

import subprocess
import sys
import platform
import shutil
import os
from pathlib import Path

def build():
    # Determine platform-specific output name
    system = platform.system().lower()
    if system == "windows":
        exe_name = "agent-server.exe"
    else:
        exe_name = "agent-server"

    # Get the directory of this script
    script_dir = Path(__file__).parent

    # ARCHITECTURE CHECK
    # Ensure the running Python/OS architecture matches what we expect.
    # This prevents creating an "x86_64" binary that is actually "arm64" (which crashes 'lipo')
    target_arch_env = os.environ.get("TARGET_ARCH", "").lower()
    current_arch = platform.machine().lower()

    # Normalize arch names
    if current_arch in ["amd64", "x86_64"]:
        current_arch = "x86_64"
    elif current_arch in ["arm64", "aarch64"]:
        current_arch = "arm64"
    
    if target_arch_env:
        if target_arch_env in ["amd64", "x86_64"]:
             target_arch_env = "x86_64"
        elif target_arch_env in ["arm64", "aarch64"]:
             target_arch_env = "arm64"
        
        print(f"[Build] Target Arch: {target_arch_env} | Current Python Arch: {current_arch}")
        
        if target_arch_env != current_arch:
            # On macOS, we can check if we are running under Rosetta (proc translation)
            # But generally PyInstaller builds for the running interpreter.
            # If they don't match, we are building the wrong thing.
            print(f"Error: Architecture mismatch! TARGET_ARCH={target_arch_env} but running on {current_arch}")
            
            # CRITICAL FIX: Only enforce strictness in CI. Locally, users might have misconfigured envs but correct python.
            if os.environ.get("CI") == "true":
                print("Strict architecture check enabled in CI. Aborting.")
                sys.exit(1)
            else:
                 print("WARNING: proceeding anyway as we are not in CI. The output binary might be wrong architecture.")
    else:
        print(f"[Build] No TARGET_ARCH set. converting to {current_arch}")

    # PyInstaller command
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--name", "agent-server",
        "--distpath", str(script_dir / "dist"),
        "--workpath", str(script_dir / "build"),
        "--specpath", str(script_dir),
        "--paths", str(script_dir),
        # Hidden imports that PyInstaller might miss
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.loops",
        "--hidden-import", "uvicorn.loops.auto",
        "--hidden-import", "uvicorn.protocols",
        "--hidden-import", "uvicorn.protocols.http",
        "--hidden-import", "uvicorn.protocols.http.auto",
        "--hidden-import", "uvicorn.protocols.websockets",
        "--hidden-import", "uvicorn.protocols.websockets.auto",
        "--hidden-import", "uvicorn.lifespan",
        "--hidden-import", "uvicorn.lifespan.on",
        "--hidden-import", "httpx",
        "--hidden-import", "langgraph",
        "--hidden-import", "langgraph.checkpoint.memory",
        "--hidden-import", "langgraph.prebuilt",
        "--hidden-import", "langgraph.prebuilt",
        "--hidden-import", "langchain_core",
        "--hidden-import", "encodings",
        # FORCE include all agent components deeply
        "--add-data", f"{script_dir / 'agent_server'}:agent_server",
        # Optimize build size/speed by excluding unused heavy ML/Science libraries
        "--exclude-module", "torch",
        "--exclude-module", "tensorflow",
        "--exclude-module", "jax",
        "--exclude-module", "scipy",
        "--exclude-module", "pandas",
        "--exclude-module", "nvidia",
        "--exclude-module", "sympy",
        "--exclude-module", "matplotlib",
        "--exclude-module", "ipython",
        # Agent doesn't use ML libraries - only httpx/fastapi/langchain
        # Excluding these speeds up PyInstaller by 5-10x (67s → 10s)
        "--exclude-module", "sklearn",
        "--exclude-module", "scikit-learn",
        "--exclude-module", "transformers",
        "--exclude-module", "sentence_transformers",
        "--exclude-module", "huggingface_hub",
        "--exclude-module", "tokenizers",
        "--exclude-module", "safetensors",
        "--exclude-module", "regex",
        "--exclude-module", "pyarrow",
        str(script_dir / "start_agent.py"),
    ]

    print(f"Building {exe_name} for {system}...")
    subprocess.run(cmd, check=True)

    # Copy to Tauri binaries directory
    tauri_bin_dir = script_dir.parent / "src-tauri" / "binaries"
    tauri_bin_dir.mkdir(parents=True, exist_ok=True)

    # Tauri expects platform-specific naming: name-target_triple
    # e.g., agent-server-x86_64-apple-darwin
    if system == "darwin":
        # Allow overriding architecture via environment variable for CI (cross-building)
        arch = os.environ.get("TARGET_ARCH", platform.machine()).lower()
        if arch in ["arm64", "aarch64"]:
            target_triple = "aarch64-apple-darwin"
        else:
            target_triple = "x86_64-apple-darwin"
    elif system == "linux":
        target_triple = "x86_64-unknown-linux-gnu"
    elif system == "windows":
        target_triple = "x86_64-pc-windows-msvc"
    else:
        target_triple = "unknown"

    src = script_dir / "dist" / exe_name
    dst = tauri_bin_dir / f"agent-server-{target_triple}"
    if system == "windows":
        dst = dst.with_suffix(".exe")

    print(f"Copying {src} to {dst}...")
    shutil.copy2(src, dst)

    # Make executable on Unix
    if system != "windows":
        dst.chmod(0o755)

    print(f"Done! Sidecar binary: {dst}")

if __name__ == "__main__":
    build()
