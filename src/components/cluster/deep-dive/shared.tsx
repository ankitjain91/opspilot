
import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export function TabButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
    return (
        <button
            onClick={onClick}
            className={`px-3 py-3 text-sm font-semibold flex items-center gap-2.5 border-b-2 transition-colors whitespace-nowrap ${
                active
                    ? "border-cyan-400 text-white bg-cyan-500/5"
                    : "border-transparent text-gray-500 hover:text-gray-200 hover:bg-white/5"
            }`}
        >
            {icon} {label}
        </button>
    );
}

export function CollapsibleSection({ title, icon, children, defaultOpen = true }: { title: string, icon: React.ReactNode, children: React.ReactNode, defaultOpen?: boolean }) {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    return (
        <div className="bg-[#0b0b10] rounded-xl border border-[#1a1a22] overflow-hidden shadow-lg shadow-black/30">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-center justify-between px-4 py-3 bg-[#0f0f16] hover:bg-[#141420] transition-all duration-150 border-b border-[#1a1a22]"
            >
                <div className="flex items-center gap-2.5 text-xs font-bold text-[#e5e7eb] uppercase tracking-wide">
                    {icon}
                    {title}
                </div>
                <ChevronDown
                    size={16}
                    className={`text-[#7f7f8a] transition-transform duration-200 ${isOpen ? '' : '-rotate-90'}`}
                />
            </button>
            {isOpen && (
                <div className="p-4 bg-[#0b0b10]">
                    {children}
                </div>
            )}
        </div>
    );
}

// Helpers - recursive rendering of nested objects
export const renderValue = (v: any, depth = 0): React.ReactNode => {
    if (v === null || v === undefined) return <span className="text-[#858585] italic text-sm">null</span>;
    if (typeof v === 'boolean') return <span className={`px-1.5 py-0.5 rounded text-sm ${v ? 'bg-green-500/10 text-green-300' : 'bg-red-500/10 text-red-300'}`}>{String(v)}</span>;
    if (typeof v === 'number') return <span className="text-[#9fe5c1] font-mono text-sm">{v}</span>;
    if (typeof v === 'string') return <span className="text-[#d8def5] break-all font-mono text-sm">{v || <span className="text-[#858585] italic">""</span>}</span>;
    if (Array.isArray(v)) {
        if (v.length === 0) return <span className="text-[#858585] italic text-sm">[]</span>;
        // For simple arrays (strings, numbers), show inline
        if (v.every(item => typeof item === 'string' || typeof item === 'number')) {
            return <span className="text-[#d8def5] font-mono text-sm">{v.join(', ')}</span>;
        }
        // For complex arrays, show each item
        return (
            <div className="ml-3 mt-2 space-y-2 border-l-2 border-[#1f1f2b] pl-3">
                {v.map((item, i) => (
                    <div key={i} className="text-sm bg-[#0f0f16] border border-[#1f1f2b] rounded-lg px-3 py-2">
                        <div className="text-xs text-[#7f7f8a] mb-1 font-medium">[{i}]</div>
                        <div className="pl-1">{renderValue(item, depth + 1)}</div>
                    </div>
                ))}
            </div>
        );
    }
    if (typeof v === 'object') {
        const entries = Object.entries(v);
        if (entries.length === 0) return <span className="text-[#858585] italic text-sm">{'{}'}</span>;
        return (
            <div className={depth > 0 ? "ml-3 mt-2 space-y-2 border-l-2 border-[#1f1f2b] pl-3" : "space-y-2"}>
                {entries.map(([key, val]) => (
                    <div key={key} className="text-sm bg-[#0f0f16] border border-[#1f1f2b] rounded-lg px-3 py-2">
                        <div className="text-[#8ab4ff] font-mono font-medium">{key}:</div>
                        <div className="pl-2 mt-1">{renderValue(val, depth + 1)}</div>
                    </div>
                ))}
            </div>
        );
    }
    return <span className="text-[#cccccc] text-sm">{String(v)}</span>;
};

export const renderKV = (obj: any) => obj ? Object.entries(obj).map(([k, v]) => (
    <div key={k} className="py-2 border-b border-[#1f1f2b] last:border-b-0">
        <div className="flex gap-4 items-start">
            <span className="text-[#8ab4ff] font-mono text-sm min-w-[140px] shrink-0 font-medium">{k}</span>
            <div className="text-[#e5e7eb] text-sm break-all flex-1 leading-relaxed">{renderValue(v)}</div>
        </div>
    </div>
)) : <span className="text-[#858585] italic text-sm">None</span>;
