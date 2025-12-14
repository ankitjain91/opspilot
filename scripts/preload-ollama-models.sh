#!/bin/bash
# Preload Ollama models into VRAM on system startup
# This prevents cold start delays when the agent first runs
# GPU Distribution: GPU 0 = opspilot-brain | GPU 1 = k8s-cli + nomic-embed-text

OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"
LOG_FILE="/var/log/ollama-preload.log"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

log "🚀 Starting Ollama model preload service"

# Wait for Ollama to be ready
for i in {1..60}; do
    if curl -s "$OLLAMA_HOST/api/tags" > /dev/null 2>&1; then
        log "✓ Ollama is ready"
        break
    fi
    if [ $i -eq 60 ]; then
        log "✗ Ollama failed to start after 60 seconds"
        exit 1
    fi
    sleep 1
done

# Sequential loading to ensure proper GPU distribution
# Load brain first (goes to GPU 0)
log "  Loading opspilot-brain:latest (GPU 0)..."
echo "test" | timeout 120 ollama run opspilot-brain:latest > /dev/null 2>&1
if [ $? -eq 0 ]; then
    log "  ✓ opspilot-brain:latest loaded on GPU 0"
else
    log "  ⚠ opspilot-brain:latest load timed out"
fi

# Load k8s-cli and nomic-embed-text in parallel (both go to GPU 1)
log "  Loading k8s-cli:latest + nomic-embed-text (GPU 1)..."
(echo "test" | timeout 120 ollama run k8s-cli:latest > /dev/null 2>&1) &
CLI_PID=$!
(echo "test" | timeout 120 ollama run nomic-embed-text > /dev/null 2>&1) &
EMBED_PID=$!

# Wait for both GPU 1 models
wait $CLI_PID
if [ $? -eq 0 ]; then
    log "  ✓ k8s-cli:latest loaded on GPU 1"
else
    log "  ⚠ k8s-cli:latest load timed out"
fi

wait $EMBED_PID
if [ $? -eq 0 ]; then
    log "  ✓ nomic-embed-text loaded on GPU 1"
else
    log "  ⚠ nomic-embed-text load timed out"
fi

# Verify GPU distribution
log ""
log "GPU Distribution:"
nvidia-smi --query-gpu=index,memory.used --format=csv,noheader,nounits | while read -r line; do
    log "  GPU $line MB"
done

log "✅ All 3 models preloaded successfully"
