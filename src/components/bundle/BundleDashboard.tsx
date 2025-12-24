import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
    Archive, FolderOpen, X, AlertTriangle, CheckCircle, Clock,
    Search, ChevronRight, ChevronDown, FileText, Activity,
    Loader2, Box, Server, Network, Settings2, Layers, Database,
    XCircle, Copy, Check, ArrowLeft, Zap, RefreshCw,
    AlertOctagon, Eye, Terminal, ExternalLink, ChevronUp,
    Info, Flame, HardDrive, MemoryStick, Cpu, Download,
    Filter, BarChart3, GitBranch, Calendar, TrendingUp,
    Shield, AlertCircle, Target, Gauge, FileDown, PanelRightOpen,
    PanelRightClose, Timer, Hash, Tag, Crosshair, Brain, Sparkles
} from 'lucide-react';
import { BundleAIAnalyzer } from './BundleAIAnalyzer';
import type {
    SupportBundle, BundleResource, BundleEvent, BundleHealthSummary,
    BundleAlerts, BundleLogFile, PodHealthInfo, DeploymentHealthInfo
} from './types';

// ============================================================================
// TYPES
// ============================================================================

interface ResourceChain {
    deployment?: BundleResource;
    replicaSet?: BundleResource;
    pod: BundleResource;
    service?: BundleResource;
    events: BundleEvent[];
    logs?: BundleLogFile[];
}

interface FailureAnalysis {
    type: 'crash' | 'oom' | 'image' | 'pending' | 'evicted' | 'error' | 'unhealthy';
    title: string;
    description: string;
    severity: 'critical' | 'warning';
    suggestions: string[];
}

interface DetectedIssue {
    id: string;
    type: string;
    title: string;
    description: string;
    severity: 'critical' | 'warning' | 'info';
    namespace: string;
    affectedResource: string;
    resourceKind: string;
    rootCause?: string;
    suggestions: string[];
    relatedEvents: BundleEvent[];
    timestamp?: Date;
}

interface TimelineEvent {
    id: string;
    timestamp: Date | null;
    type: 'event' | 'alert' | 'issue';
    severity: 'critical' | 'warning' | 'info' | 'normal';
    title: string;
    description: string;
    namespace: string;
    resource: string;
    resourceKind: string;
    count?: number;
}

interface ResourceNode {
    id: string;
    name: string;
    kind: string;
    namespace: string;
    status: string;
    hasIssue: boolean;
    children: ResourceNode[];
    parent?: string;
}

interface SearchResult {
    type: 'resource' | 'event' | 'alert' | 'log';
    name: string;
    namespace?: string;
    match: string;
    snippet: string;
    resource?: BundleResource;
    event?: BundleEvent;
}

interface ClusterOverview {
    healthScore: number;
    totalPods: number;
    healthyPods: number;
    failingPods: number;
    pendingPods: number;
    totalDeployments: number;
    healthyDeployments: number;
    totalServices: number;
    warningEvents: number;
    criticalAlerts: number;
    warningAlerts: number;
    namespaceHealth: Map<string, { healthy: number; total: number }>;
}

