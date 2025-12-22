/**
 * useLLMConnection - LLM connection state management hook
 * Handles LLM status checking, config management, and MCP tools
 */

import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LLMConfig, LLMStatus } from '../../../types/ai';
import { loadLLMConfig } from '../utils';
import { registerMcpTools } from '../tools';
import { getAgentServerUrl } from '../../../utils/config';

export function useLLMConnection() {
    const [llmConfig, setLlmConfig] = useState<LLMConfig>(loadLLMConfig);
    const [llmStatus, setLlmStatus] = useState<LLMStatus | null>(null);
    const [checkingLLM, setCheckingLLM] = useState(true);
    const [githubConfigured, setGithubConfigured] = useState(false);

    // Embedding status for knowledge base
    const [embeddingStatus, setEmbeddingStatus] = useState<'loading' | 'ready' | 'error' | null>(null);
    const [embeddingMessage, setEmbeddingMessage] = useState('');

    // Check LLM Status
    const checkLLMStatus = useCallback(async () => {
        setCheckingLLM(true);
        try {
            const status = await invoke<LLMStatus>("check_llm_status", { config: llmConfig });
            setLlmStatus(status);
            setCheckingLLM(false);
        } catch (err) {
            setLlmStatus({
                connected: false,
                provider: llmConfig.provider,
                model: llmConfig.model,
                available_models: [],
                error: String(err),
            });
            setCheckingLLM(false);
        }
    }, [llmConfig]);

    // Fetch MCP tools
    const fetchMcpTools = useCallback(async () => {
        try {
            const tools = await invoke<any[]>("list_mcp_tools");
            registerMcpTools(tools);
        } catch (e) {
            console.error("Failed to list MCP tools:", e);
        }
    }, []);

    // Check GitHub configuration
    const checkGithubConfig = useCallback(async () => {
        try {
            const resp = await fetch(`${getAgentServerUrl()}/github-config`);
            if (resp.ok) {
                const data = await resp.json();
                setGithubConfigured(data.configured === true);
            }
        } catch {
            setGithubConfigured(false);
        }
    }, []);

    // Initialize on mount
    useEffect(() => {
        checkLLMStatus();
        fetchMcpTools();
        checkGithubConfig();
    }, [llmConfig, checkLLMStatus, fetchMcpTools, checkGithubConfig]);

    // Call LLM helper
    const callLLM = useCallback(async (
        prompt: string,
        systemPrompt: string,
        conversationHistory: Array<{ role: string; content: string }>,
        threadId: string,
        options?: { temperature?: number; max_tokens?: number; model?: string }
    ): Promise<string> => {
        const configWithOptions = options ? {
            ...llmConfig,
            temperature: options.temperature ?? llmConfig.temperature,
            max_tokens: options.max_tokens ?? llmConfig.max_tokens,
            model: options.model ?? llmConfig.model,
        } : llmConfig;

        return await invoke<string>("call_llm", {
            config: configWithOptions,
            prompt,
            systemPrompt,
            conversationHistory,
            thread_id: threadId,
        });
    }, [llmConfig]);

    return {
        // Config
        llmConfig,
        setLlmConfig,

        // Status
        llmStatus,
        setLlmStatus,
        checkingLLM,
        setCheckingLLM,

        // GitHub
        githubConfigured,
        setGithubConfigured,
        checkGithubConfig,

        // Embedding
        embeddingStatus,
        setEmbeddingStatus,
        embeddingMessage,
        setEmbeddingMessage,

        // Actions
        checkLLMStatus,
        fetchMcpTools,
        callLLM,
    };
}
