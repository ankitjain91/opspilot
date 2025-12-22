import { invoke } from '@tauri-apps/api/core';
// JIRA Cloud integration utilities

export interface JiraConfig {
    cloudId?: string;
    siteUrl?: string;
    email?: string;
    accessToken?: string;
    refreshToken?: string;
    defaultProjectKey?: string;
    connected: boolean;
}

export interface JiraIssueInput {
    summary: string;
    description: string;
    issueType?: string;  // 'Bug', 'Task', 'Story', etc.
    projectKey?: string; // Override default project
    labels?: string[];
    priority?: string;   // 'Highest', 'High', 'Medium', 'Low', 'Lowest'
}

export interface JiraIssue {
    id: string;
    key: string;
    self: string;
}

/**
 * Get the stored JIRA configuration
 */
export function getJiraConfig(): JiraConfig | null {
    try {
        const stored = localStorage.getItem('opspilot-jira-config');
        if (stored) {
            return JSON.parse(stored);
        }
    } catch (e) {
        console.error('Failed to load JIRA config:', e);
    }
    return null;
}

/**
 * Check if JIRA is configured and connected
 */
export function isJiraConnected(): boolean {
    const config = getJiraConfig();
    // Connection should not depend on token being present in localStorage
    // (token is stored securely in Keychain).
    return config?.connected === true && !!config.siteUrl && !!config.email;
}

/**
 * Create a JIRA issue
 */
// Helper to fetch valid metadata for a project/issue type
async function getCreateMeta(config: JiraConfig, token: string, projectKey: string, issueType: string) {
    const url = `${config.siteUrl}/rest/api/3/issue/createmeta?projectKeys=${projectKey}&issuetypeNames=${issueType}&expand=projects.issuetypes.fields`;

    // Authorization header
    const authHeader = {
        Authorization: `Basic ${btoa(`${config.email}:${token}`)}`,
        Accept: 'application/json',
        'X-Atlassian-Token': 'no-check',
    };

    try {
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        const resp = await tauriFetch(url, { method: 'GET', headers: authHeader });
        if (resp.ok) return await resp.json();
    } catch (e) {
        // Fallback to browser fetch
        const resp = await fetch(url, { method: 'GET', headers: authHeader });
        if (resp.ok) return await resp.json();
    }
    return null;
}

