import React, { useMemo, useCallback } from 'react';
import ReactFlow, {
    Node,
    Edge,
    Position,
    ConnectionLineType,
    MarkerType,
    Controls,
    Background,
    useNodesState,
    useEdgesState,
    Handle,
} from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from 'dagre';
import {
    Package, Layers, Cpu, Network, FileCode, Shield,
    HardDrive, Database, Server, Clock, Box, CheckCircle2,
    XCircle, AlertTriangle, AlertCircle, ArrowRight, Heart, HeartCrack, GitBranch
} from 'lucide-react';
import { K8sObject } from '../../types/k8s';

// --- Icons & Colors ---
function getHealthIcon(health: string) {
    switch (health) {
        case 'Healthy': return Heart;
        case 'Degraded': return HeartCrack;
        case 'Progressing': return Clock;
        case 'Suspended': return AlertTriangle;
        case 'Missing': return AlertCircle;
        default: return AlertCircle;
    }
}

function getHealthColor(health: string) {
    switch (health) {
        case 'Healthy': return 'text-emerald-400';
        case 'Degraded': return 'text-rose-400';
        case 'Progressing': return 'text-blue-400';
        case 'Suspended': return 'text-amber-400';
        case 'Missing': return 'text-purple-400';
        default: return 'text-zinc-500';
    }
}

function getHealthBg(health: string) {
    switch (health) {
        case 'Healthy': return 'bg-emerald-500/10 border-emerald-500/20 shadow-emerald-500/10';
        case 'Degraded': return 'bg-rose-500/10 border-rose-500/20 shadow-rose-500/10';
        case 'Progressing': return 'bg-blue-500/10 border-blue-500/20 shadow-blue-500/10';
        case 'Suspended': return 'bg-amber-500/10 border-amber-500/20 shadow-amber-500/10';
        case 'Missing': return 'bg-purple-500/10 border-purple-500/20 shadow-purple-500/10';
        default: return 'bg-zinc-800/50 border-zinc-700/50';
    }
}

function getKindIcon(kind: string) {
    const kindLower = kind.toLowerCase();
    if (kindLower.includes('deployment')) return Package;
    if (kindLower.includes('replicaset')) return Layers;
    if (kindLower.includes('pod')) return Cpu;
    if (kindLower.includes('service')) return Network;
    if (kindLower.includes('configmap')) return FileCode;
    if (kindLower.includes('secret')) return Shield;
    if (kindLower.includes('ingress')) return Network;
    if (kindLower.includes('pvc') || kindLower.includes('persistentvolume')) return HardDrive;
    if (kindLower.includes('statefulset')) return Database;
    if (kindLower.includes('daemonset')) return Server;
    if (kindLower.includes('job') || kindLower.includes('cronjob')) return Clock;
    if (kindLower.includes('serviceaccount')) return Shield;
    return Box;
}

