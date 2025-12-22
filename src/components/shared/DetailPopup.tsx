import React, { useEffect, useRef, useState } from 'react';
import { X, Copy, CheckCircle2, Maximize2, ChevronRight, ChevronDown } from 'lucide-react';

type DetailContent =
    | { type: 'text'; value: string }
    | { type: 'keyValue'; data: Record<string, string> }
    | { type: 'json'; data: any };

interface DetailPopupProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    subtitle?: string;
    content: DetailContent;
    accentColor?: 'purple' | 'blue' | 'emerald' | 'amber' | 'zinc';
}

const colorMap = {
    purple: {
        border: 'border-purple-500/30',
        shadow: 'shadow-purple-500/10',
        iconBg: 'bg-purple-500/10',
        iconText: 'text-purple-400',
        headerBorder: 'border-purple-500/20',
    },
    blue: {
        border: 'border-blue-500/30',
        shadow: 'shadow-blue-500/10',
        iconBg: 'bg-blue-500/10',
        iconText: 'text-blue-400',
        headerBorder: 'border-blue-500/20',
    },
    emerald: {
        border: 'border-emerald-500/30',
        shadow: 'shadow-emerald-500/10',
        iconBg: 'bg-emerald-500/10',
        iconText: 'text-emerald-400',
        headerBorder: 'border-emerald-500/20',
    },
    amber: {
        border: 'border-amber-500/30',
        shadow: 'shadow-amber-500/10',
        iconBg: 'bg-amber-500/10',
        iconText: 'text-amber-400',
        headerBorder: 'border-amber-500/20',
    },
    zinc: {
        border: 'border-zinc-500/30',
        shadow: 'shadow-zinc-500/10',
        iconBg: 'bg-zinc-500/10',
        iconText: 'text-zinc-400',
        headerBorder: 'border-zinc-500/20',
    },
};

// Copy button component
const CopyAllButton = ({ text, label = 'Copy All' }: { text: string; label?: string }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded-md text-xs text-zinc-400 hover:text-zinc-200 transition-all"
        >
            {copied ? (
                <>
                    <CheckCircle2 size={12} className="text-emerald-400" />
                    <span className="text-emerald-400">Copied!</span>
                </>
            ) : (
                <>
                    <Copy size={12} />
                    <span>{label}</span>
                </>
            )}
        </button>
    );
};

// Expandable key-value row
const KeyValueRow = ({ keyName, value, isLast }: { keyName: string; value: string; isLast: boolean }) => {
    const [copied, setCopied] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const isLongValue = value.length > 80;

    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div
            className={`group ${!isLast ? 'border-b border-white/5' : ''}`}
        >
            <div
                className={`flex items-start gap-3 px-4 py-3 ${isLongValue ? 'cursor-pointer hover:bg-white/5' : ''} transition-colors`}
                onClick={() => isLongValue && setExpanded(!expanded)}
            >
                {isLongValue && (
                    <div className="pt-0.5 text-zinc-500">
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </div>
                )}
                <div className="flex-1 min-w-0">
                    <div className="text-xs text-zinc-500 font-medium mb-1">{keyName}</div>
                    <div
                        className={`text-sm text-zinc-200 font-mono ${!expanded && isLongValue ? 'truncate' : 'break-all whitespace-pre-wrap'}`}
                    >
                        {value}
                    </div>
                </div>
                <button
                    onClick={handleCopy}
                    className={`shrink-0 p-1.5 rounded transition-all ${copied
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : 'opacity-0 group-hover:opacity-100 hover:bg-white/10 text-zinc-500 hover:text-zinc-300'
                        }`}
                    title="Copy value"
                >
                    {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                </button>
            </div>
        </div>
    );
};

// Text content display
const TextContent = ({ value }: { value: string }) => {
    return (
        <div className="p-4">
            <div className="bg-black/30 rounded-lg p-4 border border-white/5">
                <pre className="text-sm text-zinc-200 font-mono whitespace-pre-wrap break-all">
                    {value}
                </pre>
            </div>
            <div className="mt-3 flex justify-end">
                <CopyAllButton text={value} label="Copy" />
            </div>
        </div>
    );
};

// Key-Value content display
const KeyValueContent = ({ data }: { data: Record<string, string> }) => {
    const entries = Object.entries(data);
    const allText = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    return (
        <div className="flex flex-col">
            <div className="max-h-[60vh] overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-700">
                {entries.map(([key, value], index) => (
                    <KeyValueRow
                        key={key}
                        keyName={key}
                        value={String(value)}
                        isLast={index === entries.length - 1}
                    />
                ))}
            </div>
            <div className="p-3 border-t border-white/5 flex justify-between items-center bg-black/20">
                <span className="text-xs text-zinc-500">{entries.length} items</span>
                <CopyAllButton text={allText} />
            </div>
        </div>
    );
};

// JSON content display
const JsonContent = ({ data }: { data: any }) => {
    const jsonStr = JSON.stringify(data, null, 2);

    return (
        <div className="p-4">
            <div className="bg-black/30 rounded-lg border border-white/5 max-h-[60vh] overflow-auto scrollbar-thin scrollbar-thumb-zinc-700">
                <pre className="p-4 text-xs text-zinc-300 font-mono whitespace-pre">
                    {jsonStr}
                </pre>
            </div>
            <div className="mt-3 flex justify-end">
                <CopyAllButton text={jsonStr} label="Copy JSON" />
            </div>
        </div>
    );
};

export function DetailPopup({ isOpen, onClose, title, subtitle, content, accentColor = 'purple' }: DetailPopupProps) {
    const modalRef = useRef<HTMLDivElement>(null);
    const colors = colorMap[accentColor];

    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };

        if (isOpen) {
            document.addEventListener('keydown', handleEscape);
            document.body.style.overflow = 'hidden';
        }

        return () => {
            document.removeEventListener('keydown', handleEscape);
            document.body.style.overflow = '';
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div
                ref={modalRef}
                className={`w-full max-w-2xl mx-4 bg-gradient-to-br from-[#1a1a1f] to-[#0f0f12] border ${colors.border} rounded-xl shadow-2xl ${colors.shadow} overflow-hidden animate-in zoom-in-95 duration-200`}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className={`flex items-center justify-between px-5 py-4 border-b ${colors.headerBorder} bg-black/20`}>
                    <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-lg ${colors.iconBg}`}>
                            <Maximize2 size={16} className={colors.iconText} />
                        </div>
                        <div>
                            <h2 className="text-base font-semibold text-white">{title}</h2>
                            {subtitle && (
                                <p className="text-xs text-zinc-500 mt-0.5">{subtitle}</p>
                            )}
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg hover:bg-white/10 text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Content */}
                {content.type === 'text' && <TextContent value={content.value} />}
                {content.type === 'keyValue' && <KeyValueContent data={content.data} />}
                {content.type === 'json' && <JsonContent data={content.data} />}
            </div>
        </div>
    );
}
