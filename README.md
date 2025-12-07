<img width="1024" height="559" alt="image" src="https://github.com/user-attachments/assets/a3604bf0-2510-424e-bc65-4260fee2f938" />

# OpsPilot

A high-performance, beautiful Kubernetes IDE built with Tauri, React, and TypeScript. Designed to be a faster, cleaner alternative to existing tools.

![License](https://img.shields.io/badge/license-BSL%201.1-blue)

## Features

- 🚀 **Blazing Fast**: Built with Rust + Tauri for native performance
- ✨ **Modern UI**: Sleek, dark-themed interface with analog gauges and real-time metrics
- ☸️ **Kubernetes Native**: Full inspection of Pods, Deployments, Services, Nodes, ConfigMaps, Secrets, CRDs, and more
- 🤖 **Multi-Provider AI Assistant**: Supports Ollama (local), OpenAI, Anthropic, and custom endpoints
- 🔬 **Cluster-Wide AI Chat**: Global floating assistant that can investigate your entire cluster
- 🎯 **Resource-Specific AI Chat**: Context-aware debugging for individual resources with autonomous investigation
- 🛡️ **Safe & Read-Only**: All AI tools are strictly read-only with mutation command guardrails
- 📊 **Cluster Cockpit**: Airplane-style dashboard with CPU/Memory speedometers, health indicators, and resource overview
- 📑 **Structured Logs & Events**: Fast access to pod logs with container selection and categorized events
- 📈 **Live Metrics**: Real-time CPU and memory charts for Pods and Nodes (with fallback for vclusters)
- 🐚 **Integrated Terminal**: Exec into pod containers with container selection
- 🔗 **Port Forwarding**: One-click port forwards with persistent list management
- ☁️ **Virtual Cluster Support**: Seamless vcluster detection and connection
- 🔧 **Context Management**: Switch contexts, delete unused contexts, and manage kubeconfig
- 🧩 **Easy AI Setup**: One-click provider selection with guided setup instructions

## AI Debugging Brain (v0.2.0 Upgrade)

OpsPilot features a revamped autonomous AI engine:

- 🧠 **Autonomous Investigation**: The AI executes iterative "thoughts" (up to 10 steps), gathering evidence, verifying hypotheses, and filtering noise before answering.
- ⚡ **Quick Fixes**: Automatically detects and highlights "Quick Fix" one-liners from the Knowledge Base for common errors (e.g., `kubectl logs -p`, `rollout restart`).
- 📚 **Specialized Knowledge**: Deep troubleshooting guides for **UiPath Automation Suite, Crossplane, Istio, vCluster, Cert-Manager**, and core K8s issues (OOMKilled, CrashLoop).
- 🛡️ **Smart Tooling**:
    - **Context Awareness**: Remembers previous tool outputs in the conversation.
    - **Semantic Routing**: Intelligently selects the best tool from 20+ specialized options (e.g., `GET_CROSSPLANE`, `GET_ISTIO`, `CHECK_WEBHOOKS`).
    - **Clean UI**: Hides internal reasoning complexity while showing clear tool execution status.

### Safety Guarantees

- **Read-Only**: Strictly non-mutating.
- **Secure Execution**: Validates all commands against a strict allowlist.
- **Privacy**: **Local Ops**: Embeddings are bundled. The inference model (~25MB) is downloaded once to your machine and runs **offline** thereafter.

## AI Provider Setup

OpsPilot supports multiple AI providers. Choose the one that works best for you:

### Supported Providers

| Provider | Type | API Key Required | Default Model |
|----------|------|------------------|---------------|
| **Ollama** | Local (Free) | No | llama3.1:8b |
| **OpenAI** | Cloud | Yes | gpt-4o |
| **Anthropic** | Cloud | Yes | claude-sonnet-4 |
| **Custom** | Any OpenAI-compatible | Optional | Configurable |

### Quick Setup

**Ollama (Local, Free):**
```bash
# macOS
brew install ollama && ollama serve

# Windows
winget install Ollama.Ollama && ollama serve

# Linux
curl -fsSL https://ollama.com/install.sh | sh && ollama serve
```

**OpenAI:**
1. Get your API key from [platform.openai.com](https://platform.openai.com)
2. Open AI Settings in OpsPilot and paste your key

**Anthropic:**
1. Get your API key from [console.anthropic.com](https://console.anthropic.com)
2. Open AI Settings in OpsPilot and paste your key

**Custom (vLLM, LM Studio, etc.):**
1. Enter your OpenAI-compatible endpoint URL
2. Add API key if required

### Status Indicators

The AI chat panel shows real-time connection status with automatic provider detection. Click the provider badge to access settings.

## Development Quickstart

```bash
git clone https://github.com/ankitjain91/opspilot.git
cd opspilot
npm install
npm run tauri dev
```

## Production Build

```bash
npm run tauri build
```

Artifacts appear in `src-tauri/target/release/bundle/`.

## Installation

### Download Binaries
Go to the [Releases](https://github.com/ankitjain91/opspilot/releases) page to download the latest installer for your OS:
-   **macOS**: Download the `.dmg` file.
-   **Windows**: Download the `.exe` or `.msi` file.
-   **Linux**: Download the `.AppImage` or `.deb`.

> **⚠️ Security & Permission Instructions**
>
> Since this is an open-source project (unsigned), you may need to approve the app manually:
>
> **macOS ("App is damaged" error):**
> 1. Open Terminal.
> 2. Run: `xattr -cr /Applications/OpsPilot.app`
> 3. Open the app normally.
>
> **Windows (SmartScreen warning):**
> 1. Click **More info**.
> 2. Click **Run anyway**.
>
> **Linux (.AppImage):**
> 1. Right-click -> Properties -> Permissions -> Allow executing file as program.
> 2. Or run: `chmod +x OpsPilot-*.AppImage`

### Build from Source

**Prerequisites:**
-   [Node.js](https://nodejs.org/) (v18+)
-   [Rust](https://www.rust-lang.org/tools/install) (latest stable)
-   [pnpm](https://pnpm.io/) (recommended) or npm/yarn

**Steps:**
1.  Clone the repository:
    ```bash
    git clone https://github.com/ankitjain91/opspilot.git
    cd opspilot
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Run in development mode:
    ```bash
    npm run tauri dev
    ```

<!-- Production build section replaced by consolidated sections above -->

## License

This project is licensed under the **Business Source License 1.1 (BSL)**.

-   **Non-Commercial Use**: You are free to copy, modify, and use the code for non-production or personal use.
-   **Commercial Use**: Production use requires a commercial license. Please contact the author for details.
-   **Open Source Conversion**: The code will convert to the **Apache License, Version 2.0** on **2029-12-02**.

See the [LICENSE](LICENSE) file for full details.
