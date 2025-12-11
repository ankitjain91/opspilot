/**
 * Agent Orchestrator - Wrapper for K8s Agent
 *
 * This module provides the interface between the UI (ClusterChatPanel)
 * and the agent backend.
 *
 * ARCHITECTURE CHANGE (Dec 2025):
 * Only the Python LangGraph backend is supported. The local TypeScript agent
 * has been removed to ensure consistent intelligence and avoid outdated fallbacks.
 */

// =============================================================================
// TYPES (Exported for UI compatibility)
// =============================================================================

export interface LLMOptions {
    temperature?: number;
    max_tokens?: number;
    model?: string;
    format?: string;
}

export interface AgentStep {
    role: 'SUPERVISOR' | 'SCOUT' | 'SPECIALIST' | 'USER';
    content: string;
}

interface PythonAgentRequest {
    query: string;
    kube_context: string;
    llm_endpoint: string;
    llm_provider: string;
    llm_model: string;
    executor_model: string;
}

// =============================================================================
// PYTHON LANGGRAPH SERVER
// =============================================================================

const PYTHON_AGENT_URL = 'http://127.0.0.1:8765';

async function checkPythonAgentAvailable(): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000);

        const response = await fetch(`${PYTHON_AGENT_URL}/health`, {
            method: 'GET',
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
        return response.ok;
    } catch {
        return false;
    }
}

async function runPythonAgent(
    query: string,
    kubeContext: string,
    llmEndpoint: string,
    llmProvider: string,
    llmModel: string,
    executorModel: string,
    onProgress?: (msg: string) => void,
    onStep?: (step: AgentStep) => void,
    abortSignal?: AbortSignal,
): Promise<string> {
    onProgress?.('🧠 Reasoning...');

    const request: PythonAgentRequest = {
        query,
        kube_context: kubeContext || '',
        llm_endpoint: llmEndpoint,
        llm_provider: llmProvider,
        llm_model: llmModel,
        executor_model: executorModel,
    };

    try {
        const response = await fetch(`${PYTHON_AGENT_URL}/analyze`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
            },
            body: JSON.stringify(request),
            signal: abortSignal,
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Python agent error (${response.status}): ${text}`);
        }

        if (!response.body) {
            throw new Error("No response body received from Python agent");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let finalResponse = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const eventData = JSON.parse(line.slice(6));

                        // Handle different event types
                        switch (eventData.type) {
                            case 'progress':
                                onProgress?.(eventData.message);
                                break;
                            case 'reflection':
                                onStep?.({
                                    role: eventData.assessment === 'PLANNING' ? 'SUPERVISOR' : 'SCOUT',
                                    content: `**${eventData.assessment}**: ${eventData.reasoning}`
                                });
                                break;
                            case 'command_selected':
                                onStep?.({
                                    role: 'SCOUT',
                                    // Just show the command initially
                                    content: `Executing: \`${eventData.command}\``
                                });
                                break;
                            case 'command_output':
                                // Update SCOUT step with actual output in JSON format expected by UI
                                onStep?.({
                                    role: 'SCOUT',
                                    content: JSON.stringify({
                                        command: eventData.command,
                                        output: eventData.error ? `Error: ${eventData.error}\nOutput: ${eventData.output}` : eventData.output
                                    })
                                });
                                break;
                            case 'done':
                                if (eventData.final_response) {
                                    finalResponse = eventData.final_response;
                                }
                                break;
                            case 'error':
                                throw new Error(eventData.message);
                        }
                    } catch (e) {
                        // Ignore parse errors for partial chunks
                    }
                }
            }
        }

        return finalResponse || "Agent completed without a final response.";

    } catch (error: any) {
        if (error.name === 'AbortError') {
            throw new Error("Request cancelled by user");
        }
        // Improve error message for connection failures
        if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
            throw new Error("❌ **Agent Server Unreachable**: Is the Python sidecar running?");
        }
        throw error;
    }
}

// =============================================================================
// LEGACY COMPATIBILITY LAYER
// Replaces runAgentLoop with direct Python calls
// =============================================================================

export async function runAgentLoop(
    userGoal: string,
    _llmExecutor: any, // Ignored
    _fastLlmExecutor: any, // Ignored
    onProgress?: (msg: string) => void,
    onStep?: (step: AgentStep) => void,
    _initialHistory?: any[], // Ignored
    abortSignal?: AbortSignal,
    kubeContext?: string,
    llmConfig?: { endpoint?: string; provider?: string; model?: string; executor_model?: string },
): Promise<string> {

    try {
        // Use provided config or safe defaults
        const endpoint = llmConfig?.endpoint || 'http://127.0.0.1:11434';
        const provider = llmConfig?.provider || 'ollama';
        const model = llmConfig?.model || 'opspilot-brain';
        const executorModel = llmConfig?.executor_model || 'k8s-cli';

        return await runPythonAgent(
            userGoal,
            kubeContext || '',
            endpoint,
            provider,
            model,
            executorModel,
            onProgress,
            onStep,
            abortSignal
        );


    } catch (error: any) {
        if (error.message === "Request cancelled by user") {
            throw error;
        }
        console.error('Python Agent Fatal Error:', error);
        throw new Error(`Agent Failed: ${error.message}`);
    }
}
