
import { K8sObject } from "../../../types/k8s";

// Helper to fix kubectl commands with placeholder syntax like [namespace], <pod>, etc.
export function fixKubectlPlaceholders(text: string, resource: K8sObject, containers?: string[]): string {
    if (!text) return '';
    // Replace common placeholder patterns with actual values
    let fixed = text;

    // Fix namespace placeholders
    fixed = fixed.replace(/\[namespace\]|\<namespace\>|\{namespace\}/gi, resource.namespace);
    fixed = fixed.replace(/-n\s+\[ns\]|-n\s+\<ns\>/gi, `-n ${resource.namespace}`);

    // Fix pod name placeholders
    if (resource.kind === 'Pod') {
        fixed = fixed.replace(/\[pod\]|\<pod\>|\{pod\}|\[pod-name\]|\<pod-name\>/gi, resource.name);
    }

    // Fix container placeholders - use first container if available
    if (containers && containers.length > 0) {
        fixed = fixed.replace(/\[container\]|\<container\>|\{container\}|\[container-name\]|\<container-name\>/gi, containers[0]);
    }

    // Fix resource name placeholders
    fixed = fixed.replace(/\[name\]|\<name\>|\{name\}|\[resource-name\]|\<resource-name\>/gi, resource.name);

    return fixed;
}

// Helper to auto-fix tool arguments when errors occur
export function autoFixToolArgs(toolName: string, toolArgs: string | undefined, containers: string[], errorMessage?: string): { fixed: string | undefined; wasFixed: boolean } {
    if (!toolArgs) return { fixed: undefined, wasFixed: false };

    let fixed = toolArgs;
    let wasFixed = false;

    // Fix LOGS/LOGS_PREVIOUS container names
    if (toolName === 'LOGS' || toolName === 'LOGS_PREVIOUS') {
        // Remove brackets, quotes, and extra whitespace
        const cleaned = toolArgs.replace(/[\[\]"'<>{ }]/g, '').trim();

        // If cleaned version is different, we fixed something
        if (cleaned !== toolArgs) {
            fixed = cleaned;
            wasFixed = true;
        }

        // If container name doesn't match available containers, try to find best match
        if (containers.length > 0 && cleaned && !containers.includes(cleaned)) {
            // Try case-insensitive match
            const lowerCleaned = cleaned.toLowerCase();
            const match = containers.find(c => c.toLowerCase() === lowerCleaned);
            if (match) {
                fixed = match;
                wasFixed = true;
            } else {
                // Try partial match
                const partialMatch = containers.find(c =>
                    c.toLowerCase().includes(lowerCleaned) || lowerCleaned.includes(c.toLowerCase())
                );
                if (partialMatch) {
                    fixed = partialMatch;
                    wasFixed = true;
                } else if (containers.length === 1) {
                    // Only one container, use it
                    fixed = containers[0];
                    wasFixed = true;
                }
            }
        }
    }

    // Fix LIST_RESOURCES/DESCRIBE_ANY kind names
    if (toolName === 'LIST_RESOURCES' || toolName === 'DESCRIBE_ANY') {
        // Remove brackets and quotes
        const cleaned = toolArgs.replace(/[\[\]"'<>{ }]/g, '').trim();
        if (cleaned !== toolArgs) {
            fixed = cleaned;
            wasFixed = true;
        }
    }

    return { fixed, wasFixed };
}

// Check if a tool result indicates an error that can be auto-fixed
export function isAutoFixableError(toolResult: string): boolean {
    return toolResult.includes('TOOL SYNTAX ERROR') ||
        toolResult.includes('WRONG CONTAINER NAME') ||
        toolResult.includes('Invalid container name') ||
        toolResult.includes('Invalid syntax');
}
