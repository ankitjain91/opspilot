import { LLMProvider, LLMConfig } from '../../types/ai';

// Default LLM configurations
export const DEFAULT_LLM_CONFIGS: Record<LLMProvider, LLMConfig> = {
    ollama: {
        provider: 'ollama',
        api_key: null,
        base_url: 'http://127.0.0.1:11434',
        model: 'llama3.1:8b',
        temperature: 0.2,
        max_tokens: 8192,
    },
    openai: {
        provider: 'openai',
        api_key: null,
        base_url: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        temperature: 0.2,
        max_tokens: 8192,
    },
    anthropic: {
        provider: 'anthropic',
        api_key: null,
        base_url: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-20250514',
        temperature: 0.2,
        max_tokens: 8192,
    },
    custom: {
        provider: 'custom',
        api_key: null,
        base_url: 'http://localhost:8000/v1',
        model: 'default',
        temperature: 0.7,
        max_tokens: 4096,
    },
    'claude-code': {
        provider: 'claude-code',
        api_key: null,
        base_url: '',
        model: 'claude-code-cli',
        temperature: 0.2,
        max_tokens: 8192,
    },
};
