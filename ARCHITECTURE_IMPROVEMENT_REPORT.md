# Architecture & Improvement Report

**Date:** December 14, 2025
**Project:** Lens Killer (OpsPilot)
**Status:** Alpha / Development

## 1. Executive Summary

The project is an AI-powered Kubernetes dashboard ("Lens Killer") that uses a **Hybrid Architecture**:
1.  **Frontend**: React (Vite) + Tailwind for the UI.
2.  **Core Backend**: Rust (Tauri) for system operations, K8s API interaction, and window management.
3.  **Intelligence Layer**: Python (FastAPI + LangGraph) running as a **Sidecar** binary.

**Current State:**
The system is functional. The Agent successfully runs via `npm run tauri dev`. Recent fixes stabilized the prompt formatting and startup crashes. However, technical debt exists in the persistence layer, type synchronization, and build optimizations.

---

## 2. Architecture Overview

### High-Level Diagram

```mermaid
graph TD
    User[User] --> UI[React Frontend]
    UI -- Commands/Events --> Rust[Rust Core (Tauri)]
    Rust -- Spawns/Manages --> Python[Python Sidecar (Agent Server)]
    
    subgraph "Python Agent (LangGraph)"
        API[FastAPI Server]
        Graph[LangGraph Workflow]
        Nodes[Nodes: Classifier, Supervisor, Worker]
        Tools[Tools: Kubectl, Triage]
    end
    
    Python -- "LLM Calls (Ollama/OpenAI)" --> LLM[LLM Provider]
    Python -- "Kubectl CLI" --> K8s[Kubernetes Cluster]
    Rust -- "Direct API" --> K8s
```

### Key Components

| Component | Tech Stack | Responsibility |
|-----------|------------|----------------|
| **Frontend** | React, TypeScript, Vite | UI, State Management, LLM Settings, Visualization. |
| **Rust Core** | Tauri, Rust | App Lifecycle, Sidecar Management, Direct K8s interactions (performance), File System. |
| **Agent Server** | Python 3.14, LangGraph, FastAPI | Reasoning, Planning, Complex Debugging, Tool Execution. |

---

## 3. Critical Improvements & Technical Debt

### 3.1 Persistence & State Management (High Priority)
*   **Current Status:** The agent uses `MemorySaver` for LangGraph state. This means conversation history and "learning" are **lost on restart**.
*   **Problem:** I reverted from `SqliteSaver` due to async incompatibility warnings.
*   **Recommended Fix:** Implement `AsyncSqliteSaver` properly using `aiosqlite`.
    *   **Action:** Add `aiosqlite` to `requirements.txt`.
    *   **Action:** In `server.py`, use `AsyncSqliteSaver.from_conn_string("sqlite+aiosqlite:///...")`.

### 3.2 Prompt Management (Medium Priority)
*   **Current Status:** Prompts are scattered. Some are in `python/agent_server/prompts/`, others were hardcoded strings in node files (e.g., `classifier.py`).
*   **Problem:** Hardcoded prompts are brittle (as seen with the `KeyError` bug) and hard to version/improve.
*   **Recommended Fix:** Centralize ALL prompts into the `python/agent_server/prompts/` directory. Use a strictly typed template system (e.g., Jinja2 or simple Python functions) that strictly validates inputs *before* formatting.

### 3.3 Type Synchronization (Medium Priority)
*   **Current Status:** Types like `LLMProvider` are defined in three places:
    1.  TypeScript (`types/ai.ts`)
    2.  Rust (`src-tauri/src/ai_local.rs`)
    3.  Python (`python/agent_server/models.py` implied)
*   **Problem:** Adding a provider (like 'groq') required editing 3-4 files manually.
*   **Recommended Fix:** While full generation is hard, strict validation at the boundaries (Rust <-> Python) is needed. Consider using a schema definition (like JSON Schema) to generate these types or enforce them in CI.

### 3.4 Build Optimization (Low Priority)
*   **Current Status:** `PyInstaller` bundles a full Python runtime. The binary is large (~50MB+ likely).
*   **Optimization:**
    *   Continue to refine `--exclude-module` in `build.py` (already done well).
    *   Consider **UV** or **Rye** for faster dependency resolution during build.
    *   verify `strip` usage on the binary (Linux/Mac) to reduce size.

---

## 4. Stability & Reliability Plan

### 4.1 Error Handling & Recovery
*   **Loop Detection:** The agent has loop detection in `verify_command_node`. This is good.
*   **Recommendation:** Enhance this by detecting "Semantic Loops" (e.g., repeatedly running `get pods` -> `get deployments` -> `get pods`).
*   **JSON Resilience:** I added `clean_json_response` and stricter parsing. We should move to **Structured Output** APIs (native JSON mode) for providers that support it (OpenAI, newer Ollama) instead of regex cleaning.

### 4.2 Testing Strategy
I have initialized a unit test suite in `python/tests/test_nodes_unit.py`.

*   **Goal:** 80% coverage on Logic Nodes (Classifier, Supervisor, Refiner).
*   **Next Steps:**
    1.  Add tests for `utils.py` (formatting, event emitting).
    2.  Add tests for `llm.py` (ensure fallback logic works).
    3.  Add **Integration Tests** that run the binary and check `/health`.

---

## 5. Timeline of Cleanups

| Phase | Task | Effort | Impact |
|-------|------|--------|--------|
| **1 (Done)** | Fix Prompt Formatting Bugs | Low | Critical (Stability) |
| **1 (Done)** | Unit Test Foundation | Low | High (Confidence) |
| **2 (Next)** | Centralize Prompts | Med | Med (Maintainability) |
| **2** | Restore SQLite Persistence | Med | High (UX) |
| **3** | Native JSON Output Support | High | High (Accuracy) |

## 6. Conclusion

The architecture is sound. The specific choice of using Python for the "Brain" allows leveraging the rich ecosystem of LangChain/LangGraph. The main friction point is the "Sidecar" nature (startup, builds, IPC).
By stabilizing the **Persistence** and **Testing**, this project can move from Alpha to a reliable tool.
