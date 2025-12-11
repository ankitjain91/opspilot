#!/bin/bash
set -e

# Get the project root directory (one level up from scripts)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_DIR="$PROJECT_ROOT/python"
VENV_DIR="$PROJECT_ROOT/.venv-build"

echo "🔧 Setting up Python build environment in $VENV_DIR..."

# Create venv if it doesn't exist
if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi

# Activate venv
source "$VENV_DIR/bin/activate"

echo "📦 Installing build dependencies..."
pip install --upgrade pip
# Install requirements explicitly
pip install -r "$PYTHON_DIR/requirements.txt"

echo "🔨 Building Agent Server binary..."
# Run the build script from the project root context
cd "$PROJECT_ROOT"
python3 "$PYTHON_DIR/build.py"

echo "✅ Python Sidecar Build Complete!"
