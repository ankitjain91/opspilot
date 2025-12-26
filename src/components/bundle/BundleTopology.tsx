import React, { useMemo, useCallback, useEffect, useState } from 'react';
import ReactFlow, {
    Background,
    Controls,
    MiniMap,
    useNodesState,
    useEdgesState,
    Position,
    Node,
    Edge,
    MarkerType,
    ReactFlowProvider,
    useReactFlow
} from 'reactflow';
// @ts-ignore
import dagre from 'dagre';
import 'reactflow/dist/style.css';
import { Box, Layers, Server, Activity, Database, AlertCircle, ArrowRight, Component, FileText, Shield } from 'lucide-react';
import type { BundleResource } from './types';

// ============================================================================
// STYLES & LAYOUT CONFIG
// ============================================================================

const NODE_WIDTH = 220;
const NODE_HEIGHT = 60;
const GROUP_PADDING = 20;

const DAGRE_OPTS = {
    rankdir: 'TB',
    nodesep: 50,
    ranksep: 80,
    marginx: 50,
    marginy: 50,
};

// ============================================================================
// HELPERS
// ============================================================================

const getLayoutedElements = (nodes: Node[], edges: Edge[]) => {
    const g = new dagre.graphlib.Graph();
    g.setGraph(DAGRE_OPTS);
    g.setDefaultEdgeLabel(() => ({}));

    // Add nodes to dagre
    nodes.forEach((node) => {
        // Use approximate dimensions including groups
        const width = node.style?.width as number || NODE_WIDTH;
        const height = node.style?.height as number || NODE_HEIGHT;
        g.setNode(node.id, { width, height });
    });

    edges.forEach((edge) => {
        g.setEdge(edge.source, edge.target);
    });

    dagre.layout(g);

    return {
        nodes: nodes.map((node) => {
            const nodeWithPosition = g.node(node.id);
            // Dagre returns center coords, ReactFlow needs top-left
            return {
                ...node,
                position: {
                    x: nodeWithPosition.x - (node.style?.width as number || NODE_WIDTH) / 2,
                    y: nodeWithPosition.y - (node.style?.height as number || NODE_HEIGHT) / 2,
                },
            };
        }),
        edges,
    };
};

function getResourceStatusColor(status: string | null) {
    if (!status) return 'border-zinc-700 bg-zinc-900';
    const s = status.toLowerCase();
    if (s === 'running' || s === 'completed' || s === 'ready') return 'border-emerald-500/50 bg-emerald-950/30';
    if (s.includes('fail') || s.includes('error') || s.includes('crash') || s.includes('backoff')) return 'border-red-500 bg-red-950/30';
    if (s === 'pending' || s === 'containercreating') return 'border-amber-500/50 bg-amber-950/30';
    return 'border-zinc-700 bg-zinc-900';
}

function getResourceIcon(kind: string) {
    switch (kind) {
        case 'Deployment': return Layers;
        case 'Pod': return Box;
        case 'Service': return Server;
        case 'Ingress': return ArrowRight;
        case 'ConfigMap': return FileText;
        case 'Secret': return Shield;
        case 'StatefulSet': return Database;
        case 'DaemonSet': return Component;
        default: return Box;
    }
}

// ============================================================================
// COMPONENTS
// ============================================================================

// PREMIUM RESOURCE NODE
const ResourceNode = ({ data }: any) => {
    const Icon = getResourceIcon(data.kind);
    const borderColor = getResourceStatusColor(data.status);
    const isError = borderColor.includes('red');

    return (
        <div className={`
            relative w-[220px] rounded-lg border backdrop-blur-md transition-all duration-300 hover:scale-105 hover:shadow-xl group
            ${borderColor}
            ${isError ? 'shadow-[0_0_15px_rgba(239,68,68,0.2)]' : 'shadow-lg shadow-black/50'}
        `}>
            {/* Header */}
            <div className="flex items-center gap-3 p-3 border-b border-white/5 bg-white/5">
                <div className={`p-1.5 rounded-md ${isError ? 'bg-red-500/20 text-red-500' : 'bg-black/40 text-zinc-400'}`}>
                    <Icon size={16} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-white truncate" title={data.label}>
                        {data.label}
                    </div>
                    <div className="text-[10px] text-zinc-500 font-mono truncate">{data.kind}</div>
                </div>
                {isError && <AlertCircle size={14} className="text-red-500 animate-pulse" />}
            </div>

            {/* Body */}
            <div className="p-2 space-y-1">
                <div className="flex justify-between items-center text-[10px]">
                    <span className="text-zinc-500">Status</span>
                    <span className={`font-mono font-medium ${isError ? 'text-red-400' : 'text-emerald-400'}`}>
                        {data.status || 'Unknown'}
                    </span>
                </div>
                {/* Metrics Placeholder - could be real data in future */}
                {data.kind === 'Pod' && (
                    <div className="flex gap-1 mt-2">
                        <div className="h-0.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-500/50 w-[70%]" />
                        </div>
                    </div>
                )}
            </div>

            {/* Connection Handle (Invisible but functional) */}
            {/* <Handle type="source" position={Position.Bottom} className="!bg-transparent !border-none" />
            <Handle type="target" position={Position.Top} className="!bg-transparent !border-none" /> */}
        </div>
    );
};

