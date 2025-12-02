# OpsPilot

A high-performance, beautiful Kubernetes IDE built with Tauri, React, and TypeScript. Designed to be a faster, cleaner alternative to existing tools.

![License](https://img.shields.io/badge/license-BSL%201.1-blue)

## Features

- 🚀 **Blazing Fast**: Built with Rust + Tauri for native performance.
- ✨ **Modern UI**: Sleek, dark-themed interface with crisp readable panels.
- ☸️ **Kubernetes Native**: Read-only inspection of Pods, Deployments, Services, Nodes, PVCs, and more.
- 🤖 **Autonomous AI Investigator**: Local LLM (Ollama) powered, read-only incident analysis loop that forms hypotheses, gathers evidence with safe tools, and refines conclusions.
- 🛡️ **Safe Tooling & Syntax Validation**: Strict separation of tool syntax errors vs real resource issues; container name sanitization; guardrails prevent mutation commands.
- 📑 **Structured Logs & Events Panel**: Fast access to pod logs (with container validation) and categorized events (warnings vs normal).
- 📈 **Live Metrics**: Lightweight periodic CPU and memory charts for Pods and Nodes.
- 🐚 **Integrated Exec Terminal**: Direct ephemeral shell into pod containers (read-only interaction with running processes; no cluster mutations).
- 🔍 **Parent / Related Resource Discovery**: Owner references, related pods, storage and network checks.
- 🧪 **Previous Crash Log Access**: Rapid guidance for investigating CrashLoopBackOff via LOGS_PREVIOUS.
- 🧩 **Ollama Status Badge & Setup Drawer**: Inline badge shows Connected / Unreachable / Model Missing with one-click setup instructions.

> Note: The earlier visual topology graph has been removed per user request to streamline performance and focus on investigative workflows.

## AI Debugging Assistant

The AI Assistant operates in a strictly **READ-ONLY** autonomous investigation mode:

1. Summarizes current resource state.
2. Generates ranked, evidence-backed hypotheses.
3. Requests more data via safe tools (`TOOL: LOGS`, `TOOL: EVENTS`, `TOOL: DESCRIBE`, etc.).
4. Iteratively refines until high-confidence or ambiguity declared.

### Safety Guarantees

- Never emits mutating commands (`apply`, `delete`, `patch`, `scale`, `rollout`).
- Distinguishes: **TOOL SYNTAX ERROR** (your invocation mistake) vs **RESOURCE ERROR** (actual cluster condition).
- Sanitizes container names (removes `[]"'` and rejects names not belonging to the current pod).
- Explicit guidance when wrong container selected (lists valid containers and correction example).
- Does not self-terminate (no misleading "depth reached" messages).

### Available Tools (All Read-Only)

| Tool | Purpose |
|------|---------|
| `DESCRIBE` | YAML manifest excerpt (truncated for UI) |
| `EVENTS` | All events grouped (Warnings highlighted) |
| `LOGS [container]` | Recent pod logs (auto tail + error line count) |
| `LOGS_PREVIOUS [container]` | Previous instance logs for crash diagnostics |
| `RELATED_PODS` | Pod health snapshot in same namespace |
| `PARENT_DETAILS` | Owner controller YAML excerpt |
| `NETWORK_CHECK` | Service / Endpoints presence or pod-related services |
| `RESOURCE_USAGE` | CPU & memory snapshot (if supported) |
| `LIST_RESOURCES <kind>` | Names of resources of given kind in namespace |
| `DESCRIBE_ANY <kind> <name>` | YAML excerpt for any namespaced resource |
| `NODE_INFO` | Node details for scheduled pods |
| `STORAGE_CHECK` | PVC presence and status overview |

### Using the Chat

Open the AI Chat from a resource panel and ask:

```
Why is this pod restarting?
Compare this deployment to others.
Check logs for readiness probe failures.
```

The assistant will autonomously pull events/logs/describe output and display its reasoning in structured sections: SUMMARY, HYPOTHESES, EVIDENCE, NEXT STEPS, MISSING DATA.

### Ollama Integration

Local LLM responses use Ollama. The badge states:

- `Connected`: LLM reachable and responding.
- `Model Missing`: Ollama running but requested model not pulled.
- `Unreachable`: Ollama daemon not started.
- `Unknown`: No request attempted yet.

Open the setup drawer via badge click for macOS commands:

```bash
brew install ollama
ollama serve
ollama pull llama3.1:8b
# Alternative installer:
curl -fsSL https://ollama.com/install.sh | sh
```

Verify and test:

```bash
ollama list
ollama run llama3.1:8b
```

On first successful response the status flips to `Connected` and clears previous error detail.

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
