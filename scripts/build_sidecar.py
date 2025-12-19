#!/usr/bin/env python3
import os
import sys
import subprocess
import venv
from pathlib import Path

def main():
    # Check for skip flag
    if os.environ.get('SKIP_PYTHON_BUILD') == '1':
        print("[build] SKIP_PYTHON_BUILD=1, skipping Python sidecar build")
        return

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

    # Check checksum to avoid re-installing if satisfied
    import hashlib
    req_file = python_source_dir / "requirements.txt"
    hash_file = venv_dir / "requirements.hash"
    
    current_hash = hashlib.md5(req_file.read_bytes()).hexdigest()
    stored_hash = hash_file.read_text() if hash_file.exists() else ""
    
    if current_hash == stored_hash and venv_python.exists():
        print("[build] Dependencies up to date, skipping pip install.")
    else:
        print("[build] Installing/Upgrading build dependencies...")
        try:
            # Upgrade pip (only if we are installing)
            subprocess.run([str(venv_python), "-m", "pip", "install", "--upgrade", "pip"], check=True)
            # Install requirements
            subprocess.run([str(venv_python), "-m", "pip", "install", "-r", str(req_file)], check=True)
            # Update hash
            hash_file.write_text(current_hash)
        except subprocess.CalledProcessError as e:
            print(f"[error] Failed to install dependencies: {e}")
            sys.exit(1)

    # Check if we need to rebuild or can just copy existing binary
    import hashlib

    # Hash all Python source files to detect changes
    source_files = list((python_source_dir / "agent_server").rglob("*.py"))
    source_files.append(python_source_dir / "start_agent.py")

    source_hash = hashlib.md5()
    for src_file in sorted(source_files):
        if src_file.exists():
            source_hash.update(src_file.read_bytes())

    current_source_hash = source_hash.hexdigest()
    source_hash_file = venv_dir / "source.hash"
    stored_source_hash = source_hash_file.read_text() if source_hash_file.exists() else ""

    binary_path = python_source_dir / "dist" / "agent-server"

    if current_source_hash == stored_source_hash and binary_path.exists():
        print("[build] Source files unchanged, skipping PyInstaller rebuild.")
        print(f"[build] Using existing binary: {binary_path}")
    else:
        print("[build] Source files changed, rebuilding Agent Server binary...")
        build_script = python_source_dir / "build.py"
        try:
            subprocess.run([str(venv_python), str(build_script)], cwd=project_root, check=True)
            # Update hash after successful build
            source_hash_file.write_text(current_source_hash)
        except subprocess.CalledProcessError as e:
            print(f"[error] Build failed: {e}")
            sys.exit(1)

    # Copy to Tauri binaries directory
    tauri_bin_dir = project_root / "src-tauri" / "binaries"
    tauri_bin_dir.mkdir(parents=True, exist_ok=True)

    # Determine target triple for Tauri naming
    import platform as plat
    system = plat.system().lower()
    if system == "darwin":
        arch = plat.machine()
        target_triple = "aarch64-apple-darwin" if arch == "arm64" else "x86_64-apple-darwin"
    elif system == "linux":
        target_triple = "x86_64-unknown-linux-gnu"
    elif system == "windows":
        target_triple = "x86_64-pc-windows-msvc"
    else:
        target_triple = "unknown"

    dst = tauri_bin_dir / f"agent-server-{target_triple}"
    if system == "windows":
        dst = dst.with_suffix(".exe")

    print(f"[build] Copying {binary_path} to {dst}...")
    import shutil
    shutil.copy2(binary_path, dst)

    # Make executable on Unix
    if system != "windows":
        dst.chmod(0o755)

    print("[build] Python Sidecar Build Complete!")

if __name__ == "__main__":
    main()
