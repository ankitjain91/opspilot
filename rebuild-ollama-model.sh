#!/bin/bash

# Rebuild Ollama k8s-cli model with M4 Pro optimizations
# Uses Qwen 2.5 Coder 14B (The best fit for 24GB RAM)

set -e

# Configuration
CUSTOM_MODEL_NAME="k8s-cli"
BASE_MODEL="qwen2.5-coder:14b" # Changed from generic qwen2.5 to CODER variant

echo "🔧 Rebuilding '${CUSTOM_MODEL_NAME}' with M4 Pro optimizations..."
echo ""

# 1. Pre-flight Checks
if ! command -v ollama &> /dev/null; then
    echo "❌ Error: Ollama not found. Install from https://ollama.ai"
    exit 1
fi

if [ ! -f "Modelfile.k8s-cli" ]; then
    echo "❌ Error: 'Modelfile.k8s-cli' not found in current directory."
    echo "   Please create it with the optimized parameters first."
    exit 1
fi

# 2. Check/Pull Base Model
echo "📦 Checking for base model: ${BASE_MODEL}..."
if ! ollama list | grep -q "${BASE_MODEL}"; then
    echo "⬇️  Pulling ${BASE_MODEL} (optimized for coding/JSON)..."
    ollama pull ${BASE_MODEL}
else
    echo "✅ Base model (${BASE_MODEL}) is ready."
fi

# 3. Clean up old version
if ollama list | grep -q "${CUSTOM_MODEL_NAME}"; then
    echo "🗑️  Removing old '${CUSTOM_MODEL_NAME}' model..."
    ollama rm ${CUSTOM_MODEL_NAME} || true
fi

# 4. Build new model
echo "🏗️  Creating '${CUSTOM_MODEL_NAME}' from Modelfile.k8s-cli..."
# We pipe stderr to stdout to see build progress
if ollama create ${CUSTOM_MODEL_NAME} -f Modelfile.k8s-cli; then
    echo ""
    echo "✅ SUCCESS! '${CUSTOM_MODEL_NAME}' created successfully."
else
    echo "❌ Error: Failed to create model."
    exit 1
fi

# 5. Verification & Summary
echo "---------------------------------------------------"
echo "📊 Model Specs:"
echo "   - Base:         ${BASE_MODEL} (Best for CLI/YAML)"
echo "   - Context:      16k tokens (Optimized for logs)"
echo "   - Temperature:  0.1 (Strict JSON)"
echo "   - System RAM:   ~9GB footprint (Safe for 24GB M4 Pro)"
echo "---------------------------------------------------"
echo "🚀 NEXT STEPS:"
echo "1. Update your 'agentOrchestrator.ts':"
echo "   model: '${CUSTOM_MODEL_NAME}'"
echo "2. Restart your React app to clear any open sockets."
echo ""