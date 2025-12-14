#!/bin/bash
# Provision a complete OpsPilot VM with H100 GPUs, Ollama, and all models
# This script creates an Azure VM identical to the production setup

set -e

# Configuration
RESOURCE_GROUP="${RESOURCE_GROUP:-GENIUSK8SRG}"
VM_NAME="${VM_NAME:-GeniusK8s-H100-Spot}"
LOCATION="${LOCATION:-eastus}"
VM_SIZE="${VM_SIZE:-Standard_ND96isr_H100_v5}"  # 2x H100 NVL GPUs
IMAGE="${IMAGE:-Canonical:ubuntu-24_04-lts:server:latest}"
ADMIN_USER="${ADMIN_USER:-azureuser}"
PRIORITY="${PRIORITY:-Spot}"  # Regular or Spot
EVICTION_POLICY="${EVICTION_POLICY:-Deallocate}"
MAX_PRICE="${MAX_PRICE:--1}"  # -1 means pay up to on-demand price

echo "🚀 OpsPilot VM Provisioning Script"
echo "=================================="
echo "Resource Group: $RESOURCE_GROUP"
echo "VM Name: $VM_NAME"
echo "Location: $LOCATION"
echo "VM Size: $VM_SIZE (2x NVIDIA H100 NVL, 96 vCPUs, 640GB RAM)"
echo "Priority: $PRIORITY"
echo ""

# Step 1: Create Resource Group (if not exists)
echo "📦 Step 1: Creating resource group..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" || echo "Resource group already exists"

# Step 2: Create VM with H100 GPUs
echo "💻 Step 2: Creating VM with H100 GPUs..."
if [ "$PRIORITY" == "Spot" ]; then
    az vm create \
        --resource-group "$RESOURCE_GROUP" \
        --name "$VM_NAME" \
        --location "$LOCATION" \
        --size "$VM_SIZE" \
        --image "$IMAGE" \
        --admin-username "$ADMIN_USER" \
        --generate-ssh-keys \
        --priority "$PRIORITY" \
        --eviction-policy "$EVICTION_POLICY" \
        --max-price "$MAX_PRICE" \
        --public-ip-sku Standard \
        --os-disk-size-gb 512 \
        --verbose
else
    az vm create \
        --resource-group "$RESOURCE_GROUP" \
        --name "$VM_NAME" \
        --location "$LOCATION" \
        --size "$VM_SIZE" \
        --image "$IMAGE" \
        --admin-username "$ADMIN_USER" \
        --generate-ssh-keys \
        --public-ip-sku Standard \
        --os-disk-size-gb 512 \
        --verbose
fi

# Step 3: Open required ports
echo "🔓 Step 3: Opening required ports..."
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 22 --priority 100
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 11434 --priority 110  # Ollama API

# Step 4: Get VM IP
echo "🔍 Step 4: Getting VM public IP..."
VM_IP=$(az vm show -d --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --query publicIps -o tsv)
echo "VM IP: $VM_IP"

# Step 5: Wait for SSH to be ready
echo "⏳ Step 5: Waiting for SSH to be ready..."
for i in {1..60}; do
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$ADMIN_USER@$VM_IP" "echo SSH ready" 2>/dev/null; then
        echo "✓ SSH is ready"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "✗ SSH failed to become ready after 5 minutes"
        exit 1
    fi
    sleep 5
done

# Step 6: Install NVIDIA drivers and CUDA
echo "🎮 Step 6: Installing NVIDIA drivers and CUDA toolkit..."
ssh "$ADMIN_USER@$VM_IP" 'bash -s' <<'ENDSSH'
set -e

# Update system
sudo apt-get update
sudo apt-get upgrade -y

# Install NVIDIA drivers
sudo apt-get install -y ubuntu-drivers-common
sudo ubuntu-drivers autoinstall

# Install CUDA toolkit
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt-get update
sudo apt-get -y install cuda-toolkit-13-1

# Verify installation
nvidia-smi || echo "NVIDIA driver installation pending reboot"
ENDSSH

# Step 7: Reboot and wait
echo "🔄 Step 7: Rebooting VM to load NVIDIA drivers..."
az vm restart --resource-group "$RESOURCE_GROUP" --name "$VM_NAME"
echo "Waiting 60 seconds for reboot..."
sleep 60

# Wait for SSH again
for i in {1..60}; do
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$ADMIN_USER@$VM_IP" "nvidia-smi" 2>/dev/null; then
        echo "✓ NVIDIA drivers loaded successfully"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "✗ NVIDIA drivers failed to load after reboot"
        exit 1
    fi
    sleep 5
