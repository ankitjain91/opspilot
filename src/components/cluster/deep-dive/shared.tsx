
import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export function TabButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
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

export function CollapsibleSection({ title, icon, children, defaultOpen = true }: { title: string, icon: React.ReactNode, children: React.ReactNode, defaultOpen?: boolean }) {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    return (
        <div className="bg-[#0b0b10] rounded-[10px] border border-[#1a1a22] overflow-hidden shadow-lg shadow-black/30">
            <button onClick={() => setIsOpen(!isOpen)} className="w-full flex items-center justify-between px-3 py-2 bg-gradient-to-r from-[#0f0f16] via-[#101018] to-[#0f0f16] hover:from-[#13131c] hover:to-[#13131c] transition-colors border-b border-[#1a1a22]">
                <div className="flex items-center gap-2 text-[11px] font-bold text-[#e5e7eb] uppercase tracking-wide">
                    {icon}
                    {title}
                </div>
                {isOpen ? <ChevronDown size={14} className="text-[#7f7f8a]" /> : <ChevronRight size={14} className="text-[#7f7f8a]" />}
            </button>
            {isOpen && (
                <div className="p-3 bg-[#0b0b10]">
                    {children}
                </div>
            )}
        </div>
    );
}

// Helpers - recursive rendering of nested objects
export const renderValue = (v: any, depth = 0): React.ReactNode => {
    if (v === null || v === undefined) return <span className="text-[#858585] italic">null</span>;
    if (typeof v === 'boolean') return <span className={`px-1 rounded ${v ? 'bg-green-500/10 text-green-300' : 'bg-red-500/10 text-red-300'}`}>{String(v)}</span>;
    if (typeof v === 'number') return <span className="text-[#9fe5c1] font-mono">{v}</span>;
    if (typeof v === 'string') return <span className="text-[#d8def5] break-all font-mono">{v || <span className="text-[#858585] italic">""</span>}</span>;
    if (Array.isArray(v)) {
        if (v.length === 0) return <span className="text-[#858585] italic">[]</span>;
        // For simple arrays (strings, numbers), show inline
        if (v.every(item => typeof item === 'string' || typeof item === 'number')) {
            return <span className="text-[#d8def5] font-mono">{v.join(', ')}</span>;
        }
        // For complex arrays, show each item
        return (
            <div className="ml-3 mt-1 space-y-1 border-l border-[#1f1f2b] pl-2">
                {v.map((item, i) => (
                    <div key={i} className="text-[10px] bg-[#0f0f16] border border-[#1f1f2b] rounded px-2 py-1">
                        <div className="text-[9px] text-[#7f7f8a] mb-0.5">[{i}]</div>
                        <div className="pl-1">{renderValue(item, depth + 1)}</div>
                    </div>
                ))}
            </div>
        );
    }
    if (typeof v === 'object') {
        const entries = Object.entries(v);
        if (entries.length === 0) return <span className="text-[#858585] italic">{'{}'}</span>;
        return (
            <div className={depth > 0 ? "ml-3 mt-1 space-y-1 border-l border-[#1f1f2b] pl-2" : "space-y-1"}>
                {entries.map(([key, val]) => (
                    <div key={key} className="text-[10px] bg-[#0f0f16] border border-[#1f1f2b] rounded px-2 py-1">
                        <div className="text-[#8ab4ff] font-mono">{key}:</div>
                        <div className="pl-2">{renderValue(val, depth + 1)}</div>
                    </div>
                ))}
            </div>
        );
    }
    return <span className="text-[#cccccc]">{String(v)}</span>;
};

export const renderKV = (obj: any) => obj ? Object.entries(obj).map(([k, v]) => (
    <div key={k} className="py-1 border-b border-[#1f1f2b] last:border-b-0">
        <div className="flex gap-4 items-start">
            <span className="text-[#8ab4ff] font-mono text-[11px] min-w-[120px] shrink-0">{k}</span>
            <div className="text-[#e5e7eb] text-[11px] break-all flex-1 leading-relaxed">{renderValue(v)}</div>
        </div>
    </div>
)) : <span className="text-[#858585] italic text-xs">None</span>;
