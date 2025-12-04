
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
// NOTE: For local development, run: npm install @tauri-apps/api
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useQuery, useMutation, useQueryClient, QueryClient } from "@tanstack/react-query";
import { Updater } from "./components/Updater";
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import Editor from '@monaco-editor/react';
import { Virtuoso } from "react-virtuoso";
import ReactMarkdown from 'react-markdown';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart as RechartsPieChart, Pie, Cell, BarChart, Bar, Legend } from 'recharts';
import {
  Activity,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Filter,
  FolderOpen,
  Layers,
  Package,
  Plug,
  Search,
  Settings,
  Terminal as TerminalIcon,
  Trash2,
  X,
  Check,
  ServerOff,
  FileCode,
  Loader2,
  Cloud,
  FileCog,
  Network,
  HardDrive,
  Shield,
  PieChart,
  Server,
  Puzzle,
  RefreshCw,
  LogOut as LogOutIcon,
  Cpu,
  Eye,
  EyeOff,
  List,
  Tags,
  Save,
  Minus,
  LayoutDashboard,
  Globe,
  Sparkles,
  Box,
  MoreVertical,
  Copy,
  ExternalLink,
  Play,
  Square,
  Maximize2,
  Minimize2,
  GripVertical,
  Gauge,
  Zap,
  Clock,
  ArrowUpDown,
  MessageSquare,
  Send
} from "lucide-react";
// Topology view removed per user request
import Loading from './components/Loading';

// --- Types ---
interface NavResource {
  kind: string;
  group: string;
  version: string;
  namespaced: boolean;
  title: string;
}

interface NavGroup {
  title: string;
  items: NavResource[];
}

interface K8sObject {
  id: string;
  name: string;
  namespace: string;
  status: string;
  kind: string;
  group: string;
  version: string;
  age: string;
  raw_json: string;
  // Pod-specific fields (optional)
  ready?: string;
  restarts?: number;
  node?: string;
  ip?: string;
}

interface K8sEvent {
  message: string;
  reason: string;
  type_: string;
  age: string;
  count: number;
}

interface ClusterStats {
  nodes: number;
  pods: number;
  deployments: number;
  services: number;
  namespaces: number;
}

// Comprehensive cockpit data structures
interface NodeCondition {
  type_: string;
  status: string;
  message: string;
}

interface NodeHealth {
  name: string;
  status: string;
  cpu_capacity: number;
  cpu_allocatable: number;
  cpu_usage: number;
  memory_capacity: number;
  memory_allocatable: number;
  memory_usage: number;
  pods_capacity: number;
  pods_running: number;
  conditions: NodeCondition[];
  taints: string[];
}

interface PodStatusBreakdown {
  running: number;
  pending: number;
  succeeded: number;
  failed: number;
  unknown: number;
}

interface DeploymentHealth {
  name: string;
  namespace: string;
  desired: number;
  ready: number;
  available: number;
  up_to_date: number;
}

interface NamespaceUsage {
  name: string;
  pod_count: number;
  cpu_usage: number;
  memory_usage: number;
}

interface ClusterCockpitData {
  total_nodes: number;
  healthy_nodes: number;
  total_pods: number;
  total_deployments: number;
  total_services: number;
  total_namespaces: number;
  total_cpu_capacity: number;
  total_cpu_allocatable: number;
  total_cpu_usage: number;
  total_memory_capacity: number;
  total_memory_allocatable: number;
  total_memory_usage: number;
  total_pods_capacity: number;
  pod_status: PodStatusBreakdown;
  nodes: NodeHealth[];
  unhealthy_deployments: DeploymentHealth[];
  top_namespaces: NamespaceUsage[];
  warning_count: number;
  critical_count: number;
  metrics_available: boolean;
}

// Cluster-wide health summary for AI chat
interface ClusterHealthSummary {
  total_nodes: number;
  ready_nodes: number;
  not_ready_nodes: string[];
  total_pods: number;
  running_pods: number;
  pending_pods: number;
  failed_pods: number;
  crashloop_pods: PodIssue[];
  total_deployments: number;
  healthy_deployments: number;
  unhealthy_deployments: DeploymentIssue[];
  cluster_cpu_percent: number;
  cluster_memory_percent: number;
  critical_issues: ClusterIssue[];
  warnings: ClusterIssue[];
}

interface PodIssue {
  name: string;
  namespace: string;
  status: string;
  restart_count: number;
  reason: string;
  message: string;
}

interface DeploymentIssue {
  name: string;
  namespace: string;
  desired: number;
  ready: number;
  available: number;
  reason: string;
}

interface ClusterIssue {
  severity: string;
  resource_kind: string;
  resource_name: string;
  namespace: string;
  message: string;
}

interface ClusterEventSummary {
  namespace: string;
  name: string;
  kind: string;
  reason: string;
  message: string;
  count: number;
  last_seen: string;
  event_type: string;
}

// Ollama AI status (legacy)
interface OllamaStatus {
  ollama_running: boolean;
  model_available: boolean;
  model_name: string;
  available_models: string[];
  error: string | null;
}

// LLM Provider types
type LLMProvider = 'ollama' | 'openai' | 'anthropic' | 'custom';

interface LLMConfig {
  provider: LLMProvider;
  api_key: string | null;
  base_url: string;
  model: string;
  temperature: number;
  max_tokens: number;
}

interface LLMStatus {
  connected: boolean;
  provider: string;
  model: string;
  available_models: string[];
  error: string | null;
}

// Default LLM configurations
const DEFAULT_LLM_CONFIGS: Record<LLMProvider, LLMConfig> = {
  ollama: {
    provider: 'ollama',
    api_key: null,
    base_url: 'http://127.0.0.1:11434',
    model: 'llama3.1:8b',
    temperature: 0.2,
    max_tokens: 2048,
  },
  openai: {
    provider: 'openai',
    api_key: null,
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    temperature: 0.2,
    max_tokens: 2048,
  },
  anthropic: {
    provider: 'anthropic',
    api_key: null,
    base_url: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
    temperature: 0.2,
    max_tokens: 2048,
  },
  custom: {
    provider: 'custom',
    api_key: null,
    base_url: 'http://localhost:8000/v1',
    model: 'default',
    temperature: 0.2,
    max_tokens: 2048,
  },
};

// Combined initial data for faster first load
interface InitialClusterData {
  stats: ClusterStats;
  namespaces: string[];
  pods: K8sObject[];
  nodes: K8sObject[];
  deployments: K8sObject[];
  services: K8sObject[];
}

interface ResourceMetrics {
  name: string;
  namespace: string;
  cpu: string;
  memory: string;
  cpu_nano: number;
  memory_bytes: number;
  cpu_limit_nano?: number;
  memory_limit_bytes?: number;
  cpu_percent?: number;
  memory_percent?: number;
  timestamp: number;
}

interface ResourceWatchEvent {
  event_type: "ADDED" | "MODIFIED" | "DELETED";
  resource: K8sObject;
}

interface AzureSubscription {
  id: string;
  name: string;
  state: string;
  isDefault: boolean;
  clusters: AksCluster[];
}

interface AksCluster {
  id: string;
  name: string;
  resourceGroup: string;
  location: string;
  powerState: {
    code: string;
  };
}

// Icon Helper
const getCategoryIcon = (title: string) => {
  switch (title) {
    case "Workloads": return <Cpu size={18} />;
    case "Network": return <Network size={18} />;
    case "Storage": return <HardDrive size={18} />;
    case "Config": return <FileCode size={18} />;
    case "Access Control": return <Shield size={18} />;
    case "Cluster": return <Server size={18} />;
    default: return <img src="/icon.png" alt="icon" className="w-[18px] h-[18px]" />;
  }
};

// Format age as relative time
const formatAge = (isoDate: string): string => {
  const now = Date.now();
  const created = new Date(isoDate).getTime();
  const diffMs = now - created;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
};

// Hook to trigger periodic re-renders for live age updates
function useLiveAge(intervalMs: number = 1000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return tick;
}

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      gcTime: 1000 * 60 * 60 * 24, // 24 hours
    },
  },
});

// Create persister for localStorage
const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'opspilot-cache',
});

function LoadingScreen({ message }: { message: string }) {
  return (
    <div className="h-screen bg-[#0f0f12] text-white flex flex-col items-center justify-center relative overflow-hidden">
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] bg-blue-600/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-purple-600/10 rounded-full blur-[120px] pointer-events-none" />

      <div className="z-10 flex flex-col items-center">
        <div className="relative mb-8">
          <div className="absolute inset-0 bg-blue-500/20 blur-xl rounded-full animate-pulse" />
          <Loader2 className="animate-spin text-blue-500 relative z-10" size={48} />
        </div>
        <div className="flex items-center gap-3 mb-2">
          <img src="/icon.png" alt="OpsPilot" className="w-8 h-8" />
          <h2 className="text-2xl font-bold tracking-tight">OpsPilot</h2>
        </div>
        <p className="text-gray-400 animate-pulse font-medium">{message}</p>
      </div>
    </div>
  );
}

// --- Terminal Tab ---
// --- Terminal Tab ---
function TerminalTab({ namespace, name, podSpec }: { namespace: string, name: string, podSpec: any }) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const unlistenClosedRef = useRef<(() => void) | null>(null);
  const sessionId = useMemo(() => `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, []);

  const [selectedContainer, setSelectedContainer] = useState<string>("");
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  // Extract containers from spec
  const containers = useMemo(() => [
    ...(podSpec?.containers || []).map((c: any) => c.name),
    ...(podSpec?.initContainers || []).map((c: any) => c.name)
  ], [podSpec]);

  // Set default container
  useEffect(() => {
    if (containers.length > 0 && !selectedContainer) {
      setSelectedContainer(containers[0]);
    }
  }, [containers, selectedContainer]);

  const cleanupTerminal = useCallback(() => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    if (unlistenClosedRef.current) {
      unlistenClosedRef.current();
      unlistenClosedRef.current = null;
    }
    if (xtermRef.current) {
      xtermRef.current.dispose();
      xtermRef.current = null;
    }
    fitAddonRef.current = null;
  }, []);

  const handleDisconnect = useCallback(() => {
    cleanupTerminal();
    setIsConnected(false);
    setIsConnecting(false);
  }, [cleanupTerminal]);

  const handleConnect = useCallback(async () => {
    if (!terminalRef.current || !selectedContainer) return;

    // Clean up any existing terminal first
    cleanupTerminal();
    setIsConnecting(true);

    // Initialize xterm with optimized settings
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontWeight: '400',
      letterSpacing: 0,
      lineHeight: 1.2,
      scrollback: 10000,
      fastScrollModifier: 'alt',
      fastScrollSensitivity: 5,
      theme: {
        background: '#0d0d0d',
        foreground: '#e0e0e0',
        cursor: '#f0f0f0',
        cursorAccent: '#0d0d0d',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#e06c75',
        green: '#98c379',
        yellow: '#e5c07b',
        blue: '#61afef',
        magenta: '#c678dd',
        cyan: '#56b6c2',
        white: '#abb2bf',
        brightBlack: '#5c6370',
        brightRed: '#e06c75',
        brightGreen: '#98c379',
        brightYellow: '#e5c07b',
        brightBlue: '#61afef',
        brightMagenta: '#c678dd',
        brightCyan: '#56b6c2',
        brightWhite: '#ffffff',
      }
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Try WebGL, fall back gracefully
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      term.loadAddon(webglAddon);
    } catch {
      // WebGL not available, canvas renderer will be used
    }

    term.open(terminalRef.current);

    // Fit after a brief delay to ensure proper sizing
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch {}
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    term.writeln(`\x1b[33mConnecting to container '\x1b[1m${selectedContainer}\x1b[0m\x1b[33m'...\x1b[0m`);

    // Set up event listeners before connecting
    const outputUnlisten = await listen<string>(`term_output:${sessionId}`, (event) => {
      if (xtermRef.current) {
        xtermRef.current.write(event.payload);
      }
    });
    unlistenRef.current = outputUnlisten;

    const closedUnlisten = await listen(`term_closed:${sessionId}`, () => {
      if (xtermRef.current) {
        xtermRef.current.writeln('\r\n\x1b[31mConnection closed by remote host.\x1b[0m');
      }
      setIsConnected(false);
    });
    unlistenClosedRef.current = closedUnlisten;

    // Handle Input - send immediately for responsiveness
    const inputDisposable = term.onData(data => {
      invoke("send_exec_input", { sessionId, data }).catch(() => {});
    });

    // Handle Resize with debounce
    let resizeTimeout: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (fitAddonRef.current && xtermRef.current) {
          try {
            fitAddonRef.current.fit();
          } catch {}
        }
      }, 100);
    };
    window.addEventListener("resize", handleResize);

    try {
      await invoke("start_exec", { namespace, name, container: selectedContainer, sessionId });
      term.writeln(`\x1b[32mConnected to ${name}/${selectedContainer}\x1b[0m\r\n`);
      // Fit terminal after connection established with slight delay for DOM to settle
      setTimeout(() => {
        if (fitAddonRef.current) {
          try { fitAddonRef.current.fit(); } catch {}
        }
      }, 50);
      term.focus();
      setIsConnected(true);
    } catch (err) {
      term.writeln(`\x1b[31mFailed to connect: ${err}\x1b[0m`);
      cleanupTerminal();
    } finally {
      setIsConnecting(false);
    }

    // Return cleanup
    return () => {
      clearTimeout(resizeTimeout);
      inputDisposable.dispose();
      window.removeEventListener("resize", handleResize);
    };
  }, [namespace, name, selectedContainer, sessionId, cleanupTerminal]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupTerminal();
    };
  }, [cleanupTerminal]);

  // Show loading if containers not yet available
  if (containers.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-gray-500">
        <Loading size={24} label="Loading container list..." />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex items-center gap-2 shrink-0 bg-[#252526] p-1 rounded border border-[#3e3e42]">
        <div className="flex items-center gap-2 px-2">
          <label className="text-[10px] uppercase font-bold text-[#858585]">Container:</label>
          <div className="relative">
            <select
              value={selectedContainer}
              onChange={(e) => setSelectedContainer(e.target.value)}
              disabled={isConnected || isConnecting}
              className="bg-[#1e1e1e] border border-[#3e3e42] text-[#cccccc] text-xs rounded pl-2 pr-6 py-1 appearance-none focus:border-[#007acc] focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed min-w-[150px]"
            >
              {containers.map((c: string) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[#858585]">
              <ChevronDown size={10} />
            </div>
          </div>
        </div>

        <div className="h-4 w-px bg-[#3e3e42]" />

        {!isConnected ? (
          <button
            onClick={handleConnect}
            disabled={isConnecting || !selectedContainer}
            className="flex items-center gap-1.5 px-3 py-1 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isConnecting ? <Loading size={10} label="" /> : <TerminalIcon size={12} />}
            Connect
          </button>
        ) : (
          <button
            onClick={handleDisconnect}
            className="flex items-center gap-1.5 px-3 py-1 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded transition-colors"
          >
            <X size={12} />
            Disconnect
          </button>
        )}

        {isConnected && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-[#4ec9b0] px-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#4ec9b0] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[#4ec9b0]"></span>
            </span>
            Live Session
          </span>
        )}
      </div>

      <div className="flex-1 bg-[#1e1e1e] p-2 rounded-md border border-[#3e3e42] overflow-hidden relative">
        {!isConnected && !isConnecting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-500 z-10">
            <TerminalIcon size={48} className="mb-4 opacity-20" />
            <p className="text-sm">Select a container and click Connect</p>
          </div>
        )}
        <div ref={terminalRef} className="h-full w-full" />
      </div>
    </div>
  );
}

// --- Metrics Chart Component ---
function MetricsChart({ resourceKind, namespace, name, currentContext }: { resourceKind: string, namespace: string, name: string, currentContext?: string }) {
  const [metricsHistory, setMetricsHistory] = useState<ResourceMetrics[]>([]);

  const { data: currentMetrics } = useQuery({
    queryKey: ["metrics_chart", currentContext, resourceKind, namespace, name],
    queryFn: async () => {
      const allMetrics = await invoke<ResourceMetrics[]>("get_resource_metrics", {
        kind: resourceKind,
        namespace: resourceKind === "Pod" ? namespace : null
      });
      return allMetrics.find(m => m.name === name);
    },
    enabled: resourceKind === "Pod" || resourceKind === "Node",
    refetchInterval: 5000,
  });

  // Clear metrics history when context changes
  useEffect(() => {
    setMetricsHistory([]);
  }, [currentContext]);

  useEffect(() => {
    if (currentMetrics) {
      setMetricsHistory(prev => {
        const updated = [...prev, currentMetrics];
        // Keep last 60 data points (5 minutes at 5s intervals)
        return updated.slice(-60);
      });
    }
  }, [currentMetrics]);

  const getPercentageColor = (percent?: number) => {
    if (!percent) return '#6b7280'; // gray-500
    if (percent >= 90) return '#f87171'; // red-400
    if (percent >= 70) return '#fbbf24'; // yellow-400
    return '#34d399'; // green-400
  };

  const chartData = metricsHistory.map(m => ({
    time: new Date(m.timestamp).toLocaleTimeString(),
    cpu: (m.cpu_nano / 1_000_000).toFixed(2), // Convert to millicores
    memory: (m.memory_bytes / (1024 * 1024)).toFixed(2), // Convert to Mi
    cpuPercent: m.cpu_percent || 0,
    memoryPercent: m.memory_percent || 0,
  }));

  if (metricsHistory.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm bg-gradient-to-br from-gray-900 to-black rounded-lg border border-gray-800">
        Collecting metrics data...
      </div>
    );
  }

  const latest = metricsHistory[metricsHistory.length - 1];
  const cpuColor = getPercentageColor(latest.cpu_percent);
  const memoryColor = getPercentageColor(latest.memory_percent);

  return (
    <div className="space-y-4">
      {/* Current Usage with Percentage Indicators */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-gradient-to-br from-gray-900 to-black p-4 rounded-lg border border-gray-800 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Cpu size={16} className="text-green-400" />
              <span className="text-gray-400 text-xs uppercase font-bold">CPU Usage</span>
            </div>
            {latest.cpu_percent !== undefined && (
              <div
                className="px-2 py-1 rounded text-xs font-bold shadow-sm"
                style={{
                  backgroundColor: `${cpuColor}30`,
                  color: cpuColor,
                  border: `1px solid ${cpuColor}60`
                }}
              >
                {latest.cpu_percent.toFixed(1)}%
              </div>
            )}
          </div>
          <div className="text-white text-2xl font-semibold">{latest.cpu}</div>
          {latest.cpu_limit_nano && (
            <div className="text-gray-500 text-xs mt-1">
              Limit: {(latest.cpu_limit_nano / 1_000_000_000).toFixed(2)} cores
            </div>
          )}
          {latest.cpu_percent !== undefined && (
            <div className="mt-2 h-2 bg-gray-800 rounded overflow-hidden">
              <div
                className="h-full transition-all duration-500 shadow-sm"
                style={{
                  width: `${Math.min(latest.cpu_percent, 100)}%`,
                  backgroundColor: cpuColor,
                  boxShadow: `0 0 8px ${cpuColor}80`
                }}
              />
            </div>
          )}
        </div>

        <div className="bg-gradient-to-br from-gray-900 to-black p-4 rounded-lg border border-gray-800 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <HardDrive size={16} className="text-orange-400" />
              <span className="text-gray-400 text-xs uppercase font-bold">Memory Usage</span>
            </div>
            {latest.memory_percent !== undefined && (
              <div
                className="px-2 py-1 rounded text-xs font-bold shadow-sm"
                style={{
                  backgroundColor: `${memoryColor}30`,
                  color: memoryColor,
                  border: `1px solid ${memoryColor}60`
                }}
              >
                {latest.memory_percent.toFixed(1)}%
              </div>
            )}
          </div>
          <div className="text-white text-2xl font-semibold">{latest.memory}</div>
          {latest.memory_limit_bytes && (
            <div className="text-gray-500 text-xs mt-1">
              Limit: {(latest.memory_limit_bytes / (1024 * 1024 * 1024)).toFixed(2)} Gi
            </div>
          )}
          {latest.memory_percent !== undefined && (
            <div className="mt-2 h-2 bg-gray-800 rounded overflow-hidden">
              <div
                className="h-full transition-all duration-500 shadow-sm"
                style={{
                  width: `${Math.min(latest.memory_percent, 100)}%`,
                  backgroundColor: memoryColor,
                  boxShadow: `0 0 8px ${memoryColor}80`
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Time Series Charts */}
      <div className="bg-gradient-to-br from-gray-900 to-black p-4 rounded-lg border border-gray-800 shadow-lg">
        <h4 className="text-purple-400 text-xs uppercase font-bold mb-4">Resource Usage Over Time</h4>
        <div className="grid grid-cols-1 gap-6">
          {/* CPU Chart */}
          <div>
            <div className="text-gray-400 text-xs mb-2 font-semibold">CPU (millicores)</div>
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis
                  dataKey="time"
                  stroke="#6b7280"
                  style={{ fontSize: '10px' }}
                  tick={{ fill: '#6b7280' }}
                />
                <YAxis
                  stroke="#6b7280"
                  style={{ fontSize: '10px' }}
                  tick={{ fill: '#6b7280' }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#000000',
                    border: '1px solid #374151',
                    borderRadius: '8px',
                    fontSize: '12px',
                    boxShadow: '0 4px 6px rgba(0, 0, 0, 0.5)'
                  }}
                  labelStyle={{ color: '#ffffff' }}
                />
                <Line
                  type="monotone"
                  dataKey="cpu"
                  stroke="#34d399"
                  strokeWidth={2}
                  dot={false}
                  name="CPU (m)"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Memory Chart */}
          <div>
            <div className="text-gray-400 text-xs mb-2 font-semibold">Memory (MiB)</div>
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis
                  dataKey="time"
                  stroke="#6b7280"
                  style={{ fontSize: '10px' }}
                  tick={{ fill: '#6b7280' }}
                />
                <YAxis
                  stroke="#6b7280"
                  style={{ fontSize: '10px' }}
                  tick={{ fill: '#6b7280' }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#000000',
                    border: '1px solid #374151',
                    borderRadius: '8px',
                    fontSize: '12px',
                    boxShadow: '0 4px 6px rgba(0, 0, 0, 0.5)'
                  }}
                  labelStyle={{ color: '#ffffff' }}
                />
                <Line
                  type="monotone"
                  dataKey="memory"
                  stroke="#fb923c"
                  strokeWidth={2}
                  dot={false}
                  name="Memory (Mi)"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Local Terminal Tab ---
function LocalTerminalTab() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const unlistenOutputRef = useRef<(() => void) | null>(null);
  const unlistenClosedRef = useRef<(() => void) | null>(null);
  const sessionId = useMemo(() => `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, []);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!terminalRef.current) return;

    let mounted = true;

    const initTerminal = async () => {
      // Initialize xterm with optimized settings
      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace",
        fontWeight: '400',
        letterSpacing: 0,
        lineHeight: 1.2,
        scrollback: 50000,
        fastScrollModifier: 'alt',
        fastScrollSensitivity: 5,
        allowProposedApi: true,
        theme: {
          background: '#0d0d0d',
          foreground: '#e0e0e0',
          cursor: '#f0f0f0',
          cursorAccent: '#0d0d0d',
          selectionBackground: '#264f78',
          black: '#000000',
          red: '#e06c75',
          green: '#98c379',
          yellow: '#e5c07b',
          blue: '#61afef',
          magenta: '#c678dd',
          cyan: '#56b6c2',
          white: '#abb2bf',
          brightBlack: '#5c6370',
          brightRed: '#e06c75',
          brightGreen: '#98c379',
          brightYellow: '#e5c07b',
          brightBlue: '#61afef',
          brightMagenta: '#c678dd',
          brightCyan: '#56b6c2',
          brightWhite: '#ffffff',
        }
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      // Try WebGL for better performance
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => webglAddon.dispose());
        term.loadAddon(webglAddon);
      } catch {
        // Canvas fallback
      }

      if (!terminalRef.current || !mounted) {
        term.dispose();
        return;
      }

      term.open(terminalRef.current);
      xtermRef.current = term;
      fitAddonRef.current = fitAddon;

      // Set up event listeners
      const outputUnlisten = await listen<string>(`shell_output:${sessionId}`, (event) => {
        if (xtermRef.current) {
          xtermRef.current.write(event.payload);
        }
      });
      unlistenOutputRef.current = outputUnlisten;

      const closedUnlisten = await listen(`shell_closed:${sessionId}`, () => {
        if (xtermRef.current) {
          xtermRef.current.writeln('\r\n\x1b[31mShell session ended.\x1b[0m');
        }
      });
      unlistenClosedRef.current = closedUnlisten;

      // Handle Input
      const inputDisposable = term.onData(data => {
        invoke("send_shell_input", { sessionId, data }).catch(() => {});
      });

      // Handle Resize with debounce
      let resizeTimeout: ReturnType<typeof setTimeout>;
      const handleResize = () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          if (fitAddonRef.current && xtermRef.current) {
            try {
              fitAddonRef.current.fit();
              const { cols, rows } = xtermRef.current;
              invoke("resize_shell", { sessionId, rows, cols }).catch(() => {});
            } catch {}
          }
        }, 50);
      };
      window.addEventListener("resize", handleResize);

      // Start shell
      try {
        await invoke("start_local_shell", { sessionId });
        if (mounted) {
          setIsReady(true);
          // Fit and focus after shell starts
          requestAnimationFrame(() => {
            handleResize();
            term.focus();
          });
        }
      } catch (err) {
        term.writeln(`\x1b[31mFailed to start shell: ${err}\x1b[0m`);
      }

      // Return cleanup
      return () => {
        clearTimeout(resizeTimeout);
        inputDisposable.dispose();
        window.removeEventListener("resize", handleResize);
      };
    };

    const cleanupFn = initTerminal();

    return () => {
      mounted = false;
      cleanupFn.then(fn => fn?.());

      if (unlistenOutputRef.current) {
        unlistenOutputRef.current();
        unlistenOutputRef.current = null;
      }
      if (unlistenClosedRef.current) {
        unlistenClosedRef.current();
        unlistenClosedRef.current = null;
      }
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
      // Kill the shell session
      invoke("stop_local_shell", { sessionId }).catch(() => {});
    };
  }, [sessionId]);

  return (
    <div className="h-full bg-[#0d0d0d] overflow-hidden relative">
      {!isReady && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d0d0d] z-10">
          <div className="flex items-center gap-2 text-zinc-500">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Starting shell...</span>
          </div>
        </div>
      )}
      <div ref={terminalRef} className="h-full w-full" />
    </div>
  );
}

function ConnectionScreen({ onConnect, onOpenAzure }: { onConnect: () => void, onOpenAzure: () => void }) {
  const [customPath, setCustomPath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"local" | "azure">("local");
  const [connectionLogs, setConnectionLogs] = useState<Array<{ time: string; message: string; status: 'pending' | 'success' | 'error' | 'info' }>>([]);
  const qc = useQueryClient();

  const addLog = (message: string, status: 'pending' | 'success' | 'error' | 'info' = 'info') => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setConnectionLogs(prev => [...prev, { time, message, status }]);
  };

  const { data: contexts, isLoading } = useQuery({
    queryKey: ["kube_contexts", customPath],
    queryFn: async () => {
      const result = await invoke<{ name: string }[]>("list_contexts", { customPath });
      return result.map(c => c.name);
    },
  });

  const { data: currentContext } = useQuery({
    queryKey: ["current_context", customPath],
    queryFn: async () => await invoke<string>("get_current_context_name", { customPath }),
  });

  const filteredContexts = useMemo(() => {
    if (!contexts) return [];
    if (!searchQuery) return contexts;
    return contexts.filter(c => c.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [contexts, searchQuery]);

  const connectMutation = useMutation({
    mutationFn: async (context: string) => {
      setConnectionLogs([]);
      addLog(`Initiating connection to ${context}`, 'info');

      // Reset all state and release locks first
      try {
        addLog('Resetting backend state...', 'pending');
        await Promise.race([
          invoke("reset_state"),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Reset timeout")), 1000)
          )
        ]);
        addLog('Backend state cleared', 'success');
      } catch (err) {
        addLog('Backend reset skipped (non-critical)', 'info');
      }

      // Try to set the context and validate connection
      addLog('Loading kubeconfig...', 'pending');
      await new Promise(r => setTimeout(r, 200));
      addLog('Connecting to cluster...', 'pending');

      try {
        const result = await Promise.race([
          invoke<string>("set_kube_config", { context, path: customPath }),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error("Connection timeout after 15 seconds")), 15000)
          )
        ]);
        addLog(result || 'Connected successfully', 'success');
      } catch (err: any) {
        const errorMsg = err?.message || String(err);
        addLog(`Connection failed: ${errorMsg}`, 'error');
        throw new Error(errorMsg);
      }

      addLog('Preparing API discovery...', 'pending');
      await new Promise(r => setTimeout(r, 200));

      return Promise.resolve();
    },
    onSuccess: async () => {
      addLog('Connection established!', 'success');
      addLog('Clearing cached data...', 'pending');

      // Clear backend caches first
      try {
        await invoke("clear_all_caches");
      } catch (e) {
        console.warn("Failed to clear backend caches:", e);
      }

      // Invalidate ALL cached data to prevent showing stale data from previous cluster
      qc.invalidateQueries({ queryKey: ["current_context"] });
      qc.invalidateQueries({ queryKey: ["current_context_boot"] });
      qc.invalidateQueries({ queryKey: ["current_context_global"] });
      qc.invalidateQueries({ queryKey: ["discovery"] });
      qc.invalidateQueries({ queryKey: ["namespaces"] });
      qc.invalidateQueries({ queryKey: ["cluster_stats"] });
      qc.invalidateQueries({ queryKey: ["cluster_cockpit"] });
      qc.invalidateQueries({ queryKey: ["initial_cluster_data"] });
      qc.invalidateQueries({ queryKey: ["vclusters"] });
      qc.invalidateQueries({ queryKey: ["list_resources"] });
      qc.invalidateQueries({ queryKey: ["crd-groups"] });
      qc.invalidateQueries({ queryKey: ["metrics"] });
      qc.invalidateQueries({ queryKey: ["pod_metrics"] });
      qc.invalidateQueries({ queryKey: ["node_metrics"] });
      qc.clear();
      addLog('Loading cluster dashboard...', 'success');
      setTimeout(() => onConnect(), 500);
    },
    onError: (error: Error) => {
      addLog(`Connection failed: ${error.message}`, 'error');
      console.error("Connection error:", error);
    }
  });

  // Add error state for connection failures
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Delete context state
  const [contextToDelete, setContextToDelete] = useState<string | null>(null);

  // Delete context mutation
  const deleteMutation = useMutation({
    mutationFn: async (contextName: string) => {
      await invoke("delete_context", { contextName, customPath });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kube_contexts"] });
      setContextToDelete(null);
    },
  });

  // Wrap mutation to handle error state
  const handleConnect = (ctx: string) => {
    setConnectionError(null);
    connectMutation.mutate(ctx, {
      onError: (err) => {
        setConnectionError(err.message);
      }
    });
  };

  const handleDeleteContext = (ctx: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering connect
    setContextToDelete(ctx);
  };

  const handleFileSelect = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'Kubeconfig',
          extensions: ['yaml', 'yml', 'config', 'kubeconfig']
        }]
      });

      if (selected && typeof selected === 'string') {
        setCustomPath(selected);
      }
    } catch (err) {
      console.error("Failed to open file dialog", err);
    }
  };

  if (isLoading) return <LoadingScreen message="Loading Kubeconfig..." />;

  return (
    <div className="h-screen w-full bg-[#09090b] flex items-center justify-center relative overflow-hidden">
      {/* Animated Background */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-[-30%] left-[-20%] w-[70%] h-[70%] bg-gradient-to-br from-purple-600/20 via-purple-900/10 to-transparent rounded-full blur-[100px] animate-pulse" style={{ animationDuration: '8s' }} />
        <div className="absolute bottom-[-30%] right-[-20%] w-[70%] h-[70%] bg-gradient-to-tl from-cyan-600/20 via-blue-900/10 to-transparent rounded-full blur-[100px] animate-pulse" style={{ animationDuration: '10s' }} />
        <div className="absolute top-[20%] right-[10%] w-[40%] h-[40%] bg-gradient-to-bl from-blue-600/10 to-transparent rounded-full blur-[80px] animate-pulse" style={{ animationDuration: '12s' }} />
      </div>

      {/* Grid Pattern Overlay */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(ellipse_50%_50%_at_50%_50%,black_40%,transparent_100%)]" />

      <div className="w-full max-w-2xl z-10 animate-in fade-in zoom-in-95 duration-700 px-4">
        {/* Hero Section */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border border-cyan-500/20 mb-6">
            <Sparkles size={14} className="text-cyan-400" />
            <span className="text-xs font-medium text-cyan-300">Kubernetes Management Made Simple</span>
          </div>

          <div className="w-24 h-24 mx-auto mb-6 relative group">
            <div className="absolute inset-0 bg-blue-600/20 rounded-3xl blur-xl opacity-50 group-hover:opacity-75 transition-all duration-700 group-hover:scale-110" />
            <img src="/icon.png" alt="OpsPilot" className="relative w-full h-full rounded-3xl shadow-2xl border border-white/10" />
          </div>

          <h1 className="text-4xl font-bold text-white mb-3 tracking-tight">
            Welcome to <span className="bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">OpsPilot</span>
          </h1>
          <p className="text-zinc-400 text-base max-w-md mx-auto">
            Connect to your Kubernetes clusters and manage resources with ease
          </p>
        </div>

        {/* Connection Options Card */}
        <div className="glass-panel border border-white/10 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-xl bg-black/40">
          {/* Tab Selector */}
          <div className="flex border-b border-white/5">
            <button
              onClick={() => setActiveTab("local")}
              className={`flex-1 px-6 py-4 text-sm font-medium transition-all relative ${activeTab === "local" ? "text-white" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              <div className="flex items-center justify-center gap-2">
                <FileCode size={18} />
                <span>Local Kubeconfig</span>
              </div>
              {activeTab === "local" && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-cyan-500 to-blue-500" />
              )}
            </button>
            <button
              onClick={() => setActiveTab("azure")}
              className={`flex-1 px-6 py-4 text-sm font-medium transition-all relative ${activeTab === "azure" ? "text-white" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              <div className="flex items-center justify-center gap-2">
                <Cloud size={18} />
                <span>Azure AKS</span>
              </div>
              {activeTab === "azure" && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-500 to-purple-500" />
              )}
            </button>
          </div>

          {activeTab === "local" ? (
            <div className="p-6 space-y-5">
              {/* Kubeconfig Path */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-2">
                  <FileCode size={12} />
                  Kubeconfig File
                </label>
                <div className="flex gap-2">
                  <div className="flex-1 bg-zinc-900/50 border border-white/10 rounded-xl px-4 py-3 text-sm text-zinc-300 truncate flex items-center hover:border-white/20 transition-colors group">
                    <span className="truncate opacity-70 group-hover:opacity-100 transition-opacity">{customPath || "~/.kube/config"}</span>
                  </div>
                  <button
                    onClick={handleFileSelect}
                    className="bg-zinc-800 hover:bg-zinc-700 text-white px-4 py-3 rounded-xl border border-white/10 transition-all hover:shadow-lg hover:shadow-cyan-500/10 active:scale-95 flex items-center gap-2"
                    title="Browse for kubeconfig file"
                  >
                    <FolderOpen size={18} />
                    <span className="text-sm font-medium">Browse</span>
                  </button>
                </div>
              </div>

              {/* Search */}
              <div className="relative">
                <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search contexts..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-zinc-900/50 border border-white/10 rounded-xl pl-11 pr-4 py-3 text-zinc-200 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500/50 transition-all placeholder:text-zinc-600"
                />
                {contexts && (
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-zinc-600">
                    {filteredContexts.length} context{filteredContexts.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {/* Error Message */}
              {connectionError && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
                  <AlertCircle size={18} className="shrink-0 mt-0.5" />
                  <span className="leading-relaxed">{connectionError}</span>
                </div>
              )}

              {/* Connecting Overlay with Live Logs */}
              {connectMutation.isPending && (
                <div className="bg-zinc-900/95 backdrop-blur-sm border border-cyan-500/20 rounded-xl overflow-hidden mb-4 animate-in fade-in">
                  {/* Header */}
                  <div className="flex items-center justify-between p-4 border-b border-white/5">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-cyan-500/20 flex items-center justify-center">
                        <Loader2 size={20} className="animate-spin text-cyan-400" />
                      </div>
                      <div>
                        <p className="text-white font-medium">Connecting to cluster</p>
                        <p className="text-zinc-500 text-xs font-mono truncate max-w-[280px]">{connectMutation.variables}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setConnectionLogs([]);
                        connectMutation.reset();
                      }}
                      className="px-3 py-1.5 rounded-lg bg-red-600/80 hover:bg-red-500 text-white text-xs font-medium transition-all flex items-center gap-1.5"
                    >
                      <X size={14} />
                      Cancel
                    </button>
                  </div>
                  {/* Live Log */}
                  <div className="bg-black/40 p-3 max-h-[200px] overflow-y-auto font-mono text-xs">
                    {connectionLogs.map((log, i) => (
                      <div key={i} className="flex items-start gap-2 py-1 animate-in fade-in slide-in-from-left-2">
                        <span className="text-zinc-600 shrink-0">{log.time}</span>
                        <span className={`shrink-0 ${log.status === 'success' ? 'text-green-400' :
                          log.status === 'error' ? 'text-red-400' :
                            log.status === 'pending' ? 'text-yellow-400' :
                              'text-zinc-400'
                          }`}>
                          {log.status === 'success' ? '✓' :
                            log.status === 'error' ? '✗' :
                              log.status === 'pending' ? '○' : '→'}
                        </span>
                        <span className={`${log.status === 'success' ? 'text-green-300' :
                          log.status === 'error' ? 'text-red-300' :
                            log.status === 'pending' ? 'text-yellow-200' :
                              'text-zinc-300'
                          }`}>{log.message}</span>
                      </div>
                    ))}
                    {connectionLogs.length > 0 && (
                      <div className="flex items-center gap-2 py-1 text-cyan-400">
                        <span className="text-zinc-600">{new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                        <Loader2 size={10} className="animate-spin" />
                        <span className="animate-pulse">Processing...</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Context List */}
              <div className="bg-zinc-900/30 rounded-xl border border-white/5 overflow-hidden">
                <div className="max-h-[280px] overflow-y-auto custom-scrollbar p-2 space-y-1">
                  {filteredContexts.map(ctx => (
                    <div
                      key={ctx}
                      className={`w-full text-left px-4 py-3.5 rounded-xl text-sm transition-all border group flex items-center gap-2
                        ${connectMutation.isPending ? 'opacity-50' : 'hover:bg-white/5'}
                        ${ctx === currentContext ? 'bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border-cyan-500/30' : 'border-transparent hover:border-white/10'}
                      `}
                    >
                      <button
                        onClick={() => handleConnect(ctx)}
                        disabled={connectMutation.isPending}
                        className="flex-1 min-w-0 flex items-center justify-between relative z-10 cursor-pointer"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className={`w-2.5 h-2.5 rounded-full shrink-0 transition-all ${ctx === currentContext ? 'bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.6)]' : 'bg-zinc-600 group-hover:bg-zinc-400'}`} />
                          <span className={`font-medium truncate ${ctx === currentContext ? 'text-cyan-100' : 'text-zinc-300 group-hover:text-white'}`}>
                            {ctx}
                          </span>
                          {ctx === currentContext && (
                            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shrink-0">
                              Active
                            </span>
                          )}
                        </div>
                        {connectMutation.isPending && connectMutation.variables === ctx ? (
                          <Loader2 size={18} className="animate-spin text-cyan-400 shrink-0 ml-2" />
                        ) : (
                          <ChevronRight size={16} className={`shrink-0 ml-2 transition-[color,transform] duration-150 ${ctx === currentContext ? 'text-cyan-400' : 'text-zinc-600 group-hover:text-zinc-400 group-hover:translate-x-0.5'}`} />
                        )}
                      </button>
                      {/* Delete button - always visible in layout, opacity controlled by hover */}
                      <button
                        onClick={(e) => handleDeleteContext(ctx, e)}
                        disabled={ctx === currentContext || deleteMutation.isPending}
                        className={`shrink-0 p-1.5 rounded-lg transition-[color,background-color,opacity] opacity-0 group-hover:opacity-100
                          ${ctx === currentContext
                            ? 'text-zinc-600 cursor-not-allowed'
                            : 'text-zinc-500 hover:text-red-400 hover:bg-red-500/10'}`}
                        title={ctx === currentContext ? "Cannot delete active context" : "Delete context"}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}

                  {filteredContexts.length === 0 && (
                    <div className="py-12 flex flex-col items-center justify-center text-zinc-500 gap-3">
                      <ServerOff size={32} className="opacity-40" />
                      <div className="text-center">
                        <p className="text-sm font-medium">No contexts found</p>
                        <p className="text-xs text-zinc-600 mt-1">Try a different kubeconfig file</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Azure Tab Content */
            <div className="p-8">
              <div className="text-center">
                <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-blue-500/30 flex items-center justify-center">
                  <Cloud size={40} className="text-blue-400" />
                </div>
                <h3 className="text-xl font-semibold text-white mb-2">Connect to Azure AKS</h3>
                <p className="text-zinc-400 text-sm mb-6 max-w-sm mx-auto">
                  Browse and connect to your Azure Kubernetes Service clusters directly from your subscriptions
                </p>
                <button
                  onClick={onOpenAzure}
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-medium transition-all shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98]"
                >
                  <Globe size={18} />
                  Open Azure Explorer
                </button>

                <div className="mt-8 pt-6 border-t border-white/5">
                  <p className="text-xs text-zinc-600 mb-4">Features</p>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div className="p-3 rounded-lg bg-white/5">
                      <div className="text-blue-400 mb-1">
                        <Server size={20} className="mx-auto" />
                      </div>
                      <p className="text-xs text-zinc-400">Multi-subscription</p>
                    </div>
                    <div className="p-3 rounded-lg bg-white/5">
                      <div className="text-green-400 mb-1">
                        <Check size={20} className="mx-auto" />
                      </div>
                      <p className="text-xs text-zinc-400">Auto-credentials</p>
                    </div>
                    <div className="p-3 rounded-lg bg-white/5">
                      <div className="text-purple-400 mb-1">
                        <Layers size={20} className="mx-auto" />
                      </div>
                      <p className="text-xs text-zinc-400">Resource groups</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="px-6 py-3 bg-zinc-900/50 border-t border-white/5 flex items-center justify-between">
            <p className="text-[10px] text-zinc-600 font-mono">OpsPilot v1.0.0</p>
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Ready
            </div>
          </div>
        </div>
      </div>

      {/* Delete Context Confirmation Modal */}
      {contextToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl max-w-md w-full mx-4 animate-in zoom-in-95 duration-200">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/30">
                  <AlertCircle className="w-6 h-6 text-red-400" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-white">Delete Context</h3>
                  <p className="text-sm text-zinc-400">This action cannot be undone</p>
                </div>
              </div>

              <div className="bg-zinc-800/50 rounded-lg p-4 mb-4 border border-zinc-700">
                <p className="text-sm text-zinc-300 mb-2">Are you sure you want to delete this context?</p>
                <code className="text-sm font-mono text-cyan-400 bg-zinc-800 px-2 py-1 rounded break-all">
                  {contextToDelete}
                </code>
                <p className="text-xs text-zinc-500 mt-3">
                  This will remove the context from your kubeconfig file. If the cluster and user credentials are not used by other contexts, they will also be removed.
                </p>
              </div>

              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setContextToDelete(null)}
                  disabled={deleteMutation.isPending}
                  className="px-4 py-2 text-sm font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => deleteMutation.mutate(contextToDelete)}
                  disabled={deleteMutation.isPending}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {deleteMutation.isPending ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    <>
                      <Trash2 size={14} />
                      Delete Context
                    </>
                  )}
                </button>
              </div>

              {deleteMutation.isError && (
                <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                  <p className="text-sm text-red-400">
                    {deleteMutation.error instanceof Error ? deleteMutation.error.message : 'Failed to delete context'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CommandPalette({
  isOpen,
  onClose,
  navStructure,
  onNavigate
}: {
  isOpen: boolean,
  onClose: () => void,
  navStructure: NavGroup[] | undefined,
  onNavigate: (res: NavResource) => void
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Flatten navigation items for search
  const items = useMemo(() => {
    if (!navStructure) return [];
    return navStructure.flatMap(group =>
      group.items.map(item => ({
        ...item,
        category: group.title
      }))
    );
  }, [navStructure]);

  const filteredItems = useMemo(() => {
    if (!query) return items.slice(0, 10); // Show top 10 by default
    return items.filter((item: any) =>
      item.title.toLowerCase().includes(query.toLowerCase()) ||
      item.kind.toLowerCase().includes(query.toLowerCase())
    ).slice(0, 10);
  }, [items, query]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredItems]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, filteredItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredItems[selectedIndex]) {
        onNavigate(filteredItems[selectedIndex]);
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-gradient-to-br from-gray-900 to-black border border-gray-800 rounded-lg shadow-2xl shadow-purple-500/20 overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-100"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center px-4 py-3 border-b border-gray-800 gap-3">
          <Search size={18} className="text-gray-500" />
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent border-none outline-none text-white placeholder-gray-500 text-sm"
            placeholder="Type a command or search..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="flex gap-1">
            <span className="text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded border border-gray-700">ESC</span>
          </div>
        </div>

        <div className="max-h-[300px] overflow-y-auto py-2">
          {filteredItems.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-500 text-sm">No results found.</div>
          ) : (
            filteredItems.map((item: any, index: number) => (
              <button
                key={`${item.group}/${item.kind}`}
                className={`w-full text-left px-4 py-2 flex items-center justify-between text-sm transition-all ${index === selectedIndex ? "bg-cyan-600 text-white" : "text-gray-300 hover:bg-gray-800"
                  }`}
                onClick={() => {
                  onNavigate(item);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <div className="flex items-center gap-2">
                  {getCategoryIcon(item.category)}
                  <span>{item.title}</span>
                </div>
                <span className={`text-xs ${index === selectedIndex ? "text-white/70" : "text-gray-500"}`}>
                  {item.category}
                </span>
              </button >
            ))
          )}
        </div >

        <div className="px-4 py-2 bg-gray-900 border-t border-gray-800 text-[10px] text-gray-500 flex justify-between">
          <span>Navigate with <span className="font-mono">↑↓</span></span>
          <span>Select with <span className="font-mono">↵</span></span>
        </div>
      </div >
    </div >
  );
}

// --- Sidebar Group Component ---
const SidebarGroup = ({ title, icon: Icon, items, activeRes, onSelect, isOpen, onToggle }: any) => {
  if (items.length === 0) return null;

  const groupColors: Record<string, string> = {
    "Cluster": "text-blue-400 group-hover:text-blue-300",
    "Workloads": "text-purple-400 group-hover:text-purple-300",
    "Config": "text-yellow-400 group-hover:text-yellow-300",
    "Network": "text-green-400 group-hover:text-green-300",
    "Storage": "text-orange-400 group-hover:text-orange-300",
    "Access Control": "text-red-400 group-hover:text-red-300",
  };

  return (
    <div className="mb-1">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2.5 text-base font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded-md transition-all group"
      >
        <div className="flex items-center gap-2.5">
          <Icon size={18} className={groupColors[title] || "text-cyan-400 group-hover:text-cyan-300"} />
          <span>{title}</span>
        </div>
        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>

      {isOpen && (
        <div className="mt-1 ml-3 pl-3 border-l border-gray-700 space-y-0.5">
          {items.map((res: any) => (
            <button
              key={`${res.group}/${res.kind}`}
              onClick={() => onSelect(res)}
              className={`w-full text-left px-3 py-2 text-base rounded-md transition-all flex items-center gap-2.5 ${activeRes?.kind === res.kind
                ? "bg-gradient-to-r from-purple-600/80 to-blue-600/80 text-white font-medium shadow-lg shadow-purple-500/20"
                : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`}
            >
              {res.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// --- Sidebar Section Component (for nesting) ---
const SidebarSection = ({ title, icon: Icon, isOpen, onToggle, children }: any) => {
  return (
    <div className="mb-1">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2.5 text-base font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded-md transition-all group"
      >
        <div className="flex items-center gap-2.5">
          <Icon size={18} className="text-pink-400 group-hover:text-pink-300" />
          <span>{title}</span>
        </div>
        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>

      {isOpen && (
        <div className="mt-1 ml-3 pl-3 border-l border-gray-700 space-y-0.5">
          {children}
        </div>
      )}
    </div>
  );
}

// --- Resource Context Menu (Actions Dropdown) ---
function ResourceContextMenu({
  resource,
  onViewDetails,
  onDelete,
  isPod = false
}: {
  resource: K8sObject,
  onViewDetails: () => void,
  onDelete: () => void,
  isPod?: boolean
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    (window as any).showToast?.(`Copied ${label} to clipboard`, 'success');
    setIsOpen(false);
  };

  const menuItems = [
    { label: 'View Details', icon: <Eye size={14} />, action: () => { onViewDetails(); setIsOpen(false); } },
    { label: 'Copy Name', icon: <Copy size={14} />, action: () => copyToClipboard(resource.name, 'name') },
    { label: 'Copy Full Name', icon: <Copy size={14} />, action: () => copyToClipboard(`${resource.namespace}/${resource.name}`, 'full name') },
    ...(isPod ? [
      { label: 'Copy Pod IP', icon: <Copy size={14} />, action: () => copyToClipboard(resource.ip || '', 'Pod IP'), disabled: !resource.ip },
    ] : []),
    { divider: true },
    { label: 'Delete', icon: <Trash2 size={14} />, action: () => { onDelete(); setIsOpen(false); }, danger: true },
  ];

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen); }}
        className="p-1.5 rounded-md hover:bg-white/10 text-zinc-500 hover:text-zinc-300 transition-[color,background-color,opacity] opacity-0 group-hover:opacity-100"
        title="Actions"
      >
        <MoreVertical size={16} />
      </button>

      {isOpen && (
        <div
          className="absolute right-0 top-full mt-1 w-48 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-50 py-1 animate-in fade-in slide-in-from-top-2 duration-150"
          onClick={(e) => e.stopPropagation()}
        >
          {menuItems.map((item, idx) =>
            'divider' in item ? (
              <div key={idx} className="my-1 border-t border-zinc-700" />
            ) : (
              <button
                key={idx}
                onClick={item.action}
                disabled={'disabled' in item && item.disabled}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left transition-all
                  ${'danger' in item && item.danger
                    ? 'text-red-400 hover:bg-red-500/10 hover:text-red-300'
                    : 'text-zinc-300 hover:bg-white/5 hover:text-white'}
                  ${'disabled' in item && item.disabled ? 'opacity-40 cursor-not-allowed' : ''}
                `}
              >
                {item.icon}
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

// --- Delete Confirmation Modal ---
function DeleteConfirmationModal({ isOpen, onClose, onConfirm, resourceName }: { isOpen: boolean, onClose: () => void, onConfirm: () => void, resourceName: string }) {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setInputValue("");
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue === resourceName) {
      onConfirm();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md bg-gradient-to-br from-gray-900 to-black border border-red-500/30 rounded-lg shadow-2xl shadow-red-500/20 overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6 border-b border-gray-800">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-full bg-red-500/10">
              <AlertCircle className="text-red-400" size={24} />
            </div>
            <h2 className="text-xl font-bold text-white">Delete Resource</h2>
          </div>
          <p className="text-gray-400 text-sm">
            This action cannot be undone. Type <span className="font-mono text-red-400 font-semibold">{resourceName}</span> to confirm deletion.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-2">
              Resource name
            </label>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              className="w-full px-3 py-2 bg-black border border-gray-800 rounded-md text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:border-red-500"
              placeholder={resourceName}
              autoComplete="off"
            />
          </div>

          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white rounded-md transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={inputValue !== resourceName}
              className="px-4 py-2 bg-red-600 text-white rounded-md transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:bg-red-700 disabled:hover:bg-red-600"
            >
              Delete Resource
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Cluster Cockpit Dashboard - Airplane cockpit style view
function ClusterCockpit({ onNavigate: _onNavigate, currentContext }: { onNavigate: (res: NavResource) => void, navStructure?: NavGroup[], currentContext?: string }) {
  const qc = useQueryClient();
  const [connectingVcluster, setConnectingVcluster] = useState<string | null>(null);
  const [connectCancelled, setConnectCancelled] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<string>("");

  // Detect if we're inside a vcluster (context name starts with "vcluster_")
  const isInsideVcluster = currentContext?.startsWith('vcluster_') || false;

  const { data: cockpit, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["cluster_cockpit", currentContext],
    queryFn: async () => await invoke<ClusterCockpitData>("get_cluster_cockpit"),
    staleTime: 30000, // Increased to 30s to avoid refetch while initial_data is fresh
    refetchInterval: 60000, // Increased to 60s - cockpit data doesn't change that fast
  });

  // Fetch vclusters for this cluster - only on host clusters, not inside vclusters
  const { data: vclusters, isLoading: vclustersLoading } = useQuery({
    queryKey: ["vclusters", currentContext],
    queryFn: async () => {
      try {
        const vclusterResult = await invoke<string>("list_vclusters");
        if (!vclusterResult || vclusterResult === "null" || vclusterResult.trim() === "") {
          return [];
        }
        const vclusterList = JSON.parse(vclusterResult);
        if (!Array.isArray(vclusterList)) return [];
        return vclusterList.map((vc: any) => ({
          id: `vcluster-${vc.Name}-${vc.Namespace}`,
          name: vc.Name,
          namespace: vc.Namespace,
          status: vc.Status || 'Unknown',
          version: vc.Version || '',
          connected: vc.Connected || false,
        }));
      } catch {
        return [];
      }
    },
    staleTime: 1000 * 60 * 2, // 2 minutes - vclusters don't change often
    // Only fetch vclusters when on host cluster, not inside a vcluster
    enabled: !!currentContext && !isInsideVcluster,
  });

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'Ki', 'Mi', 'Gi', 'Ti'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const formatCpu = (milli: number) => {
    if (milli >= 1000) return `${(milli / 1000).toFixed(1)} cores`;
    return `${milli}m`;
  };

  // Colors for charts
  const COLORS = {
    running: '#22c55e',
    pending: '#eab308',
    succeeded: '#3b82f6',
    failed: '#ef4444',
    unknown: '#6b7280',
    cpu: '#06b6d4',
    memory: '#8b5cf6',
    healthy: '#22c55e',
    warning: '#f59e0b',
    critical: '#ef4444',
  };

  // Analog Speedometer Gauge - like a car speedometer
  const SpeedometerGauge = ({ value, max, label, color, unit, size = 160 }: { value: number, max: number, label: string, color: string, unit?: string, size?: number }) => {
    const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
    const startAngle = -225; // Start from bottom-left
    const endAngle = 45; // End at bottom-right
    const angleRange = endAngle - startAngle;
    const currentAngle = startAngle + (percentage / 100) * angleRange;

    const getColor = () => {
      if (percentage >= 90) return COLORS.critical;
      if (percentage >= 75) return COLORS.warning;
      return color;
    };

    // Create tick marks
    const ticks = [];
    for (let i = 0; i <= 10; i++) {
      const tickAngle = startAngle + (i / 10) * angleRange;
      const rad = (tickAngle * Math.PI) / 180;
      const outerR = size / 2 - 8;
      const innerR = i % 2 === 0 ? outerR - 12 : outerR - 6;
      const x1 = size / 2 + Math.cos(rad) * outerR;
      const y1 = size / 2 + Math.sin(rad) * outerR;
      const x2 = size / 2 + Math.cos(rad) * innerR;
      const y2 = size / 2 + Math.sin(rad) * innerR;
      ticks.push(
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={i >= 8 ? COLORS.critical : i >= 7 ? COLORS.warning : '#52525b'} strokeWidth={i % 2 === 0 ? 2 : 1} />
      );
      if (i % 2 === 0) {
        const labelR = innerR - 12;
        const lx = size / 2 + Math.cos(rad) * labelR;
        const ly = size / 2 + Math.sin(rad) * labelR;
        ticks.push(
          <text key={`label-${i}`} x={lx} y={ly} fill="#71717a" fontSize="9" textAnchor="middle" dominantBaseline="middle">
            {i * 10}
          </text>
        );
      }
    }

    // Needle
    const needleRad = (currentAngle * Math.PI) / 180;
    const needleLength = size / 2 - 30;
    const needleX = size / 2 + Math.cos(needleRad) * needleLength;
    const needleY = size / 2 + Math.sin(needleRad) * needleLength;

    return (
      <div className="flex flex-col items-center relative">
        <svg width={size} height={size * 0.7} viewBox={`0 0 ${size} ${size * 0.85}`}>
          {/* Background arc */}
          <path
            d={`M ${size / 2 + Math.cos((startAngle * Math.PI) / 180) * (size / 2 - 15)} ${size / 2 + Math.sin((startAngle * Math.PI) / 180) * (size / 2 - 15)}
               A ${size / 2 - 15} ${size / 2 - 15} 0 1 1 ${size / 2 + Math.cos((endAngle * Math.PI) / 180) * (size / 2 - 15)} ${size / 2 + Math.sin((endAngle * Math.PI) / 180) * (size / 2 - 15)}`}
            fill="none"
            stroke="#27272a"
            strokeWidth={6}
            strokeLinecap="round"
          />
          {/* Value arc */}
          <path
            d={`M ${size / 2 + Math.cos((startAngle * Math.PI) / 180) * (size / 2 - 15)} ${size / 2 + Math.sin((startAngle * Math.PI) / 180) * (size / 2 - 15)}
               A ${size / 2 - 15} ${size / 2 - 15} 0 ${percentage > 50 ? 1 : 0} 1 ${size / 2 + Math.cos((currentAngle * Math.PI) / 180) * (size / 2 - 15)} ${size / 2 + Math.sin((currentAngle * Math.PI) / 180) * (size / 2 - 15)}`}
            fill="none"
            stroke={getColor()}
            strokeWidth={6}
            strokeLinecap="round"
            className="transition-all duration-500"
            style={{ filter: `drop-shadow(0 0 6px ${getColor()})` }}
          />
          {/* Tick marks */}
          {ticks}
          {/* Needle */}
          <line
            x1={size / 2}
            y1={size / 2}
            x2={needleX}
            y2={needleY}
            stroke={getColor()}
            strokeWidth={3}
            strokeLinecap="round"
            className="transition-all duration-500"
            style={{ filter: `drop-shadow(0 0 4px ${getColor()})` }}
          />
          {/* Center dot */}
          <circle cx={size / 2} cy={size / 2} r={6} fill={getColor()} />
          <circle cx={size / 2} cy={size / 2} r={3} fill="#18181b" />
        </svg>
        <div className="text-center -mt-2">
          <div className="text-xl font-bold text-white">{percentage.toFixed(0)}%</div>
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</div>
          {unit && <div className="text-xs text-zinc-600">{unit}</div>}
        </div>
      </div>
    );
  };

  // Vertical Bar Meter - like an audio VU meter
  const VerticalMeter = ({ value, max, label, color, icon: Icon }: { value: number, max: number, label: string, color: string, icon?: React.ComponentType<{ size?: number, className?: string }> }) => {
    const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
    const getColor = () => {
      if (percentage >= 90) return COLORS.critical;
      if (percentage >= 75) return COLORS.warning;
      return color;
    };

    return (
      <div className="flex flex-col items-center gap-2">
        <div className="relative w-8 h-32 bg-zinc-900 rounded-full border border-zinc-800 overflow-hidden">
          {/* Scale markers */}
          {[0, 25, 50, 75, 100].map(mark => (
            <div key={mark} className="absolute left-0 right-0 h-px bg-zinc-700" style={{ bottom: `${mark}%` }} />
          ))}
          {/* Fill */}
          <div
            className="absolute bottom-0 left-0 right-0 transition-all duration-500 rounded-b-full"
            style={{
              height: `${percentage}%`,
              background: `linear-gradient(to top, ${getColor()}, ${getColor()}88)`,
              boxShadow: `0 0 20px ${getColor()}66`
            }}
          />
          {/* Glow effect at top */}
          <div
            className="absolute left-1 right-1 h-2 rounded-full transition-all duration-500"
            style={{
              bottom: `calc(${percentage}% - 4px)`,
              background: getColor(),
              boxShadow: `0 0 8px ${getColor()}`
            }}
          />
        </div>
        <div className="text-center">
          {Icon && <span style={{ color: getColor() }}><Icon size={16} className="mx-auto mb-1" /></span>}
          <div className="text-sm font-bold text-white">{percentage.toFixed(0)}%</div>
          <div className="text-[10px] text-zinc-500">{label}</div>
        </div>
      </div>
    );
  };

  // Horizontal Progress with gradient
  const GradientProgress = ({ value, max, label, sublabel }: { value: number, max: number, label: string, sublabel?: string }) => {
    const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
    const getGradient = () => {
      if (percentage >= 90) return 'from-red-600 to-red-400';
      if (percentage >= 75) return 'from-yellow-600 to-yellow-400';
      return 'from-cyan-600 to-cyan-400';
    };

    return (
      <div className="w-full">
        <div className="flex justify-between items-center mb-1">
          <span className="text-xs text-zinc-400">{label}</span>
          <span className="text-xs font-mono text-zinc-300">{percentage.toFixed(1)}%</span>
        </div>
        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full bg-gradient-to-r ${getGradient()} rounded-full transition-all duration-500`}
            style={{ width: `${percentage}%` }}
          />
        </div>
        {sublabel && <div className="text-[10px] text-zinc-600 mt-0.5">{sublabel}</div>}
      </div>
    );
  };

  // Simple ring gauge for compact display
  const Gauge = ({ value, max, label, color, size = 120, isHealthMetric = true }: { value: number, max: number, label: string, color: string, size?: number, isHealthMetric?: boolean }) => {
    const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
    const strokeWidth = 8;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (percentage / 100) * circumference;

    const getColor = () => {
      if (isHealthMetric) {
        // For health metrics: higher is better (green), lower is worse (red)
        if (percentage >= 90) return COLORS.healthy;
        if (percentage >= 70) return COLORS.warning;
        return COLORS.critical;
      } else {
        // For utilization metrics: higher is worse (red), lower is better (green)
        if (percentage >= 90) return COLORS.critical;
        if (percentage >= 75) return COLORS.warning;
        return color;
      }
    };

    return (
      <div className="flex flex-col items-center">
        <svg width={size} height={size} className="transform -rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#27272a"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={getColor()}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            className="transition-all duration-500"
            style={{ filter: `drop-shadow(0 0 4px ${getColor()})` }}
          />
        </svg>
        <div className="absolute flex flex-col items-center justify-center" style={{ width: size, height: size }}>
          <span className="text-2xl font-bold text-white">{percentage.toFixed(0)}%</span>
          <span className="text-xs text-zinc-400">{label}</span>
        </div>
      </div>
    );
  };

  // Status indicator
  const StatusIndicator = ({ status, count, label }: { status: 'healthy' | 'warning' | 'critical', count: number, label: string }) => (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${status === 'critical' ? 'bg-red-500/10 border-red-500/30' :
      status === 'warning' ? 'bg-yellow-500/10 border-yellow-500/30' :
        'bg-green-500/10 border-green-500/30'
      }`}>
      <div className={`w-2 h-2 rounded-full ${status === 'critical' ? 'bg-red-500 animate-pulse' :
        status === 'warning' ? 'bg-yellow-500' :
          'bg-green-500'
        }`} />
      <span className={`text-sm font-medium ${status === 'critical' ? 'text-red-400' :
        status === 'warning' ? 'text-yellow-400' :
          'text-green-400'
        }`}>{count}</span>
      <span className="text-xs text-zinc-500">{label}</span>
    </div>
  );

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-[#09090b]">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-12 h-12 text-cyan-400 animate-spin" />
          <span className="text-zinc-400">Loading cluster cockpit...</span>
        </div>
      </div>
    );
  }

  if (isError || !cockpit) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-[#09090b] p-8">
        <AlertCircle className="w-16 h-16 text-red-400 mb-4" />
        <h2 className="text-xl font-bold text-white mb-2">Failed to load cockpit</h2>
        <p className="text-zinc-400 mb-4">{String(error)}</p>
        <button onClick={() => refetch()} className="px-4 py-2 bg-cyan-500 hover:bg-cyan-600 rounded text-white">
          Retry
        </button>
      </div>
    );
  }

  // Prepare chart data
  const podStatusData = [
    { name: 'Running', value: cockpit.pod_status.running, color: COLORS.running },
    { name: 'Pending', value: cockpit.pod_status.pending, color: COLORS.pending },
    { name: 'Succeeded', value: cockpit.pod_status.succeeded, color: COLORS.succeeded },
    { name: 'Failed', value: cockpit.pod_status.failed, color: COLORS.failed },
    { name: 'Unknown', value: cockpit.pod_status.unknown, color: COLORS.unknown },
  ].filter(d => d.value > 0);

  const nodeBarData = cockpit.nodes.slice(0, 8).map(node => ({
    name: node.name.length > 20 ? node.name.slice(-20) : node.name,
    cpu: node.cpu_capacity > 0 ? Math.round((node.cpu_usage / node.cpu_capacity) * 100) : 0,
    memory: node.memory_capacity > 0 ? Math.round((node.memory_usage / node.memory_capacity) * 100) : 0,
  }));

  const namespaceData = cockpit.top_namespaces.slice(0, 8).map(ns => ({
    name: ns.name.length > 15 ? ns.name.slice(0, 15) + '...' : ns.name,
    pods: ns.pod_count,
  }));

  return (
    <div className="h-full overflow-y-auto bg-[#09090b] p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Activity className="w-7 h-7 text-cyan-400" />
            Cluster Cockpit
          </h1>
          <p className="text-zinc-500 mt-1">
            Real-time cluster health and resource monitoring
            {!cockpit.metrics_available && (
              <span className="ml-2 text-yellow-500 text-xs">
                (Resource usage estimated from pod requests - metrics-server not available)
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {!cockpit.metrics_available && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-yellow-500/10 border border-yellow-500/30">
              <AlertCircle size={14} className="text-yellow-500" />
              <span className="text-xs text-yellow-400">Estimated</span>
            </div>
          )}
          <StatusIndicator status={cockpit.critical_count > 0 ? 'critical' : 'healthy'} count={cockpit.critical_count} label="Critical" />
          <StatusIndicator status={cockpit.warning_count > 0 ? 'warning' : 'healthy'} count={cockpit.warning_count} label="Warnings" />
          <button onClick={() => refetch()} className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors">
            <RefreshCw size={18} />
          </button>
        </div>
      </div>

      {/* Main Speedometer Gauges Row */}
      <div className="grid grid-cols-2 gap-6 mb-6">
        {/* CPU Speedometer */}
        <div className="bg-gradient-to-br from-zinc-900 via-zinc-900/50 to-zinc-950 rounded-xl p-6 border border-zinc-800">
          <div className="flex items-center gap-2 mb-4">
            <Cpu className="w-5 h-5 text-cyan-400" />
            <div>
              <h3 className="text-sm font-semibold text-white">CPU Utilization</h3>
              <p className="text-[10px] text-zinc-500">Total CPU usage across all nodes vs allocatable capacity</p>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <SpeedometerGauge
              value={cockpit.total_cpu_usage}
              max={cockpit.total_cpu_allocatable}
              label="CPU UTILIZATION"
              color={COLORS.cpu}
              unit={formatCpu(cockpit.total_cpu_usage)}
              size={180}
            />
            <div className="flex-1 space-y-3">
              <GradientProgress value={cockpit.total_cpu_usage} max={cockpit.total_cpu_allocatable} label="Used by workloads" sublabel={`${formatCpu(cockpit.total_cpu_usage)} of ${formatCpu(cockpit.total_cpu_allocatable)} allocatable`} />
              <GradientProgress value={cockpit.total_cpu_capacity - cockpit.total_cpu_allocatable} max={cockpit.total_cpu_capacity} label="Reserved by system" sublabel={`${formatCpu(cockpit.total_cpu_capacity - cockpit.total_cpu_allocatable)} for kubelet, OS`} />
              <div className="pt-2 border-t border-zinc-800 grid grid-cols-2 gap-4 text-xs">
                <div>
                  <span className="text-zinc-500">Allocatable</span>
                  <div className="text-cyan-400 font-mono font-semibold">{formatCpu(cockpit.total_cpu_allocatable)}</div>
                  <span className="text-[9px] text-zinc-600">for pods</span>
                </div>
                <div>
                  <span className="text-zinc-500">Available</span>
                  <div className="text-green-400 font-mono font-semibold">{formatCpu(Math.max(0, cockpit.total_cpu_allocatable - cockpit.total_cpu_usage))}</div>
                  <span className="text-[9px] text-zinc-600">free capacity</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Memory Speedometer */}
        <div className="bg-gradient-to-br from-zinc-900 via-zinc-900/50 to-zinc-950 rounded-xl p-6 border border-zinc-800">
          <div className="flex items-center gap-2 mb-4">
            <HardDrive className="w-5 h-5 text-purple-400" />
            <div>
              <h3 className="text-sm font-semibold text-white">Memory Utilization</h3>
              <p className="text-[10px] text-zinc-500">Total RAM usage across all nodes vs allocatable capacity</p>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <SpeedometerGauge
              value={cockpit.total_memory_usage}
              max={cockpit.total_memory_allocatable}
              label="MEMORY UTILIZATION"
              color={COLORS.memory}
              unit={formatBytes(cockpit.total_memory_usage)}
              size={180}
            />
            <div className="flex-1 space-y-3">
              <GradientProgress value={cockpit.total_memory_usage} max={cockpit.total_memory_allocatable} label="Used by workloads" sublabel={`${formatBytes(cockpit.total_memory_usage)} of ${formatBytes(cockpit.total_memory_allocatable)} allocatable`} />
              <GradientProgress value={cockpit.total_memory_capacity - cockpit.total_memory_allocatable} max={cockpit.total_memory_capacity} label="Reserved by system" sublabel={`${formatBytes(cockpit.total_memory_capacity - cockpit.total_memory_allocatable)} for kubelet, OS`} />
              <div className="pt-2 border-t border-zinc-800 grid grid-cols-2 gap-4 text-xs">
                <div>
                  <span className="text-zinc-500">Allocatable</span>
                  <div className="text-purple-400 font-mono font-semibold">{formatBytes(cockpit.total_memory_allocatable)}</div>
                  <span className="text-[9px] text-zinc-600">for pods</span>
                </div>
                <div>
                  <span className="text-zinc-500">Available</span>
                  <div className="text-green-400 font-mono font-semibold">{formatBytes(Math.max(0, cockpit.total_memory_allocatable - cockpit.total_memory_usage))}</div>
                  <span className="text-[9px] text-zinc-600">free capacity</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Vertical Meters Row */}
      <div className="bg-gradient-to-r from-zinc-900/80 to-zinc-950/80 rounded-xl p-6 border border-zinc-800 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-yellow-400" />
            <div>
              <h3 className="text-sm font-semibold text-zinc-300">Cluster Capacity Overview</h3>
              <p className="text-[10px] text-zinc-500">Quick view of resource utilization and health status</p>
            </div>
          </div>
          <div className="flex items-center gap-4 text-[10px] text-zinc-500">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500"></span> Healthy (0-74%)</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500"></span> Warning (75-89%)</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500"></span> Critical (90%+)</span>
          </div>
        </div>
        <div className="flex justify-around items-end">
          {/* Resource Utilization Meters */}
          <div className="flex flex-col items-center">
            <VerticalMeter value={cockpit.total_cpu_usage} max={cockpit.total_cpu_allocatable} label="CPU" color={COLORS.cpu} icon={Cpu} />
            <span className="text-[9px] text-zinc-600 mt-1">processor usage</span>
          </div>
          <div className="flex flex-col items-center">
            <VerticalMeter value={cockpit.total_memory_usage} max={cockpit.total_memory_allocatable} label="Memory" color={COLORS.memory} icon={HardDrive} />
            <span className="text-[9px] text-zinc-600 mt-1">RAM usage</span>
          </div>
          <div className="flex flex-col items-center">
            <VerticalMeter value={cockpit.total_pods} max={cockpit.total_pods_capacity} label="Pods" color={COLORS.running} icon={Layers} />
            <span className="text-[9px] text-zinc-600 mt-1">pod slots used</span>
          </div>
          <div className="flex flex-col items-center">
            <VerticalMeter value={cockpit.total_nodes - cockpit.healthy_nodes} max={cockpit.total_nodes} label="Unhealthy" color={COLORS.critical} icon={AlertCircle} />
            <span className="text-[9px] text-zinc-600 mt-1">nodes with issues</span>
          </div>

          {/* Divider */}
          <div className="w-px h-32 bg-zinc-700 mx-2"></div>

          {/* Ring gauges for health metrics */}
          <div className="flex flex-col items-center gap-2">
            <div className="relative">
              <Gauge value={cockpit.healthy_nodes} max={cockpit.total_nodes} label="Nodes" color={COLORS.healthy} size={100} />
            </div>
            <div className="text-[10px] text-zinc-500">{cockpit.healthy_nodes}/{cockpit.total_nodes} healthy</div>
            <span className="text-[9px] text-zinc-600">Ready status</span>
          </div>

          <div className="flex flex-col items-center gap-2">
            <div className="relative">
              <Gauge value={cockpit.pod_status.running} max={cockpit.total_pods} label="Running" color={COLORS.running} size={100} />
            </div>
            <div className="text-[10px] text-zinc-500">{cockpit.pod_status.running}/{cockpit.total_pods} running</div>
            <span className="text-[9px] text-zinc-600">Active pods</span>
          </div>

          <div className="flex flex-col items-center gap-2">
            <div className="relative">
              <Gauge value={cockpit.total_deployments - (cockpit.warning_count || 0)} max={cockpit.total_deployments} label="Healthy" color={COLORS.healthy} size={100} />
            </div>
            <div className="text-[10px] text-zinc-500">{cockpit.total_deployments} deployments</div>
            <span className="text-[9px] text-zinc-600">Fully available</span>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-zinc-300">Resource Counts</h3>
          <span className="text-[10px] text-zinc-500">Total resources in the cluster</span>
        </div>
        <div className="grid grid-cols-5 gap-4">
          {[
            { label: 'Nodes', value: cockpit.total_nodes, icon: Server, color: 'text-blue-400', desc: 'Worker machines' },
            { label: 'Pods', value: cockpit.total_pods, icon: Layers, color: 'text-green-400', desc: 'Running containers' },
            { label: 'Deployments', value: cockpit.total_deployments, icon: Package, color: 'text-purple-400', desc: 'App workloads' },
            { label: 'Services', value: cockpit.total_services, icon: Network, color: 'text-orange-400', desc: 'Network endpoints' },
            { label: 'Namespaces', value: cockpit.total_namespaces, icon: FolderOpen, color: 'text-yellow-400', desc: 'Logical partitions' },
          ].map((stat, i) => (
            <div key={i} className="bg-zinc-900/50 rounded-lg p-4 border border-zinc-800 hover:border-zinc-700 transition-colors">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs text-zinc-500 uppercase tracking-wider">{stat.label}</div>
                  <div className={`text-2xl font-bold ${stat.color} mt-1`}>{stat.value}</div>
                  <div className="text-[9px] text-zinc-600 mt-0.5">{stat.desc}</div>
                </div>
                <stat.icon className={`w-8 h-8 ${stat.color} opacity-50`} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-3 gap-6 mb-6">
        {/* Pod Status Pie Chart */}
        <div className="bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
              <PieChart className="w-4 h-4 text-cyan-400" />
              Pod Status Distribution
            </h3>
            <p className="text-[10px] text-zinc-500 mt-1">Breakdown of pod lifecycle states</p>
          </div>
          <div className="h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <RechartsPieChart>
                <Pie
                  data={podStatusData}
                  cx="50%"
                  cy="50%"
                  innerRadius={45}
                  outerRadius={70}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {podStatusData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                  labelStyle={{ color: '#fff' }}
                  formatter={(value: number, name: string) => [`${value} pods`, name]}
                />
                <Legend
                  verticalAlign="bottom"
                  height={36}
                  formatter={(value) => <span className="text-xs text-zinc-400">{value}</span>}
                />
              </RechartsPieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 pt-2 border-t border-zinc-800 text-[9px] text-zinc-600 grid grid-cols-2 gap-1">
            <span><span className="text-green-400">Running</span> = actively executing</span>
            <span><span className="text-yellow-400">Pending</span> = waiting to start</span>
            <span><span className="text-blue-400">Succeeded</span> = completed ok</span>
            <span><span className="text-red-400">Failed</span> = exited with error</span>
          </div>
        </div>

        {/* Node Resource Usage Bar Chart */}
        <div className="bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
              <Server className="w-4 h-4 text-cyan-400" />
              Node Resource Usage
            </h3>
            <p className="text-[10px] text-zinc-500 mt-1">CPU and memory utilization per node</p>
          </div>
          <div className="h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={nodeBarData} layout="vertical">
                <XAxis type="number" domain={[0, 100]} tick={{ fill: '#71717a', fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
                <YAxis type="category" dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} width={80} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                  labelStyle={{ color: '#fff' }}
                  formatter={(value: number, name: string) => [`${value}%`, name]}
                />
                <Legend formatter={(value) => <span className="text-xs text-zinc-400">{value}</span>} />
                <Bar dataKey="cpu" fill={COLORS.cpu} name="CPU %" radius={[0, 4, 4, 0]} />
                <Bar dataKey="memory" fill={COLORS.memory} name="Memory %" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 pt-2 border-t border-zinc-800 flex items-center justify-between text-[9px] text-zinc-600">
            <span><span className="inline-block w-2 h-2 rounded-full bg-cyan-500 mr-1"></span>CPU: processor cores</span>
            <span><span className="inline-block w-2 h-2 rounded-full bg-purple-500 mr-1"></span>Memory: RAM usage</span>
          </div>
        </div>

        {/* Top Namespaces */}
        <div className="bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-cyan-400" />
              Top Namespaces
            </h3>
            <p className="text-[10px] text-zinc-500 mt-1">Namespaces with most pods deployed</p>
          </div>
          <div className="h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={namespaceData}>
                <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} angle={-45} textAnchor="end" height={60} />
                <YAxis tick={{ fill: '#71717a', fontSize: 10 }} label={{ value: 'Pods', angle: -90, position: 'insideLeft', fill: '#52525b', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#18181b', border: '1px solid #27272a', borderRadius: '8px' }}
                  labelStyle={{ color: '#fff' }}
                  formatter={(value: number) => [`${value} pods`, 'Pod count']}
                />
                <Bar dataKey="pods" fill={COLORS.running} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 pt-2 border-t border-zinc-800 text-[9px] text-zinc-600">
            Namespaces group related workloads and isolate resources
          </div>
        </div>
      </div>

      {/* Bottom Row - Nodes Table and Unhealthy Deployments */}
      <div className="grid grid-cols-2 gap-6">
        {/* Nodes Health Table */}
        <div className="bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
              <Server className="w-4 h-4 text-cyan-400" />
              Nodes Health ({cockpit.nodes.length})
            </h3>
            <p className="text-[10px] text-zinc-500 mt-1">Individual node status and resource consumption</p>
          </div>
          <div className="overflow-auto max-h-[280px]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-zinc-900">
                <tr className="text-zinc-500 uppercase">
                  <th className="text-left py-2 px-2" title="Node hostname">Node</th>
                  <th className="text-center py-2 px-2" title="Ready = accepting pods">Status</th>
                  <th className="text-right py-2 px-2" title="CPU utilization percentage">CPU %</th>
                  <th className="text-right py-2 px-2" title="Memory utilization percentage">Mem %</th>
                  <th className="text-right py-2 px-2" title="Running/Capacity pods">Pods</th>
                </tr>
              </thead>
              <tbody>
                {cockpit.nodes.map((node, i) => {
                  const cpuPct = node.cpu_capacity > 0 ? (node.cpu_usage / node.cpu_capacity) * 100 : 0;
                  const memPct = node.memory_capacity > 0 ? (node.memory_usage / node.memory_capacity) * 100 : 0;
                  return (
                    <tr key={i} className="border-t border-zinc-800 hover:bg-zinc-800/50">
                      <td className="py-2 px-2 font-mono text-zinc-300 truncate max-w-[150px]" title={node.name}>
                        {node.name.length > 25 ? '...' + node.name.slice(-22) : node.name}
                      </td>
                      <td className="py-2 px-2 text-center">
                        <span className={`px-2 py-0.5 rounded text-[10px] ${node.status === 'Ready' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                          }`}>{node.status}</span>
                      </td>
                      <td className="py-2 px-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-16 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${cpuPct > 90 ? 'bg-red-500' : cpuPct > 75 ? 'bg-yellow-500' : 'bg-cyan-500'}`} style={{ width: `${cpuPct}%` }} />
                          </div>
                          <span className="text-zinc-400 w-10 text-right">{cpuPct.toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="py-2 px-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-16 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${memPct > 90 ? 'bg-red-500' : memPct > 75 ? 'bg-yellow-500' : 'bg-purple-500'}`} style={{ width: `${memPct}%` }} />
                          </div>
                          <span className="text-zinc-400 w-10 text-right">{memPct.toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="py-2 px-2 text-right text-zinc-400">
                        {node.pods_running}/{node.pods_capacity}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Unhealthy Deployments */}
        <div className="bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-yellow-400" />
              Unhealthy Deployments ({cockpit.unhealthy_deployments.length})
            </h3>
            <p className="text-[10px] text-zinc-500 mt-1">Deployments with missing or unavailable replicas</p>
          </div>
          {cockpit.unhealthy_deployments.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-[240px] text-zinc-500">
              <Check className="w-12 h-12 text-green-400 mb-2" />
              <span className="text-sm">All deployments healthy</span>
              <span className="text-[10px] text-zinc-600 mt-1">No replica mismatches detected</span>
            </div>
          ) : (
            <div className="overflow-auto max-h-[280px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-zinc-900">
                  <tr className="text-zinc-500 uppercase">
                    <th className="text-left py-2 px-2" title="Deployment name">Deployment</th>
                    <th className="text-left py-2 px-2" title="Kubernetes namespace">Namespace</th>
                    <th className="text-center py-2 px-2" title="Ready/Desired pods">Ready</th>
                    <th className="text-center py-2 px-2" title="Available/Desired pods">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {cockpit.unhealthy_deployments.map((dep, i) => (
                    <tr key={i} className="border-t border-zinc-800 hover:bg-zinc-800/50">
                      <td className="py-2 px-2 font-mono text-zinc-300 truncate max-w-[150px]" title={dep.name}>{dep.name}</td>
                      <td className="py-2 px-2 text-zinc-500 truncate max-w-[100px]">{dep.namespace}</td>
                      <td className="py-2 px-2 text-center">
                        <span className={`${dep.ready < dep.desired ? 'text-yellow-400' : 'text-green-400'}`}>
                          {dep.ready}/{dep.desired}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-center">
                        <span className={`${dep.available < dep.desired ? 'text-red-400' : 'text-green-400'}`}>
                          {dep.available}/{dep.desired}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Virtual Clusters Section - only show on host clusters, not inside vclusters */}
      {!isInsideVcluster && vclusters && vclusters.length > 0 && (
        <div className="mt-6 bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
              <Box className="w-4 h-4 text-purple-400" />
              Virtual Clusters ({vclusters.length})
            </h3>
            <p className="text-[10px] text-zinc-500 mt-1">Lightweight isolated Kubernetes clusters running in this host cluster</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {vclusters.map((vc: any) => (
              <div
                key={vc.id}
                className="bg-zinc-800/50 rounded-lg p-4 border border-zinc-700 hover:border-purple-500/50 transition-all group"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Box className="w-5 h-5 text-purple-400" />
                    <div>
                      <div className="font-medium text-white text-sm">{vc.name}</div>
                      <div className="text-xs text-zinc-500">{vc.namespace}</div>
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded ${vc.status === 'Running' ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
                    {vc.status}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-zinc-500 mb-3">
                  <span>v{vc.version}</span>
                  {vc.connected && <span className="text-cyan-400">Connected</span>}
                </div>
                {connectingVcluster === vc.id ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 px-3 py-2.5 rounded-md bg-purple-900/50 border border-purple-500/30">
                      <Loader2 size={14} className="animate-spin text-purple-400" />
                      <span className="text-xs text-purple-200 flex-1">{connectionStatus || "Initializing..."}</span>
                    </div>
                    <button
                      onClick={() => {
                        setConnectCancelled(true);
                        setConnectingVcluster(null);
                        setConnectionStatus("");
                        if ((window as any).showToast) {
                          (window as any).showToast('Connection cancelled', 'info');
                        }
                      }}
                      className="w-full px-3 py-1.5 rounded-md bg-zinc-700/50 hover:bg-zinc-600/50 text-zinc-300 text-xs font-medium transition-all flex items-center justify-center gap-1.5"
                    >
                      <X size={12} />
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={async () => {
                      const vcId = vc.id;
                      setConnectingVcluster(vcId);
                      setConnectCancelled(false);
                      setConnectionStatus("Starting vcluster proxy...");
                      try {
                        // Simulate progress updates
                        const statusUpdates = [
                          { delay: 500, msg: "Starting vcluster proxy..." },
                          { delay: 2000, msg: "Waiting for proxy to initialize..." },
                          { delay: 4000, msg: "Configuring kubeconfig..." },
                          { delay: 6000, msg: "Verifying API connection..." },
                          { delay: 10000, msg: "Establishing secure tunnel..." },
                        ];

                        const timeoutIds: ReturnType<typeof setTimeout>[] = [];
                        statusUpdates.forEach(({ delay, msg }) => {
                          const id = setTimeout(() => {
                            if (!connectCancelled) setConnectionStatus(msg);
                          }, delay);
                          timeoutIds.push(id);
                        });

                        await invoke("connect_vcluster", { name: vc.name, namespace: vc.namespace });

                        // Clear timeouts
                        timeoutIds.forEach(id => clearTimeout(id));

                        // Check if cancelled while waiting
                        if (connectCancelled) {
                          return;
                        }
                        setConnectionStatus("Connected! Loading cluster...");
                        if ((window as any).showToast) {
                          (window as any).showToast(`Connected to vcluster '${vc.name}'`, 'success');
                        }
                        // Clear all cached data from host cluster before switching context
                        qc.removeQueries({ predicate: (query) => query.queryKey[0] !== "current_context" });
                        // Now invalidate current_context to trigger refetch with new vcluster context
                        qc.invalidateQueries({ queryKey: ["current_context"] });
                      } catch (err) {
                        if (!connectCancelled) {
                          console.error('vcluster connect error:', err);
                          setConnectionStatus("");
                          if ((window as any).showToast) {
                            (window as any).showToast(`Failed to connect: ${err}`, 'error');
                          }
                        }
                      } finally {
                        setConnectingVcluster(null);
                        setConnectionStatus("");
                      }
                    }}
                    disabled={connectingVcluster !== null}
                    className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-white text-xs font-medium transition-all ${connectingVcluster !== null
                      ? 'bg-purple-800/50 cursor-not-allowed'
                      : 'bg-purple-600/80 hover:bg-purple-500'
                      }`}
                  >
                    <Plug size={14} />
                    Connect
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {!isInsideVcluster && vclustersLoading && (
        <div className="mt-6 bg-zinc-900/50 rounded-xl p-4 border border-zinc-800">
          <div className="flex items-center gap-2 text-zinc-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Detecting virtual clusters...</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Ollama Setup Instructions Component
interface InstallStep {
  label: string;
  command?: string;
  link?: string;
}

interface PlatformConfig {
  name: string;
  icon: string;
  installSteps: InstallStep[];
  startCommand: string;
  pullCommand: string;
}

function OllamaSetupInstructions({ status, onRetry }: { status: OllamaStatus | null, onRetry: () => void }) {
  const [selectedPlatform, setSelectedPlatform] = useState<'macos' | 'windows' | 'linux'>('macos');
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCommand(id);
    setTimeout(() => setCopiedCommand(null), 2000);
  };

  const platforms: Record<'macos' | 'windows' | 'linux', PlatformConfig> = {
    macos: {
      name: 'macOS',
      icon: '🍎',
      installSteps: [
        { label: 'Install via Homebrew', command: 'brew install ollama' },
        { label: 'Or download from', link: 'https://ollama.com/download/mac' },
      ],
      startCommand: 'ollama serve',
      pullCommand: 'ollama pull llama3.1:8b',
    },
    windows: {
      name: 'Windows',
      icon: '🪟',
      installSteps: [
        { label: 'Download installer from', link: 'https://ollama.com/download/windows' },
        { label: 'Or via winget', command: 'winget install Ollama.Ollama' },
      ],
      startCommand: 'ollama serve',
      pullCommand: 'ollama pull llama3.1:8b',
    },
    linux: {
      name: 'Linux',
      icon: '🐧',
      installSteps: [
        { label: 'Install script', command: 'curl -fsSL https://ollama.com/install.sh | sh' },
      ],
      startCommand: 'ollama serve',
      pullCommand: 'ollama pull llama3.1:8b',
    },
  };

  const platform = platforms[selectedPlatform];

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="text-center">
        <div className="w-16 h-16 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-orange-500/20 to-red-500/20 flex items-center justify-center border border-orange-500/30">
          <Sparkles size={32} className="text-orange-400" />
        </div>
        <h3 className="text-lg font-semibold text-white mb-1">AI Setup Required</h3>
        <p className="text-sm text-zinc-400">
          OpsPilot uses Ollama for local AI. Let's get you set up!
        </p>
      </div>

      {/* Status Indicators */}
      <div className="bg-zinc-800/50 rounded-lg p-3 space-y-2">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${status?.ollama_running ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-sm text-zinc-300">Ollama Service</span>
          <span className={`text-xs ml-auto ${status?.ollama_running ? 'text-green-400' : 'text-red-400'}`}>
            {status?.ollama_running ? 'Running' : 'Not Running'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${status?.model_available ? 'bg-green-500' : 'bg-yellow-500'}`} />
          <span className="text-sm text-zinc-300">llama3.1:8b Model</span>
          <span className={`text-xs ml-auto ${status?.model_available ? 'text-green-400' : 'text-yellow-400'}`}>
            {status?.model_available ? 'Available' : 'Not Installed'}
          </span>
        </div>
        {status?.available_models && status.available_models.length > 0 && (
          <div className="text-xs text-zinc-500 pt-1 border-t border-zinc-700">
            Installed models: {status.available_models.join(', ')}
          </div>
        )}
      </div>

      {/* Platform Selector */}
      <div className="flex gap-2">
        {(Object.keys(platforms) as Array<'macos' | 'windows' | 'linux'>).map(p => (
          <button
            key={p}
            onClick={() => setSelectedPlatform(p)}
            className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all ${selectedPlatform === p
              ? 'bg-purple-500/20 border border-purple-500/50 text-purple-300'
              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400 border border-transparent'
              }`}
          >
            <span className="mr-1">{platforms[p].icon}</span>
            {platforms[p].name}
          </button>
        ))}
      </div>

      {/* Installation Steps */}
      <div className="space-y-3">
        {/* Step 1: Install Ollama */}
        {!status?.ollama_running && (
          <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-400 text-xs flex items-center justify-center font-bold">1</span>
              <span className="text-sm font-medium text-white">Install Ollama</span>
            </div>
            {platform.installSteps.map((step, i) => (
              <div key={i} className="ml-7 mb-2 last:mb-0">
                {step.command ? (
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-black/40 px-2 py-1.5 rounded text-cyan-300 font-mono">{step.command}</code>
                    <button
                      onClick={() => copyToClipboard(step.command!, `install-${i}`)}
                      className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors"
                    >
                      {copiedCommand === `install-${i}` ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                    </button>
                  </div>
                ) : (
                  <a
                    href={step.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1"
                  >
                    {step.label} <ExternalLink size={12} />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Step 2: Start Ollama */}
        {!status?.ollama_running && (
          <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-400 text-xs flex items-center justify-center font-bold">2</span>
              <span className="text-sm font-medium text-white">Start Ollama</span>
            </div>
            <div className="ml-7 flex items-center gap-2">
              <code className="flex-1 text-xs bg-black/40 px-2 py-1.5 rounded text-cyan-300 font-mono">{platform.startCommand}</code>
              <button
                onClick={() => copyToClipboard(platform.startCommand, 'start')}
                className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors"
              >
                {copiedCommand === 'start' ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
              </button>
            </div>
            <p className="ml-7 mt-1 text-xs text-zinc-500">
              Or launch the Ollama app (it runs in the background)
            </p>
          </div>
        )}

        {/* Step 3: Pull Model */}
        {status?.ollama_running && !status?.model_available && (
          <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-5 h-5 rounded-full bg-green-500/20 text-green-400 text-xs flex items-center justify-center font-bold">✓</span>
              <span className="text-sm font-medium text-white">Ollama is running!</span>
            </div>
            <div className="flex items-center gap-2 mb-2 mt-3">
              <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-400 text-xs flex items-center justify-center font-bold">2</span>
              <span className="text-sm font-medium text-white">Pull the AI model</span>
            </div>
            <div className="ml-7 flex items-center gap-2">
              <code className="flex-1 text-xs bg-black/40 px-2 py-1.5 rounded text-cyan-300 font-mono">{platform.pullCommand}</code>
              <button
                onClick={() => copyToClipboard(platform.pullCommand, 'pull')}
                className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors"
              >
                {copiedCommand === 'pull' ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
              </button>
            </div>
            <p className="ml-7 mt-1 text-xs text-zinc-500">
              This downloads ~4.7GB model (one-time setup)
            </p>
          </div>
        )}
      </div>

      {/* Retry Button */}
      <button
        onClick={onRetry}
        className="w-full py-2.5 px-4 rounded-lg bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-500 hover:to-purple-400 text-white font-medium text-sm transition-all flex items-center justify-center gap-2"
      >
        <RefreshCw size={16} />
        Check Again
      </button>

      {/* Help Link */}
      <p className="text-center text-xs text-zinc-500">
        Need help? Visit{' '}
        <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300">
          ollama.com
        </a>
      </p>
    </div>
  );
}

// LLM Settings Component - Industry-standard configuration
function LLMSettingsPanel({
  config,
  onConfigChange,
  onClose
}: {
  config: LLMConfig;
  onConfigChange: (config: LLMConfig) => void;
  onClose: () => void;
}) {
  const [localConfig, setLocalConfig] = useState<LLMConfig>(config);
  const [status, setStatus] = useState<LLMStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  const providerInfo: Record<LLMProvider, { name: string; description: string; icon: string; requiresApiKey: boolean; defaultModel: string }> = {
    ollama: {
      name: 'Ollama',
      description: 'Free, local AI. Runs on your machine.',
      icon: '🦙',
      requiresApiKey: false,
      defaultModel: 'llama3.1:8b',
    },
    openai: {
      name: 'OpenAI',
      description: 'GPT-4o and more. Requires API key.',
      icon: '🤖',
      requiresApiKey: true,
      defaultModel: 'gpt-4o',
    },
    anthropic: {
      name: 'Anthropic',
      description: 'Claude models. Requires API key.',
      icon: '🧠',
      requiresApiKey: true,
      defaultModel: 'claude-sonnet-4-20250514',
    },
    custom: {
      name: 'Custom',
      description: 'OpenAI-compatible endpoint (vLLM, etc.)',
      icon: '⚙️',
      requiresApiKey: false,
      defaultModel: 'default',
    },
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCommand(id);
    setTimeout(() => setCopiedCommand(null), 2000);
  };

  const checkConnection = async () => {
    setChecking(true);
    setStatus(null);
    try {
      const result = await invoke<LLMStatus>("check_llm_status", { config: localConfig });
      setStatus(result);
    } catch (err) {
      setStatus({
        connected: false,
        provider: localConfig.provider,
        model: localConfig.model,
        available_models: [],
        error: String(err),
      });
    }
    setChecking(false);
  };

  const handleProviderChange = (provider: LLMProvider) => {
    const defaultConfig = DEFAULT_LLM_CONFIGS[provider];
    setLocalConfig({ ...defaultConfig, api_key: provider === localConfig.provider ? localConfig.api_key : null });
    setStatus(null);
  };

  const handleSave = () => {
    // Use default model if model field is empty
    const configToSave = {
      ...localConfig,
      model: localConfig.model.trim() || currentProviderInfo.defaultModel,
    };
    onConfigChange(configToSave);
    // Save to localStorage
    localStorage.setItem('opspilot-llm-config', JSON.stringify(configToSave));
    onClose();
  };

  useEffect(() => {
    // Auto-check on mount
    checkConnection();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const currentProviderInfo = providerInfo[localConfig.provider];

  return (
    <div className="p-5 space-y-5 max-h-full overflow-y-auto">
      {/* Decorative background */}
      <div className="absolute top-0 left-0 right-0 h-40 bg-gradient-to-b from-violet-500/10 via-fuchsia-500/5 to-transparent pointer-events-none" />
      <div className="absolute -top-20 -right-20 w-40 h-40 bg-purple-500/20 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="relative flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-fuchsia-500 rounded-xl blur-sm opacity-60" />
            <div className="relative w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
              <Settings size={20} className="text-white" />
            </div>
          </div>
          <div>
            <h3 className="text-lg font-bold text-white tracking-tight">AI Settings</h3>
            <p className="text-xs text-zinc-400">Configure your AI provider</p>
          </div>
        </div>
        <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-all">
          <X size={18} />
        </button>
      </div>

      {/* Provider Selection */}
      <div className="relative space-y-3">
        <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">Select Provider</label>
        <div className="grid grid-cols-2 gap-2.5">
          {(Object.keys(providerInfo) as LLMProvider[]).map(provider => (
            <button
              key={provider}
              onClick={() => handleProviderChange(provider)}
              className={`relative p-3.5 rounded-xl text-left transition-all duration-200 border overflow-hidden group ${
                localConfig.provider === provider
                  ? 'bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 border-violet-500/50 shadow-lg shadow-purple-500/10'
                  : 'bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10'
              }`}
            >
              {localConfig.provider === provider && (
                <div className="absolute top-2 right-2">
                  <div className="w-5 h-5 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center">
                    <Check size={12} className="text-white" />
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2.5 mb-1.5">
                <span className="text-xl">{providerInfo[provider].icon}</span>
                <span className="font-semibold text-white text-sm">{providerInfo[provider].name}</span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">{providerInfo[provider].description}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Connection Status */}
      <div className="relative bg-white/5 backdrop-blur-sm rounded-xl p-4 border border-white/10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`relative w-3 h-3 rounded-full ${
              checking ? 'bg-amber-400' :
              status?.connected ? 'bg-emerald-400' : 'bg-red-400'
            }`}>
              {checking && <div className="absolute inset-0 bg-amber-400 rounded-full animate-ping" />}
              {status?.connected && <div className="absolute inset-0 bg-emerald-400 rounded-full animate-pulse opacity-50" />}
            </div>
            <div>
              <span className="text-sm font-medium text-white">Connection Status</span>
              {status && (
                <p className={`text-xs ${status.connected ? 'text-emerald-400' : 'text-red-400'}`}>
                  {status.connected ? `Connected to ${status.provider}` : (status.error || 'Not connected')}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={checkConnection}
            disabled={checking}
            className="text-xs px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-zinc-300 hover:text-white transition-all disabled:opacity-50 font-medium"
          >
            {checking ? 'Testing...' : 'Test Connection'}
          </button>
        </div>
      </div>

      {/* Ollama Setup Instructions */}
      {localConfig.provider === 'ollama' && status && !status.connected && (
        <div className="relative bg-gradient-to-br from-amber-500/10 to-orange-500/10 border border-amber-500/20 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} className="text-amber-400" />
            <p className="text-sm text-amber-300 font-semibold">Ollama Setup Required</p>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2 bg-black/20 rounded-lg p-2">
              <code className="flex-1 text-[11px] text-cyan-300 font-mono">brew install ollama && ollama serve</code>
              <button
                onClick={() => copyToClipboard('brew install ollama && ollama serve', 'install')}
                className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-all"
              >
                {copiedCommand === 'install' ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
              </button>
            </div>
            <div className="flex items-center gap-2 bg-black/20 rounded-lg p-2">
              <code className="flex-1 text-[11px] text-cyan-300 font-mono">ollama pull {localConfig.model}</code>
              <button
                onClick={() => copyToClipboard(`ollama pull ${localConfig.model}`, 'pull')}
                className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-400 hover:text-white transition-all"
              >
                {copiedCommand === 'pull' ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
              </button>
            </div>
          </div>
          <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" className="text-xs text-violet-400 hover:text-violet-300 flex items-center gap-1.5 transition-colors">
            Visit ollama.com for more info <ExternalLink size={12} />
          </a>
        </div>
      )}

      {/* API Key */}
      {currentProviderInfo.requiresApiKey && (
        <div className="space-y-2.5">
          <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">API Key</label>
          <div className="relative">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={localConfig.api_key || ''}
              onChange={(e) => setLocalConfig({ ...localConfig, api_key: e.target.value || null })}
              placeholder={`Enter your ${currentProviderInfo.name} API key`}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 pr-11 text-sm text-white placeholder-zinc-500 focus:border-violet-500/50 focus:bg-white/10 focus:outline-none transition-all"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-white transition-colors"
            >
              {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="text-[11px] text-zinc-500">
            {localConfig.provider === 'openai' && 'Get your API key from platform.openai.com'}
            {localConfig.provider === 'anthropic' && 'Get your API key from console.anthropic.com'}
          </p>
        </div>
      )}

      {/* Base URL */}
      <div className="space-y-2.5">
        <label className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
          Base URL
          {localConfig.provider !== 'custom' && <span className="text-zinc-500 font-normal normal-case">(optional)</span>}
        </label>
        <input
          type="text"
          value={localConfig.base_url}
          onChange={(e) => setLocalConfig({ ...localConfig, base_url: e.target.value })}
          placeholder="API endpoint URL"
          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-violet-500/50 focus:bg-white/10 focus:outline-none transition-all font-mono text-xs"
        />
      </div>

      {/* Advanced Settings */}
      <details className="group">
        <summary className="text-xs font-semibold text-zinc-400 uppercase tracking-wider cursor-pointer hover:text-zinc-300 flex items-center gap-2 transition-colors">
          <ChevronRight size={14} className="transition-transform duration-200 group-open:rotate-90" />
          Advanced Settings
        </summary>
        <div className="mt-4 space-y-5 pl-5 border-l-2 border-white/10">
          {/* Model Override */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-zinc-300 font-medium">Model Override</label>
              <span className="text-[10px] text-zinc-500">Default: {currentProviderInfo.defaultModel}</span>
            </div>
            <input
              type="text"
              value={localConfig.model}
              onChange={(e) => setLocalConfig({ ...localConfig, model: e.target.value })}
              placeholder={currentProviderInfo.defaultModel}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-violet-500/50 focus:outline-none transition-all font-mono text-xs"
            />
            <p className="text-[10px] text-zinc-500">Leave empty to use the default. Only change if you know the exact model name.</p>
          </div>

          {/* Temperature */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs text-zinc-300 font-medium">Temperature</label>
              <span className="text-xs text-violet-400 font-mono bg-violet-500/10 px-2 py-0.5 rounded-md">{localConfig.temperature.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={localConfig.temperature}
              onChange={(e) => setLocalConfig({ ...localConfig, temperature: parseFloat(e.target.value) })}
              className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-violet-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-500">
              <span>Precise</span>
              <span>Creative</span>
            </div>
          </div>

          {/* Max Tokens */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs text-zinc-300 font-medium">Max Tokens</label>
              <span className="text-xs text-violet-400 font-mono bg-violet-500/10 px-2 py-0.5 rounded-md">{localConfig.max_tokens}</span>
            </div>
            <input
              type="range"
              min="256"
              max="8192"
              step="256"
              value={localConfig.max_tokens}
              onChange={(e) => setLocalConfig({ ...localConfig, max_tokens: parseInt(e.target.value) })}
              className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-violet-500"
            />
          </div>
        </div>
      </details>

      {/* Action Buttons */}
      <div className="flex gap-3 pt-3">
        <button
          onClick={onClose}
          className="flex-1 py-3 px-4 rounded-xl border border-white/10 text-zinc-300 font-medium text-sm hover:bg-white/5 hover:border-white/20 transition-all"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={currentProviderInfo.requiresApiKey && !localConfig.api_key}
          className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white font-semibold text-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-purple-500/20 hover:shadow-purple-500/30 disabled:shadow-none hover:scale-[1.02] disabled:hover:scale-100"
        >
          <Check size={16} />
          Save Settings
        </button>
      </div>
    </div>
  );
}

// Helper to load LLM config from localStorage
function loadLLMConfig(): LLMConfig {
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

// Cluster-wide AI Chat Panel component - Global floating chat
function ClusterChatPanel({ onClose, isMinimized, onToggleMinimize }: { onClose: () => void, isMinimized: boolean, onToggleMinimize: () => void }) {
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'assistant' | 'tool', content: string, toolName?: string, command?: string }>>([]);
  const [userInput, setUserInput] = useState("");
  const [llmLoading, setLlmLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [llmConfig, setLlmConfig] = useState<LLMConfig>(loadLLMConfig);
  const [llmStatus, setLlmStatus] = useState<LLMStatus | null>(null);
  const [checkingLLM, setCheckingLLM] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Check LLM status on mount
  useEffect(() => {
    checkLLMStatus();
  }, [llmConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkLLMStatus = async () => {
    setCheckingLLM(true);
    try {
      const status = await invoke<LLMStatus>("check_llm_status", { config: llmConfig });
      setLlmStatus(status);
    } catch (err) {
      setLlmStatus({
        connected: false,
        provider: llmConfig.provider,
        model: llmConfig.model,
        available_models: [],
        error: String(err),
      });
    } finally {
      setCheckingLLM(false);
    }
  };

  // Auto-scroll to bottom
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [chatHistory]);

  const sendMessage = async (message: string) => {
    if (!message.trim() || llmLoading) return;

    setChatHistory(prev => [...prev, { role: 'user', content: message }]);
    setUserInput("");
    setLlmLoading(true);

    try {
      // Get cluster health summary for context
      const healthSummary = await invoke<ClusterHealthSummary>("get_cluster_health_summary");

      // Build comprehensive context
      const context = `
CLUSTER OVERVIEW:
- Nodes: ${healthSummary.total_nodes} total, ${healthSummary.ready_nodes} ready${healthSummary.not_ready_nodes.length > 0 ? `, NOT READY: ${healthSummary.not_ready_nodes.join(', ')}` : ''}
- Pods: ${healthSummary.total_pods} total, ${healthSummary.running_pods} running, ${healthSummary.pending_pods} pending, ${healthSummary.failed_pods} failed
- Deployments: ${healthSummary.total_deployments} total, ${healthSummary.healthy_deployments} healthy
- Resource Usage: CPU ${healthSummary.cluster_cpu_percent.toFixed(1)}%, Memory ${healthSummary.cluster_memory_percent.toFixed(1)}%

${healthSummary.critical_issues.length > 0 ? `CRITICAL ISSUES (${healthSummary.critical_issues.length}):
${healthSummary.critical_issues.slice(0, 10).map(i => `- [${i.resource_kind}] ${i.namespace}/${i.resource_name}: ${i.message}`).join('\n')}` : 'No critical issues.'}

${healthSummary.warnings.length > 0 ? `WARNINGS (${healthSummary.warnings.length}):
${healthSummary.warnings.slice(0, 10).map(i => `- [${i.resource_kind}] ${i.namespace}/${i.resource_name}: ${i.message}`).join('\n')}` : 'No warnings.'}

${healthSummary.crashloop_pods.length > 0 ? `CRASHLOOPING PODS (${healthSummary.crashloop_pods.length}):
${healthSummary.crashloop_pods.slice(0, 5).map(p => `- ${p.namespace}/${p.name}: ${p.restart_count} restarts, reason: ${p.reason}`).join('\n')}` : ''}

${healthSummary.unhealthy_deployments.length > 0 ? `UNHEALTHY DEPLOYMENTS (${healthSummary.unhealthy_deployments.length}):
${healthSummary.unhealthy_deployments.slice(0, 5).map(d => `- ${d.namespace}/${d.name}: ${d.ready}/${d.desired} ready - ${d.reason}`).join('\n')}` : ''}

AVAILABLE READ-ONLY TOOLS:
1. CLUSTER_HEALTH - Refresh cluster health summary
2. GET_EVENTS [namespace] - Get cluster events (optionally filter by namespace)
3. LIST_PODS [namespace] - List pods (optionally filter by namespace)
4. LIST_DEPLOYMENTS [namespace] - List deployments
5. LIST_SERVICES [namespace] - List services
6. DESCRIBE <kind> <namespace> <name> - Get detailed YAML of a resource
7. GET_LOGS <namespace> <pod> [container] - Get pod logs
8. TOP_PODS [namespace] - Show pod resource usage
9. FIND_ISSUES - Find all problematic resources

To use a tool, respond with: TOOL: <tool_name> [args]
Multiple tools: List each on a new line
`;

      const systemPrompt = `SYSTEM IDENTITY
You are a Cluster-Wide SRE AI Assistant with visibility across the ENTIRE Kubernetes cluster.
You operate as an AUTONOMOUS, READ-ONLY CLUSTER INVESTIGATOR.

SCOPE
- All namespaces and resources
- Cross-resource relationships (Service → Endpoints → Pods, Deployment → ReplicaSet → Pods)
- Cluster health, resource usage, and issues

CAPABILITIES
1. Cluster Health Analysis - Identify unhealthy nodes, pods, deployments
2. Troubleshooting - Start from symptoms, drill down to root cause
3. Optimization Suggestions - Over/under-provisioned workloads
4. Security Analysis - Privileged containers, missing limits, exposed secrets

HARD SAFETY RULES (READ ONLY)
You MUST NOT:
- Generate kubectl commands that modify state (apply, patch, delete, scale)
- Generate YAML patches or manifests to apply
- Suggest direct mutations

You MAY:
- Suggest READ-ONLY commands for users to run
- Use tools to gather more information
- Explain findings and provide recommendations

OUTPUT FORMAT (EVERY TURN)
1. SUMMARY - 2-3 sentences describing the situation
2. FINDINGS - Key observations with severity indicators [CRITICAL]/[WARNING]/[INFO]
3. RECOMMENDATIONS - What should be done (but not how to mutate)
4. NEXT INVESTIGATION STEPS - If you need more data, use TOOL: commands

Keep responses concise and actionable. Focus on the most important issues.`;

      const answer = await invoke<string>("call_llm", {
        config: llmConfig,
        prompt: `${context}\n\nUser: ${message}`,
        systemPrompt,
        conversationHistory: chatHistory.filter(m => m.role !== 'tool'),
      });

      // Check for tool usage
      const toolMatches = answer.matchAll(/TOOL:\s*(\w+)(?:\s+(.+?))?(?=\n|$)/g);
      const tools = Array.from(toolMatches);

      const validTools = ['CLUSTER_HEALTH', 'GET_EVENTS', 'LIST_PODS', 'LIST_DEPLOYMENTS',
        'LIST_SERVICES', 'DESCRIBE', 'GET_LOGS', 'TOP_PODS', 'FIND_ISSUES'];

      if (tools.length > 0) {
        let allToolResults: string[] = [];

        for (const toolMatch of tools) {
          const toolName = toolMatch[1];
          const toolArgs = toolMatch[2]?.trim();
          let toolResult = '';
          let kubectlCommand = '';

          if (!validTools.includes(toolName)) {
            toolResult = `⚠️ Invalid tool: ${toolName}. Valid tools: ${validTools.join(', ')}`;
            setChatHistory(prev => [...prev, { role: 'tool', content: toolResult, toolName: 'INVALID', command: 'N/A' }]);
            continue;
          }

          try {
            if (toolName === 'CLUSTER_HEALTH') {
              kubectlCommand = 'kubectl get nodes,pods --all-namespaces';
              const health = await invoke<ClusterHealthSummary>("get_cluster_health_summary");
              toolResult = `## Cluster Health Summary
**Nodes:** ${health.ready_nodes}/${health.total_nodes} ready
**Pods:** ${health.running_pods}/${health.total_pods} running (${health.pending_pods} pending, ${health.failed_pods} failed)
**Deployments:** ${health.healthy_deployments}/${health.total_deployments} healthy
**Resources:** CPU ${health.cluster_cpu_percent.toFixed(1)}%, Memory ${health.cluster_memory_percent.toFixed(1)}%
${health.critical_issues.length > 0 ? `\n**Critical Issues:** ${health.critical_issues.length}` : ''}
${health.warnings.length > 0 ? `\n**Warnings:** ${health.warnings.length}` : ''}`;
            } else if (toolName === 'GET_EVENTS') {
              const namespace = toolArgs || undefined;
              kubectlCommand = namespace ? `kubectl get events -n ${namespace}` : 'kubectl get events --all-namespaces';
              const events = await invoke<ClusterEventSummary[]>("get_cluster_events_summary", { namespace, limit: 20 });
              if (events.length === 0) {
                toolResult = 'No warning events found.';
              } else {
                toolResult = `## Recent Events (${events.length})\n${events.slice(0, 15).map(e =>
                  `- [${e.event_type}] ${e.namespace}/${e.name} (${e.kind}): ${e.reason} - ${e.message}${e.count > 1 ? ` (×${e.count})` : ''}`
                ).join('\n')}`;
              }
            } else if (toolName === 'LIST_PODS') {
              const namespace = toolArgs || undefined;
              kubectlCommand = namespace ? `kubectl get pods -n ${namespace}` : 'kubectl get pods --all-namespaces';
              const pods = await invoke<any[]>("list_resources", {
                req: { group: "", version: "v1", kind: "Pod", namespace: namespace || null }
              });
              const summary = pods.slice(0, 20).map(p => `- ${p.namespace}/${p.name}: ${p.status}`).join('\n');
              toolResult = `## Pods (${pods.length} total)\n${summary}${pods.length > 20 ? `\n... and ${pods.length - 20} more` : ''}`;
            } else if (toolName === 'LIST_DEPLOYMENTS') {
              const namespace = toolArgs || undefined;
              kubectlCommand = namespace ? `kubectl get deployments -n ${namespace}` : 'kubectl get deployments --all-namespaces';
              const deps = await invoke<any[]>("list_resources", {
                req: { group: "apps", version: "v1", kind: "Deployment", namespace: namespace || null }
              });
              const summary = deps.slice(0, 20).map(d => `- ${d.namespace}/${d.name}: ${d.ready || '?'}/${d.replicas || '?'} ready`).join('\n');
              toolResult = `## Deployments (${deps.length} total)\n${summary}`;
            } else if (toolName === 'LIST_SERVICES') {
              const namespace = toolArgs || undefined;
              kubectlCommand = namespace ? `kubectl get services -n ${namespace}` : 'kubectl get services --all-namespaces';
              const svcs = await invoke<any[]>("list_resources", {
                req: { group: "", version: "v1", kind: "Service", namespace: namespace || null }
              });
              const summary = svcs.slice(0, 20).map(s => `- ${s.namespace}/${s.name}: ${s.status}`).join('\n');
              toolResult = `## Services (${svcs.length} total)\n${summary}`;
            } else if (toolName === 'DESCRIBE') {
              const [kind, ns, name] = (toolArgs || '').split(/\s+/);
              if (!kind || !ns || !name) {
                toolResult = '⚠️ Usage: DESCRIBE <kind> <namespace> <name>';
              } else {
                kubectlCommand = `kubectl describe ${kind.toLowerCase()} -n ${ns} ${name}`;
                const details = await invoke<string>("get_resource_details", {
                  req: { group: kind === 'Deployment' ? 'apps' : '', version: 'v1', kind, namespace: ns },
                  name
                });
                const parsed = JSON.parse(details);
                toolResult = `## ${kind}: ${ns}/${name}\n\`\`\`yaml\n${JSON.stringify(parsed, null, 2).slice(0, 2000)}\n\`\`\``;
              }
            } else if (toolName === 'GET_LOGS') {
              const parts = (toolArgs || '').split(/\s+/);
              const [ns, pod, container] = parts;
              if (!ns || !pod) {
                toolResult = '⚠️ Usage: GET_LOGS <namespace> <pod> [container]';
              } else {
                kubectlCommand = container ? `kubectl logs -n ${ns} ${pod} -c ${container}` : `kubectl logs -n ${ns} ${pod}`;
                const logs = await invoke<string>("get_pod_logs", { namespace: ns, name: pod, container: container || null, lines: 100 });
                toolResult = `## Logs: ${ns}/${pod}${container ? ` (${container})` : ''}\n\`\`\`\n${logs.slice(-2000)}\n\`\`\``;
              }
            } else if (toolName === 'TOP_PODS') {
              kubectlCommand = 'kubectl top pods --all-namespaces';
              toolResult = '⚠️ Metrics API required. Check if metrics-server is installed.';
            } else if (toolName === 'FIND_ISSUES') {
              kubectlCommand = 'kubectl get pods --all-namespaces --field-selector=status.phase!=Running';
              const health = await invoke<ClusterHealthSummary>("get_cluster_health_summary");
              const issues = [...health.critical_issues, ...health.warnings].slice(0, 20);
              if (issues.length === 0) {
                toolResult = '✅ No issues found in the cluster.';
              } else {
                toolResult = `## Issues Found (${issues.length})\n${issues.map(i =>
                  `- [${i.severity.toUpperCase()}] ${i.resource_kind} ${i.namespace}/${i.resource_name}: ${i.message}`
                ).join('\n')}`;
              }
            }
          } catch (err) {
            toolResult = `❌ Tool error: ${err}`;
          }

          setChatHistory(prev => [...prev, { role: 'tool', content: toolResult, toolName, command: kubectlCommand }]);
          allToolResults.push(`## ${toolName}\n${toolResult}`);
        }

        // Get follow-up analysis with tool results
        const followUp = await invoke<string>("call_llm", {
          config: llmConfig,
          prompt: `Tool results:\n${allToolResults.join('\n\n')}\n\nAnalyze these results and provide your assessment.`,
          systemPrompt: "You are analyzing Kubernetes cluster data. Summarize findings, identify issues, and provide recommendations. Be concise.",
          conversationHistory: [],
        });

        setChatHistory(prev => [...prev, { role: 'assistant', content: followUp }]);
      } else {
        setChatHistory(prev => [...prev, { role: 'assistant', content: answer }]);
      }
    } catch (err) {
      setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ Error: ${err}. Check your AI settings or provider connection.` }]);
    } finally {
      setLlmLoading(false);
    }
  };

  // If minimized, show just a small pill
  if (isMinimized) {
    return (
      <div
        onClick={onToggleMinimize}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-2.5 px-5 py-2.5 bg-gradient-to-r from-violet-600 via-purple-600 to-fuchsia-600 hover:from-violet-500 hover:via-purple-500 hover:to-fuchsia-500 rounded-2xl shadow-xl shadow-purple-500/25 cursor-pointer transition-all duration-300 group hover:scale-105 hover:shadow-purple-500/40"
      >
        <div className="relative">
          <Sparkles size={18} className="text-white" />
          <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-400 rounded-full animate-pulse" />
        </div>
        <span className="text-white font-semibold text-sm tracking-tight">AI Assistant</span>
        {chatHistory.length > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-white/20 text-white font-medium backdrop-blur-sm">{chatHistory.filter(m => m.role === 'assistant').length}</span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="ml-1 p-1 rounded-full hover:bg-white/20 text-white/70 hover:text-white transition-all opacity-0 group-hover:opacity-100"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className={`fixed ${isExpanded ? 'inset-4' : 'bottom-4 right-4 w-[480px] h-[640px]'} z-50 flex flex-col bg-gradient-to-b from-[#1a1a2e] to-[#16161a] border border-white/10 rounded-2xl shadow-2xl shadow-black/50 transition-all duration-300 overflow-hidden`}>
      {/* Decorative background effects */}
      <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-purple-500/10 via-fuchsia-500/5 to-transparent pointer-events-none" />
      <div className="absolute -top-24 -right-24 w-48 h-48 bg-purple-500/20 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="relative flex items-center justify-between px-4 py-3.5 border-b border-white/5 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-fuchsia-500 rounded-xl blur-sm opacity-60" />
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500">
              <Sparkles size={16} className="text-white" />
            </div>
          </div>
          <div>
            <h3 className="font-semibold text-white text-sm tracking-tight">AI Assistant</h3>
            <button
              onClick={() => setShowSettings(true)}
              className="text-[10px] text-zinc-400 hover:text-zinc-300 flex items-center gap-1.5 transition-colors group"
            >
              <div className={`w-1.5 h-1.5 rounded-full ${llmStatus?.connected ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50' : 'bg-red-400 shadow-sm shadow-red-400/50'}`} />
              <span>{llmConfig.provider === 'ollama' ? 'Ollama' : llmConfig.provider === 'openai' ? 'OpenAI' : llmConfig.provider === 'anthropic' ? 'Anthropic' : 'Custom'}</span>
              <span className="text-zinc-500">•</span>
              <span className="text-zinc-500 group-hover:text-zinc-400">{llmConfig.model.split(':')[0]}</span>
              <ChevronDown size={10} className="text-zinc-500" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-all"
            title="Settings"
          >
            <Settings size={15} />
          </button>
          <button
            onClick={onToggleMinimize}
            className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-all"
            title="Minimize"
          >
            <Minus size={15} />
          </button>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-2 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-white transition-all"
            title={isExpanded ? "Restore" : "Expand"}
          >
            {isExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-red-500/10 text-zinc-400 hover:text-red-400 transition-all"
            title="Close"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Settings Panel Modal */}
      {showSettings && (
        <div className="absolute inset-0 z-50 bg-gradient-to-b from-[#1a1a2e] to-[#16161a] rounded-2xl overflow-y-auto">
          <LLMSettingsPanel
            config={llmConfig}
            onConfigChange={(newConfig) => {
              setLlmConfig(newConfig);
              setShowSettings(false);
            }}
            onClose={() => setShowSettings(false)}
          />
        </div>
      )}

      {/* Messages */}
      <div className="relative flex-1 overflow-y-auto p-4 space-y-4">
        {/* Loading state while checking LLM */}
        {checkingLLM && chatHistory.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-fuchsia-500 rounded-full blur-xl opacity-30 animate-pulse" />
              <Loader2 className="relative w-10 h-10 animate-spin text-purple-400" />
            </div>
            <p className="mt-4 text-sm text-zinc-400 animate-pulse">Connecting to AI...</p>
          </div>
        )}

        {/* Show setup prompt if LLM not connected */}
        {!checkingLLM && !llmStatus?.connected && chatHistory.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 px-6">
            <div className="relative mb-6">
              <div className="absolute inset-0 bg-gradient-to-br from-orange-500 to-red-500 rounded-2xl blur-xl opacity-20" />
              <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-br from-orange-500/20 to-red-500/20 flex items-center justify-center border border-orange-500/20 backdrop-blur-sm">
                <AlertCircle size={36} className="text-orange-400" />
              </div>
            </div>
            <h3 className="text-xl font-bold text-white mb-2 tracking-tight">Setup Required</h3>
            <p className="text-sm text-zinc-400 text-center mb-1 max-w-[280px]">{llmStatus?.error || 'Configure your AI provider to start chatting.'}</p>
            <p className="text-xs text-zinc-500 mb-6 font-mono">{llmConfig.provider} • {llmConfig.model}</p>
            <button
              onClick={() => setShowSettings(true)}
              className="group px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white font-semibold text-sm transition-all duration-300 flex items-center gap-2 shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40 hover:scale-105"
            >
              <Settings size={16} className="group-hover:rotate-90 transition-transform duration-300" />
              Configure AI
            </button>
          </div>
        )}

        {/* Normal chat welcome screen - only show when LLM is ready */}
        {!checkingLLM && llmStatus?.connected && chatHistory.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 px-6">
            <div className="relative mb-6">
              <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-cyan-500 rounded-2xl blur-xl opacity-20 animate-pulse" />
              <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-500/20 to-cyan-500/20 flex items-center justify-center border border-violet-500/20 backdrop-blur-sm">
                <Sparkles size={36} className="text-violet-400" />
              </div>
            </div>
            <h3 className="text-xl font-bold text-white mb-2 tracking-tight">Ready to Help</h3>
            <p className="text-sm text-zinc-400 text-center mb-1 max-w-[300px]">Ask me anything about your cluster's health, resources, or issues.</p>
            <p className="text-xs text-zinc-500 mb-6 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
              {llmStatus.provider} • {llmConfig.model.split(':')[0]}
            </p>
            <div className="flex flex-wrap gap-2 justify-center max-w-[360px]">
              {[
                { icon: '🔍', text: 'Find cluster issues' },
                { icon: '🔄', text: 'Crashlooping pods' },
                { icon: '📊', text: 'Health overview' }
              ].map(q => (
                <button
                  key={q.text}
                  onClick={() => sendMessage(q.text)}
                  className="px-3.5 py-2 text-xs bg-white/5 hover:bg-white/10 text-zinc-300 hover:text-white rounded-xl transition-all border border-white/5 hover:border-white/10 flex items-center gap-2"
                >
                  <span>{q.icon}</span>
                  {q.text}
                </button>
              ))}
            </div>
          </div>
        )}

        {chatHistory.map((msg, i) => (
          <div key={i} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            {msg.role === 'user' && (
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 bg-gradient-to-br from-violet-600/90 to-fuchsia-600/90 text-white text-sm shadow-lg shadow-purple-500/10">
                  {msg.content}
                </div>
              </div>
            )}
            {msg.role === 'tool' && (
              <div className="bg-white/5 backdrop-blur-sm rounded-xl border border-white/10 overflow-hidden">
                <div className="px-3 py-2 bg-white/5 border-b border-white/5 flex items-center gap-2">
                  <div className="p-1 rounded bg-cyan-500/20">
                    <TerminalIcon size={12} className="text-cyan-400" />
                  </div>
                  <span className="text-xs font-semibold text-cyan-300">{msg.toolName}</span>
                  {msg.command && <code className="text-[10px] text-zinc-500 ml-auto font-mono truncate max-w-[200px]">{msg.command}</code>}
                </div>
                <div className="px-3 py-2.5 prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown
                    components={{
                      p: ({ children }) => <p className="text-xs text-zinc-300 my-1 leading-relaxed">{children}</p>,
                      code: ({ children }) => <code className="text-[11px] bg-black/30 px-1.5 py-0.5 rounded text-cyan-300 font-mono">{children}</code>,
                      pre: ({ children }) => <pre className="text-[11px] bg-black/30 p-2.5 rounded-lg overflow-x-auto my-2 font-mono">{children}</pre>,
                      ul: ({ children }) => <ul className="text-xs list-disc ml-4 my-1 space-y-0.5">{children}</ul>,
                      li: ({ children }) => <li className="text-zinc-300">{children}</li>,
                      h2: ({ children }) => <h2 className="text-sm font-semibold text-white mt-3 mb-1.5">{children}</h2>,
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            {msg.role === 'assistant' && (
              <div className="flex justify-start gap-2">
                <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 flex items-center justify-center border border-violet-500/20">
                  <Sparkles size={12} className="text-violet-400" />
                </div>
                <div className="max-w-[85%] rounded-2xl rounded-tl-md px-4 py-2.5 bg-white/5 backdrop-blur-sm border border-white/10 prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown
                    components={{
                      p: ({ children }) => <p className="text-[13px] text-zinc-200 my-1.5 leading-relaxed">{children}</p>,
                      strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
                      code: ({ children }) => <code className="text-[11px] bg-black/30 px-1.5 py-0.5 rounded text-cyan-300 font-mono">{children}</code>,
                      pre: ({ children }) => <pre className="text-[11px] bg-black/30 p-2.5 rounded-lg overflow-x-auto my-2 font-mono">{children}</pre>,
                      ul: ({ children }) => <ul className="text-[13px] list-disc ml-4 my-1.5 space-y-1">{children}</ul>,
                      ol: ({ children }) => <ol className="text-[13px] list-decimal ml-4 my-1.5 space-y-1">{children}</ol>,
                      li: ({ children }) => <li className="text-zinc-200">{children}</li>,
                      h1: ({ children }) => <h1 className="text-sm font-bold text-white mt-3 mb-1.5">{children}</h1>,
                      h2: ({ children }) => <h2 className="text-sm font-semibold text-white mt-3 mb-1.5">{children}</h2>,
                      h3: ({ children }) => <h3 className="text-xs font-semibold text-white mt-2 mb-1">{children}</h3>,
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ))}

        {llmLoading && (
          <div className="flex justify-start gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500/20 to-fuchsia-500/20 flex items-center justify-center border border-violet-500/20">
              <Sparkles size={12} className="text-violet-400 animate-pulse" />
            </div>
            <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl rounded-tl-md px-4 py-3 flex items-center gap-3">
              <div className="flex gap-1">
                <div className="w-2 h-2 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 rounded-full bg-fuchsia-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-sm text-zinc-400">Analyzing cluster...</span>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div className="relative border-t border-white/5 p-3 bg-black/20 backdrop-blur-sm">
        <form onSubmit={(e) => { e.preventDefault(); sendMessage(userInput); }} className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              disabled={llmLoading}
              placeholder="Ask about your cluster..."
              className="w-full px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white text-sm placeholder-zinc-500 focus:outline-none focus:border-violet-500/50 focus:bg-white/10 transition-all duration-200"
            />
          </div>
          <button
            type="submit"
            disabled={llmLoading || !userInput.trim()}
            className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 disabled:from-zinc-700 disabled:to-zinc-700 disabled:text-zinc-500 text-white font-medium transition-all duration-200 shadow-lg shadow-purple-500/20 hover:shadow-purple-500/30 disabled:shadow-none hover:scale-105 disabled:hover:scale-100"
          >
            <Send size={16} />
          </button>
        </form>
      </div>
    </div>
  );
}

function VclusterConnectButton({ name, namespace }: { name: string, namespace: string }) {
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("");
  const qc = useQueryClient();
  // Handle Reload button: invalidate queries globally when event fires
  useEffect(() => {
    const handler = () => {
      try {
        qc.invalidateQueries();
      } catch { }
    };
    window.addEventListener("lenskiller:reload", handler);
    return () => window.removeEventListener("lenskiller:reload", handler);
  }, [qc]);
  return (
    <div>
      {connecting ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-md bg-cyan-900/50 border border-cyan-500/30">
            <Loader2 size={14} className="animate-spin text-cyan-400" />
            <span className="text-xs text-cyan-200 flex-1">{status || "Initializing..."}</span>
          </div>
          <button
            onClick={() => {
              setConnecting(false);
              setStatus("");
              if ((window as any).showToast) {
                (window as any).showToast('Connection cancelled', 'info');
              }
            }}
            className="w-full px-3 py-1.5 rounded-md bg-zinc-700/50 hover:bg-zinc-600/50 text-zinc-300 text-xs font-medium transition-all flex items-center justify-center gap-1.5"
          >
            <X size={12} />
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={async () => {
            try {
              setConnecting(true);
              setStatus("Starting vcluster proxy...");

              // Status updates to show progress
              const statusUpdates = [
                { delay: 500, msg: "Starting vcluster proxy..." },
                { delay: 2000, msg: "Waiting for proxy to initialize..." },
                { delay: 4000, msg: "Configuring kubeconfig..." },
                { delay: 6000, msg: "Verifying API connection..." },
                { delay: 10000, msg: "Establishing secure tunnel..." },
              ];

              const timeoutIds: ReturnType<typeof setTimeout>[] = [];
              statusUpdates.forEach(({ delay, msg }) => {
                const id = setTimeout(() => setStatus(msg), delay);
                timeoutIds.push(id);
              });

              const result = await invoke("connect_vcluster", {
                name,
                namespace
              });

              // Clear status timeouts
              timeoutIds.forEach(id => clearTimeout(id));

              console.log('vcluster connect success:', result);
              setStatus("Connected! Loading cluster...");
              setConnected(true);
              // Toast notify
              if ((window as any).showToast) {
                (window as any).showToast(`Connected to vcluster '${name}' in namespace '${namespace}'`, 'success');
              }
              // Clear all caches - backend caches are already cleared in connect_vcluster
              // Clear frontend React Query caches
              qc.clear();
              await qc.invalidateQueries({ queryKey: ["current_context"] });
              await qc.invalidateQueries({ queryKey: ["cluster_stats"] });
              await qc.invalidateQueries({ queryKey: ["cluster_cockpit"] });
              await qc.invalidateQueries({ queryKey: ["initial_cluster_data"] });
              await qc.invalidateQueries({ queryKey: ["vclusters"] });
              await qc.invalidateQueries({ queryKey: ["discovery"] });
              await qc.invalidateQueries({ queryKey: ["namespaces"] });
              await qc.invalidateQueries({ queryKey: ["crd-groups"] });
              await qc.invalidateQueries({ queryKey: ["metrics"] });
              // Also refetch any resource lists that depend on context
              await qc.invalidateQueries({ predicate: (q) => Array.isArray(q.queryKey) && q.queryKey.includes("list_resources") });
            } catch (err) {
              console.error('vcluster connect error:', err);
              if ((window as any).showToast) {
                (window as any).showToast(`Failed to connect: ${err}`, 'error');
              }
              alert(`Error: ${err}\n\nTo connect manually, run:\nvcluster connect ${name} -n ${namespace}`);
            } finally {
              setConnecting(false);
              setStatus("");
            }
          }}
          disabled={connecting}
          className={`w-full mt-3 px-3 py-2 rounded-md text-xs font-medium transition-all flex items-center justify-center gap-2 ${connecting ? 'bg-cyan-800 text-white cursor-not-allowed' : 'bg-cyan-600 hover:bg-cyan-700 text-white'}`}
        >
          <Plug size={14} />
          Connect to vcluster
        </button>
      )}
      {connected && (
        <div className="mt-2 text-xs flex items-center gap-2 text-green-400">
          <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.707a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 10-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" /></svg>
          Connected to {name}. Refreshing data...
        </div>
      )}
    </div>
  );
}

// Custom hook for real-time resource watching via Kubernetes watch API
function useResourceWatch(
  resourceType: NavResource | null,
  namespace: string | null,
  currentContext: string | undefined,
  enabled: boolean = true
) {
  const qc = useQueryClient();
  const [isWatching, setIsWatching] = useState(false);
  const [syncComplete, setSyncComplete] = useState(false);
  const watchIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !resourceType || !resourceType.kind || !currentContext) {
      return;
    }

    const watchId = `watch_${resourceType.group}_${resourceType.version}_${resourceType.kind}_${namespace || 'all'}_${Date.now()}`;
    watchIdRef.current = watchId;
    setIsWatching(true);
    setSyncComplete(false);

    const queryKey = ["list_resources", currentContext, resourceType.group || "", resourceType.version || "", resourceType.kind || "", namespace === null ? "All Namespaces" : namespace];

    // Start the watch
    invoke("start_resource_watch", {
      req: {
        group: resourceType.group,
        version: resourceType.version,
        kind: resourceType.kind,
        namespace: namespace
      },
      watchId
    }).catch(err => {
      console.error("Failed to start resource watch:", err);
      setIsWatching(false);
    });

    // Listen for watch events
    const unlistenWatch = listen<ResourceWatchEvent>(`resource_watch:${watchId}`, (event) => {
      const watchEvent = event.payload;

      qc.setQueryData(queryKey, (oldData: K8sObject[] | undefined) => {
        if (!oldData) return [watchEvent.resource];

        switch (watchEvent.event_type) {
          case "ADDED":
            // Check if already exists (might be from initial sync)
            if (oldData.some(r => r.id === watchEvent.resource.id)) {
              return oldData.map(r => r.id === watchEvent.resource.id ? watchEvent.resource : r);
            }
            return [...oldData, watchEvent.resource];

          case "MODIFIED":
            return oldData.map(r => r.id === watchEvent.resource.id ? watchEvent.resource : r);

          case "DELETED":
            return oldData.filter(r => r.id !== watchEvent.resource.id);

          default:
            return oldData;
        }
      });
    });

    // Listen for sync complete
    const unlistenSync = listen(`resource_watch_sync:${watchId}`, () => {
      setSyncComplete(true);
    });

    // Listen for watch end
    const unlistenEnd = listen(`resource_watch_end:${watchId}`, () => {
      setIsWatching(false);
      setSyncComplete(false);
    });

    // Cleanup
    return () => {
      unlistenWatch.then(fn => fn());
      unlistenSync.then(fn => fn());
      unlistenEnd.then(fn => fn());
      invoke("stop_resource_watch", { watchId }).catch(() => { });
      setIsWatching(false);
      setSyncComplete(false);
    };
  }, [resourceType?.group, resourceType?.version, resourceType?.kind, namespace, currentContext, enabled, qc]);

  return { isWatching, syncComplete };
}

// Resource list component - shows all resources of a given type
function ResourceList({ resourceType, onSelect, namespaceFilter, searchQuery, currentContext }: { resourceType: NavResource, onSelect: (obj: K8sObject) => void, namespaceFilter: string, searchQuery: string, currentContext?: string }) {
  // Defensive guard: ensure resourceType is valid
  if (!resourceType || !resourceType.kind) {
    return <div className="h-full flex items-center justify-center"><Loading size={24} label="Loading" /></div>;
  }

  const qc = useQueryClient();

  // Delete modal state
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [resourceToDelete, setResourceToDelete] = useState<K8sObject | null>(null);

  const handleDeleteRequest = (resource: K8sObject) => {
    setResourceToDelete(resource);
    setDeleteModalOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!resourceToDelete) return;
    try {
      await invoke("delete_resource", {
        req: {
          group: resourceType.group,
          version: resourceType.version,
          kind: resourceType.kind,
          namespace: resourceToDelete.namespace === '-' ? null : resourceToDelete.namespace
        },
        name: resourceToDelete.name
      });
      (window as any).showToast?.(`Deleted ${resourceType.kind} '${resourceToDelete.name}'`, 'success');
      // Invalidate the query to refresh the list
      qc.invalidateQueries({ queryKey: ["list_resources"] });
    } catch (err) {
      (window as any).showToast?.(`Failed to delete: ${err}`, 'error');
    }
    setDeleteModalOpen(false);
    setResourceToDelete(null);
  };

  // Enable real-time watching via Kubernetes watch API
  const watchNamespace = namespaceFilter === "All Namespaces" ? null : namespaceFilter;
  const { isWatching, syncComplete } = useResourceWatch(resourceType, watchNamespace, currentContext, true);

  // Live age ticker - updates every second for real-time age display
  const _ageTick = useLiveAge(1000);

  const { data: resources, isLoading: isListLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ["list_resources", currentContext, resourceType.group || "", resourceType.version || "", resourceType.kind || "", namespaceFilter],
    queryFn: async () => await invoke<K8sObject[]>("list_resources", {
      req: {
        group: resourceType.group,
        version: resourceType.version,
        kind: resourceType.kind,
        namespace: namespaceFilter === "All Namespaces" ? null : namespaceFilter
      }
    }),
    staleTime: isWatching ? Infinity : 10000, // Don't consider stale if watching
    gcTime: 1000 * 60 * 5, // Keep in cache for 5 minutes
    refetchInterval: isWatching ? false : 30000, // Disable polling when watching
    refetchOnWindowFocus: false,
  });

  // Listen for global reloads and refetch
  useEffect(() => {
    const handler = () => {
      refetch();
    };
    window.addEventListener("lenskiller:reload", handler);
    return () => window.removeEventListener("lenskiller:reload", handler);
  }, [refetch]);

  const kindLower = (resourceType.kind || '').toLowerCase();
  const isPod = kindLower === 'pod';
  const isNode = kindLower === 'node';

  // Fetch metrics for pods and nodes
  const { data: metricsData } = useQuery({
    queryKey: ["list_metrics", currentContext, resourceType.kind || "", namespaceFilter],
    queryFn: async () => {
      try {
        return await invoke<ResourceMetrics[]>("get_resource_metrics", {
          kind: resourceType.kind,
          namespace: isPod ? (namespaceFilter === "All Namespaces" ? null : namespaceFilter) : null
        });
      } catch (e) {
        console.warn("Metrics not available:", e);
        return [];
      }
    },
    enabled: isPod || isNode,
    staleTime: 10000,
    refetchInterval: 30000,
  });

  const metricsMap = useMemo(() => {
    const map = new Map<string, ResourceMetrics>();
    if (metricsData) {
      metricsData.forEach(m => map.set(`${m.namespace || ''}/${m.name}`, m));
    }
    return map;
  }, [metricsData]);

  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);

  const filteredResources = useMemo(() => {
    if (!resources) return [];
    let filtered = resources.filter(r => {
      const nsMatch = namespaceFilter === "All Namespaces" || r.namespace === namespaceFilter;
      const searchMatch = !searchQuery || r.name.toLowerCase().includes(searchQuery.toLowerCase());
      return nsMatch && searchMatch;
    });

    // Apply sorting
    if (sortConfig) {
      filtered = [...filtered].sort((a, b) => {
        let aVal: any = a[sortConfig.key as keyof K8sObject];
        let bVal: any = b[sortConfig.key as keyof K8sObject];

        // Special handling for different data types
        if (sortConfig.key === 'age') {
          aVal = new Date(a.age).getTime();
          bVal = new Date(b.age).getTime();
        } else if (sortConfig.key === 'restarts') {
          aVal = a.restarts ?? 0;
          bVal = b.restarts ?? 0;
        } else if (sortConfig.key === 'ready') {
          // Parse ready string like "1/1" to compare
          const [aReady, aTotal] = (a.ready || '0/0').split('/').map(Number);
          const [bReady, bTotal] = (b.ready || '0/0').split('/').map(Number);
          aVal = aTotal > 0 ? aReady / aTotal : 0;
          bVal = bTotal > 0 ? bReady / bTotal : 0;
        } else if (sortConfig.key === 'cpu' || sortConfig.key === 'memory') {
          // For nodes, namespace is "-" in resource list but "" in metrics
          const aNs = a.namespace === '-' ? '' : (a.namespace || '');
          const bNs = b.namespace === '-' ? '' : (b.namespace || '');
          const aMetrics = metricsMap.get(`${aNs}/${a.name}`);
          const bMetrics = metricsMap.get(`${bNs}/${b.name}`);
          aVal = sortConfig.key === 'cpu' ? (aMetrics?.cpu_nano ?? 0) : (aMetrics?.memory_bytes ?? 0);
          bVal = sortConfig.key === 'cpu' ? (bMetrics?.cpu_nano ?? 0) : (bMetrics?.memory_bytes ?? 0);
        }

        // String comparison for text fields
        if (typeof aVal === 'string' && typeof bVal === 'string') {
          return sortConfig.direction === 'asc'
            ? aVal.localeCompare(bVal)
            : bVal.localeCompare(aVal);
        }

        // Numeric comparison
        if (sortConfig.direction === 'asc') {
          return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        } else {
          return bVal < aVal ? -1 : bVal > aVal ? 1 : 0;
        }
      });
    }

    return filtered;
  }, [resources, namespaceFilter, searchQuery, sortConfig, metricsMap]);

  const handleSort = (key: string) => {
    setSortConfig(current => {
      if (!current || current.key !== key) {
        return { key, direction: 'asc' };
      }
      if (current.direction === 'asc') {
        return { key, direction: 'desc' };
      }
      return null; // Reset sorting
    });
  };

  const SortableHeader = ({ label, sortKey }: { label: string; sortKey: string }) => {
    const isActive = sortConfig?.key === sortKey;
    const direction = sortConfig?.direction;
    return (
      <div
        onClick={() => handleSort(sortKey)}
        className="flex items-center gap-1 cursor-pointer hover:text-cyan-400 transition-all select-none"
      >
        <span>{label}</span>
        <div className="flex flex-col">
          <ChevronDown
            size={10}
            className={`-mb-1 ${isActive && direction === 'asc' ? 'text-cyan-400' : 'text-gray-700'}`}
            style={{ transform: 'rotate(180deg)' }}
          />
          <ChevronDown
            size={10}
            className={`${isActive && direction === 'desc' ? 'text-cyan-400' : 'text-gray-700'}`}
          />
        </div>
      </div>
    );
  };

  // Show loading state
  // Guard: don't render anything until resources are loaded
  if (!resources) {
    return <Loading fullScreen size={32} />;
  }

  // Show error ONLY if we have no data at all
  if (!resources) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <div className="bg-red-500/10 p-8 rounded-xl border border-red-500/30 max-w-md backdrop-blur-sm shadow-lg shadow-red-500/10">
          <AlertCircle size={40} className="text-red-400 mx-auto mb-4" />
          <h3 className="text-base font-bold text-white mb-2">No Data Available</h3>
          <p className="text-gray-400 text-sm">
            {isError ? `Error: ${error}` : "Loading resources..."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#09090b]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-white/5 bg-zinc-900/30 backdrop-blur-md text-xs sticky top-0 z-10">
        <div className="flex items-center gap-2 text-zinc-500">
          <span className="uppercase tracking-wider font-semibold">{resourceType.kind}</span>
          {isListLoading && !syncComplete ? (
            <span className="flex items-center gap-1 text-cyan-400">
              <Loading size={12} label="Loading" />
            </span>
          ) : isError ? (
            <span className="flex items-center gap-1 text-red-400">
              <AlertCircle size={12} /> Failed
            </span>
          ) : isWatching ? (
            <span className="flex items-center gap-1 text-emerald-400" title="Real-time updates via Kubernetes watch API">
              <div className="relative">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <div className="absolute inset-0 w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping opacity-75" />
              </div>
              <Activity size={12} className="ml-0.5" />
              Real-time
            </span>
          ) : (
            <span className={`flex items-center gap-1 ${isFetching ? 'text-cyan-400' : 'text-zinc-500'}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${isFetching ? 'bg-cyan-400 animate-pulse' : 'bg-zinc-500'}`} />
              {isFetching ? 'Updating...' : 'Polling'}
            </span>
          )}
        </div>
      </div>
      {isPod ? (
        <div className="grid grid-cols-[2fr_1.5fr_0.8fr_0.7fr_0.8fr_0.8fr_0.8fr_1.2fr_1fr_40px] gap-3 px-6 py-3 bg-zinc-900/50 border-b border-white/5 text-xs uppercase text-zinc-500 font-semibold tracking-wider shrink-0 backdrop-blur-sm">
          <SortableHeader label="Name" sortKey="name" />
          <SortableHeader label="Namespace" sortKey="namespace" />
          <SortableHeader label="Ready" sortKey="ready" />
          <SortableHeader label="Status" sortKey="status" />
          <SortableHeader label="Restarts" sortKey="restarts" />
          <SortableHeader label="CPU" sortKey="cpu" />
          <SortableHeader label="Memory" sortKey="memory" />
          <SortableHeader label="Node" sortKey="node" />
          <SortableHeader label="Age" sortKey="age" />
          <div />
        </div>
      ) : isNode ? (
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_40px] gap-4 px-6 py-3 bg-zinc-900/50 border-b border-white/5 text-xs uppercase text-zinc-500 font-semibold tracking-wider shrink-0 backdrop-blur-sm">
          <SortableHeader label="Name" sortKey="name" />
          <SortableHeader label="Status" sortKey="status" />
          <SortableHeader label="CPU" sortKey="cpu" />
          <SortableHeader label="Memory" sortKey="memory" />
          <SortableHeader label="Age" sortKey="age" />
          <div />
        </div>
      ) : (
        <div className="grid grid-cols-[2fr_1.5fr_1fr_1fr_40px] gap-4 px-6 py-3 bg-zinc-900/50 border-b border-white/5 text-xs uppercase text-zinc-500 font-semibold tracking-wider shrink-0 backdrop-blur-sm">
          <SortableHeader label="Name" sortKey="name" />
          <SortableHeader label="Namespace" sortKey="namespace" />
          <SortableHeader label="Status" sortKey="status" />
          <SortableHeader label="Age" sortKey="age" />
          <div />
        </div>
      )}

      {/* List */}
      <div className="flex-1">
        {isListLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-10 bg-white/5 rounded animate-pulse" />
            ))}
          </div>
        ) : filteredResources.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-zinc-500">
            <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mb-4 border border-white/10">
              <Layers size={32} className="opacity-40 text-zinc-400" />
            </div>
            <p className="text-base font-medium text-zinc-300">No resources found</p>
            <p className="text-sm opacity-60 mt-2">
              {searchQuery ? `No matches for "${searchQuery}"` : `There are no ${resourceType.kind}s in ${namespaceFilter}`}
            </p>
          </div>
        ) : (
          <Virtuoso
            style={{ height: "100%" }}
            data={filteredResources}
            itemContent={(_, obj) => {
              // For nodes, namespace is "-" in resource list but "" in metrics
              const metricsNs = obj.namespace === '-' ? '' : (obj.namespace || '');
              const metrics = metricsMap.get(`${metricsNs}/${obj.name}`);
              return isPod ? (
                <div
                  onClick={() => onSelect(obj)}
                  className="grid grid-cols-[2fr_1.5fr_0.8fr_0.7fr_0.8fr_0.8fr_0.8fr_1.2fr_1fr_40px] gap-3 px-6 py-3 text-sm border-b border-white/5 cursor-pointer transition-all items-center hover:bg-white/5 group"
                >
                  <div className="font-medium text-zinc-200 truncate group-hover:text-white transition-colors" title={obj.name}>{obj.name}</div>
                  <div className="text-zinc-500 truncate" title={obj.namespace}>{obj.namespace}</div>
                  <div className="text-cyan-400 font-mono text-xs font-semibold">{obj.ready || '0/0'}</div>
                  <div><StatusBadge status={obj.status} /></div>
                  <div className="text-yellow-400 font-mono text-xs font-semibold">{obj.restarts ?? 0}</div>
                  <div className="text-emerald-400 font-mono text-xs font-semibold">{metrics?.cpu || '-'}</div>
                  <div className="text-orange-400 font-mono text-xs font-semibold">{metrics?.memory || '-'}</div>
                  <div className="text-zinc-500 truncate text-xs" title={obj.node}>{obj.node || '-'}</div>
                  <div className="text-zinc-600 font-mono text-xs">{formatAge(obj.age)}</div>
                  <ResourceContextMenu
                    resource={obj}
                    onViewDetails={() => onSelect(obj)}
                    onDelete={() => handleDeleteRequest(obj)}
                    isPod={true}
                  />
                </div>
              ) : isNode ? (
                <div
                  onClick={() => onSelect(obj)}
                  className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_40px] gap-4 px-6 py-3 text-sm border-b border-white/5 cursor-pointer transition-all items-center hover:bg-white/5 group"
                >
                  <div className="font-medium text-zinc-200 truncate group-hover:text-white transition-colors" title={obj.name}>{obj.name}</div>
                  <div><StatusBadge status={obj.status} /></div>
                  <div className="text-emerald-400 font-mono text-xs font-semibold">{metrics?.cpu || '-'}</div>
                  <div className="text-orange-400 font-mono text-xs font-semibold">{metrics?.memory || '-'}</div>
                  <div className="text-zinc-600 font-mono text-xs">{formatAge(obj.age)}</div>
                  <ResourceContextMenu
                    resource={obj}
                    onViewDetails={() => onSelect(obj)}
                    onDelete={() => handleDeleteRequest(obj)}
                  />
                </div>
              ) : (
                <div
                  onClick={() => onSelect(obj)}
                  className="grid grid-cols-[2fr_1.5fr_1fr_1fr_40px] gap-4 px-6 py-3 text-sm border-b border-white/5 cursor-pointer transition-all items-center hover:bg-white/5 group"
                >
                  <div className="font-medium text-zinc-200 truncate group-hover:text-white transition-colors" title={obj.name}>{obj.name}</div>
                  <div className="text-zinc-500 truncate" title={obj.namespace}>{obj.namespace}</div>
                  <div><StatusBadge status={obj.status} /></div>
                  <div className="text-zinc-600 font-mono text-xs">{formatAge(obj.age)}</div>
                  <ResourceContextMenu
                    resource={obj}
                    onViewDetails={() => onSelect(obj)}
                    onDelete={() => handleDeleteRequest(obj)}
                  />
                </div>
              );
            }}
          />
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <DeleteConfirmationModal
        isOpen={deleteModalOpen}
        onClose={() => { setDeleteModalOpen(false); setResourceToDelete(null); }}
        onConfirm={handleDeleteConfirm}
        resourceName={resourceToDelete?.name || ''}
      />
    </div>
  );
}

interface Tab {
  id: string;
  resource: K8sObject;
  kind: string;
}

function Dashboard({ onDisconnect }: { onDisconnect: () => void, isConnected: boolean, setIsConnected: (v: boolean) => void }) {
  const [activeRes, setActiveRes] = useState<NavResource | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [resourceToDelete, setResourceToDelete] = useState<K8sObject | null>(null);

  // Resizable UI State
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [terminalHeight, setTerminalHeight] = useState(350);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [isResizingTerminal, setIsResizingTerminal] = useState(false);

  const [selectedNamespace, setSelectedNamespace] = useState<string>("All Namespaces");
  const [searchQuery, setSearchQuery] = useState(""); // Search State
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState(""); // Sidebar search
  const [isCmdPaletteOpen, setIsCmdPaletteOpen] = useState(false); // Command Palette State
  const [isTerminalOpen, setIsTerminalOpen] = useState(false); // Local Terminal State
  const qc = useQueryClient();
  // Don't clear cache on mount - it blocks the UI and causes slow loading
  // The cache will be cleared when needed (e.g., on disconnect)
  /*
  useEffect(() => {
    (async () => {
      try { qc.invalidateQueries(); } catch { }
      try {
        // @ts-ignore
        await invoke("clear_discovery_cache");
      } catch { }
    })();
  }, [qc]);
  */

  const selectedObj = tabs.find(t => t.id === activeTabId)?.resource || null;

  const handleOpenResource = (obj: K8sObject) => {
    const tabId = `${obj.namespace}-${obj.name}-${obj.kind}`;
    const existingTab = tabs.find(t => t.id === tabId);

    if (existingTab) {
      setActiveTabId(tabId);
    } else {
      const newTab: Tab = {
        id: tabId,
        resource: obj,
        kind: activeRes?.kind || ""
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(tabId);
    }
  };

  const handleCloseTab = (tabId: string | null) => {
    if (!tabId) return;

    setTabs(prev => {
      const filtered = prev.filter(t => t.id !== tabId);
      if (activeTabId === tabId && filtered.length > 0) {
        setActiveTabId(filtered[filtered.length - 1].id);
      } else if (filtered.length === 0) {
        setActiveTabId(null);
      }
      return filtered;
    });
  };

  // Fetch Current Context Name
  const { data: currentContext } = useQuery({
    queryKey: ["current_context"],
    queryFn: async () => await invoke<string>("get_current_context_name"),
  });

  // Track previous context to detect changes
  const prevContextRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevContextRef.current && currentContext && prevContextRef.current !== currentContext) {
      // Context changed - remove all cached data except current_context query
      console.log(`Context changed from ${prevContextRef.current} to ${currentContext}, clearing cache`);
      qc.removeQueries({ predicate: (query) => query.queryKey[0] !== "current_context" });
      // Clear component state that holds resources from the old context
      setTabs([]);
      setActiveTabId(null);
      setActiveRes(null);
      setSelectedNamespace("All Namespaces");
      setSearchQuery("");
    }
    prevContextRef.current = currentContext;
  }, [currentContext, qc]);

  // Keyboard Shortcut for Command Palette & Terminal
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsCmdPaletteOpen((open) => !open);
      }
      if (e.key === "`" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsTerminalOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  // Handle Resizing
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingSidebar) {
        setSidebarWidth(Math.max(200, Math.min(600, e.clientX)));
      }
      if (isResizingTerminal) {
        setTerminalHeight(Math.max(150, Math.min(800, window.innerHeight - e.clientY)));
      }
    };

    const handleMouseUp = () => {
      setIsResizingSidebar(false);
      setIsResizingTerminal(false);
      document.body.style.cursor = 'default';
    };

    if (isResizingSidebar || isResizingTerminal) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = isResizingSidebar ? 'col-resize' : 'row-resize';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default';
    };
  }, [isResizingSidebar, isResizingTerminal]);

  // 1. Fetch Discovery (Nav Structure) Sidebar Structure - scoped to current context
  const { data: navStructure, isLoading: isDiscovering, isError: isDiscoveryError, error: discoveryError, refetch: refetchDiscovery } = useQuery({
    queryKey: ["discovery", currentContext],
    queryFn: async () => await invoke<NavGroup[]>("discover_api_resources"),
    enabled: !!currentContext,
    staleTime: 1000 * 60 * 5, // 5 minutes - API resources rarely change
    gcTime: 1000 * 60 * 30, // Keep in memory for 30 minutes
  });

  // 1b. Fetch initial cluster data in parallel - this populates caches for instant navigation
  const { data: initialData } = useQuery({
    queryKey: ["initial_cluster_data", currentContext],
    queryFn: async () => {
      const data = await invoke<InitialClusterData>("get_initial_cluster_data");

      // Pre-populate React Query caches with the fetched data for instant navigation
      // This means when user clicks Pods, Nodes, etc., data is already available
      qc.setQueryData(["cluster_stats"], data.stats);
      qc.setQueryData(["namespaces", currentContext], data.namespaces);
      qc.setQueryData(["list_resources", currentContext, "", "v1", "Pod", "All Namespaces"], data.pods);
      qc.setQueryData(["list_resources", currentContext, "", "v1", "Node", "All Namespaces"], data.nodes);
      qc.setQueryData(["list_resources", currentContext, "apps", "v1", "Deployment", "All Namespaces"], data.deployments);
      qc.setQueryData(["list_resources", currentContext, "", "v1", "Service", "All Namespaces"], data.services);

      return data;
    },
    enabled: !!currentContext,
    staleTime: 30000, // 30 seconds
    gcTime: 1000 * 60 * 5, // 5 minutes
  });

  // Invalidate discovery on context change to force loading state
  useEffect(() => {
    if (currentContext) {
      try {
        qc.invalidateQueries({ queryKey: ["discovery", currentContext] });
      } catch { }
    }
  }, [currentContext, qc]);

  // 1a. Fetch CRDs separately for progressive hydration of Custom Resources
  const { data: crdGroups, isLoading: isCrdLoading } = useQuery({
    queryKey: ["crd-groups", currentContext],
    queryFn: async () => {
      try {
        const crds = await invoke<any[]>("list_crds");
        // Group CRDs by apiGroup title
        const grouped: Record<string, any[]> = {};
        crds.forEach((c: any) => {
          const apiGroup = c.group || "Custom";
          const entry = {
            kind: c.kind,
            group: c.group,
            version: (c.versions || [])[0]?.name || c.version || "v1",
            namespaced: c.scope === "Namespaced",
            title: c.kind
          };
          if (!grouped[apiGroup]) grouped[apiGroup] = [];
          grouped[apiGroup].push(entry);
        });
        return grouped;
      } catch (e) {
        console.warn("CRD listing failed", e);
        return {};
      }
    },
    enabled: !!currentContext,
    staleTime: 1000 * 60 * 5, // 5 minutes - CRDs rarely change
  });

  // Force re-discovery when global reload occurs
  useEffect(() => {
    const handler = () => {
      refetchDiscovery();
    };
    window.addEventListener("lenskiller:reload", handler);
    return () => window.removeEventListener("lenskiller:reload", handler);
  }, [refetchDiscovery]);

  // Default to Cluster Overview
  useEffect(() => {
    if (navStructure && !activeRes) {
      setActiveRes(null); // null means Cluster Overview
    }
  }, [navStructure]);

  // State for expanded groups - persist to localStorage
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() => {
    const saved = localStorage.getItem('opspilot-expanded-groups');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        // Fall through to defaults
      }
    }
    return {
      "Cluster": false,
      "Workloads": false,
      "Network": false,
      "Config": false,
      "Storage": false,
      "Access Control": false,
      "Crossplane": false,
      "Virtual Clusters": true,
      "Custom Resources": false
    };
  });

  const toggleGroup = (group: string) => {
    setExpandedGroups(prev => {
      const newState = { ...prev, [group]: !prev[group] };
      localStorage.setItem('opspilot-expanded-groups', JSON.stringify(newState));
      return newState;
    });
  };

  // Grouping Logic
  const groupedResources = useMemo(() => {
    if (!navStructure) return {};

    const groups: Record<string, any[]> = {
      "Cluster": [],
      "Workloads": [],
      "Config": [],
      "Network": [],
      "Storage": [],
      "Access Control": []
    };

    const mappings: Record<string, string> = {
      "Node": "Cluster",
      "Namespace": "Cluster",
      "Event": "Cluster",
      "Pod": "Workloads",
      "Deployment": "Workloads",
      "StatefulSet": "Workloads",
      "DaemonSet": "Workloads",
      "Job": "Workloads",
      "CronJob": "Workloads",
      "ReplicaSet": "Workloads",
      "ConfigMap": "Config",
      "Secret": "Config",
      "ResourceQuota": "Config",
      "HorizontalPodAutoscaler": "Config",
      "Service": "Network",
      "Ingress": "Network",
      "NetworkPolicy": "Network",
      "Endpoint": "Network",
      "PersistentVolumeClaim": "Storage",
      "PersistentVolume": "Storage",
      "StorageClass": "Storage",
      "ServiceAccount": "Access Control",
      "Role": "Access Control",
      "RoleBinding": "Access Control",
      "ClusterRole": "Access Control",
      "ClusterRoleBinding": "Access Control"
    };

    navStructure.forEach(group => {
      // Skip the top-level "Custom Resources" bucket; we'll show CRDs under their API groups instead
      if (group.title === "Custom Resources") {
        return;
      }
      group.items.forEach(item => {
        const targetGroup = mappings[item.kind];
        if (targetGroup) {
          groups[targetGroup].push(item);
        } else {
          // Use the API Group title for custom resources
          const apiGroup = group.title;
          if (!groups[apiGroup]) {
            groups[apiGroup] = [];
          }
          groups[apiGroup].push(item);
        }
      });
    });

    // Merge CRDs discovered separately for progressive hydration
    if (crdGroups) {
      Object.entries(crdGroups).forEach(([apiGroup, items]) => {
        if (!groups[apiGroup]) groups[apiGroup] = [];
        // Dedup by kind
        const existingKinds = new Set(groups[apiGroup].map(i => i.kind));
        items.forEach((i: any) => {
          if (!existingKinds.has(i.kind)) {
            // Normalize: ensure title is present (fallback to kind)
            const normalized = { ...i, title: i.title ?? i.kind };
            groups[apiGroup].push(normalized);
          }
        });
      });
    }

    // Deduplicate items in each group by title (case-insensitive)
    Object.keys(groups).forEach(groupName => {
      const seen = new Set<string>();
      groups[groupName] = groups[groupName]
        .map(item => ({ ...item, title: item.title ?? item.kind }))
        .filter(item => {
          const key = (item.title || '').toLowerCase();
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        });
    });

    return groups;
  }, [navStructure, crdGroups]);

  // Filter grouped resources based on sidebar search
  const filteredGroupedResources = useMemo(() => {
    if (!sidebarSearchQuery.trim()) return groupedResources;

    const query = sidebarSearchQuery.toLowerCase();
    const filtered: Record<string, any[]> = {};

    Object.entries(groupedResources).forEach(([groupName, items]) => {
      const matchingItems = (items || []).filter(item => {
        const title = (item?.title ?? item?.kind ?? "").toLowerCase();
        const kind = (item?.kind ?? "").toLowerCase();
        return (
          title.includes(query) ||
          kind.includes(query) ||
          groupName.toLowerCase().includes(query)
        );
      });

      if (matchingItems.length > 0) {
        filtered[groupName] = matchingItems;
      }
    });

    return filtered;
  }, [groupedResources, sidebarSearchQuery]);

  // 2. Fetch Namespaces for Filter (scoped to current context)
  // Note: initialData comes from get_initial_cluster_data which pre-populates the cache
  const { data: namespaces } = useQuery({
    queryKey: ["namespaces", currentContext],
    queryFn: async () => {
      try {
        const res = await invoke<K8sObject[]>("list_resources", {
          req: { group: "", version: "v1", kind: "Namespace", namespace: null }
        });
        const list = res.map(n => n.name).filter(Boolean);
        return Array.from(new Set(list)).sort();
      } catch (e) {
        console.error('Failed to fetch namespaces:', e);
        return [] as string[];
      }
    },
    staleTime: 1000 * 60 * 2, // 2 minutes - namespaces rarely change
    initialData: initialData?.namespaces?.sort(), // Use cached data from initial fetch
  });

  // Set default active resource to Cluster Overview
  useEffect(() => {
    if (navStructure && !activeRes) {
      setActiveRes(null); // null means Cluster Overview
    }
  }, [navStructure]);

  // 2.5 Background Prefetching (Performance Optimization)
  useEffect(() => {
    if (!navStructure || !currentContext) return;

    const prefetch = async () => {
      console.log("Starting background prefetch...");

      // Collect all items to prefetch
      const allItems = navStructure.flatMap(group => group.items);

      // Skip resources already fetched by initial data (Pod, Node, Deployment, Service)
      const alreadyFetched = ["Pod", "Node", "Deployment", "Service"];

      // Prioritize common resources - load these first for snappier UX
      const priorityKinds = ["ConfigMap", "Secret", "Ingress", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"];
      const priorityItems = allItems.filter(item =>
        priorityKinds.includes(item.kind) && !alreadyFetched.includes(item.kind)
      );
      const otherItems = allItems.filter(item =>
        !priorityKinds.includes(item.kind) && !alreadyFetched.includes(item.kind)
      );
      const sortedItems = [...priorityItems, ...otherItems];

      // Prefetch in parallel batches of 10 to avoid overwhelming the backend
      const batchSize = 10;
      for (let i = 0; i < sortedItems.length; i += batchSize) {
        const batch = sortedItems.slice(i, i + batchSize);
        await Promise.all(
          batch.map(item =>
            qc.prefetchQuery({
              // Use same query key format as ResourceList for cache hit
              queryKey: ["list_resources", currentContext, item.group || "", item.version || "", item.kind || "", "All Namespaces"],
              queryFn: async () => {
                return await invoke<K8sObject[]>("list_resources", {
                  req: {
                    group: item.group,
                    version: item.version,
                    kind: item.kind,
                    namespace: null
                  }
                });
              },
              staleTime: 30000,
            })
          )
        );
      }
      console.log("Background prefetch complete.");
    };

    // Small delay to allow initial render to settle
    const timer = setTimeout(prefetch, 500);
    return () => clearTimeout(timer);
  }, [navStructure, currentContext, qc]);



  const deleteMutation = useMutation({
    mutationFn: async (obj: K8sObject) => {
      if (!activeRes) return;
      await invoke("delete_resource", {
        req: { group: activeRes.group, version: activeRes.version, kind: activeRes.kind, namespace: obj.namespace === "-" ? null : obj.namespace },
        name: obj.name
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["list_resources"] });
      if (activeTabId) {
        handleCloseTab(activeTabId);
      }
    }
  });





  // Note: We no longer block the entire UI during discovery.
  // ClusterOverview shows immediately with skeleton loading for stats,
  // and the sidebar shows a skeleton while discovery is in progress.

  if (isDiscoveryError) {
    return (
      <div className="h-screen bg-[#1e1e1e] text-[#cccccc] flex flex-col items-center justify-center p-8">
        <div className="bg-[#f48771]/10 p-8 rounded-xl border border-[#f48771]/20 max-w-md text-center">
          <AlertCircle size={40} className="text-[#f48771] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-white mb-2">Discovery Failed</h3>
          <p className="text-[#f48771] text-sm mb-6">{discoveryError?.toString()}</p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={onDisconnect}
              className="bg-[#3e3e42] hover:bg-[#4a4a4a] text-white px-4 py-2 rounded transition-colors text-sm"
            >
              Go Back
            </button>
            <button
              onClick={() => setActiveRes({ kind: "Azure", group: "Azure", version: "v1", namespaced: false, title: "Azure" })}
              className="bg-[#007acc] hover:bg-[#0098ff] text-white px-4 py-2 rounded transition-colors text-sm flex items-center gap-2"
            >
              <Cloud size={14} />
              Open Azure Explorer
            </button>
          </div>
        </div>
      </div>
    );

  }

  if (!navStructure && !isDiscovering) {
    return (
      <div className="h-screen bg-[#1e1e1e] text-[#cccccc] flex flex-col items-center justify-center p-8">
        <AlertCircle size={40} className="text-[#f48771] mb-4" />
        <h3 className="text-lg font-bold text-white mb-2">No Data Found</h3>
        <p className="text-[#858585] text-sm mb-6">Discovery completed but returned no structure.</p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={onDisconnect}
            className="bg-[#3e3e42] hover:bg-[#4a4a4a] text-white px-4 py-2 rounded transition-colors text-sm"
          >
            Go Back
          </button>
          <button
            onClick={() => setActiveRes({ kind: "Azure", group: "Azure", version: "v1", namespaced: false, title: "Azure" })}
            className="bg-[#007acc] hover:bg-[#0098ff] text-white px-4 py-2 rounded transition-colors text-sm flex items-center gap-2"
          >
            <Cloud size={14} />
            Open Azure Explorer
          </button>
        </div>
      </div>
    );
  }



  console.log("Dashboard Render:", { isDiscovering, isDiscoveryError, navStructure, activeRes });

  return (
    <div className="flex h-screen bg-[#1e1e1e] text-[#cccccc] font-sans overflow-hidden">
      <CommandPalette
        isOpen={isCmdPaletteOpen}
        onClose={() => setIsCmdPaletteOpen(false)}
        navStructure={navStructure}
        onNavigate={(res) => {
          setActiveRes(res);
          setActiveTabId(null);
          setSearchQuery("");
        }}
      />

      {/* Sidebar */}
      <aside
        className="fixed top-0 bottom-0 left-0 z-30 flex flex-col glass-panel border-r border-white/5 transition-all duration-300 ease-in-out"
        style={{ width: sidebarWidth }}
      >
        {/* Sidebar Header */}
        <div className="h-14 flex items-center justify-between px-4 border-b border-white/5 shrink-0 bg-white/5 backdrop-blur-sm">
          <div className="flex items-center gap-3 overflow-hidden">
            <img src="/icon.png" alt="OpsPilot" className="w-8 h-8 rounded-lg shadow-lg shadow-cyan-500/20 shrink-0" />
            <div className="flex flex-col min-w-0">
              <span className="font-bold text-sm tracking-tight text-white truncate">OpsPilot</span>
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
                <span className="text-[10px] text-zinc-400 truncate font-medium">{currentContext || "Unknown"}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar Search Bar */}
        <div className="px-3 pt-3 pb-2 flex items-center gap-2">
          <div className="relative group flex-1">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500 group-focus-within:text-cyan-400 transition-colors">
              <Search size={14} />
            </div>
            <input
              type="text"
              placeholder="Search resources..."
              value={sidebarSearchQuery}
              onChange={(e) => setSidebarSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-zinc-900/50 border border-white/5 text-zinc-200 text-sm rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-500/50 focus:border-cyan-500/50 placeholder:text-zinc-600 transition-all"
            />
            {sidebarSearchQuery && (
              <button
                onClick={() => setSidebarSearchQuery("")}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-500 hover:text-white transition-colors"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <button
            onClick={async () => {
              try {
                await invoke("clear_discovery_cache");
                await queryClient.invalidateQueries({ queryKey: ["nav_structure"] });
                window.location.reload();
              } catch (e) {
                console.error("Failed to refresh discovery:", e);
              }
            }}
            className="p-2 bg-zinc-900/50 border border-white/5 text-zinc-500 hover:text-white rounded-md hover:bg-white/10 transition-colors"
            title="Refresh Discovery Cache"
          >
            <RefreshCw size={14} />
          </button>
        </div>


        {/* Topology button removed */}

        <div className="flex-1 overflow-y-auto py-2 px-3 space-y-6 custom-scrollbar">
          {/* Cluster Overview Button */}
          {(!sidebarSearchQuery || "cluster".includes(sidebarSearchQuery.toLowerCase()) || "overview".includes(sidebarSearchQuery.toLowerCase()) || "dashboard".includes(sidebarSearchQuery.toLowerCase())) && (
            <div className="mb-1">
              <button
                onClick={() => {
                  setActiveRes(null);
                  setActiveTabId(null);
                  setSearchQuery("");
                }}
                className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-md transition-all group ${activeRes === null ? "bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-lg shadow-cyan-500/30" : "text-zinc-400 hover:text-white hover:bg-white/5"}`}
              >
                <div className="flex items-center gap-2.5">
                  <LayoutDashboard size={18} className={activeRes === null ? "text-white" : "text-cyan-400 group-hover:text-cyan-300"} />
                  <span>Cluster Overview</span>
                </div>
              </button>
            </div>
          )}

          {/* Helm Releases Button */}
          {(!sidebarSearchQuery || "helm".includes(sidebarSearchQuery.toLowerCase()) || "release".includes(sidebarSearchQuery.toLowerCase())) && (
            <div className="mb-1">
              <button
                onClick={() => {
                  setActiveRes({ kind: "HelmReleases", group: "helm", version: "v1", namespaced: false, title: "Releases" });
                  setActiveTabId(null);
                  setSearchQuery("");
                }}
                className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-md transition-all group ${activeRes?.kind === "HelmReleases" ? "bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-lg shadow-purple-500/30" : "text-zinc-400 hover:text-white hover:bg-white/5"}`}
              >
                <div className="flex items-center gap-2.5">
                  <Package size={18} className={activeRes?.kind === "HelmReleases" ? "text-white" : "text-purple-400 group-hover:text-purple-300"} />
                  <span>Helm Releases</span>
                </div>
              </button>
            </div>
          )}

          {/* Sidebar Skeleton while discovering */}
          {isDiscovering && (
            <div className="space-y-4 animate-pulse">
              {["Cluster", "Workloads", "Config", "Network", "Storage"].map((title) => (
                <div key={title} className="space-y-1.5">
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <div className="w-4 h-4 bg-zinc-800 rounded" />
                    <div className="h-3 bg-zinc-800 rounded w-20" />
                  </div>
                  <div className="pl-6 space-y-1">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-7 bg-zinc-900/50 rounded mx-2" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Cluster"] && (
            <SidebarGroup
              title="Cluster"
              icon={Server}
              items={filteredGroupedResources["Cluster"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Cluster"]}
              onToggle={() => toggleGroup("Cluster")}
            />
          )}

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Workloads"] && (
            <SidebarGroup
              title="Workloads"
              icon={PieChart}
              items={filteredGroupedResources["Workloads"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Workloads"]}
              onToggle={() => toggleGroup("Workloads")}
            />
          )}

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Config"] && (
            <SidebarGroup
              title="Config"
              icon={FileCog}
              items={filteredGroupedResources["Config"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Config"]}
              onToggle={() => toggleGroup("Config")}
            />
          )}

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Network"] && (
            <SidebarGroup
              title="Network"
              icon={Network}
              items={filteredGroupedResources["Network"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Network"]}
              onToggle={() => toggleGroup("Network")}
            />
          )}

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Storage"] && (
            <SidebarGroup
              title="Storage"
              icon={HardDrive}
              items={filteredGroupedResources["Storage"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Storage"]}
              onToggle={() => toggleGroup("Storage")}
            />
          )}

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Access Control"] && (
            <SidebarGroup
              title="Access Control"
              icon={Shield}
              items={filteredGroupedResources["Access Control"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Access Control"]}
              onToggle={() => toggleGroup("Access Control")}
            />
          )}

          {!navStructure || isDiscovering ? null : filteredGroupedResources["Crossplane"] && (
            <SidebarGroup
              title="Crossplane"
              icon={Cloud}
              items={filteredGroupedResources["Crossplane"]}
              activeRes={activeRes}
              onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
              isOpen={expandedGroups["Crossplane"]}
              onToggle={() => toggleGroup("Crossplane")}
            />
          )}

          {/* Custom Resources Section */}
          {!navStructure || isDiscovering ? null : Object.keys(filteredGroupedResources).some(g => ["Cluster", "Workloads", "Config", "Network", "Storage", "Access Control", "Crossplane"].includes(g) === false) && (
            <SidebarSection
              title="Custom Resources"
              icon={Puzzle}
              isOpen={expandedGroups["Custom Resources"]}
              onToggle={() => toggleGroup("Custom Resources")}
            >
              {/* Clearer loading label; hide once any CRD group appears */}
              {isCrdLoading && Object.keys(filteredGroupedResources).filter(g => !["Cluster", "Workloads", "Config", "Network", "Storage", "Access Control", "Crossplane"].includes(g)).length === 0 && (
                <div className="px-3 py-2">
                  <Loading size={14} label="Loading Custom Resources…" />
                </div>
              )}
              {Object.keys(filteredGroupedResources)
                .filter(g => !["Cluster", "Workloads", "Config", "Network", "Storage", "Access Control", "Crossplane"].includes(g))
                .sort()
                .map(groupTitle => (
                  <SidebarGroup
                    key={groupTitle}
                    title={groupTitle}
                    icon={FolderOpen}
                    items={filteredGroupedResources[groupTitle]}
                    activeRes={activeRes}
                    onSelect={(res: any) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
                    isOpen={expandedGroups[groupTitle]}
                    onToggle={() => toggleGroup(groupTitle)}
                  />
                ))}
            </SidebarSection>
          )}
        </div>

        {/* User Profile / Context */}
        <div className="p-3 border-t border-gray-800 flex flex-col gap-1">
          <button
            onClick={() => setIsTerminalOpen(!isTerminalOpen)}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-base rounded-md transition-all ${isTerminalOpen ? 'bg-gradient-to-r from-green-600 to-emerald-600 text-white shadow-lg shadow-green-500/30' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            <TerminalIcon size={18} />
            <span>Terminal</span>
          </button>
          <button onClick={async () => {
            console.log("Disconnect button clicked");

            // Clear ALL cached data immediately to prevent stale data
            console.log("Clearing all query cache...");
            qc.removeQueries();

            // Clear backend caches
            try {
              await invoke("clear_discovery_cache");
            } catch (e) {
              console.error("Failed to clear discovery cache:", e);
            }

            // Proceed with disconnect
            console.log("Calling onDisconnect...");
            onDisconnect();
            console.log("Disconnect complete");
          }} className="w-full flex items-center gap-2.5 px-3 py-2.5 text-base text-gray-400 hover:text-white hover:bg-gray-800 rounded-md transition-all">
            <LogOutIcon size={18} />
            <span>Disconnect</span>
          </button>
        </div>
      </aside >

      {/* Local Terminal Drawer */}
      {
        isTerminalOpen && (
          <div
            className="absolute bottom-0 left-0 right-0 bg-black border-t border-gray-800 z-40 flex flex-col shadow-2xl shadow-green-500/10 animate-in slide-in-from-bottom-10"
            style={{ height: terminalHeight, left: sidebarWidth }}
          >
            {/* Resize Handle */}
            <div
              className="absolute top-0 left-0 right-0 h-1 cursor-row-resize hover:bg-gradient-to-r hover:from-green-500 hover:to-emerald-500 transition-all z-50"
              onMouseDown={() => setIsResizingTerminal(true)}
            />

            <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
              <span className="text-sm font-bold text-[#cccccc] flex items-center gap-2">
                <TerminalIcon size={16} />
                Local Terminal
              </span>
              <button onClick={() => setIsTerminalOpen(false)} className="text-[#858585] hover:text-white">
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-hidden p-2">
              <LocalTerminalTab />
            </div>
          </div>
        )
      }

      {/* Main Content */}
      <main
        className="flex-1 flex flex-col min-w-0 bg-[#09090b] relative transition-all duration-300 ease-in-out"
        style={{ marginLeft: sidebarWidth }}
      >
        {activeRes?.kind === "HelmReleases" ? (
          <HelmReleases currentContext={currentContext} />
        ) : (
          <>
            {/* Header */}
            <header className="h-14 glass-header flex items-center justify-between px-6 sticky top-0 z-20">
              <div className="flex items-center gap-4">
                {/* Breadcrumbs */}
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-zinc-500 font-medium">{activeRes?.group || "Core"}</span>
                  <ChevronRight size={14} className="text-zinc-700" />
                  <span className="font-semibold text-zinc-100 tracking-tight">{activeRes?.title}</span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {/* Search Input */}
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500 group-focus-within:text-cyan-400 transition-colors">
                    <Search size={14} />
                  </div>
                  <input
                    type="text"
                    placeholder="Filter resources..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="bg-zinc-900/50 border border-white/10 text-zinc-200 text-xs rounded-full focus:ring-2 focus:ring-cyan-500/20 focus:border-cyan-500/50 block w-48 pl-9 p-2 placeholder:text-zinc-600 focus:outline-none transition-all focus:w-64"
                  />
                </div>

                {/* Namespace Filter */}
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-500">
                    <Filter size={14} />
                  </div>
                  <select
                    value={selectedNamespace}
                    onChange={(e) => setSelectedNamespace(e.target.value)}
                    className="bg-zinc-900/50 border border-white/10 text-zinc-200 text-xs rounded-full focus:ring-2 focus:ring-cyan-500/20 focus:border-cyan-500/50 block w-40 pl-9 pr-8 p-2 appearance-none focus:outline-none cursor-pointer hover:bg-zinc-800 transition-all"
                  >
                    <option value="">All Namespaces</option>
                    {namespaces?.map(ns => (
                      <option key={ns} value={ns}>{ns}</option>
                    ))}
                  </select>
                  <div className="absolute inset-y-0 right-0 pr-2 flex items-center pointer-events-none text-zinc-500">
                    <ChevronDown size={14} />
                  </div>
                </div>
              </div>
            </header>

            {/* Content */}
            <div className="flex-1 overflow-hidden relative">
              {activeRes?.kind === "Azure" ? (
                <AzurePage onConnect={() => setActiveRes(null)} />
              ) : activeRes?.kind === "HelmReleases" ? (
                <HelmReleases currentContext={currentContext} />
              ) : activeRes ? (
                /* Gate resource list until discovery completes - it needs navStructure */
                !navStructure || isDiscovering ? (
                  <div className="h-full flex items-center justify-center"><Loading size={32} label="Loading resources..." /></div>
                ) : (
                  <ResourceList
                    resourceType={activeRes}
                    onSelect={handleOpenResource}
                    namespaceFilter={selectedNamespace}
                    searchQuery={searchQuery}
                    currentContext={currentContext}
                  />
                )
              ) : (
                /* ClusterCockpit - comprehensive cluster dashboard */
                <ClusterCockpit
                  navStructure={navStructure}
                  onNavigate={(res) => { setActiveRes(res); setActiveTabId(null); setSearchQuery(""); }}
                  currentContext={currentContext}
                />
              )}
            </div>
          </>
        )}
      </main>

      {/* Tabs Bar */}
      {
        tabs.length > 0 && (
          <div className="absolute top-14 left-0 right-0 h-10 bg-gray-900 border-b border-gray-800 flex items-center px-2 gap-1 overflow-x-auto z-10" style={{ marginLeft: sidebarWidth }}>
            {/* Reload button to clear backend discovery cache and refresh */}
            <button
              onClick={async () => {
                try {
                  // Clear Tauri backend discovery cache if available
                  // @ts-ignore invoke is provided by tauri
                  await invoke("clear_discovery_cache");
                } catch (e) {
                  // no-op if command not present
                }
                // Trigger UI data reloads
                try {
                  // If using React Query, globally invalidate
                  // @ts-ignore queryClient in scope? fallback to window event
                  if (typeof queryClient !== "undefined") {
                    await queryClient.invalidateQueries();
                  }
                } catch { }
                // Fallback: emit a custom event other components can listen to
                window.dispatchEvent(new CustomEvent("lenskiller:reload"));
              }}
              className="flex items-center gap-2 px-2 py-1 rounded text-xs font-medium bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700 transition-all mr-2"
              title="Reload (clear cache and refetch)"
            >
              <span className="inline-flex items-center gap-1">
                Reload
              </span>
            </button>
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-t text-xs font-medium transition-all group ${activeTabId === tab.id
                  ? 'bg-black text-white border-t-2 border-t-cyan-400'
                  : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
                  }`}
              >
                <span className="truncate max-w-[120px]">{tab.resource.name}</span>
                <span
                  role="button"
                  aria-label="Close tab"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseTab(tab.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      handleCloseTab(tab.id);
                    }
                  }}
                  className="opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
                >
                  <X size={12} />
                </span>
              </button>
            ))}
          </div>
        )
      }

      {/* Deep Dive Drawer */}
      {
        selectedObj && activeTabId && (
          <DeepDiveDrawer
            resource={selectedObj}
            kind={tabs.find(t => t.id === activeTabId)?.kind || ""}
            onClose={() => handleCloseTab(activeTabId)}
            onDelete={() => {
              setResourceToDelete(selectedObj);
              setIsDeleteModalOpen(true);
            }}
            currentContext={currentContext}
          />
        )
      }

      {/* Delete Confirmation Modal */}
      <DeleteConfirmationModal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false);
          setResourceToDelete(null);
        }}
        onConfirm={() => {
          if (resourceToDelete) {
            deleteMutation.mutate(resourceToDelete);
          }
        }}
        resourceName={resourceToDelete?.name || ""}
      />
    </div >
  );
}




// --- Deep Dive Components ---

function DeepDiveDrawer({ resource, kind, onClose, onDelete, currentContext }: { resource: K8sObject, kind: string, onClose: () => void, onDelete: () => void, currentContext?: string }) {
  const [activeTab, setActiveTab] = useState("overview");
  const [isExpanded, setIsExpanded] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(800);
  const [isResizing, setIsResizing] = useState(false);
  const minWidth = 500;
  const maxWidth = typeof window !== 'undefined' ? window.innerWidth - 100 : 1600;

  // Handle resize drag
  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      setDrawerWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)));
    };
    const handleMouseUp = () => setIsResizing(false);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, maxWidth]);

  const [isPFOpen, setIsPFOpen] = useState(false);
  // Fetched full details (handles empty raw_json from list)
  const { data: fullObject, isLoading: detailsLoading, error: detailsError } = useQuery({
    queryKey: ["resource_details_obj", currentContext, resource.namespace, resource.group, resource.version, resource.kind, resource.name],
    queryFn: async () => {
      if (resource.raw_json && resource.raw_json.trim() !== "") {
        try { return JSON.parse(resource.raw_json); } catch { /* ignore */ }
      }
      const jsonStr = await invoke<string>("get_resource_details", {
        req: {
          group: resource.group,
          version: resource.version,
          kind: resource.kind,
          namespace: resource.namespace !== "-" ? resource.namespace : null
        },
        name: resource.name
      });
      try { return JSON.parse(jsonStr); } catch { return {}; }
    },
    staleTime: 30000,
  });
  const podSpec = useMemo(() => fullObject?.spec || {}, [fullObject]);

  return (
    <aside
      className={`bg-black border-l border-gray-800 flex flex-col shadow-2xl shadow-purple-500/10 z-30 h-full absolute right-0 top-0 ${isResizing ? '' : 'transition-all duration-300'}`}
      style={{ width: isExpanded ? '100%' : drawerWidth }}
    >
      {/* Resize Handle */}
      {!isExpanded && (
        <div
          className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-cyan-500/50 transition-colors group z-50"
          onMouseDown={() => setIsResizing(true)}
        >
          <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-8 bg-zinc-800 border border-zinc-700 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            <GripVertical size={10} className="text-zinc-500" />
          </div>
        </div>
      )}

      <PortForwardModal
        isOpen={isPFOpen}
        onClose={() => setIsPFOpen(false)}
        namespace={resource.namespace}
        podName={resource.name}
      />

      {/* Header */}
      <div className="h-12 border-b border-gray-800 flex items-center justify-between px-4 bg-gradient-to-r from-gray-900 to-black shrink-0">
        <div className="flex flex-col overflow-hidden">
          <h3 className="font-semibold text-white truncate text-sm">{resource.name}</h3>
          <span className="text-[10px] text-gray-500 uppercase tracking-wider">{kind}</span>
        </div>
        <div className="flex gap-2 items-center">
          {kind === "Pod" && (
            <button
              onClick={() => setIsPFOpen(true)}
              className="p-1.5 text-cyan-400 hover:bg-cyan-500/10 rounded transition-colors flex items-center gap-1 border border-cyan-500/30 hover:border-cyan-500/50"
              title="Port Forward"
            >
              <Plug size={14} />
              <span className="text-xs font-medium">Forward</span>
            </button>
          )}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded transition-colors"
            title={isExpanded ? "Minimize panel" : "Maximize panel"}
          >
            {isExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button onClick={onClose} className="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded transition-colors">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-800 px-4 gap-4 shrink-0 bg-gray-900">
        <TabButton active={activeTab === "overview"} onClick={() => setActiveTab("overview")} icon={<Eye size={12} />} label="Overview" />
        {kind === "Pod" && <TabButton active={activeTab === "logs"} onClick={() => setActiveTab("logs")} icon={<List size={12} />} label="Logs" />}
        {kind === "Pod" && <TabButton active={activeTab === "terminal"} onClick={() => setActiveTab("terminal")} icon={<TerminalIcon size={12} />} label="Terminal" />}
        <TabButton active={activeTab === "events"} onClick={() => setActiveTab("events")} icon={<Activity size={12} />} label="Events" />
        <TabButton active={activeTab === "yaml"} onClick={() => setActiveTab("yaml")} icon={<FileCode size={12} />} label="YAML" />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 bg-black">
        {activeTab === "overview" && <OverviewTab resource={resource} fullObject={fullObject} loading={detailsLoading} error={detailsError as Error | undefined} onDelete={onDelete} currentContext={currentContext} />}
        {activeTab === "logs" && kind === "Pod" && <LogsTab namespace={resource.namespace} name={resource.name} podSpec={podSpec} />}
        {activeTab === "terminal" && kind === "Pod" && <TerminalTab namespace={resource.namespace} name={resource.name} podSpec={podSpec} />}
        {activeTab === "events" && <EventsTab namespace={resource.namespace} name={resource.name} uid={resource.id} currentContext={currentContext} />}
        {activeTab === "yaml" && <YamlTab resource={resource} currentContext={currentContext} />}
      </div>
    </aside>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button
      onClick={onClick}
      className={`py-2.5 text-xs font-medium flex items-center gap-1.5 border-b-2 transition-all ${active ? "border-cyan-400 text-white" : "border-transparent text-gray-500 hover:text-gray-300"
        }`}
    >
      {icon} {label}
    </button>
  );
}

// --- Collapsible Section Component ---
function CollapsibleSection({ title, icon, children, defaultOpen = true }: { title: string, icon: React.ReactNode, children: React.ReactNode, defaultOpen?: boolean }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="bg-gradient-to-br from-gray-900 to-black rounded-lg border border-gray-800 overflow-hidden shadow-lg">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-900 hover:bg-gray-800 transition-all"
      >
        <div className="flex items-center gap-2 text-xs font-bold text-purple-400 uppercase tracking-wider">
          {icon}
          {title}
        </div>
        {isOpen ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
      </button>
      {isOpen && (
        <div className="p-4 border-t border-gray-800">
          {children}
        </div>
      )}
    </div>
  );
}

function OverviewTab({ resource, fullObject, loading, error, onDelete, currentContext }: { resource: K8sObject, fullObject: any, loading: boolean, error?: Error, onDelete: () => void, currentContext?: string }) {
  const [llmLoading, setLlmLoading] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<
    { state: 'unknown' | 'connected' | 'unreachable' | 'model-missing'; detail?: string }
  >({ state: 'unknown' });
  const [showOllamaHelp, setShowOllamaHelp] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'assistant' | 'tool', content: string, toolName?: string, command?: string }>>([]);
  const [userInput, setUserInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Live age ticker - updates every second for real-time age display
  const _ageTick = useLiveAge(1000);

  const metadata = fullObject?.metadata || {};

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (showChat && chatEndRef.current) {
      // Use scrollIntoView with block: 'nearest' to prevent page scrolling
      chatEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [chatHistory, showChat]);

  const sendMessage = async (message: string) => {
    if (!message.trim()) return;

    const newUserMessage = { role: 'user' as const, content: message };
    setChatHistory(prev => [...prev, newUserMessage]);
    setUserInput("");
    setLlmLoading(true);

    try {
      // Gather comprehensive context upfront to reduce hallucinations
      let recentEvents = '';
      try {
        const events = await invoke<any[]>("list_events", {
          namespace: resource.namespace,
          name: resource.name,
          uid: resource.id
        });
        const last10 = events.slice(0, 10);
        if (last10.length > 0) {
          recentEvents = last10.map(e =>
            `[${e.type_}] ${e.reason}: ${e.message}${e.count > 1 ? ` (×${e.count})` : ''}`
          ).join('\n');
        }
      } catch (e) {
        recentEvents = 'Unable to fetch events';
      }

      // Build comprehensive context
      const podConditions = resource.kind === 'Pod' && fullObject?.status?.conditions
        ? fullObject.status.conditions.map((c: any) => `${c.type}=${c.status} (${c.reason || 'N/A'})${c.message ? ` "${c.message}"` : ''}`).join('\n  ')
        : '';

      const podContainerStatuses = resource.kind === 'Pod' && fullObject?.status?.containerStatuses
        ? fullObject.status.containerStatuses.map((cs: any) => {
          const state = cs.state ? Object.keys(cs.state)[0] : 'unknown';
          const stateInfo = cs.state?.[state];
          const restarts = cs.restartCount || 0;
          const resources = fullObject?.spec?.containers?.find((c: any) => c.name === cs.name)?.resources;
          const resourceStr = resources ? `\n    Requests: ${JSON.stringify(resources.requests || {})}\n    Limits: ${JSON.stringify(resources.limits || {})}` : '';
          return `  ${cs.name}:\n    State: ${state}${stateInfo?.reason ? ` (${stateInfo.reason})` : ''}${stateInfo?.exitCode !== undefined ? ` [exit ${stateInfo.exitCode}]` : ''}\n    Restarts: ${restarts}${resourceStr}`;
        }).join('\n')
        : '';

      const ownerRefs = fullObject?.metadata?.ownerReferences
        ? fullObject.metadata.ownerReferences.map((o: any) => `${o.kind}/${o.name}`).join(', ')
        : 'None';

      const labels = fullObject?.metadata?.labels
        ? Object.entries(fullObject.metadata.labels).map(([k, v]) => `${k}=${v}`).join(', ')
        : 'None';

      const context = `
Current Resource:
- Kind: ${resource.kind}
- Name: ${resource.name}
- Namespace: ${resource.namespace}
- Status: ${resource.status}
- Age: ${formatAge(resource.age)}
- Owner: ${ownerRefs}
- Labels: ${labels}
${resource.kind === 'Pod' && fullObject?.status?.phase ? `- Phase: ${fullObject.status.phase}` : ''}
${resource.kind === 'Pod' && fullObject?.status?.podIP ? `- Pod IP: ${fullObject.status.podIP}` : ''}
${resource.kind === 'Pod' && fullObject?.spec?.nodeName ? `- Node: ${fullObject.spec.nodeName}` : ''}
${podConditions ? `- Conditions:\n  ${podConditions}` : ''}
${podContainerStatuses ? `- Containers:\n${podContainerStatuses}` : ''}
${resource.kind === 'Deployment' && fullObject?.status ? `- Replicas: ${fullObject.status.replicas || 0}/${fullObject.spec?.replicas || 0} available: ${fullObject.status.availableReplicas || 0}` : ''}
${resource.kind === 'Service' && fullObject?.spec?.type ? `- Type: ${fullObject.spec.type}, ClusterIP: ${fullObject.spec.clusterIP || 'N/A'}` : ''}

Recent Events (last 10):
${recentEvents || 'No recent events'}

Available READ-ONLY debugging tools:
1. DESCRIBE - Get full YAML manifest
2. EVENTS - Get all events for this resource
3. LOGS [container_name] - Get pod logs (optionally specify container)
   **CRITICAL:** Check "Containers:" section in context above for available container names
   **IMPORTANT:** Container names must be plain text, NO brackets, quotes, or spaces
   **CORRECT:** LOGS manager (if "manager" is listed in Containers section)
   **WRONG:** LOGS [calico-node], LOGS "calico-node", LOGS calico node
   **WRONG:** Using a container name from a different pod
4. LOGS_PREVIOUS [container_name] - Get previous pod logs (for crashloops)
   **CRITICAL:** Check "Containers:" section in context above for available container names
   **IMPORTANT:** Container names must be plain text, NO brackets, quotes, or spaces
   **CORRECT:** LOGS_PREVIOUS manager (if "manager" is listed in Containers section)
   **WRONG:** LOGS_PREVIOUS [calico-node]
   **WRONG:** Using a container name from a different pod
5. RELATED_PODS - List related pods (same namespace/labels)
6. PARENT_DETAILS - Get parent resource details (owner references)
7. NETWORK_CHECK - Check service/endpoint status
8. RESOURCE_USAGE - Get current resource metrics
9. LIST_RESOURCES <kind> - List resources of type (e.g., "configmaps", "secrets")
10. DESCRIBE_ANY <kind> <name> - Describe any resource in namespace
11. NODE_INFO - Get node details if pod is scheduled
12. STORAGE_CHECK - Check PVC/PV status for pods

**All tools are read-only and safe - they only retrieve information, never modify resources.**

**CRITICAL SYNTAX RULES:**
- Container names: NO brackets [], quotes "", or apostrophes ''
- Arguments must be plain text separated by spaces
- If you see a TOOL SYNTAX ERROR, fix your syntax and try again

To use a tool, respond with: TOOL: <tool_name> [args]
You can use multiple tools - list each on a new line.
`;

      const answer = await invoke<string>("call_local_llm_with_tools", {
        prompt: `${context}\n\nUser: ${message}`,
        systemPrompt: `SYSTEM IDENTITY
You are a Distinguished Engineer and Principal SRE for Kubernetes and cloud-native systems.
You operate as an AUTONOMOUS, READ-ONLY INCIDENT INVESTIGATOR.

You do NOT wait to be told what to do.
You actively:
- Form hypotheses
- Decide what evidence you need next
- Ask for that evidence explicitly
- Refine or discard hypotheses as new data arrives
- Drive the debugging process end-to-end

You NEVER perform or suggest cluster mutations.
You ONLY analyze and reason.

------------------------------------------------
HARD SAFETY RULES (READ ONLY)
You MUST NOT:
- Generate kubectl commands that modify state (apply, patch, delete, scale, rollout, exec, cp)
- Generate YAML patches or manifests to apply
- Suggest direct mutations like "run this to fix it"
- Provide shell commands that change the cluster

You MAY:
- Suggest READ-ONLY commands the user can run to collect data
  (e.g., "You can run: kubectl get pod X -o yaml (READ ONLY)")
- Ask for outputs of describe, logs, events, metrics, etc.
- Explain how to interpret the outputs they already have

If the user explicitly asks for mutating commands:
Reply: "I am running in READ-ONLY Kubernetes analysis mode and cannot generate modifying commands."

------------------------------------------------
TOOL USAGE (AUTONOMOUS INVESTIGATION)
You have access to READ-ONLY debugging tools. Use them autonomously to drive investigation.

Available tools:
1. DESCRIBE - Get full YAML manifest
2. EVENTS - Get all events for this resource
3. LOGS [container_name] - Get pod logs (optionally specify container)
   SYNTAX: LOGS calico-node (NO brackets, quotes, or spaces)
4. LOGS_PREVIOUS [container_name] - Get previous pod logs (for crashloops)
   SYNTAX: LOGS_PREVIOUS calico-node (NO brackets, quotes, or spaces)
5. RELATED_PODS - List related pods (same namespace/labels)
6. PARENT_DETAILS - Get parent resource details (owner references)
7. NETWORK_CHECK - Check service/endpoint status
8. RESOURCE_USAGE - Get current resource metrics
9. LIST_RESOURCES <kind> - List resources of type (e.g., configmaps, secrets)
10. DESCRIBE_ANY <kind> <name> - Describe any resource in namespace
11. NODE_INFO - Get node details if pod is scheduled
12. STORAGE_CHECK - Check PVC/PV status for pods

To use a tool: TOOL: <tool_name> [args]
Multiple tools: List each on a new line

**CRITICAL TOOL RULES:**
- ALWAYS use LOGS for Pods before analyzing (shows actual behavior)
- ALWAYS use EVENTS for any resource (shows problems and activity)
- **FOR LOGS/LOGS_PREVIOUS: Check the "Containers:" section in the context FIRST**
  - The context shows available containers for THIS specific pod
  - ONLY use container names that are listed for THIS pod
  - NEVER use container names from other pods (e.g., don't use "calico-node" if it's not in the Containers list)
  - If pod has multiple containers, check logs for each one separately
- Container names must be plain text: NO [], "", or '' characters
- If you see "TOOL SYNTAX ERROR", fix your syntax and retry immediately
- IGNORE tool execution errors - focus only on actual resource data
- Never confuse tool errors with pod/resource problems

------------------------------------------------
AUTONOMOUS INVESTIGATION LOOP

You must behave like an autonomous investigator with this loop:

1. INGEST & SUMMARIZE
   - Read all provided data (YAML, logs, events, metrics, describe outputs).
   - Summarize in 2–3 precise sentences what the current situation appears to be.

2. HYPOTHESIS GENERATION
   - Generate 2–5 ranked hypotheses for what might be wrong.
   - Ground each hypothesis in specific signals:
     - container state
     - events
     - logs
     - resource status
     - scheduling info
     - probe results
   - Never say "it might be anything" — always propose concrete, testable possibilities.

3. EVIDENCE CHECK
   For each hypothesis:
   - Identify which existing evidence supports or contradicts it.
   - Mark hypotheses as STRONG, WEAK, or UNKNOWN based on current data.

4. NEXT DATA REQUEST (AUTONOMOUS)
   - Decide what data you need next to narrow down the root cause.
   - Use TOOL: commands to gather that data autonomously.
   - Be explicit and specific; do NOT be vague.

5. ITERATE
   - When new data arrives, repeat:
     - Update summary
     - Refine or discard hypotheses
     - Adjust evidence
     - Request the next most useful data via tools
   - Continue until a HIGH-confidence root cause is identified or you explicitly say it's ambiguous.

------------------------------------------------
OUTPUT FORMAT (EVERY TURN)

On EVERY response, follow this exact structure:

1. SUMMARY  
2–3 sentences describing the situation in clear, precise terms.

2. CURRENT BEST HYPOTHESES (RANKED)  
List items like:
- [#1 – STRONG] <short title>  
  - Objects: Pod X, Deployment Y, Node Z  
  - Fields: spec.containers[0].image, status.containerStatuses[0].state.waiting.reason  
  - Evidence: quote specific lines from logs/events/YAML  
- [#2 – MEDIUM] ...

3. EVIDENCE SNAPSHOT  
Bullet list of the *most important* signals you are using:
- Events: ...
- Logs: ...
- YAML: ...
- Metrics: ...

4. NEXT INVESTIGATION STEPS
If you need more evidence, use TOOL: commands to gather it.
List each tool on a new line:
TOOL: EVENTS
TOOL: LOGS container-name
TOOL: DESCRIBE

5. MISSING DATA (IF ANY)  
If you still lack key evidence after using available tools, list exactly what is missing and why it matters.

------------------------------------------------
SCOPE OF EXPERTISE

You are extremely strong at:
- Pod lifecycle (Pending, ContainerCreating, Running, CrashLoopBackOff, ImagePullBackOff, OOMKilled)
- Probes (liveness, readiness, startup)
- Networking (Services, Endpoints, DNS, CNI, Ingress, NetworkPolicy)
- Scheduling (taints/tolerations, nodeSelector, affinity, resources, quotas)
- Storage (PVC/PV, access modes, mount failures, permissions)
- Controllers (Deployment, StatefulSet, DaemonSet, Job, CronJob, HPA)
- Multi-resource relationships:
  - Service ↔ Endpoints ↔ Pod labels
  - Deployment ↔ ReplicaSet ↔ Pods
  - HPA ↔ metrics ↔ workload

You must reference explicit fields and objects when reasoning, e.g.:
- "spec.template.spec.containers[0].resources.requests.cpu"
- "status.conditions[?(@.type=='Ready')]"

------------------------------------------------
LLAMA OPTIMIZATION RULES

To perform well as a smaller local model (e.g., Llama 3.1 8B):

- Prefer short, structured bullet lists over long paragraphs.
- Avoid storytelling, metaphors, and chit-chat.
- Use consistent labels ("SUMMARY", "HYPOTHESES", "EVIDENCE", "NEXT STEPS").
- Keep your chain of reasoning shallow but precise and anchored to the inputs.
- Never invent missing fields or values.
- If something is unclear, use tools to gather more data instead of guessing.

------------------------------------------------
FINAL SAFETY RULE

If at any point you are not confident in the root cause, you MUST say:
"I cannot safely determine a single root cause yet."

Then:
- Keep multiple hypotheses open
- Use tools to gather the most powerful next piece of evidence

------------------------------------------------
IMPORTANT:
Do NOT output messages such as:
"Reached maximum analysis depth", "Investigation complete", "Stopping here", or
any other message about halting, depth, or completion.

You do NOT manage your own depth or step count.
You continue responding normally unless the USER says to stop.
There is NO investigation depth limit.
Never self-terminate.

------------------------------------------------

You are now running as an AUTONOMOUS, READ-ONLY Kubernetes Distinguished Engineer
whose job is to DRIVE the investigation, not just answer questions.`,
        conversationHistory: chatHistory.filter(m => m.role !== 'tool'),
      });
      // Mark Ollama connected on successful LLM response
      // Always mark as connected and clear prior detail
      setOllamaStatus({ state: 'connected' });

      // Enhanced tool execution with multiple tool support
      const toolMatches = answer.matchAll(/TOOL:\s*(\w+)(?:\s+(.+?))?(?=\n|$)/g);
      const tools = Array.from(toolMatches);

      // Validate tool names to prevent treating syntax errors as real errors
      const validTools = ['DESCRIBE', 'EVENTS', 'LOGS', 'LOGS_PREVIOUS', 'RELATED_PODS',
        'PARENT_DETAILS', 'NETWORK_CHECK', 'RESOURCE_USAGE', 'LIST_RESOURCES',
        'DESCRIBE_ANY', 'NODE_INFO', 'STORAGE_CHECK'];

      if (tools.length > 0) {
        let allToolResults: string[] = [];

        for (const toolMatch of tools) {
          const toolName = toolMatch[1];
          const toolArgs = toolMatch[2]?.trim();
          let toolResult = '';
          let kubectlCommand = '';

          // Validate tool name
          if (!validTools.includes(toolName)) {
            const errorMsg = `⚠️ **TOOL ERROR**: "${toolName}" is not a valid tool.\n\nValid tools: ${validTools.join(', ')}\n\n**This is an AI tool invocation error, NOT a pod/resource error.**`;
            setChatHistory(prev => [...prev, {
              role: 'tool',
              content: errorMsg,
              toolName: 'INVALID_TOOL',
              command: 'N/A'
            }]);
            allToolResults.push(`## INVALID TOOL: ${toolName}\n${errorMsg}`);
            continue;
          }

          try {
            // Show tool execution with kubectl equivalent
            if (toolName === 'DESCRIBE') {
              kubectlCommand = `kubectl get ${resource.kind.toLowerCase()} ${resource.name} -n ${resource.namespace} -o yaml`;
              const details = await invoke<string>("get_resource_details", {
                req: {
                  group: resource.group,
                  version: resource.version,
                  kind: resource.kind,
                  namespace: resource.namespace !== "-" ? resource.namespace : null
                },
                name: resource.name
              });
              toolResult = `\`\`\`yaml\n${details.slice(0, 3000)}\n${details.length > 3000 ? '... (truncated, use kubectl for full output)' : ''}\`\`\``;
            }
            else if (toolName === 'EVENTS') {
              kubectlCommand = `kubectl get events -n ${resource.namespace} --field-selector involvedObject.name=${resource.name}`;
              const events = await invoke<any[]>("list_events", {
                namespace: resource.namespace,
                name: resource.name,
                uid: resource.id
              });
              const warnings = events.filter(e => e.type_ === 'Warning');
              const normal = events.filter(e => e.type_ !== 'Warning');
              toolResult = `**${events.length} total events (${warnings.length} warnings)**\n\n`;
              if (warnings.length > 0) {
                toolResult += `**⚠️ Warnings:**\n${warnings.slice(0, 15).map(e =>
                  `- \`${new Date(e.age).toLocaleString()}\` **${e.reason}**: ${e.message} ${e.count > 1 ? `**(×${e.count})**` : ''}`
                ).join('\n')}\n\n`;
              }
              if (normal.length > 0) {
                toolResult += `**✓ Normal:**\n${normal.slice(0, 5).map(e =>
                  `- ${e.reason}: ${e.message}`
                ).join('\n')}`;
              }
            }
            else if (toolName === 'LOGS' && resource.kind === 'Pod') {
              // Sanitize container name - remove brackets, quotes, and extra whitespace
              let containerName = toolArgs ? toolArgs.replace(/[\[\]"']/g, '').trim() : null;

              // Validate container name
              if (containerName && (/\s/.test(containerName) || containerName.length === 0)) {
                toolResult = `❌ **TOOL SYNTAX ERROR**: Invalid container name "${toolArgs}"\n\n**Issue:** Container names cannot contain spaces or special characters like [], ", '\n\n**Correct usage:** LOGS container-name\n**Example:** LOGS calico-node\n\n**This is a TOOL SYNTAX ERROR, not a pod error.**`;
              } else {
                kubectlCommand = `kubectl logs ${resource.name} -n ${resource.namespace}${containerName ? ` -c ${containerName}` : ''} --tail=100`;
                try {
                  const logs = await invoke<string>("get_pod_logs", {
                    namespace: resource.namespace,
                    name: resource.name,
                    container: containerName,
                    tailLines: 100
                  });
                  // Sanitize logs - remove any control characters or malformed data
                  // Sanitize logs - remove any control characters or malformed data
                  const sanitizedLogs = logs.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
                  const logLines = sanitizedLogs.split('\n').filter(l => l.trim());
                  const errorLines = logLines.filter(l => /error|exception|fatal|fail/i.test(l));
                  toolResult = `**Pod Logs** (${logLines.length} lines total)${errorLines.length > 0 ? ` - **${errorLines.length} errors found**` : ' - **No errors detected**'}\n\n\`\`\`\n${sanitizedLogs.slice(-2500)}\n\`\`\``;
                } catch (err) {
                  const containerListFormatted = fullObject?.spec?.containers?.map((c: any) => `- ${c.name}`).join('\n') || 'Unknown';

                  // Check if error is about wrong container name
                  const isWrongContainer = err && err.toString().includes('is not valid for pod');

                  if (isWrongContainer) {
                    toolResult = `❌ **WRONG CONTAINER NAME**\n\n**You tried:** "${containerName}"\n**Error:** This container does not exist in THIS pod.\n\n**Available containers in THIS pod (${resource.name}):**\n${containerListFormatted}\n\n**What went wrong:**\nYou used a container name from a DIFFERENT pod. The context at the top shows the containers for THIS specific pod under "Containers:" section.\n\n**How to fix:**\nUse LOGS with one of the actual container names listed above.\nExample: LOGS ${fullObject?.spec?.containers?.[0]?.name || 'manager'}\n\n**This is NOT a pod error - you just used the wrong container name.**`;
                  } else {
                    toolResult = `❌ **Could not retrieve logs:** ${err}\n\n**Possible causes:**\n- Container not yet started\n- Container crashed before logging\n- No container named "${containerName || 'default'}"\n\n**Available containers in this pod:**\n${containerListFormatted}\n\nTry: \`${kubectlCommand}\``;
                  }
                }
              }
            }
            else if (toolName === 'LOGS_PREVIOUS' && resource.kind === 'Pod') {
              // Sanitize container name - remove brackets, quotes, and extra whitespace
              let containerName = toolArgs ? toolArgs.replace(/[\[\]"']/g, '').trim() : null;

              if (containerName && (/\s/.test(containerName) || containerName.length === 0)) {
                toolResult = `❌ **TOOL SYNTAX ERROR**: Invalid container name "${toolArgs}"\n\n**Issue:** Container names cannot contain spaces or special characters like [], ", '\n\n**Correct usage:** LOGS_PREVIOUS container-name\n**Example:** LOGS_PREVIOUS calico-node\n\n**This is a TOOL SYNTAX ERROR, not a pod error.**`;
              } else {
                kubectlCommand = `kubectl logs ${resource.name} -n ${resource.namespace}${containerName ? ` -c ${containerName}` : ''} --previous --tail=100`;
                toolResult = `**Previous logs:** Use \`${kubectlCommand}\` to check crashed container logs`;
              }
            }
            else if (toolName === 'RELATED_PODS') {
              kubectlCommand = `kubectl get pods -n ${resource.namespace}`;
              const pods = await invoke<any[]>("list_resources", {
                req: { group: "", version: "v1", kind: "Pod", namespace: resource.namespace }
              });
              const failed = pods.filter(p => p.status.includes('Error') || p.status.includes('CrashLoop'));
              toolResult = `**${pods.length} pods** ${failed.length > 0 ? `**(${failed.length} failing)**` : '**all healthy**'}\n\n${pods.slice(0, 40).map(p => {
                const icon = p.status.includes('Running') && !p.status.includes('0/') ? '✓' : p.status.includes('Error') || p.status.includes('CrashLoop') ? '❌' : '⚠️';
                return `${icon} \`${p.name}\`: ${p.status}`;
              }).join('\n')}`;
            }
            else if (toolName === 'PARENT_DETAILS') {
              const owner = fullObject?.metadata?.ownerReferences?.[0];
              if (owner) {
                kubectlCommand = `kubectl get ${owner.kind.toLowerCase()} ${owner.name} -n ${resource.namespace} -o yaml`;
                const parentDetails = await invoke<string>("get_resource_details", {
                  req: {
                    group: owner.apiVersion.split('/')[0] || '',
                    version: owner.apiVersion.split('/')[1] || owner.apiVersion,
                    kind: owner.kind,
                    namespace: resource.namespace
                  },
                  name: owner.name
                });
                toolResult = `**Parent: ${owner.kind}/${owner.name}**\n\`\`\`yaml\n${parentDetails.slice(0, 1500)}\n...\`\`\``;
              } else {
                toolResult = `No parent resource (standalone ${resource.kind})`;
              }
            }
            else if (toolName === 'NETWORK_CHECK') {
              kubectlCommand = `kubectl get svc,endpoints -n ${resource.namespace}`;
              if (resource.kind === 'Service') {
                const endpoints = await invoke<any[]>("list_resources", {
                  req: { group: "", version: "v1", kind: "Endpoints", namespace: resource.namespace }
                });
                const matchingEp = endpoints.find(ep => ep.name === resource.name);
                toolResult = `**Service:** ${fullObject?.spec?.type}, ClusterIP: ${fullObject?.spec?.clusterIP}\n**Endpoints:** ${matchingEp ? '✓ Found' : '❌ Missing (no pods match selector)'}`;
              } else if (resource.kind === 'Pod') {
                const services = await invoke<any[]>("list_resources", {
                  req: { group: "", version: "v1", kind: "Service", namespace: resource.namespace }
                });
                toolResult = `**${services.length} services** in namespace\n${services.slice(0, 10).map(s => `- ${s.name}: ${s.status}`).join('\n')}`;
              }
            }
            else if (toolName === 'RESOURCE_USAGE') {
              kubectlCommand = `kubectl top ${resource.kind.toLowerCase()} ${resource.name} -n ${resource.namespace}`;
              if (resource.kind === 'Pod' || resource.kind === 'Node') {
                const metrics = await invoke<any>("get_resource_metrics", {
                  resourceKind: resource.kind, namespace: resource.namespace, name: resource.name
                });
                toolResult = `**Current usage:**\n${metrics.map((m: any) =>
                  `- CPU: **${m.cpu}** ${m.cpu_percent ? `(${m.cpu_percent}% of limit)` : ''}\n- Memory: **${m.memory}** ${m.memory_percent ? `(${m.memory_percent}% of limit)` : ''}`
                ).join('\n')}`;
              }
            }
            else if (toolName === 'LIST_RESOURCES') {
              const kind = toolArgs || 'ConfigMap';
              // Validate kind name - catch common mistakes
              if (!kind || kind.includes(' ') || kind.includes('\n')) {
                toolResult = `❌ **Invalid syntax.** Use: LIST_RESOURCES <kind>\n\nExample: LIST_RESOURCES configmaps\n\n**This is a TOOL SYNTAX ERROR, not a resource error.**`;
              } else {
                kubectlCommand = `kubectl get ${kind.toLowerCase()} -n ${resource.namespace}`;
                try {
                  // Try with core API first
                  let resources = await invoke<any[]>("list_resources", {
                    req: { group: "", version: "v1", kind, namespace: resource.namespace }
                  }).catch(async () => {
                    // If core API fails, try to discover the resource from the current namespace
                    // This handles custom resources better
                    const allResources = await invoke<any[]>("list_resources", {
                      req: { group: resource.group, version: resource.version, kind, namespace: resource.namespace }
                    });
                    return allResources;
                  });
                  toolResult = `**${resources.length} ${kind}(s)**\n${resources.slice(0, 20).map(r => `- ${r.name}`).join('\n')}`;
                } catch (err) {
                  toolResult = `❌ **Error listing ${kind}:** ${err}\n\nThis could mean:\n- Resource type doesn't exist\n- Wrong API group/version\n- No resources of this type found\n\nTry using kubectl directly: \`${kubectlCommand}\``;
                }
              }
            }
            else if (toolName === 'DESCRIBE_ANY') {
              if (!toolArgs || !toolArgs.trim()) {
                toolResult = `❌ **Invalid syntax.** Use: DESCRIBE_ANY <kind> <name>\n\nExample: DESCRIBE_ANY configmap my-config\n\n**This is a TOOL SYNTAX ERROR, not a resource error.**`;
              } else {
                const parts = toolArgs.trim().split(/\s+/);
                if (parts.length !== 2) {
                  toolResult = `❌ **Invalid syntax.** Expected 2 arguments (kind and name), got ${parts.length}\n\nUse: DESCRIBE_ANY <kind> <name>\nExample: DESCRIBE_ANY configmap my-config\n\n**This is a TOOL SYNTAX ERROR, not a resource error.**`;
                } else {
                  const [kind, name] = parts;
                  kubectlCommand = `kubectl get ${kind.toLowerCase()} ${name} -n ${resource.namespace} -o yaml`;
                  try {
                    // Try core API first, then fallback to current resource's API group
                    const details = await invoke<string>("get_resource_details", {
                      req: { group: "", version: "v1", kind, namespace: resource.namespace },
                      name
                    }).catch(async () => {
                      // Fallback: try with the parent resource's group/version
                      return await invoke<string>("get_resource_details", {
                        req: { group: resource.group, version: resource.version, kind, namespace: resource.namespace },
                        name
                      });
                    });
                    toolResult = `**${kind}/${name}:**\n\`\`\`yaml\n${details.slice(0, 2000)}\n...\`\`\``;
                  } catch (err) {
                    toolResult = `❌ **Resource not found or inaccessible:** ${kind}/${name}\n\n**Error:** ${err}\n\n**Possible causes:**\n- Resource does not exist in namespace "${resource.namespace}"\n- Wrong resource kind name (check capitalization)\n- Insufficient permissions\n\n**This is a RESOURCE ERROR, not a tool syntax error.**\n\nTry manually: \`${kubectlCommand}\``;
                  }
                }
              }
            }
            else if (toolName === 'NODE_INFO' && resource.kind === 'Pod') {
              const nodeName = fullObject?.spec?.nodeName;
              if (nodeName) {
                kubectlCommand = `kubectl get node ${nodeName} -o yaml`;
                const nodeDetails = await invoke<string>("get_resource_details", {
                  req: { group: "", version: "v1", kind: "Node", namespace: null },
                  name: nodeName
                });
                toolResult = `**Scheduled on node:** ${nodeName}\n\`\`\`yaml\n${nodeDetails.slice(0, 1500)}\n...\`\`\``;
              } else {
                toolResult = `Pod not yet scheduled to a node`;
              }
            }
            else if (toolName === 'STORAGE_CHECK' && resource.kind === 'Pod') {
              kubectlCommand = `kubectl get pvc -n ${resource.namespace}`;
              const pvcs = await invoke<any[]>("list_resources", {
                req: { group: "", version: "v1", kind: "PersistentVolumeClaim", namespace: resource.namespace }
              });
              toolResult = `**${pvcs.length} PVCs** in namespace\n${pvcs.slice(0, 10).map(p => `- ${p.name}: ${p.status}`).join('\n')}`;
            }

            // Add tool execution to chat with kubectl command
            setChatHistory(prev => [...prev, {
              role: 'tool',
              content: toolResult,
              toolName: toolName,
              command: kubectlCommand
            }]);

            allToolResults.push(`## ${toolName}${toolArgs ? ` ${toolArgs}` : ''}\n${toolResult}`);
          } catch (toolErr) {
            const errorMsg = `⚠️ **TOOL EXECUTION ERROR (not a resource error)**\n\n**Tool:** ${toolName}\n**Error:** ${toolErr}\n\n**Note:** This error occurred while trying to execute the debugging tool, not from the Kubernetes resource itself.\n\nTry the kubectl command manually: \`${kubectlCommand || 'N/A'}\``;
            setChatHistory(prev => [...prev, {
              role: 'tool',
              content: errorMsg,
              toolName: toolName,
              command: kubectlCommand
            }]);
            allToolResults.push(`## ${toolName} - Tool Execution Error\n${errorMsg}`);
          }
        }

        // Iterative investigation loop - AI analyzes and decides if more investigation needed
        let combinedResults = allToolResults.join('\n\n---\n\n');
        let iterationCount = 0;
        const maxIterations = 3; // Prevent infinite loops

        while (iterationCount < maxIterations) {
          const analysisPrompt = iterationCount === 0
            ? `Based on these tool results, provide analysis for: "${message}"\n\n${combinedResults}`
            : `Continue investigation with these new results:\n\n${combinedResults}`;

          const analysisAnswer = await invoke<string>("call_local_llm_with_tools", {
            prompt: analysisPrompt,
            systemPrompt: `SYSTEM IDENTITY
You are a Distinguished Engineer and Principal SRE for Kubernetes and cloud-native systems.
You operate as an AUTONOMOUS, READ-ONLY INCIDENT INVESTIGATOR.

You are analyzing tool output data to refine your investigation and determine next steps.

**CRITICAL RULES:**
1. Base analysis ONLY on actual tool output data (logs, events, metrics, YAML)
2. NEVER make assumptions from YAML alone without runtime evidence
3. If logs not checked for a Pod, state: "MISSING EVIDENCE: Pod logs not retrieved"
4. If events not checked, state: "MISSING EVIDENCE: Events not retrieved"
5. **IGNORE tool execution errors** - messages marked "TOOL ERROR", "INVALID TOOL", or "TOOL SYNTAX ERROR" are debugging system issues, NOT resource problems
6. Focus ONLY on successful tool executions containing actual Kubernetes data

**SELF-CORRECTION FOR SYNTAX ERRORS:**
If you see "TOOL SYNTAX ERROR":
- You made a syntax mistake (e.g., LOGS [container] instead of LOGS container)
- Fix syntax and retry immediately using correct format
- Do NOT report syntax errors as resource problems
- Common fixes:
  - Remove brackets: LOGS [calico-node] → LOGS calico-node
  - Remove quotes: LOGS "app" → LOGS app
  - Remove spaces in resource names: LIST_RESOURCES config maps → LIST_RESOURCES configmaps

**CRITICAL: Container Name Errors**
If you see "container X is not valid for pod Y":
- You used a container name from the WRONG pod
- Check the original context's "Containers:" section for THIS pod's actual containers
- ONLY use container names listed for THIS specific pod
- Example: If context shows "Containers: manager, kube-rbac-proxy", ONLY use those names
- NEVER use "calico-node", "install-cni", etc. unless they're listed for THIS pod

**OUTPUT FORMAT (MANDATORY)**

1. SUMMARY
2–3 sentences describing the situation in clear, precise terms based on evidence.

2. CURRENT BEST HYPOTHESES (RANKED)
List items like:
- [#1 – STRONG] <short title>
  - Objects: Pod X, Deployment Y, Node Z
  - Fields: spec.containers[0].image, status.containerStatuses[0].state.waiting.reason
  - Evidence: quote specific lines from logs/events/YAML
- [#2 – MEDIUM] ...
- [#3 – WEAK] ...

3. EVIDENCE SNAPSHOT
Bullet list of the *most important* signals from tool outputs:
- Events: [quote actual event messages with timestamps]
- Logs: [quote actual log lines showing errors/behavior]
- YAML: [reference specific fields like spec.containers[0].resources.limits.memory]
- Metrics: [cite actual CPU/memory values if available]

4. NEXT INVESTIGATION STEPS
If you need more evidence to narrow down the root cause, use TOOL: commands.
List each tool on a new line with correct syntax:
TOOL: EVENTS
TOOL: LOGS container-name
TOOL: DESCRIBE

If you have sufficient evidence, provide final analysis instead.

5. MISSING DATA (IF ANY)
If tool data is insufficient even after using all relevant tools, explicitly state:
- What data is still missing
- Why it's critical for diagnosis
- Whether it's obtainable via tools or requires external access

**BEHAVIOR RULES:**
- Concise: short paragraphs, no filler
- Evidence-based: cite specific fields, log lines, event messages
- Deterministic: no speculation or hallucination
- Linear reasoning: avoid abstract metaphors
- Default to uncertainty when evidence is missing
- Reference exact fields: spec.containers[0].imagePullPolicy
- Align with K8s mechanics: pod lifecycle, probes, scheduling, CrashLoopBackOff, QoS, taints/tolerations

**AUTONOMOUS INVESTIGATION:**
- You drive the debugging process
- Form hypotheses and test them with tools
- Refine or discard hypotheses as new data arrives
- Continue requesting evidence until HIGH confidence or ambiguity is acknowledged

**FINAL RULE:**
If you cannot safely determine a single root cause yet, state:
"I cannot safely determine a single root cause yet."

Then keep multiple hypotheses open and use tools to gather the most powerful next piece of evidence.

Never generate mutative operations (apply, patch, delete, restart, scale).
If requested, respond: "I cannot generate mutative operations. I operate in READ-ONLY Kubernetes DE mode."

**IMPORTANT:**
Do NOT output messages such as:
"Reached maximum analysis depth", "Investigation complete", "Stopping here", or
any other message about halting, depth, or completion.

You do NOT manage your own depth or step count.
You continue responding normally unless the USER says to stop.
There is NO investigation depth limit.
Never self-terminate.`,
            conversationHistory: chatHistory.filter(m => m.role !== 'tool'),
          });
          // Mark Ollama connected on successful follow-up LLM response
          // Always mark as connected and clear prior detail
          setOllamaStatus({ state: 'connected' });

          // Check if AI wants to use more tools
          const nextToolMatches = analysisAnswer.matchAll(/TOOL:\s*(\w+)(?:\s+(.+?))?(?=\n|$)/g);
          const nextTools = Array.from(nextToolMatches);

          if (nextTools.length === 0) {
            // No more tools requested - final answer
            setChatHistory(prev => [...prev, { role: 'assistant', content: analysisAnswer }]);
            break;
          }

          // AI wants to investigate more - show reasoning
          const reasoningPart = analysisAnswer.split('TOOL:')[0].trim();
          if (reasoningPart) {
            setChatHistory(prev => [...prev, {
              role: 'assistant',
              content: reasoningPart + '\n\n*🔄 Continuing investigation...*'
            }]);
          }

          // Execute next round of tools
          const newToolResults: string[] = [];
          for (const toolMatch of nextTools) {
            const toolName = toolMatch[1];
            const toolArgs = toolMatch[2]?.trim();
            let toolResult = '';
            let kubectlCommand = '';

            // Validate tool name in iteration
            if (!validTools.includes(toolName)) {
              const errorMsg = `⚠️ **TOOL ERROR**: "${toolName}" is not a valid tool.\n\nValid tools: ${validTools.join(', ')}\n\n**This is an AI tool invocation error, NOT a pod/resource error.**`;
              setChatHistory(prev => [...prev, {
                role: 'tool',
                content: errorMsg,
                toolName: 'INVALID_TOOL',
                command: 'N/A'
              }]);
              newToolResults.push(`## INVALID TOOL: ${toolName}\n${errorMsg}`);
              continue;
            }

            try {
              // Execute all available tools in iteration
              if (toolName === 'DESCRIBE') {
                kubectlCommand = `kubectl get ${resource.kind.toLowerCase()} ${resource.name} -n ${resource.namespace} -o yaml`;
                const details = await invoke<string>("get_resource_details", {
                  req: { group: resource.group, version: resource.version, kind: resource.kind, namespace: resource.namespace !== "-" ? resource.namespace : null },
                  name: resource.name
                });
                toolResult = `\`\`\`yaml\n${details.slice(0, 3000)}\n${details.length > 3000 ? '... (truncated, use kubectl for full output)' : ''}\`\`\``;
              }
              else if (toolName === 'EVENTS') {
                kubectlCommand = `kubectl get events -n ${resource.namespace} --field-selector involvedObject.name=${resource.name}`;
                const events = await invoke<any[]>("list_events", { namespace: resource.namespace, name: resource.name, uid: resource.id });
                const warnings = events.filter(e => e.type_ === 'Warning');
                const normal = events.filter(e => e.type_ !== 'Warning');
                toolResult = `**${events.length} total events (${warnings.length} warnings)**\n\n`;
                if (warnings.length > 0) {
                  toolResult += `**⚠️ Warnings:**\n${warnings.slice(0, 15).map(e =>
                    `- \`${new Date(e.age).toLocaleString()}\` **${e.reason}**: ${e.message} ${e.count > 1 ? `**(×${e.count})**` : ''}`
                  ).join('\n')}\n\n`;
                }
                if (normal.length > 0) {
                  toolResult += `**✓ Normal:**\n${normal.slice(0, 5).map(e => `- ${e.reason}: ${e.message}`).join('\n')}`;
                }
              }
              else if (toolName === 'LOGS' && resource.kind === 'Pod') {
                // Sanitize container name - remove brackets, quotes, and extra whitespace
                let containerName = toolArgs ? toolArgs.replace(/[\[\]"']/g, '').trim() : null;

                if (containerName && (/\s/.test(containerName) || containerName.length === 0)) {
                  toolResult = `❌ **TOOL SYNTAX ERROR**: Invalid container name "${toolArgs}"\n\n**Issue:** Container names cannot contain spaces or special characters like [], ", '\n\n**Correct usage:** LOGS container-name\n**Example:** LOGS calico-node\n\n**This is a TOOL SYNTAX ERROR, not a pod error.**`;
                } else {
                  kubectlCommand = `kubectl logs ${resource.name} -n ${resource.namespace}${containerName ? ` -c ${containerName}` : ''} --tail=100`;
                  try {
                    const logs = await invoke<string>("get_pod_logs", { namespace: resource.namespace, name: resource.name, container: containerName, tailLines: 100 });
                    const sanitizedLogs = logs.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
                    const logLines = sanitizedLogs.split('\n').filter(l => l.trim());
                    const errorLines = logLines.filter(l => /error|exception|fatal|fail/i.test(l));
                    toolResult = `**Pod Logs** (${logLines.length} lines total)${errorLines.length > 0 ? ` - **${errorLines.length} errors found**` : ' - **No errors detected**'}\n\n\`\`\`\n${sanitizedLogs.slice(-2500)}\n\`\`\``;
                  } catch (err) {
                    const containerListFormatted = fullObject?.spec?.containers?.map((c: any) => `- ${c.name}`).join('\n') || 'Unknown';
                    const isWrongContainer = err && err.toString().includes('is not valid for pod');

                    if (isWrongContainer) {
                      toolResult = `❌ **WRONG CONTAINER NAME**\n\n**You tried:** "${containerName}"\n**Error:** This container does not exist in THIS pod.\n\n**Available containers in THIS pod (${resource.name}):**\n${containerListFormatted}\n\n**What went wrong:**\nYou used a container name from a DIFFERENT pod. The context at the top shows the containers for THIS specific pod under "Containers:" section.\n\n**How to fix:**\nUse LOGS with one of the actual container names listed above.\nExample: LOGS ${fullObject?.spec?.containers?.[0]?.name || 'manager'}\n\n**This is NOT a pod error - you just used the wrong container name.**`;
                    } else {
                      toolResult = `❌ **Could not retrieve logs:** ${err}\n\n**Available containers in this pod:**\n${containerListFormatted}\n\nTry: \`${kubectlCommand}\``;
                    }
                  }
                }
              }
              else if (toolName === 'LOGS_PREVIOUS' && resource.kind === 'Pod') {
                // Sanitize container name - remove brackets, quotes, and extra whitespace
                let containerName = toolArgs ? toolArgs.replace(/[\[\]"']/g, '').trim() : null;

                if (containerName && (/\s/.test(containerName) || containerName.length === 0)) {
                  toolResult = `❌ **TOOL SYNTAX ERROR**: Invalid container name "${toolArgs}"\n\n**Issue:** Container names cannot contain spaces or special characters like [], ", '\n\n**Correct usage:** LOGS_PREVIOUS container-name\n**Example:** LOGS_PREVIOUS calico-node\n\n**This is a TOOL SYNTAX ERROR, not a pod error.**`;
                } else {
                  kubectlCommand = `kubectl logs ${resource.name} -n ${resource.namespace}${containerName ? ` -c ${containerName}` : ''} --previous --tail=100`;
                  toolResult = `**Previous logs:** Use \`${kubectlCommand}\` to check crashed container logs`;
                }
              }
              else if (toolName === 'RELATED_PODS') {
                kubectlCommand = `kubectl get pods -n ${resource.namespace}`;
                try {
                  const pods = await invoke<any[]>("list_resources", { req: { group: "", version: "v1", kind: "Pod", namespace: resource.namespace } });
                  const failed = pods.filter(p => p.status.includes('Error') || p.status.includes('CrashLoop'));
                  toolResult = `**${pods.length} pods** ${failed.length > 0 ? `**(${failed.length} failing)**` : '**all healthy**'}\n\n${pods.slice(0, 40).map(p => {
                    const icon = p.status.includes('Running') && !p.status.includes('0/') ? '✓' : p.status.includes('Error') || p.status.includes('CrashLoop') ? '❌' : '⚠️';
                    return `${icon} \`${p.name}\`: ${p.status}`;
                  }).join('\n')}`;
                } catch (err) {
                  toolResult = `❌ **Error listing pods:** ${err}`;
                }
              }
              else if (toolName === 'PARENT_DETAILS') {
                const owner = fullObject?.metadata?.ownerReferences?.[0];
                if (owner) {
                  kubectlCommand = `kubectl get ${owner.kind.toLowerCase()} ${owner.name} -n ${resource.namespace} -o yaml`;
                  const parentDetails = await invoke<string>("get_resource_details", {
                    req: { group: owner.apiVersion.split('/')[0] || '', version: owner.apiVersion.split('/')[1] || owner.apiVersion, kind: owner.kind, namespace: resource.namespace },
                    name: owner.name
                  });
                  toolResult = `**Parent: ${owner.kind}/${owner.name}**\n\`\`\`yaml\n${parentDetails.slice(0, 1500)}\n...\`\`\``;
                } else {
                  toolResult = `No parent resource (standalone ${resource.kind})`;
                }
              }
              else if (toolName === 'NETWORK_CHECK') {
                kubectlCommand = `kubectl get svc,endpoints -n ${resource.namespace}`;
                if (resource.kind === 'Service') {
                  const endpoints = await invoke<any[]>("list_resources", { req: { group: "", version: "v1", kind: "Endpoints", namespace: resource.namespace } });
                  const matchingEp = endpoints.find(ep => ep.name === resource.name);
                  toolResult = `**Service:** ${fullObject?.spec?.type}, ClusterIP: ${fullObject?.spec?.clusterIP}\n**Endpoints:** ${matchingEp ? '✓ Found' : '❌ Missing (no pods match selector)'}`;
                } else if (resource.kind === 'Pod') {
                  const services = await invoke<any[]>("list_resources", { req: { group: "", version: "v1", kind: "Service", namespace: resource.namespace } });
                  toolResult = `**${services.length} services** in namespace\n${services.slice(0, 10).map(s => `- ${s.name}: ${s.status}`).join('\n')}`;
                }
              }
              else if (toolName === 'RESOURCE_USAGE') {
                kubectlCommand = `kubectl top ${resource.kind.toLowerCase()} ${resource.name} -n ${resource.namespace}`;
                if (resource.kind === 'Pod' || resource.kind === 'Node') {
                  const metrics = await invoke<any>("get_resource_metrics", { resourceKind: resource.kind, namespace: resource.namespace, name: resource.name });
                  toolResult = `**Current usage:**\n${metrics.map((m: any) => `- CPU: **${m.cpu}** ${m.cpu_percent ? `(${m.cpu_percent}% of limit)` : ''}\n- Memory: **${m.memory}** ${m.memory_percent ? `(${m.memory_percent}% of limit)` : ''}`).join('\n')}`;
                }
              }
              else if (toolName === 'LIST_RESOURCES') {
                const kind = toolArgs || 'ConfigMap';
                kubectlCommand = `kubectl get ${kind.toLowerCase()} -n ${resource.namespace}`;
                try {
                  let resources = await invoke<any[]>("list_resources", {
                    req: { group: "", version: "v1", kind, namespace: resource.namespace }
                  }).catch(async () => {
                    return await invoke<any[]>("list_resources", {
                      req: { group: resource.group, version: resource.version, kind, namespace: resource.namespace }
                    });
                  });
                  toolResult = `**${resources.length} ${kind}(s)**\n${resources.slice(0, 20).map(r => `- ${r.name}`).join('\n')}`;
                } catch (err) {
                  toolResult = `❌ **Error listing ${kind}:** ${err}\n\nTry using kubectl directly: \`${kubectlCommand}\``;
                }
              }
              else if (toolName === 'DESCRIBE_ANY') {
                const [kind, name] = (toolArgs || '').split(' ');
                if (kind && name) {
                  kubectlCommand = `kubectl get ${kind.toLowerCase()} ${name} -n ${resource.namespace} -o yaml`;
                  try {
                    const details = await invoke<string>("get_resource_details", {
                      req: { group: "", version: "v1", kind, namespace: resource.namespace },
                      name
                    }).catch(async () => {
                      return await invoke<string>("get_resource_details", {
                        req: { group: resource.group, version: resource.version, kind, namespace: resource.namespace },
                        name
                      });
                    });
                    toolResult = `**${kind}/${name}:**\n\`\`\`yaml\n${details.slice(0, 2000)}\n...\`\`\``;
                  } catch (err) {
                    toolResult = `❌ **Error describing ${kind}/${name}:** ${err}\n\n**Possible issues:**\n- Resource does not exist\n- Wrong resource kind name\n- Insufficient permissions\n\nTry: \`${kubectlCommand}\``;
                  }
                } else {
                  toolResult = `❌ **Invalid syntax.** Use: DESCRIBE_ANY <kind> <name>\n\nExample: DESCRIBE_ANY configmap my-config`;
                }
              }
              else if (toolName === 'NODE_INFO' && resource.kind === 'Pod') {
                const nodeName = fullObject?.spec?.nodeName;
                if (nodeName) {
                  kubectlCommand = `kubectl get node ${nodeName} -o yaml`;
                  const nodeDetails = await invoke<string>("get_resource_details", { req: { group: "", version: "v1", kind: "Node", namespace: null }, name: nodeName });
                  toolResult = `**Scheduled on node:** ${nodeName}\n\`\`\`yaml\n${nodeDetails.slice(0, 1500)}\n...\`\`\``;
                } else {
                  toolResult = `Pod not yet scheduled to a node`;
                }
              }
              else if (toolName === 'STORAGE_CHECK' && resource.kind === 'Pod') {
                kubectlCommand = `kubectl get pvc -n ${resource.namespace}`;
                const pvcs = await invoke<any[]>("list_resources", { req: { group: "", version: "v1", kind: "PersistentVolumeClaim", namespace: resource.namespace } });
                toolResult = `**${pvcs.length} PVCs** in namespace\n${pvcs.slice(0, 10).map(p => `- ${p.name}: ${p.status}`).join('\n')}`;
              }
              else {
                toolResult = `Tool ${toolName} not available in iteration mode`;
              }

              setChatHistory(prev => [...prev, {
                role: 'tool',
                content: toolResult,
                toolName: toolName,
                command: kubectlCommand
              }]);

              newToolResults.push(`## ${toolName}${toolArgs ? ` ${toolArgs}` : ''}\n${toolResult}`);
            } catch (toolErr) {
              const errorMsg = `⚠️ **TOOL EXECUTION ERROR (not a resource error)**\n\n**Tool:** ${toolName}\n**Error:** ${toolErr}\n\n**Note:** This error occurred while trying to execute the debugging tool, not from the Kubernetes resource itself.\n\nTry the kubectl command manually: \`${kubectlCommand || 'N/A'}\``;
              setChatHistory(prev => [...prev, { role: 'tool', content: errorMsg, toolName: toolName, command: kubectlCommand }]);
              newToolResults.push(`## ${toolName} - Tool Execution Error\n${errorMsg}`);
            }
          }

          combinedResults = newToolResults.join('\n\n---\n\n');
          iterationCount++;
        }

        // Don't add any "investigation complete" messages - let AI continue naturally
      } else {
        setChatHistory(prev => [...prev, { role: 'assistant', content: answer }]);
      }
    } catch (err) {
      const msg = (err as any)?.toString?.() || String(err);
      const isOllamaNotRunning = /ECONNREFUSED|connection refused|connect ECONNREFUSED|Failed to connect|fetch failed|NetworkError/i.test(msg);
      const isModelMissing = /model not found|no model|unknown model|could not find model|pull the model/i.test(msg);
      if (isOllamaNotRunning) {
        setOllamaStatus({ state: 'unreachable', detail: msg });
        const helpful = `⚠️ Ollama is not running or unreachable.

What this means: The local LLM server couldn’t be reached to process your request.

How to fix (READ ONLY guidance):
- Start Ollama and ensure the service is running locally.
- Verify the model is installed and available.

You can start Ollama and then retry your request.`;
        setChatHistory(prev => [...prev, { role: 'assistant', content: helpful }]);
      } else if (isModelMissing) {
        setOllamaStatus({ state: 'model-missing', detail: msg });
        const helpful = `⚠️ No model found in Ollama.

What this means: The requested model isn’t installed or available.

How to fix (READ ONLY guidance):
- Ensure the configured model exists locally (e.g., llama3.1:8b).
- Pull or select an available model in your Ollama setup.

After the model is available, retry your request.`;
        setChatHistory(prev => [...prev, { role: 'assistant', content: helpful }]);
      } else {
        setChatHistory(prev => [...prev, { role: 'assistant', content: `Error: ${msg}` }]);
      }
    } finally {
      setLlmLoading(false);
    }
  };

  const quickAnalysis = async () => {
    await sendMessage("Analyze this resource and explain its current status, any potential issues, and recommendations.");
  };

  // Events summary (warnings vs total) - lightweight query
  const { data: eventsSummary } = useQuery({
    queryKey: ["overview_events", currentContext, resource.namespace, resource.kind, resource.name],
    queryFn: async () => {
      try {
        const evs = await invoke<any[]>("list_events", { namespace: resource.namespace, name: resource.name, uid: resource.id });
        const warnings = evs.filter(e => e.type_ === 'Warning').length;
        return { total: evs.length, warnings, recent: evs.slice(0, 5) };
      } catch { return { total: 0, warnings: 0, recent: [] }; }
    },
    staleTime: 10000,
  });

  const showMetrics = resource.kind === "Pod" || resource.kind === "Node";

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loading size={24} label="Loading" /></div>;
  }
  if (error) {
    return <div className="text-red-400 text-xs bg-red-500/10 p-4 rounded border border-red-500/30">Failed to load resource details: {error.message}</div>;
  }

  return (
    <div className="space-y-4">
      {/* AI Chat Button */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setShowChat(!showChat)}
          className="px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-700 text-white text-xs flex items-center gap-2 shadow-sm"
        >
          {showChat ? '✕ Close AI Chat' : '🤖 AI Chat'}
        </button>
        {!showChat && chatHistory.length > 0 && (
          <span className="text-xs text-[#858585]">{chatHistory.filter(m => m.role === 'assistant').length} messages</span>
        )}
      </div>

      {/* AI Chat Panel */}
      {showChat && (
        <div className="bg-[#252526] border border-purple-500/30 rounded overflow-hidden flex flex-col h-[500px]">
          <div className="flex items-center justify-between px-4 py-2 bg-[#1e1e1e] border-b border-purple-500/30 flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-purple-400 text-xs font-semibold">🤖 AI Assistant</span>
              {/* Ollama Status Badge */}
              <button
                type="button"
                onClick={() => setShowOllamaHelp(v => !v)}
                className={`text-[10px] px-2 py-0.5 rounded border ${ollamaStatus.state === 'connected'
                  ? 'bg-green-100 text-green-700 border-green-300'
                  : ollamaStatus.state === 'model-missing'
                    ? 'bg-yellow-100 text-yellow-700 border-yellow-300'
                    : ollamaStatus.state === 'unreachable'
                      ? 'bg-red-100 text-red-700 border-red-300'
                      : 'bg-gray-100 text-gray-700 border-gray-300'
                  }`}
                title="Ollama status"
              >
                {ollamaStatus.state === 'connected' && 'Ollama: Connected'}
                {ollamaStatus.state === 'model-missing' && 'Ollama: Model Missing'}
                {ollamaStatus.state === 'unreachable' && 'Ollama: Unreachable'}
                {ollamaStatus.state === 'unknown' && 'Ollama: Unknown'}
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={quickAnalysis}
                disabled={llmLoading}
                className="text-xs text-purple-400 hover:text-purple-300 disabled:text-purple-600"
              >
                Quick Analysis
              </button>
              <button
                onClick={() => setChatHistory([])}
                className="text-xs text-[#858585] hover:text-white"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Ollama Help Drawer */}
          {showOllamaHelp && (
            <div className="px-4 py-2 bg-[#111] border-b border-purple-500/20 text-[11px] text-[#cccccc]">
              <div className="font-semibold mb-1">Ollama Setup (macOS)</div>
              <div className="mb-1">Install/start and pull a model:</div>
              <pre className="bg-[#0d1117] border border-[#3e3e42] rounded p-2 overflow-auto text-[10px] text-[#cccccc]">
                brew install ollama
                ollama serve
                ollama pull llama3.1:8b
              </pre>
              <div className="mt-2">Alternative installer:</div>
              <pre className="bg-[#0d1117] border border-[#3e3e42] rounded p-2 overflow-auto text-[10px] text-[#cccccc]">
                curl -fsSL https://ollama.com/install.sh | sh
              </pre>
              <div className="mt-2">Verify installation and models:</div>
              <pre className="bg-[#0d1117] border border-[#3e3e42] rounded p-2 overflow-auto text-[10px] text-[#cccccc]">
                ollama list
                ollama run llama3.1:8b
              </pre>
              <div className="mt-2 text-[#858585]">Status: {ollamaStatus.state} {ollamaStatus.detail ? `– ${ollamaStatus.detail}` : ''}</div>
            </div>
          )}

          {/* Chat Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
            {chatHistory.length === 0 && (
              <div className="text-center text-[#858585] text-xs py-8">
                <div className="text-2xl mb-2">🤖</div>
                <div className="font-semibold mb-1">AI Kubernetes Debugging Assistant</div>
                Ask me anything about this {resource.kind}!<br />
                <div className="text-[10px] mt-2 space-y-1">
                  <div>💡 "Why is this pod failing?"</div>
                  <div>💡 "Check the logs for errors"</div>
                  <div>💡 "Compare with other pods in this namespace"</div>
                </div>
              </div>
            )}
            {chatHistory.map((msg, i) => (
              <div key={i}>
                {msg.role === 'user' && (
                  <div className="flex justify-end">
                    <div className="max-w-[80%] rounded px-3 py-2 text-xs bg-purple-600 text-white">
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    </div>
                  </div>
                )}

                {msg.role === 'tool' && (
                  <div className="flex justify-start">
                    <div className="max-w-[90%] rounded border border-cyan-500/30 bg-[#1e1e1e] overflow-hidden">
                      {/* Tool header */}
                      <div className="bg-cyan-900/20 px-3 py-1.5 border-b border-cyan-500/30 flex items-center gap-2">
                        <span className="text-cyan-400 text-[10px] font-mono font-semibold">🔧 {msg.toolName}</span>
                      </div>
                      {/* Kubectl command */}
                      {msg.command && (
                        <div className="bg-[#0d1117] px-3 py-1.5 border-b border-cyan-500/20">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[#858585] text-[9px] uppercase tracking-wider">kubectl equivalent</span>
                          </div>
                          <code className="text-[10px] text-cyan-300 font-mono select-all">{msg.command}</code>
                        </div>
                      )}
                      {/* Tool result */}
                      <div className="px-3 py-2 text-[11px] text-[#cccccc] leading-relaxed prose prose-invert prose-sm max-w-none">
                        <ReactMarkdown
                          components={{
                            h2: ({ children }) => <h2 className="text-xs text-white font-bold mb-1 mt-2 first:mt-0">{children}</h2>,
                            h3: ({ children }) => <h3 className="text-[11px] text-white font-semibold mb-1 mt-1.5">{children}</h3>,
                            p: ({ children }) => <p className="my-1 text-[10px] text-[#cccccc]">{children}</p>,
                            ul: ({ children }) => <ul className="list-disc ml-4 my-1 space-y-0.5 text-[10px]">{children}</ul>,
                            ol: ({ children }) => <ol className="list-decimal ml-4 my-1 space-y-0.5 text-[10px]">{children}</ol>,
                            li: ({ children }) => <li className="text-[#cccccc]">{children}</li>,
                            code: ({ className, children }) => {
                              const isBlock = className?.includes('language-');
                              if (isBlock) {
                                return <code className="text-[#cccccc] text-[9px]">{children}</code>;
                              }
                              return <code className="bg-[#2d2d30] px-1 py-0.5 rounded text-cyan-300 text-[9px]">{children}</code>;
                            },
                            pre: ({ children }) => <pre className="bg-[#0d1117] p-2 rounded border border-[#3e3e42] my-1.5 text-[9px] max-h-40 overflow-auto">{children}</pre>,
                            strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
                            em: ({ children }) => <em className="italic">{children}</em>,
                          }}
                        >
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    </div>
                  </div>
                )}

                {msg.role === 'assistant' && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] rounded px-3 py-2 text-xs bg-[#1e1e1e] border border-[#3e3e42] text-[#cccccc] prose prose-invert prose-sm max-w-none">
                      <ReactMarkdown
                        components={{
                          h1: ({ children }) => <h1 className="text-sm text-white font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
                          h2: ({ children }) => <h2 className="text-xs text-white font-semibold mb-1.5 mt-2">{children}</h2>,
                          h3: ({ children }) => <h3 className="text-xs text-white font-semibold mb-1 mt-2">{children}</h3>,
                          p: ({ children }) => <p className="my-1.5 text-[11px] leading-relaxed text-[#cccccc]">{children}</p>,
                          ul: ({ children }) => <ul className="list-disc ml-4 my-1.5 space-y-0.5">{children}</ul>,
                          ol: ({ children }) => <ol className="list-decimal ml-4 my-1.5 space-y-0.5">{children}</ol>,
                          li: ({ children }) => <li className="text-[#cccccc] text-[11px]">{children}</li>,
                          code: ({ className, children }) => {
                            const isBlock = className?.includes('language-');
                            if (isBlock) {
                              return <code className="text-[#cccccc] text-[10px]">{children}</code>;
                            }
                            return <code className="bg-[#2d2d30] px-1.5 py-0.5 rounded text-[#ce9178] text-[10px]">{children}</code>;
                          },
                          pre: ({ children }) => <pre className="bg-[#0d1117] p-2.5 rounded border border-[#3e3e42] my-2 text-[10px] overflow-x-auto">{children}</pre>,
                          strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
                          em: ({ children }) => <em className="italic text-purple-300">{children}</em>,
                          a: ({ href, children }) => <a href={href} className="text-cyan-400 hover:text-cyan-300 underline" target="_blank" rel="noopener noreferrer">{children}</a>,
                          blockquote: ({ children }) => <blockquote className="border-l-2 border-purple-500 pl-3 my-2 text-[#999]">{children}</blockquote>,
                          hr: () => <hr className="border-[#3e3e42] my-3" />,
                          table: ({ children }) => <table className="border-collapse my-2 text-[10px] w-full">{children}</table>,
                          th: ({ children }) => <th className="border border-[#3e3e42] px-2 py-1 bg-[#2d2d30] text-white font-semibold">{children}</th>,
                          td: ({ children }) => <td className="border border-[#3e3e42] px-2 py-1">{children}</td>,
                        }}
                      >
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {llmLoading && (
              <div className="flex justify-start">
                <div className="bg-[#1e1e1e] border border-[#3e3e42] rounded px-3 py-2 text-xs text-[#cccccc] flex items-center gap-2">
                  <Loader2 size={12} className="animate-spin text-purple-400" />
                  <span>Analyzing...</span>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-purple-500/30 p-3 bg-[#1e1e1e] flex-shrink-0">
            <form onSubmit={(e) => { e.preventDefault(); sendMessage(userInput); }} className="flex gap-2">
              <input
                type="text"
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                disabled={llmLoading}
                placeholder="Ask about this resource..."
                className="flex-1 bg-[#252526] border border-[#3e3e42] rounded px-3 py-1.5 text-xs text-white placeholder-[#858585] focus:outline-none focus:border-purple-500/50 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={llmLoading || !userInput.trim()}
                className="px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-700 disabled:bg-purple-800 disabled:opacity-50 text-white text-xs"
              >
                Send
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Metadata Card */}
      <CollapsibleSection title="Metadata" icon={<Settings size={14} />}>
        <div className="grid grid-cols-2 gap-y-4 gap-x-6 text-sm">
          <div>
            <span className="block text-[#858585] text-xs mb-1">Namespace</span>
            <span className="text-[#cccccc] font-medium">{resource.namespace}</span>
          </div>
          <div>
            <span className="block text-[#858585] text-xs mb-1">Age</span>
            <span className="text-[#cccccc] font-medium">{formatAge(resource.age)}</span>
          </div>
          <div className="col-span-2">
            <span className="block text-[#858585] text-xs mb-1">UID</span>
            <span className="text-[#858585] text-xs font-mono bg-[#1e1e1e] px-2 py-1 rounded border border-[#3e3e42] inline-block select-all">
              {resource.id}
            </span>
          </div>
          <div>
            <span className="block text-[#858585] text-xs mb-1">API Group</span>
            <span className="text-[#cccccc] font-medium">{resource.group || 'core'}</span>
          </div>
          <div>
            <span className="block text-[#858585] text-xs mb-1">Version</span>
            <span className="text-[#cccccc] font-medium">{resource.version}</span>
          </div>
          <div>
            <span className="block text-[#858585] text-xs mb-1">Status</span>
            <StatusBadge status={resource.status} />
          </div>
        </div>
      </CollapsibleSection>

      {/* Crossplane Details */}
      {(resource.group.includes('crossplane.io') || resource.group.includes('upbound.io')) && (
        <CollapsibleSection title="Crossplane Details" icon={<Cloud size={14} />}>
          <div className="space-y-6">
            {/* Conditions Table */}
            {fullObject?.status?.conditions && (
              <div>
                <span className="block text-[#858585] text-xs mb-2 font-medium uppercase tracking-wider">Conditions</span>
                <div className="bg-[#1e1e1e] rounded border border-[#3e3e42] overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[#252526] text-[#858585] font-medium border-b border-[#3e3e42]">
                      <tr>
                        <th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">Reason</th>
                        <th className="px-3 py-2">Message</th>
                        <th className="px-3 py-2">Last Transition</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#3e3e42]">
                      {fullObject.status.conditions.map((c: any, i: number) => (
                        <tr key={i} className="hover:bg-[#2d2d30]">
                          <td className="px-3 py-2 font-medium text-white">{c.type}</td>
                          <td className="px-3 py-2">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${c.status === 'True' ? 'bg-green-500/20 text-green-400' :
                              c.status === 'False' ? 'bg-red-500/20 text-red-400' :
                                'bg-gray-500/20 text-gray-400'
                              }`}>
                              {c.status}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-[#cccccc]">{c.reason}</td>
                          <td className="px-3 py-2 text-[#858585] max-w-[200px] truncate" title={c.message}>{c.message}</td>
                          <td className="px-3 py-2 text-[#858585] whitespace-nowrap">{formatAge(c.lastTransitionTime)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Provider Config Ref */}
            {fullObject?.spec?.providerConfigRef && (
              <div>
                <span className="block text-[#858585] text-xs mb-1 font-medium uppercase tracking-wider">Provider Config</span>
                <div className="flex items-center gap-2 text-sm text-[#cccccc]">
                  <span className="font-mono bg-[#1e1e1e] px-2 py-1 rounded border border-[#3e3e42]">
                    {fullObject.spec.providerConfigRef.name}
                  </span>
                </div>
              </div>
            )}

            {/* Connection Secret */}
            {fullObject?.spec?.writeConnectionSecretToRef && (
              <div>
                <span className="block text-[#858585] text-xs mb-1 font-medium uppercase tracking-wider">Connection Secret</span>
                <div className="flex items-center gap-2 text-sm text-[#cccccc]">
                  <span className="text-[#858585]">Secret:</span>
                  <span className="font-mono bg-[#1e1e1e] px-2 py-1 rounded border border-[#3e3e42]">
                    {fullObject.spec.writeConnectionSecretToRef.name}
                  </span>
                  <span className="text-[#858585] ml-2">Namespace:</span>
                  <span className="font-mono bg-[#1e1e1e] px-2 py-1 rounded border border-[#3e3e42]">
                    {fullObject.spec.writeConnectionSecretToRef.namespace}
                  </span>
                </div>
              </div>
            )}

            {/* Connection Details */}
            {fullObject?.status?.connectionDetails && (
              <div>
                <span className="block text-[#858585] text-xs mb-1 font-medium uppercase tracking-wider">Published Connection Details</span>
                <div className="flex flex-wrap gap-2">
                  {Object.keys(fullObject.status.connectionDetails).map(key => (
                    <span key={key} className="px-2 py-1 bg-purple-500/10 text-purple-400 text-xs rounded border border-purple-500/20 font-mono">
                      {key}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleSection>
      )}

      {/* Resource Metrics */}
      {showMetrics && (
        <CollapsibleSection title="Resource Metrics" icon={<Activity size={14} />}>
          <MetricsChart resourceKind={resource.kind} namespace={resource.namespace} name={resource.name} currentContext={currentContext} />
        </CollapsibleSection>
      )}

      {/* Labels & Annotations */}
      <CollapsibleSection title="Labels & Annotations" icon={<Tags size={14} />}>
        <div className="space-y-4">
          <div>
            <span className="block text-[#858585] text-xs mb-2">Labels</span>
            <div className="flex flex-wrap gap-1.5">
              {metadata.labels ? Object.entries(metadata.labels).map(([k, v]) => (
                <span key={k} className="px-2 py-1 bg-[#007acc]/10 text-[#007acc] text-xs rounded border border-[#007acc]/20 font-mono">
                  {k}={String(v)}
                </span>
              )) : <span className="text-[#858585] text-sm italic">No labels</span>}
            </div>
          </div>
          <div>
            <span className="block text-[#858585] text-xs mb-2">Annotations</span>
            <div className="flex flex-col gap-1">
              {metadata.annotations ? Object.entries(metadata.annotations).map(([k, v]) => (
                <div key={k} className="text-xs font-mono text-[#cccccc] break-all">
                  <span className="text-[#858585]">{k}:</span> {String(v)}
                </div>
              )) : <span className="text-[#858585] text-sm italic">No annotations</span>}
            </div>
          </div>
        </div>
      </CollapsibleSection>

      {/* Recent Events */}
      {eventsSummary && (
        <CollapsibleSection title="Recent Events" icon={<Activity size={14} />}>
          <div className="flex items-center gap-4 text-xs mb-3">
            <span className="px-2 py-0.5 rounded bg-[#3e3e42] text-[#cccccc]">Total: {eventsSummary.total}</span>
            <span className="px-2 py-0.5 rounded bg-[#cca700]/15 text-[#cca700]">Warnings: {eventsSummary.warnings}</span>
          </div>
          <div className="space-y-1.5">
            {eventsSummary.recent.length === 0 && <span className="text-[#858585] text-xs italic">No recent events</span>}
            {eventsSummary.recent.map((e: any, i: number) => (
              <div key={i} className="bg-[#1e1e1e] border border-[#3e3e42] rounded p-2 flex gap-2 items-start">
                <div className={`w-1.5 h-1.5 rounded-full mt-1 ${e.type_ === 'Warning' ? 'bg-[#cca700]' : 'bg-[#89d185]'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline">
                    <span className="font-mono text-[11px] text-[#cccccc] truncate" title={e.reason}>{e.reason}</span>
                    <span className="text-[10px] text-[#858585]" title={e.age}>{new Date(e.age).toLocaleTimeString()}</span>
                  </div>
                  <span className="text-[11px] text-[#858585] break-all" title={e.message}>{e.message}</span>
                </div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Owner References */}
      {Array.isArray(metadata.ownerReferences) && metadata.ownerReferences.length > 0 && (
        <CollapsibleSection title="Owner References" icon={<FileCog size={14} />}>
          <div className="space-y-2 text-xs">
            {metadata.ownerReferences.map((o: any, i: number) => (
              <div key={i} className="bg-[#1e1e1e] border border-[#3e3e42] rounded p-2 flex flex-col gap-1">
                <div className="flex flex-wrap gap-2">
                  <span className="px-1.5 py-0.5 rounded bg-[#007acc]/10 text-[#007acc] font-mono">{o.kind}</span>
                  <span className="px-1.5 py-0.5 rounded bg-[#3e3e42] text-[#cccccc] font-mono">{o.name}</span>
                  {o.controller && <span className="px-1.5 py-0.5 rounded bg-[#89d185]/10 text-[#89d185] font-mono">controller</span>}
                  {o.blockOwnerDeletion && <span className="px-1.5 py-0.5 rounded bg-[#cca700]/10 text-[#cca700] font-mono">blockDeletion</span>}
                </div>
                <div className="text-[#858585] break-all font-mono">uid: {o.uid}</div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Finalizers */}
      {Array.isArray(metadata.finalizers) && metadata.finalizers.length > 0 && (
        <CollapsibleSection title="Finalizers" icon={<Shield size={14} />}>
          <div className="flex flex-wrap gap-1.5">
            {metadata.finalizers.map((f: string) => (
              <span key={f} className="px-2 py-1 bg-[#252526] border border-[#3e3e42] rounded text-[11px] font-mono text-[#cccccc]">{f}</span>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Conditions */}
      {Array.isArray(fullObject?.status?.conditions) && fullObject.status.conditions.length > 0 && (
        <CollapsibleSection title="Conditions" icon={<Activity size={14} />}>
          <div className="space-y-2">
            {fullObject.status.conditions.map((c: any, i: number) => (
              <div key={i} className="grid grid-cols-[1fr_0.7fr_0.6fr_1.4fr] gap-3 text-xs items-center bg-[#1e1e1e] border border-[#3e3e42] rounded p-2">
                <span className="font-mono text-[#cccccc] truncate" title={c.type}>{c.type}</span>
                <span className={`font-medium ${c.status === 'True' ? 'text-[#89d185]' : c.status === 'False' ? 'text-[#f48771]' : 'text-[#cca700]'}`}>{c.status}</span>
                <span className="text-[#858585] font-mono" title={c.lastTransitionTime}>{c.lastTransitionTime?.split('T')[0]}</span>
                <span className="text-[#858585] truncate" title={c.message || c.reason}>{c.reason || c.message || '-'}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Spec Summary (Kind Specific) */}
      <KindSpecSection kind={resource.kind} fullObject={fullObject} currentContext={currentContext} />

      {/* Raw Status */}
      {fullObject?.status && (
        <CollapsibleSection title="Raw Status" icon={<FileCode size={14} />}>
          <pre className="max-h-64 overflow-auto text-[11px] leading-relaxed bg-[#1e1e1e] p-3 rounded border border-[#3e3e42] font-mono text-[#cccccc]">
            {JSON.stringify(fullObject.status, null, 2)}
          </pre>
        </CollapsibleSection>
      )}

      {/* Delete Resource */}
      <div className="pt-4 border-t border-gray-800 mt-6">
        <button
          onClick={onDelete}
          className="w-full px-4 py-3 bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 text-white rounded-lg transition-all flex items-center justify-center gap-2 font-medium shadow-lg shadow-red-500/20 hover:shadow-red-500/30"
        >
          <Trash2 size={16} />
          Delete Resource
        </button>
      </div>
    </div>
  );
}

// --- Kind Specific Spec Section ---
function KindSpecSection({ kind, fullObject, currentContext }: { kind: string, fullObject: any, currentContext?: string }) {
  const k = kind.toLowerCase();
  const spec = fullObject?.spec || {};
  const status = fullObject?.status || {};

  // Helpers - recursive rendering of nested objects
  const renderValue = (v: any, depth = 0): React.ReactNode => {
    if (v === null || v === undefined) return <span className="text-[#858585] italic">null</span>;
    if (typeof v === 'boolean') return <span className={v ? 'text-[#89d185]' : 'text-[#f48771]'}>{String(v)}</span>;
    if (typeof v === 'number') return <span className="text-[#b5cea8]">{v}</span>;
    if (typeof v === 'string') return <span className="text-[#cccccc] break-all">{v || <span className="text-[#858585] italic">""</span>}</span>;
    if (Array.isArray(v)) {
      if (v.length === 0) return <span className="text-[#858585] italic">[]</span>;
      // For simple arrays (strings, numbers), show inline
      if (v.every(item => typeof item === 'string' || typeof item === 'number')) {
        return <span className="text-[#cccccc]">{v.join(', ')}</span>;
      }
      // For complex arrays, show each item
      return (
        <div className="ml-3 mt-1 space-y-1 border-l border-[#3e3e42] pl-2">
          {v.map((item, i) => (
            <div key={i} className="text-[10px]">
              <span className="text-[#858585]">[{i}] </span>
              {renderValue(item, depth + 1)}
            </div>
          ))}
        </div>
      );
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v);
      if (entries.length === 0) return <span className="text-[#858585] italic">{'{}'}</span>;
      return (
        <div className={depth > 0 ? "ml-3 mt-1 space-y-0.5 border-l border-[#3e3e42] pl-2" : "space-y-0.5"}>
          {entries.map(([key, val]) => (
            <div key={key} className="text-[10px]">
              <span className="text-[#569cd6]">{key}: </span>
              {renderValue(val, depth + 1)}
            </div>
          ))}
        </div>
      );
    }
    return <span className="text-[#cccccc]">{String(v)}</span>;
  };

  const renderKV = (obj: any) => obj ? Object.entries(obj).map(([k, v]) => (
    <div key={k} className="py-1 border-b border-[#2d2d30] last:border-b-0">
      <div className="flex gap-4">
        <span className="text-[#569cd6] font-mono text-[11px] min-w-[120px] shrink-0">{k}</span>
        <div className="text-[#cccccc] font-mono text-[11px] break-all flex-1">{renderValue(v)}</div>
      </div>
    </div>
  )) : <span className="text-[#858585] italic text-xs">None</span>;

  if (k === 'pod') {
    const containers = spec.containers || [];
    const initContainers = spec.initContainers || [];
    const cStatuses: Record<string, any> = {};
    (status.containerStatuses || []).forEach((cs: any) => { cStatuses[cs.name] = cs; });
    const volumes = spec.volumes || [];
    const metadata = fullObject?.metadata || {};
    const [activeContainer, setActiveContainer] = useState<string>(containers[0]?.name || "");
    useEffect(() => {
      if (containers.length > 0 && !containers.find((c: any) => c.name === activeContainer)) {
        setActiveContainer(containers[0].name);
      }
    }, [containers, activeContainer]);
    // Matching services (query all services; lightweight summary)
    const { data: svcList } = useQuery({
      queryKey: ["pod_matching_services", currentContext],
      queryFn: async () => {
        try {
          const svcs = await invoke<any[]>("list_resources", { req: { group: "", version: "v1", kind: "Service", namespace: null } });
          return svcs.map(s => s.name).slice(0, 50); // limit names
        } catch { return []; }
      },
      staleTime: 60000,
    });
    const [matchedServices, setMatchedServices] = useState<string[]>([]);
    useEffect(() => {
      (async () => {
        if (!svcList || svcList.length === 0 || !metadata.labels) { setMatchedServices([]); return; }
        const labels = metadata.labels;
        const matches: string[] = [];
        // Fetch each service detail to inspect selector (limit 20 to avoid spam)
        for (const name of svcList.slice(0, 20)) {
          try {
            const jsonStr = await invoke<string>("get_resource_details", { req: { group: "", version: "v1", kind: "Service", namespace: null }, name });
            const obj = JSON.parse(jsonStr);
            const selector = obj?.spec?.selector || {};
            const isMatch = selector && Object.entries(selector).every(([k, v]) => labels[k] === v);
            if (isMatch) matches.push(name);
          } catch { /* ignore */ }
        }
        setMatchedServices(matches);
      })();
    }, [svcList, metadata.labels]);
    // Calculate QoS class
    const getQoSClass = () => {
      const allContainers = [...containers, ...initContainers];
      if (allContainers.length === 0) return 'BestEffort';

      let allGuaranteed = true;
      let anyRequestOrLimit = false;

      for (const c of allContainers) {
        const requests = c.resources?.requests || {};
        const limits = c.resources?.limits || {};

        const hasCpuRequest = !!requests.cpu;
        const hasMemRequest = !!requests.memory;
        const hasCpuLimit = !!limits.cpu;
        const hasMemLimit = !!limits.memory;

        if (hasCpuRequest || hasMemRequest || hasCpuLimit || hasMemLimit) {
          anyRequestOrLimit = true;
        }

        // For Guaranteed: must have both CPU and memory limits equal to requests
        if (!(hasCpuLimit && hasMemLimit && hasCpuRequest && hasMemRequest &&
          requests.cpu === limits.cpu && requests.memory === limits.memory)) {
          allGuaranteed = false;
        }
      }

      if (!anyRequestOrLimit) return 'BestEffort';
      if (allGuaranteed) return 'Guaranteed';
      return 'Burstable';
    };

    const qosClass = status?.qosClass || getQoSClass();
    const securityContext = spec?.securityContext || {};
    const dnsPolicy = spec?.dnsPolicy || 'ClusterFirst';
    const priorityClassName = spec?.priorityClassName;
    const priority = spec?.priority;

    return (
      <CollapsibleSection title="Pod Details" icon={<Layers size={14} />}>
        <div className="space-y-6">
          {/* Summary */}
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div><span className="block text-[#858585] mb-1">Node</span><span className="font-mono text-[#cccccc]">{status?.hostIP || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Pod IP</span><span className="font-mono text-[#cccccc]">{status?.podIP || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">ServiceAccount</span><span className="font-mono text-[#cccccc]">{spec?.serviceAccountName || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Restart Policy</span><span className="font-mono text-[#cccccc]">{spec?.restartPolicy || '-'}</span></div>
            <div>
              <span className="block text-[#858585] mb-1">QoS Class</span>
              <span className={`px-1.5 py-0.5 rounded text-[11px] font-mono ${qosClass === 'Guaranteed' ? 'bg-[#89d185]/10 text-[#89d185]' :
                qosClass === 'Burstable' ? 'bg-[#cca700]/10 text-[#cca700]' :
                  'bg-[#858585]/10 text-[#858585]'
                }`}>{qosClass}</span>
            </div>
            <div><span className="block text-[#858585] mb-1">DNS Policy</span><span className="font-mono text-[#cccccc]">{dnsPolicy}</span></div>
            {priorityClassName && (
              <div><span className="block text-[#858585] mb-1">Priority Class</span><span className="font-mono text-[#cccccc]">{priorityClassName}</span></div>
            )}
            {priority !== undefined && (
              <div><span className="block text-[#858585] mb-1">Priority</span><span className="font-mono text-[#cccccc]">{priority}</span></div>
            )}
          </div>

          {/* Security Context */}
          {Object.keys(securityContext).length > 0 && (
            <div className="space-y-2">
              <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold">Security Context</h4>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {securityContext.runAsUser !== undefined && (
                  <div className="flex items-center gap-2">
                    <span className="text-[#858585]">runAsUser:</span>
                    <span className="font-mono text-[#cccccc]">{securityContext.runAsUser}</span>
                  </div>
                )}
                {securityContext.runAsGroup !== undefined && (
                  <div className="flex items-center gap-2">
                    <span className="text-[#858585]">runAsGroup:</span>
                    <span className="font-mono text-[#cccccc]">{securityContext.runAsGroup}</span>
                  </div>
                )}
                {securityContext.fsGroup !== undefined && (
                  <div className="flex items-center gap-2">
                    <span className="text-[#858585]">fsGroup:</span>
                    <span className="font-mono text-[#cccccc]">{securityContext.fsGroup}</span>
                  </div>
                )}
                {securityContext.runAsNonRoot !== undefined && (
                  <div className="flex items-center gap-2">
                    <span className="text-[#858585]">runAsNonRoot:</span>
                    <span className={`font-mono ${securityContext.runAsNonRoot ? 'text-[#89d185]' : 'text-[#f48771]'}`}>
                      {String(securityContext.runAsNonRoot)}
                    </span>
                  </div>
                )}
                {securityContext.readOnlyRootFilesystem !== undefined && (
                  <div className="flex items-center gap-2">
                    <span className="text-[#858585]">readOnlyRootFilesystem:</span>
                    <span className={`font-mono ${securityContext.readOnlyRootFilesystem ? 'text-[#89d185]' : 'text-[#cca700]'}`}>
                      {String(securityContext.readOnlyRootFilesystem)}
                    </span>
                  </div>
                )}
                {securityContext.seccompProfile && (
                  <div className="flex items-center gap-2 col-span-2">
                    <span className="text-[#858585]">seccompProfile:</span>
                    <span className="font-mono text-[#cccccc]">{securityContext.seccompProfile.type}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Scheduling */}
          {(spec.nodeSelector || spec.tolerations) && (
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <span className="block text-[#858585] mb-1">Node Selector</span>
                <div className="flex flex-wrap gap-1">
                  {spec.nodeSelector ? Object.entries(spec.nodeSelector).map(([k, v]) => (
                    <span key={k} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]">{k}={String(v)}</span>
                  )) : <span className="text-[#858585] text-[11px] italic">None</span>}
                </div>
              </div>
              <div>
                <span className="block text-[#858585] mb-1">Tolerations</span>
                <div className="flex flex-wrap gap-1">
                  {Array.isArray(spec.tolerations) && spec.tolerations.length > 0 ? spec.tolerations.map((t: any, i: number) => (
                    <span key={i} className="px-1.5 py-0.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={JSON.stringify(t)}>{t.key || '*'}:{t.operator || ''}:{t.effect || ''}</span>
                  )) : <span className="text-[#858585] text-[11px] italic">None</span>}
                </div>
              </div>
            </div>
          )}

          {/* Containers (single selection) */}
          <div className="space-y-3">
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold">Containers</h4>
            <div className="flex flex-wrap gap-1">
              {containers.map((c: any) => {
                const st = cStatuses[c.name];
                const running = st?.state?.running;
                return (
                  <button
                    key={c.name}
                    onClick={() => setActiveContainer(c.name)}
                    className={`px-2 py-1 rounded text-[11px] font-mono border flex items-center gap-1 transition-colors ${activeContainer === c.name ? 'bg-[#007acc] border-[#007acc] text-white' : 'bg-[#252526] border-[#3e3e42] text-[#cccccc] hover:border-[#007acc]/50'}`}
                    title={c.image}
                  >
                    <span>{c.name}</span>
                    {running && <span className="w-1.5 h-1.5 rounded-full bg-[#89d185]" />}
                  </button>
                );
              })}
              {containers.length === 0 && <span className="text-[#858585] text-xs italic">No containers</span>}
            </div>
            {initContainers.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {initContainers.map((c: any) => (
                  <span key={c.name} className="px-2 py-1 rounded text-[10px] font-mono bg-[#3e3e42] text-[#cccccc]" title={c.image}>init:{c.name}</span>
                ))}
              </div>
            )}
            {/* Active container details */}
            {activeContainer && (() => {
              const c = containers.find((x: any) => x.name === activeContainer);
              if (!c) return <span className="text-[#858585] text-xs italic">Container not found</span>;
              const st = cStatuses[c.name];
              let state = '-';
              if (st?.state?.running) state = 'Running'; else if (st?.state?.waiting) state = 'Waiting:' + (st.state.waiting.reason || ''); else if (st?.state?.terminated) state = 'Terminated:' + (st.state.terminated.reason || '');
              return (
                <div className="border border-[#3e3e42] rounded p-3 bg-[#1e1e1e] space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="px-1.5 py-0.5 bg-[#007acc]/10 text-[#007acc] rounded text-[11px] font-mono">{c.name}</span>
                    <span className="px-1.5 py-0.5 bg-[#3e3e42] text-[#cccccc] rounded text-[11px] font-mono" title={c.image}>{c.image?.split('@')[0]}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[11px] font-mono ${state.startsWith('Running') ? 'bg-[#89d185]/10 text-[#89d185]' : state.startsWith('Waiting') ? 'bg-[#cca700]/10 text-[#cca700]' : state.startsWith('Terminated') ? 'bg-[#f48771]/10 text-[#f48771]' : 'bg-[#858585]/10 text-[#858585]'}`}>{state}</span>
                    {st && <span className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[11px] font-mono">Restarts:{st.restartCount}</span>}
                  </div>
                  {(c.resources?.requests || c.resources?.limits) && (
                    <div className="grid grid-cols-2 gap-4 text-[11px]">
                      <div>
                        <span className="text-[#858585]">Requests</span>
                        <div className="mt-1 space-y-0.5">{renderKV(c.resources.requests)}</div>
                      </div>
                      <div>
                        <span className="text-[#858585]">Limits</span>
                        <div className="mt-1 space-y-0.5">{renderKV(c.resources.limits)}</div>
                      </div>
                    </div>
                  )}
                  {Array.isArray(c.ports) && c.ports.length > 0 && (
                    <div className="text-[11px]"><span className="text-[#858585]">Ports:</span> {c.ports.map((p: any) => `${p.containerPort}/${p.protocol || 'TCP'}`).join(', ')}</div>
                  )}
                  {Array.isArray(c.env) && c.env.length > 0 && (
                    <div className="text-[11px]">
                      <span className="text-[#858585]">Env:</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {c.env.slice(0, 60).map((e: any) => (
                          <span key={e.name + (e.value || '')} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={e.value || e.valueFrom ? JSON.stringify(e.valueFrom || e.value) : ''}>{e.name}{e.value ? `=${e.value}` : ''}</span>
                        ))}
                        {c.env.length > 60 && <span className="text-[10px] text-[#858585]">+{c.env.length - 60} more</span>}
                      </div>
                    </div>
                  )}
                  {Array.isArray(c.volumeMounts) && c.volumeMounts.length > 0 && (
                    <div className="text-[11px]">
                      <span className="text-[#858585]">Mounts:</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {c.volumeMounts.map((m: any) => (
                          <span key={m.name + m.mountPath} className="px-1.5 py-0.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={m.mountPath}>{m.name}:{m.mountPath}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {(c.livenessProbe || c.readinessProbe || c.startupProbe) && (
                    <div className="text-[11px] space-y-1">
                      <span className="text-[#858585]">Probes:</span>
                      {['livenessProbe', 'readinessProbe', 'startupProbe'].map((pk) => {
                        const probe: any = (c as any)[pk];
                        if (!probe) return null;
                        const type = probe.httpGet ? 'HTTP' : probe.tcpSocket ? 'TCP' : probe.exec ? 'Exec' : 'Unknown';
                        const detail = probe.httpGet ? `${probe.httpGet.path || '/'}:${probe.httpGet.port}` : probe.tcpSocket ? probe.tcpSocket.port : probe.exec ? (probe.exec.command || []).join(' ') : '';
                        return (
                          <div key={pk} className="flex flex-wrap items-center gap-2">
                            <span className="px-1 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]">{pk.replace('Probe', '')}</span>
                            <span className="px-1 py-0.5 bg-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]">{type}</span>
                            <span className="px-1 py-0.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={detail}>{detail || '-'}</span>
                            {typeof probe.initialDelaySeconds === 'number' && <span className="text-[#858585]">delay:{probe.initialDelaySeconds}s</span>}
                            {typeof probe.periodSeconds === 'number' && <span className="text-[#858585]">period:{probe.periodSeconds}s</span>}
                            {typeof probe.timeoutSeconds === 'number' && <span className="text-[#858585]">timeout:{probe.timeoutSeconds}s</span>}
                            {typeof probe.failureThreshold === 'number' && <span className="text-[#f48771]">fail:{probe.failureThreshold}</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Volumes */}
          <div className="space-y-2">
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold">Volumes</h4>
            <div className="flex flex-wrap gap-1.5">
              {volumes.map((v: any, i: number) => {
                const type = Object.keys(v).find(k => k !== 'name') || 'unknown';
                return (
                  <span key={i} className="px-2 py-1 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={JSON.stringify(v[type] || {})}>{v.name}:{type}</span>
                );
              })}
              {volumes.length === 0 && <span className="text-[#858585] text-xs italic">No volumes</span>}
            </div>
          </div>
          {/* Matching Services */}
          <div className="space-y-1">
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold">Matching Services</h4>
            <div className="flex flex-wrap gap-1">
              {matchedServices.length > 0 ? matchedServices.map(n => (
                <span key={n} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={n}>{n}</span>
              )) : <span className="text-[#858585] text-xs italic">None</span>}
            </div>
          </div>
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'deployment') {
    const replicas = spec.replicas ?? 1;
    const strategy = spec.strategy?.type || 'RollingUpdate';
    const rollingUpdate = spec.strategy?.rollingUpdate;
    const selector = spec.selector?.matchLabels ? Object.entries(spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(', ') : '-';
    const tplContainers = spec.template?.spec?.containers || [];
    const initContainers = spec.template?.spec?.initContainers || [];

    // Status info
    const readyReplicas = status.readyReplicas || 0;
    const availableReplicas = status.availableReplicas || 0;
    const updatedReplicas = status.updatedReplicas || 0;
    const unavailableReplicas = status.unavailableReplicas || 0;
    const conditions = status.conditions || [];

    // Determine rollout status
    const getRolloutStatus = () => {
      if (unavailableReplicas > 0) return { status: 'Progressing', color: 'text-yellow-400', bg: 'bg-yellow-500/20' };
      if (updatedReplicas < replicas) return { status: 'Updating', color: 'text-blue-400', bg: 'bg-blue-500/20' };
      if (readyReplicas === replicas && availableReplicas === replicas) return { status: 'Complete', color: 'text-green-400', bg: 'bg-green-500/20' };
      if (readyReplicas < replicas) return { status: 'Scaling', color: 'text-orange-400', bg: 'bg-orange-500/20' };
      return { status: 'Unknown', color: 'text-[#858585]', bg: 'bg-[#3e3e42]' };
    };
    const rolloutStatus = getRolloutStatus();

    // Calculate resource totals
    const getResourceTotals = () => {
      let cpuRequest = 0, cpuLimit = 0, memRequest = 0, memLimit = 0;
      tplContainers.forEach((c: any) => {
        const req = c.resources?.requests || {};
        const lim = c.resources?.limits || {};
        if (req.cpu) cpuRequest += parseCpu(req.cpu);
        if (lim.cpu) cpuLimit += parseCpu(lim.cpu);
        if (req.memory) memRequest += parseMemory(req.memory);
        if (lim.memory) memLimit += parseMemory(lim.memory);
      });
      return { cpuRequest, cpuLimit, memRequest, memLimit };
    };
    const parseCpu = (cpu: string) => {
      if (cpu.endsWith('m')) return parseInt(cpu) / 1000;
      return parseFloat(cpu);
    };
    const parseMemory = (mem: string) => {
      const num = parseFloat(mem);
      if (mem.endsWith('Ki')) return num * 1024;
      if (mem.endsWith('Mi')) return num * 1024 * 1024;
      if (mem.endsWith('Gi')) return num * 1024 * 1024 * 1024;
      if (mem.endsWith('Ti')) return num * 1024 * 1024 * 1024 * 1024;
      return num;
    };
    const formatMemory = (bytes: number) => {
      if (bytes === 0) return '-';
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ki`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} Mi`;
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} Gi`;
    };
    const resources = getResourceTotals();

    return (
      <CollapsibleSection title="Deployment Spec" icon={<Package size={14} />}>
        <div className="space-y-4 text-xs">
          {/* Rollout Status */}
          <div className="flex flex-wrap gap-3">
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Rollout: </span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] ${rolloutStatus.bg} ${rolloutStatus.color}`}>{rolloutStatus.status}</span>
            </div>
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Strategy: </span>
              <span className="font-mono text-[#cccccc]">{strategy}</span>
              {rollingUpdate && (
                <span className="text-[#585858] ml-1">
                  (max surge: {rollingUpdate.maxSurge || '25%'}, max unavail: {rollingUpdate.maxUnavailable || '25%'})
                </span>
              )}
            </div>
          </div>

          {/* Replica Status */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Replica Status</h4>
            <div className="grid grid-cols-4 gap-2">
              <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded text-center">
                <div className="text-lg font-mono text-[#cccccc]">{replicas}</div>
                <div className="text-[9px] text-[#858585]">Desired</div>
              </div>
              <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded text-center">
                <div className={`text-lg font-mono ${readyReplicas === replicas ? 'text-green-400' : 'text-yellow-400'}`}>{readyReplicas}</div>
                <div className="text-[9px] text-[#858585]">Ready</div>
              </div>
              <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded text-center">
                <div className={`text-lg font-mono ${updatedReplicas === replicas ? 'text-green-400' : 'text-blue-400'}`}>{updatedReplicas}</div>
                <div className="text-[9px] text-[#858585]">Updated</div>
              </div>
              <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded text-center">
                <div className={`text-lg font-mono ${availableReplicas === replicas ? 'text-green-400' : 'text-orange-400'}`}>{availableReplicas}</div>
                <div className="text-[9px] text-[#858585]">Available</div>
              </div>
            </div>
            {/* Progress bar */}
            <div className="mt-2 h-1.5 bg-[#3e3e42] rounded overflow-hidden">
              <div
                className={`h-full transition-all ${readyReplicas === replicas ? 'bg-green-500' : 'bg-yellow-500'}`}
                style={{ width: `${(readyReplicas / replicas) * 100}%` }}
              />
            </div>
          </div>

          {/* Conditions */}
          {conditions.length > 0 && (
            <div>
              <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Conditions</h4>
              <div className="flex flex-wrap gap-2">
                {conditions.map((cond: any, i: number) => {
                  const isTrue = cond.status === 'True';
                  return (
                    <div key={i} className="px-2 py-1 bg-[#1e1e1e] border border-[#3e3e42] rounded flex items-center gap-1.5" title={cond.message || cond.reason}>
                      <span className={`w-1.5 h-1.5 rounded-full ${isTrue ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className="text-[10px] text-[#cccccc]">{cond.type}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Resource Totals (per replica) */}
          {(resources.cpuRequest > 0 || resources.memRequest > 0) && (
            <div>
              <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Resources Per Replica</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <div className="text-[9px] text-[#858585] mb-1">CPU</div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-[#858585]">Request:</span>
                    <span className="font-mono text-cyan-400">{resources.cpuRequest > 0 ? `${(resources.cpuRequest * 1000).toFixed(0)}m` : '-'}</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-[#858585]">Limit:</span>
                    <span className="font-mono text-orange-400">{resources.cpuLimit > 0 ? `${(resources.cpuLimit * 1000).toFixed(0)}m` : '-'}</span>
                  </div>
                </div>
                <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <div className="text-[9px] text-[#858585] mb-1">Memory</div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-[#858585]">Request:</span>
                    <span className="font-mono text-cyan-400">{formatMemory(resources.memRequest)}</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-[#858585]">Limit:</span>
                    <span className="font-mono text-orange-400">{formatMemory(resources.memLimit)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Selector */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Selector</h4>
            <div className="flex flex-wrap gap-1">
              {spec.selector?.matchLabels ? Object.entries(spec.selector.matchLabels).map(([k, v]) => (
                <span key={k} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]">{k}={String(v)}</span>
              )) : <span className="text-[#858585] italic">None</span>}
            </div>
          </div>

          {/* Template Containers */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Containers ({tplContainers.length})</h4>
            <div className="space-y-1.5">
              {tplContainers.map((c: any, i: number) => (
                <div key={i} className="px-2 py-1.5 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] text-[#cccccc] font-bold">{c.name}</span>
                    <div className="flex items-center gap-1">
                      {c.ports?.map((p: any, pi: number) => (
                        <span key={pi} className="px-1 py-0.5 bg-[#3e3e42] rounded text-[9px] text-[#858585]">{p.containerPort}/{p.protocol || 'TCP'}</span>
                      ))}
                    </div>
                  </div>
                  <div className="text-[9px] text-[#585858] truncate mt-0.5" title={c.image}>{c.image}</div>
                </div>
              ))}
              {tplContainers.length === 0 && <span className="text-[#858585] italic">No containers</span>}
            </div>
          </div>

          {/* Init Containers */}
          {initContainers.length > 0 && (
            <div>
              <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Init Containers ({initContainers.length})</h4>
              <div className="flex flex-wrap gap-1.5">
                {initContainers.map((c: any, i: number) => (
                  <span key={i} className="px-1.5 py-0.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[10px] font-mono text-purple-400" title={c.image}>{c.name}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'replicaset') {
    const replicas = spec.replicas;
    const selector = spec.selector?.matchLabels ? Object.entries(spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(', ') : '-';
    const tplContainers = spec.template?.spec?.containers || [];
    return (
      <CollapsibleSection title="ReplicaSet Spec" icon={<Package size={14} />}>
        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-4">
            <div><span className="block text-[#858585] mb-1">Desired Replicas</span><span className="font-mono text-[#cccccc]">{replicas ?? '-'}</span></div>
            <div className="col-span-2"><span className="block text-[#858585] mb-1">Selector</span><span className="font-mono text-[#cccccc] break-all">{selector}</span></div>
          </div>
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Template Containers</h4>
            <div className="flex flex-wrap gap-1.5">
              {tplContainers.map((c: any, i: number) => (
                <span key={i} className="px-1.5 py-0.5 bg-[#1e1e1e] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={c.image}>{c.name}</span>
              ))}
              {tplContainers.length === 0 && <span className="text-[#858585] italic">No containers</span>}
            </div>
          </div>
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'service') {
    const ports = spec.ports || [];
    const serviceType = spec.type || 'ClusterIP';
    const sessionAffinity = spec.sessionAffinity || 'None';
    const loadBalancerIP = spec.loadBalancerIP;
    const loadBalancerStatus = status.loadBalancer || {};
    const externalTrafficPolicy = spec.externalTrafficPolicy;
    const internalTrafficPolicy = spec.internalTrafficPolicy;
    const healthCheckNodePort = spec.healthCheckNodePort;

    // Service type colors
    const getServiceTypeInfo = (type: string) => {
      switch (type) {
        case 'LoadBalancer': return { color: 'text-green-400', bg: 'bg-green-500/20' };
        case 'NodePort': return { color: 'text-blue-400', bg: 'bg-blue-500/20' };
        case 'ExternalName': return { color: 'text-purple-400', bg: 'bg-purple-500/20' };
        case 'ClusterIP': return { color: 'text-cyan-400', bg: 'bg-cyan-500/20' };
        default: return { color: 'text-[#858585]', bg: 'bg-[#3e3e42]' };
      }
    };
    const typeInfo = getServiceTypeInfo(serviceType);

    // Get load balancer ingress IPs
    const lbIngress = loadBalancerStatus.ingress || [];

    return (
      <CollapsibleSection title="Service Spec" icon={<Network size={14} />}>
        <div className="space-y-4 text-xs">
          {/* Service Type Badge & Stats */}
          <div className="flex flex-wrap gap-3">
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Type: </span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] ${typeInfo.bg} ${typeInfo.color}`}>{serviceType}</span>
            </div>
            {sessionAffinity !== 'None' && (
              <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
                <span className="text-[#858585]">Session Affinity: </span>
                <span className="font-mono text-orange-400">{sessionAffinity}</span>
              </div>
            )}
            {externalTrafficPolicy && (
              <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
                <span className="text-[#858585]">External Traffic: </span>
                <span className={`font-mono ${externalTrafficPolicy === 'Local' ? 'text-yellow-400' : 'text-[#cccccc]'}`}>{externalTrafficPolicy}</span>
              </div>
            )}
          </div>

          {/* IP Addresses */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">IP Addresses</h4>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                <div className="text-[9px] text-[#858585] mb-1">Cluster IP</div>
                <div className="font-mono text-[11px] text-cyan-400">{spec.clusterIP === 'None' ? <span className="text-[#858585] italic">Headless</span> : spec.clusterIP || '-'}</div>
              </div>
              {serviceType === 'LoadBalancer' && (
                <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <div className="text-[9px] text-[#858585] mb-1">Load Balancer IP</div>
                  {lbIngress.length > 0 ? (
                    <div className="space-y-0.5">
                      {lbIngress.map((ing: any, i: number) => (
                        <div key={i} className="font-mono text-[11px] text-green-400">{ing.ip || ing.hostname || '-'}</div>
                      ))}
                    </div>
                  ) : loadBalancerIP ? (
                    <div className="font-mono text-[11px] text-yellow-400">{loadBalancerIP} <span className="text-[9px] text-[#585858]">(pending)</span></div>
                  ) : (
                    <div className="text-[#858585] italic text-[11px]">Pending...</div>
                  )}
                </div>
              )}
              {serviceType === 'ExternalName' && spec.externalName && (
                <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <div className="text-[9px] text-[#858585] mb-1">External Name</div>
                  <div className="font-mono text-[11px] text-purple-400 break-all">{spec.externalName}</div>
                </div>
              )}
              {spec.externalIPs && spec.externalIPs.length > 0 && (
                <div className="p-2 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <div className="text-[9px] text-[#858585] mb-1">External IPs</div>
                  <div className="font-mono text-[11px] text-orange-400">{spec.externalIPs.join(', ')}</div>
                </div>
              )}
            </div>
          </div>

          {/* Ports */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Ports ({ports.length})</h4>
            {ports.length === 0 ? (
              <span className="text-[#858585] italic">No ports</span>
            ) : (
              <div className="space-y-1.5">
                {ports.map((p: any, i: number) => (
                  <div key={i} className="px-2 py-1.5 bg-[#1e1e1e] border border-[#3e3e42] rounded flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {p.name && <span className="font-mono text-[10px] text-[#cccccc] font-bold">{p.name}</span>}
                      <span className="px-1.5 py-0.5 bg-[#3e3e42] rounded text-[9px] text-[#858585]">{p.protocol || 'TCP'}</span>
                    </div>
                    <div className="flex items-center gap-2 font-mono text-[10px]">
                      <span className="text-cyan-400">{p.port}</span>
                      <span className="text-[#585858]">→</span>
                      <span className="text-green-400">{p.targetPort || p.port}</span>
                      {p.nodePort && (
                        <>
                          <span className="text-[#585858]">:</span>
                          <span className="text-orange-400">{p.nodePort}</span>
                          <span className="text-[9px] text-[#585858]">(node)</span>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Selector */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Selector</h4>
            <div className="flex flex-wrap gap-1">
              {spec.selector ? Object.entries(spec.selector).map(([k, v]) => (
                <span key={k} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]">{k}={String(v)}</span>
              )) : <span className="text-[#858585] italic text-xs">None (headless or external)</span>}
            </div>
          </div>

          {/* Additional Info */}
          {(healthCheckNodePort || internalTrafficPolicy) && (
            <div className="flex flex-wrap gap-3 text-[10px]">
              {healthCheckNodePort && (
                <div className="px-2 py-1 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <span className="text-[#858585]">Health Check Port: </span>
                  <span className="font-mono text-[#cccccc]">{healthCheckNodePort}</span>
                </div>
              )}
              {internalTrafficPolicy && (
                <div className="px-2 py-1 bg-[#1e1e1e] border border-[#3e3e42] rounded">
                  <span className="text-[#858585]">Internal Traffic: </span>
                  <span className="font-mono text-[#cccccc]">{internalTrafficPolicy}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'node') {
    const capacity = status.capacity || {};
    const alloc = status.allocatable || {};
    const addresses = status.addresses || [];
    const taints = spec.taints || [];
    const conditions = status.conditions || [];
    const nodeInfo = status.nodeInfo || {};

    // Parse CPU and memory for percentage calculation
    const parseCpu = (val: string) => {
      if (!val) return 0;
      if (val.endsWith('m')) return parseInt(val) / 1000;
      if (val.endsWith('n')) return parseInt(val) / 1000000000;
      return parseFloat(val);
    };
    const parseMem = (val: string) => {
      if (!val) return 0;
      const units: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4 };
      for (const [suffix, mult] of Object.entries(units)) {
        if (val.endsWith(suffix)) return parseInt(val) * mult;
      }
      return parseInt(val);
    };

    const cpuCapacity = parseCpu(capacity.cpu);
    const cpuAllocatable = parseCpu(alloc.cpu);
    const memCapacity = parseMem(capacity.memory);
    const memAllocatable = parseMem(alloc.memory);
    const podsCapacity = parseInt(capacity.pods) || 0;
    const podsAllocatable = parseInt(alloc.pods) || 0;

    const cpuReservedPct = cpuCapacity > 0 ? Math.round(((cpuCapacity - cpuAllocatable) / cpuCapacity) * 100) : 0;
    const memReservedPct = memCapacity > 0 ? Math.round(((memCapacity - memAllocatable) / memCapacity) * 100) : 0;

    // Get condition statuses
    const getConditionStatus = (type: string) => {
      const cond = conditions.find((c: any) => c.type === type);
      return cond ? { status: cond.status, message: cond.message } : null;
    };

    const ready = getConditionStatus('Ready');
    const memPressure = getConditionStatus('MemoryPressure');
    const diskPressure = getConditionStatus('DiskPressure');
    const pidPressure = getConditionStatus('PIDPressure');
    const networkUnavail = getConditionStatus('NetworkUnavailable');

    return (
      <CollapsibleSection title="Node Info" icon={<Server size={14} />}>
        <div className="space-y-4 text-xs">
          {/* System Info */}
          <div className="grid grid-cols-2 gap-4">
            <div><span className="block text-[#858585] mb-1">OS Image</span><span className="font-mono text-[#cccccc] break-all">{nodeInfo.osImage || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Kubelet</span><span className="font-mono text-[#cccccc]">{nodeInfo.kubeletVersion || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Container Runtime</span><span className="font-mono text-[#cccccc]">{nodeInfo.containerRuntimeVersion || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Kernel</span><span className="font-mono text-[#cccccc]">{nodeInfo.kernelVersion || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Architecture</span><span className="font-mono text-[#cccccc]">{nodeInfo.architecture || '-'}</span></div>
            <div><span className="block text-[#858585] mb-1">Machine ID</span><span className="font-mono text-[#cccccc] text-[10px] break-all">{nodeInfo.machineID || '-'}</span></div>
          </div>

          {/* Node Conditions */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Health Status</h4>
            <div className="flex flex-wrap gap-2">
              {ready && (
                <span className={`px-2 py-1 rounded text-[11px] font-mono ${ready.status === 'True' ? 'bg-[#89d185]/10 text-[#89d185]' : 'bg-[#f48771]/10 text-[#f48771]'}`} title={ready.message}>
                  Ready: {ready.status}
                </span>
              )}
              {memPressure && (
                <span className={`px-2 py-1 rounded text-[11px] font-mono ${memPressure.status === 'False' ? 'bg-[#89d185]/10 text-[#89d185]' : 'bg-[#f48771]/10 text-[#f48771]'}`} title={memPressure.message}>
                  MemoryPressure: {memPressure.status}
                </span>
              )}
              {diskPressure && (
                <span className={`px-2 py-1 rounded text-[11px] font-mono ${diskPressure.status === 'False' ? 'bg-[#89d185]/10 text-[#89d185]' : 'bg-[#f48771]/10 text-[#f48771]'}`} title={diskPressure.message}>
                  DiskPressure: {diskPressure.status}
                </span>
              )}
              {pidPressure && (
                <span className={`px-2 py-1 rounded text-[11px] font-mono ${pidPressure.status === 'False' ? 'bg-[#89d185]/10 text-[#89d185]' : 'bg-[#f48771]/10 text-[#f48771]'}`} title={pidPressure.message}>
                  PIDPressure: {pidPressure.status}
                </span>
              )}
              {networkUnavail && (
                <span className={`px-2 py-1 rounded text-[11px] font-mono ${networkUnavail.status === 'False' ? 'bg-[#89d185]/10 text-[#89d185]' : 'bg-[#f48771]/10 text-[#f48771]'}`} title={networkUnavail.message}>
                  NetworkUnavailable: {networkUnavail.status}
                </span>
              )}
            </div>
          </div>

          {/* Taints */}
          {taints.length > 0 && (
            <div>
              <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Taints</h4>
              <div className="flex flex-wrap gap-1.5">
                {taints.map((t: any, i: number) => (
                  <span key={i} className={`px-2 py-1 rounded text-[10px] font-mono border ${t.effect === 'NoSchedule' ? 'bg-[#f48771]/10 text-[#f48771] border-[#f48771]/30' :
                    t.effect === 'NoExecute' ? 'bg-[#f48771]/20 text-[#f48771] border-[#f48771]/40' :
                      t.effect === 'PreferNoSchedule' ? 'bg-[#cca700]/10 text-[#cca700] border-[#cca700]/30' :
                        'bg-[#252526] text-[#cccccc] border-[#3e3e42]'
                    }`} title={`Effect: ${t.effect}${t.value ? `, Value: ${t.value}` : ''}`}>
                    {t.key}={t.value || ''}:{t.effect}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Addresses */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-1">Addresses</h4>
            <div className="flex flex-wrap gap-1.5">
              {addresses.map((a: any, i: number) => (
                <span key={i} className="px-1.5 py-0.5 bg-[#252526] border border-[#3e3e42] rounded text-[10px] font-mono text-[#cccccc]" title={a.address}>{a.type}:{a.address}</span>
              ))}
              {addresses.length === 0 && <span className="text-[#858585] italic">No addresses</span>}
            </div>
          </div>

          {/* Capacity vs Allocatable with Progress Bars */}
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-[#858585] font-bold mb-2">Resources</h4>
            <div className="space-y-3">
              {/* CPU */}
              <div>
                <div className="flex justify-between text-[11px] mb-1">
                  <span className="text-[#858585]">CPU</span>
                  <span className="font-mono text-[#cccccc]">{alloc.cpu} / {capacity.cpu} <span className="text-[#858585]">({cpuReservedPct}% reserved)</span></span>
                </div>
                <div className="h-2 bg-[#252526] rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-cyan-500 to-blue-500" style={{ width: `${100 - cpuReservedPct}%` }} />
                </div>
              </div>
              {/* Memory */}
              <div>
                <div className="flex justify-between text-[11px] mb-1">
                  <span className="text-[#858585]">Memory</span>
                  <span className="font-mono text-[#cccccc]">{alloc.memory} / {capacity.memory} <span className="text-[#858585]">({memReservedPct}% reserved)</span></span>
                </div>
                <div className="h-2 bg-[#252526] rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-purple-500 to-pink-500" style={{ width: `${100 - memReservedPct}%` }} />
                </div>
              </div>
              {/* Pods */}
              <div>
                <div className="flex justify-between text-[11px] mb-1">
                  <span className="text-[#858585]">Pods</span>
                  <span className="font-mono text-[#cccccc]">{podsAllocatable} / {podsCapacity} allocatable</span>
                </div>
              </div>
              {/* Ephemeral Storage */}
              {capacity['ephemeral-storage'] && (
                <div className="flex justify-between text-[11px]">
                  <span className="text-[#858585]">Ephemeral Storage</span>
                  <span className="font-mono text-[#cccccc]">{alloc['ephemeral-storage']} / {capacity['ephemeral-storage']}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'persistentvolumeclaim') {
    return (
      <CollapsibleSection title="PVC Spec" icon={<HardDrive size={14} />}>
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div><span className="block text-[#858585] mb-1">Storage Class</span><span className="font-mono text-[#cccccc]">{spec.storageClassName || '-'}</span></div>
          <div><span className="block text-[#858585] mb-1">Access Modes</span><span className="font-mono text-[#cccccc]">{Array.isArray(spec.accessModes) ? spec.accessModes.join(', ') : '-'}</span></div>
          <div><span className="block text-[#858585] mb-1">Requested</span><span className="font-mono text-[#cccccc]">{spec.resources?.requests?.storage || '-'}</span></div>
          <div><span className="block text-[#858585] mb-1">Phase</span><span className="font-mono text-[#cccccc]">{status.phase || '-'}</span></div>
          <div className="col-span-2"><span className="block text-[#858585] mb-1">Capacity</span><span className="font-mono text-[#cccccc]">{status.capacity?.storage || '-'}</span></div>
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'configmap') {
    const configData = fullObject.data || {};
    const binaryData = fullObject.binaryData || {};
    const keys = Object.keys(configData);
    const binaryKeys = Object.keys(binaryData);
    const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

    // Calculate total size
    const totalSize = keys.reduce((acc, key) => acc + (configData[key]?.length || 0), 0);
    const binarySize = binaryKeys.reduce((acc, key) => acc + (binaryData[key]?.length || 0), 0);
    const formatSize = (bytes: number) => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const toggleVisibility = (key: string) => {
      setVisibleKeys(prev => {
        const updated = new Set(prev);
        if (updated.has(key)) {
          updated.delete(key);
        } else {
          updated.add(key);
        }
        return updated;
      });
    };

    const copyToClipboard = (text: string) => {
      navigator.clipboard.writeText(text).catch(() => { });
    };

    // Detect file type from key name
    const getFileType = (key: string) => {
      if (key.endsWith('.yaml') || key.endsWith('.yml')) return 'yaml';
      if (key.endsWith('.json')) return 'json';
      if (key.endsWith('.properties')) return 'properties';
      if (key.endsWith('.conf') || key.endsWith('.cfg')) return 'config';
      if (key.endsWith('.sh')) return 'shell';
      if (key.endsWith('.xml')) return 'xml';
      if (key.endsWith('.env')) return 'env';
      return 'text';
    };

    return (
      <CollapsibleSection title="ConfigMap Data" icon={<FileCog size={14} />}>
        <div className="space-y-3">
          {/* Stats */}
          <div className="flex flex-wrap gap-3 text-xs">
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Keys: </span>
              <span className="font-mono text-cyan-400">{keys.length}</span>
            </div>
            {binaryKeys.length > 0 && (
              <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
                <span className="text-[#858585]">Binary Keys: </span>
                <span className="font-mono text-purple-400">{binaryKeys.length}</span>
              </div>
            )}
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Total Size: </span>
              <span className="font-mono text-[#cccccc]">{formatSize(totalSize + binarySize)}</span>
            </div>
          </div>

          {keys.length === 0 && binaryKeys.length === 0 && <span className="text-[#858585] italic text-xs">No data</span>}
          {keys.map(key => {
            const isVisible = visibleKeys.has(key);
            const value = configData[key];
            const preview = typeof value === 'string' ? value.substring(0, 100) : String(value).substring(0, 100);
            const fileType = getFileType(key);
            const lineCount = (value?.match(/\n/g) || []).length + 1;
            return (
              <div key={key} className="bg-[#1e1e1e] border border-[#3e3e42] rounded p-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-[#cccccc] font-bold">{key}</span>
                    <span className="px-1.5 py-0.5 bg-[#3e3e42] rounded text-[9px] text-[#858585]">{fileType}</span>
                    <span className="text-[9px] text-[#858585]">{formatSize(value?.length || 0)} • {lineCount} lines</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {isVisible && (
                      <button
                        onClick={() => copyToClipboard(value)}
                        className="px-2 py-0.5 bg-[#252526] hover:bg-[#3e3e42] border border-[#3e3e42] rounded text-[10px] text-[#cccccc] transition-colors"
                        title="Copy value"
                      >
                        Copy
                      </button>
                    )}
                    <button
                      onClick={() => toggleVisibility(key)}
                      className="px-2 py-0.5 bg-[#007acc] hover:bg-[#005a9e] rounded text-[10px] text-white transition-colors flex items-center gap-1"
                    >
                      <Eye size={10} />
                      {isVisible ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
                {isVisible ? (
                  <div className="bg-[#252526] p-2 rounded border border-[#3e3e42] font-mono text-[10px] text-[#cccccc] break-all whitespace-pre-wrap max-h-96 overflow-auto">
                    {value}
                  </div>
                ) : (
                  <div className="bg-[#252526] p-2 rounded border border-[#3e3e42] font-mono text-[10px] text-[#858585] break-all">
                    {preview}{value?.length > 100 ? '...' : ''}
                  </div>
                )}
              </div>
            );
          })}
          {/* Binary data */}
          {binaryKeys.map(key => (
            <div key={key} className="bg-[#1e1e1e] border border-[#3e3e42] rounded p-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-[#cccccc] font-bold">{key}</span>
                <span className="px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded text-[9px]">binary</span>
                <span className="text-[9px] text-[#858585]">{formatSize(binaryData[key]?.length || 0)}</span>
              </div>
            </div>
          ))}
        </div>
      </CollapsibleSection>
    );
  }

  if (k === 'secret') {
    const secretData = fullObject.data || {};
    const secretType = fullObject.type || 'Opaque';
    const keys = Object.keys(secretData);
    const [decodedValues, setDecodedValues] = useState<Record<string, string>>({});
    const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

    // Calculate decoded sizes
    const getDecodedSize = (encoded: string) => {
      try {
        return atob(encoded).length;
      } catch {
        return 0;
      }
    };
    const totalEncodedSize = keys.reduce((acc, key) => acc + (secretData[key]?.length || 0), 0);
    const totalDecodedSize = keys.reduce((acc, key) => acc + getDecodedSize(secretData[key] || ''), 0);

    const formatSize = (bytes: number) => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const decodeBase64 = (encoded: string): string => {
      try {
        return atob(encoded);
      } catch {
        return '[Invalid Base64]';
      }
    };

    const toggleVisibility = (key: string) => {
      setVisibleKeys(prev => {
        const updated = new Set(prev);
        if (updated.has(key)) {
          updated.delete(key);
        } else {
          updated.add(key);
          if (!decodedValues[key]) {
            setDecodedValues(prev => ({
              ...prev,
              [key]: decodeBase64(secretData[key])
            }));
          }
        }
        return updated;
      });
    };

    const copyToClipboard = (text: string) => {
      navigator.clipboard.writeText(text).catch(() => { });
    };

    // Detect common key types
    const getKeyType = (key: string) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('password') || lowerKey.includes('passwd')) return { type: 'password', color: 'text-red-400' };
      if (lowerKey.includes('token') || lowerKey.includes('bearer')) return { type: 'token', color: 'text-orange-400' };
      if (lowerKey.includes('key') || lowerKey.includes('secret')) return { type: 'key', color: 'text-yellow-400' };
      if (lowerKey.includes('cert') || lowerKey.includes('crt') || lowerKey.includes('pem')) return { type: 'cert', color: 'text-blue-400' };
      if (lowerKey.includes('ca')) return { type: 'ca', color: 'text-blue-400' };
      if (lowerKey.includes('user') || lowerKey.includes('username')) return { type: 'user', color: 'text-green-400' };
      if (lowerKey.includes('host') || lowerKey.includes('endpoint') || lowerKey.includes('url')) return { type: 'endpoint', color: 'text-cyan-400' };
      return { type: 'data', color: 'text-[#858585]' };
    };

    // Get secret type color and label
    const getSecretTypeInfo = (type: string) => {
      if (type === 'kubernetes.io/tls') return { label: 'TLS', color: 'bg-blue-500/20 text-blue-400' };
      if (type === 'kubernetes.io/dockerconfigjson') return { label: 'Docker', color: 'bg-purple-500/20 text-purple-400' };
      if (type === 'kubernetes.io/service-account-token') return { label: 'SA Token', color: 'bg-orange-500/20 text-orange-400' };
      if (type === 'kubernetes.io/basic-auth') return { label: 'Basic Auth', color: 'bg-yellow-500/20 text-yellow-400' };
      if (type === 'kubernetes.io/ssh-auth') return { label: 'SSH', color: 'bg-green-500/20 text-green-400' };
      return { label: 'Opaque', color: 'bg-[#3e3e42] text-[#858585]' };
    };

    const typeInfo = getSecretTypeInfo(secretType);

    return (
      <CollapsibleSection title="Secret Data" icon={<Shield size={14} />}>
        <div className="space-y-3">
          {/* Stats */}
          <div className="flex flex-wrap gap-3 text-xs">
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Type: </span>
              <span className={`px-1.5 py-0.5 rounded text-[9px] ${typeInfo.color}`}>{typeInfo.label}</span>
            </div>
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Keys: </span>
              <span className="font-mono text-cyan-400">{keys.length}</span>
            </div>
            <div className="px-2 py-1 bg-[#252526] rounded border border-[#3e3e42]">
              <span className="text-[#858585]">Size: </span>
              <span className="font-mono text-[#cccccc]">{formatSize(totalDecodedSize)}</span>
              <span className="text-[#585858] ml-1">(decoded)</span>
            </div>
          </div>

          {keys.length === 0 && <span className="text-[#858585] italic text-xs">No keys</span>}
          {keys.map(key => {
            const isVisible = visibleKeys.has(key);
            const decodedValue = decodedValues[key];
            const keyType = getKeyType(key);
            const decodedSize = getDecodedSize(secretData[key] || '');
            return (
              <div key={key} className="bg-[#1e1e1e] border border-[#3e3e42] rounded p-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-[#cccccc] font-bold">{key}</span>
                    <span className={`px-1.5 py-0.5 bg-[#3e3e42] rounded text-[9px] ${keyType.color}`}>{keyType.type}</span>
                    <span className="text-[9px] text-[#858585]">{formatSize(decodedSize)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {isVisible && (
                      <button
                        onClick={() => copyToClipboard(decodedValue)}
                        className="px-2 py-0.5 bg-[#252526] hover:bg-[#3e3e42] border border-[#3e3e42] rounded text-[10px] text-[#cccccc] transition-colors"
                        title="Copy decoded value"
                      >
                        Copy
                      </button>
                    )}
                    <button
                      onClick={() => toggleVisibility(key)}
                      className="px-2 py-0.5 bg-[#007acc] hover:bg-[#005a9e] rounded text-[10px] text-white transition-colors flex items-center gap-1"
                    >
                      <Eye size={10} />
                      {isVisible ? 'Hide' : 'Decode & Show'}
                    </button>
                  </div>
                </div>
                {isVisible ? (
                  <div className="bg-[#252526] p-2 rounded border border-[#3e3e42] font-mono text-[10px] text-[#cccccc] break-all whitespace-pre-wrap max-h-48 overflow-auto">
                    {decodedValue}
                  </div>
                ) : (
                  <div className="bg-[#252526] p-2 rounded border border-[#3e3e42] font-mono text-[10px] text-[#858585] break-all">
                    ••••••••••••••••
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CollapsibleSection>
    );
  }

  // Generic fallback
  if (spec && Object.keys(spec).length > 0) {
    return (
      <CollapsibleSection title="Spec" icon={<FileCog size={14} />}>
        <div className="space-y-0.5 text-[11px] font-mono">
          {renderKV(spec)}
        </div>
      </CollapsibleSection>
    );
  }
  return null;
}

function LogsTab({ namespace, name, podSpec }: { namespace: string, name: string, podSpec: any }) {
  const [selectedContainer, setSelectedContainer] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [allLogs, setAllLogs] = useState<string[]>([]); // Store all log lines
  const [isStreaming, setIsStreaming] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [wrapLines, setWrapLines] = useState(false);
  const [fontSize, setFontSize] = useState<'xs' | 'sm' | 'base'>('xs');
  const [error, setError] = useState<string | null>(null);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const matchRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const sessionIdRef = useRef<string>(`log-${Math.random().toString(36).substr(2, 9)}`);
  const streamActiveRef = useRef<boolean>(false);

  // Extract containers from spec
  const containers = [
    ...(podSpec?.containers || []).map((c: any) => c.name),
    ...(podSpec?.initContainers || []).map((c: any) => c.name)
  ];

  // Set default container
  useEffect(() => {
    if (containers.length > 0 && !selectedContainer) {
      setSelectedContainer(containers[0]);
    }
  }, [containers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start streaming - ONLY depends on container change, NOT on pause state
  useEffect(() => {
    if (!selectedContainer) return;

    // Generate new session ID for new container
    const sessionId = `log-${namespace}-${name}-${selectedContainer}-${Date.now()}`;
    sessionIdRef.current = sessionId;

    setError(null);
    setIsStreaming(true);
    setAllLogs([]); // Clear logs only on container change
    streamActiveRef.current = true;

    invoke("start_log_stream", { namespace, name, container: selectedContainer, sessionId })
      .catch((err: any) => {
        setError(String(err));
        setIsStreaming(false);
        streamActiveRef.current = false;
      });

    let unlistenFn: (() => void) | null = null;
    let unlistenEndFn: (() => void) | null = null;

    const setupListeners = async () => {
      unlistenFn = await listen<string>(`log_stream:${sessionId}`, (event) => {
        if (!streamActiveRef.current) return;
        // Append new log lines
        const newLines = event.payload.split('\n').filter(line => line.length > 0);
        if (newLines.length > 0) {
          setAllLogs(prev => [...prev, ...newLines]);
        }
      });

      unlistenEndFn = await listen(`log_stream_end:${sessionId}`, () => {
        setIsStreaming(false);
        streamActiveRef.current = false;
      });
    };

    setupListeners();

    return () => {
      streamActiveRef.current = false;
      if (unlistenFn) unlistenFn();
      if (unlistenEndFn) unlistenEndFn();
      invoke("stop_log_stream", { sessionId }).catch(() => { });
      setIsStreaming(false);
    };
  }, [namespace, name, selectedContainer]);

  // Filter logs based on search - this is separate from streaming
  const { filteredLogLines, matchingIndices } = useMemo(() => {
    if (!searchQuery.trim()) {
      return { filteredLogLines: allLogs, matchingIndices: [] as number[] };
    }
    const query = searchQuery.toLowerCase();
    const indices: number[] = [];
    const filtered = allLogs.filter((line, idx) => {
      const matches = line.toLowerCase().includes(query);
      if (matches) indices.push(idx);
      return matches;
    });
    return { filteredLogLines: filtered, matchingIndices: indices };
  }, [allLogs, searchQuery]);

  // Reset match index when search changes
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [searchQuery]);

  // Auto-scroll to bottom when new logs come in (only if not searching and autoFollow is on)
  useEffect(() => {
    if (autoFollow && !searchQuery && scrollRef.current && !isPaused) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [allLogs, autoFollow, searchQuery, isPaused]);

  // Navigate to current match
  const navigateToMatch = useCallback((index: number) => {
    if (matchRefs.current[index]) {
      matchRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  // Navigation functions
  const goToNextMatch = useCallback(() => {
    if (filteredLogLines.length === 0) return;
    const newIndex = (currentMatchIndex + 1) % filteredLogLines.length;
    setCurrentMatchIndex(newIndex);
    navigateToMatch(newIndex);
  }, [currentMatchIndex, filteredLogLines.length, navigateToMatch]);

  const goToPrevMatch = useCallback(() => {
    if (filteredLogLines.length === 0) return;
    const newIndex = currentMatchIndex === 0 ? filteredLogLines.length - 1 : currentMatchIndex - 1;
    setCurrentMatchIndex(newIndex);
    navigateToMatch(newIndex);
  }, [currentMatchIndex, filteredLogLines.length, navigateToMatch]);

  const totalLogCount = allLogs.length;
  const matchCount = searchQuery ? filteredLogLines.length : 0;

  // Highlight search matches in log line
  const highlightMatches = (line: string) => {
    if (!searchQuery) return line;
    const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = line.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? <mark key={i} className="bg-yellow-500/40 text-yellow-200 px-0.5 rounded">{part}</mark> : part
    );
  };

  // Color code log levels
  const getLineColor = (line: string) => {
    const lower = line.toLowerCase();
    if (lower.includes('error') || lower.includes('fatal') || lower.includes('panic')) return 'text-red-400';
    if (lower.includes('warn')) return 'text-yellow-400';
    if (lower.includes('info')) return 'text-blue-400';
    if (lower.includes('debug')) return 'text-zinc-500';
    return 'text-[#cccccc]';
  };

  const fontSizeClass = fontSize === 'xs' ? 'text-xs' : fontSize === 'sm' ? 'text-sm' : 'text-base';

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Top toolbar */}
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <label className="text-[10px] uppercase font-bold text-[#858585]">Container:</label>
        <div className="relative">
          <select
            value={selectedContainer}
            onChange={(e) => setSelectedContainer(e.target.value)}
            className="bg-[#252526] border border-[#3e3e42] text-[#cccccc] text-xs rounded pl-2 pr-6 py-1 appearance-none focus:border-[#007acc] focus:outline-none"
          >
            {containers.map((c: string) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[#858585]">
            <ChevronDown size={10} />
          </div>
        </div>

        <div className="h-4 w-px bg-zinc-700" />

        {/* Controls */}
        <button
          onClick={() => setIsPaused(!isPaused)}
          className={`px-2 py-1 text-xs rounded border transition-colors flex items-center gap-1 ${isPaused ? 'bg-yellow-600/10 border-yellow-600/50 text-yellow-400 hover:bg-yellow-600/20' : 'bg-green-600/10 border-green-600/50 text-green-400 hover:bg-green-600/20'}`}
          title={isPaused ? 'Resume streaming' : 'Pause streaming'}
        >
          {isPaused ? <Play size={10} /> : <Square size={10} />}
          {isPaused ? 'Resume' : 'Streaming'}
        </button>

        <button
          onClick={() => setAutoFollow(!autoFollow)}
          className={`px-2 py-1 text-xs rounded border transition-colors ${autoFollow ? 'bg-blue-600/10 border-blue-600/50 text-blue-400 hover:bg-blue-600/20' : 'bg-gray-600/10 border-gray-600/50 text-gray-400 hover:bg-gray-600/20'}`}
          title={autoFollow ? 'Disable auto-scroll' : 'Enable auto-scroll'}
        >
          {autoFollow ? '↓ Follow' : 'Follow Off'}
        </button>

        <div className="h-4 w-px bg-zinc-700" />

        {/* View options */}
        <button
          onClick={() => setShowLineNumbers(!showLineNumbers)}
          className={`px-2 py-1 text-xs rounded border transition-colors ${showLineNumbers ? 'bg-purple-600/10 border-purple-600/50 text-purple-400' : 'bg-gray-600/10 border-gray-600/50 text-gray-400'}`}
          title="Toggle line numbers"
        >
          #
        </button>

        <button
          onClick={() => setWrapLines(!wrapLines)}
          className={`px-2 py-1 text-xs rounded border transition-colors ${wrapLines ? 'bg-purple-600/10 border-purple-600/50 text-purple-400' : 'bg-gray-600/10 border-gray-600/50 text-gray-400'}`}
          title="Toggle line wrap"
        >
          ↵
        </button>

        <select
          value={fontSize}
          onChange={(e) => setFontSize(e.target.value as 'xs' | 'sm' | 'base')}
          className="bg-[#252526] border border-[#3e3e42] text-[#cccccc] text-xs rounded px-2 py-1 appearance-none focus:border-[#007acc] focus:outline-none"
          title="Font size"
        >
          <option value="xs">Small</option>
          <option value="sm">Medium</option>
          <option value="base">Large</option>
        </select>

        {/* Live status */}
        <div className="text-xs flex items-center gap-1">
          {error ? (
            <span className="flex items-center gap-1 text-red-400"><AlertCircle size={12} /> Error</span>
          ) : (
            <span className={`flex items-center gap-1 ${isStreaming && !isPaused ? 'text-green-400' : 'text-zinc-500'}`}>
              <div className={`w-2 h-2 rounded-full ${isStreaming && !isPaused ? 'bg-green-400 animate-pulse' : 'bg-zinc-600'}`} />
              {isStreaming && !isPaused ? 'Live' : isPaused ? 'Paused' : 'Idle'}
            </span>
          )}
        </div>

        {/* Line count */}
        <div className="text-xs text-zinc-500">
          {totalLogCount.toLocaleString()} lines
          {searchQuery && <span className="text-zinc-600"> ({matchCount} matches)</span>}
        </div>

        {/* Search Input */}
        <div className="relative flex-1 max-w-xs ml-auto flex items-center gap-1">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 text-[#858585]" size={12} />
            <input
              type="text"
              placeholder="Filter logs... (streaming continues)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.shiftKey ? goToPrevMatch() : goToNextMatch();
                }
                if (e.key === 'Escape') {
                  setSearchQuery('');
                }
              }}
              className="w-full bg-[#252526] border border-[#3e3e42] rounded pl-8 pr-16 py-1 text-xs text-[#cccccc] focus:border-[#007acc] focus:outline-none"
            />
            {searchQuery && (
              <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
                <span className="text-[10px] text-zinc-500">
                  {matchCount > 0 ? `${currentMatchIndex + 1}/${matchCount}` : '0/0'}
                </span>
                <button
                  onClick={goToPrevMatch}
                  className="p-0.5 hover:bg-zinc-700 rounded text-zinc-400 hover:text-white"
                  title="Previous match (Shift+Enter)"
                  disabled={matchCount === 0}
                >
                  <ChevronUp size={12} />
                </button>
                <button
                  onClick={goToNextMatch}
                  className="p-0.5 hover:bg-zinc-700 rounded text-zinc-400 hover:text-white"
                  title="Next match (Enter)"
                  disabled={matchCount === 0}
                >
                  <ChevronDown size={12} />
                </button>
                <button
                  onClick={() => setSearchQuery('')}
                  className="p-0.5 hover:bg-zinc-700 rounded text-zinc-400 hover:text-white"
                  title="Clear search (Esc)"
                >
                  <X size={12} />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Clear logs */}
        <button
          onClick={() => setAllLogs([])}
          className="px-2 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-600 transition-colors"
          title="Clear logs"
        >
          Clear
        </button>

        {/* Download logs */}
        <button
          onClick={() => {
            const blob = new Blob([allLogs.join('\n')], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${name}-${selectedContainer}-logs.txt`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="px-2 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-600 transition-colors"
          title="Download all logs"
        >
          <Save size={12} />
        </button>
      </div>

      {error && <div className="text-red-400 p-4 text-xs bg-red-500/10 border border-red-500/30 rounded">Failed to stream logs: {error}</div>}

      {/* Search active indicator */}
      {searchQuery && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-500/10 border border-blue-500/30 rounded text-xs text-blue-400">
          <Search size={12} />
          <span>Filtering for "{searchQuery}" - showing {matchCount} of {totalLogCount} lines</span>
          {isStreaming && <span className="text-green-400 flex items-center gap-1"><div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> Stream active</span>}
        </div>
      )}

      {/* Log viewer */}
      <div
        ref={scrollRef}
        className={`bg-[#0d0d0d] rounded border border-[#3e3e42] font-mono flex-1 overflow-auto ${fontSizeClass} ${wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}
      >
        {filteredLogLines.length === 0 ? (
          <div className="p-4 text-zinc-500 text-center">
            {isStreaming ? "Waiting for logs..." : allLogs.length > 0 ? "No matches found" : "No logs available."}
          </div>
        ) : (
          <table className="w-full">
            <tbody>
              {filteredLogLines.map((line, i) => (
                <tr
                  key={i}
                  ref={(el) => { matchRefs.current[i] = el; }}
                  className={`hover:bg-white/5 group ${searchQuery && i === currentMatchIndex ? 'bg-yellow-500/20' : ''}`}
                >
                  {showLineNumbers && (
                    <td className="px-2 py-0.5 text-right text-zinc-600 select-none border-r border-zinc-800 sticky left-0 bg-[#0d0d0d] group-hover:bg-zinc-900/50 w-12">
                      {searchQuery ? matchingIndices[i] + 1 : i + 1}
                    </td>
                  )}
                  <td className={`px-3 py-0.5 ${getLineColor(line)} leading-relaxed`}>
                    {highlightMatches(line)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function EventsTab({ namespace, name, uid, currentContext }: { namespace: string, name: string, uid: string, currentContext?: string }) {
  const [expandedExplanations, setExpandedExplanations] = useState<Record<number, string>>({});
  const [loadingExplanations, setLoadingExplanations] = useState<Record<number, boolean>>({});

  const { data: events, isLoading, isFetching } = useQuery({
    queryKey: ["events", currentContext, namespace, name, uid],
    queryFn: async () => await invoke<K8sEvent[]>("list_events", { namespace, name, uid }),
    refetchInterval: 8000,
    refetchIntervalInBackground: true,
  });

  const explainEvent = async (index: number, event: K8sEvent) => {
    setLoadingExplanations(prev => ({ ...prev, [index]: true }));
    try {
      const context = `
Event Type: ${event.type_}
Reason: ${event.reason}
Message: ${event.message}
Count: ${event.count}
Resource: ${name} (namespace: ${namespace})
`;
      const answer = await invoke<string>("call_local_llm", {
        prompt: `Analyze this Kubernetes event and explain what it means, why it might be happening, and suggest potential solutions:\n\n${context}`,
        systemPrompt: "You are a Kubernetes SRE assistant. Provide concise, actionable explanations for Kubernetes events. Focus on root causes and practical solutions.",
      });
      setExpandedExplanations(prev => ({ ...prev, [index]: answer }));
    } catch (err) {
      setExpandedExplanations(prev => ({ ...prev, [index]: `Error: ${err}` }));
    } finally {
      setLoadingExplanations(prev => ({ ...prev, [index]: false }));
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8 gap-2 text-xs text-[#007acc]">
        <Loader2 className="animate-spin" size={20} /> Loading events
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <span className={`inline-flex items-center gap-1.5 ${isFetching ? 'text-[#007acc]' : 'text-[#89d185]'}`}>
          <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${isFetching ? 'bg-[#007acc] animate-pulse' : 'bg-[#89d185]'}`} />
          {isFetching ? 'Live (updating)' : 'Live'}
        </span>
      </div>
      {!events || events.length === 0 && (
        <div className="text-[#858585] text-center p-8 text-xs">No events found for this resource.</div>
      )}
      {events && events.length > 0 && events.map((ev, i) => (
        <div key={i} className="bg-[#1e1e1e] p-3 rounded border border-[#3e3e42]">
          <div className="flex items-center justify-between text-xs">
            <span className={`inline-flex items-center gap-1 ${ev.type_ === 'Warning' ? 'text-[#cca700]' : 'text-[#89d185]'}`}>
              <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${ev.type_ === 'Warning' ? 'bg-[#cca700]' : 'bg-[#89d185]'}`} />
              {ev.type_}
            </span>
            <span className="text-[10px] text-[#858585]">{new Date(ev.age).toLocaleString()}</span>
          </div>
          <div className="mt-1">
            <span className="font-medium text-xs text-[#cccccc]">{ev.reason}</span>
            {ev.count > 1 && <span className="ml-2 text-[10px] bg-[#3e3e42] px-1.5 py-0.5 rounded text-[#cccccc]">x{ev.count}</span>}
          </div>
          <p className="text-xs text-[#858585] break-words leading-snug mt-1">{ev.message}</p>

          {/* Explain button */}
          <div className="mt-2">
            <button
              onClick={() => expandedExplanations[i] ? setExpandedExplanations(prev => { const n = { ...prev }; delete n[i]; return n; }) : explainEvent(i, ev)}
              disabled={loadingExplanations[i]}
              className="text-xs text-purple-400 hover:text-purple-300 disabled:text-purple-600 flex items-center gap-1"
            >
              {loadingExplanations[i] ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Analyzing...
                </>
              ) : expandedExplanations[i] ? (
                <>Hide Explanation</>
              ) : (
                <>🤖 Explain</>
              )}
            </button>
            {expandedExplanations[i] && !loadingExplanations[i] && (
              <div className="mt-2 p-2 bg-[#252526] border border-[#3e3e42] rounded text-xs text-[#cccccc] leading-relaxed">
                <pre className="whitespace-pre-wrap font-sans">{expandedExplanations[i]}</pre>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function YamlTab({ resource, currentContext }: { resource: K8sObject, currentContext?: string }) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const editorRef = useRef<any>(null);
  const decorationsRef = useRef<string[]>([]);
  const qc = useQueryClient();

  // Fetch full resource details on-demand
  const { data: yamlContent, isLoading } = useQuery({
    queryKey: ["resource_details", currentContext, resource.namespace, resource.group, resource.version, resource.kind, resource.name],
    queryFn: async () => {
      if (resource.raw_json && resource.raw_json.trim() !== "") return resource.raw_json;
      return await invoke<string>("get_resource_details", {
        req: {
          group: resource.group,
          version: resource.version,
          kind: resource.kind,
          namespace: resource.namespace !== "-" ? resource.namespace : null
        },
        name: resource.name
      });
    },
    staleTime: 30000,
  });

  const [content, setContent] = useState("");

  // Update content when yamlContent loads
  useEffect(() => {
    if (yamlContent) {
      setContent(yamlContent);
    }
  }, [yamlContent]);

  // Search Logic
  useEffect(() => {
    if (!editorRef.current) return;

    const editor = editorRef.current;
    const model = editor.getModel();

    if (!searchQuery) {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
      return;
    }

    const matches = model.findMatches(searchQuery, false, false, false, null, true);

    if (matches.length > 0) {
      // Highlight all matches
      const newDecorations = matches.map((match: any) => ({
        range: match.range,
        options: {
          isWholeLine: false,
          className: 'myContentClass', // We'll rely on inline styles or global css if needed, but monaco supports inlineClassName
          inlineClassName: 'bg-yellow-500/40 text-white font-bold'
        }
      }));

      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, newDecorations);

      // Scroll to first match
      editor.revealRangeInCenter(matches[0].range);
    } else {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
    }
  }, [searchQuery]);

  const handleEditorDidMount = (editor: any) => {
    editorRef.current = editor;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="animate-spin text-[#007acc]" size={24} />
      </div>
    );
  }

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await invoke("apply_yaml", {
        namespace: resource.namespace,
        kind: resource.kind,
        name: resource.name,
        yamlContent: content
      });

      qc.invalidateQueries({ queryKey: ["resources"] });
      qc.invalidateQueries({ queryKey: ["discovery"] }); // In case CRDs changed

      // Show success feedback (could be a toast, but for now just clear loading)
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] border border-[#3e3e42] rounded overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-[#252526] border-b border-[#3e3e42]">
        <div className="flex items-center gap-4">
          <span className="text-xs text-[#858585]">Edits are applied via Server-Side Apply</span>
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1.5 text-gray-500" />
            <input
              type="text"
              placeholder="Search in YAML..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-[#1e1e1e] border border-[#3e3e42] rounded pl-7 pr-2 py-1 text-xs text-[#cccccc] focus:outline-none focus:border-[#007acc]"
            />
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setContent(yamlContent || "")}
            className="px-3 py-1 text-xs text-[#cccccc] hover:bg-[#3e3e42] rounded transition-colors"
            disabled={isSaving}
          >
            Reset
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-3 py-1 text-xs bg-[#007acc] hover:bg-[#0062a3] text-white rounded transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isSaving ? <Loader2 className="animate-spin" size={12} /> : <Save size={12} />}
            Save
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-[#f48771]/10 text-[#f48771] px-4 py-2 text-xs border-b border-[#f48771]/20">
          Error: {error}
        </div>
      )}

      <div className="flex-1 relative">
        <Editor
          height="100%"
          defaultLanguage="json"
          value={content}
          onChange={(val) => setContent(val || "")}
          onMount={handleEditorDidMount}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          }}
        />
      </div>
    </div>
  );
}

const StatusBadge = ({ status }: { status: string }) => {
  const getStyles = () => {
    switch (status) {
      case 'Active':
      case 'Running':
      case 'Bound':
      case 'Ready':
        return 'bg-green-500/20 text-green-400 border-green-500/40 shadow-sm shadow-green-500/20';
      case 'Pending':
      case 'ContainerCreating':
      case 'Terminating':
        return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40 shadow-sm shadow-yellow-500/20';
      case 'CrashLoopBackOff':
      case 'Error':
      case 'Failed':
        return 'bg-red-500/20 text-red-400 border-red-500/40 shadow-sm shadow-red-500/20';
      default:
        return 'bg-gray-500/20 text-gray-400 border-gray-500/40';
    }
  };

  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${getStyles()} inline-flex items-center gap-1`}>
      <span className={`w-1 h-1 rounded-full ${getStyles().split(' ')[1].replace('text-', 'bg-')}`} />
      {status}
    </span>
  );
};

// --- Port Forwarding ---

function PortForwardModal({ isOpen, onClose, namespace, podName }: { isOpen: boolean, onClose: () => void, namespace: string, podName: string }) {
  const [localPort, setLocalPort] = useState("");
  const [podPort, setPodPort] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const handleStart = async () => {
    setIsLoading(true);
    setError(null);
    try {
      await invoke("start_port_forward", {
        namespace,
        name: podName,
        localPort: parseInt(localPort),
        podPort: parseInt(podPort)
      });
      qc.invalidateQueries({ queryKey: ["portforwards"] });
      onClose();
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#252526] border border-[#3e3e42] rounded-lg p-6 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-white mb-4">Port Forward</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-[#858585] mb-1.5 uppercase tracking-wide">Local Port</label>
            <input
              type="number"
              value={localPort}
              onChange={e => setLocalPort(e.target.value)}
              className="w-full bg-[#3c3c3c] border border-[#3e3e42] rounded px-3 py-2 text-sm text-[#cccccc] focus:outline-none focus:border-[#007acc]"
              placeholder="e.g. 8080"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#858585] mb-1.5 uppercase tracking-wide">Pod Port</label>
            <input
              type="number"
              value={podPort}
              onChange={e => setPodPort(e.target.value)}
              className="w-full bg-[#3c3c3c] border border-[#3e3e42] rounded px-3 py-2 text-sm text-[#cccccc] focus:outline-none focus:border-[#007acc]"
              placeholder="e.g. 80"
            />
          </div>

          {error && (
            <div className="text-[#f48771] text-xs bg-[#f48771]/10 p-2 rounded border border-[#f48771]/20">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 mt-6">
            <button onClick={onClose} className="px-4 py-2 text-sm text-[#cccccc] hover:bg-[#3e3e42] rounded transition-colors">Cancel</button>
            <button
              onClick={handleStart}
              disabled={isLoading || !localPort || !podPort}
              className="px-4 py-2 text-sm bg-[#007acc] hover:bg-[#0062a3] text-white rounded transition-colors disabled:opacity-50"
            >
              {isLoading ? "Starting..." : "Start Forwarding"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PortForwardList({ currentContext }: { currentContext?: string }) {
  const qc = useQueryClient();
  const { data: forwards } = useQuery({
    queryKey: ["portforwards", currentContext],
    queryFn: async () => await invoke<any[]>("list_port_forwards"),
    refetchInterval: 5000,
  });

  const stopMutation = useMutation({
    mutationFn: async (id: string) => {
      await invoke("stop_port_forward", { sessionId: id });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["portforwards"] });
    }
  });

  if (!forwards || forwards.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2">
      {forwards.map(pf => (
        <div key={pf.id} className="bg-[#252526] border border-[#3e3e42] rounded-md shadow-lg p-3 flex items-center gap-4 animate-in slide-in-from-bottom-5">
          <div className="flex flex-col">
            <span className="text-xs font-medium text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#89d185] animate-pulse" />
              {pf.local_port} → {pf.pod_port}
            </span>
            <span className="text-[10px] text-[#858585]">{pf.pod_name}</span>
          </div>
          <button
            onClick={() => stopMutation.mutate(pf.id)}
            className="p-1 text-[#858585] hover:text-[#f48771] hover:bg-[#3e3e42] rounded transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}



// --- Helm Integration ---

interface HelmRelease {
  name: string;
  namespace: string;
  revision: string;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
}

function HelmReleases({ currentContext }: { currentContext?: string }) {
  const qc = useQueryClient();
  const { data: releases, isLoading } = useQuery({
    queryKey: ["helm_releases", currentContext],
    queryFn: async () => await invoke<HelmRelease[]>("helm_list"),
    refetchInterval: 10000,
  });

  const uninstallMutation = useMutation({
    mutationFn: async (r: HelmRelease) => {
      if (confirm(`Uninstall ${r.name} from ${r.namespace}?`)) {
        await invoke("helm_uninstall", { namespace: r.namespace, name: r.name });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["helm_releases"] });
    }
  });

  if (isLoading) return <LoadingScreen message="Loading Helm Releases..." />;

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] text-[#cccccc]">
      <div className="h-12 border-b border-[#3e3e42] flex items-center px-4 bg-[#252526] shrink-0">
        <h2 className="font-semibold text-white">Helm Releases</h2>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {releases?.length === 0 && (
          <div className="text-center text-[#858585] mt-20">No Helm releases found.</div>
        )}
        <div className="grid grid-cols-1 gap-3">
          {releases?.map((r) => (
            <div key={`${r.namespace}/${r.name}`} className="bg-[#252526] border border-[#3e3e42] rounded p-4 flex items-center justify-between hover:border-[#505050] transition-colors">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-3">
                  <span className="font-bold text-white text-sm">{r.name}</span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${r.status === 'deployed' ? 'bg-[#89d185]/10 text-[#89d185] border-[#89d185]/20' : 'bg-[#f48771]/10 text-[#f48771] border-[#f48771]/20'}`}>
                    {r.status}
                  </span>
                </div>
                <div className="text-xs text-[#858585] flex gap-4">
                  <span>NS: {r.namespace}</span>
                  <span>Chart: {r.chart}</span>
                  <span>App v{r.app_version}</span>
                  <span>Rev: {r.revision}</span>
                </div>
                <div className="text-[10px] text-[#505050]">Updated: {r.updated}</div>
              </div>
              <button
                onClick={() => uninstallMutation.mutate(r)}
                className="p-2 text-[#858585] hover:text-[#f48771] hover:bg-[#3e3e42] rounded transition-colors"
                title="Uninstall Release"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AzurePage({ onConnect }: { onConnect: () => void }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedSubs, setExpandedSubs] = useState<Record<string, boolean>>({});

  const { data: subscriptions, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["azure_data"],
    queryFn: async () => await invoke<AzureSubscription[]>("refresh_azure_data"),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const connectMutation = useMutation({
    mutationFn: async ({ subId, cluster }: { subId: string, cluster: AksCluster }) => {
      await invoke("get_aks_credentials", {
        subscriptionId: subId,
        resourceGroup: cluster.resourceGroup,
        name: cluster.name
      });
    },
    onSuccess: () => {
      onConnect();
    },
  });

  // Filter Logic
  const filteredSubs = useMemo(() => {
    if (!subscriptions) return [];
    if (!searchQuery) return subscriptions;

    const lowerQuery = searchQuery.toLowerCase();
    return subscriptions.map(sub => {
      if (sub.name.toLowerCase().includes(lowerQuery) || sub.id.toLowerCase().includes(lowerQuery)) {
        return sub;
      }
      const matchingClusters = sub.clusters.filter(c =>
        c.name.toLowerCase().includes(lowerQuery) ||
        c.resourceGroup.toLowerCase().includes(lowerQuery)
      );

      if (matchingClusters.length > 0) {
        return { ...sub, clusters: matchingClusters };
      }

      return null;
    }).filter(Boolean) as AzureSubscription[];
  }, [subscriptions, searchQuery]);

  // Auto-expand if searching
  useEffect(() => {
    if (searchQuery && filteredSubs.length > 0) {
      const newExpanded: Record<string, boolean> = {};
      filteredSubs.forEach(s => newExpanded[s.id] = true);
      setExpandedSubs(newExpanded);
    }
  }, [searchQuery, filteredSubs]);

  const toggleSub = (id: string) => {
    setExpandedSubs(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // Calculate totals
  const totalClusters = subscriptions?.reduce((acc, sub) => acc + sub.clusters.length, 0) || 0;
  const runningClusters = subscriptions?.reduce((acc, sub) =>
    acc + sub.clusters.filter(c => c.powerState.code === 'Running').length, 0) || 0;

  if (isLoading) return <LoadingScreen message="Fetching Azure Data (this may take a moment)..." />;

  if (error) {
    const isLoginError = error.message.toLowerCase().includes("login");

    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-8 bg-gradient-to-br from-zinc-900 to-zinc-950">
        <div className="bg-gradient-to-br from-red-500/10 to-orange-500/5 p-10 rounded-2xl border border-red-500/20 max-w-md backdrop-blur-xl shadow-2xl">
          <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-red-500/20 to-orange-500/20 flex items-center justify-center border border-red-500/30">
            <AlertCircle size={32} className="text-red-400" />
          </div>
          <h3 className="text-xl font-bold text-white mb-3">Azure Connection Error</h3>
          <p className="text-zinc-400 text-sm mb-6 leading-relaxed">{error.message}</p>

          {isLoginError ? (
            <button
              onClick={async () => {
                try {
                  await invoke("azure_login");
                  refetch();
                } catch (e) {
                  console.error(e);
                  refetch();
                }
              }}
              className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 rounded-xl text-white font-medium shadow-lg shadow-blue-500/25 transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              <Cloud size={18} />
              Sign in to Azure
            </button>
          ) : (
            <button
              onClick={() => refetch()}
              className="inline-flex items-center gap-2 px-6 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-white font-medium transition-all"
            >
              <RefreshCw size={16} />
              Try Again
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-950">
      {/* Header */}
      <div className="border-b border-white/5 bg-black/20 backdrop-blur-xl shrink-0">
        <div className="px-6 py-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center shadow-lg shadow-blue-500/25">
                <Cloud className="text-white" size={24} />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">Azure Kubernetes Service</h2>
                <p className="text-sm text-zinc-500">Select a cluster to connect</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Stats Pills */}
              <div className="hidden md:flex items-center gap-2">
                <div className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 flex items-center gap-2">
                  <Server size={14} className="text-blue-400" />
                  <span className="text-xs font-medium text-zinc-300">{totalClusters} Clusters</span>
                </div>
                <div className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-xs font-medium text-emerald-300">{runningClusters} Running</span>
                </div>
              </div>

              <button
                onClick={() => refetch()}
                disabled={isRefetching}
                className="p-2.5 text-zinc-400 hover:text-white hover:bg-white/10 rounded-xl transition-all disabled:opacity-50 border border-transparent hover:border-white/10"
                title="Refresh Azure Data"
              >
                <RefreshCw size={18} className={isRefetching ? "animate-spin" : ""} />
              </button>
            </div>
          </div>

          {/* Search Bar */}
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" size={18} />
            <input
              type="text"
              placeholder="Search subscriptions, clusters, or resource groups..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl pl-12 pr-4 py-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500/50 transition-all"
            />
            {subscriptions && (
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-zinc-600">
                {filteredSubs.length} subscription{filteredSubs.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Subscription List */}
      <div className="flex-1 overflow-auto p-6 space-y-4">
        {filteredSubs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-4">
              <Search size={28} className="text-zinc-600" />
            </div>
            <p className="text-zinc-400 font-medium">
              {searchQuery ? "No matches found" : "No subscriptions available"}
            </p>
            <p className="text-sm text-zinc-600 mt-1">
              {searchQuery ? "Try a different search term" : "Make sure you're logged in to Azure"}
            </p>
          </div>
        ) : (
          filteredSubs.map(sub => (
            <div
              key={sub.id}
              className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden backdrop-blur-sm hover:border-white/20 transition-all"
            >
              {/* Subscription Header */}
              <button
                onClick={() => toggleSub(sub.id)}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-white/5 transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${expandedSubs[sub.id] ? 'bg-blue-500/20' : 'bg-white/5'}`}>
                    {expandedSubs[sub.id] ? (
                      <ChevronDown size={18} className="text-blue-400" />
                    ) : (
                      <ChevronRight size={18} className="text-zinc-500" />
                    )}
                  </div>
                  <div className="flex flex-col items-start">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white">{sub.name}</span>
                      {sub.isDefault && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">
                          Default
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-zinc-600 font-mono">{sub.id}</span>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Server size={14} className="text-zinc-600" />
                    <span className="text-sm text-zinc-400">{sub.clusters.length} cluster{sub.clusters.length !== 1 ? 's' : ''}</span>
                  </div>
                </div>
              </button>

              {/* Clusters Grid */}
              {expandedSubs[sub.id] && (
                <div className="border-t border-white/5 bg-black/20 p-5">
                  {sub.clusters.length === 0 ? (
                    <div className="text-center py-8">
                      <Server size={24} className="text-zinc-700 mx-auto mb-2" />
                      <p className="text-sm text-zinc-600">No clusters in this subscription</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {sub.clusters.map(cluster => {
                        const isRunning = cluster.powerState.code === 'Running';
                        const isConnecting = connectMutation.isPending &&
                          connectMutation.variables?.cluster.id === cluster.id;

                        return (
                          <div
                            key={cluster.id}
                            className={`group relative rounded-xl border p-5 transition-all duration-300 ${isRunning
                              ? 'bg-gradient-to-br from-emerald-500/5 to-transparent border-emerald-500/20 hover:border-emerald-500/40 hover:shadow-lg hover:shadow-emerald-500/10'
                              : 'bg-white/[0.02] border-white/10 hover:border-white/20'
                              }`}
                          >
                            {/* Status Badge */}
                            <div className="absolute top-4 right-4">
                              <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium ${isRunning
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                : 'bg-zinc-800 text-zinc-500 border border-zinc-700'
                                }`}>
                                <div className={`w-1.5 h-1.5 rounded-full ${isRunning ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
                                {isRunning ? 'Running' : 'Stopped'}
                              </div>
                            </div>

                            {/* Cluster Info */}
                            <div className="mb-4">
                              <h3 className="font-bold text-white text-lg mb-1 pr-20">{cluster.name}</h3>
                              <div className="flex flex-wrap gap-2 mt-3">
                                <span className="inline-flex items-center gap-1 text-xs text-zinc-500 bg-white/5 px-2 py-1 rounded-md">
                                  <Globe size={12} />
                                  {cluster.location}
                                </span>
                                <span className="inline-flex items-center gap-1 text-xs text-zinc-500 bg-white/5 px-2 py-1 rounded-md truncate max-w-[180px]" title={cluster.resourceGroup}>
                                  <Layers size={12} />
                                  {cluster.resourceGroup}
                                </span>
                              </div>
                            </div>

                            {/* Connect Button */}
                            <button
                              onClick={() => connectMutation.mutate({ subId: sub.id, cluster })}
                              disabled={connectMutation.isPending || !isRunning}
                              className={`w-full py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 ${isRunning
                                ? 'bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 disabled:opacity-50'
                                : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                                }`}
                            >
                              {isConnecting ? (
                                <>
                                  <Loader2 className="animate-spin" size={16} />
                                  Connecting...
                                </>
                              ) : (
                                <>
                                  <Plug size={16} />
                                  {isRunning ? 'Connect to Cluster' : 'Cluster Stopped'}
                                </>
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function AppContent() {
  const qc = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const [showAzure, setShowAzure] = useState(false);
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; type?: 'success' | 'error' | 'info' }>>([]);
  const prevContextRef = useRef<string | null>(null);

  // Global cluster chat state
  const [showClusterChat, setShowClusterChat] = useState(false);
  const [isClusterChatMinimized, setIsClusterChatMinimized] = useState(false);

  // Observe current context name globally
  const { data: globalCurrentContext } = useQuery({
    queryKey: ["current_context_boot"],
    queryFn: async () => await invoke<string>("get_current_context_name"),
    refetchInterval: 5000,
  });

  // After connection, gate UI on cluster details load
  const {
    data: bootStats,
    isLoading: bootLoading,
    isError: bootError,
    error: bootErr,
    refetch: bootRefetch,
  } = useQuery({
    queryKey: ["cluster_bootstrap", globalCurrentContext],
    queryFn: async () => await invoke<ClusterStats>("get_cluster_stats"),
    enabled: isConnected && !!globalCurrentContext,
    retry: 1,
    staleTime: 0,
  });

  // Touch bootStats to avoid unused variable lint errors
  useEffect(() => {
    if (bootStats) {
      // noop: used to mark stats availability
    }
  }, [bootStats]);

  // Global toast bus
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ message: string; type?: 'success' | 'error' | 'info' }>;
      const id = Date.now() + Math.random();
      setToasts((prev) => [...prev, { id, message: ce.detail.message, type: ce.detail.type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3000);
    };
    window.addEventListener('app:toast', handler as EventListener);
    // expose helper
    (window as any).showToast = (message: string, type?: 'success' | 'error' | 'info') => {
      window.dispatchEvent(new CustomEvent('app:toast', { detail: { message, type } }));
    };
    return () => {
      window.removeEventListener('app:toast', handler as EventListener);
    };
  }, []);

  // Check if there's already an active context on mount


  // Watch current context and toast on changes
  const { data: currentCtx } = useQuery({
    queryKey: ["current_context_global"],
    queryFn: async () => await invoke<string>("get_current_context_name"),
    refetchInterval: 5000,
  });

  // Always show home screen on app open - user must explicitly connect
  // (Removed auto-connect logic that was previously here)

  useEffect(() => {
    if (typeof currentCtx === 'string') {
      if (prevContextRef.current && prevContextRef.current !== currentCtx) {
        (window as any).showToast?.(`Switched context to '${currentCtx}'`, 'info');
      }
      prevContextRef.current = currentCtx;
    }
  }, [currentCtx]);

  if (!isConnected) {
    return (
      <>
        {showAzure ? (
          <div className="h-screen flex flex-col bg-[#1e1e1e]">
            <div className="h-14 border-b border-[#3e3e42] flex items-center justify-between px-4 bg-[#252526] shrink-0">
              <div className="flex items-center gap-2">
                <Cloud className="text-[#007acc]" size={20} />
                <h2 className="font-semibold text-white">Azure Explorer</h2>
              </div>
              <button
                onClick={() => setShowAzure(false)}
                className="text-[#858585] hover:text-white text-sm"
              >
                Back to Connections
              </button>
            </div>
            <div className="flex-1 overflow-hidden relative">
              <AzurePage onConnect={() => setIsConnected(true)} />
            </div>
          </div>
        ) : (
          <ConnectionScreen
            onConnect={() => setIsConnected(true)}
            onOpenAzure={() => setShowAzure(true)}
          />
        )}
      </>
    );
  }

  // Show error gate only on connection errors (not during loading - let Dashboard load progressively)
  if (isConnected && (!!globalCurrentContext) && bootError) {
    const errorMessage = (bootErr as any)?.message || String(bootErr) || "Unknown error";
    console.error("Boot error:", bootErr);
    const isConnectionError = errorMessage.toLowerCase().includes("connect") ||
      errorMessage.toLowerCase().includes("unreachable") ||
      errorMessage.toLowerCase().includes("timeout");
    const isAuthError = errorMessage.toLowerCase().includes("unauthorized") ||
      errorMessage.toLowerCase().includes("forbidden") ||
      errorMessage.toLowerCase().includes("certificate");

    return (
      <div className="h-screen bg-gradient-to-br from-zinc-900 to-zinc-950 flex flex-col items-center justify-center p-8">
        <div className="max-w-lg w-full">
          <div className="bg-gradient-to-br from-red-500/10 to-orange-500/5 rounded-2xl border border-red-500/20 p-8 backdrop-blur-xl shadow-2xl">
            <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-red-500/20 to-orange-500/20 flex items-center justify-center border border-red-500/30">
              <AlertCircle size={32} className="text-red-400" />
            </div>

            <h1 className="text-2xl font-bold text-white text-center mb-2">
              {isConnectionError ? "Cluster Unreachable" : isAuthError ? "Authentication Failed" : "Connection Error"}
            </h1>

            <p className="text-zinc-400 text-center text-sm mb-6">
              {isConnectionError
                ? "Unable to connect to the Kubernetes API server"
                : isAuthError
                  ? "Your credentials may have expired or are invalid"
                  : "Failed to load cluster details"}
            </p>

            <div className="bg-black/30 rounded-lg p-4 mb-6 border border-white/5">
              <p className="text-xs font-mono text-red-300 break-all">{errorMessage}</p>
            </div>

            {isConnectionError && (
              <div className="bg-blue-500/10 rounded-lg p-4 mb-6 border border-blue-500/20">
                <p className="text-xs text-blue-300 font-medium mb-2">Troubleshooting tips:</p>
                <ul className="text-xs text-blue-200/70 space-y-1 list-disc list-inside">
                  <li>Check if the cluster is running</li>
                  <li>Verify VPN connection if required</li>
                  <li>Check network/firewall settings</li>
                  <li>Try: <code className="bg-black/30 px-1 rounded">kubectl cluster-info</code></li>
                </ul>
              </div>
            )}

            {isAuthError && (
              <div className="bg-yellow-500/10 rounded-lg p-4 mb-6 border border-yellow-500/20">
                <p className="text-xs text-yellow-300 font-medium mb-2">Authentication tips:</p>
                <ul className="text-xs text-yellow-200/70 space-y-1 list-disc list-inside">
                  <li>Re-authenticate with your cloud provider</li>
                  <li>For AKS: <code className="bg-black/30 px-1 rounded">az aks get-credentials</code></li>
                  <li>For EKS: <code className="bg-black/30 px-1 rounded">aws eks update-kubeconfig</code></li>
                  <li>For GKE: <code className="bg-black/30 px-1 rounded">gcloud container clusters get-credentials</code></li>
                </ul>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => bootRefetch()}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-medium shadow-lg shadow-blue-500/20 transition-all"
              >
                <RefreshCw size={16} />
                Retry Connection
              </button>
              <button
                onClick={() => {
                  qc.removeQueries();
                  setIsConnected(false);
                }}
                className="flex-1 px-4 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 font-medium transition-all"
              >
                Change Cluster
              </button>
            </div>
          </div>

          <p className="text-center text-xs text-zinc-600 mt-4">
            Context: <span className="font-mono text-zinc-500">{globalCurrentContext}</span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Global Toasts */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`px-3 py-2 rounded-md text-sm shadow-lg backdrop-blur bg-opacity-20 border ${t.type === 'success'
              ? 'bg-green-500/20 border-green-500/40 text-green-300'
              : t.type === 'error'
                ? 'bg-red-500/20 border-red-500/40 text-red-300'
                : 'bg-cyan-500/20 border-cyan-500/40 text-cyan-200'
              }`}
          >
            {t.message}
          </div>
        ))}
      </div>
      <Dashboard
        isConnected={isConnected}
        setIsConnected={setIsConnected}
        onDisconnect={async () => {
          // Clear ALL cached data to prevent stale data
          qc.removeQueries();
          // Also clear backend caches
          try {
            await invoke("clear_all_caches");
          } catch (e) {
            console.warn("Failed to clear backend caches:", e);
          }
          (window as any).showToast?.('Disconnected from cluster', 'info');
          setIsConnected(false);
        }}
      />
      <PortForwardList currentContext={globalCurrentContext} />

      {/* Global Floating AI Chat Button */}
      {!showClusterChat && (
        <button
          onClick={() => { setShowClusterChat(true); setIsClusterChatMinimized(false); }}
          className="fixed bottom-4 right-4 z-40 flex items-center gap-2 px-4 py-3 bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-500 hover:to-purple-400 rounded-full shadow-lg shadow-purple-500/30 text-white font-medium transition-all hover:scale-105"
        >
          <MessageSquare size={20} />
          <span>AI Chat</span>
        </button>
      )}

      {/* Global Cluster Chat Panel */}
      {showClusterChat && (
        <ClusterChatPanel
          onClose={() => setShowClusterChat(false)}
          isMinimized={isClusterChatMinimized}
          onToggleMinimize={() => setIsClusterChatMinimized(!isClusterChatMinimized)}
        />
      )}
    </>
  );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: any }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen bg-black text-red-400 flex flex-col items-center justify-center p-8 text-center">
          <h1 className="text-2xl font-bold mb-4">Something went wrong.</h1>
          <pre className="bg-gray-900 p-4 rounded text-left text-xs overflow-auto max-w-2xl border border-gray-800">
            {this.state.error?.toString()}
          </pre>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 px-4 py-2 bg-cyan-600 text-white rounded hover:bg-cyan-500 shadow-lg shadow-cyan-500/30"
          >
            Reload Application
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// Wrapper to provide QueryClient context with persistence
export default function App() {
  return (
    <ErrorBoundary>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister }}
      >
        <AppContent />
      </PersistQueryClientProvider>
    </ErrorBoundary>
  );
}