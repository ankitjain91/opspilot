#!/bin/bash

# Rebuild Ollama k8s-cli model with optimized Modelfile
# Run this after making changes to Modelfile

set -e

echo "🔧 Rebuilding Ollama k8s-cli model with optimizations..."
echo ""

# Check if Ollama is installed
if ! command -v ollama &> /dev/null; then
    echo "❌ Error: Ollama not found. Please install from https://ollama.ai"
    exit 1
fi

# Check if base model exists
echo "📦 Checking for qwen2.5:14b..."
if ! ollama list | grep -q "qwen2.5:14b"; then
    echo "⬇️  Pulling qwen2.5:14b (this may take a few minutes)..."
    ollama pull qwen2.5:14b
else
    echo "✅ Base model already exists"
fi

# Delete old k8s-cli model if it exists
if ollama list | grep -q "k8s-cli"; then
    echo "🗑️  Removing old k8s-cli model..."
    ollama rm k8s-cli || true
fi

# Create new model from Modelfile
echo "🏗️  Creating k8s-cli model from Modelfile..."
ollama create k8s-cli -f Modelfile

# Verify creation
if ollama list | grep -q "k8s-cli"; then
    echo ""
    echo "✅ SUCCESS! k8s-cli model created with optimizations:"
    echo "   - Base model: Qwen 2.5 14B"
    echo "   - Temperature: 0.2"
    echo "   - Context window: 16384 tokens"
    echo "   - Top-p: 0.9, Top-k: 50"
    echo "   - Repeat penalty: 1.1"
    echo "   - No system prompt conflicts"
    echo ""
    echo "📊 Model details:"
    ollama list | grep "k8s-cli"
    echo ""
    echo "🚀 Ready to use! Switch to 'k8s-cli' in lens-killer settings."
    echo ""
    echo "💡 Qwen 2.5 14B advantages:"
    echo "   - Better reasoning than Llama 3.1 8B"
    echo "   - Handles 16k context (vs 8k)"
    echo "   - More accurate tool selection"
    echo "   - Better at following instructions"
else
    echo ""
    echo "❌ Error: Model creation failed"
    exit 1
fi
