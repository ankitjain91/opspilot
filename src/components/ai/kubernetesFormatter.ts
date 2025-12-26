/**
 * Kubernetes Output Formatter
 *
 * Parses raw kubectl output and formats it into user-friendly markdown
 * This ensures consistent, beautiful formatting regardless of LLM behavior
 */

export interface Pod {
    namespace: string;
    name: string;
    ready: string;
    status: string;
    restarts: string;
    age: string;
}

export interface FormattedOutput {
    type: 'pod_list' | 'events' | 'logs' | 'describe' | 'raw';
    markdown: string;
    data?: any;
}

/**
 * Parse kubectl get pods output into structured data
 */
export function parsePodList(output: string): Pod[] {
    const lines = output.trim().split('\n');
    if (lines.length === 0) return [];

    // Skip header line
    const dataLines = lines.slice(1);

    return dataLines.map(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) return null;

        return {
            namespace: parts[0],
            name: parts[1],
            ready: parts[2],
            status: parts[3],
            restarts: parts[4],
            age: parts[5] || 'N/A'
        };
    }).filter((p): p is Pod => p !== null);
}

/**
 * Identify if a pod is failing
 */
export function isPodFailing(pod: Pod): boolean {
    const failingStatuses = [
        'CrashLoopBackOff',
        'Error',
        'Failed',
        'ImagePullBackOff',
        'ErrImagePull',
        'Pending',
        'OOMKilled',
        'Unknown',
        'Terminating',
        'Init:Error',
        'Init:CrashLoopBackOff'
    ];

    // Check status
    if (failingStatuses.some(s => pod.status.includes(s))) return true;

    // Check if ready count is 0/X (not ready)
    if (pod.ready.match(/^0\/\d+$/)) return true;

    // High restart count
    const restarts = parseInt(pod.restarts);
    if (!isNaN(restarts) && restarts > 5) return true;

    return false;
}

/**
 * Get emoji and color for pod status
 */
export function getPodStatusInfo(status: string): { emoji: string; severity: 'error' | 'warning' | 'info' } {
    if (status.includes('CrashLoopBackOff') || status.includes('Error') || status.includes('OOMKilled')) {
        return { emoji: '[X]', severity: 'error' };
    }
    if (status.includes('Pending') || status.includes('ImagePull')) {
        return { emoji: '[WARN]', severity: 'warning' };
    }
    if (status.includes('Completed')) {
        return { emoji: '[OK]', severity: 'info' };
    }
    return { emoji: '[?]', severity: 'info' };
}

/**
 * Get recommended action for a failing pod
 */
export function getRecommendedAction(pod: Pod): string {
    const status = pod.status;

    if (status.includes('CrashLoopBackOff')) {
        return `Check logs: \`kubectl logs ${pod.name} -n ${pod.namespace} --tail=50\``;
    }
    if (status.includes('ImagePullBackOff') || status.includes('ErrImagePull')) {
        return `Verify image name and registry credentials`;
    }
    if (status.includes('OOMKilled')) {
        return `Increase memory limits in deployment spec`;
    }
    if (status.includes('Pending')) {
        return `Check events: \`kubectl describe pod ${pod.name} -n ${pod.namespace}\``;
    }
    if (parseInt(pod.restarts) > 5) {
        return `High restart count - investigate logs for recurring errors`;
    }
    return 'Investigate further with kubectl describe';
}

/**
 * Format pod list as markdown table (ONLY failing pods)
 */
export function formatFailingPods(output: string): FormattedOutput {
    const allPods = parsePodList(output);
    const failingPods = allPods.filter(isPodFailing);

    if (failingPods.length === 0) {
        return {
            type: 'pod_list',
            markdown: `## Pod Status\n\n[OK] **All pods are healthy!**\n\nNo failing pods detected in the cluster.`,
            data: { total: allPods.length, failing: 0 }
        };
    }

    let markdown = `## Failing Pods\n\nFound **${failingPods.length}** pod${failingPods.length > 1 ? 's' : ''} with issues:\n\n`;

    // Build markdown table
    markdown += `| Namespace | Pod Name | Status | Ready | Restarts | Age |\n`;
    markdown += `|-----------|----------|--------|-------|----------|-----|\n`;

    failingPods.forEach(pod => {
        const { emoji } = getPodStatusInfo(pod.status);
        markdown += `| ${pod.namespace} | ${pod.name} | ${emoji} ${pod.status} | ${pod.ready} | ${pod.restarts} | ${pod.age} |\n`;
    });

    // Add recommendations
    markdown += `\n### Recommended Actions\n\n`;
    failingPods.forEach(pod => {
        const { emoji } = getPodStatusInfo(pod.status);
        const action = getRecommendedAction(pod);
        markdown += `${emoji} **${pod.name}**: ${action}\n\n`;
    });

    return {
        type: 'pod_list',
        markdown,
        data: { total: allPods.length, failing: failingPods.length, pods: failingPods }
    };
}

/**
 * Auto-detect kubectl output type and format appropriately
 */
export function formatKubectlOutput(command: string, output: string): FormattedOutput {
    // Empty output
    if (!output || output.trim().length === 0) {
        return {
            type: 'raw',
            markdown: '[OK] No output (command completed successfully)'
        };
    }

    // Detect command type
    const cmdLower = command.toLowerCase();

    // Pod listing
    if (cmdLower.includes('get pods') || cmdLower.includes('get pod')) {
        // Check if output looks like pod list (has NAMESPACE or NAME header)
        if (output.includes('NAMESPACE') && output.includes('NAME') && output.includes('STATUS')) {
            return formatFailingPods(output);
        }
    }

    // Events - just show last 10
    if (cmdLower.includes('get events')) {
        const lines = output.trim().split('\n');
        if (lines.length > 11) {
            // Only show last 10 events
            return {
                type: 'events',
                markdown: `## Recent Events\n\n\`\`\`\n${lines.slice(0, 1).join('\n')}\n${lines.slice(-10).join('\n')}\n\`\`\`\n\n_Showing last 10 events_`
            };
        }
    }

    // Logs - truncate if too long
    if (cmdLower.includes('logs')) {
        const lines = output.trim().split('\n');
        if (lines.length > 50) {
            return {
                type: 'logs',
                markdown: `## Pod Logs\n\n\`\`\`\n${lines.slice(-50).join('\n')}\n\`\`\`\n\n_Showing last 50 lines_`
            };
        }
        return {
            type: 'logs',
            markdown: `## Pod Logs\n\n\`\`\`\n${output}\n\`\`\``
        };
    }

    // Default: show as code block with truncation
    const lines = output.trim().split('\n');
    if (lines.length > 30) {
        return {
            type: 'raw',
            markdown: `\`\`\`\n${lines.slice(0, 30).join('\n')}\n... (${lines.length - 30} more lines)\n\`\`\`\n\n_Output truncated for readability_`
        };
    }

    return {
        type: 'raw',
        markdown: `\`\`\`\n${output}\n\`\`\``
    };
}
