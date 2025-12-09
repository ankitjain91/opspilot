
import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
    Loader2, Activity, ChevronDown, ChevronUp, RefreshCw, Zap, Copy, Check,
    Search, Bot, Play, Square, FileCog, Shield, Layers, MessageSquare, AlertCircle,
    Clock, Tag, Hash, Box, ExternalLink, AlertTriangle, CheckCircle2, XCircle,
    Info, Calendar, User, GitBranch, Send, X, Edit3, Eye, Maximize2, Sparkles
} from 'lucide-react';
import { K8sObject } from '../../../types/k8s';
import { fixMarkdownHeaders } from '../../../utils/markdown';
import { ResourceDetails } from './ResourceDetails';
import { MetricsChart } from './MetricsChart';
import { executeTool, sanitizeToolArgs, VALID_TOOLS } from '../../ai/tools';
import { loadLLMConfig } from '../../ai/utils';
import { QUICK_MODE_SYSTEM_PROMPT, ITERATIVE_SYSTEM_PROMPT } from '../../ai/prompts';

interface OverviewTabProps {
    resource: K8sObject;
    fullObject: any;
    loading: boolean;
    error?: Error;
    onDelete: () => void;
    currentContext?: string;
}

interface ChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolName?: string;
    command?: string;
    isActivity?: boolean;
}

// Normalize timestamps coming from YAML/Date/string
const formatTimestamp = (ts: any): string => {
    if (!ts) return 'Unknown';
    const str = typeof ts === 'string' ? ts : ts instanceof Date ? ts.toISOString() : String(ts);
    return str.replace('T', ' ').split('.')[0].replace('Z', '');
};

