import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import ReactFlow, { Background, Controls, MiniMap, Node as RFNode, Edge as RFEdge, useReactFlow, ReactFlowProvider } from 'reactflow';
// @ts-ignore - dagre has no bundled TS types; using dynamic import fallback
import dagre from 'dagre';
import 'reactflow/dist/style.css';
import type { TopologyGraph, TopologyNode } from '../types/topology';
import { AlertCircle } from 'lucide-react';
import Loading from './Loading';

function nodeStatusColor(status?: string): string {
  switch (status) {
    case 'Healthy': return '#22c55e';
    case 'Degraded': return '#facc15';
    case 'Failed': return '#f97373';
    case 'Pending': return '#38bdf8';
    default: return '#9ca3af';
  }
}

function kindGroup(kind: string): number {
  switch (kind) {
    case 'Ingress': return 0;
    case 'Service': return 1;
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'Job':
    case 'CronJob': return 2;
    case 'Pod': return 3;
    case 'PVC':
    case 'PV':
    case 'StorageClass': return 4;
    case 'Node': return 5;
    default: return 6;
  }
}

export const TopologyView: React.FC = () => {
  // Filtering state
  const [selectedNamespace, setSelectedNamespace] = useState<string>('ALL');
  const [showPods, setShowPods] = useState(false);
  const [showStorage, setShowStorage] = useState(false);
  const [showJobs, setShowJobs] = useState(false);
  const [showIngress, setShowIngress] = useState(true);
  const [showReplicaSets, setShowReplicaSets] = useState(false);
  const [search, setSearch] = useState('');
  const [hideNonMatches, setHideNonMatches] = useState(false);
  const [groupControllers, setGroupControllers] = useState(true);
  const [spotlightOpen, setSpotlightOpen] = useState(false);
  const [spotlightQuery, setSpotlightQuery] = useState('');
  const [expandedControllers, setExpandedControllers] = useState<Set<string>>(new Set());

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['topology_graph_opts', { showPods, showStorage, showJobs, showReplicaSets, showIngress }],
    queryFn: async () => invoke<TopologyGraph>('get_topology_graph_opts', {
      includePods: showPods,
      includeStorage: showStorage,
      includeJobs: showJobs,
      includeReplicasets: showReplicaSets,
      includeIngress: showIngress,
    }),
    refetchInterval: 30000,
  });

  // Note: search + hideNonMatches retained

  // Debounced search value
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const namespaces = useMemo(() => {
    if (!data) return [] as string[];
    const set = new Set<string>();
    for (const n of data.nodes) {
      if (n.namespace) set.add(n.namespace);
    }
    return Array.from(set).sort();
  }, [data]);

  const { rfNodes, rfEdges } = useMemo(() => {
    if (!data) return { rfNodes: [] as RFNode[], rfEdges: [] as RFEdge[] };

    // Dagre handles spacing; previous manual spacing removed
    const grouped: Record<string, TopologyNode[]> = {};

    // Apply filters before grouping
    // Precompute match predicate
    const lcQuery = debouncedSearch.toLowerCase();
    const nameMatches = (n: TopologyNode) => lcQuery.length === 0 ||
      n.name.toLowerCase().includes(lcQuery) ||
      n.kind.toLowerCase().includes(lcQuery) ||
      (n.namespace && n.namespace.toLowerCase().includes(lcQuery));

    const filteredNodes = data.nodes.filter(n => {
      if (selectedNamespace !== 'ALL' && n.namespace !== selectedNamespace) return false;
      switch (n.kind) {
        case 'Pod': return showPods; // hide unless enabled
        case 'PVC':
        case 'PV':
        case 'StorageClass': return showStorage;
        case 'Job':
        case 'CronJob': return showJobs;
        case 'ReplicaSet': return showReplicaSets; // usually noisy
        case 'Ingress': return showIngress;
        default: return true;
      }
    });

    // Controller grouping: collapse children of controllers when enabled
    let nodesAfterGrouping = filteredNodes;
    if (groupControllers) {
      const controllerKinds = new Set(['Deployment','StatefulSet','DaemonSet','Job','CronJob']);
      const visibleIdsSet = new Set(nodesAfterGrouping.map(n => n.id));
      const ownedTargetsToHide = new Set<string>();
      for (const e of data.edges) {
        if (e.type === 'owns' && visibleIdsSet.has(e.from) && visibleIdsSet.has(e.to)) {
          const fromNode = nodesAfterGrouping.find(n => n.id === e.from);
          if (fromNode && controllerKinds.has(fromNode.kind)) {
            if (!expandedControllers.has(e.from)) {
              ownedTargetsToHide.add(e.to);
            }
          }
        }
      }
      nodesAfterGrouping = nodesAfterGrouping.filter(n => !ownedTargetsToHide.has(n.id));
    }

    const matchIds = new Set<string>();
    for (const n of filteredNodes) if (nameMatches(n)) matchIds.add(n.id);

    const displayNodes = hideNonMatches && debouncedSearch
      ? nodesAfterGrouping.filter(n => matchIds.has(n.id))
      : nodesAfterGrouping;

    for (const n of displayNodes) {
      grouped[n.kind] ||= [];
      grouped[n.kind].push(n);
    }

    // Build a dagre graph for layout (horizontal by kind group)
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 140 });
    g.setDefaultEdgeLabel(() => ({}));

    // Add nodes to dagre with provisional size
    Object.entries(grouped).forEach(([kindKey, nodes]) => {
      const layer = kindGroup(kindKey);
      nodes.forEach(n => {
        g.setNode(n.id, { width: 160, height: 40, layer });
      });
    });
    // Add edges (only those between filtered nodes)
    const visibleIdsTemp = new Set(displayNodes.map(n => n.id));
    data.edges.forEach(e => {
      if (visibleIdsTemp.has(e.from) && visibleIdsTemp.has(e.to)) {
        g.setEdge(e.from, e.to);
      }
    });
    dagre.layout(g);

    const rfNodes: RFNode[] = [];
    Object.entries(grouped).forEach(([_, nodes]) => {
      nodes.forEach(n => {
        const pos = g.node(n.id);
        // Visual indicators for controllers
        const controllerKinds = new Set(['Deployment','StatefulSet','DaemonSet','Job','CronJob']);
        const isController = controllerKinds.has(n.kind);
        const isExpanded = expandedControllers.has(n.id);
        let hiddenCount = 0;
        if (groupControllers && isController && !isExpanded) {
          // Count immediate owned children hidden
          for (const e of data.edges) {
            if (e.type === 'owns' && e.from === n.id && !expandedControllers.has(e.from)) {
              // Only count if the child exists in full dataset
              hiddenCount += 1;
            }
          }
        }
        const chevron = groupControllers && isController ? (isExpanded ? '▾' : '▸') : '';
        // Badge-style count using square brackets to stand out in monospaced label
        const labelSuffix = groupControllers && isController && hiddenCount > 0 && !isExpanded
          ? `  [${hiddenCount}]`
          : '';
        rfNodes.push({
          id: n.id,
          data: {
            label: `${chevron} ${n.kind}/${n.namespace ? n.namespace + '/' : ''}${n.name}${labelSuffix}`.trim(),
            status: n.status
          },
          position: { x: pos.x, y: pos.y },
          style: {
            borderRadius: 8,
            padding: 6,
            border: matchIds.has(n.id) && debouncedSearch ? `2px solid #06b6d4` : isController ? `2px double ${nodeStatusColor(n.status)}` : `1px solid ${nodeStatusColor(n.status)}`,
            background: '#020617',
            color: '#e5e7eb',
            fontSize: 11,
            minWidth: 120
          }
        });
      });
    });

    const visibleIds = new Set(rfNodes.map(n => n.id));
    const rfEdges: RFEdge[] = data.edges
      .filter(e => visibleIds.has(e.from) && visibleIds.has(e.to))
      .map(e => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.type,
        animated: (e.type === 'routes_to' || e.type === 'selects') && rfNodes.length < 300,
      style: { strokeWidth: 1.5 },
      labelStyle: { fontSize: 9, fill: '#9ca3af' },
    }));

    return { rfNodes, rfEdges };
  }, [data, selectedNamespace, showPods, showStorage, showJobs, showIngress, showReplicaSets, debouncedSearch, hideNonMatches, groupControllers, expandedControllers]);

  // Nested component so useReactFlow is inside provider
  const GraphCanvas: React.FC<{ nodes: RFNode[]; edges: RFEdge[] }> = ({ nodes, edges }) => {
    const instance = useReactFlow();
    React.useEffect(() => {
      if (!instance || !debouncedSearch || nodes.length === 0) return;
      const first = nodes.find(n => (n.style as any)?.border?.includes('#06b6d4'));
      if (first) {
        instance.setCenter(first.position.x, first.position.y, { zoom: 1.0, duration: 400 });
      }
    }, [debouncedSearch, nodes, instance]);
    return (
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        minZoom={0.1}
        maxZoom={2}
        onNodeClick={(_, node) => {
          // Toggle expansion when clicking controller nodes
          const controllerKinds = new Set(['Deployment','StatefulSet','DaemonSet','Job','CronJob']);
          const isController = (() => {
            const label: string = (node.data as any)?.label || '';
            const kind = label.split('/')[0];
            return controllerKinds.has(kind);
          })();
          if (groupControllers && isController) {
            const id = node.id;
            setExpandedControllers(prev => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id); else next.add(id);
              return next;
            });
          }
        }}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable maskColor="#0b1220" nodeColor={(n) => {
          const status = (n.data as any)?.status as string | undefined;
          return nodeStatusColor(status);
        }} />
      </ReactFlow>
    );
  };

  // Spotlight search (Cmd+K)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const metaPressed = isMac ? e.metaKey : e.ctrlKey;
      if (metaPressed && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSpotlightOpen(true);
        setSpotlightQuery('');
      }
      if (e.key === 'Escape') {
        setSpotlightOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const spotlightResults = useMemo(() => {
    if (!data) return [] as TopologyNode[];
    const q = spotlightQuery.trim().toLowerCase();
    const all = data.nodes;
    if (!q) return all.slice(0, 50);
    return all.filter(n =>
      n.name.toLowerCase().includes(q) ||
      n.kind.toLowerCase().includes(q) ||
      (n.namespace && n.namespace.toLowerCase().includes(q))
    ).slice(0, 100);
  }, [data, spotlightQuery]);

  const SpotlightUI: React.FC = () => {
    const instance = useReactFlow();
    if (!spotlightOpen) return null;
    return (
      <div className="fixed inset-0 z-[60] flex items-start justify-center p-8" style={{ pointerEvents: 'auto' }}>
        <div className="absolute inset-0 bg-black/60" onClick={() => setSpotlightOpen(false)} />
        <div className="relative w-[720px] bg-[#0b1220] border border-[#1f2937] rounded-lg shadow-xl">
          <input
            autoFocus
            value={spotlightQuery}
            onChange={(e) => setSpotlightQuery(e.target.value)}
            placeholder="Search nodes (Cmd+K)…"
            className="w-full bg-transparent border-b border-[#1f2937] text-sm text-gray-200 px-3 py-2 outline-none"
          />
          <div className="max-h-[50vh] overflow-auto">
            {spotlightResults.map(n => (
              <button
                key={n.id}
                onClick={() => {
                  const rn = rfNodes.find(x => x.id === n.id);
                  if (rn) {
                    instance.setCenter(rn.position.x, rn.position.y, { zoom: 1.2, duration: 400 });
                  }
                  setSpotlightOpen(false);
                }}
                className="w-full text-left px-3 py-2 hover:bg-[#111827]"
              >
                <div className="text-xs text-gray-300">{n.kind}/{n.namespace ? n.namespace + '/' : ''}{n.name}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  };

  if (isLoading) {
    return <div className="h-full flex items-center justify-center bg-black"><Loading size={32} fullScreen /></div>;
  }

  if (isError || !data) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-black text-red-400">
        <AlertCircle size={32} className="mb-2" />
        <div className="text-sm font-medium">Failed to load topology graph</div>
        <div className="text-xs text-gray-500 mt-2">{String((error as Error)?.message ?? error ?? '')}</div>
      </div>
    );
  }

  return (
    <div className="h-full bg-black relative">
      {/* Controls overlay with elevated z-index to remain clickable above ReactFlow layers */}
      <div className="absolute top-2 left-2 z-50 text-xs font-mono px-2 py-1 rounded bg-gray-900/80 border border-gray-700 flex flex-wrap items-center gap-3 max-w-[860px] pointer-events-auto">
        <div className="flex items-center gap-2">
          <span className={isFetching ? 'text-cyan-400' : 'text-green-400'}>
            <span className={`inline-block w-2 h-2 rounded-full mr-1 ${isFetching ? 'animate-pulse bg-cyan-400' : 'bg-green-400'}`}></span>
            {isFetching ? 'Live (updating)' : 'Live'}
          </span>
          <span className="text-gray-500">{new Date(data.generatedAt).toLocaleTimeString()}</span>
        </div>
        <input
          placeholder="Search (kind/name/ns)"
          value={search}
          onChange={e=>setSearch(e.target.value)}
          className="bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-xs w-40"
        />
        <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={hideNonMatches} onChange={e=>setHideNonMatches(e.target.checked)} /> <span>Hide non-matches</span></label>
        <select
          className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-xs"
          value={selectedNamespace}
          onChange={e => setSelectedNamespace(e.target.value)}
        >
          <option value="ALL">All namespaces</option>
          {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
        </select>
        <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showPods} onChange={e=>setShowPods(e.target.checked)} /> <span>Pods</span></label>
        <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showReplicaSets} onChange={e=>setShowReplicaSets(e.target.checked)} /> <span>ReplicaSets</span></label>
        <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showJobs} onChange={e=>setShowJobs(e.target.checked)} /> <span>Jobs</span></label>
        <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showIngress} onChange={e=>setShowIngress(e.target.checked)} /> <span>Ingress</span></label>
        <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={showStorage} onChange={e=>setShowStorage(e.target.checked)} /> <span>Storage</span></label>
        <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={groupControllers} onChange={e=>setGroupControllers(e.target.checked)} /> <span>Group Controllers</span></label>
        {groupControllers && (
          <span className="text-gray-500">Click a controller to expand/collapse</span>
        )}
        {groupControllers && (
          <>
            <button
              className="px-2 py-0.5 rounded bg-[#0f172a] border border-gray-700"
              onClick={() => {
                if (!data) return;
                const controllerKinds = new Set(['Deployment','StatefulSet','DaemonSet','Job','CronJob']);
                const allControllerIds = data.nodes.filter(n => controllerKinds.has(n.kind)).map(n => n.id);
                setExpandedControllers(new Set(allControllerIds));
              }}
            >Expand all</button>
            <button
              className="px-2 py-0.5 rounded bg-[#0f172a] border border-gray-700"
              onClick={() => setExpandedControllers(new Set())}
            >Collapse all</button>
          </>
        )}
        <button className="px-2 py-0.5 rounded bg-[#111827] border border-gray-700" onClick={() => setSpotlightOpen(true)}>Spotlight (Cmd+K)</button>
        <span className="text-gray-500 ml-auto">{rfNodes.length} nodes / {rfEdges.length} edges</span>
      </div>
      <ReactFlowProvider>
        <GraphCanvas nodes={rfNodes} edges={rfEdges} />
        <SpotlightUI />
      </ReactFlowProvider>
    </div>
  );
};
