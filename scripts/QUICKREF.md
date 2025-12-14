# OpsPilot VM Quick Reference

## 🚀 Create New VM
```bash
./scripts/provision-opspilot-vm.sh
```

## 🔧 Common Operations

### Connect to VM
```bash
ssh azureuser@172.190.53.1
```

### Check GPU Status
```bash
ssh azureuser@172.190.53.1 "nvidia-smi"
```

### Check Loaded Models
```bash
curl -s http://172.190.53.1:11434/api/ps | jq
```

### Restart Ollama
```bash
ssh azureuser@172.190.53.1 "sudo systemctl restart ollama"
```

### Reload All Models
```bash
ssh azureuser@172.190.53.1 "/home/azureuser/preload-ollama-models.sh"
```

### Check Preload Service Logs
```bash
ssh azureuser@172.190.53.1 "sudo cat /var/log/ollama-preload.log"
```

### Update Custom Models
```bash
# Upload new modelfile
scp modelfiles/opspilot-brain-updated.modelfile azureuser@172.190.53.1:/tmp/

# Recreate model
ssh azureuser@172.190.53.1 "ollama create opspilot-brain:latest -f /tmp/opspilot-brain-updated.modelfile"

# Restart
ssh azureuser@172.190.53.1 "sudo systemctl restart ollama"
```

## 🎯 Agent Configuration

### Local Agent → Remote Ollama
```bash
export LLM_HOST="http://172.190.53.1:11434"
export LLM_MODEL="opspilot-brain:latest"
export EXECUTOR_MODEL="k8s-cli:latest"
python agent_server.py
```

### Deploy Agent to VM
```bash
scp dist/agent-server azureuser@172.190.53.1:/home/azureuser/
ssh azureuser@172.190.53.1 "nohup ./agent-server > agent.log 2>&1 &"
```

## 💰 Cost Management

### Check VM Status
```bash
az vm show -d -g GENIUSK8SRG -n GeniusK8s-H100-Spot --query powerState -o tsv
```

### Stop VM (Spot: keeps disk)
```bash
az vm deallocate -g GENIUSK8SRG -n GeniusK8s-H100-Spot
```

### Start VM
```bash
az vm start -g GENIUSK8SRG -n GeniusK8s-H100-Spot
```

### Get Public IP
```bash
az vm show -d -g GENIUSK8SRG -n GeniusK8s-H100-Spot --query publicIps -o tsv
```

## 🐛 Troubleshooting

### Models Not in VRAM
```bash
# Check if loaded
curl http://172.190.53.1:11434/api/ps

# Force reload
ssh azureuser@172.190.53.1 'echo "test" | ollama run opspilot-brain:latest'
ssh azureuser@172.190.53.1 'echo "test" | ollama run k8s-cli:latest'
ssh azureuser@172.190.53.1 'echo "test" | ollama run nomic-embed-text'
```

### Check Service Status
```bash
ssh azureuser@172.190.53.1 "systemctl status ollama"
ssh azureuser@172.190.53.1 "systemctl status ollama-preload"
```

### View Live Ollama Logs
```bash
ssh azureuser@172.190.53.1 "sudo journalctl -u ollama -f"
```

## 🔒 Security

### Restrict Ollama Access
```bash
# Only allow your IP
MY_IP=$(curl -s ifconfig.me)
az vm open-port -g GENIUSK8SRG -n GeniusK8s-H100-Spot --port 11434 --priority 110 \
  --rule-name AllowOllamaMyIP --source-address-prefixes $MY_IP/32
```

### Close Public Access
```bash
az vm close-port -g GENIUSK8SRG -n GeniusK8s-H100-Spot --port 11434
```

## 📊 Monitoring

### Real-time GPU Usage
```bash
ssh azureuser@172.190.53.1 "watch -n 1 nvidia-smi"
```

### Model Response Test
```bash
time curl -s http://172.190.53.1:11434/api/generate -d '{
  "model": "opspilot-brain:latest",
  "prompt": "test",
  "stream": false,
  "options": {"num_predict": 1}
}'
```
