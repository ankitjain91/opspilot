#!/usr/bin/env python3
"""
Build script to create a standalone executable of the LangGraph agent server.
Uses PyInstaller to bundle Python and all dependencies.
"""

import subprocess
import sys
import platform
import shutil
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

    # PyInstaller command
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--name", "agent-server",
        "--distpath", str(script_dir / "dist"),
        "--workpath", str(script_dir / "build"),
        "--specpath", str(script_dir),
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
        "--hidden-import", "langchain_core",
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
        # SAFETY FIRST: Reverting aggressive exclusions. 
        # Only excluding the truly massive libraries that we 100% know are unused.
        # "--exclude-module", "sklearn",
        # "--exclude-module", "scikit-learn", 
        # "--exclude-module", "transformers",
        # "--exclude-module", "sentence_transformers",
        # "--exclude-module", "huggingface_hub",
        # "--exclude-module", "tokenizers",
        # "--exclude-module", "safetensors",
        # "--exclude-module", "regex", 
        # "--exclude-module", "pyarrow", 
        # "--exclude-module", "pandas",
        # "--exclude-module", "scipy",
        str(script_dir / "agent_server.py"),
    ]

    print(f"Building {exe_name} for {system}...")
    subprocess.run(cmd, check=True)

    # Copy to Tauri binaries directory
    tauri_bin_dir = script_dir.parent / "src-tauri" / "binaries"
    tauri_bin_dir.mkdir(parents=True, exist_ok=True)

    # Tauri expects platform-specific naming: name-target_triple
    # e.g., agent-server-x86_64-apple-darwin
    if system == "darwin":
        arch = platform.machine()
        if arch == "arm64":
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
