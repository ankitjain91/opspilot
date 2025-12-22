#!/bin/bash
# Build script for OpsPilot Agent Sidecar (macOS/Linux)
# Usage: ./build_sidecar.sh [target-triple]

TARGET_TRIPLE=${1:-$(gcc -dumpmachine | sed 's/-gnu//')}
BINARY_NAME="agent-server-$TARGET_TRIPLE"
DIST_DIR="../src-tauri/binaries"

echo "Building sidecar for $TARGET_TRIPLE..."

# Install PyInstaller if missing
pip install pyinstaller

# Create build directory
mkdir -p "$DIST_DIR"

# Build with PyInstaller
# --onefile: Create a single executable
# --name: Name of the output binary
# --distpath: Where to put the final binary
pyinstaller --onefile \
    --name "$BINARY_NAME" \
    --distpath "$DIST_DIR" \
    --hidden-import="uvicorn.logging" \
    --hidden-import="uvicorn.loops" \
    --hidden-import="uvicorn.loops.auto" \
    --hidden-import="uvicorn.protocols" \
    --hidden-import="uvicorn.protocols.http" \
    --hidden-import="uvicorn.protocols.http.auto" \
    --hidden-import="uvicorn.protocols.websockets" \
    --hidden-import="uvicorn.protocols.websockets.auto" \
    --hidden-import="uvicorn.lifespan" \
    --hidden-import="uvicorn.lifespan.on" \
    agent_server/server.py

echo "Build complete: $DIST_DIR/$BINARY_NAME"
