/**
 * useClusterChat - Core chat state management hook
 * Extracts chat session state from ClusterChatPanel for better modularity
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { LLMConfig, LLMStatus } from '../../../types/ai';
import { loadLLMConfig } from '../utils';
import { AgentPhase, CommandExecution } from '../chat/StreamingProgressCard';

// Message types
export interface ChatMessage {
    role: 'user' | 'assistant' | 'tool' | 'claude-code';
    content: string;
    toolName?: string;
    command?: string;
    isActivity?: boolean;
    isStreaming?: boolean;
}

export interface InvestigationProgressState {
    iteration: number;
    maxIterations: number;
    phase: string;
    confidence: { level: string; score: number };
    hypotheses: Array<{ id: string; description: string; status: string }>;
    toolsExecuted: number;
    usefulEvidence: number;
}

export interface ApprovalContextState {
    command?: string;
    reason?: string;
    risk?: string;
    impact?: string;
}

export interface GoalVerificationState {
    met: boolean;
    reason: string;
}

export interface ExtendedModeState {
    preferred_checks?: string[];
    prefer_mcp_tools?: boolean;
}

// Helper to group messages into interactions - memoizable
export function groupMessages(history: ChatMessage[]) {
    const groups: any[] = [];
    let currentGroup: any = null;

    // Filter function to hide verbose internal reasoning
    const shouldShowAsStep = (msg: ChatMessage) => {
        // Always show tool executions (actual commands)
        if (msg.role === 'tool') return true;

        // For assistant messages, filter out internal reasoning
        if (msg.role === 'assistant') {
            const content = msg.content || '';
            // Hide verbose internal states
            if (content.includes('PLANNING:') ||
                content.includes('EXECUTING:') ||
                content.includes('REASONING CHAIN') ||
                content.includes('DONE') ||
                content.includes('VERIFIED:') ||
                content.includes('CONTINUE:') ||
                content.includes('SOLVED:') ||
                content.includes('WARN')) {
                return false;
            }
            // Show meaningful thinking/investigation messages
            return msg.isActivity ||
                content.includes('🧠 Thinking') ||
                content.includes('🧠 Supervisor') ||
                content.includes('🔄 Investigating') ||
                content.includes('Continuing investigation');
        }
        return false;
    };

    history.forEach((msg) => {
        if (msg.role === 'user') {
            if (currentGroup) groups.push(currentGroup);
            currentGroup = { type: 'interaction', user: msg, steps: [], answer: null };
        } else if (shouldShowAsStep(msg)) {
            if (currentGroup) {
                currentGroup.steps.push(msg);
            } else {
                if (groups.length === 0 || groups[groups.length - 1].type !== 'system_steps') {
                    groups.push({ type: 'system_steps', steps: [msg] });
                } else {
                    groups[groups.length - 1].steps.push(msg);
                }
            }
        } else if (msg.role === 'assistant') {
            if (currentGroup && !currentGroup.answer) {
                currentGroup.answer = msg;
            } else {
                groups.push({ type: 'raw', msg });
            }
        } else {
            groups.push({ type: 'raw', msg });
        }
    });

    if (currentGroup) groups.push(currentGroup);
    return groups;
}

export interface UseClusterChatOptions {
    storageKey: string;
    resourceContext?: { kind: string; name: string; namespace: string };
}

export function useClusterChat(options: UseClusterChatOptions) {
    const { storageKey, resourceContext } = options;

    // Core chat state
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>(() => {
        try {
            const saved = localStorage.getItem(storageKey);
            if (!saved) return [];
            const parsed = JSON.parse(saved);
            return parsed.map((msg: any) => ({ ...msg, isStreaming: false }));
        } catch (e) {
            console.warn('Failed to load chat history:', e);
            return [];
        }
    });

    const [userInput, setUserInput] = useState("");
    const [llmLoading, setLlmLoading] = useState(false);
    const [currentActivity, setCurrentActivity] = useState("Analyzing cluster data...");
    const [suggestedActions, setSuggestedActions] = useState<string[]>([]);

    // Memoized grouped history - prevents re-computation on every render
    const groupedHistory = useMemo(() => groupMessages(chatHistory), [chatHistory]);

    // Thread ID for session persistence
    const [threadId, setThreadId] = useState<string>(() => {
        const saved = localStorage.getItem('agent_thread_id');
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return saved || crypto.randomUUID();
        }
        return saved || 'session-' + Math.random().toString(36).substr(2, 9);
    });

    // Investigation state
    const [investigationProgress, setInvestigationProgress] = useState<InvestigationProgressState | null>(null);
    const [phaseTimeline, setPhaseTimeline] = useState<Array<{ name: string; timestamp?: string }>>([]);
    const [rankedHypotheses, setRankedHypotheses] = useState<Array<{ title: string; confidence?: number }>>([]);
    const [approvalContext, setApprovalContext] = useState<ApprovalContextState | null>(null);
    const [coverageGaps, setCoverageGaps] = useState<string[]>([]);
    const [agentHints, setAgentHints] = useState<string[]>([]);
    const [goalVerification, setGoalVerification] = useState<GoalVerificationState | null>(null);
    const [extendedMode, setExtendedMode] = useState<ExtendedModeState | null>(null);
    const [autoExtendEnabled, setAutoExtendEnabled] = useState(true);

    // Streaming state
    const [streamingPhase, setStreamingPhase] = useState<AgentPhase | null>(null);
    const commandHistoryRef = useRef<CommandExecution[]>([]);
    const [planTotalSteps, setPlanTotalSteps] = useState(0);
    const [currentPlan, setCurrentPlan] = useState<any[] | null>(null);

    // Cancellation
    const abortControllerRef = useRef<AbortController | null>(null);
    const [isCancelling, setIsCancelling] = useState(false);

    // Persist thread_id
    useEffect(() => {
        if (threadId) {
            localStorage.setItem('agent_thread_id', threadId);
        }
    }, [threadId]);

    // Persist chat history (limited to last 50 messages)
    useEffect(() => {
        try {
            const historyToSave = chatHistory.slice(-50);
            localStorage.setItem(storageKey, JSON.stringify(historyToSave));
        } catch (e) {
            console.warn('Failed to save chat history:', e);
        }
    }, [chatHistory, storageKey]);

    // Clear history handler
    const clearHistory = useCallback(() => {
        setChatHistory([]);
        setInvestigationProgress(null);
        setPhaseTimeline([]);
        setRankedHypotheses([]);
        setApprovalContext(null);
        setGoalVerification(null);
        setExtendedMode(null);
        setCoverageGaps([]);
        setAgentHints([]);
        setCurrentPlan(null);
        setPlanTotalSteps(0);

        // Rotate thread_id
        let newThreadId = '';
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            newThreadId = crypto.randomUUID();
        } else {
            newThreadId = 'session-' + Math.random().toString(36).substr(2, 9);
        }
        setThreadId(newThreadId);
        localStorage.setItem('agent_thread_id', newThreadId);
    }, []);

    // Cancel analysis handler
    const cancelAnalysis = useCallback(() => {
        setIsCancelling(true);
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        setChatHistory(prev => [...prev, {
            role: 'assistant',
            content: '⚠️ Analysis cancelled by user.'
        }]);
        setLlmLoading(false);
        setIsCancelling(false);
        setCurrentActivity("");
    }, []);

    // Add message to history
    const addMessage = useCallback((message: ChatMessage) => {
        setChatHistory(prev => [...prev, message]);
    }, []);

    // Update last message (for streaming consolidation)
    const updateLastMessage = useCallback((updater: (msg: ChatMessage) => ChatMessage) => {
        setChatHistory(prev => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            return [...prev.slice(0, -1), updater(last)];
        });
    }, []);

    return {
        // Core state
        chatHistory,
        setChatHistory,
        userInput,
        setUserInput,
        llmLoading,
        setLlmLoading,
        currentActivity,
        setCurrentActivity,
        suggestedActions,
        setSuggestedActions,
        groupedHistory,

        // Session
        threadId,
        setThreadId,

        // Investigation state
        investigationProgress,
        setInvestigationProgress,
        phaseTimeline,
        setPhaseTimeline,
        rankedHypotheses,
        setRankedHypotheses,
        approvalContext,
        setApprovalContext,
        coverageGaps,
        setCoverageGaps,
        agentHints,
        setAgentHints,
        goalVerification,
        setGoalVerification,
        extendedMode,
        setExtendedMode,
        autoExtendEnabled,
        setAutoExtendEnabled,

        // Streaming
        streamingPhase,
        setStreamingPhase,
        commandHistoryRef,
        planTotalSteps,
        setPlanTotalSteps,
        currentPlan,
        setCurrentPlan,

        // Cancellation
        abortControllerRef,
        isCancelling,
        setIsCancelling,

        // Actions
        clearHistory,
        cancelAnalysis,
        addMessage,
        updateLastMessage,
    };
}
