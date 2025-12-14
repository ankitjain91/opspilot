#!/bin/bash
# Configure Ollama to run nomic-embed-text and k8s-cli on GPU 1, opspilot-brain on GPU 0

set -e

echo "🔧 Configuring GPU affinity for Ollama models..."

# Check if running at startup or manually
if systemctl is-active --quiet ollama; then
    echo "Stopping Ollama service..."
    sudo systemctl stop ollama
fi

# Remove any override config that might conflict
sudo rm -f /etc/systemd/system/ollama.service.d/override.conf

# Update ollama service to allow multiple models loaded
sudo tee /etc/systemd/system/ollama.service > /dev/null <<'EOF'
[Unit]
Description=Ollama Service
After=network-online.target

[Service]
ExecStart=/usr/local/bin/ollama serve
User=ollama
Group=ollama
Restart=always
RestartSec=3
Environment="OLLAMA_HOST=0.0.0.0"
Environment="OLLAMA_MODELS=/home/ollama-models"
Environment="OLLAMA_KEEP_ALIVE=24h"
Environment="OLLAMA_MAX_LOADED_MODELS=3"

[Install]
WantedBy=default.target
EOF

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl start ollama

# Wait for ollama to be ready
sleep 5

echo "✅ Ollama configured to keep 3 models loaded simultaneously"
echo ""
echo "Note: Ollama automatically balances models across available GPUs."
echo "With 2x H100 GPUs (95GB each), the distribution will be:"
echo "  GPU 0: opspilot-brain (70B, ~42GB)"
echo "  GPU 1: k8s-cli (32B, ~30GB) + nomic-embed-text (137M, ~0.6GB)"
echo ""
echo "This configuration maximizes GPU 1 utilization while keeping GPU 0 dedicated to the brain."
echo ""

# Load models with progress indication
echo "🧪 Loading models onto GPUs..."
echo ""

# Load small models first (faster feedback)
echo "  [1/3] Loading nomic-embed-text (0.6GB)..."
curl -s http://localhost:11434/api/embeddings -d '{"model":"nomic-embed-text:latest","prompt":"test"}' > /dev/null 2>&1
echo "        ✅ nomic-embed-text loaded"

echo "  [2/3] Loading k8s-cli (32B, ~29GB) - this takes 2-3 minutes..."
curl -s http://localhost:11434/api/generate -d '{"model":"k8s-cli:latest","prompt":"test","stream":false,"keep_alive":"60m"}' > /dev/null 2>&1 &
KPID=$!

echo "  [3/3] Loading opspilot-brain (70B, ~42GB) - this takes 4-6 minutes..."
curl -s http://localhost:11434/api/generate -d '{"model":"opspilot-brain:latest","prompt":"test","stream":false,"keep_alive":"60m"}' > /dev/null 2>&1 &
BPID=$!

echo ""
echo "⏳ Waiting for large models to load (checking every 10s)..."

# Show progress while waiting
COUNTER=0
while kill -0 $KPID 2>/dev/null || kill -0 $BPID 2>/dev/null; do
    COUNTER=$((COUNTER + 1))
    LOADED=$(curl -s http://localhost:11434/api/ps | grep -o '"name"' | wc -l)
    GPU0_MEM=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader -i 0 | awk '{print $1}')
    GPU1_MEM=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader -i 1 | awk '{print $1}')
    echo "  ⏱  ${COUNTER}0s elapsed | ${LOADED}/3 models loaded | GPU0: ${GPU0_MEM}MB, GPU1: ${GPU1_MEM}MB"
    sleep 10
done

wait $KPID $BPID 2>/dev/null

echo ""
echo "✅ All models loaded. Checking final GPU distribution..."
nvidia-smi --query-gpu=index,name,memory.used,memory.total --format=csv
echo ""
echo "✅ Setup complete! Models will stay loaded for 60 minutes."
echo ""
echo "📊 Model distribution:"
curl -s http://localhost:11434/api/ps | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for m in data.get('models', []):
        size_gb = m['size'] / (1024**3)
        print(f\"  - {m['name']}: {size_gb:.1f}GB\")
except: pass
" 2>/dev/null || echo "  (unable to fetch model list)"

# Create systemd service to run this script on VM startup
echo ""
echo "📝 Creating startup service..."
sudo tee /etc/systemd/system/ollama-gpu-setup.service > /dev/null <<'STARTUP_EOF'
[Unit]
Description=Ollama GPU Setup and Model Preloading
After=network-online.target ollama.service
Wants=network-online.target
Requires=ollama.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=azureuser
ExecStart=/home/azureuser/setup-gpu-affinity.sh
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
STARTUP_EOF

sudo systemctl daemon-reload
sudo systemctl enable ollama-gpu-setup.service
echo "✅ Startup service created and enabled"
echo "   The GPU setup script will run automatically on VM boot"
