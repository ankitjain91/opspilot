
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
