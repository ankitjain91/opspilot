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
    conversation_history: Array<{ role: string, content: string }>;
}

// =============================================================================
// PYTHON LANGGRAPH SERVER
// =============================================================================

import { invoke } from '@tauri-apps/api/core';
import { formatKubectlOutput } from './kubernetesFormatter';
import { DEFAULT_LLM_CONFIGS } from './constants';
import { LLMConfig } from '../../types/ai';
import {
    discoverClusterCapabilities,
    buildClusterContextString,
    getAIDrivenAlternatives,
    createAIInvestigationPlan
} from './aiDrivenUtils';

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

async function ensureAgentRunning(): Promise<boolean> {
    // First check if already running
    if (await checkPythonAgentAvailable()) {
        return true;
    }

    // Try to start it via Tauri command
    console.log('[AgentOrchestrator] Agent not available, attempting to start...');
    try {
        const result = await invoke('start_agent');
        console.log('[AgentOrchestrator] start_agent result:', result);

        // Wait for it to become available (up to 8 seconds)
        for (let i = 0; i < 16; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (await checkPythonAgentAvailable()) {
                console.log('[AgentOrchestrator] Agent started successfully after', (i + 1) * 500, 'ms');
                return true;
            }
            if (i % 4 === 3) {
                console.log('[AgentOrchestrator] Still waiting for agent...', (i + 1) * 500, 'ms');
            }
        }
        console.error('[AgentOrchestrator] Agent failed to become available after 8 seconds');
    } catch (e: any) {
        console.error('[AgentOrchestrator] Failed to start agent:', e?.message || e);
    }

    return false;
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
    mcpTools?: any[],
    initialHistory: Array<{ role: string, content: string }> = [],
    onPlanCreated?: (plan: any[], totalSteps: number) => void,
    onStepCompleted?: (step: number, planSummary: string) => void,
    onStepFailed?: (step: number, error: string) => void,
    onPlanComplete?: (totalSteps: number) => void
): Promise<string> {
    // Pre-flight check: ensure the Python agent is running (auto-start if needed)
    onProgress?.('🔍 Checking agent server...');
    const isAvailable = await ensureAgentRunning();
    if (!isAvailable) {
        throw new Error("❌ **Agent Server Unavailable**: The Python sidecar failed to start. Please restart the app and check the console for errors.");
    }

    onProgress?.('🧠 Reasoning...');

    // State for the agent loop
    let currentHistory: any[] = [];
    let currentToolOutput: any | null = null;

    // Safety break
    let loopCount = 0;
    const MAX_LOOPS = 10;

    while (loopCount < MAX_LOOPS) {
        loopCount++;

        const request: PythonAgentRequest & { mcp_tools?: any[], tool_output?: any, history: any[] } = {
            query,
            kube_context: kubeContext || '',
            llm_endpoint: llmEndpoint,
            llm_provider: llmProvider,
            llm_model: llmModel,
            executor_model: executorModel,
            conversation_history: initialHistory || [],
            mcp_tools: mcpTools || [],
            tool_output: currentToolOutput,
            history: currentHistory
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

            if (!response.body) throw new Error("No response body received");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let finalResponse = '';
            let toolCallRequest = null;
            let currentServerHistory = null;

            while (true) {
                let done: boolean;
                let value: Uint8Array | undefined;

                try {
                    const result = await reader.read();
                    done = result.done;
                    value = result.value;
                } catch (readError: any) {
                    // Stream read failed - could be network issue or server died
                    throw new Error(`Stream read failed: ${readError?.message || 'Connection interrupted'}`);
                }

                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const eventData = JSON.parse(line.slice(6));

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
                                        content: `Executing: \`${eventData.command}\``
                                    });
                                    break;
                                case 'command_output':
                                    // Auto-format kubectl outputs for better readability
                                    const rawOutput = eventData.error ? `Error: ${eventData.error}\nOutput: ${eventData.output}` : eventData.output;
                                    let formattedOutput = rawOutput;

                                    // Try to format kubectl output
                                    if (eventData.command && eventData.command.includes('kubectl') && !eventData.error) {
                                        const formatted = formatKubectlOutput(eventData.command, eventData.output);
                                        formattedOutput = formatted.markdown;
                                    }

                                    onStep?.({
                                        role: 'SCOUT',
                                        content: JSON.stringify({
                                            command: eventData.command,
                                            output: formattedOutput
                                        })
                                    });
                                    break;
                                case 'plan_created':
                                    onPlanCreated?.(eventData.plan, eventData.total_steps);
                                    break;
                                case 'step_completed':
                                    onStepCompleted?.(eventData.step, eventData.plan_summary);
                                    break;
                                case 'step_failed':
                                    onStepFailed?.(eventData.step, eventData.error);
                                    break;
                                case 'plan_complete':
                                    onPlanComplete?.(eventData.total_steps);
                                    break;
                                case 'tool_call_request':
                                    toolCallRequest = eventData;
                                    currentServerHistory = eventData.history;
                                    onStep?.({
                                        role: 'SPECIALIST',
                                        content: `**Using Tool**: \`${eventData.tool}\`\nArguments: ${JSON.stringify(eventData.args)}`
                                    });
                                    break;
                                case 'done':
                                    if (eventData.final_response) {
                                        finalResponse = eventData.final_response;
                                    }
                                    break;
                                case 'error':
                                    // Agent server sent an explicit error - propagate it
                                    const agentError = new Error(`Agent Server: ${eventData.message}`);
                                    (agentError as any).isAgentError = true;
                                    throw agentError;
                            }
                        } catch (e: any) {
                            // Only ignore JSON parse errors, not agent errors
                            if (e?.isAgentError) {
                                throw e;
                            }
                            // Ignore parse errors for incomplete SSE chunks (common with streaming)
                        }
                    }
                }
            }

            // If we got a tool call request, execute it and LOOP
            if (toolCallRequest) {
                const requestedTool = toolCallRequest.tool; // e.g. "github__get_issue"
                const toolDef = mcpTools?.find((t: any) => t.name === requestedTool);

                let toolResult = "";
                let toolError = null;

                if (!toolDef) {
                    toolResult = "";
                    toolError = `Tool '${requestedTool}' not found in available tools list.`;
                } else {
                    try {
                        onProgress?.(`🛠️ Running ${toolDef.original_name}...`);
                        const result = await invoke('call_mcp_tool', {
                            serverName: toolDef.server,
                            toolName: toolDef.original_name,
                            args: toolCallRequest.args
                        });

                        // MCP Check: The result object usually has { content: [ { type: 'text', text: '...' } ] }
                        // We need to verify if 'call_mcp_tool' returns the raw value or wrapped
                        // The Rust 'call_mcp_tool' returns Result<Value, String>.
                        // Assuming it returns the MCP 'CallToolResult' object.

                        toolResult = JSON.stringify(result, null, 2);

                        onStep?.({
                            role: 'SPECIALIST',
                            content: `**Tool Result**: \n\`\`\`json\n${toolResult.substring(0, 500)}${toolResult.length > 500 ? '...' : ''}\n\`\`\``
                        });

                    } catch (e: any) {
                        toolResult = "";
                        toolError = String(e);
                        onStep?.({
                            role: 'SPECIALIST',
                            content: `**Tool Failed**: ${toolError}`
                        });
                    }
                }

                // Prepare next iteration
                currentHistory = currentServerHistory || currentHistory;
                currentToolOutput = {
                    tool: requestedTool,
                    output: toolResult,
                    error: toolError
                };

                // CONTINUE LOOP
                continue;
            }

            // If no tool call, we are done
            return finalResponse || "Agent completed without a final response.";

        } catch (error: any) {
            if (error.name === 'AbortError') throw new Error("Request cancelled by user");

            // Should we retry on network error? Probably not for now.
            const errorMsg = error.message?.toLowerCase() || '';
            if (errorMsg.includes('fetch failed') || errorMsg.includes('econnrefused')) {
                throw new Error("❌ **Agent Server Unreachable**: The Python sidecar is not running.");
            }
            throw error;
        }
    }

    return "Agent loop limit reached (max 10 turns). Stopping to prevent infinite loops.";
}

