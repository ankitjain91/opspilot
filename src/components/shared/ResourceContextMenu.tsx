import React, { useState, useRef, useEffect } from 'react';
import { Eye, Copy, Loader2, Trash2, MoreVertical } from 'lucide-react';
import { K8sObject } from '../../types/k8s';

interface ResourceContextMenuProps {
    resource: K8sObject;
    onViewDetails: () => void;
    onDelete: () => void;
    isPod?: boolean;
    disabled?: boolean;
}

export function ResourceContextMenu({
    resource,
    onViewDetails,
    onDelete,
    isPod = false,
    disabled = false
}: ResourceContextMenuProps) {
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
        { label: disabled ? 'Deleting...' : 'Delete', icon: disabled ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />, action: () => { if (!disabled) { onDelete(); setIsOpen(false); } }, danger: true, disabled },
    ];

    return (
        <div className="relative" ref={menuRef}>
            <button
                onClick={(e) => { e.stopPropagation(); if (!disabled) setIsOpen(!isOpen); }}
                className={`p-1.5 rounded-md hover:bg-white/10 text-zinc-500 hover:text-zinc-300 transition-[color,background-color,opacity] opacity-0 group-hover:opacity-100 ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                title={disabled ? "Deleting..." : "Actions"}
                disabled={disabled}
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
