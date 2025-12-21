# OpsPilot

**OpsPilot** is an intelligent Kubernetes management platform powered by **Claude Code**. It combines a high-performance Rust/Tauri frontend with Anthropic's Claude to provide autonomous troubleshooting, deep cluster insights, and GitHub code search integration.

## 🚀 Key Features

### 🤖 Claude Code Integration
OpsPilot uses **Claude Code** as its AI backbone - the same powerful coding agent from Anthropic. This means:
- **Autonomous Investigation**: Claude runs kubectl commands, analyzes logs, and follows diagnostic chains automatically
- **Read-Only Safety**: All cluster operations are read-only by default (no accidental deletes!)
- **Streaming UI**: Watch Claude think and execute in real-time with a transparent command log

### 🔗 GitHub MCP Integration (NEW!)
Connect your GitHub repos to let Claude search your source code when debugging K8s issues:
- **Search for error patterns** in your codebase
- **Read source files** to understand the code causing errors
- **Check recent commits** to correlate issues with deployments
- **Find related GitHub issues** for known bugs

Just add your GitHub Personal Access Token in Settings → GitHub Integration.

### ⚡ Performance
- **Tauri/Rust** frontend - near-native speed, low memory
- **Direct Kubernetes API** - no kubectl overhead for UI operations
- **Conversation persistence** - continue debugging across app restarts

### 🧠 Context-Aware Deep Dive
Open any resource (Pod, Deployment, Service) in the **Deep Dive Drawer**:
- AI is automatically locked to that specific resource
- Ask "why is this crashing?" - Claude knows which pod you mean
- View logs, events, YAML all in one place

### 🌐 vCluster Support
Create and manage virtual clusters directly from the UI.

### 🔒 Privacy & Safety
- **Read-only mode**: Claude cannot delete, apply, or edit resources
- **Local history**: Conversation stored in your browser only
- **Fine-grained GitHub tokens**: Read-only access to your repos

## 🆕 What's New in v0.2.37

- **GitHub MCP Integration**: Search your source code from the chat
- **"Find Related Code" Button**: One-click GitHub search after any investigation
- **Conversation Persistence**: Chat history survives app restarts (10 messages context)
- **Improved Settings UX**: Better token management UI

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    OpsPilot Desktop App                      │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │   Tauri/Rust    │    │         React Frontend          │ │
│  │   - K8s API     │◄──►│   - Dashboard                   │ │
│  │   - Window mgmt │    │   - Deep Dive Drawer            │ │
│  │   - File I/O    │    │   - AI Chat Panel               │ │
│  └─────────────────┘    └─────────────────────────────────┘ │
└───────────────────────────────┬─────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                Python Agent Server (Sidecar)                 │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │  Claude Code    │    │      MCP Servers                │ │
│  │  - Bash/kubectl │◄──►│   - GitHub (code search)        │ │
│  │  - Streaming    │    │   - Custom tools                │ │
│  │  - Tool safety  │    │                                 │ │
│  └─────────────────┘    └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## 🛠️ Prerequisites

- **Claude Code CLI** installed (`npm install -g @anthropic-ai/claude-code` or via Anthropic)
- **Node.js** (v18+)
- **Rust** (latest stable)
- **Python** (3.10+)
- **kubectl** in your PATH

## 📦 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/ankitjain91/opspilot.git
cd opspilot
npm install
```

### 2. Set Up Python Environment

```bash
cd python
pip install -r requirements.txt
cd ..
```

### 3. Run Development Server

```bash
npm run tauri dev
```

This starts both the Tauri app and the Python agent sidecar.

## ⚙️ Configuration

### Claude Code (Required)

OpsPilot requires Claude Code CLI to be installed and authenticated:

```bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Authenticate (opens browser)
claude login
```

Then in OpsPilot Settings, select **"Claude Code"** as your AI provider.

### GitHub Integration (Optional)

To enable code search during investigations:

1. Open **Settings** (gear icon)
2. Scroll to **GitHub Integration**
3. Create a [Fine-Grained Personal Access Token](https://github.com/settings/personal-access-tokens/new):
   - Permission: `Contents` → Read-only
   - Select repositories or "All repositories"
4. Paste token and click **Save**
5. Click **Test** to verify connection

Once connected, you'll see a **"Find related code"** button after each investigation.

### Knowledge Base (Optional)

OpsPilot includes 57+ Kubernetes troubleshooting patterns. To enable semantic search:

1. Install embedding model: `ollama pull nomic-embed-text`
2. Open Settings → Memory System
3. Click **Generate** to index the knowledge base

## 🎮 Usage

### Connecting to Clusters

- **Kubeconfig**: Browse to your `~/.kube/config`
- **Azure AKS**: Sign in with Azure to auto-discover clusters
- **vCluster**: Create virtual clusters from the Clusters tab

### AI Chat

Ask natural language questions:
- "Show me all failing pods"
- "Why is the auth-service crashing?"
- "What events happened in the last hour?"
- "Find pods with high restart counts"

Claude will:
1. Plan the investigation
2. Run kubectl commands
3. Analyze the output
4. Provide a clear summary

### Deep Dive Drawer

Click any resource → Opens context-locked chat:
- "Show me the logs" (knows which pod)
- "What events are related?" (knows the namespace)
- "Why is this pending?" (focuses on this specific resource)

### GitHub Code Search

After any investigation, click **"Find related code"** to:
- Search for error strings in your repos
- Find the source code causing exceptions
- Check who made recent changes

## 🔧 Development

### Build for Production

```bash
# Build the app
npm run tauri build

# Output in src-tauri/target/release/bundle/
```

### Project Structure

```
opspilot/
├── src/                    # React frontend
│   ├── components/
│   │   ├── ai/            # Chat panel, settings
│   │   ├── cluster/       # Deep dive drawer
│   │   └── dashboard/     # Main dashboard
├── src-tauri/             # Rust backend
│   └── src/
│       └── main.rs        # Tauri commands, K8s API
├── python/                # Agent server
│   └── agent_server/
│       ├── server.py      # FastAPI endpoints
│       └── claude_code_backend.py  # Claude Code integration
└── knowledge/             # K8s troubleshooting patterns
```

## 🤝 Contributing

We welcome contributions! Please see `CONTRIBUTING.md` for guidelines.

## 📄 License

MIT License. See `LICENSE` for details.
