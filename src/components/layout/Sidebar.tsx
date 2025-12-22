
import React from 'react';
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import { NavResource } from '../../types/k8s';

interface SidebarGroupProps {
    title: string;
    icon: LucideIcon;
    items: NavResource[];
    activeRes: NavResource | null;
    onSelect: (res: NavResource) => void;
    isOpen: boolean;
    onToggle: () => void;
}

export const SidebarGroup = ({ title, icon: Icon, items, activeRes, onSelect, isOpen, onToggle }: SidebarGroupProps) => {
    if (items.length === 0) return null;

    // These colors work well on both light and dark
    const groupColors: Record<string, string> = {
        "Cluster": "text-blue-500",
        "Workloads": "text-purple-500",
        "Config": "text-amber-500",
        "Network": "text-emerald-500",
        "Storage": "text-orange-500",
        "Access Control": "text-rose-500",
    };

    return (
        <div className="mb-1">
            <button
                onClick={onToggle}
                className="w-full flex items-center justify-between px-3 py-2.5 text-base font-medium rounded-md transition-all group"
                style={{
                    color: 'var(--text-secondary)',
                }}
            >
                <div className="flex items-center gap-2.5">
                    <Icon size={18} className={groupColors[title] || "text-cyan-500"} />
                    <span className="group-hover:opacity-100" style={{ color: 'var(--text-primary)' }}>{title}</span>
                </div>
                {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>

            {isOpen && (
                <div className="mt-1 ml-3 pl-3 space-y-0.5" style={{ borderLeft: '1px solid var(--border-subtle)' }}>
                    {items.map((res: any) => (
                        <button
                            key={`${res.group}/${res.kind}`}
                            onClick={() => onSelect(res)}
                            className={`w-full text-left px-3 py-2 text-base rounded-md transition-all flex items-center gap-2.5 ${activeRes?.kind === res.kind
                                ? "bg-gradient-to-r from-purple-600/80 to-blue-600/80 text-white font-medium shadow-lg shadow-purple-500/20"
                                : ""
                                }`}
                            style={activeRes?.kind !== res.kind ? {
                                color: 'var(--text-tertiary)',
                            } : undefined}
                        >
                            {res.title}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

interface SidebarSectionProps {
    title: string;
    icon: LucideIcon;
    isOpen: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}

export const SidebarSection = ({ title, icon: Icon, isOpen, onToggle, children }: SidebarSectionProps) => {
    return (
        <div className="mb-1">
            <button
                onClick={onToggle}
                className="w-full flex items-center justify-between px-3 py-2.5 text-base font-medium rounded-md transition-all group"
                style={{ color: 'var(--text-secondary)' }}
            >
                <div className="flex items-center gap-2.5">
                    <Icon size={18} className="text-pink-500" />
                    <span style={{ color: 'var(--text-primary)' }}>{title}</span>
                </div>
                {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>

            {isOpen && (
                <div className="mt-1 ml-3 pl-3 space-y-0.5" style={{ borderLeft: '1px solid var(--border-subtle)' }}>
                    {children}
                </div>
            )}
        </div>
    );
}
