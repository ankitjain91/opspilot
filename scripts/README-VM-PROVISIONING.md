# OpsPilot VM Provisioning Guide

Automated provisioning script for creating production-ready OpsPilot VMs with H100 GPUs.

## Quick Start

```bash
# Default configuration (creates Spot VM)
./scripts/provision-opspilot-vm.sh

# Custom configuration
RESOURCE_GROUP=MyRG VM_NAME=MyOpsPilot PRIORITY=Regular ./scripts/provision-opspilot-vm.sh
```

## What Gets Installed

### Hardware
- **VM Size**: Standard_ND96isr_H100_v5
- **GPUs**: 2x NVIDIA H100 NVL (95GB VRAM each)
- **CPUs**: 96 vCPUs
- **RAM**: 640GB
- **Disk**: 512GB OS disk

### Software Stack
1. **Ubuntu 24.04 LTS** (latest)
2. **NVIDIA Drivers** (latest via ubuntu-drivers)
3. **CUDA Toolkit 13.1**
4. **Ollama** (latest)
5. **3 AI Models**:
   - `opspilot-brain:latest` (llama3.3:70b, ~42GB, GPU 0)
   - `k8s-cli:latest` (qwen2.5-coder:32b, ~30GB, GPU 1)
   - `nomic-embed-text` (137M params, ~0.6GB, GPU 1)

### Services
- `ollama.service` - Ollama API server (port 11434)
- `ollama-preload.service` - Automatic model loading on boot

## Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `RESOURCE_GROUP` | GENIUSK8SRG | Azure resource group |
| `VM_NAME` | GeniusK8s-H100-Spot | VM name |
| `LOCATION` | eastus | Azure region |
| `VM_SIZE` | Standard_ND96isr_H100_v5 | H100 VM size |
| `ADMIN_USER` | azureuser | SSH username |
| `PRIORITY` | Spot | `Spot` or `Regular` |
| `EVICTION_POLICY` | Deallocate | For Spot VMs |
| `MAX_PRICE` | -1 | Max Spot price (-1 = on-demand) |

## Step-by-Step Process

### Phase 1: Infrastructure (Steps 1-4)
1. Create resource group
2. Create VM with H100 GPUs
3. Open ports 22 (SSH) and 11434 (Ollama)
4. Get VM public IP

### Phase 2: NVIDIA Setup (Steps 5-7)
5. Wait for SSH readiness
6. Install NVIDIA drivers + CUDA
7. Reboot and verify GPU detection

### Phase 3: Ollama Installation (Steps 8-9)
8. Install Ollama
9. Configure for 3 concurrent models

### Phase 4: Model Setup (Steps 10-11)
10. Pull base models (~30 minutes):
    - llama3.3:70b (42GB download)
    - qwen2.5-coder:32b (19GB download)
    - nomic-embed-text (274MB download)
11. Create custom OpsPilot models from modelfiles

### Phase 5: Automation (Steps 12-13)
12. Install preload service for automatic model loading
13. Verify GPU distribution

## GPU Distribution Strategy

```
GPU 0: opspilot-brain:latest (70B, ~42GB VRAM)
       ├─ Used for: Query analysis, reasoning, pattern matching
       └─ Dedicated GPU for maximum throughput

GPU 1: k8s-cli:latest (32B, ~30GB VRAM)
       nomic-embed-text (137M, ~0.6GB VRAM)
       ├─ k8s-cli: kubectl command generation
       └─ nomic-embed-text: Knowledge base embeddings
```

**Total VRAM**: ~73GB / 191GB (38% utilization with headroom for inference)

## Cost Optimization

### Spot VMs (Default)
- **Cost**: ~70% cheaper than regular
- **Risk**: Can be evicted with 30s notice
- **Best for**: Development, testing, non-critical workloads
- **Mitigation**: Set `EVICTION_POLICY=Deallocate` to preserve disk

### Regular VMs
```bash
PRIORITY=Regular ./scripts/provision-opspilot-vm.sh
```
- **Cost**: Full on-demand price (~$27/hour for ND96isr_H100_v5)
- **Stability**: Guaranteed availability
- **Best for**: Production, critical workloads

