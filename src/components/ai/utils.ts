import { LLMConfig } from '../../types/ai';
import { DEFAULT_LLM_CONFIGS } from './constants';

// Helper to load LLM config from localStorage
export function loadLLMConfig(): LLMConfig {
    try {
        const saved = localStorage.getItem('opspilot-llm-config');
        if (saved) {
            return JSON.parse(saved);
        }
    } catch {
        // Ignore parse errors
    }
    return DEFAULT_LLM_CONFIGS.ollama;
}