const nodeTypes = {
    resource: ResourceNode,
};

// TOPOLOGY VIEW
export function BundleTopology({ resources, onNodeClick }: { resources: BundleResource[], onNodeClick?: (id: string) => void }) {
    const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
        const rawNodes: Node[] = [];
        const rawEdges: Edge[] = [];
        const resourceMap = new Map<string, BundleResource>();

        // Group by Namespace
        const namespaces = Array.from(new Set(resources.map(r => r.namespace || 'default')));

        // 1. Create Nodes
        resources.forEach(r => {
            const id = `${r.kind}:${r.namespace}:${r.name}`;
            resourceMap.set(id, r);

            // Basic filtering to keep graph sane
            if (['EndpointSlice', 'Endpoints', 'Event', 'ReplicaSet'].includes(r.kind)) return;

            rawNodes.push({
                id,
                type: 'resource',
                data: {
                    label: r.name,
                    kind: r.kind,
                    status: r.status_phase || (r.conditions?.[0]?.status === 'True' ? 'Ready' : null),
                    hasIssue: false // TODO
                },
                position: { x: 0, y: 0 } // Layout will fix
            });
        });

        // 2. Infer Edges (Simple Owner/Service Relationship)
        // This is a naive implementation since we don't have ownerRefs fully populated or indexed in this flat list
        // Improvements: Backend should provide the edge list.
        // Fallback: Pattern matching names.

        resources.forEach(r => {
            const id = `${r.kind}:${r.namespace}:${r.name}`;

            // Deployment -> Pod (Name prefix match)
            if (r.kind === 'Deployment') {
                const pods = resources.filter(p =>
                    p.kind === 'Pod' &&
                    p.namespace === r.namespace &&
                    p.name.startsWith(r.name + '-')
                );
                pods.forEach(p => {
                    const podId = `${p.kind}:${p.namespace}:${p.name}`;
                    rawEdges.push({
                        id: `e-${id}-${podId}`,
                        source: id,
                        target: podId,
                        type: 'smoothstep',
                        animated: true,
                        style: { stroke: '#52525b', strokeWidth: 1.5 }
                    });
                });
            }

            // Service -> Pod (Label selector would be better, but we don't have selectors here easily)
            // Using name match heuristic for now is risky.
        });

        return getLayoutedElements(rawNodes, rawEdges);
    }, [resources]);

    const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

    // Re-layout when resources change
    useEffect(() => {
        const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(initialNodes, initialEdges);
        setNodes(layoutedNodes);
        setEdges(layoutedEdges);
    }, [initialNodes, initialEdges]);

    return (
        <div className="w-full h-full bg-black rounded-xl overflow-hidden relative group">
            {/* Graph Background Pattern */}
            <div className="absolute inset-0 z-0 opacity-20 pointer-events-none"
                style={{
                    backgroundImage: 'radial-gradient(circle at 1px 1px, #333 1px, transparent 0)',
                    backgroundSize: '24px 24px'
                }}
            />

            <ReactFlowProvider>
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    nodeTypes={nodeTypes}
                    fitView
                    minZoom={0.2}
                    maxZoom={2}
                    className="bg-zinc-950"
                >
                    <Background color="#222" gap={24} />
                    <Controls className="bg-zinc-900 border-white/10 fill-white" />
                    <MiniMap
                        nodeColor={(n) => {
                            const kind = (n.data as any).kind;
                            if (kind === 'Pod') return '#a855f7'; // Purple
                            if (kind === 'Service') return '#f59e0b'; // Amber
                            return '#52525b'; // Zinc
                        }}
                        maskColor="rgba(0, 0, 0, 0.8)"
                        className="bg-zinc-900 border border-white/10 rounded-lg shadow-xl"
                    />
                </ReactFlow>
            </ReactFlowProvider>

            {/* Overlay Title */}
            <div className="absolute top-4 left-4 z-10 pointer-events-none">
                <div className="flex items-center gap-2 text-white/50 text-sm font-mono">
                    <Activity size={14} />
                    <span>TOPOLOGY</span>
                    <span className="text-white/20">::</span>
                    <span>{resources.length} NODES</span>
                </div>
            </div>
        </div>
    );
}

// Ensure icons function is defined/imported
import { FileText as FileIcon, Shield as ShieldIcon } from 'lucide-react';