interface FilterState {
    status: ('failing' | 'warning' | 'healthy' | 'pending')[];
    resourceTypes: string[];
    namespaces: string[];
    issueTypes: string[];
    severity: ('critical' | 'warning' | 'info')[];
    hasLogs: boolean | null;
    timeRange: 'all' | '1h' | '6h' | '24h' | '7d';
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function analyzeBundle(
    allResources: Map<string, BundleResource[]>,
    events: BundleEvent[],
    alerts: BundleAlerts | null,
    healthSummary: BundleHealthSummary | null
): DetectedIssue[] {
    const issues: DetectedIssue[] = [];
    const allResourcesList: BundleResource[] = [];
    allResources.forEach(r => allResourcesList.push(...r));

    // Analyze failing pods
    if (healthSummary?.failing_pods) {
        for (const podInfo of healthSummary.failing_pods) {
            const pod = allResourcesList.find(r =>
                r.kind === 'Pod' && r.name === podInfo.name && r.namespace === podInfo.namespace
            );
            if (!pod) continue;

            const podEvents = events.filter(e =>
                e.involved_object_name === pod.name && e.involved_object_kind === 'Pod'
            );

            const analysis = analyzeFailure(pod, podEvents);
            issues.push({
                id: `pod-${pod.namespace}-${pod.name}`,
                type: analysis.type,
                title: analysis.title,
                description: analysis.description,
                severity: analysis.severity,
                namespace: pod.namespace || 'default',
                affectedResource: pod.name,
                resourceKind: 'Pod',
                rootCause: analysis.description,
                suggestions: analysis.suggestions,
                relatedEvents: podEvents,
                timestamp: podEvents[0]?.last_timestamp ? new Date(podEvents[0].last_timestamp) : undefined
            });
        }
    }

    // Analyze unhealthy deployments
    if (healthSummary?.unhealthy_deployments) {
        for (const dep of healthSummary.unhealthy_deployments) {
            issues.push({
                id: `deployment-${dep.namespace}-${dep.name}`,
                type: 'unhealthy',
                title: 'Deployment Not Ready',
                description: `${dep.ready_replicas}/${dep.desired_replicas} replicas ready`,
                severity: dep.ready_replicas === 0 ? 'critical' : 'warning',
                namespace: dep.namespace,
                affectedResource: dep.name,
                resourceKind: 'Deployment',
                suggestions: [
                    'Check pod status for this deployment',
                    'Review deployment events',
                    'Verify resource limits and requests'
                ],
                relatedEvents: events.filter(e =>
                    e.involved_object_name === dep.name && e.involved_object_kind === 'Deployment'
                )
            });
        }
    }

    // Analyze pending PVCs
    if (healthSummary?.pending_pvcs) {
        for (const pvc of healthSummary.pending_pvcs) {
            issues.push({
                id: `pvc-${pvc}`,
                type: 'pending',
                title: 'PVC Pending',
                description: `PersistentVolumeClaim ${pvc} is not bound`,
                severity: 'warning',
                namespace: 'unknown',
                affectedResource: pvc,
                resourceKind: 'PersistentVolumeClaim',
                suggestions: [
                    'Check if a matching PersistentVolume exists',
                    'Verify storage class configuration',
                    'Review PVC events for binding errors'
                ],
                relatedEvents: []
            });
        }
    }

    // Analyze critical alerts
    if (alerts?.critical) {
        for (const alert of alerts.critical) {
            issues.push({
                id: `alert-critical-${alert.name}`,
                type: 'alert',
                title: alert.name,
                description: alert.message || 'Critical alert firing',
                severity: 'critical',
                namespace: alert.labels['namespace'] || 'cluster',
                affectedResource: alert.labels['pod'] || alert.labels['deployment'] || alert.name,
                resourceKind: 'Alert',
                suggestions: ['Investigate the alert conditions', 'Check related metrics'],
                relatedEvents: []
            });
        }
    }

    // Analyze warning alerts
    if (alerts?.warning) {
        for (const alert of alerts.warning) {
            issues.push({
                id: `alert-warning-${alert.name}`,
                type: 'alert',
                title: alert.name,
                description: alert.message || 'Warning alert firing',
                severity: 'warning',
                namespace: alert.labels['namespace'] || 'cluster',
                affectedResource: alert.labels['pod'] || alert.labels['deployment'] || alert.name,
                resourceKind: 'Alert',
                suggestions: ['Monitor the alert conditions'],
                relatedEvents: []
            });
        }
    }

    return issues.sort((a, b) => {
        const severityOrder = { critical: 0, warning: 1, info: 2 };
        return severityOrder[a.severity] - severityOrder[b.severity];
    });
}

function computeOverview(
    allResources: Map<string, BundleResource[]>,
    events: BundleEvent[],
    alerts: BundleAlerts | null,
    healthSummary: BundleHealthSummary | null
): ClusterOverview {
    let totalPods = 0, healthyPods = 0, failingPods = 0, pendingPods = 0;
    let totalDeployments = 0, healthyDeployments = 0;
    let totalServices = 0;
    const namespaceHealth = new Map<string, { healthy: number; total: number }>();

    allResources.forEach((resources, ns) => {
        let nsHealthy = 0, nsTotal = 0;

        for (const r of resources) {
            if (r.kind === 'Pod') {
                totalPods++;
                nsTotal++;
                const status = r.status_phase?.toLowerCase() || '';
                if (status === 'running' || status === 'succeeded') {
                    healthyPods++;
                    nsHealthy++;
                } else if (status === 'pending') {
                    pendingPods++;
                } else if (status.includes('error') || status.includes('crash') || status.includes('failed')) {
                    failingPods++;
                }
            } else if (r.kind === 'Deployment') {
                totalDeployments++;
                // Check if all replicas are ready
                const isHealthy = !healthSummary?.unhealthy_deployments?.some(
                    d => d.name === r.name && d.namespace === ns
                );
                if (isHealthy) healthyDeployments++;
            } else if (r.kind === 'Service') {
                totalServices++;
            }
        }

        namespaceHealth.set(ns, { healthy: nsHealthy, total: nsTotal });
    });

    // Add failing pods from health summary that we might have missed
    failingPods = Math.max(failingPods, healthSummary?.failing_pods?.length || 0);

    const warningEvents = events.filter(e => e.event_type === 'Warning').length;
    const criticalAlerts = alerts?.critical?.length || 0;
    const warningAlerts = alerts?.warning?.length || 0;

    // Calculate health score (0-100)
    let healthScore = 100;
    if (totalPods > 0) {
        healthScore -= (failingPods / totalPods) * 40; // Up to 40 points for pod failures
        healthScore -= (pendingPods / totalPods) * 10; // Up to 10 points for pending pods
    }
    if (totalDeployments > 0) {
        const unhealthyDeps = totalDeployments - healthyDeployments;
        healthScore -= (unhealthyDeps / totalDeployments) * 20; // Up to 20 points for deployment issues
    }
    healthScore -= Math.min(criticalAlerts * 5, 15); // Up to 15 points for critical alerts
    healthScore -= Math.min(warningAlerts * 2, 10); // Up to 10 points for warning alerts
    healthScore -= Math.min(warningEvents * 0.5, 5); // Up to 5 points for warning events
    healthScore = Math.max(0, Math.round(healthScore));

    return {
        healthScore,
        totalPods,
        healthyPods,
        failingPods,
        pendingPods,
        totalDeployments,
        healthyDeployments,
        totalServices,
        warningEvents,
        criticalAlerts,
        warningAlerts,
        namespaceHealth
    };
}

function buildTimeline(
    events: BundleEvent[],
    alerts: BundleAlerts | null,
    issues: DetectedIssue[]
): TimelineEvent[] {
    const timeline: TimelineEvent[] = [];

    // Add events
    for (const e of events) {
        timeline.push({
            id: `event-${e.name}-${e.namespace}`,
            timestamp: e.last_timestamp ? new Date(e.last_timestamp) : null,
            type: 'event',
            severity: e.event_type === 'Warning' ? 'warning' : 'normal',
            title: e.reason,
            description: e.message,
            namespace: e.namespace,
            resource: e.involved_object_name,
            resourceKind: e.involved_object_kind,
            count: e.count
        });
    }

    // Add alerts
    if (alerts?.critical) {
        for (const a of alerts.critical) {
            timeline.push({
                id: `alert-${a.name}`,
                timestamp: null,
                type: 'alert',
                severity: 'critical',
                title: a.name,
                description: a.message || '',
                namespace: a.labels['namespace'] || 'cluster',
                resource: a.labels['pod'] || a.name,
                resourceKind: 'Alert'
            });
        }
    }
    if (alerts?.warning) {
        for (const a of alerts.warning) {
            timeline.push({
                id: `alert-${a.name}`,
                timestamp: null,
                type: 'alert',
                severity: 'warning',
                title: a.name,
                description: a.message || '',
                namespace: a.labels['namespace'] || 'cluster',
                resource: a.labels['pod'] || a.name,
                resourceKind: 'Alert'
            });
        }
    }

    // Sort by timestamp (nulls last)
    return timeline.sort((a, b) => {
        if (!a.timestamp && !b.timestamp) return 0;
        if (!a.timestamp) return 1;
        if (!b.timestamp) return -1;
        return b.timestamp.getTime() - a.timestamp.getTime();
    });
}

function buildResourceGraph(
    allResources: Map<string, BundleResource[]>,
    issues: DetectedIssue[]
): ResourceNode[] {
    const nodes: ResourceNode[] = [];
    const issueResourceIds = new Set(issues.map(i => `${i.resourceKind}-${i.namespace}-${i.affectedResource}`));

    allResources.forEach((resources, ns) => {
        const deployments = resources.filter(r => r.kind === 'Deployment');
        const replicaSets = resources.filter(r => r.kind === 'ReplicaSet');
        const pods = resources.filter(r => r.kind === 'Pod');
        const services = resources.filter(r => r.kind === 'Service');

        for (const dep of deployments) {
            const depNode: ResourceNode = {
                id: `Deployment-${ns}-${dep.name}`,
                name: dep.name,
                kind: 'Deployment',
                namespace: ns,
                status: dep.status_phase || 'Unknown',
                hasIssue: issueResourceIds.has(`Deployment-${ns}-${dep.name}`),
                children: []
            };

            // Find ReplicaSets owned by this deployment
            const ownedRS = replicaSets.filter(rs => {
                const depName = rs.name.replace(/-[a-z0-9]+$/, '');
                return depName === dep.name;
            });

            for (const rs of ownedRS) {
                const rsNode: ResourceNode = {
                    id: `ReplicaSet-${ns}-${rs.name}`,
                    name: rs.name,
                    kind: 'ReplicaSet',
                    namespace: ns,
                    status: rs.status_phase || 'Unknown',
                    hasIssue: issueResourceIds.has(`ReplicaSet-${ns}-${rs.name}`),
                    children: [],
                    parent: depNode.id
                };

                // Find Pods owned by this ReplicaSet
                const rsHash = rs.labels['pod-template-hash'];
                const ownedPods = pods.filter(p =>
                    p.labels['pod-template-hash'] === rsHash
                );

                for (const pod of ownedPods) {
                    rsNode.children.push({
                        id: `Pod-${ns}-${pod.name}`,
                        name: pod.name,
                        kind: 'Pod',
                        namespace: ns,
                        status: pod.status_phase || 'Unknown',
                        hasIssue: issueResourceIds.has(`Pod-${ns}-${pod.name}`),
                        children: [],
                        parent: rsNode.id
                    });
                }

                depNode.children.push(rsNode);
            }

            nodes.push(depNode);
        }

        // Add standalone pods (not owned by ReplicaSet)
        const standalonePods = pods.filter(p => !p.labels['pod-template-hash']);
        for (const pod of standalonePods) {
            nodes.push({
                id: `Pod-${ns}-${pod.name}`,
                name: pod.name,
                kind: 'Pod',
                namespace: ns,
                status: pod.status_phase || 'Unknown',
                hasIssue: issueResourceIds.has(`Pod-${ns}-${pod.name}`),
                children: []
            });
        }
    });

    return nodes;
}

function globalSearch(
    query: string,
    allResources: Map<string, BundleResource[]>,
    events: BundleEvent[],
    alerts: BundleAlerts | null
): SearchResult[] {
    if (!query || query.length < 2) return [];
    const results: SearchResult[] = [];
    const q = query.toLowerCase();

    // Search resources
    allResources.forEach((resources, ns) => {
        for (const r of resources) {
            if (r.name.toLowerCase().includes(q) ||
                r.kind.toLowerCase().includes(q) ||
                Object.values(r.labels).some(v => v.toLowerCase().includes(q))) {
                results.push({
                    type: 'resource',
                    name: r.name,
                    namespace: ns,
                    match: r.name.includes(q) ? 'name' : 'labels',
                    snippet: `${r.kind} in ${ns}`,
                    resource: r
                });
            }
        }
    });

    // Search events
    for (const e of events) {
        if (e.message.toLowerCase().includes(q) ||
            e.reason.toLowerCase().includes(q) ||
            e.involved_object_name.toLowerCase().includes(q)) {
            results.push({
                type: 'event',
                name: e.reason,
                namespace: e.namespace,
                match: e.message.includes(q) ? 'message' : 'reason',
                snippet: e.message.slice(0, 100),
                event: e
            });
        }
    }

    // Search alerts
    if (alerts) {
        for (const a of [...(alerts.critical || []), ...(alerts.warning || [])]) {
            if (a.name.toLowerCase().includes(q) ||
                (a.message && a.message.toLowerCase().includes(q))) {
                results.push({
                    type: 'alert',
                    name: a.name,
                    namespace: a.labels['namespace'],
                    match: 'name',
                    snippet: a.message || a.state
                });
            }
        }
    }

    return results.slice(0, 50);
}

function generateReport(
    bundle: SupportBundle,
    overview: ClusterOverview,
    issues: DetectedIssue[],
    events: BundleEvent[]
): string {
    const lines: string[] = [];
    const now = new Date().toISOString();

    lines.push('# Support Bundle Analysis Report');
    lines.push(`Generated: ${now}`);
    lines.push(`Bundle: ${bundle.path}`);
    lines.push('');

    lines.push('## Health Score');
    lines.push(`**${overview.healthScore}/100**`);
    lines.push('');

    lines.push('## Summary');
    lines.push(`- Total Pods: ${overview.totalPods}`);
    lines.push(`- Healthy Pods: ${overview.healthyPods}`);
    lines.push(`- Failing Pods: ${overview.failingPods}`);
    lines.push(`- Pending Pods: ${overview.pendingPods}`);
    lines.push(`- Total Deployments: ${overview.totalDeployments}`);
    lines.push(`- Healthy Deployments: ${overview.healthyDeployments}`);
    lines.push(`- Warning Events: ${overview.warningEvents}`);
    lines.push(`- Critical Alerts: ${overview.criticalAlerts}`);
    lines.push('');

    if (issues.length > 0) {
        lines.push('## Detected Issues');
        lines.push('');

        const critical = issues.filter(i => i.severity === 'critical');
        const warning = issues.filter(i => i.severity === 'warning');

        if (critical.length > 0) {
            lines.push('### Critical');
            for (const issue of critical) {
                lines.push(`- **${issue.title}** (${issue.resourceKind}: ${issue.affectedResource})`);
                lines.push(`  - ${issue.description}`);
                lines.push(`  - Namespace: ${issue.namespace}`);
                if (issue.suggestions.length > 0) {
                    lines.push('  - Suggestions:');
                    for (const s of issue.suggestions) {
                        lines.push(`    - ${s}`);
                    }
                }
            }
            lines.push('');
        }

        if (warning.length > 0) {
            lines.push('### Warnings');
            for (const issue of warning) {
                lines.push(`- **${issue.title}** (${issue.resourceKind}: ${issue.affectedResource})`);
                lines.push(`  - ${issue.description}`);
                lines.push(`  - Namespace: ${issue.namespace}`);
            }
            lines.push('');
        }
    }

    lines.push('## Namespaces');
    for (const ns of bundle.namespaces) {
        const health = overview.namespaceHealth.get(ns);
        lines.push(`- ${ns}: ${health?.healthy || 0}/${health?.total || 0} healthy pods`);
    }

    return lines.join('\n');
}

function analyzeFailure(pod: BundleResource, events: BundleEvent[]): FailureAnalysis {
    const status = pod.status_phase?.toLowerCase() || '';
    const conditions = pod.conditions || [];
    const podEvents = events.filter(e =>
        e.involved_object_name === pod.name && e.involved_object_kind === 'Pod'
    );

    // Check for OOMKilled
    if (status.includes('oom') || podEvents.some(e => e.reason?.includes('OOM'))) {
        return {
            type: 'oom',
            title: 'Out of Memory',
            description: 'Container was killed because it exceeded memory limits',
            severity: 'critical',
            suggestions: [
                'Increase memory limits in the pod spec',
                'Check for memory leaks in the application',
                'Review application memory usage patterns',
                'Consider horizontal scaling instead of vertical'
            ]
        };
    }

    // Check for CrashLoopBackOff
    if (status.includes('crash') || status.includes('backoff')) {
        const exitCode = podEvents.find(e => e.message?.includes('exit code'))?.message;
        return {
            type: 'crash',
            title: 'CrashLoopBackOff',
            description: exitCode || 'Container keeps crashing and restarting',
            severity: 'critical',
            suggestions: [
                'Check container logs for error messages',
                'Verify environment variables and secrets are correct',
                'Ensure the application entrypoint is valid',
                'Check if required dependencies/services are available'
            ]
        };
    }

    // Check for ImagePull errors
    if (status.includes('image') || status.includes('pull') ||
        podEvents.some(e => e.reason?.includes('Pull') || e.reason?.includes('Image'))) {
        const imageEvent = podEvents.find(e => e.reason?.includes('Pull'));
        return {
            type: 'image',
            title: 'Image Pull Failed',
            description: imageEvent?.message || 'Cannot pull container image',
            severity: 'critical',
            suggestions: [
                'Verify the image name and tag are correct',
                'Check if image registry is accessible',
                'Ensure imagePullSecrets are configured if using private registry',
                'Verify network connectivity to the registry'
            ]
        };
    }

    // Check for Pending
    if (status === 'pending') {
        const schedulingEvent = podEvents.find(e =>
            e.reason?.includes('Schedul') || e.reason?.includes('Insufficient')
        );
        if (schedulingEvent?.message?.includes('Insufficient')) {
            return {
                type: 'pending',
                title: 'Insufficient Resources',
                description: schedulingEvent.message,
                severity: 'warning',
                suggestions: [
                    'Check cluster resource availability',
                    'Review pod resource requests',
                    'Consider scaling up the cluster',
                    'Check node taints and tolerations'
                ]
            };
        }
        return {
            type: 'pending',
            title: 'Pending',
            description: schedulingEvent?.message || 'Pod is waiting to be scheduled',
            severity: 'warning',
            suggestions: [
                'Check for node selector/affinity constraints',
                'Verify PersistentVolumeClaims are bound',
                'Check for resource quota limits',
                'Review pod scheduling constraints'
            ]
        };
    }

    // Check for Evicted
    if (status === 'evicted' || podEvents.some(e => e.reason === 'Evicted')) {
        return {
            type: 'evicted',
            title: 'Evicted',
            description: 'Pod was evicted from the node',
            severity: 'warning',
            suggestions: [
                'Check node disk pressure conditions',
                'Review pod resource usage',
                'Check for node memory pressure',
                'Consider adding resource limits'
            ]
        };
    }

    // Check conditions for unhealthy probes
    const readyCondition = conditions.find(c => c.condition_type === 'Ready');
    if (readyCondition?.status === 'False') {
        return {
            type: 'unhealthy',
            title: 'Not Ready',
            description: readyCondition.message || 'Pod failed readiness check',
            severity: 'warning',
            suggestions: [
                'Check readiness probe configuration',
                'Verify the application health endpoint',
                'Check container startup time',
                'Review application logs for errors'
            ]
        };
    }

    return {
        type: 'error',
        title: status || 'Error',
        description: 'Pod is in an unhealthy state',
        severity: 'warning',
        suggestions: ['Check pod events and logs for more details']
    };
}

function getStatusColor(status: string | null): string {
    if (!status) return 'zinc';
    const s = status.toLowerCase();
    if (s === 'running' || s === 'succeeded' || s === 'active' || s === 'bound') return 'emerald';
    if (s === 'pending') return 'amber';
    if (s.includes('crash') || s.includes('error') || s.includes('failed') || s.includes('oom')) return 'red';
    return 'zinc';
}

function formatAge(ts: string | null): string {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    if (mins > 0) return `${mins}m`;
    return 'now';
}

// ============================================================================
// HEALTH SCORE GAUGE
// ============================================================================

function HealthGauge({ score }: { score: number }) {
    const color = score >= 80 ? 'emerald' : score >= 60 ? 'amber' : 'red';
    const circumference = 2 * Math.PI * 45;
    const strokeDashoffset = circumference - (score / 100) * circumference;

    return (
        <div className="relative w-32 h-32">
            <svg className="w-full h-full transform -rotate-90">
                <circle
                    cx="64"
                    cy="64"
                    r="45"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="8"
                    className="text-zinc-800"
                />
                <circle
                    cx="64"
                    cy="64"
                    r="45"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="8"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={strokeDashoffset}
                    className={`text-${color}-500 transition-all duration-1000`}
                />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className={`text-3xl font-bold text-${color}-400`}>{score}</span>
                <span className="text-xs text-zinc-500">Health</span>
            </div>
        </div>
    );
}

// ============================================================================
// ISSUE CARD COMPONENT
// ============================================================================

function IssueCard({ issue, onClick, isSelected }: {
    issue: DetectedIssue;
    onClick: () => void;
    isSelected: boolean;
}) {
    const severityStyles = {
        critical: {
            border: 'border-red-500/30',
            bg: 'bg-gradient-to-r from-red-950/40 to-transparent',
            icon: 'bg-red-500/20 text-red-400',
            badge: 'bg-red-500/20 text-red-400'
        },
        warning: {
            border: 'border-amber-500/30',
            bg: 'bg-gradient-to-r from-amber-950/40 to-transparent',
            icon: 'bg-amber-500/20 text-amber-400',
            badge: 'bg-amber-500/20 text-amber-400'
        },
        info: {
            border: 'border-blue-500/30',
            bg: 'bg-gradient-to-r from-blue-950/40 to-transparent',
            icon: 'bg-blue-500/20 text-blue-400',
            badge: 'bg-blue-500/20 text-blue-400'
        }
    };

    const style = severityStyles[issue.severity];
    const Icon = issue.severity === 'critical' ? AlertOctagon : issue.severity === 'warning' ? AlertTriangle : Info;

    return (
        <button
            onClick={onClick}
            className={`w-full text-left p-4 rounded-xl border transition-all ${style.border} ${style.bg} ${isSelected ? 'ring-2 ring-violet-500/50' : 'hover:bg-white/5'
                }`}
        >
            <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-lg ${style.icon} flex items-center justify-center flex-shrink-0`}>
                    <Icon size={20} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-white truncate">{issue.title}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${style.badge}`}>
                            {issue.severity.toUpperCase()}
                        </span>
                    </div>
                    <p className="text-xs text-zinc-400 line-clamp-2">{issue.description}</p>
                    <div className="flex items-center gap-2 mt-2 text-[10px] text-zinc-500">
                        <span className="flex items-center gap-1">
                            <Box size={10} />
                            {issue.resourceKind}
                        </span>
                        <span>·</span>
                        <span className="truncate">{issue.affectedResource}</span>
                        <span>·</span>
                        <span>{issue.namespace}</span>
                    </div>
                </div>
                <ChevronRight size={16} className="text-zinc-600 flex-shrink-0" />
            </div>
        </button>
    );
}