// --- Custom Node Component ---
const ResourceNode = ({ data }: { data: any }) => {
    const { resource, isRoot } = data;
    const Icon = isRoot ? GitBranch : getKindIcon(resource.kind);
    const HealthIcon = resource.health ? getHealthIcon(resource.health) : null;
    const healthColor = resource.health ? getHealthColor(resource.health) : 'text-zinc-500';
    const bgClass = resource.health ? getHealthBg(resource.health) : 'bg-zinc-900 border-zinc-800';

    // Status text color
    const statusColor = resource.status === 'Synced' ? 'text-emerald-400' : 'text-amber-400';

    return (
        <div className={`
            relative group min-w-[240px] rounded-xl border backdrop-blur-xl transition-all duration-300
            ${isRoot ? 'shadow-2xl shadow-orange-500/10 border-orange-500/30 bg-zinc-900/80' : `hover:scale-105 hover:shadow-xl hover:shadow-black/60 shadow-lg ${bgClass}`}
        `}>
            {/* Input Handle */}
            {!isRoot && (
                <Handle
                    type="target"
                    position={Position.Left}
                    className="!w-3 !h-3 !bg-zinc-600 !border-2 !border-zinc-900 !rounded-full !-ml-1.5"
                />
            )}

            <div className="flex flex-col">
                {/* Header */}
                <div className={`
                    flex items-center gap-3 px-4 py-3 border-b border-white/5
                    ${isRoot ? 'bg-orange-500/10' : ''}
                `}>
                    <div className={`
                        p-2 rounded-lg shrink-0
                        ${isRoot ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/20' : `bg-white/5 ${healthColor}`}
                    `}>
                        <Icon size={isRoot ? 20 : 18} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-0.5">
                            {resource.kind}
                        </div>
                        <div className="text-sm font-bold text-zinc-100 truncate" title={resource.name}>
                            {resource.name}
                        </div>
                    </div>
                </div>

                {/* Body / Stats */}
                {!isRoot && (
                    <div className="px-4 py-3 flex items-center justify-between gap-4">
                        {/* Health Status */}
                        <div className="flex items-center gap-1.5">
                            {HealthIcon && <HealthIcon size={14} className={healthColor} />}
                            <span className={`text-xs font-medium ${healthColor}`}>
                                {resource.health || 'Unknown'}
                            </span>
                        </div>

                        {/* Sync Status */}
                        {resource.status && (
                            <div className="flex items-center gap-1.5">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded border border-white/5 bg-black/20 font-medium ${statusColor}`}>
                                    {resource.status}
                                </span>
                            </div>
                        )}
                    </div>
                )}

                {/* Root specific details */}
                {isRoot && (
                    <div className="px-4 py-3 grid grid-cols-2 gap-2 text-center text-xs text-zinc-400">
                        <div className="bg-white/5 rounded p-1">
                            <span className={getHealthColor(resource.health)}>{resource.health}</span>
                        </div>
                        <div className="bg-white/5 rounded p-1">
                            <span className={resource.status === 'Synced' ? 'text-emerald-400' : 'text-amber-400'}>{resource.status}</span>
                        </div>
                    </div>
                )}
            </div>

            {/* Output Handle */}
            <Handle
                type="source"
                position={Position.Right}
                className="!w-3 !h-3 !bg-zinc-600 !border-2 !border-zinc-900 !rounded-full !-mr-1.5 transition-colors group-hover:bg-white"
            />
        </div>
    );
};

const nodeTypes = {
    resource: ResourceNode,
};

// --- Layout Logic ---
const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

const getLayoutedElements = (nodes: Node[], edges: Edge[], direction = 'LR') => {
    const isHorizontal = direction === 'LR';
    dagreGraph.setGraph({ rankdir: direction });

    nodes.forEach((node) => {
        // Approximate width/height for layout based on new larger card design
        dagreGraph.setNode(node.id, { width: 280, height: 120 });
    });

    edges.forEach((edge) => {
        dagreGraph.setEdge(edge.source, edge.target);
    });

    dagre.layout(dagreGraph);

    const layoutedNodes = nodes.map((node) => {
        const nodeWithPosition = dagreGraph.node(node.id);
        const w = 280;
        const h = 120;

        node.targetPosition = isHorizontal ? Position.Left : Position.Top;
        node.sourcePosition = isHorizontal ? Position.Right : Position.Bottom;

        // Shift anchor to top-left
        node.position = {
            x: nodeWithPosition.x - w / 2,
            y: nodeWithPosition.y - h / 2,
        };

        return node;
    });

    return { nodes: layoutedNodes, edges };
};

// --- Main Component ---
interface ArgoGraphTabProps {
    app: any;
    onOpenResource?: (resource: K8sObject) => void;
}

export function ArgoGraphTab({ app, onOpenResource }: ArgoGraphTabProps) {
    // 1. Convert Argo Resources to Nodes/Edges
    const { initialNodes, initialEdges } = useMemo(() => {
        if (!app.resources) return { initialNodes: [], initialEdges: [] };

        const nodes: Node[] = [];
        const edges: Edge[] = [];
        const resourceMap = new Map<string, any>();

        // 1a. Root Node
        const appNodeId = `app-${app.name}`;
        nodes.push({
            id: appNodeId,
            type: 'resource',
            data: {
                resource: { kind: 'Application', name: app.name, health: app.health, status: app.sync },
                isRoot: true
            },
            position: { x: 0, y: 0 },
        });

        // 1b. Resource Nodes
        app.resources.forEach((r: any) => {
            const id = `${r.kind}:${r.name}`;
            resourceMap.set(id, r);

            nodes.push({
                id,
                type: 'resource',
                data: { resource: r, isRoot: false },
                position: { x: 0, y: 0 },
            });
        });

        // 1c. Edges
        const hierarchy: Record<string, string[]> = {
            'Deployment': ['ReplicaSet'],
            'ReplicaSet': ['Pod'],
            'StatefulSet': ['Pod'],
            'DaemonSet': ['Pod'],
            'Job': ['Pod'],
            'CronJob': ['Job'],
            'Service': ['EndpointSlice', 'Endpoints'],
            'Rollout': ['ReplicaSet', 'AnalysisRun'], // Argo Rollouts support
        };

        const childrenMap = new Map<string, Set<string>>();
        const allChildren = new Set<string>();

        // Build edges based on naming
        app.resources.forEach((parent: any) => {
            const possibleChildren = hierarchy[parent.kind];
            if (!possibleChildren) return;

            possibleChildren.forEach(childKind => {
                app.resources.filter((r: any) => r.kind === childKind).forEach((child: any) => {
                    // Check strict prefix naming usually used by controllers
                    // Deployment: nginx -> RS: nginx-59f.. -> Pod: nginx-59f..-abc
                    if (child.name.startsWith(parent.name)) {
                        const parentId = `${parent.kind}:${parent.name}`;
                        const childId = `${child.kind}:${child.name}`;

                        // Detect if "Progressing" to animate edge
                        const isActive = child.health === 'Progressing' || child.status === 'OutOfSync';

                        edges.push({
                            id: `${parentId}-${childId}`,
                            source: parentId,
                            target: childId,
                            type: 'smoothstep',
                            animated: isActive, // Animation for active/syncing resources
                            style: {
                                stroke: isActive ? '#60a5fa' : '#52525b',
                                strokeWidth: isActive ? 2 : 1
                            },
                        });
                        allChildren.add(childId);
                    }
                });
            });
        });

        // Connect App to Roots
        app.resources.forEach((r: any) => {
            const id = `${r.kind}:${r.name}`;
            if (!allChildren.has(id)) {
                edges.push({
                    id: `${appNodeId}-${id}`,
                    source: appNodeId,
                    target: id,
                    type: 'smoothstep',
                    animated: false,
                    style: { stroke: '#f97316', strokeWidth: 1.5 },
                });
            }
        });

        return { initialNodes: nodes, initialEdges: edges };
    }, [app]);

    // 2. Layout
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([]);

    useMemo(() => {
        const textLayout = getLayoutedElements(initialNodes, initialEdges);
        setNodes(textLayout.nodes);
        setEdges(textLayout.edges);
    }, [initialNodes, initialEdges]);

    // 3. Click
    const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
        if (!node.data.isRoot && onOpenResource) {
            const r = node.data.resource;
            const k8sObj: K8sObject = {
                id: `${r.namespace || ''}/${r.kind}/${r.name}`,
                name: r.name,
                namespace: r.namespace || '-',
                kind: r.kind,
                group: r.group || '',
                version: r.version,
                status: r.health || 'Unknown',
                age: '',
            };
            onOpenResource(k8sObj);
        }
    }, [onOpenResource]);

    return (
        <div className="w-full h-full min-h-[500px] bg-gradient-to-br from-zinc-950 to-black">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                nodeTypes={nodeTypes}
                fitView
                minZoom={0.1}
                maxZoom={2}
                defaultEdgeOptions={{ type: 'smoothstep', animated: false }}
                proOptions={{ hideAttribution: true }}
            >
                <Background color="#3f3f46" gap={24} size={1} />
                <Controls className="bg-zinc-900 border-zinc-800 fill-zinc-400 !shadow-xl" showInteractive={false} />
            </ReactFlow>
        </div>
    );
}
