import { LLMConfig } from '../../types/ai';

// Default LLM configuration - Claude Code only
export const DEFAULT_LLM_CONFIG: LLMConfig = {
    provider: 'claude-code',
    api_key: null,
    base_url: '',
    model: 'claude-code',
    executor_model: null,
    embedding_model: 'nomic-embed-text',
    embedding_endpoint: null,
    temperature: 0.2,
    max_tokens: 8192,
};