export async function createJiraIssue(input: JiraIssueInput): Promise<JiraIssue> {
    const config = getJiraConfig();
    if (!config?.connected || !config.siteUrl || !config.email) {
        throw new Error('JIRA is not configured. Please set up JIRA in Settings.');
    }

    const projectKey = input.projectKey || config.defaultProjectKey;
    if (!projectKey) {
        throw new Error('No project specified and no default project configured.');
    }

    // 1. Sanitize Summary (remove newlines)
    const summary = input.summary.replace(/[\r\n]+/g, ' ').trim();

    // Retrieve token from secure storage (Keychain)
    let token = config.accessToken;
    if (!token) {
        try {
            console.log('[JIRA] Attempting to retrieve token from secure storage...');
            const secret = await invoke<string | null>('retrieve_secret', { key: 'jira_access_token' });
            if (secret) {
                token = secret;
                console.log('[JIRA] Token retrieved successfully from secure storage');
            } else {
                console.warn('[JIRA] retrieve_secret returned null/empty');
            }
        } catch (e) {
            console.error('[JIRA] Failed to retrieve token from secure storage:', e);
        }
    }
    if (!token) {
        throw new Error('JIRA token missing. Please reconnect in Settings. If macOS shows a "Music" or other permission prompt, click Allow to grant Keychain access.');
    }

    let issueData: any = {
        fields: {
            project: { key: projectKey },
            summary: summary,
            description: {
                type: 'doc',
                version: 1,
                content: [{ type: 'paragraph', content: [{ type: 'text', text: input.description }] }]
            },
            issuetype: { name: input.issueType || 'Bug' },
            ...(input.labels?.length ? { labels: input.labels } : {}),
            ...(input.priority ? { priority: { name: input.priority } } : {})
        }
    };

    // Helper to perform the create request
    const performCreate = async (data: any) => {
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        const headers = {
            Authorization: `Basic ${btoa(`${config.email}:${token}`)}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Atlassian-Token': 'no-check',
        };

        try {
            const resp = await tauriFetch(`${config.siteUrl}/rest/api/3/issue`, {
                method: 'POST',
                headers,
                body: JSON.stringify(data),
            });
            if (resp.ok) return await resp.json() as JiraIssue;
            return { error: await resp.text(), status: resp.status };
        } catch (e) {
            // Fallback
            const resp = await fetch(`${config.siteUrl}/rest/api/3/issue`, {
                method: 'POST',
                headers,
                body: JSON.stringify(data),
            });
            if (resp.ok) return await resp.json() as JiraIssue;
            return { error: await resp.text(), status: resp.status };
        }
    };

    // First attempt
    let result = await performCreate(issueData);

    // Check for specific validation errors regarding missing required fields
    if ('error' in result) {
        let errorObj: any;
        try { errorObj = JSON.parse(result.error); } catch (e) { }

        if (errorObj && errorObj.errors) {
            const missingVars = [];
            if (errorObj.errors.versions || errorObj.errors.timetracking || errorObj.errors.components) {
                // Fetch create meta to get valid values
                const meta = await getCreateMeta(config, token!, projectKey, input.issueType || 'Bug');
                if (meta && meta.projects && meta.projects.length > 0) {
                    const issuetype = meta.projects[0].issuetypes.find((it: any) => it.name === (input.issueType || 'Bug'));
                    if (issuetype && issuetype.fields) {
                        // Fix Components
                        if (errorObj.errors.components && issuetype.fields.components && issuetype.fields.components.allowedValues?.length > 0) {
                            issueData.fields.components = [{ id: issuetype.fields.components.allowedValues[0].id }];
                            missingVars.push("components");
                        }
                        // Fix Versions (Affects Versions)
                        if (errorObj.errors.versions && issuetype.fields.versions && issuetype.fields.versions.allowedValues?.length > 0) {
                            issueData.fields.versions = [{ id: issuetype.fields.versions.allowedValues[0].id }];
                            missingVars.push("versions");
                        }
                    }
                }
            }

            // Retry if we patched something
            if (missingVars.length > 0) {
                result = await performCreate(issueData);
            }
        }
    }

    if (!('error' in result) && ((result as JiraIssue).id || (result as JiraIssue).key)) {
        return result as JiraIssue;
    }

    const err = result as { error: string; status: number; };
    throw new Error(`Failed to create issue: ${err.status || 'Unknown'} - ${err.error || JSON.stringify(result)}`);
}

/**
 * Rich resource context for debugging
 */
export interface ResourceDebugContext {
    kind: string;
    name: string;
    namespace: string;
    apiVersion?: string;
    status?: string;
    phase?: string;
    conditions?: Array<{
        type: string;
        status: string;
        reason?: string;
        message?: string;
        lastTransitionTime?: string;
    }>;
    containerStatuses?: Array<{
        name: string;
        ready: boolean;
        restartCount: number;
        state?: string;
        reason?: string;
        message?: string;
    }>;
    events?: Array<{
        type: string;
        reason: string;
        message: string;
        count?: number;
        lastTimestamp?: string;
    }>;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: Array<{
        kind: string;
        name: string;
    }>;
    relatedResources?: Array<{
        kind: string;
        name: string;
        namespace?: string;
    }>;
    recentLogs?: string;
    resourceMetrics?: {
        cpuUsage?: string;
        memoryUsage?: string;
        cpuRequests?: string;
        memoryRequests?: string;
        cpuLimits?: string;
        memoryLimits?: string;
    };
}

/**
 * Extract debug context from a full Kubernetes resource object
 */
export function extractResourceDebugContext(fullObject: any, events?: any[], relatedResources?: any[]): ResourceDebugContext {
    if (!fullObject) return { kind: 'Unknown', name: 'Unknown', namespace: 'default' };

    const metadata = fullObject.metadata || {};
    const spec = fullObject.spec || {};
    const status = fullObject.status || {};

    const context: ResourceDebugContext = {
        kind: fullObject.kind || 'Unknown',
        name: metadata.name || 'Unknown',
        namespace: metadata.namespace || 'default',
        apiVersion: fullObject.apiVersion,
    };

    // Extract status/phase
    if (status.phase) {
        context.phase = status.phase;
    }

    // Extract conditions
    if (status.conditions && Array.isArray(status.conditions)) {
        context.conditions = status.conditions.map((c: any) => ({
            type: c.type,
            status: c.status,
            reason: c.reason,
            message: c.message,
            lastTransitionTime: c.lastTransitionTime,
        })).slice(0, 10); // Limit to 10 most relevant
    }

    // Extract container statuses for Pods
    if (status.containerStatuses && Array.isArray(status.containerStatuses)) {
        context.containerStatuses = status.containerStatuses.map((cs: any) => {
            const stateKey = Object.keys(cs.state || {})[0] || 'unknown';
            const stateDetails = cs.state?.[stateKey] || {};
            return {
                name: cs.name,
                ready: cs.ready,
                restartCount: cs.restartCount || 0,
                state: stateKey,
                reason: stateDetails.reason,
                message: stateDetails.message,
            };
        });
    }

    // Extract init container statuses if any failed
    if (status.initContainerStatuses && Array.isArray(status.initContainerStatuses)) {
        const failedInit = status.initContainerStatuses.filter((cs: any) => !cs.ready);
        if (failedInit.length > 0) {
            context.containerStatuses = [
                ...(context.containerStatuses || []),
                ...failedInit.map((cs: any) => {
                    const stateKey = Object.keys(cs.state || {})[0] || 'unknown';
                    const stateDetails = cs.state?.[stateKey] || {};
                    return {
                        name: `init:${cs.name}`,
                        ready: cs.ready,
                        restartCount: cs.restartCount || 0,
                        state: stateKey,
                        reason: stateDetails.reason,
                        message: stateDetails.message,
                    };
                })
            ];
        }
    }

    // Extract relevant labels (filter out noisy ones)
    if (metadata.labels) {
        const relevantLabels: Record<string, string> = {};
        const importantKeys = ['app', 'app.kubernetes.io/name', 'app.kubernetes.io/version', 'app.kubernetes.io/component',
                               'version', 'release', 'environment', 'tier', 'component'];
        for (const key of importantKeys) {
            if (metadata.labels[key]) {
                relevantLabels[key] = metadata.labels[key];
            }
        }
        if (Object.keys(relevantLabels).length > 0) {
            context.labels = relevantLabels;
        }
    }

    // Extract owner references
    if (metadata.ownerReferences && Array.isArray(metadata.ownerReferences)) {
        context.ownerReferences = metadata.ownerReferences.map((ref: any) => ({
            kind: ref.kind,
            name: ref.name,
        }));
    }

    // Extract resource metrics from spec
    const containers = spec.containers || [];
    if (containers.length > 0) {
        const firstContainer = containers[0];
        const resources = firstContainer.resources || {};
        if (resources.requests || resources.limits) {
            context.resourceMetrics = {
                cpuRequests: resources.requests?.cpu,
                memoryRequests: resources.requests?.memory,
                cpuLimits: resources.limits?.cpu,
                memoryLimits: resources.limits?.memory,
            };
        }
    }

    // Add events if provided
    if (events && events.length > 0) {
        context.events = events.slice(0, 10).map((e: any) => ({
            type: e.type || 'Normal',
            reason: e.reason || 'Unknown',
            message: e.message || '',
            count: e.count,
            lastTimestamp: e.lastTimestamp,
        }));
    }

    // Add related resources if provided
    if (relatedResources && relatedResources.length > 0) {
        context.relatedResources = relatedResources.slice(0, 10).map((r: any) => ({
            kind: r.kind,
            name: r.name,
            namespace: r.namespace,
        }));
    }

    return context;
}

/**
 * Format debug context as JIRA-compatible text
 */
function formatDebugContextForJira(ctx: ResourceDebugContext): string {
    const sections: string[] = [];

    // Resource Identity
    sections.push(`h3. Resource Details
||Property||Value||
|Kind|${ctx.kind}|
|Name|${ctx.name}|
|Namespace|${ctx.namespace}|
${ctx.apiVersion ? `|API Version|${ctx.apiVersion}|` : ''}
${ctx.phase ? `|Phase|${ctx.phase}|` : ''}`);

    // Labels
    if (ctx.labels && Object.keys(ctx.labels).length > 0) {
        const labelRows = Object.entries(ctx.labels)
            .map(([k, v]) => `|${k}|${v}|`)
            .join('\n');
        sections.push(`h3. Key Labels
||Label||Value||
${labelRows}`);
    }

    // Owner References
    if (ctx.ownerReferences && ctx.ownerReferences.length > 0) {
        const ownerList = ctx.ownerReferences
            .map(ref => `* ${ref.kind}: ${ref.name}`)
            .join('\n');
        sections.push(`h3. Owner References
${ownerList}`);
    }

    // Conditions (highlight non-True ones)
    if (ctx.conditions && ctx.conditions.length > 0) {
        const conditionRows = ctx.conditions
            .map(c => {
                const icon = c.status === 'True' ? '(/)' : c.status === 'False' ? '(x)' : '(?)';
                const details = [c.reason, c.message].filter(Boolean).join(' - ');
                return `|${icon} ${c.type}|${c.status}|${details || '-'}|`;
            })
            .join('\n');
        sections.push(`h3. Conditions
||Condition||Status||Details||
${conditionRows}`);
    }

    // Container Statuses
    if (ctx.containerStatuses && ctx.containerStatuses.length > 0) {
        const containerRows = ctx.containerStatuses
            .map(cs => {
                const icon = cs.ready ? '(/)' : '(x)';
                const details = [cs.reason, cs.message].filter(Boolean).join(' - ');
                return `|${icon} ${cs.name}|${cs.state}|${cs.restartCount}|${details || '-'}|`;
            })
            .join('\n');
        sections.push(`h3. Container Statuses
||Container||State||Restarts||Details||
${containerRows}`);
    }

    // Resource Metrics
    if (ctx.resourceMetrics) {
        const metrics = ctx.resourceMetrics;
        const metricLines = [];
        if (metrics.cpuRequests || metrics.cpuLimits) {
            metricLines.push(`|CPU|${metrics.cpuRequests || '-'}|${metrics.cpuLimits || '-'}|`);
        }
        if (metrics.memoryRequests || metrics.memoryLimits) {
            metricLines.push(`|Memory|${metrics.memoryRequests || '-'}|${metrics.memoryLimits || '-'}|`);
        }
        if (metricLines.length > 0) {
            sections.push(`h3. Resource Allocations
||Resource||Requests||Limits||
${metricLines.join('\n')}`);
        }
    }

    // Events (filter to warnings first)
    if (ctx.events && ctx.events.length > 0) {
        const warnings = ctx.events.filter(e => e.type === 'Warning');
        const eventsToShow = warnings.length > 0 ? warnings : ctx.events.slice(0, 5);
        const eventRows = eventsToShow
            .map(e => {
                const icon = e.type === 'Warning' ? '(!)' : '(i)';
                return `|${icon} ${e.reason}|${e.message}|${e.count ? `x${e.count}` : '1'}|`;
            })
            .join('\n');
        sections.push(`h3. Recent Events
||Reason||Message||Count||
${eventRows}`);
    }

    // Related Resources
    if (ctx.relatedResources && ctx.relatedResources.length > 0) {
        const relatedList = ctx.relatedResources
            .map(r => `* ${r.kind}: ${r.name}${r.namespace ? ` (${r.namespace})` : ''}`)
            .join('\n');
        sections.push(`h3. Related Resources
${relatedList}`);
    }

    // Recent Logs
    if (ctx.recentLogs) {
        sections.push(`h3. Recent Logs
{code}
${ctx.recentLogs.slice(0, 2000)}${ctx.recentLogs.length > 2000 ? '\n... (truncated)' : ''}
{code}`);
    }

    return sections.join('\n\n');
}

/**
 * Format an investigation/alert for JIRA (enhanced version)
 */
export function formatInvestigationForJira(
    title: string,
    context: string,
    findings: string,
    cluster?: string,
    resourceDebugContext?: ResourceDebugContext
): JiraIssueInput {
    let description = `
*Cluster:* ${cluster || 'Unknown'}
*Reported At:* ${new Date().toISOString()}

h2. Context
${context}

h2. Investigation Findings
${findings}
`;

    // Add rich debug context if available
    if (resourceDebugContext) {
        description += `
----
h2. Resource Debug Information
${formatDebugContextForJira(resourceDebugContext)}
`;
    }

    description += `
----
_Created by OpsPilot_
    `.trim();

    // Determine labels based on context
    const labels = ['opspilot', 'k8s-issue'];
    if (resourceDebugContext?.kind) {
        labels.push(`k8s-${resourceDebugContext.kind.toLowerCase()}`);
    }
    if (resourceDebugContext?.phase === 'Failed' ||
        resourceDebugContext?.containerStatuses?.some(cs => cs.restartCount > 5)) {
        labels.push('critical');
    }

    return {
        summary: title,
        description,
        issueType: 'Bug',
        labels
    };
}

/**
 * Get the JIRA issue URL
 */
export function getJiraIssueUrl(issueKey: string): string | null {
    const config = getJiraConfig();
    if (!config?.siteUrl) return null;
    return `${config.siteUrl}/browse/${issueKey}`;
}