// ============================================================================
// DETAIL PANEL COMPONENT
// ============================================================================

function DetailPanel({ issue, bundle, events, onClose, onNavigateToResource }: {
    issue: DetectedIssue | null;
    bundle: SupportBundle;
    events: BundleEvent[];
    onClose: () => void;
    onNavigateToResource: (resource: string, kind: string, namespace: string) => void;
}) {
    if (!issue) return null;

    return (
        <div className="h-full flex flex-col bg-zinc-900">
            {/* Header */}
            <div className="flex-none p-4 border-b border-white/10">
                <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                            <span className={`w-2 h-2 rounded-full ${issue.severity === 'critical' ? 'bg-red-500' :
                                issue.severity === 'warning' ? 'bg-amber-500' : 'bg-blue-500'
                                }`} />
                            <h2 className="text-lg font-semibold text-white truncate">{issue.title}</h2>
                        </div>
                        <p className="text-sm text-zinc-400">{issue.resourceKind}: {issue.affectedResource}</p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg text-zinc-400">
                        <X size={18} />
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 space-y-6">
                {/* Description */}
                <div>
                    <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Description</h3>
                    <p className="text-sm text-zinc-300">{issue.description}</p>
                </div>

                {/* Root Cause */}
                {issue.rootCause && (
                    <div>
                        <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Root Cause</h3>
                        <div className="p-3 bg-zinc-800/50 rounded-lg border border-white/5">
                            <p className="text-sm text-zinc-300">{issue.rootCause}</p>
                        </div>
                    </div>
                )}

                {/* Affected Resource */}
                <div>
                    <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Affected Resource</h3>
                    <button
                        onClick={() => onNavigateToResource(issue.affectedResource, issue.resourceKind, issue.namespace)}
                        className="w-full p-3 bg-zinc-800/50 rounded-lg border border-white/5 hover:border-violet-500/30 transition-colors text-left"
                    >
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium text-white">{issue.affectedResource}</p>
                                <p className="text-xs text-zinc-500">{issue.resourceKind} · {issue.namespace}</p>
                            </div>
                            <ExternalLink size={14} className="text-zinc-500" />
                        </div>
                    </button>
                </div>

                {/* Suggestions */}
                {issue.suggestions.length > 0 && (
                    <div>
                        <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">Suggested Actions</h3>
                        <div className="space-y-2">
                            {issue.suggestions.map((s, i) => (
                                <div key={i} className="flex items-start gap-2 p-3 bg-emerald-500/5 rounded-lg border border-emerald-500/20">
                                    <Zap size={14} className="text-emerald-400 mt-0.5 flex-shrink-0" />
                                    <p className="text-sm text-zinc-300">{s}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Related Events */}
                {issue.relatedEvents.length > 0 && (
                    <div>
                        <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">
                            Related Events ({issue.relatedEvents.length})
                        </h3>
                        <div className="space-y-2 max-h-60 overflow-y-auto">
                            {issue.relatedEvents.slice(0, 10).map((e, i) => (
                                <div
                                    key={i}
                                    className={`p-3 rounded-lg border ${e.event_type === 'Warning'
                                        ? 'bg-amber-500/5 border-amber-500/20'
                                        : 'bg-zinc-800/50 border-white/5'
                                        }`}
                                >
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className={`w-1.5 h-1.5 rounded-full ${e.event_type === 'Warning' ? 'bg-amber-500' : 'bg-blue-500'
                                            }`} />
                                        <span className="text-xs font-medium text-white">{e.reason}</span>
                                        {e.count > 1 && (
                                            <span className="text-[10px] text-zinc-500">×{e.count}</span>
                                        )}
                                        {e.last_timestamp && (
                                            <span className="text-[10px] text-zinc-600 ml-auto">{formatAge(e.last_timestamp)}</span>
                                        )}
                                    </div>
                                    <p className="text-xs text-zinc-400 line-clamp-2">{e.message}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ============================================================================
// RESOURCE DETAIL PANEL
// ============================================================================

interface ResourceDetailProps {
    resource: BundleResource;
    yaml: string;
    logs?: string;
    logFiles: BundleLogFile[];
    events: BundleEvent[];
    onClose: () => void;
    onLoadLog: (lf: BundleLogFile) => void;
    selectedLogFile?: BundleLogFile;
}

function ResourceDetail({ resource, yaml, logs, logFiles, events, onClose, onLoadLog, selectedLogFile }: ResourceDetailProps) {
    const [tab, setTab] = useState<'overview' | 'events' | 'logs' | 'yaml'>('overview');
    const [copied, setCopied] = useState(false);
    const [logFilter, setLogFilter] = useState<'all' | 'error' | 'warn'>('all');

    const copyYaml = async () => {
        await navigator.clipboard.writeText(yaml);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const statusColor = getStatusColor(resource.status_phase);
    const resourceEvents = events.filter(e =>
        e.involved_object_name === resource.name &&
        e.involved_object_kind === resource.kind
    );

    // Parse logs for highlighting
    const parsedLogs = useMemo(() => {
        if (!logs) return [];
        return logs.split('\n').map((line, i) => {
            const lowerLine = line.toLowerCase();
            let level: 'error' | 'warn' | 'info' | 'debug' | 'normal' = 'normal';
            if (lowerLine.includes('error') || lowerLine.includes('fatal') || lowerLine.includes('panic')) {
                level = 'error';
            } else if (lowerLine.includes('warn')) {
                level = 'warn';
            } else if (lowerLine.includes('info')) {
                level = 'info';
            } else if (lowerLine.includes('debug')) {
                level = 'debug';
            }
            return { line, level, index: i };
        });
    }, [logs]);

    const filteredLogs = useMemo(() => {
        if (logFilter === 'all') return parsedLogs;
        if (logFilter === 'error') return parsedLogs.filter(l => l.level === 'error');
        if (logFilter === 'warn') return parsedLogs.filter(l => l.level === 'error' || l.level === 'warn');
        return parsedLogs;
    }, [parsedLogs, logFilter]);

    const errorCount = parsedLogs.filter(l => l.level === 'error').length;
    const warnCount = parsedLogs.filter(l => l.level === 'warn').length;

    return (
        <div className="h-full flex flex-col bg-zinc-900">
            {/* Header */}
            <div className="flex-none p-4 border-b border-white/10 bg-zinc-900/80">
                <div className="flex items-start justify-between">
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-lg font-semibold text-white">{resource.name}</h2>
                            <span className={`text-xs px-2 py-0.5 rounded-full bg-${statusColor}-500/20 text-${statusColor}-400 border border-${statusColor}-500/30`}>
                                {resource.status_phase || 'Unknown'}
                            </span>
                        </div>
                        <p className="text-sm text-zinc-500 mt-1">{resource.kind} · {resource.namespace || 'cluster-scoped'}</p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg text-zinc-400">
                        <X size={18} />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex items-center gap-1 mt-4 bg-zinc-800/50 rounded-lg p-1 w-fit">
                    {[
                        { id: 'overview', label: 'Overview' },
                        { id: 'events', label: 'Events', count: resourceEvents.length },
                        { id: 'logs', label: 'Logs', show: logFiles.length > 0, errorCount },
                        { id: 'yaml', label: 'YAML' }
                    ].filter(t => t.show !== false).map(t => (
                        <button
                            key={t.id}
                            onClick={() => setTab(t.id as typeof tab)}
                            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1.5 ${tab === t.id ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-white'
                                }`}
                        >
                            {t.label}
                            {t.count !== undefined && t.count > 0 && (
                                <span className="text-[10px] text-zinc-500">({t.count})</span>
                            )}
                            {t.id === 'logs' && t.errorCount !== undefined && t.errorCount > 0 && (
                                <span className="text-[10px] px-1 py-0.5 bg-red-500/20 text-red-400 rounded">{t.errorCount}</span>
                            )}
                        </button>
                    ))}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4">
                {tab === 'overview' && (
                    <div className="space-y-4">
                        {/* Conditions */}
                        {resource.conditions.length > 0 && (
                            <div>
                                <h3 className="text-sm font-medium text-zinc-300 mb-3">Conditions</h3>
                                <div className="space-y-2">
                                    {resource.conditions.map((c, i) => (
                                        <div
                                            key={i}
                                            className={`p-3 rounded-xl border ${c.status === 'True'
                                                ? 'bg-emerald-500/5 border-emerald-500/20'
                                                : c.status === 'False'
                                                    ? 'bg-red-500/5 border-red-500/20'
                                                    : 'bg-zinc-800/50 border-white/5'
                                                }`}
                                        >
                                            <div className="flex items-center justify-between">
                                                <span className="text-sm font-medium text-white">{c.condition_type}</span>
                                                <span className={`text-xs px-2 py-0.5 rounded-full ${c.status === 'True'
                                                    ? 'bg-emerald-500/20 text-emerald-400'
                                                    : c.status === 'False'
                                                        ? 'bg-red-500/20 text-red-400'
                                                        : 'bg-zinc-700 text-zinc-400'
                                                    }`}>
                                                    {c.status}
                                                </span>
                                            </div>
                                            {c.reason && <p className="text-xs text-zinc-400 mt-1">{c.reason}</p>}
                                            {c.message && <p className="text-xs text-zinc-500 mt-1">{c.message}</p>}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Labels */}
                        {Object.keys(resource.labels).length > 0 && (
                            <div>
                                <h3 className="text-sm font-medium text-zinc-300 mb-3">Labels</h3>
                                <div className="flex flex-wrap gap-1.5">
                                    {Object.entries(resource.labels).map(([k, v]) => (
                                        <span key={k} className="text-xs px-2 py-1 bg-zinc-800 text-zinc-400 rounded-lg">
                                            {k}: <span className="text-zinc-300">{v}</span>
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {tab === 'events' && (
                    <div className="space-y-2">
                        {resourceEvents.length === 0 ? (
                            <div className="text-center py-8 text-zinc-500">No events for this resource</div>
                        ) : (
                            resourceEvents.map((e, i) => (
                                <div
                                    key={i}
                                    className={`p-3 rounded-xl border ${e.event_type === 'Warning'
                                        ? 'bg-amber-500/5 border-amber-500/20'
                                        : 'bg-zinc-800/50 border-white/5'
                                        }`}
                                >
                                    <div className="flex items-center gap-2">
                                        <span className={`w-2 h-2 rounded-full ${e.event_type === 'Warning' ? 'bg-amber-500' : 'bg-blue-500'}`} />
                                        <span className="text-sm font-medium text-white">{e.reason}</span>
                                        {e.count > 1 && <span className="text-xs text-zinc-500">×{e.count}</span>}
                                        {e.last_timestamp && (
                                            <span className="text-xs text-zinc-600 ml-auto">{formatAge(e.last_timestamp)}</span>
                                        )}
                                    </div>
                                    <p className="text-sm text-zinc-400 mt-1">{e.message}</p>
                                </div>
                            ))
                        )}
                    </div>
                )}

                {tab === 'logs' && (
                    <div className="space-y-3">
                        {/* Container selector */}
                        <div className="flex items-center justify-between">
                            <div className="flex flex-wrap gap-1.5">
                                {logFiles.map(lf => (
                                    <button
                                        key={lf.file_path}
                                        onClick={() => onLoadLog(lf)}
                                        className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${selectedLogFile?.file_path === lf.file_path
                                            ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                                            : 'bg-zinc-800 text-zinc-400 hover:text-white border border-transparent'
                                            }`}
                                    >
                                        {lf.container}
                                    </button>
                                ))}
                            </div>
                            {logs && (
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => setLogFilter('all')}
                                        className={`px-2 py-1 text-xs rounded ${logFilter === 'all' ? 'bg-white/10 text-white' : 'text-zinc-500'}`}
                                    >
                                        All
                                    </button>
                                    <button
                                        onClick={() => setLogFilter('error')}
                                        className={`px-2 py-1 text-xs rounded flex items-center gap-1 ${logFilter === 'error' ? 'bg-red-500/20 text-red-400' : 'text-zinc-500'}`}
                                    >
                                        Errors {errorCount > 0 && `(${errorCount})`}
                                    </button>
                                    <button
                                        onClick={() => setLogFilter('warn')}
                                        className={`px-2 py-1 text-xs rounded flex items-center gap-1 ${logFilter === 'warn' ? 'bg-amber-500/20 text-amber-400' : 'text-zinc-500'}`}
                                    >
                                        + Warn {warnCount > 0 && `(${warnCount})`}
                                    </button>
                                </div>
                            )}
                        </div>
                        {logs ? (
                            <div className="bg-black/50 rounded-xl border border-white/5 overflow-hidden">
                                <div className="max-h-[60vh] overflow-auto">
                                    {filteredLogs.map((l, i) => (
                                        <div
                                            key={i}
                                            className={`px-3 py-0.5 text-[11px] font-mono border-l-2 ${l.level === 'error' ? 'bg-red-500/10 text-red-300 border-red-500' :
                                                l.level === 'warn' ? 'bg-amber-500/5 text-amber-300 border-amber-500' :
                                                    l.level === 'info' ? 'text-blue-300 border-blue-500/50' :
                                                        l.level === 'debug' ? 'text-zinc-500 border-zinc-700' :
                                                            'text-zinc-400 border-transparent'
                                                }`}
                                        >
                                            <span className="text-zinc-600 mr-2 select-none">{l.index + 1}</span>
                                            {l.line}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <div className="text-center py-8 text-zinc-500">Select a container to view logs</div>
                        )}
                    </div>
                )}

                {tab === 'yaml' && (
                    <div className="bg-black/50 rounded-xl border border-white/5 overflow-hidden">
                        <div className="px-3 py-2 bg-white/5 border-b border-white/5 flex justify-between">
                            <span className="text-xs text-zinc-500">YAML</span>
                            <button onClick={copyYaml} className="text-xs text-zinc-400 hover:text-white flex items-center gap-1">
                                {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                                {copied ? 'Copied' : 'Copy'}
                            </button>
                        </div>
                        <pre className="p-4 text-[11px] font-mono text-zinc-300 overflow-auto max-h-[60vh]">
                            {yaml}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

// Pre-loaded bundle data from ConnectionScreen
export interface PreloadedBundleData {
    bundle: SupportBundle;
    healthSummary: BundleHealthSummary;
    events: BundleEvent[];
    alerts: BundleAlerts | null;
    allResources: Map<string, BundleResource[]>;
}

interface BundleDashboardProps {
    onClose?: () => void;
    preloadedData?: PreloadedBundleData;
}

export function BundleDashboard({ onClose, preloadedData }: BundleDashboardProps) {
    // Bundle state - initialize from preloadedData if provided
    const [bundle, setBundle] = useState<SupportBundle | null>(preloadedData?.bundle ?? null);
    const [loading, setLoading] = useState(false);
    const [loadingProgress, setLoadingProgress] = useState('');
    const [error, setError] = useState<string | null>(null);

    // Data - initialize from preloadedData if provided
    const [healthSummary, setHealthSummary] = useState<BundleHealthSummary | null>(preloadedData?.healthSummary ?? null);
    const [events, setEvents] = useState<BundleEvent[]>(preloadedData?.events ?? []);
    const [alerts, setAlerts] = useState<BundleAlerts | null>(preloadedData?.alerts ?? null);
    const [allResources, setAllResources] = useState<Map<string, BundleResource[]>>(preloadedData?.allResources ?? new Map());

    // UI state
    const [view, setView] = useState<'issues' | 'overview' | 'explore' | 'events' | 'timeline' | 'graph'>('issues');
    const [selectedIssue, setSelectedIssue] = useState<DetectedIssue | null>(null);
    const [selectedResource, setSelectedResource] = useState<BundleResource | null>(null);
    const [resourceYaml, setResourceYaml] = useState('');
    const [logFiles, setLogFiles] = useState<BundleLogFile[]>([]);
    const [logContent, setLogContent] = useState('');
    const [selectedLogFile, setSelectedLogFile] = useState<BundleLogFile | undefined>();
    const [showRightPanel, setShowRightPanel] = useState(true);
    const [showAIChat, setShowAIChat] = useState(false);

    // Explore state - initialize selectedNs from preloaded bundle if available
    const [selectedNs, setSelectedNs] = useState<string | null>(preloadedData?.bundle.namespaces[0] ?? null);
    const [selectedType, setSelectedType] = useState<string | null>(null);
    const [resourceTypes, setResourceTypes] = useState<string[]>([]);
    const [resources, setResources] = useState<BundleResource[]>([]);
    const [search, setSearch] = useState('');

    // Filter state
    const [filters, setFilters] = useState<FilterState>({
        status: [],
        resourceTypes: [],
        namespaces: [],
        issueTypes: [],
        severity: [],
        hasLogs: null,
        timeRange: 'all'
    });
    const [showFilters, setShowFilters] = useState(false);

    // Search state
    const [globalSearchQuery, setGlobalSearchQuery] = useState('');
    const [showSearch, setShowSearch] = useState(false);

    // Timeline/Graph state
    const [timelineFilter, setTimelineFilter] = useState<'all' | 'critical' | 'warning'>('all');
    const [graphNamespace, setGraphNamespace] = useState<string | null>(null);
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

    // Explore view status filter
    const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'pending' | 'failed' | 'issues'>('all');

    // Computed values
    const detectedIssues = useMemo(() =>
        analyzeBundle(allResources, events, alerts, healthSummary),
        [allResources, events, alerts, healthSummary]
    );

    const clusterOverview = useMemo(() =>
        computeOverview(allResources, events, alerts, healthSummary),
        [allResources, events, alerts, healthSummary]
    );

    const filteredIssues = useMemo(() => {
        let result = detectedIssues;
        if (filters.severity.length > 0) {
            result = result.filter(i => filters.severity.includes(i.severity));
        }
        if (filters.namespaces.length > 0) {
            result = result.filter(i => filters.namespaces.includes(i.namespace));
        }
        if (filters.issueTypes.length > 0) {
            result = result.filter(i => filters.issueTypes.includes(i.type));
        }
        return result;
    }, [detectedIssues, filters]);

    const timeline = useMemo(() =>
        buildTimeline(events, alerts, detectedIssues),
        [events, alerts, detectedIssues]
    );

    const filteredTimeline = useMemo(() => {
        if (timelineFilter === 'all') return timeline;
        return timeline.filter(t => t.severity === timelineFilter);
    }, [timeline, timelineFilter]);

    const resourceGraph = useMemo(() =>
        buildResourceGraph(allResources, detectedIssues),
        [allResources, detectedIssues]
    );

    const filteredGraph = useMemo(() => {
        if (!graphNamespace) return resourceGraph;
        return resourceGraph.filter(n => n.namespace === graphNamespace);
    }, [resourceGraph, graphNamespace]);

    const searchResults = useMemo(() =>
        globalSearch(globalSearchQuery, allResources, events, alerts),
        [globalSearchQuery, allResources, events, alerts]
    );

    const criticalCount = detectedIssues.filter(i => i.severity === 'critical').length;
    const warningCount = detectedIssues.filter(i => i.severity === 'warning').length;
    const warningEvents = useMemo(() => events.filter(e => e.event_type === 'Warning'), [events]);

    // Load resource types for explore view
    useEffect(() => {
        if (!bundle || !selectedNs) return;
        invoke<string[]>('get_bundle_resource_types', { bundlePath: bundle.path, namespace: selectedNs })
            .then(types => {
                setResourceTypes(types);
                setSelectedType(types.includes('pods') ? 'pods' : types[0] || null);
            });
    }, [bundle, selectedNs]);

    // Load resources for explore view
    useEffect(() => {
        if (!bundle || !selectedNs || !selectedType) return;
        invoke<BundleResource[]>('get_bundle_resources', { bundlePath: bundle.path, namespace: selectedNs, resourceType: selectedType })
            .then(r => {
                setResources(r);
                setSelectedResource(null);
            });
    }, [bundle, selectedNs, selectedType]);

    // Load YAML when resource selected
    useEffect(() => {
        if (!bundle || !selectedResource) return;
        const type = selectedResource.kind.toLowerCase() + 's';
        invoke<string>('get_bundle_resource_yaml', {
            bundlePath: bundle.path,
            namespace: selectedResource.namespace,
            resourceType: type,
            name: selectedResource.name
        }).then(setResourceYaml);
    }, [bundle, selectedResource]);

    // Load log files when pod selected
    useEffect(() => {
        if (!bundle || !selectedResource || selectedResource.kind !== 'Pod') {
            setLogFiles([]);
            return;
        }
        invoke<BundleLogFile[]>('get_bundle_log_files', {
            bundlePath: bundle.path,
            namespace: selectedResource.namespace || '',
            pod: selectedResource.name
        }).then(setLogFiles);
    }, [bundle, selectedResource]);

    const loadLog = async (lf: BundleLogFile) => {
        if (!bundle) return;
        setSelectedLogFile(lf);
        const content = await invoke<string>('get_bundle_logs', {
            bundlePath: bundle.path,
            namespace: lf.namespace,
            pod: lf.pod,
            container: lf.container,
            tail: 500
        });
        setLogContent(content);
    };

    const closeBundle = async () => {
        await invoke('close_support_bundle');
        setBundle(null);
        setAllResources(new Map());
        onClose?.();
    };

    const exportReport = async () => {
        if (!bundle) return;
        const report = generateReport(bundle, clusterOverview, detectedIssues, events);
        const path = await save({
            defaultPath: `bundle-report-${new Date().toISOString().split('T')[0]}.md`,
            filters: [{ name: 'Markdown', extensions: ['md'] }]
        });
        if (path) {
            // For now, just copy to clipboard since we can't write files directly
            await navigator.clipboard.writeText(report);
            // TODO: Write to file using Tauri
        }
    };

    const navigateToResource = (name: string, kind: string, namespace: string) => {
        setView('explore');
        setSelectedNs(namespace);
        setSelectedType(kind.toLowerCase() + 's');
        // Resource will be selected once it loads
    };

    const filteredResources = useMemo(() => {
        let result = resources;

        // Apply search filter
        if (search) {
            result = result.filter(r => r.name.toLowerCase().includes(search.toLowerCase()));
        }

        // Apply status filter
        if (statusFilter !== 'all') {
            result = result.filter(r => {
                const phase = (r.status_phase || '').toLowerCase();
                switch (statusFilter) {
                    case 'running':
                        return phase === 'running' || phase === 'succeeded' || phase === 'active' || phase === 'bound' || phase === 'ready';
                    case 'pending':
                        return phase === 'pending' || phase === 'waiting' || phase === 'containercreating';
                    case 'failed':
                        return phase.includes('crash') || phase.includes('error') || phase.includes('failed') ||
                            phase.includes('oom') || phase === 'evicted' || phase === 'terminated';
                    case 'issues':
                        return detectedIssues.some(i => i.affectedResource === r.name);
                    default:
                        return true;
                }
            });
        }

        return result;
    }, [resources, search, statusFilter, detectedIssues]);

    // =========================================================================
    // RENDER: No bundle (shouldn't happen with preloadedData)
    // =========================================================================
    if (!bundle) {
        return (
            <div className="h-full flex items-center justify-center bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950">
                <div className="text-center max-w-md mx-auto px-8">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-zinc-800 border border-zinc-700 flex items-center justify-center">
                        <Archive size={32} className="text-zinc-400" />
                    </div>
                    <h2 className="text-xl font-semibold text-white mb-2">No Bundle Loaded</h2>
                    <p className="text-zinc-400 text-sm mb-6">Please select a bundle from the connection screen.</p>
                    <button
                        onClick={onClose}
                        className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-sm"
                    >
                        Back
                    </button>
                </div>
            </div>
        );
    }

    // =========================================================================
    // RENDER: Main dashboard
    // =========================================================================
    return (
        <div className="h-full flex flex-col bg-zinc-950">
            {/* Header */}
            <header className="flex-none h-14 px-4 border-b border-white/10 bg-zinc-900/80 backdrop-blur flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <button onClick={closeBundle} className="p-2 hover:bg-white/10 rounded-lg text-zinc-400 hover:text-white">
                        <ArrowLeft size={18} />
                    </button>
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-red-500/20 to-orange-500/20 border border-red-500/30 flex items-center justify-center">
                            <Archive size={16} className="text-red-400" />
                        </div>
                        <div>
                            <h1 className="text-sm font-semibold text-white">{bundle.path.split('/').pop()}</h1>
                            <div className="flex items-center gap-2 text-[11px]">
                                <span className="text-zinc-500">{bundle.total_resources} resources</span>
                                <span className={`flex items-center gap-1 ${clusterOverview.healthScore >= 80 ? 'text-emerald-400' : clusterOverview.healthScore >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
                                    <Gauge size={10} />
                                    {clusterOverview.healthScore}%
                                </span>
                                {criticalCount > 0 && (
                                    <span className="text-red-400">· {criticalCount} critical</span>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Search & Actions */}
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                        <input
                            type="text"
                            placeholder="Search..."
                            value={globalSearchQuery}
                            onChange={(e) => setGlobalSearchQuery(e.target.value)}
                            onFocus={() => setShowSearch(true)}
                            className="w-48 pl-9 pr-3 py-1.5 bg-zinc-800/50 border border-white/10 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500/50"
                        />
                        {showSearch && searchResults.length > 0 && (
                            <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-white/10 rounded-lg shadow-xl max-h-80 overflow-y-auto z-50">
                                {searchResults.slice(0, 10).map((r, i) => (
                                    <button
                                        key={i}
                                        onClick={() => {
                                            if (r.resource) {
                                                setSelectedResource(r.resource);
                                                setView('explore');
                                            }
                                            setShowSearch(false);
                                            setGlobalSearchQuery('');
                                        }}
                                        className="w-full p-3 text-left hover:bg-white/5 border-b border-white/5 last:border-0"
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.type === 'resource' ? 'bg-violet-500/20 text-violet-400' :
                                                r.type === 'event' ? 'bg-amber-500/20 text-amber-400' :
                                                    'bg-red-500/20 text-red-400'
                                                }`}>{r.type}</span>
                                            <span className="text-sm text-white truncate">{r.name}</span>
                                        </div>
                                        <p className="text-xs text-zinc-500 mt-1 truncate">{r.snippet}</p>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    <button
                        onClick={() => {
                            setShowAIChat(!showAIChat);
                            if (!showAIChat) {
                                setShowRightPanel(true);
                                setSelectedIssue(null);
                                setSelectedResource(null);
                            }
                        }}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all ${showAIChat
                            ? 'bg-purple-500/20 border-purple-500/30 text-purple-300'
                            : 'bg-zinc-800/50 border-white/10 text-zinc-400 hover:text-white hover:bg-zinc-800'
                            }`}
                    >
                        <Sparkles size={14} />
                        <span className="text-xs font-medium">Ask AI</span>
                    </button>
                    <button
                        onClick={exportReport}
                        className="p-2 hover:bg-white/10 rounded-lg text-zinc-400 hover:text-white"
                        title="Export Report"
                    >
                        <Download size={16} />
                    </button>
                    <button
                        onClick={() => setShowRightPanel(!showRightPanel)}
                        className="p-2 hover:bg-white/10 rounded-lg text-zinc-400 hover:text-white"
                    >
                        {showRightPanel ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
                    </button>
                </div>
            </header>

            {/* Navigation */}
            <nav className="flex-none px-4 py-2 border-b border-white/10 bg-zinc-900/50 flex items-center gap-1">
                {[
                    { id: 'issues', label: 'Issues', icon: AlertOctagon, count: detectedIssues.length, color: 'red' },
                    { id: 'overview', label: 'Overview', icon: BarChart3 },
                    { id: 'timeline', label: 'Timeline', icon: Calendar },
                    { id: 'graph', label: 'Graph', icon: GitBranch },
                    { id: 'events', label: 'Events', icon: Activity, count: warningEvents.length, color: 'amber' },
                    { id: 'explore', label: 'Explore', icon: Search },
                ].map(nav => (
                    <button
                        key={nav.id}
                        onClick={() => setView(nav.id as typeof view)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${view === nav.id
                            ? `bg-${nav.color || 'white'}-500/20 text-${nav.color ? nav.color + '-400' : 'white'}`
                            : 'text-zinc-500 hover:text-white hover:bg-white/5'
                            }`}
                    >
                        <nav.icon size={14} />
                        {nav.label}
                        {nav.count !== undefined && nav.count > 0 && (
                            <span className={`ml-1 px-1.5 py-0.5 text-[10px] bg-${nav.color || 'zinc'}-500/30 rounded-full`}>
                                {nav.count}
                            </span>
                        )}
                    </button>
                ))}
            </nav>

            {/* Main Content */}
            <div className="flex-1 min-h-0 flex overflow-hidden">
                {/* Left Content */}
                <div className={`flex-1 min-h-0 overflow-hidden flex flex-col ${showRightPanel && (selectedIssue || selectedResource || showAIChat) ? 'w-2/3' : 'w-full'}`}>
                    {/* ISSUES VIEW */}
                    {view === 'issues' && (
                        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-6">
                            {filteredIssues.length === 0 ? (
                                <div className="h-full flex items-center justify-center">
                                    <div className="text-center p-8">
                                        <div className="w-20 h-20 mx-auto rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-4">
                                            <CheckCircle size={36} className="text-emerald-400" />
                                        </div>
                                        <h2 className="text-xl font-semibold text-white mb-2">No Issues Detected</h2>
                                        <p className="text-zinc-500 max-w-md">
                                            All resources in this bundle appear healthy.
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <div className="max-w-3xl mx-auto space-y-3">
                                    <div className="flex items-center justify-between mb-4">
                                        <h2 className="text-lg font-semibold text-white">
                                            {filteredIssues.length} Issue{filteredIssues.length !== 1 ? 's' : ''} Detected
                                        </h2>
                                        <div className="flex items-center gap-2">
                                            <span className="flex items-center gap-1 text-xs text-red-400">
                                                <span className="w-2 h-2 rounded-full bg-red-500" />
                                                {criticalCount} Critical
                                            </span>
                                            <span className="flex items-center gap-1 text-xs text-amber-400">
                                                <span className="w-2 h-2 rounded-full bg-amber-500" />
                                                {warningCount} Warning
                                            </span>
                                        </div>
                                    </div>
                                    {filteredIssues.map(issue => (
                                        <IssueCard
                                            key={issue.id}
                                            issue={issue}
                                            onClick={() => setSelectedIssue(issue)}
                                            isSelected={selectedIssue?.id === issue.id}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* OVERVIEW VIEW */}
                    {view === 'overview' && (
                        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-6">
                            <div className="max-w-4xl mx-auto space-y-6">
                                {/* Health Score */}
                                <div className="flex items-center gap-8 p-6 bg-zinc-900/50 rounded-2xl border border-white/5">
                                    <HealthGauge score={clusterOverview.healthScore} />
                                    <div className="flex-1 grid grid-cols-4 gap-4">
                                        <div className="text-center">
                                            <p className="text-2xl font-bold text-white">{clusterOverview.totalPods}</p>
                                            <p className="text-xs text-zinc-500">Total Pods</p>
                                        </div>
                                        <div className="text-center">
                                            <p className="text-2xl font-bold text-emerald-400">{clusterOverview.healthyPods}</p>
                                            <p className="text-xs text-zinc-500">Healthy</p>
                                        </div>
                                        <div className="text-center">
                                            <p className="text-2xl font-bold text-red-400">{clusterOverview.failingPods}</p>
                                            <p className="text-xs text-zinc-500">Failing</p>
                                        </div>
                                        <div className="text-center">
                                            <p className="text-2xl font-bold text-amber-400">{clusterOverview.pendingPods}</p>
                                            <p className="text-xs text-zinc-500">Pending</p>
                                        </div>
                                    </div>
                                </div>

                                {/* Stats Grid */}
                                <div className="grid grid-cols-4 gap-4">
                                    <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                                        <div className="flex items-center gap-2 mb-2">
                                            <Layers size={16} className="text-purple-400" />
                                            <span className="text-xs text-zinc-500">Deployments</span>
                                        </div>
                                        <p className="text-xl font-bold text-white">
                                            {clusterOverview.healthyDeployments}/{clusterOverview.totalDeployments}
                                        </p>
                                    </div>
                                    <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                                        <div className="flex items-center gap-2 mb-2">
                                            <Network size={16} className="text-cyan-400" />
                                            <span className="text-xs text-zinc-500">Services</span>
                                        </div>
                                        <p className="text-xl font-bold text-white">{clusterOverview.totalServices}</p>
                                    </div>
                                    <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                                        <div className="flex items-center gap-2 mb-2">
                                            <AlertTriangle size={16} className="text-amber-400" />
                                            <span className="text-xs text-zinc-500">Warning Events</span>
                                        </div>
                                        <p className="text-xl font-bold text-amber-400">{clusterOverview.warningEvents}</p>
                                    </div>
                                    <div className="p-4 bg-zinc-900/50 rounded-xl border border-white/5">
                                        <div className="flex items-center gap-2 mb-2">
                                            <Shield size={16} className="text-red-400" />
                                            <span className="text-xs text-zinc-500">Critical Alerts</span>
                                        </div>
                                        <p className="text-xl font-bold text-red-400">{clusterOverview.criticalAlerts}</p>
                                    </div>
                                </div>

                                {/* Namespace Health */}
                                <div className="p-6 bg-zinc-900/50 rounded-2xl border border-white/5">
                                    <h3 className="text-sm font-medium text-zinc-400 mb-4">Namespace Health</h3>
                                    <div className="space-y-3">
                                        {Array.from(clusterOverview.namespaceHealth.entries()).map(([ns, health]) => (
                                            <div key={ns} className="flex items-center gap-4">
                                                <span className="text-sm text-white w-40 truncate">{ns}</span>
                                                <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
                                                    <div
                                                        className={`h-full ${health.total === 0 ? 'bg-zinc-600' : health.healthy === health.total ? 'bg-emerald-500' : 'bg-amber-500'}`}
                                                        style={{ width: `${health.total === 0 ? 0 : (health.healthy / health.total) * 100}%` }}
                                                    />
                                                </div>
                                                <span className="text-xs text-zinc-500 w-16 text-right">
                                                    {health.healthy}/{health.total}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* TIMELINE VIEW */}
                    {view === 'timeline' && (
                        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-6">
                            <div className="max-w-3xl mx-auto">
                                <div className="flex items-center justify-between mb-4">
                                    <h2 className="text-lg font-semibold text-white">Event Timeline</h2>
                                    <div className="flex items-center gap-1">
                                        {(['all', 'critical', 'warning'] as const).map(f => (
                                            <button
                                                key={f}
                                                onClick={() => setTimelineFilter(f)}
                                                className={`px-3 py-1 text-xs rounded-lg ${timelineFilter === f
                                                    ? f === 'critical' ? 'bg-red-500/20 text-red-400' :
                                                        f === 'warning' ? 'bg-amber-500/20 text-amber-400' :
                                                            'bg-white/10 text-white'
                                                    : 'text-zinc-500 hover:text-white'
                                                    }`}
                                            >
                                                {f.charAt(0).toUpperCase() + f.slice(1)}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="relative pl-8 space-y-4">
                                    <div className="absolute left-3 top-0 bottom-0 w-px bg-zinc-800" />
                                    {filteredTimeline.slice(0, 100).map((item, i) => (
                                        <div key={item.id} className="relative">
                                            <div className={`absolute left-[-20px] w-2 h-2 rounded-full ${item.severity === 'critical' ? 'bg-red-500' :
                                                item.severity === 'warning' ? 'bg-amber-500' :
                                                    item.severity === 'info' ? 'bg-blue-500' : 'bg-zinc-500'
                                                }`} />
                                            <div className={`p-4 rounded-xl border ${item.severity === 'critical' ? 'bg-red-500/5 border-red-500/20' :
                                                item.severity === 'warning' ? 'bg-amber-500/5 border-amber-500/20' :
                                                    'bg-zinc-900/50 border-white/5'
                                                }`}>
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className="text-sm font-medium text-white">{item.title}</span>
                                                    {item.count && item.count > 1 && (
                                                        <span className="text-xs text-zinc-500">×{item.count}</span>
                                                    )}
                                                    {item.timestamp && (
                                                        <span className="text-xs text-zinc-600 ml-auto">
                                                            {item.timestamp.toLocaleString()}
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="text-xs text-zinc-400 line-clamp-2">{item.description}</p>
                                                <div className="flex items-center gap-2 mt-2 text-[10px] text-zinc-500">
                                                    <span>{item.resourceKind}</span>
                                                    <span>·</span>
                                                    <span>{item.resource}</span>
                                                    <span>·</span>
                                                    <span>{item.namespace}</span>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* GRAPH VIEW */}
                    {view === 'graph' && (
                        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-6">
                            <div className="max-w-4xl mx-auto">
                                <div className="flex items-center justify-between mb-4">
                                    <h2 className="text-lg font-semibold text-white">Resource Graph</h2>
                                    <select
                                        value={graphNamespace || ''}
                                        onChange={(e) => setGraphNamespace(e.target.value || null)}
                                        className="px-3 py-1.5 bg-zinc-800 border border-white/10 rounded-lg text-sm text-white"
                                    >
                                        <option value="">All Namespaces</option>
                                        {bundle.namespaces.map(ns => (
                                            <option key={ns} value={ns}>{ns}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="space-y-2">
                                    {filteredGraph.map(node => (
                                        <ResourceNodeComponent
                                            key={node.id}
                                            node={node}
                                            depth={0}
                                            expanded={expandedNodes}
                                            onToggle={(id) => {
                                                const next = new Set(expandedNodes);
                                                if (next.has(id)) next.delete(id);
                                                else next.add(id);
                                                setExpandedNodes(next);
                                            }}
                                        />
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* EVENTS VIEW */}
                    {view === 'events' && (
                        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-6">
                            <div className="max-w-4xl mx-auto">
                                <div className="flex items-center justify-between mb-4">
                                    <h2 className="text-lg font-semibold text-white">{events.length} Events</h2>
                                    <div className="flex items-center gap-2 text-xs">
                                        <span className="flex items-center gap-1 text-amber-400">
                                            <span className="w-2 h-2 rounded-full bg-amber-500" />
                                            {warningEvents.length} warnings
                                        </span>
                                    </div>
                                </div>

                                {events.length === 0 ? (
                                    <div className="text-center py-12 text-zinc-500">No events found</div>
                                ) : (
                                    <div className="space-y-2">
                                        {events.slice(0, 200).map((e, i) => (
                                            <div
                                                key={i}
                                                className={`p-4 rounded-xl border ${e.event_type === 'Warning'
                                                    ? 'bg-amber-500/5 border-amber-500/20'
                                                    : 'bg-zinc-900/50 border-white/5'
                                                    }`}
                                            >
                                                <div className="flex items-start gap-3">
                                                    <span className={`w-2 h-2 mt-2 rounded-full flex-shrink-0 ${e.event_type === 'Warning' ? 'bg-amber-500' : 'bg-blue-500'
                                                        }`} />
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <span className="text-sm font-medium text-white">{e.reason}</span>
                                                            {e.count > 1 && (
                                                                <span className="text-xs text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">×{e.count}</span>
                                                            )}
                                                            {e.last_timestamp && (
                                                                <span className="text-xs text-zinc-600">{formatAge(e.last_timestamp)}</span>
                                                            )}
                                                        </div>
                                                        <p className="text-sm text-zinc-400 mt-1">{e.message}</p>
                                                        <div className="flex items-center gap-2 mt-2 text-xs text-zinc-600">
                                                            <span className="px-1.5 py-0.5 bg-zinc-800/50 rounded">{e.involved_object_kind}</span>
                                                            <span>{e.involved_object_name}</span>
                                                            <span>·</span>
                                                            <span>{e.namespace}</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* EXPLORE VIEW */}
                    {view === 'explore' && (
                        <div className="flex-1 min-h-0 flex overflow-hidden">
                            {/* Namespace sidebar */}
                            <div className="w-52 flex-none border-r border-white/10 bg-zinc-900/30 min-h-0 overflow-y-auto custom-scrollbar p-3">
                                <p className="px-2 py-1.5 text-[10px] text-zinc-500 uppercase tracking-wider font-medium">Namespaces</p>
                                {bundle.namespaces.map(ns => {
                                    const health = clusterOverview.namespaceHealth.get(ns);
                                    const hasIssues = detectedIssues.some(i => i.namespace === ns);
                                    return (
                                        <button
                                            key={ns}
                                            onClick={() => setSelectedNs(ns)}
                                            className={`w-full px-3 py-2 text-left text-sm rounded-lg truncate flex items-center justify-between ${selectedNs === ns
                                                ? 'bg-violet-500/20 text-violet-300'
                                                : 'text-zinc-400 hover:text-white hover:bg-white/5'
                                                }`}
                                        >
                                            <span className="truncate">{ns}</span>
                                            {hasIssues && <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />}
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                                {/* Resource type tabs */}
                                <div className="flex-none px-4 py-3 border-b border-white/10 bg-zinc-900/30">
                                    <div className="flex items-center gap-2 overflow-x-auto pb-1">
                                        {resourceTypes.map(type => (
                                            <button
                                                key={type}
                                                onClick={() => setSelectedType(type)}
                                                className={`px-3 py-1.5 text-xs font-medium rounded-full whitespace-nowrap ${selectedType === type
                                                    ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                                                    : 'text-zinc-400 hover:text-white bg-zinc-800/50 border border-transparent'
                                                    }`}
                                            >
                                                {type}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Search */}
                                <div className="flex-none px-4 py-3 border-b border-white/10">
                                    <div className="relative">
                                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                                        <input
                                            type="text"
                                            placeholder="Search resources..."
                                            value={search}
                                            onChange={e => setSearch(e.target.value)}
                                            className="w-full pl-9 pr-3 py-2 bg-zinc-800/50 border border-white/10 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-violet-500/50"
                                        />
                                    </div>
                                </div>

                                {/* Status Filters */}
                                <div className="flex-none px-4 py-2 border-b border-white/10">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        <span className="text-[10px] text-zinc-500 uppercase tracking-wider mr-1">Status:</span>
                                        <button
                                            onClick={() => setStatusFilter('all')}
                                            className={`px-2.5 py-1 text-xs rounded-full transition-all ${statusFilter === 'all'
                                                ? 'bg-zinc-700 text-white'
                                                : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                                                }`}
                                        >
                                            All
                                        </button>
                                        <button
                                            onClick={() => setStatusFilter('running')}
                                            className={`px-2.5 py-1 text-xs rounded-full transition-all ${statusFilter === 'running'
                                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                                : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                                                }`}
                                        >
                                            Running
                                        </button>
                                        <button
                                            onClick={() => setStatusFilter('pending')}
                                            className={`px-2.5 py-1 text-xs rounded-full transition-all ${statusFilter === 'pending'
                                                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                                : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                                                }`}
                                        >
                                            Pending
                                        </button>
                                        <button
                                            onClick={() => setStatusFilter('failed')}
                                            className={`px-2.5 py-1 text-xs rounded-full transition-all ${statusFilter === 'failed'
                                                ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                                                : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                                                }`}
                                        >
                                            Failed
                                        </button>
                                        <button
                                            onClick={() => setStatusFilter('issues')}
                                            className={`px-2.5 py-1 text-xs rounded-full transition-all ${statusFilter === 'issues'
                                                ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                                                : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                                                }`}
                                        >
                                            Has Issues
                                        </button>
                                    </div>
                                </div>

                                {/* Resource list */}
                                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4">
                                    {filteredResources.length === 0 ? (
                                        <div className="h-full flex items-center justify-center text-zinc-500">No resources</div>
                                    ) : (
                                        <div className="space-y-2">
                                            {filteredResources.map(r => {
                                                const color = getStatusColor(r.status_phase);
                                                const hasIssue = detectedIssues.some(i => i.affectedResource === r.name);
                                                return (
                                                    <button
                                                        key={r.file_path}
                                                        onClick={() => setSelectedResource(r)}
                                                        className={`w-full p-4 rounded-xl border text-left transition-colors ${selectedResource?.file_path === r.file_path
                                                            ? 'bg-violet-500/10 border-violet-500/30'
                                                            : 'bg-zinc-900/50 border-white/5 hover:border-white/10'
                                                            }`}
                                                    >
                                                        <div className="flex items-center justify-between">
                                                            <div className="flex items-center gap-2">
                                                                {hasIssue && <span className="w-2 h-2 rounded-full bg-red-500" />}
                                                                <span className="text-sm font-medium text-white truncate">{r.name}</span>
                                                            </div>
                                                            <span className={`text-xs px-2 py-0.5 rounded-full bg-${color}-500/20 text-${color}-400`}>
                                                                {r.status_phase || 'Unknown'}
                                                            </span>
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* AI ANALYSIS VIEW REMOVED - NOW IN SIDE PANEL */}
                </div>

                {/* Right Panel */}
                {showRightPanel && (selectedIssue || selectedResource || showAIChat) && (
                    <div className="w-1/3 min-w-[400px] max-w-[500px] min-h-0 flex flex-col border-l border-white/10">
                        {selectedResource ? (
                            <ResourceDetail
                                resource={selectedResource}
                                yaml={resourceYaml}
                                logs={logContent}
                                logFiles={logFiles}
                                events={events}
                                onClose={() => setSelectedResource(null)}
                                onLoadLog={loadLog}
                                selectedLogFile={selectedLogFile}
                            />
                        ) : selectedIssue ? (
                            <DetailPanel
                                issue={selectedIssue}
                                bundle={bundle}
                                events={events}
                                onClose={() => setSelectedIssue(null)}
                                onNavigateToResource={navigateToResource}
                            />
                        ) : showAIChat ? (
                            <div className="h-full flex flex-col">
                                <BundleAIAnalyzer
                                    bundlePath={bundle.path}
                                    context={{
                                        healthSummary,
                                        alerts,
                                        events,
                                        overview: {
                                            healthScore: clusterOverview.healthScore,
                                            totalPods: clusterOverview.totalPods,
                                            failingPods: clusterOverview.failingPods,
                                            pendingPods: clusterOverview.pendingPods,
                                            warningEvents: clusterOverview.warningEvents,
                                            criticalAlerts: clusterOverview.criticalAlerts
                                        },
                                        namespaces: bundle.namespaces
                                    }}
                                    onClose={() => setShowAIChat(false)}
                                />
                            </div>
                        ) : null}
                    </div>
                )}
            </div>
        </div>
    );
}

// Resource node component for graph view
function ResourceNodeComponent({ node, depth, expanded, onToggle }: {
    node: ResourceNode;
    depth: number;
    expanded: Set<string>;
    onToggle: (id: string) => void;
}) {
    const isExpanded = expanded.has(node.id);
    const hasChildren = node.children.length > 0;
    const statusColor = getStatusColor(node.status);

    const kindColors: Record<string, string> = {
        Deployment: 'purple',
        ReplicaSet: 'violet',
        Pod: 'blue',
        Service: 'cyan'
    };
    const color = kindColors[node.kind] || 'zinc';

    return (
        <div style={{ marginLeft: depth * 24 }}>
            <button
                onClick={() => hasChildren && onToggle(node.id)}
                className={`w-full flex items-center gap-2 p-3 rounded-lg border transition-colors ${node.hasIssue ? 'bg-red-500/5 border-red-500/20' : 'bg-zinc-900/50 border-white/5 hover:border-white/10'
                    }`}
            >
                {hasChildren ? (
                    isExpanded ? <ChevronDown size={14} className="text-zinc-500" /> : <ChevronRight size={14} className="text-zinc-500" />
                ) : (
                    <span className="w-3.5" />
                )}
                <span className={`text-[10px] px-1.5 py-0.5 rounded bg-${color}-500/20 text-${color}-400`}>
                    {node.kind}
                </span>
                <span className="text-sm text-white truncate flex-1 text-left">{node.name}</span>
                {node.hasIssue && <AlertCircle size={14} className="text-red-400" />}
                <span className={`text-xs px-2 py-0.5 rounded-full bg-${statusColor}-500/20 text-${statusColor}-400`}>
                    {node.status}
                </span>
            </button>
            {isExpanded && node.children.map(child => (
                <ResourceNodeComponent
                    key={child.id}
                    node={child}
                    depth={depth + 1}
                    expanded={expanded}
                    onToggle={onToggle}
                />
            ))}
        </div>
    );
}
