/**
 * useAgentStream - Clean SSE consumption for agent progress
 *
 * Converts noisy backend events into clean phase updates:
 * - Throttles rapid-fire updates (max 1 per 500ms)
 * - Batches similar events (e.g., multiple "progress" events)
 * - Maps internal events to user-friendly phases
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { AgentPhase, CommandExecution } from './chat/StreamingProgressCard';
import { getAgentServerUrl } from '../../utils/config';

interface SSEEvent {
    type: string;
    data?: any;
    message?: string;
}

export function useAgentStream(queryId: string | null) {
    const [currentPhase, setCurrentPhase] = useState<AgentPhase | null>(null);
    const [finalResponse, setFinalResponse] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const eventSourceRef = useRef<EventSource | null>(null);
    const lastUpdateRef = useRef<number>(0);
    const pendingUpdateRef = useRef<AgentPhase | null>(null);
    const throttleTimerRef = useRef<number | null>(null);
    const commandHistoryRef = useRef<CommandExecution[]>([]); // Track all commands

    // Throttle phase updates to prevent UI jank
    const updatePhase = useCallback((newPhase: AgentPhase) => {
        const now = Date.now();
        const timeSinceLastUpdate = now - lastUpdateRef.current;

        if (timeSinceLastUpdate >= 500) {
            // Immediate update if enough time has passed
            setCurrentPhase(newPhase);
            lastUpdateRef.current = now;
            pendingUpdateRef.current = null;
        } else {
            // Queue update for later
            pendingUpdateRef.current = newPhase;

            // Clear existing timer
            if (throttleTimerRef.current) {
                clearTimeout(throttleTimerRef.current);
            }

            // Schedule delayed update
            throttleTimerRef.current = window.setTimeout(() => {
                if (pendingUpdateRef.current) {
                    setCurrentPhase(pendingUpdateRef.current);
                    lastUpdateRef.current = Date.now();
                    pendingUpdateRef.current = null;
                }
            }, 500 - timeSinceLastUpdate);
        }
    }, []);

    // Track command execution and generate summary
    const handleCommandEvent = useCallback((event: SSEEvent) => {
        const { type, data } = event;

        if (type === 'command_start' || type === 'executing') {
            // Command started
            const cmd: CommandExecution = {
                command: data?.command || data?.tool || 'Unknown command',
                status: 'running',
                timestamp: Date.now()
            };
            commandHistoryRef.current.push(cmd);
        } else if (type === 'command_complete' || type === 'tool_result') {
            // Command completed - update the last command
            const lastCmd = commandHistoryRef.current[commandHistoryRef.current.length - 1];
            if (lastCmd && lastCmd.status === 'running') {
                lastCmd.status = data?.error ? 'error' : 'success';
                lastCmd.output = data?.output || data?.result;
                lastCmd.summary = data?.summary || generateSummaryFromOutput(data?.output, data?.command);
            }
        }
    }, []);

    // Generate human-readable summary from command output
    const generateSummaryFromOutput = (output: string | undefined, command: string | undefined): string => {
        if (!output) return 'No output';

        // Try to extract meaningful info
        const lines = output.split('\n');

        // Count resources (kubectl get often shows tables)
        if (command?.includes('get')) {
            const dataLines = lines.filter(l => l.trim() && !l.startsWith('NAME') && !l.startsWith('NAMESPACE'));
            if (dataLines.length > 0) {
                return `Found ${dataLines.length} resource(s)`;
            }
        }

        // Look for error indicators
        if (output.toLowerCase().includes('error') || output.toLowerCase().includes('failed')) {
            return 'Command failed - see raw output';
        }

        // Look for status indicators
        if (output.includes('CrashLoopBackOff')) {
            const count = (output.match(/CrashLoopBackOff/g) || []).length;
            return `Found ${count} pod(s) in CrashLoopBackOff`;
        }

        // Default: first non-empty line
        const firstLine = lines.find(l => l.trim());
        return firstLine ? firstLine.substring(0, 80) : 'Command executed';
    };

    // Map backend event types to user-friendly phases
    const eventToPhase = useCallback((event: SSEEvent): AgentPhase | null => {
        const { type, data, message } = event;

        // Track commands
        if (['command_start', 'executing', 'command_complete', 'tool_result'].includes(type)) {
            handleCommandEvent(event);
        }

        switch (type) {
            case 'planning':
            case 'supervisor':
                return {
                    phase: 'planning',
                    message: message || data?.message || 'Creating investigation plan...',
                    commandHistory: commandHistoryRef.current
                };

            case 'executing':
            case 'tool_call':
            case 'command':
            case 'command_start':
                return {
                    phase: 'executing',
                    message: message || data?.message || 'Executing kubectl commands...',
                    currentStep: data?.command || data?.tool,
                    commandHistory: commandHistoryRef.current
                };

            case 'command_complete':
            case 'tool_result':
                return {
                    phase: 'executing',
                    message: 'Executing kubectl commands...',
                    commandHistory: commandHistoryRef.current
                };

            case 'analyzing':
            case 'reflection':
            case 'synthesizing':
                return {
                    phase: 'analyzing',
                    message: message || data?.message || 'Analyzing results...',
                    commandHistory: commandHistoryRef.current
                };

            case 'kb_search':
                // Knowledge base search event
                const kbMessage = data?.has_results
                    ? `📚 Found ${data.results_found} KB entries for: "${data.query}"`
                    : `📚 No KB entries found for: "${data.query}"`;
                return {
                    phase: 'analyzing',
                    message: kbMessage,
                    commandHistory: commandHistoryRef.current
                };

            case 'plan_decision':
                // Supervisor plan decision event
                const planMsg = `🧠 Plan: ${data?.action} (confidence: ${(data?.confidence * 100 || 0).toFixed(0)}%) using ${data?.model_used || 'LLM'}`;
                return {
                    phase: 'analyzing',
                    message: planMsg,
                    commandHistory: commandHistoryRef.current
                };

            case 'plan_progress':
                // Plan execution with step counts
                return {
                    phase: 'executing',
                    message: 'Executing investigation plan',
                    stepsCompleted: data?.completed || 0,
                    totalSteps: data?.total || 1,
                    commandHistory: commandHistoryRef.current
                };

            case 'done':
                return {
                    phase: 'complete',
                    message: 'Investigation complete',
                    commandHistory: commandHistoryRef.current,
                    suggestions: data?.suggested_next_steps || []
                };

            case 'error':
                return {
                    phase: 'error',
                    message: message || data?.message || 'An error occurred',
                    commandHistory: commandHistoryRef.current
                };

            // Progress events - show useful updates to user
            case 'progress': {
                const progressMsg = message || data?.message || '';
                // Determine phase from message content
                let phase: 'planning' | 'executing' | 'analyzing' = 'analyzing';
                const lowerMsg = progressMsg.toLowerCase();
                if (lowerMsg.includes('brain') || lowerMsg.includes('reasoning') || lowerMsg.includes('planner') || lowerMsg.includes('supervisor')) {
                    phase = 'planning';
                } else if (lowerMsg.includes('executing') || lowerMsg.includes('python') || lowerMsg.includes('running') || lowerMsg.includes('kubectl')) {
                    phase = 'executing';
                }
                return {
                    phase,
                    message: progressMsg,
                    commandHistory: commandHistoryRef.current
                };
            }

            // Ignore noisy internal events
            case 'debug':
            case 'internal':
                return null;

            default:
                return null;
        }
    }, [handleCommandEvent]);

    useEffect(() => {
        if (!queryId) {
            return;
        }

        // Reset command history for new query
        commandHistoryRef.current = [];

        // Connect to agent SSE stream
        const eventSource = new EventSource(`${getAgentServerUrl()}/analyze?query_id=${queryId}`);
        eventSourceRef.current = eventSource;

        eventSource.onmessage = (event) => {
            try {
                const parsed = JSON.parse(event.data);

                // Handle final response
                if (parsed.type === 'done' && parsed.final_response) {
                    setFinalResponse(parsed.final_response);
                    updatePhase({
                        phase: 'complete',
                        message: 'Investigation complete'
                    });
                    return;
                }

                // Handle error
                if (parsed.type === 'error') {
                    setError(parsed.message || 'Unknown error');
                    updatePhase({
                        phase: 'error',
                        message: parsed.message || 'An error occurred'
                    });
                    return;
                }

                // Map event to phase
                const phase = eventToPhase(parsed);
                if (phase) {
                    updatePhase(phase);
                }
            } catch (err) {
                console.error('[useAgentStream] Failed to parse SSE event:', err);
            }
        };

        eventSource.onerror = (err) => {
            console.error('[useAgentStream] SSE connection error:', err);
            setError('Lost connection to agent');
            updatePhase({
                phase: 'error',
                message: 'Lost connection to agent'
            });
        };

        // Cleanup
        return () => {
            eventSource.close();
            if (throttleTimerRef.current) {
                clearTimeout(throttleTimerRef.current);
            }
        };
    }, [queryId, updatePhase, eventToPhase]);

    return {
        currentPhase,
        finalResponse,
        error,
        isStreaming: currentPhase !== null && currentPhase.phase !== 'complete' && currentPhase.phase !== 'error'
    };
}
