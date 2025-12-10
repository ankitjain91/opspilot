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
echo "📦 Checking for llama3.1:8b-instruct-q8_0..."
if ! ollama list | grep -q "llama3.1:8b-instruct-q8_0"; then
    echo "⬇️  Pulling llama3.1:8b-instruct-q8_0 (this may take a few minutes)..."
    ollama pull llama3.1:8b-instruct-q8_0
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
    echo "   - Temperature: 0.3"
    echo "   - Context window: 8192 tokens"
    echo "   - Top-p: 0.9, Top-k: 40"
    echo "   - Repeat penalty: 1.1"
    echo "   - No system prompt conflicts"
    echo ""
    echo "📊 Model details:"
    ollama list | grep "k8s-cli"
    echo ""
    echo "🚀 Ready to use! Switch to 'k8s-cli' in lens-killer settings."
else
    echo ""
    echo "❌ Error: Model creation failed"
    exit 1
fi
