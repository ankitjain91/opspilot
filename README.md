# OpsPilot (formerly Lens Killer)

**OpsPilot** is an intelligent, next-generation Kubernetes management platform designed to replace legacy tools like Lens. It combines a high-performance Rust/Tauri frontend with a powerful local AI Agent to provide deep insights, automated troubleshooting, and context-aware management of your clusters.

![OpsPilot Screenshot](docs/screenshots/overview.png) *[Placeholder for screenshot]*

## 🚀 Key Features

*   **⚡ Blazing Fast UI**: Built with **Tauri** (Rust) and **React**, offering near-native performance and low memory footprint compared to Electron-based alternatives.
*   **🤖 AI-Powered Sidecar**: A sophisticated **Python-based Agent** (using LangGraph) that runs locally. It acts as a "Supervisor" and "Scout", autonomously investigating cluster issues, analyzing logs, and suggesting fixes.
*   **🧠 Context-Aware Deep Dive**: Open any resource (Pod, Deployment, etc.) in a dedicated "Deep Dive Drawer" where the AI is fully immersed in that specific context (logs, events, YAML).
*   **🌐 vCluster Integration**: seamless support for creating and managing virtual clusters (vClusters) directly from the UI.
*   **🔌 MCP Support**: Full support for the **Model Context Protocol (MCP)**, allowing you to extend the agent's capabilities with external tools (GitHub, Git, Postgres, etc.).
*   **🔒 Privacy-First**: Designed for local LLMs (Ollama) with support for Azure OpenAI/Anthropic. Your data stays on your machine unless you choose cloud providers.
*   **🛡️ Read-Only Mode**: Safety protocols to prevent accidental modifications during AI investigations.

## 🆕 New in v0.2.4
*   **Hardened vCluster Connection**: Improved process monitoring and fallback logic for reliable connectivity.
*   **MCP Tool Visualization**: AI Chat now explicitly shows external tool execution (e.g. GitHub, Postgres) in the conversation stream.
*   **Refactored Settings**: Streamlined AI provider configuration UI.

## 🏗️ Architecture

OpsPilot uses a hybrid architecture:

1.  **Frontend (Tauri/Rust)**: Handles the UI, window management, and direct Kubernetes API interactions via `kube-rs`.
2.  **AI Sidecar (Python)**: A dedicated Python process (`agent_server.py`) that hosts the LangGraph agent. It exposes a local API for the frontend to communicate with.
    *   **Supervisor Node**: Plans the investigation.
    *   **Scout Node**: Executes safe `kubectl` commands.
3.  **communication**: The Frontend and Sidecar communicate via a local HTTP interface.

## 🛠️ Prerequisites

*   **Node.js** (v18+)
*   **Rust** (latest stable)
*   **Python** (3.10+) & `uv` (recommended for fast package management)
*   **kubectl** & **helm** (installed in your PATH)

## 📦 Installation & Setup

### 1. Clone the Repository
```bash
git clone https://github.com/ankitjain91/opspilot.git
cd opspilot
```

### 2. Backend (Rust) Setup
Install system dependencies (macOS):
```bash
brew install rust upx
```

### 3. Frontend Setup
```bash
npm install
```

### 4. AI Agent Setup (Python)
We recommend using `uv` or `venv`:
```bash
cd python
# Install dependencies
pip install -r requirements.txt
# OR with uv
uv pip install -r requirements.txt
```

### 5. Build & Run
Run the development server (starts UI and Python sidecar automatically):
```bash
npm run tauri dev
```

## 🧠 AI Configuration (Ollama / Custom)

OpsPilot is optimized for **Ollama** running locally. The AI system uses two models:

1. **Supervisor/Brain** - Reasons about problems, plans investigation steps
2. **Executor/Worker** - Translates plans into kubectl commands (can be smaller/faster)

### Quick Start (Recommended)

```bash
# Install Ollama
# macOS: brew install ollama
# Linux: curl -fsSL https://ollama.com/install.sh | sh

# Pull recommended models
ollama pull qwen2.5:14b        # Brain (reasoning)
ollama pull qwen2.5-coder:1.5b # Executor (fast command generation)
ollama pull nomic-embed-text   # Embeddings (REQUIRED for knowledge base)
```

### Why Local Embeddings Are Required

OpsPilot includes a **curated Knowledge Base** of 57+ Kubernetes troubleshooting patterns (CrashLoopBackOff fixes, Crossplane debugging, cert-manager issues, etc.). To match your questions to the right knowledge:

