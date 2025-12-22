# OpsPilot 🚀

<div align="center">

**The Kubernetes IDE that actually understands your clusters.**

*Because staring at `kubectl get pods` at 3 AM shouldn't be your only debugging option.*

[![License](https://img.shields.io/badge/license-BUSL--1.1-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.61-green.svg)](https://github.com/ankitjain91/opspilot/releases)
[![Claude Code](https://img.shields.io/badge/powered%20by-Claude%20Code-purple.svg)](https://claude.ai)

[Features](#-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [Documentation](#-documentation)

</div>

---

## 🤔 Why OpsPilot?

Let's be honest. Kubernetes is amazing until something breaks. Then it's:

```bash
kubectl get pods -A | grep -v Running
kubectl describe pod failing-pod-abc123
kubectl logs failing-pod-abc123 --previous
# *scrolls through 10,000 lines of logs*
# *questions life choices*
```

**OpsPilot changes that.**

Just ask: *"Why is my payment service crashing?"*

And watch as Claude Code:
1. Finds the failing pods
2. Checks the logs
3. Examines events
4. Analyzes the crash reason
5. Even searches your GitHub code for the bug

All while you sip your coffee. ☕

---

## ✨ Features

### 🤖 AI-Powered Debugging (Claude Code)

OpsPilot uses **Claude Code** - Anthropic's autonomous coding agent - as its brain.

- **Autonomous Investigation**: Claude runs kubectl commands, follows diagnostic chains, and actually *thinks* about the problem
- **Streaming UI**: Watch Claude work in real-time. It's like pair programming, but your partner has read every K8s doc ever written
- **Read-Only Safety**: Claude can look, but can't touch. No accidental `kubectl delete namespace production` moments

```
You: "Why is the auth-service returning 503s?"

Claude: *runs 15 commands*
        *analyzes logs*
        *checks recent deployments*
        *finds the OOMKilled container*

"The auth-service is being OOMKilled because the memory limit
is 256Mi but it's using 340Mi at peak. Here's the exact line
in your deployment.yaml that needs changing..."
```

### 🔗 GitHub Code Search (MCP Integration)

When Claude finds an error, it can search your actual source code:

- **Find the bug**: Search for error strings in your repos
- **Understand the code**: Read the source files causing issues
- **Check recent commits**: Correlate issues with deployments
- **Find related issues**: Check if it's a known bug

*"The NullPointerException is thrown at line 47 of PaymentProcessor.java, introduced in commit abc123 two days ago."*

### 🧠 Smart Knowledge Base

OpsPilot comes with **57+ built-in troubleshooting patterns** for common K8s issues:

- CrashLoopBackOff? Got it.
- ImagePullBackOff? Covered.
- OOMKilled? Yep.
- That weird DNS issue that only happens on Thursdays? ...we're working on it.

Plus it **auto-discovers CRDs** from your cluster and learns your custom resources.

### 📊 Cluster Cockpit

A beautiful dashboard that shows you:

- **Resource utilization** across namespaces
- **Health metrics** at a glance
- **Cost insights** (know exactly which team is burning through your cloud budget)
- **Real-time metrics history** with pretty charts

### 🔍 Deep Dive Drawer

Click any resource and get a context-aware AI panel:

- AI automatically knows which resource you're looking at
- Ask "why is this crashing?" - no need to specify the pod name
- View logs, events, and YAML all in one place
- One-click "Find related code" button

### 🎯 Resource Management

- **Live resource watching** with real-time updates
- **Multi-namespace support**
- **Custom resource filtering** and search
- **YAML editor** with syntax highlighting
- **Log streaming** with follow mode
- **Exec into containers** right from the UI

### ⛵ Helm Integration

Full Helm release management:

- List all releases across namespaces
- View release history and values
- One-click rollback (because we all make mistakes)
- See all resources created by a release

### 🔷 ArgoCD Integration

For the GitOps enthusiasts:

- View ArgoCD applications
- Sync and refresh apps
- Patch Helm values and sources
- Visual dependency graphs

### 🌐 vCluster Support

Create virtual clusters for:

- Development environments
- Testing
- Multi-tenant setups
- Making your cluster look more impressive in demos

### ☁️ Azure AKS Integration

First-class Azure support:

- **One-click Azure login**
- **Auto-discover AKS clusters** across subscriptions
- **AKS-specific metrics** and insights
- **Credential management** built-in

### 🔌 MCP Server Support

Extensible with Model Context Protocol servers:

- **Presets for common tools** (GitHub, filesystem, etc.)
- **Custom server support**
- **Tool discovery** and management

### 🖥️ Built-in Terminal

Because sometimes you just need a shell:

- Local terminal integration
- Container exec support
- AI-assisted terminal agent (coming soon™)

### 🔐 Security First

- **Read-only by default**: Claude observes but doesn't modify
- **Local storage**: Your conversations stay on your machine
- **Secure secrets**: API keys stored in system keyring
- **Fine-grained permissions**: Control what the AI can access

### 🎨 Beautiful UI

- Dark mode (because we're not savages)
- Smooth animations
- Responsive design
- Actually pleasant to look at at 3 AM

---

## 💻 Installation

### Prerequisites

| Tool | Required | Purpose |
|------|----------|---------|
| **kubectl** | ✅ Yes | Cluster communication |
| **helm** | ✅ Yes | Helm release management |
| **Claude Code CLI** | ✅ Yes | AI-powered debugging |
| **Ollama** | Optional | Local embeddings for knowledge base |
| **vcluster** | Optional | Virtual cluster support |

### macOS

```bash
# Install dependencies
brew install kubectl helm ollama

# Start Ollama (OpsPilot auto-starts it, but just in case)
ollama serve &

# Pull the embedding model
ollama pull nomic-embed-text

# Install Claude Code
npm install -g @anthropic-ai/claude-code
claude login

# Download OpsPilot from releases
# https://github.com/ankitjain91/opspilot/releases
```

After downloading, remove the quarantine attribute:
```bash
xattr -cr /Applications/OpsPilot.app
```

### Windows

```powershell
# Install dependencies (PowerShell as Admin)
winget install -e --id Kubernetes.kubectl
winget install -e --id Helm.Helm
winget install -e --id Ollama.Ollama

# Start Ollama
ollama serve

# Pull embedding model
ollama pull nomic-embed-text

# Install Claude Code
npm install -g @anthropic-ai/claude-code
claude login

# Download and run OpsPilot installer
```

### Linux

```bash
# Install kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
chmod +x kubectl && sudo mv kubectl /usr/local/bin/

# Install Helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &
ollama pull nomic-embed-text

# Install Claude Code
npm install -g @anthropic-ai/claude-code
claude login

# Download AppImage and run
chmod +x OpsPilot_*.AppImage
./OpsPilot_*.AppImage
```

---

## 🚀 Quick Start

### 1. Connect to a Cluster

- Open OpsPilot
- Select your kubeconfig file (defaults to `~/.kube/config`)
- Click on a context to connect

### 2. Ask Claude Anything

Open the AI chat panel and try:

- *"Show me all failing pods"*
- *"Why is the payment-service crashing?"*
- *"What changed in the last hour?"*
- *"Find pods using more than 500Mi memory"*

### 3. Deep Dive into Resources

- Click any pod/deployment/service
- The Deep Dive drawer opens with context-aware AI
- Ask questions specific to that resource

### 4. Enable GitHub Integration (Optional)

1. Open Settings (gear icon)
2. Go to GitHub Integration
3. Add your Personal Access Token
4. Now Claude can search your source code!

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpsPilot Desktop App                          │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐ │
│  │   Tauri/Rust Core   │    │         React Frontend          │ │
│  │   ─────────────────  │    │   ─────────────────────────────  │ │
│  │   • K8s API client  │◄──►│   • Dashboard & Cockpit         │ │
│  │   • Helm commands   │    │   • AI Chat Panel               │ │
│  │   • Azure auth      │    │   • Deep Dive Drawer            │ │
│  │   • System keyring  │    │   • Resource viewers            │ │
│  │   • Auto-updater    │    │   • Helm/Argo managers          │ │
│  └─────────────────────┘    └─────────────────────────────────┘ │
└───────────────────────────────────┬─────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Python Agent Server (Sidecar)                    │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐ │
│  │   Claude Code       │    │      Integrations               │ │
│  │   ─────────────────  │    │   ─────────────────────────────  │ │
│  │   • Autonomous AI   │◄──►│   • MCP Servers (GitHub, etc)   │ │
│  │   • Tool execution  │    │   • Knowledge Base (RAG)        │ │
│  │   • Streaming       │    │   • Embeddings (Ollama)         │ │
│  │   • Safety filters  │    │   • Pattern matching            │ │
│  └─────────────────────┘    └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Configuration

### AI Provider Setup

1. **Claude Code (Recommended)**
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude login
   ```
   Select "Claude Code" in Settings → AI Provider

2. **Anthropic API**
   - Get API key from [console.anthropic.com](https://console.anthropic.com)
   - Add key in Settings

3. **Ollama (Local/Offline)**
   - Install Ollama
   - Pull a model: `ollama pull llama3.2`
   - Select "Ollama" in Settings

### Knowledge Base Setup

```bash
# Pull the embedding model
ollama pull nomic-embed-text

# In OpsPilot Settings → Knowledge Base → Click "Initialize"
```

### GitHub Integration

1. Create a [Fine-Grained PAT](https://github.com/settings/personal-access-tokens/new)
2. Grant `Contents: Read-only` permission
3. Add token in Settings → GitHub Integration
4. Click Test to verify

---

## 🛠️ Development

### Running from Source

```bash
# Clone
git clone https://github.com/ankitjain91/opspilot.git
cd opspilot

# Install dependencies
npm install

# Set up Python environment
cd python
pip install -r requirements.txt
cd ..

# Run in dev mode
npm run tauri dev
```

### Building

```bash
npm run tauri build
# Output in src-tauri/target/release/bundle/
```

### Project Structure

```
opspilot/
├── src/                      # React frontend
│   ├── components/
│   │   ├── ai/              # AI chat, settings, orchestrator
│   │   ├── cluster/         # Connection, deep dive, resources
│   │   ├── dashboard/       # Main dashboard, cockpit
│   │   ├── tools/           # Helm, ArgoCD, Terminal
│   │   └── settings/        # Configuration panels
├── src-tauri/               # Rust backend
│   └── src/
│       ├── commands/        # Tauri command handlers
│       ├── client.rs        # K8s client
│       └── ai_local.rs      # Local AI integration
├── python/                  # Agent server
│   └── agent_server/
│       ├── server.py        # FastAPI server
│       ├── claude_code_backend.py
│       └── knowledge_base.py
└── knowledge/               # Built-in troubleshooting patterns
```

---

## 🆚 OpsPilot vs. The Competition

| Feature | OpsPilot | Lens | K9s | kubectl |
|---------|----------|------|-----|---------|
| AI-Powered Debugging | ✅ Claude Code | ❌ | ❌ | ❌ |
| Natural Language Queries | ✅ | ❌ | ❌ | ❌ |
| GitHub Code Search | ✅ | ❌ | ❌ | ❌ |
| Knowledge Base | ✅ 57+ patterns | ❌ | ❌ | ❌ |
| Beautiful UI | ✅ | ✅ | 🟡 TUI | ❌ |
| Fast Startup | ✅ ~1s | 🟡 ~5s | ✅ | ✅ |
| Memory Usage | ~150MB | ~500MB+ | ~50MB | ~20MB |
| Auto-Updates | ✅ | ✅ | ❌ | ❌ |
| Price | Free | Freemium | Free | Free |

---

## 🙏 Acknowledgments

- **[Anthropic](https://anthropic.com)** for Claude Code - the AI that actually understands code
- **[Tauri](https://tauri.app)** for making native apps not terrible
- **The K8s community** for building something we need to debug at 3 AM

---

## 📄 License

[BUSL-1.1](LICENSE) - Free for individual and internal business use.

---

## 🤝 Contributing

Found a bug? Want a feature? PRs welcome!

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

<div align="center">

**Built with 💜 and too much caffeine**

*Because life's too short for `kubectl describe`*

[⬆ Back to top](#opspilot-)

</div>
