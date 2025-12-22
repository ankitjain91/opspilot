# Build script for OpsPilot Agent Sidecar (Windows)
# Usage: .\build_sidecar.ps1 [target-triple]

$TargetTriple = if ($args[0]) { $args[0] } else { "x86_64-pc-windows-msvc" }
$BinaryName = "agent-server-$TargetTriple.exe"
$DistDir = "..\src-tauri\binaries"

Write-Host "Building sidecar for $TargetTriple..."

# Install PyInstaller if missing
pip install pyinstaller

# Create build directory
if (!(Test-Path $DistDir)) {
    New-Item -ItemType Directory -Path $DistDir
}

# Build with PyInstaller
# --onefile: Create a single executable
# --name: Name of the output binary
# --distpath: Where to put the final binary
pyinstaller --onefile `
    --name "$BinaryName" `
    --distpath "$DistDir" `
    --hidden-import="uvicorn.logging" `
    --hidden-import="uvicorn.loops" `
    --hidden-import="uvicorn.loops.auto" `
    --hidden-import="uvicorn.protocols" `
    --hidden-import="uvicorn.protocols.http" `
    --hidden-import="uvicorn.protocols.http.auto" `
    --hidden-import="uvicorn.protocols.websockets" `
    --hidden-import="uvicorn.protocols.websockets.auto" `
    --hidden-import="uvicorn.lifespan" `
    --hidden-import="uvicorn.lifespan.on" `
    agent_server\server.py

Write-Host "Build complete: $DistDir\$BinaryName"
