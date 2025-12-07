import React, { useState, useRef, useMemo, useEffect } from 'react';
import { Search, Cpu, Network, HardDrive, FileCode, Shield, Server } from 'lucide-react';
import { NavGroup, NavResource } from '../../types/k8s';

interface CommandPaletteProps {
    isOpen: boolean;
    onClose: () => void;
    navStructure: NavGroup[] | undefined;
    onNavigate: (res: NavResource) => void;
}

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

export function CommandPalette({
    isOpen,
    onClose,
    navStructure,
    onNavigate
}: CommandPaletteProps) {
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
