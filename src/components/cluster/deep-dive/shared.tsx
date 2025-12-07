
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
        <div className="bg-[#1e1e1e] rounded-[4px] border border-[#3e3e42] overflow-hidden">
            <button onClick={() => setIsOpen(!isOpen)} className="w-full flex items-center justify-between px-3 py-2 bg-[#252526] hover:bg-[#2d2d30] transition-colors border-b border-[#3e3e42]">
                <div className="flex items-center gap-2 text-[11px] font-bold text-[#cccccc] uppercase tracking-wide">
                    {icon}
                    {title}
                </div>
                {isOpen ? <ChevronDown size={14} className="text-[#858585]" /> : <ChevronRight size={14} className="text-[#858585]" />}
            </button>
            {isOpen && (
                <div className="p-3 bg-[#1e1e1e]">
                    {children}
                </div>
            )}
        </div>
    );
}

// Helpers - recursive rendering of nested objects
export const renderValue = (v: any, depth = 0): React.ReactNode => {
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

export const renderKV = (obj: any) => obj ? Object.entries(obj).map(([k, v]) => (
    <div key={k} className="py-1 border-b border-[#2d2d30] last:border-b-0">
        <div className="flex gap-4">
            <span className="text-[#569cd6] font-mono text-[11px] min-w-[120px] shrink-0">{k}</span>
            <div className="text-[#cccccc] font-mono text-[11px] break-all flex-1">{renderValue(v)}</div>
        </div>
    </div>
)) : <span className="text-[#858585] italic text-xs">None</span>;
