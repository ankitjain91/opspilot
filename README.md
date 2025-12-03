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

## AI Debugging Assistant

OpsPilot includes two AI assistants, both operating in strictly **READ-ONLY** mode:

### Cluster-Wide AI Chat (Global)

Access from anywhere via the floating purple button in the bottom-right corner. This assistant can:
- Analyze cluster-wide health across all namespaces
- Find crashlooping pods, unhealthy deployments, and resource issues
- Investigate events, logs, and resource usage cluster-wide
- Correlate issues across related resources

**Cluster-Wide Tools:**

| Tool | Purpose |
|------|---------|
| `CLUSTER_HEALTH` | Overall cluster health summary |
| `GET_EVENTS [namespace]` | Cluster or namespace events |
| `LIST_PODS [namespace]` | List pods across namespaces |
| `LIST_DEPLOYMENTS [namespace]` | List deployments |
| `LIST_SERVICES [namespace]` | List services |
| `DESCRIBE <kind> <ns> <name>` | Get resource YAML details |
| `GET_LOGS <ns> <pod> [container]` | Get pod logs |
| `TOP_PODS [namespace]` | Pod resource usage |
| `FIND_ISSUES` | Find all problematic resources |

### Resource-Specific AI Chat

Open from any resource's detail panel for context-aware debugging:

**Resource Tools:**

| Tool | Purpose |
|------|---------|
| `DESCRIBE` | YAML manifest excerpt |
| `EVENTS` | Resource events (warnings highlighted) |
| `LOGS [container]` | Recent pod logs |
| `LOGS_PREVIOUS [container]` | Previous instance logs for crash diagnostics |
| `RELATED_PODS` | Pod health in same namespace |
| `PARENT_DETAILS` | Owner controller details |
| `NETWORK_CHECK` | Service/Endpoints status |
| `RESOURCE_USAGE` | CPU & memory snapshot |
| `NODE_INFO` | Node details for scheduled pods |
| `STORAGE_CHECK` | PVC presence and status |

### Safety Guarantees

- Never emits mutating commands (`apply`, `delete`, `patch`, `scale`, `rollout`)
- Sanitizes container names and validates against actual pod containers
- Explicit guidance when issues are detected
- All tools are read-only with no cluster mutations

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

### NPM (Experimental)
```bash
npm install -g opspilot
opspilot
```

### Download Binaries
Go to the [Releases](https://github.com/ankitjain91/opspilot/releases) page to download the latest installer for your OS:
-   **macOS**: Download the `.dmg` file.
-   **Windows**: Download the `.exe` or `.msi` file.

> **Note on Security Warnings**:
> Since this is an open-source project not signed by Apple/Microsoft, you may see a security warning when installing.
>
> -   **macOS**: If you see "App cannot be opened because the developer cannot be verified", **Right-Click** the app -> Select **Open** -> Click **Open** again.
> -   **Windows**: If you see "Windows protected your PC", click **More info** -> **Run anyway**.

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
