import { LLMProvider, LLMConfig } from '../../types/ai';

// Default LLM configurations
// executor_model is optional - when null, uses the main (Brain) model for both roles
export const DEFAULT_LLM_CONFIGS: Record<LLMProvider, LLMConfig> = {
    ollama: {
        provider: 'ollama',
        api_key: null,
        base_url: 'http://127.0.0.1:11434',
        model: 'llama3.1',              // Brain model - smart, for planning/analysis
        executor_model: null,            // Executor model - optional, for fast CLI translation
        embedding_model: 'nomic-embed-text', // Default embedding model
        temperature: 0.0,                // Force deterministic output
        max_tokens: 8192,
    },
    openai: {
        provider: 'openai',
        api_key: null,
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        executor_model: 'gpt-4o-mini',
        embedding_model: 'text-embedding-3-small',
        embedding_endpoint: 'https://api.openai.com/v1',
        temperature: 0.2,
        max_tokens: 8192,
    },
    anthropic: {
        provider: 'anthropic',
        api_key: null,
        base_url: 'https://api.anthropic.com',
        model: 'claude-3-5-sonnet-20241022',
        executor_model: null,
        embedding_model: null,
        embedding_endpoint: null,
        temperature: 0.2,
        max_tokens: 8192,
    },
    custom: {
        provider: 'custom',
        api_key: null,
        base_url: 'http://localhost:1234/v1',
        model: 'local-model',
        executor_model: null,
        embedding_model: 'nomic-embed-text',
        embedding_endpoint: 'http://localhost:11434',
        temperature: 0.7,
        max_tokens: 4096,
    },
    'claude-code': {
        provider: 'claude-code',
        api_key: null,
        base_url: '',
        model: 'claude-code',
        executor_model: null,
        embedding_model: null,
        embedding_endpoint: null,
        temperature: 0.2,
        max_tokens: 8192,
    },
    groq: {
        provider: 'groq',
        api_key: null,
        base_url: 'https://api.groq.com/openai/v1',
        model: 'llama-3.3-70b-versatile',
        executor_model: 'llama-3.3-70b-versatile',
        embedding_model: 'nomic-embed-text',
        embedding_endpoint: 'http://localhost:11434',
        temperature: 0.1,
        max_tokens: 8192,
    },
};
