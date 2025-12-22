import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    ArrowUp,
    ArrowDown,
    Link,
    AlertTriangle,
    ChevronRight,
    Loader2,
    ExternalLink,
    Box,
    FileText,
    Key,
    Database,
    User
} from 'lucide-react';
import { useAgentUrl } from '../../../hooks/useAgentUrl';

interface ResourceRef {
    kind: string;
    name: string;
    namespace: string;
    api_version?: string;
}

interface ResourceChainData {
    root: ResourceRef;
    owners: ResourceRef[];
    children: ResourceRef[];
    related: ResourceRef[];
    events: Array<{
        resource: string;
        reason: string;
        message: string;
        count: number;
    }>;
    summary: string;
}

interface ResourceChainCardProps {
    kind: string;
    name: string;
    namespace: string;
    currentContext?: string;
    onNavigate?: (kind: string, name: string, namespace: string, apiVersion?: string) => void;
}


// Icon mapping for resource types
const getResourceIcon = (kind: string) => {
    const k = kind.toLowerCase();
    if (k === 'configmap') return FileText;
    if (k === 'secret') return Key;
    if (k === 'persistentvolumeclaim' || k === 'pvc') return Database;
    if (k === 'serviceaccount') return User;
    return Box;
};

// Color mapping for resource types
const getResourceColor = (kind: string) => {
    const k = kind.toLowerCase();
    if (k === 'deployment') return 'text-blue-400 bg-blue-500/10 border-blue-500/20';
    if (k === 'replicaset') return 'text-purple-400 bg-purple-500/10 border-purple-500/20';
    if (k === 'pod') return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    if (k === 'service') return 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20';
    if (k === 'configmap') return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20';
    if (k === 'secret') return 'text-red-400 bg-red-500/10 border-red-500/20';
    if (k === 'statefulset') return 'text-orange-400 bg-orange-500/10 border-orange-500/20';
    if (k === 'daemonset') return 'text-pink-400 bg-pink-500/10 border-pink-500/20';
    return 'text-zinc-400 bg-zinc-500/10 border-zinc-500/20';
};

const ResourcePill = ({
    resource,
    onClick,
    direction
}: {
    resource: ResourceRef;
    onClick?: () => void;
    direction?: 'up' | 'down' | 'related';
}) => {
    const Icon = getResourceIcon(resource.kind);
    const colorClass = getResourceColor(resource.kind);

    return (
        <button
            onClick={onClick}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-all hover:scale-[1.02] hover:shadow-lg ${colorClass} ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
        >
            {direction === 'up' && <ArrowUp size={12} className="text-zinc-500" />}
            {direction === 'down' && <ArrowDown size={12} className="text-zinc-500" />}
            {direction === 'related' && <Link size={12} className="text-zinc-500" />}
            <Icon size={14} />
            <div className="flex flex-col items-start">
                <span className="text-xs font-medium">{resource.name}</span>
                <span className="text-[10px] opacity-60">{resource.kind}</span>
            </div>
            {onClick && <ExternalLink size={10} className="ml-auto opacity-40" />}
        </button>
    );
};