// =============================================================================
// CONFIGURATION MANAGEMENT - NO HARDCODED DEFAULTS
// =============================================================================

/**
 * Load LLM configuration from user settings
 * Falls back to DEFAULT_LLM_CONFIGS only if user hasn't configured
 */
async function loadLLMConfiguration(): Promise<LLMConfig> {
    try {
        // Try to load from user settings file
        const userConfig = await invoke<LLMConfig | null>('load_llm_config');
        if (userConfig) {
            console.log('[LLM Config] Loaded user configuration:', userConfig.provider, userConfig.model);
            return userConfig;
        }
    } catch (e) {
        console.warn('[LLM Config] Failed to load user config:', e);
    }

    // Check if Ollama is available and use its default
    try {
        const ollamaStatus = await invoke<any>('check_ollama_status');
        if (ollamaStatus.ollama_running && ollamaStatus.available_models?.length > 0) {
            console.log('[LLM Config] Using Ollama with available models:', ollamaStatus.available_models);
            return {
                ...DEFAULT_LLM_CONFIGS.ollama,
                model: ollamaStatus.available_models[0], // Use first available model
                executor_model: ollamaStatus.available_models.length > 1 ? ollamaStatus.available_models[1] : null
            };
        }
    } catch (e) {
        console.warn('[LLM Config] Ollama check failed:', e);
    }

    // Last resort: use Ollama defaults but warn user
    console.warn('[LLM Config] Using default Ollama configuration - please configure LLM settings');
    return DEFAULT_LLM_CONFIGS.ollama;
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
    mcpTools?: any[],
    onPlanCreated?: (plan: any[], totalSteps: number) => void,
    onStepCompleted?: (step: number, planSummary: string) => void,
    onStepFailed?: (step: number, error: string) => void,
    onPlanComplete?: (totalSteps: number) => void
): Promise<string> {

    try {
        // Load configuration from settings - NO HARDCODED DEFAULTS
        const config = await loadLLMConfiguration();

        // Use provided config or loaded config (fail if neither available)
        const endpoint = llmConfig?.endpoint || config.base_url;
        const provider = llmConfig?.provider || config.provider;
        const model = llmConfig?.model || config.model;
        const executorModel = llmConfig?.executor_model || config.executor_model || model;

        if (!endpoint || !model) {
            throw new Error('LLM configuration required. Please configure LLM settings first.');
        }

        return await runPythonAgent(
            userGoal,
            kubeContext || '',
            endpoint,
            provider,
            model,
            executorModel,
            onProgress,
            onStep,
            abortSignal,
            mcpTools,
            _initialHistory || [],
            onPlanCreated,
            onStepCompleted,
            onStepFailed,
            onPlanComplete
        );


    } catch (error: any) {
        if (error.message === "Request cancelled by user") {
            throw error;
        }
        console.error('Python Agent Fatal Error:', error);
        throw new Error(`Agent Failed: ${error.message}`);
    }
}