done

# Step 8: Install Ollama
echo "🦙 Step 8: Installing Ollama..."
ssh "$ADMIN_USER@$VM_IP" 'bash -s' <<'ENDSSH'
set -e

# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Enable Ollama service
sudo systemctl enable ollama
sudo systemctl start ollama

# Wait for Ollama to be ready
sleep 5
curl -s http://localhost:11434/api/tags > /dev/null && echo "Ollama is running"
ENDSSH

# Step 9: Configure Ollama for multiple models
echo "⚙️ Step 9: Configuring Ollama for 3 concurrent models..."
ssh "$ADMIN_USER@$VM_IP" 'bash -s' <<'ENDSSH'
set -e

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
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"
Environment="OLLAMA_MAX_LOADED_MODELS=3"
Environment="OLLAMA_NUM_PARALLEL=3"

[Install]
WantedBy=default.target
EOF

sudo systemctl daemon-reload
sudo systemctl restart ollama
sleep 5
ENDSSH

# Step 10: Pull required models
echo "📥 Step 10: Pulling Ollama models (this will take ~30 minutes)..."
ssh "$ADMIN_USER@$VM_IP" 'bash -s' <<'ENDSSH'
set -e

echo "Pulling llama3.3:70b (base for opspilot-brain)..."
ollama pull llama3.3:70b

echo "Pulling qwen2.5-coder:32b (base for k8s-cli)..."
ollama pull qwen2.5-coder:32b

echo "Pulling nomic-embed-text (for KB embeddings)..."
ollama pull nomic-embed-text

ollama list
ENDSSH

# Step 11: Upload and create custom models
echo "🎯 Step 11: Creating custom OpsPilot models..."

# Upload modelfiles
scp "$(dirname "$0")/../modelfiles/opspilot-brain-updated.modelfile" "$ADMIN_USER@$VM_IP:/tmp/"
scp "$(dirname "$0")/../modelfiles/k8s-cli-updated.modelfile" "$ADMIN_USER@$VM_IP:/tmp/"

# Create models from modelfiles
ssh "$ADMIN_USER@$VM_IP" 'bash -s' <<'ENDSSH'
set -e

echo "Creating opspilot-brain:latest model..."
ollama create opspilot-brain:latest -f /tmp/opspilot-brain-updated.modelfile

echo "Creating k8s-cli:latest model..."
ollama create k8s-cli:latest -f /tmp/k8s-cli-updated.modelfile

echo "Models created successfully:"
ollama list
ENDSSH

# Step 12: Install preload service
echo "🔧 Step 12: Installing model preload service..."
scp "$(dirname "$0")/preload-ollama-models.sh" "$ADMIN_USER@$VM_IP:/home/$ADMIN_USER/"
scp "$(dirname "$0")/ollama-preload.service" "$ADMIN_USER@$VM_IP:/tmp/"

ssh "$ADMIN_USER@$VM_IP" 'bash -s' <<'ENDSSH'
set -e

chmod +x /home/azureuser/preload-ollama-models.sh
sudo cp /tmp/ollama-preload.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable ollama-preload.service

echo "Running initial model preload..."
/home/azureuser/preload-ollama-models.sh
ENDSSH

# Step 13: Verify GPU distribution
echo "🎮 Step 13: Verifying GPU distribution..."
ssh "$ADMIN_USER@$VM_IP" "nvidia-smi"

echo ""
echo "✅ VM PROVISIONING COMPLETE!"
echo "=============================="
echo "VM Name: $VM_NAME"
echo "VM IP: $VM_IP"
echo "SSH: ssh $ADMIN_USER@$VM_IP"
echo "Ollama API: http://$VM_IP:11434"
echo ""
echo "Models installed:"
echo "  - opspilot-brain:latest (70B, GPU 0)"
echo "  - k8s-cli:latest (32B, GPU 1)"
echo "  - nomic-embed-text (137M, GPU 1)"
echo ""
echo "Services:"
echo "  - ollama.service (running)"
echo "  - ollama-preload.service (enabled, runs on boot)"
echo ""
echo "Next steps:"
echo "  1. Update agent_server.py to use: export LLM_HOST=\"http://$VM_IP:11434\""
echo "  2. Test connection: curl http://$VM_IP:11434/api/tags"
echo "  3. Deploy agent-server to this VM or connect from local machine"
