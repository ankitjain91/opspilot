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

OpsPilot is optimized for **Ollama** running locally.

1.  **Install Ollama**: [ollama.com](https://ollama.com)
2.  **Pull Recommended Models**:
    *   **Brain**: `ollama pull qwen2.5:14b` (or `llama3.1`)
    *   **Executor**: `ollama pull qwen2.5-coder:1.5b` (fast/lightweight)
3.  **Embedding Model** (for Knowledge Base):
    *   OpsPilot will prompt you to download `nomic-embed-text` automatically.

**Settings**:
Click the "AI Settings" (Sparkles icon) in the app to configure your provider (Ollama, OpenAI, Anthropic, or Custom).

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