- **At Build Time**: We pre-generate embeddings using Ollama's `nomic-embed-text` (768-dim vectors)
- **At Runtime**: The same `nomic-embed-text` model converts your query to a vector
- **Matching**: Cosine similarity finds the most relevant KB articles

Using the same model for both build-time and runtime ensures perfect vector compatibility. This enables the agent to instantly recall expert patterns like "OOMKilled → check memory limits" without sending your data to the cloud.

### Advanced: Custom Modelfiles for Power Users

For users with powerful GPUs (24GB+ VRAM), you can create optimized custom models with K8s-specific system prompts. We provide two Modelfiles in the repo:

#### Quick Setup: Build Both Models

```bash
# First, pull the base models (one-time download)
ollama pull llama3.3:70b       # ~40GB, best reasoning
ollama pull qwen2.5-coder:32b  # ~18GB, great for commands

# Build custom K8s-optimized models from our Modelfiles
ollama create opspilot-brain -f Modelfile.brain    # Reasoning engine
ollama create opspilot-cli -f Modelfile.k8s-cli    # Command executor

# Verify they're available
ollama list | grep opspilot
```

#### Modelfile.brain (Llama 3.3 70B - Reasoning)

Optimized for complex K8s investigations with:
- 32K context window for long investigations
- Temperature 0.0 for deterministic JSON output
- K8s-specific system prompt with CR discovery protocol, mental model, and diagnostic rules
- Stop sequences tuned for Llama 3.3

```bash
# Test it
ollama run opspilot-brain "Why would a pod be in Pending state?"
```

#### Modelfile.k8s-cli (Qwen 2.5 32B - Commands)

Optimized for precise kubectl command execution with:
- Strict JSON output format (`{"thought": "...", "command": "..."}`)
- Read-only command enforcement (delete/apply/edit forbidden)
- Built-in kubectl "cheat sheet" for power commands
- Stop sequences tuned for Qwen

```bash
# Test it
ollama run opspilot-cli "Get all pods with high restart counts"
```

#### Configure in OpsPilot

In **AI Settings**, set:
- **Model**: `opspilot-brain` (reasoning/planning)
- **Executor Model**: `opspilot-cli` (command generation)

This dual-model setup gives you the best of both worlds: powerful reasoning from Llama 3.3 and precise command generation from Qwen.

### Model Recommendations by Hardware

| VRAM | Brain Model | Executor Model | Notes |
|------|-------------|----------------|-------|
| 8GB | `qwen2.5:7b` | `qwen2.5-coder:1.5b` | Basic, may struggle with complex issues |
| 16GB | `qwen2.5:14b` | `qwen2.5-coder:7b` | Good balance for most users |
| 24GB | `qwen2.5:32b` | `qwen2.5-coder:14b` | Excellent reasoning |
| 48GB+ | `llama3.3:70b` | `qwen2.5-coder:32b` | Best possible local experience |

### Cloud Providers (Alternative)

If you prefer cloud models, OpsPilot supports:
- **OpenAI**: `gpt-4o`, `gpt-4o-mini`
- **Anthropic**: `claude-sonnet-4-20250514`, `claude-3-5-haiku-20241022`
- **Azure OpenAI**: Custom deployments

**Settings**: Click the "AI Settings" (Sparkles icon) in the app to configure your provider.

## 🎮 Usage Guide

### Connecting to Clusters
*   **Local Kubeconfig**: Simply browse to your `~/.kube/config`.
*   **Azure AKS**: Sign in with Azure to auto-discover your AKS clusters.
*   **Setup Tab**: Use the "Setup" tab on the connection screen to install `kubectl` or `vcluster` if missing.

### The "Deep Dive" Drawer
Click any resource in the dashboard to open the Deep Dive Drawer.
*   **Overview**: Real-time health, metrics, and events.
*   **YAML**: Read/Edit the resource definition.
*   **AI Chat**: Ask questions like *"Why is this crashing?"*. The AI automatically locks context to this specific resource.

### MCP Extensions
Go to **AI Settings > MCP Extensions** to connect external tools like GitHub or Postgres. The Agent can then use these tools during investigations (e.g., "Check GitHub issues for this error").

## 🤝 Contributing

We welcome contributions! Please see `CONTRIBUTING.md` for guidelines.

## 📄 License

MIT License. See `LICENSE` for details.