// Modal component for viewing/copying content with optional edit mode
function DetailModal({ isOpen, onClose, title, content, type, onSave, resourceName, resourceNamespace, resourceKind }: {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    content: Record<string, string> | string;
    type: 'labels' | 'annotations' | 'text';
    onSave?: (newContent: Record<string, string>) => Promise<void>;
    resourceName?: string;
    resourceNamespace?: string;
    resourceKind?: string;
}) {
    const [copied, setCopied] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [isEditing, setIsEditing] = useState(false);
    const [editedContent, setEditedContent] = useState<Record<string, string>>({});
    const [newKey, setNewKey] = useState('');
    const [newValue, setNewValue] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Reset state when modal opens
    useEffect(() => {
        if (isOpen && typeof content === 'object') {
            setEditedContent({ ...content });
            setIsEditing(false);
            setNewKey('');
            setNewValue('');
            setError(null);
        }
    }, [isOpen, content]);

    if (!isOpen) return null;

    const handleCopyAll = async () => {
        const text = typeof content === 'string'
            ? content
            : Object.entries(content).map(([k, v]) => `${k}=${v}`).join('\n');
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleCopyItem = async (key: string, value: string) => {
        await navigator.clipboard.writeText(`${key}=${value}`);
    };

    const handleEditValue = (key: string, value: string) => {
        setEditedContent(prev => ({ ...prev, [key]: value }));
    };

    const handleDeleteItem = (key: string) => {
        setEditedContent(prev => {
            const newContent = { ...prev };
            delete newContent[key];
            return newContent;
        });
    };

    const handleAddItem = () => {
        if (newKey.trim() && newValue.trim()) {
            setEditedContent(prev => ({ ...prev, [newKey.trim()]: newValue.trim() }));
            setNewKey('');
            setNewValue('');
        }
    };

    const handleSave = async () => {
        if (!onSave) return;
        setSaving(true);
        setError(null);
        try {
            await onSave(editedContent);
            setIsEditing(false);
            onClose();
        } catch (err: any) {
            setError(err.toString());
        } finally {
            setSaving(false);
        }
    };

    const entries = typeof content === 'object' ? Object.entries(isEditing ? editedContent : content) : [];
    const filteredEntries = entries.filter(([k, v]) =>
        k.toLowerCase().includes(searchTerm.toLowerCase()) ||
        v.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const hasChanges = JSON.stringify(editedContent) !== JSON.stringify(content);

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <div
                className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 bg-zinc-800/50">
                    <div className="flex items-center gap-3 min-w-0">
                        {type === 'labels' && <Tag size={18} className="text-cyan-400 shrink-0" />}
                        {type === 'annotations' && <Info size={18} className="text-purple-400 shrink-0" />}
                        {type === 'text' && <Eye size={18} className="text-blue-400 shrink-0" />}
                        <h3 className="text-lg font-semibold text-white truncate">{title}</h3>
                        <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded-full shrink-0">
                            {typeof content === 'object' ? Object.keys(isEditing ? editedContent : content).length : 1} items
                        </span>
                        {isEditing && hasChanges && (
                            <span className="text-[9px] text-yellow-400 bg-yellow-500/20 px-1.5 py-0.5 rounded-full shrink-0">Modified</span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {!isEditing && (
                            <button
                                onClick={handleCopyAll}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors border border-zinc-700"
                            >
                                {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                                {copied ? 'Copied!' : 'Copy All'}
                            </button>
                        )}
                        {typeof content === 'object' && onSave && !isEditing && (
                            <button
                                onClick={() => setIsEditing(true)}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-cyan-300 bg-cyan-500/20 hover:bg-cyan-500/30 rounded-lg transition-colors border border-cyan-500/30"
                            >
                                <Edit3 size={12} />
                                Edit
                            </button>
                        )}
                        {isEditing && (
                            <>
                                <button
                                    onClick={() => {
                                        setIsEditing(false);
                                        setEditedContent(typeof content === 'object' ? { ...content } : {});
                                    }}
                                    className="px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={saving || !hasChanges}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-cyan-600 hover:bg-cyan-500 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                                    Save
                                </button>
                            </>
                        )}
                        <button
                            onClick={onClose}
                            className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                        >
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {/* Error Banner */}
                {error && (
                    <div className="px-5 py-2 bg-red-500/10 border-b border-red-500/20 text-red-400 text-xs flex items-center gap-2">
                        <AlertCircle size={14} />
                        {error}
                    </div>
                )}

                {/* Search */}
                {typeof content === 'object' && entries.length > 3 && (
                    <div className="px-5 py-3 border-b border-zinc-800/50">
                        <div className="relative">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                            <input
                                type="text"
                                placeholder="Search..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="w-full bg-zinc-800/50 border border-zinc-700 rounded-lg pl-9 pr-4 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
                            />
                        </div>
                    </div>
                )}

                {/* Add New Item (Edit Mode) */}
                {isEditing && (
                    <div className="px-5 py-3 border-b border-zinc-800/50 bg-zinc-800/20">
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                placeholder="Key"
                                value={newKey}
                                onChange={(e) => setNewKey(e.target.value)}
                                className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-cyan-500/50"
                            />
                            <input
                                type="text"
                                placeholder="Value"
                                value={newValue}
                                onChange={(e) => setNewValue(e.target.value)}
                                className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-cyan-500/50"
                                onKeyDown={(e) => e.key === 'Enter' && handleAddItem()}
                            />
                            <button
                                onClick={handleAddItem}
                                disabled={!newKey.trim() || !newValue.trim()}
                                className="px-3 py-1.5 text-xs font-medium text-cyan-300 bg-cyan-500/20 hover:bg-cyan-500/30 rounded-lg transition-colors border border-cyan-500/30 disabled:opacity-50"
                            >
                                Add
                            </button>
                        </div>
                    </div>
                )}

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-5">
                    {typeof content === 'string' ? (
                        <pre className="text-sm font-mono text-zinc-300 whitespace-pre-wrap break-all bg-zinc-800/50 rounded-lg p-4 border border-zinc-700">
                            {content}
                        </pre>
                    ) : (
                        <div className="space-y-2">
                            {filteredEntries.map(([key, value]) => (
                                <div
                                    key={key}
                                    className={`group p-3 rounded-xl border transition-all ${isEditing
                                        ? 'bg-zinc-800/30 border-zinc-700'
                                        : `cursor-pointer hover:shadow-md ${type === 'labels'
                                            ? 'bg-cyan-500/5 border-cyan-500/20 hover:border-cyan-500/40'
                                            : 'bg-purple-500/5 border-purple-500/20 hover:border-purple-500/40'
                                        }`
                                        }`}
                                    onClick={() => !isEditing && handleCopyItem(key, value)}
                                    title={!isEditing ? "Click to copy" : undefined}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <div className={`text-xs font-semibold mb-1 ${type === 'labels' ? 'text-cyan-400' : 'text-purple-400'}`}>
                                                {key}
                                            </div>
                                            {isEditing ? (
                                                <input
                                                    type="text"
                                                    value={value}
                                                    onChange={(e) => handleEditValue(key, e.target.value)}
                                                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-sm text-white font-mono focus:outline-none focus:border-cyan-500/50"
                                                />
                                            ) : (
                                                <div className="text-sm text-zinc-300 font-mono break-all">
                                                    {value}
                                                </div>
                                            )}
                                        </div>
                                        {isEditing ? (
                                            <button
                                                onClick={() => handleDeleteItem(key)}
                                                className="p-1.5 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors shrink-0"
                                                title="Delete"
                                            >
                                                <X size={14} />
                                            </button>
                                        ) : (
                                            <Copy size={14} className="opacity-0 group-hover:opacity-50 text-zinc-400 shrink-0 mt-1 transition-opacity" />
                                        )}
                                    </div>
                                </div>
                            ))}
                            {filteredEntries.length === 0 && (
                                <div className="text-center py-8 text-zinc-500">
                                    <Search size={24} className="mx-auto mb-2 opacity-30" />
                                    <p className="text-sm">No matches found</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// Compact copyable text
function CopyableText({ text, className = "", mono = true, truncate = false }: {
    text: string;
    className?: string;
    mono?: boolean;
    truncate?: boolean;
}) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <span
            onClick={handleCopy}
            className={`inline-flex items-center gap-1 cursor-pointer hover:bg-white/5 px-1 py-0.5 rounded transition-all group ${className}`}
            title={`${text}\nClick to copy`}
        >
            <span className={`${mono ? "font-mono" : ""} ${truncate ? "truncate" : ""}`}>{text}</span>
            {copied ? (
                <Check size={10} className="text-green-400 shrink-0" />
            ) : (
                <Copy size={10} className="opacity-0 group-hover:opacity-50 transition-opacity shrink-0" />
            )}
        </span>
    );
}

// Status badge component
function StatusBadge({ status, size = "md" }: { status?: string; size?: "sm" | "md" | "lg" }) {
    const getStatusConfig = (s?: string) => {
        switch (s) {
            case 'Running':
            case 'Active':
            case 'Bound':
            case 'Ready':
            case 'Succeeded':
            case 'Available':
            case 'True':
                return { bg: 'bg-emerald-500/20', border: 'border-emerald-500/40', text: 'text-emerald-400', dot: 'bg-emerald-500' };
            case 'Pending':
            case 'ContainerCreating':
            case 'Waiting':
            case 'Unknown':
                return { bg: 'bg-yellow-500/20', border: 'border-yellow-500/40', text: 'text-yellow-400', dot: 'bg-yellow-500' };
            case 'Failed':
            case 'Error':
            case 'CrashLoopBackOff':
            case 'ImagePullBackOff':
            case 'False':
                return { bg: 'bg-red-500/20', border: 'border-red-500/40', text: 'text-red-400', dot: 'bg-red-500' };
            case 'Terminating':
                return { bg: 'bg-orange-500/20', border: 'border-orange-500/40', text: 'text-orange-400', dot: 'bg-orange-500' };
            default:
                return { bg: 'bg-zinc-500/20', border: 'border-zinc-500/40', text: 'text-zinc-400', dot: 'bg-zinc-500' };
        }
    };

    const config = getStatusConfig(status);
    const sizes = {
        sm: { padding: 'px-1.5 py-0.5', text: 'text-[10px]', dot: 'w-1.5 h-1.5' },
        md: { padding: 'px-2 py-1', text: 'text-xs', dot: 'w-2 h-2' },
        lg: { padding: 'px-3 py-1.5', text: 'text-sm', dot: 'w-2.5 h-2.5' }
    };
    const sizeConfig = sizes[size];

    return (
        <span className={`inline-flex items-center gap-1.5 ${sizeConfig.padding} ${config.bg} border ${config.border} rounded-full ${sizeConfig.text} font-medium ${config.text} shrink-0`}>
            <span className={`${sizeConfig.dot} rounded-full ${config.dot} ${status === 'Running' || status === 'Active' ? 'animate-pulse' : ''} shrink-0`} />
            <span className="truncate">{status || 'Unknown'}</span>
        </span>
    );
}

// Info card component - now clickable
function InfoCard({ icon: Icon, label, value, fullValue, copyable = false, onClick }: {
    icon: React.ComponentType<{ size?: number; className?: string }>;
    label: string;
    value: string;
    fullValue?: string;
    copyable?: boolean;
    onClick?: () => void;
}) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(copyValue);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const baseVal = value !== undefined && value !== null ? String(value) : '';
    const displayValue = baseVal.trim().length > 0 ? baseVal : 'Unknown';
    const copyValue = fullValue || displayValue;

    return (
        <div
            className={`flex items-center gap-3 p-3 bg-[#0b0b10] rounded-xl border border-[#1a1a22] hover:border-[#242433] transition-all hover:shadow-lg group ${onClick ? 'cursor-pointer' : ''}`}
            onClick={onClick}
        >
            <div className="p-2 bg-[#11111a] rounded-lg border border-[#1f1f2b] shrink-0">
                <Icon size={14} className="text-zinc-300" />
            </div>
            <div className="flex-1 min-w-0 overflow-hidden">
                <div className="text-xs text-zinc-500 uppercase tracking-wider font-medium truncate">{label}</div>
                <div className="text-sm text-zinc-100 font-medium truncate" title={copyValue}>{displayValue}</div>
            </div>
            {copyable && (
                <button
                    onClick={handleCopy}
                    className="p-1.5 opacity-0 group-hover:opacity-100 hover:bg-[#1f1f2b] rounded-lg transition-all shrink-0"
                    title="Copy"
                >
                    {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} className="text-zinc-300" />}
                </button>
            )}
        </div>
    );
}

// Compact label chip with popup on click
function LabelChip({ name, value, type = "label", onClick }: {
    name: string;
    value: string;
    type?: "label" | "annotation";
    onClick?: () => void;
}) {
    const [copied, setCopied] = useState(false);
    const fullText = `${name}=${value}`;

    const handleCopy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(fullText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const colors = type === "label"
        ? "bg-cyan-500/10 border-cyan-500/30 hover:border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/20"
        : "bg-purple-500/10 border-purple-500/30 hover:border-purple-500/50 text-purple-300 hover:bg-purple-500/20";

    // Truncate long names/values for display
    const displayName = name.length > 20 ? name.slice(0, 18) + '...' : name;
    const displayValue = value.length > 15 ? value.slice(0, 13) + '...' : value;

    return (
        <span
            onClick={handleCopy}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs cursor-pointer transition-colors ${colors} max-w-full`}
            title={`${name}=${value}\nClick to copy`}
        >
            <span className="font-medium truncate">{displayName}</span>
            <span className="text-zinc-500 shrink-0">=</span>
            <span className="font-mono truncate">{displayValue}</span>
            {copied && <Check size={12} className="text-green-400 shrink-0" />}
        </span>
    );
}

// Normalize event payload from core/v1 or events.k8s.io
const normalizeEvent = (event: any) => {
    const ts = event.lastTimestamp || event.eventTime || event.age || event.firstTimestamp;
    return {
        ...event,
        type: event.type || event.type_ || event.eventType || 'Normal',
        timestamp: ts,
    };
};

// Event item component - compact version
function EventItem({ event, onClick }: { event: any; onClick?: () => void }) {
    const e = normalizeEvent(event);
    const isWarning = e.type === 'Warning';
    const Icon = isWarning ? AlertTriangle : Info;

    return (
        <div
            className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${isWarning
                ? 'bg-orange-500/5 border-orange-500/25 hover:border-orange-500/40'
                : 'bg-[#0f0f16] border-[#1a1a22] hover:border-[#2b2b38]'
                }`}
            onClick={onClick}
        >
            <div className={`p-2 rounded-lg shrink-0 ${isWarning ? 'bg-orange-500/20' : 'bg-[#11111a]'}`}>
                <Icon size={14} className={isWarning ? 'text-orange-400' : 'text-zinc-400'} />
            </div>
            <div className="flex-1 min-w-0 overflow-hidden">
                <div className="flex items-center gap-2 mb-1">
                    <span className={`text-sm font-semibold truncate ${isWarning ? 'text-orange-400' : 'text-zinc-300'}`}>
                        {e.reason || e.type}
                    </span>
                    {e.count && e.count > 1 && (
                        <span className="text-xs text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded-full shrink-0">
                            {e.count}x
                        </span>
                    )}
                </div>
                <p className="text-sm text-zinc-400 line-clamp-2 leading-relaxed">{e.message}</p>
                <div className="flex items-center gap-1.5 mt-2 text-xs text-zinc-500">
                    <Clock size={12} />
                    <span className="truncate">{e.timestamp || 'Unknown'}</span>
                </div>
            </div>
        </div>
    );
}

// Condition row component - compact
function ConditionRow({ condition, onClick }: { condition: any; onClick?: () => void }) {
    const isTrue = condition.status === 'True';
    const isFalse = condition.status === 'False';

    return (
        <div
            className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${isTrue
                ? 'bg-emerald-500/5 border-emerald-500/20 hover:border-emerald-500/40'
                : isFalse
                    ? 'bg-red-500/5 border-red-500/20 hover:border-red-500/40'
                    : 'bg-yellow-500/5 border-yellow-500/20 hover:border-yellow-500/40'
                }`}
            onClick={onClick}
        >
            <div className={`p-2 rounded-lg shrink-0 ${isTrue
                ? 'bg-emerald-500/20'
                : isFalse
                    ? 'bg-red-500/20'
                    : 'bg-yellow-500/20'
                }`}>
                {isTrue ? (
                    <CheckCircle2 size={14} className="text-emerald-400" />
                ) : isFalse ? (
                    <XCircle size={14} className="text-red-400" />
                ) : (
                    <AlertCircle size={14} className="text-yellow-400" />
                )}
            </div>
            <div className="flex-1 min-w-0 overflow-hidden">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white truncate">{condition.type}</span>
                    {condition.reason && (
                        <span className="text-xs text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded-full truncate max-w-[120px]">
                            {condition.reason}
                        </span>
                    )}
                </div>
                {condition.message && (
                    <p className="text-xs text-zinc-500 mt-1 line-clamp-1" title={condition.message}>
                        {condition.message}
                    </p>
                )}
            </div>
            <div className="text-xs text-zinc-600 whitespace-nowrap shrink-0 hidden sm:block">
                {formatTimestamp(condition.lastTransitionTime).split(' ')[0]}
            </div>
        </div>
    );
}

// Section wrapper component with expand button
function Section({ title, icon, count, children, onExpand, className = "" }: {
    title: string;
    icon: React.ReactNode;
    count?: number;
    children: React.ReactNode;
    onExpand?: () => void;
    className?: string;
}) {
    return (
        <div className={`bg-[#0b0b10] rounded-xl border border-[#1a1a22] overflow-hidden ${className}`}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a22] bg-[#0f0f16]">
                <div className="flex items-center gap-2.5 min-w-0">
                    {icon}
                    <h3 className="text-sm font-semibold text-white truncate">{title}</h3>
                    {count !== undefined && count > 0 && (
                        <span className="text-xs text-zinc-500 bg-[#14141c] px-2 py-0.5 rounded-full shrink-0">{count}</span>
                    )}
                </div>
                {onExpand && (
                    <button
                        onClick={onExpand}
                        className="p-1.5 text-zinc-500 hover:text-white hover:bg-[#1f1f2b] rounded-lg transition-colors shrink-0"
                        title="Expand"
                    >
                        <Maximize2 size={14} />
                    </button>
                )}
            </div>
            <div className="p-4">
                {children}
            </div>
        </div>
    );
}

// Get a user-friendly description of what the tool does
const getToolActivity = (toolName: string, args?: string): string => {
    const toolDescriptions: Record<string, string> = {
        'CLUSTER_HEALTH': '🔍 Checking cluster health...',
        'GET_EVENTS': args ? `📋 Fetching events for ${args}...` : '📋 Fetching cluster events...',
        'LIST_ALL': args ? `📊 Listing ${args} resources...` : '📊 Listing resources...',
        'DESCRIBE': args ? `🔬 Describing ${args}...` : '🔬 Getting resource details...',
        'GET_LOGS': args ? `📜 Fetching logs for ${args}...` : '📜 Fetching pod logs...',
        'TOP_PODS': args ? `📈 Checking pod metrics in ${args}...` : '📈 Checking pod resource usage...',
        'FIND_ISSUES': '🔎 Scanning for cluster issues...',
        'SEARCH_KNOWLEDGE': args ? `📚 Searching knowledge base for "${args}"...` : '📚 Searching knowledge base...',
        'GET_ENDPOINTS': args ? `🌐 Getting endpoints for ${args}...` : '🌐 Getting service endpoints...',
        'GET_NAMESPACE': args ? `📁 Inspecting namespace ${args}...` : '📁 Inspecting namespace...',
        'LIST_FINALIZERS': args ? `🔗 Finding finalizers in ${args}...` : '🔗 Finding stuck finalizers...',
    };
    return toolDescriptions[toolName] || `⚙️ Executing ${toolName}...`;
};

export function OverviewTab({ resource, fullObject, loading, error, onDelete, currentContext }: OverviewTabProps) {
    const [llmLoading, setLlmLoading] = useState(false);
    const [currentActivity, setCurrentActivity] = useState("Thinking...");
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
    const [userInput, setUserInput] = useState("");
    const [labelsModalOpen, setLabelsModalOpen] = useState(false);
    const [annotationsModalOpen, setAnnotationsModalOpen] = useState(false);
    const [selectedCondition, setSelectedCondition] = useState<any>(null);
    const [selectedEvent, setSelectedEvent] = useState<any>(null);
    const chatEndRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const queryClient = useQueryClient();

    // Scroll to bottom of chat
    useEffect(() => {
        if (chatEndRef.current) {
            chatEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [chatHistory, llmLoading]);

    // Save labels or annotations
    const handleSaveMetadata = async (type: 'labels' | 'annotations', newContent: Record<string, string>) => {
        if (!fullObject) throw new Error("No resource loaded");

        // Build the patch object
        const patchData = {
            metadata: {
                [type]: newContent
            }
        };

        // Build apiVersion from group and version
        const ns = resource.namespace === "-" ? "" : resource.namespace;
        const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version || "v1";

        await invoke("patch_resource", {
            namespace: ns,
            kind: resource.kind,
            name: resource.name,
            apiVersion: apiVersion,
            patchData: patchData
        });

        // Invalidate queries to refresh
        queryClient.invalidateQueries({ queryKey: ["resource_details"] });
        queryClient.invalidateQueries({ queryKey: ["resources"] });

        // Show success toast
        if ((window as any).showToast) {
            (window as any).showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} updated successfully`, 'success');
        }
    };

    // Extract keywords from user message for knowledge base search
    const extractKeywords = (msg: string): string => {
        const k8sKeywords = [
            'pod', 'pods', 'deployment', 'deployments', 'service', 'services', 'node', 'nodes',
            'crash', 'crashing', 'crashloop', 'crashloopbackoff', 'error', 'errors', 'failed', 'failing',
            'pending', 'stuck', 'terminating', 'oom', 'oomkilled', 'memory', 'cpu', 'resource',
            'image', 'imagepull', 'imagepullbackoff', 'pull', 'registry', 'secret', 'secrets',
            'configmap', 'volume', 'pvc', 'pv', 'storage', 'mount', 'network', 'networking',
            'dns', 'endpoint', 'endpoints', 'ingress', 'loadbalancer', 'clusterip', 'nodeport',
            'rbac', 'permission', 'forbidden', 'unauthorized', 'serviceaccount', 'role',
            'namespace', 'finalizer', 'finalizers', 'delete', 'deletion', 'scale', 'replica',
            'restart', 'restarts', 'logs', 'events', 'describe', 'health', 'unhealthy', 'ready',
            'notready', 'scheduling', 'schedule', 'taint', 'toleration', 'affinity', 'selector'
        ];

        const words = msg.toLowerCase().split(/\s+/);
        const matched = words.filter(w => k8sKeywords.some(kw => w.includes(kw)));

        if (matched.length === 0) {
            const stopWords = ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'why', 'how', 'when', 'where', 'which', 'who', 'my', 'your', 'this', 'that', 'it', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];
            const significant = words.filter(w => w.length > 2 && !stopWords.includes(w));
            return significant.slice(0, 4).join(' ');
        }

        return matched.slice(0, 4).join(' ');
    };

    // Helper to call LLM - routes to Claude Code CLI or regular API
    const callLLM = async (
        llmConfig: ReturnType<typeof loadLLMConfig>,
        prompt: string,
        systemPrompt: string,
        conversationHistory: Array<{ role: string; content: string }>
    ): Promise<string> => {
        if (llmConfig.provider === 'claude-code') {
            // Build conversation context for Claude Code
            const historyStr = conversationHistory
                .slice(-10) // Last 10 messages for context
                .map(m => `${m.role.toUpperCase()}: ${m.content}`)
                .join('\n\n');

            const fullPrompt = historyStr ? `${historyStr}\n\nUSER: ${prompt}` : prompt;

            return await invoke<string>("call_claude_code", {
                prompt: fullPrompt,
                systemPrompt,
            });
        } else {
            return await invoke<string>("call_llm", {
                config: llmConfig,
                prompt,
                systemPrompt,
                conversationHistory,
            });
        }
    };

    const sendMessage = async (message: string) => {
        if (!message.trim()) return;

        setChatHistory(prev => [...prev, { role: 'user', content: message }]);
        setUserInput("");
        setLlmLoading(true);
        setCurrentActivity("🧠 Understanding your request...");

        try {
            const llmConfig = loadLLMConfig();

            // MANDATORY: Always search knowledge base first
            const keywords = extractKeywords(message);
            setCurrentActivity(`📚 Searching knowledge base for "${keywords}"...`);
            const { result: kbResult, command: kbCommand } = await executeTool('SEARCH_KNOWLEDGE', keywords);
            setChatHistory(prev => [...prev, { role: 'tool', content: kbResult, toolName: 'SEARCH_KNOWLEDGE', command: kbCommand }]);

            // Build resource-specific context with FULL resource data
            // Truncate large objects to avoid token limits but include essential details
            const getResourceSummary = () => {
                if (!fullObject) return 'Resource data not loaded';

                const summary: any = {
                    apiVersion: fullObject.apiVersion,
                    kind: fullObject.kind,
                    metadata: {
                        name: fullObject.metadata?.name,
                        namespace: fullObject.metadata?.namespace,
                        labels: fullObject.metadata?.labels,
                        annotations: Object.fromEntries(
                            Object.entries(fullObject.metadata?.annotations || {})
                                .filter(([k]) => !k.includes('last-applied-configuration'))
                        ),
                        creationTimestamp: fullObject.metadata?.creationTimestamp,
                        uid: fullObject.metadata?.uid,
                    },
                    spec: fullObject.spec,
                    status: fullObject.status,
                };

                // Convert to YAML-like string, truncate if too long
                const yamlStr = JSON.stringify(summary, null, 2);
                if (yamlStr.length > 8000) {
                    // For very large objects, only include key parts
                    return JSON.stringify({
                        apiVersion: summary.apiVersion,
                        kind: summary.kind,
                        metadata: summary.metadata,
                        status: summary.status,
                        spec: '... (truncated, use DESCRIBE tool for full spec)'
                    }, null, 2);
                }
                return yamlStr;
            };

            const resourceContext = `
=== KNOWLEDGE BASE RESULTS (ALREADY SEARCHED) ===
${kbResult}
=== END KNOWLEDGE BASE ===

=== CLUSTER CONTEXT ===
Kubernetes Context: ${currentContext || 'default'}
=== END CLUSTER CONTEXT ===

=== CURRENT RESOURCE (YOU ARE INVESTIGATING THIS) ===
Kind: ${resource.kind}
Name: ${resource.name}
Namespace: ${resource.namespace === '-' ? '(cluster-scoped)' : resource.namespace}
Status: ${resource.status}

FULL RESOURCE DATA:
\`\`\`json
${getResourceSummary()}
\`\`\`
=== END RESOURCE ===

IMPORTANT: You already have the full resource data above.
- You do NOT need to run DESCRIBE for basic information - it's already here!
- Only use DESCRIBE if you need fresh/updated data
- Use GET_LOGS, GET_EVENTS, or other tools to investigate issues
- The knowledge base has ALREADY been searched - DO NOT call SEARCH_KNOWLEDGE again
`;

            const finalPrompt = `${resourceContext}\n\nUser Request: ${message}`;

            setCurrentActivity("🤔 Thinking...");
            const answer = await callLLM(
                llmConfig,
                finalPrompt,
                QUICK_MODE_SYSTEM_PROMPT,
                chatHistory.filter(m => m.role !== 'tool')
            );

            // Check for tool usage - autonomous execution
            const toolMatches = answer.matchAll(/TOOL:\s*(\w+)(?:\s+(.+?))?(?=\n|$)/g);
            const tools = Array.from(toolMatches);

            if (tools.length > 0) {
                // Show initial reasoning before tool execution
                const initialReasoning = answer.split(/TOOL:/)[0].trim();
                if (initialReasoning) {
                    setChatHistory(prev => [...prev, {
                        role: 'assistant',
                        content: initialReasoning + '\n\n*🔄 Investigating...*',
                        isActivity: true
                    }]);
                }

                let allToolResults: string[] = [];

                for (const toolMatch of tools) {
                    const toolName = toolMatch[1];
                    let toolArgs: string | undefined = sanitizeToolArgs(toolMatch[2]?.trim());

                    if (!VALID_TOOLS.includes(toolName)) {
                        setChatHistory(prev => [...prev, { role: 'tool', content: `⚠️ Invalid tool: ${toolName}`, toolName: 'INVALID' }]);
                        continue;
                    }

                    setCurrentActivity(getToolActivity(toolName, toolArgs));

                    // Placeholder validation
                    const placeholderRegex = /\[.*?\]|<.*?>|\.\.\./;
                    if (toolName !== 'SEARCH_KNOWLEDGE' && toolArgs && placeholderRegex.test(toolArgs)) {
                        if (['GET_EVENTS', 'LIST_ALL', 'TOP_PODS', 'FIND_ISSUES'].includes(toolName)) {
                            if (toolName === 'LIST_ALL') {
                                const parts = toolArgs.split(/\s+/);
                                toolArgs = parts[0];
                            } else {
                                toolArgs = undefined;
                            }
                        } else {
                            setChatHistory(prev => [...prev, { role: 'tool', content: `❌ Placeholder detected in args. Use real names.`, toolName }]);
                            continue;
                        }
                    }

                    const { result, command } = await executeTool(toolName, toolArgs);
                    setChatHistory(prev => [...prev, { role: 'tool', content: result, toolName, command }]);
                    allToolResults.push(`## ${toolName}\n${result}`);
                }

                // Iterative investigation loop
                let combinedResults = allToolResults.join('\n\n---\n\n');
                let iterationCount = 0;
                const maxIterations = 30;
                let consecutiveErrors = 0;

                while (iterationCount < maxIterations) {
                    setCurrentActivity(`🧠 Analyzing results... (step ${iterationCount + 1})`);

                    const analysisPrompt = iterationCount === 0
                        ? `Tool results:\n${combinedResults}\n\nAnalyze these results for: "${message}". If you need more data, use TOOL: commands.`
                        : `New tool results:\n${combinedResults}\n\nContinue your investigation.`;

                    const analysisAnswer = await callLLM(
                        llmConfig,
                        analysisPrompt,
                        ITERATIVE_SYSTEM_PROMPT,
                        chatHistory.filter(m => m.role !== 'tool')
                    );

                    const nextToolMatches = analysisAnswer.matchAll(/TOOL:\s*(\w+)(?:\s+(.+?))?(?=\n|$)/g);
                    const nextTools = Array.from(nextToolMatches);

                    if (nextTools.length === 0) {
                        setChatHistory(prev => [...prev, { role: 'assistant', content: analysisAnswer }]);
                        break;
                    }

                    const reasoningPart = analysisAnswer.split('TOOL:')[0].trim();
                    if (reasoningPart) {
                        setChatHistory(prev => [...prev, {
                            role: 'assistant',
                            content: reasoningPart + '\n\n*🔄 Continuing investigation...*',
                            isActivity: true
                        }]);
                    }

                    const newToolResults: string[] = [];
                    let successfulToolsThisIteration = 0;
                    let errorsThisIteration = 0;

                    for (const toolMatch of nextTools) {
                        const toolName = toolMatch[1];
                        let toolArgs = sanitizeToolArgs(toolMatch[2]?.trim());

                        if (!VALID_TOOLS.includes(toolName)) {
                            errorsThisIteration++;
                            continue;
                        }

                        setCurrentActivity(getToolActivity(toolName, toolArgs));

                        const iterPlaceholderRegex = /\[.*?\]|<.*?>|\.\.\./;
                        if (toolName !== 'SEARCH_KNOWLEDGE' && toolArgs && iterPlaceholderRegex.test(toolArgs)) {
                            if (['GET_EVENTS', 'LIST_ALL', 'TOP_PODS', 'FIND_ISSUES'].includes(toolName)) {
                                if (toolName === 'LIST_ALL') {
                                    const parts = (toolArgs || '').split(/\s+/);
                                    toolArgs = parts[0];
                                } else {
                                    toolArgs = undefined;
                                }
                            } else {
                                errorsThisIteration++;
                                continue;
                            }
                        }

                        const { result, command } = await executeTool(toolName, toolArgs);
                        setChatHistory(prev => [...prev, { role: 'tool', content: result, toolName, command }]);
                        newToolResults.push(`## ${toolName}\n${result}`);

                        // Track success/error based on result content
                        if (result.startsWith('❌') || result.startsWith('⚠️')) {
                            errorsThisIteration++;
                        } else {
                            successfulToolsThisIteration++;
                        }
                    }

                    // Track consecutive errors - only give up after 3 consecutive failed iterations
                    if (errorsThisIteration > 0 && successfulToolsThisIteration === 0) {
                        consecutiveErrors++;
                        if (consecutiveErrors >= 3) {
                            setCurrentActivity("⚠️ Investigation hit a dead end...");
                            const fallbackAnswer = await callLLM(
                                llmConfig,
                                `I've encountered ${consecutiveErrors} consecutive errors while investigating. Based on what I've found so far, provide your best analysis and recommendations. Original question: "${message}"`,
                                ITERATIVE_SYSTEM_PROMPT,
                                chatHistory.filter(m => m.role !== 'tool')
                            );
                            setChatHistory(prev => [...prev, { role: 'assistant', content: fallbackAnswer }]);
                            break;
                        }
                    } else {
                        consecutiveErrors = 0;
                    }

                    combinedResults = newToolResults.join('\n\n---\n\n');
                    iterationCount++;
                }
            } else {
                setChatHistory(prev => [...prev, { role: 'assistant', content: answer }]);
            }
        } catch (err: any) {
            setChatHistory(prev => [...prev, { role: 'assistant', content: `❌ Error: ${err.toString()}` }]);
        } finally {
            setLlmLoading(false);
        }
    };

    // Recent Events
    const { data: recentEventsRaw } = useQuery({
        queryKey: ["recent_events", resource.namespace, resource.name],
        queryFn: async () => {
            const all: any[] = await invoke("list_events", { namespace: resource.namespace, name: resource.name, uid: resource.id });
            return all.slice(0, 5);
        },
        enabled: !!resource,
        staleTime: 10000,
    });
    const recentEvents = (recentEventsRaw || []).map(normalizeEvent);

    const labels = fullObject?.metadata?.labels || {};
    const annotations = fullObject?.metadata?.annotations || {};
    const filteredAnnotations: Record<string, string> = Object.fromEntries(
        Object.entries(annotations).filter(
            ([k]) => !k.includes('kubectl.kubernetes.io/last-applied-configuration')
        ).map(([k, v]) => [k, String(v)])
    );
    const conditions = fullObject?.status?.conditions || [];
    const labelEntries = Object.entries(labels);

    // Calculate age
    const rawCreationTime = fullObject?.metadata?.creationTimestamp;
    const creationTime = typeof rawCreationTime === 'string'
        ? rawCreationTime
        : rawCreationTime instanceof Date
            ? rawCreationTime.toISOString()
            : rawCreationTime
                ? String(rawCreationTime)
                : '';

    return (
        <div className="space-y-4">
            {/* Labels Modal */}
            <DetailModal
                isOpen={labelsModalOpen}
                onClose={() => setLabelsModalOpen(false)}
                title="Labels"
                content={labels}
                type="labels"
                onSave={(newContent) => handleSaveMetadata('labels', newContent)}
                resourceName={resource.name}
                resourceNamespace={resource.namespace}
                resourceKind={resource.kind}
            />

            {/* Annotations Modal */}
            <DetailModal
                isOpen={annotationsModalOpen}
                onClose={() => setAnnotationsModalOpen(false)}
                title="Annotations"
                content={filteredAnnotations}
                type="annotations"
                onSave={(newContent) => handleSaveMetadata('annotations', newContent)}
                resourceName={resource.name}
                resourceNamespace={resource.namespace}
                resourceKind={resource.kind}
            />

            {/* Condition Detail Modal */}
            {selectedCondition && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setSelectedCondition(null)}>
                    <div
                        className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 bg-zinc-800/50">
                            <div className="flex items-center gap-3">
                                {selectedCondition.status === 'True' ? (
                                    <CheckCircle2 size={20} className="text-emerald-400" />
                                ) : selectedCondition.status === 'False' ? (
                                    <XCircle size={20} className="text-red-400" />
                                ) : (
                                    <AlertCircle size={20} className="text-yellow-400" />
                                )}
                                <h3 className="text-lg font-semibold text-white">{selectedCondition.type}</h3>
                            </div>
                            <button onClick={() => setSelectedCondition(null)} className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg">
                                <X size={18} />
                            </button>
                        </div>
                        <div className="p-5 space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Status</div>
                                    <StatusBadge status={selectedCondition.status} />
                                </div>
                                {selectedCondition.reason && (
                                    <div>
                                        <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Reason</div>
                                        <div className="text-sm text-white">{selectedCondition.reason}</div>
                                    </div>
                                )}
                            </div>
                            {selectedCondition.message && (
                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Message</div>
                                    <div className="text-sm text-zinc-300 bg-zinc-800/50 rounded-lg p-3 border border-zinc-700">
                                        {selectedCondition.message}
                                    </div>
                                </div>
                            )}
                            <div>
                                <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Last Transition</div>
                                <div className="text-sm text-zinc-400">{formatTimestamp(selectedCondition.lastTransitionTime)}</div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Event Detail Modal */}
            {selectedEvent && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setSelectedEvent(null)}>
                    <div
                        className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className={`flex items-center justify-between px-5 py-4 border-b ${selectedEvent.type === 'Warning' ? 'border-orange-500/30 bg-orange-500/10' : 'border-zinc-800 bg-zinc-800/50'}`}>
                            <div className="flex items-center gap-3">
                                {selectedEvent.type === 'Warning' ? (
                                    <AlertTriangle size={20} className="text-orange-400" />
                                ) : (
                                    <Info size={20} className="text-blue-400" />
                                )}
                                <h3 className="text-lg font-semibold text-white">{selectedEvent.reason || selectedEvent.type}</h3>
                            </div>
                            <button onClick={() => setSelectedEvent(null)} className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg">
                                <X size={18} />
                            </button>
                        </div>
                        <div className="p-5 space-y-4">
                            <div>
                                <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Message</div>
                                <div className="text-sm text-zinc-300 bg-zinc-800/50 rounded-lg p-3 border border-zinc-700">
                                    {selectedEvent.message}
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Count</div>
                                    <div className="text-sm text-white">{selectedEvent.count || 1}</div>
                                </div>
                                <div>
                                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Type</div>
                                    <div className="text-sm text-white">{selectedEvent.type}</div>
                                </div>
                            </div>
                            <div>
                                <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Timestamp</div>
                                <div className="text-sm text-zinc-400">{selectedEvent.lastTimestamp || selectedEvent.eventTime}</div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Hero Status Section - Compact */}
            <div className="bg-zinc-900/80 rounded-xl border border-zinc-800/80 p-4 shadow-xl">
                <div className="flex items-center justify-between gap-3 mb-3">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="p-2.5 bg-gradient-to-br from-cyan-500/20 to-blue-600/20 rounded-lg border border-cyan-500/30 shadow-lg shadow-cyan-500/10 shrink-0">
                            <Box size={20} className="text-cyan-400" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <h2 className="text-lg font-bold text-white truncate flex items-center gap-2">
                                <span className="truncate">{resource.name}</span>
                                {loading && <Loader2 size={14} className="animate-spin text-cyan-500 shrink-0" />}
                            </h2>
                            <div className="flex items-center gap-2 text-xs">
                                <span className="font-mono text-[10px] bg-zinc-800 text-zinc-300 px-1.5 py-0.5 rounded border border-zinc-700 truncate max-w-[100px]">
                                    {resource.kind}
                                </span>
                                <span className="text-zinc-600 shrink-0">•</span>
                                <span className="text-zinc-400 truncate">{resource.namespace}</span>
                            </div>
                        </div>
                    </div>
                    <StatusBadge status={resource.status} size="md" />
                </div>

                {/* Quick Info Grid - 2x2 on mobile, 4 on larger */}
                <div className="grid grid-cols-2 gap-2">
                    <InfoCard
                        icon={Hash}
                        label="UID"
                        value={resource.id ? resource.id.slice(0, 8) + '...' : 'N/A'}
                        fullValue={resource.id}
                        copyable
                    />
                    <InfoCard
                        icon={Clock}
                        label="Age"
                        value={resource.age || 'Unknown'}
                    />
                    <InfoCard
                        icon={GitBranch}
                        label="API"
                        value={`${resource.group || 'core'}/${resource.version}`}
                    />
                    <InfoCard
                        icon={Calendar}
                        label="Created"
                        value={creationTime ? creationTime.split('T')[0] : 'Unknown'}
                        fullValue={formatTimestamp(creationTime)}
                    />
                </div>
            </div>

            {/* Labels & Annotations - Side by side */}
            <div className="grid grid-cols-2 gap-4">
                <Section
                    title="Labels"
                    icon={<Tag size={14} className="text-cyan-400" />}
                    count={labelEntries.length}
                    onExpand={() => setLabelsModalOpen(true)}
                >
                    <div className="flex flex-wrap gap-2">
                        {labelEntries.length > 0 ? (
                            labelEntries.slice(0, 4).map(([k, v]) => (
                                <LabelChip key={k} name={k} value={String(v)} type="label" />
                            ))
                        ) : (
                            <span className="text-sm text-zinc-500 italic">No labels</span>
                        )}
                        {labelEntries.length > 4 && (
                            <button
                                onClick={() => setLabelsModalOpen(true)}
                                className="text-xs text-cyan-400 hover:text-cyan-300 font-medium px-2 py-1 rounded-lg hover:bg-cyan-500/10 transition-colors"
                            >
                                +{labelEntries.length - 4} more
                            </button>
                        )}
                    </div>
                </Section>

                <Section
                    title="Annotations"
                    icon={<Info size={14} className="text-purple-400" />}
                    count={Object.keys(filteredAnnotations).length}
                    onExpand={() => setAnnotationsModalOpen(true)}
                >
                    <div className="flex flex-wrap gap-2">
                        {Object.keys(filteredAnnotations).length > 0 ? (
                            Object.entries(filteredAnnotations).slice(0, 3).map(([k, v]) => (
                                <LabelChip key={k} name={k} value={String(v)} type="annotation" />
                            ))
                        ) : (
                            <span className="text-sm text-zinc-500 italic">No annotations</span>
                        )}
                        {Object.keys(filteredAnnotations).length > 3 && (
                            <button
                                onClick={() => setAnnotationsModalOpen(true)}
                                className="text-xs text-purple-400 hover:text-purple-300 font-medium px-2 py-1 rounded-lg hover:bg-purple-500/10 transition-colors"
                            >
                                +{Object.keys(filteredAnnotations).length - 3} more
                            </button>
                        )}
                    </div>
                </Section>
            </div>

            {/* Resource Details (Kind Specific) - MOVED UP: now above Conditions */}
            <ResourceDetails kind={resource.kind} fullObject={fullObject} currentContext={currentContext} />

            {/* Resource Metrics (only for Nodes) */}
            {resource.kind === 'Node' && (
                <Section
                    title="Metrics"
                    icon={<Activity size={14} className="text-green-400" />}
                >
                    <MetricsChart resourceKind={resource.kind} namespace={resource.namespace} name={resource.name} currentContext={currentContext} />
                </Section>
            )}

            {/* Conditions */}
            {conditions.length > 0 && (
                <Section
                    title="Conditions"
                    icon={<Activity size={14} className="text-blue-400" />}
                    count={conditions.length}
                >
                    <div className="space-y-2">
                        {conditions.slice(0, 4).map((c: any, i: number) => (
                            <ConditionRow key={i} condition={c} onClick={() => setSelectedCondition(c)} />
                        ))}
                        {conditions.length > 4 && (
                            <div className="text-center text-xs text-zinc-500 pt-2">
                                +{conditions.length - 4} more conditions
                            </div>
                        )}
                    </div>
                </Section>
            )}

            {/* Recent Events */}
            <Section
                title="Events"
                icon={<AlertCircle size={14} className="text-orange-400" />}
                count={recentEvents?.length}
            >
                {recentEvents && recentEvents.length > 0 ? (
                    <div className="space-y-2">
                        {recentEvents.slice(0, 3).map((e: any, i: number) => (
                            <EventItem key={i} event={e} onClick={() => setSelectedEvent(e)} />
                        ))}
                        {recentEvents.length > 3 && (
                            <div className="text-center text-xs text-zinc-500 pt-2">
                                +{recentEvents.length - 3} more events
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="flex items-center justify-center py-6 text-zinc-500">
                        <CheckCircle2 size={18} className="mr-2 opacity-30" />
                        <span className="text-sm">No recent events</span>
                    </div>
                )}
            </Section>

            {/* AI Assistant - Timeline Style */}
            <div className="bg-gradient-to-br from-purple-900/20 via-zinc-900/50 to-zinc-900/50 rounded-xl border border-purple-500/20 overflow-hidden relative">
                {/* Decorative background effects */}
                <div className="absolute top-0 left-0 right-0 h-16 bg-gradient-to-b from-purple-500/5 to-transparent pointer-events-none" />

                <div className="flex items-center justify-between px-4 py-3 bg-purple-500/10 border-b border-purple-500/20 relative">
                    <div className="flex items-center gap-2.5">
                        <div className="relative">
                            <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-fuchsia-500 rounded-lg blur-sm opacity-40" />
                            <div className="relative p-2 bg-gradient-to-br from-violet-500/80 to-fuchsia-500/80 rounded-lg">
                                <Sparkles size={14} className="text-white" />
                            </div>
                        </div>
                        <span className="text-sm font-semibold text-white">AI Assistant</span>
                        <span className="text-xs text-purple-400 bg-purple-500/20 px-1.5 py-0.5 rounded-full">BETA</span>
                    </div>
                    {llmLoading && <Loader2 size={14} className="animate-spin text-purple-400" />}
                </div>
                <div className="h-[220px] overflow-y-auto p-4 space-y-4" ref={scrollContainerRef}>
                    {chatHistory.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-zinc-500">
                            <div className="relative mb-4">
                                <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-cyan-500 rounded-xl blur-lg opacity-15" />
                                <div className="relative w-14 h-14 rounded-xl bg-gradient-to-br from-violet-500/15 to-cyan-500/15 flex items-center justify-center border border-violet-500/15">
                                    <Sparkles size={24} className="text-violet-400/60" />
                                </div>
                            </div>
                            <p className="text-sm font-medium text-zinc-400">Ask about this {resource.kind}</p>
                            <div className="flex flex-wrap gap-2 justify-center mt-3 max-w-[250px]">
                                {['Why failing?', 'Explain config', 'Check health', 'Show logs'].map(q => (
                                    <button
                                        key={q}
                                        onClick={() => sendMessage(q)}
                                        className="px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white rounded-lg transition-colors border border-white/10"
                                    >
                                        {q}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {chatHistory.map((msg, i) => (
                        <div key={i} className="animate-in fade-in slide-in-from-bottom-1 duration-200">
                            {/* User Message - Task/Query */}
                            {msg.role === 'user' && (
                                <div className="relative pl-5 pb-3">
                                    <div className="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full bg-violet-500 ring-2 ring-violet-500/20" />
                                    <div className="absolute left-[4px] top-4 bottom-0 w-0.5 bg-gradient-to-b from-violet-500/40 to-transparent" />
                                    <div className="ml-3">
                                        <span className="text-xs font-medium text-violet-400 uppercase tracking-wider">Task</span>
                                        <div className="bg-gradient-to-br from-violet-600/20 to-fuchsia-600/20 rounded-lg px-3 py-2 border border-violet-500/30 mt-1">
                                            <p className="text-sm text-white">{msg.content}</p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Tool Execution */}
                            {msg.role === 'tool' && (
                                <div className="relative pl-5 pb-3">
                                    <div className="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full bg-cyan-500 ring-2 ring-cyan-500/20" />
                                    <div className="absolute left-[4px] top-4 bottom-0 w-0.5 bg-gradient-to-b from-cyan-500/40 to-transparent" />
                                    <div className="ml-3 space-y-1.5">
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs font-medium text-cyan-400 uppercase tracking-wider">Tool</span>
                                            <span className="text-xs text-zinc-600">→</span>
                                            <span className="text-xs font-mono text-cyan-300 bg-cyan-500/10 px-2 py-0.5 rounded">{msg.toolName}</span>
                                        </div>
                                        {msg.command && (
                                            <code className="block text-xs text-emerald-400 font-mono bg-black/30 px-2.5 py-1 rounded-lg break-all">$ {msg.command}</code>
                                        )}
                                        <div className="bg-[#0d1117] rounded-lg border border-[#21262d] overflow-hidden">
                                            <div className="px-3 py-1.5 bg-[#161b22] border-b border-[#21262d] flex items-center gap-2">
                                                <div className="w-2 h-2 rounded-full bg-emerald-500/80" />
                                                <span className="text-xs text-zinc-500 uppercase tracking-wider">Output</span>
                                            </div>
                                            <div className="px-3 py-2 max-h-[120px] overflow-y-auto">
                                                <ReactMarkdown
                                                    remarkPlugins={[remarkGfm]}
                                                    components={{
                                                        p: ({ children }) => <p className="text-xs text-zinc-300 my-1 leading-relaxed">{children}</p>,
                                                        strong: ({ children }) => <strong className="text-emerald-300 font-semibold">{children}</strong>,
                                                        code: ({ children }) => <code className="text-xs bg-black/40 px-1.5 py-0.5 rounded text-cyan-300 font-mono">{children}</code>,
                                                        ul: ({ children }) => <ul className="text-xs list-none ml-0 my-1 space-y-0.5">{children}</ul>,
                                                        li: ({ children }) => <li className="text-zinc-400 before:content-['•'] before:text-cyan-500 before:mr-1.5">{children}</li>,
                                                        h2: ({ children }) => <h2 className="text-xs font-semibold text-cyan-300 mt-1.5 mb-1">{children}</h2>,
                                                    }}
                                                >
                                                    {msg.content}
                                                </ReactMarkdown>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Assistant Response */}
                            {msg.role === 'assistant' && (
                                (msg.isActivity || msg.content.includes('🔄 Investigating') || msg.content.includes('Continuing investigation')) ? (
                                    <div className="relative pl-5 pb-3">
                                        <div className="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full bg-amber-500 ring-2 ring-amber-500/20 animate-pulse" />
                                        <div className="absolute left-[4px] top-4 bottom-0 w-0.5 bg-gradient-to-b from-amber-500/40 to-transparent" />
                                        <div className="ml-3">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-medium text-amber-400 uppercase tracking-wider">Thinking</span>
                                                <Loader2 size={12} className="text-amber-400 animate-spin" />
                                            </div>
                                            <p className="text-xs text-zinc-400 mt-1 italic">
                                                {msg.content.replace(/\*|🔄/g, '').replace(/Investigating\.\.\.|Continuing investigation\.\.\./, '').trim() || 'Analyzing...'}
                                            </p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="relative pl-5 pb-3">
                                        <div className="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20" />
                                        <div className="ml-3">
                                            <div className="flex items-center gap-2 mb-1.5">
                                                <span className="text-xs font-medium text-emerald-400 uppercase tracking-wider">Analysis</span>
                                                <Sparkles size={12} className="text-emerald-400" />
                                            </div>
                                            <div className="bg-[#0d1117] rounded-lg border border-[#21262d] overflow-hidden">
                                                <div className="px-3 py-2.5 prose prose-invert prose-sm max-w-none">
                                                    <ReactMarkdown
                                                        remarkPlugins={[remarkGfm]}
                                                        components={{
                                                            p: ({ children }) => <p className="text-sm text-zinc-300 my-1.5 leading-relaxed">{children}</p>,
                                                            strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
                                                            code: ({ children }) => <code className="text-xs bg-black/40 px-1.5 py-0.5 rounded text-cyan-300 font-mono">{children}</code>,
                                                            ul: ({ children }) => <ul className="text-sm list-none ml-0 my-1.5 space-y-1">{children}</ul>,
                                                            li: ({ children }) => <li className="text-zinc-300 before:content-['→'] before:text-emerald-500 before:mr-2 before:font-bold">{children}</li>,
                                                            h2: ({ children }) => <h2 className="text-sm font-bold text-emerald-300 mt-3 mb-1.5 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />{children}</h2>,
                                                            h3: ({ children }) => <h3 className="text-sm font-semibold text-cyan-300 mt-2 mb-1">{children}</h3>,
                                                        }}
                                                    >
                                                        {fixMarkdownHeaders(msg.content)}
                                                    </ReactMarkdown>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )
                            )}
                        </div>
                    ))}
                    {llmLoading && (
                        <div className="relative pl-5 pb-3 animate-in fade-in slide-in-from-bottom-1 duration-200">
                            <div className="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full bg-violet-500 ring-2 ring-violet-500/20 animate-pulse" />
                            <div className="absolute left-[4px] top-4 bottom-0 w-0.5 bg-gradient-to-b from-violet-500/40 to-transparent" />
                            <div className="ml-3">
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium text-violet-400 uppercase tracking-wider">Processing</span>
                                    <div className="flex gap-1">
                                        <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                                        <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                                        <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                                    </div>
                                </div>
                                <p className="text-xs text-zinc-500 mt-1">{currentActivity}</p>
                            </div>
                        </div>
                    )}
                    <div ref={chatEndRef} />
                </div>
                <div className="p-3 bg-zinc-900/70 border-t border-zinc-800 relative">
                    <form onSubmit={(e) => { e.preventDefault(); sendMessage(userInput); }} className="flex items-center gap-2 p-1.5 bg-white/5 border border-white/10 rounded-full focus-within:border-violet-500/30 focus-within:bg-white/10 transition-all">
                        <input
                            type="text"
                            value={userInput}
                            onChange={(e) => setUserInput(e.target.value)}
                            placeholder="Ask about this resource..."
                            className="flex-1 px-3 py-2 bg-transparent border-none text-white text-sm placeholder-zinc-500 focus:outline-none min-w-0"
                            disabled={llmLoading}
                        />
                        <button
                            type="submit"
                            disabled={!userInput.trim() || llmLoading}
                            className="p-1.5 rounded-full bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 disabled:from-zinc-700 disabled:to-zinc-700 disabled:text-zinc-500 text-white transition-all shadow-lg shadow-purple-500/20 disabled:shadow-none flex-shrink-0"
                        >
                            <Send size={10} className={llmLoading ? 'animate-pulse' : ''} />
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}