export function ResourceChainCard({ kind, name, namespace, currentContext, onNavigate }: ResourceChainCardProps) {
    const [expanded, setExpanded] = useState(true);
    const agentUrl = useAgentUrl();

    const { data, isLoading, error } = useQuery<ResourceChainData>({
        queryKey: ['resource-chain', kind, name, namespace, currentContext],
        queryFn: async () => {
            const response = await fetch(`${agentUrl}/resource-chain`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind,
                    name,
                    namespace,
                    kube_context: currentContext || '',
                    include_events: true
                })
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch resource chain: ${response.statusText}`);
            }
            return response.json();
        },
        staleTime: 30000, // 30 seconds
        retry: 1,
        enabled: !!name && !!namespace
    });

    const handleNavigate = (ref: ResourceRef) => {
        if (onNavigate) {
            onNavigate(ref.kind, ref.name, ref.namespace, ref.api_version);
        }
    };

    // Don't render if no relationships
    const hasRelationships = data && (
        data.owners.length > 0 ||
        data.children.length > 0 ||
        data.related.length > 0
    );

    if (isLoading) {
        return (
            <div className="bg-[#18181b] border border-white/5 rounded-xl p-4">
                <div className="flex items-center gap-2 text-zinc-500">
                    <Loader2 size={14} className="animate-spin" />
                    <span className="text-xs">Loading resource relationships...</span>
                </div>
            </div>
        );
    }

    if (error || !hasRelationships) {
        // Silently don't show if no relationships
        return null;
    }

    return (
        <div className="bg-[#18181b] border border-white/5 rounded-xl overflow-hidden">
            {/* Header */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center justify-between px-4 py-3 bg-white/5 hover:bg-white/10 transition-colors group text-left"
            >
                <div className="flex items-center gap-2">
                    <Link size={14} className="text-cyan-400" />
                    <span className="text-xs font-semibold text-zinc-400 group-hover:text-zinc-200">
                        Resource Relationships
                    </span>
                    <span className="text-[10px] text-zinc-600">
                        ({(data?.owners.length || 0) + (data?.children.length || 0) + (data?.related.length || 0)} connected)
                    </span>
                </div>
                <ChevronRight size={14} className={`text-zinc-500 transition-transform ${expanded ? 'rotate-90' : ''}`} />
            </button>

            {expanded && data && (
                <div className="p-4 space-y-4 border-t border-white/5 bg-[#0f0f12]">
                    {/* Owner Chain (Up) */}
                    {data.owners.length > 0 && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-zinc-500">
                                <ArrowUp size={12} />
                                <span className="text-[10px] font-medium uppercase tracking-wider">Owners</span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {data.owners.map((owner, i) => (
                                    <ResourcePill
                                        key={`${owner.kind}-${owner.name}-${i}`}
                                        resource={owner}
                                        direction="up"
                                        onClick={() => handleNavigate(owner)}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Children (Down) */}
                    {data.children.length > 0 && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-zinc-500">
                                <ArrowDown size={12} />
                                <span className="text-[10px] font-medium uppercase tracking-wider">
                                    Owned Resources ({data.children.length})
                                </span>
                            </div>
                            <div className="flex flex-wrap gap-2 max-h-[150px] overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-700">
                                {data.children.slice(0, 10).map((child, i) => (
                                    <ResourcePill
                                        key={`${child.kind}-${child.name}-${i}`}
                                        resource={child}
                                        direction="down"
                                        onClick={() => handleNavigate(child)}
                                    />
                                ))}
                                {data.children.length > 10 && (
                                    <div className="px-3 py-2 text-xs text-zinc-500">
                                        +{data.children.length - 10} more
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Related Resources (Lateral) */}
                    {data.related.length > 0 && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-zinc-500">
                                <Link size={12} />
                                <span className="text-[10px] font-medium uppercase tracking-wider">Related Resources</span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {data.related.map((rel, i) => (
                                    <ResourcePill
                                        key={`${rel.kind}-${rel.name}-${i}`}
                                        resource={rel}
                                        direction="related"
                                        onClick={() => handleNavigate(rel)}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Warning Events */}
                    {data.events.length > 0 && (
                        <div className="space-y-2 pt-2 border-t border-white/5">
                            <div className="flex items-center gap-2 text-yellow-500">
                                <AlertTriangle size={12} />
                                <span className="text-[10px] font-medium uppercase tracking-wider">
                                    Warning Events ({data.events.length})
                                </span>
                            </div>
                            <div className="space-y-1 max-h-[100px] overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-700">
                                {data.events.slice(0, 5).map((event, i) => (
                                    <div
                                        key={i}
                                        className="flex items-start gap-2 text-xs p-2 bg-yellow-500/5 border border-yellow-500/10 rounded"
                                    >
                                        <span className="text-yellow-400 font-medium shrink-0">{event.reason}</span>
                                        <span className="text-zinc-400 truncate">{event.message}</span>
                                        {event.count > 1 && (
                                            <span className="text-yellow-600 text-[10px] shrink-0">x{event.count}</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