## Network Security

Ports opened automatically:
- **22 (SSH)**: For management and deployment
- **11434 (Ollama)**: For model API access

**⚠️ Security Note**: The script creates a public IP by default. For production:
1. Use Azure Bastion for SSH access
2. Restrict Ollama port to your IP range
3. Consider VNet integration with no public IP

## Troubleshooting

### SSH timeout during provisioning
```bash
# Check VM status
az vm show -d -g GENIUSK8SRG -n GeniusK8s-H100-Spot --query powerState

# Get IP manually
az vm show -d -g GENIUSK8SRG -n GeniusK8s-H100-Spot --query publicIps -o tsv
```

### NVIDIA drivers not loading
```bash
# SSH to VM and check
ssh azureuser@<VM_IP> "nvidia-smi"

# If failed, manually install
ssh azureuser@<VM_IP>
sudo ubuntu-drivers autoinstall
sudo reboot
```

### Ollama models not loading
```bash
# Check Ollama service
ssh azureuser@<VM_IP> "systemctl status ollama"

# Check model preload logs
ssh azureuser@<VM_IP> "sudo cat /var/log/ollama-preload.log"

# Manually preload
ssh azureuser@<VM_IP> "/home/azureuser/preload-ollama-models.sh"
```

### GPU memory issues
```bash
# Check current GPU usage
ssh azureuser@<VM_IP> "nvidia-smi"

# Restart Ollama to clear VRAM
ssh azureuser@<VM_IP> "sudo systemctl restart ollama"
```

## Post-Provisioning

### Connect Agent Server

**Option 1: Remote Ollama (recommended)**
```bash
export LLM_HOST="http://<VM_IP>:11434"
export LLM_MODEL="opspilot-brain:latest"
export EXECUTOR_MODEL="k8s-cli:latest"
python agent_server.py
```

**Option 2: Deploy agent to VM**
```bash
scp dist/agent-server azureuser@<VM_IP>:/home/azureuser/
ssh azureuser@<VM_IP> "LLM_HOST=http://localhost:11434 ./agent-server"
```

### Verify Setup
```bash
# Check all models loaded
curl http://<VM_IP>:11434/api/tags | jq '.models[].name'

# Test brain model
curl http://<VM_IP>:11434/api/generate -d '{
  "model": "opspilot-brain:latest",
  "prompt": "List failing pods",
  "stream": false
}'

# Check GPU distribution
ssh azureuser@<VM_IP> "nvidia-smi"
```

## Cleanup

```bash
# Delete entire resource group (WARNING: permanent!)
az group delete --name GENIUSK8SRG --yes --no-wait

# Delete just the VM (keeps other resources)
az vm delete --resource-group GENIUSK8SRG --name GeniusK8s-H100-Spot --yes
```

## Estimated Provisioning Time

| Phase | Duration |
|-------|----------|
| VM creation | 5-10 min |
| NVIDIA setup + reboot | 5-10 min |
| Ollama installation | 2 min |
| Model downloads | 25-35 min |
| Model creation + preload | 5-10 min |
| **Total** | **40-70 min** |

*Note: Most time is spent downloading large models (61GB total)*

## Advanced: Custom Modelfiles

To update OpsPilot's behavior without re-provisioning:

```bash
# Edit modelfiles locally
vim modelfiles/opspilot-brain-updated.modelfile

# Upload and recreate model
scp modelfiles/opspilot-brain-updated.modelfile azureuser@<VM_IP>:/tmp/
ssh azureuser@<VM_IP> "ollama create opspilot-brain:latest -f /tmp/opspilot-brain-updated.modelfile"

# Restart to apply
ssh azureuser@<VM_IP> "sudo systemctl restart ollama"
```

## Support

For issues:
1. Check `/var/log/ollama-preload.log` on the VM
2. Check `journalctl -u ollama -f` for Ollama service logs
3. Verify with `nvidia-smi` that GPUs are detected
