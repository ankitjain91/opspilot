#!/usr/bin/env python3
import os
import sys
import subprocess
import venv
from pathlib import Path

def main():
    # Identify project paths
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    python_source_dir = project_root / "python"
    venv_dir = project_root / ".venv-build"
    
    print(f"[build] Setting up Python build environment in {venv_dir}...")
    
    # Create venv if needed
    if not venv_dir.exists():
        print("Creating virtual environment...")
        venv.create(venv_dir, with_pip=True)
    
    # Determine local python in venv
    if sys.platform == "win32":
        venv_python = venv_dir / "Scripts" / "python.exe"
        venv_pip = venv_dir / "Scripts" / "pip.exe"
    else:
        venv_python = venv_dir / "bin" / "python3"
        venv_pip = venv_dir / "bin" / "pip"

    # Fallback if specific pip binary missing (e.g. some venv configs)
    if not venv_pip.exists():
         venv_pip = venv_python # We can run module pip

    # Validate python exists
    if not venv_python.exists():
        print(f"[error] Python executable not found at {venv_python}")
        sys.exit(1)

    # Install dependencies
    print("[build] Installing build dependencies...")
    try:
        # Upgrade pip
        subprocess.run([str(venv_python), "-m", "pip", "install", "--upgrade", "pip"], check=True)
        # Install requirements
        req_file = python_source_dir / "requirements.txt"
        subprocess.run([str(venv_python), "-m", "pip", "install", "-r", str(req_file)], check=True)
    except subprocess.CalledProcessError as e:
        print(f"[error] Failed to install dependencies: {e}")
        sys.exit(1)

    # Run the actual build
    print("[build] Building Agent Server binary...")
    build_script = python_source_dir / "build.py"
    try:
        subprocess.run([str(venv_python), str(build_script)], cwd=project_root, check=True)
    except subprocess.CalledProcessError as e:
        print(f"[error] Build failed: {e}")
        sys.exit(1)

    print("[build] Python Sidecar Build Complete!")

if __name__ == "__main__":
    main()
