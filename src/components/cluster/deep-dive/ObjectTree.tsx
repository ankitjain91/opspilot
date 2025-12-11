import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ChevronRight, ChevronDown, Copy, Check, Edit2 } from 'lucide-react';

interface ObjectTreeProps {
    data: any;
    name?: string;
    searchTerm?: string;
    level?: number;
    defaultOpen?: boolean;
    path?: string[];
    onEdit?: (path: string[], value: any) => void;
    matchPaths?: Set<string>;
    activePath?: string | null;
    expandAll?: boolean;
}

// Highlight helper component
const Highlight = ({ text, term, isActive }: { text: string, term?: string, isActive?: boolean }) => {
    if (!term || !text.toLowerCase().includes(term.toLowerCase())) {
        return <span>{text}</span>;
    }

    const parts = text.split(new RegExp(`(${term})`, 'gi'));
    return (
        <span>
            {parts.map((part, i) =>
                part.toLowerCase() === term.toLowerCase() ? (
                    <span key={i} className={`${isActive ? 'bg-yellow-500 text-black' : 'bg-yellow-500/30 text-yellow-200'} rounded-[1px] px-0.5`}>{part}</span>
                ) : (
                    <span key={i}>{part}</span>
                )
            )}
        </span>
    );
};

// Helper component for inline editing
const EditableValue = ({ value, path, onEdit, searchTerm, isActive }: { value: any, path: string[], onEdit?: (p: string[], v: any) => void, searchTerm?: string, isActive?: boolean }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [tempValue, setTempValue] = useState(String(value));
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
        }
    }, [isEditing]);

    if (!onEdit) {
        if (typeof value === 'boolean') {
            return <span className={`font-mono ${value ? 'text-emerald-400' : 'text-rose-400'}`}>{String(value)}</span>;
        }
        if (typeof value === 'number') {
            return <span className="font-mono text-orange-400">{String(value)}</span>;
        }
        if (typeof value === 'string') {
            // Check if looks like ISO Date
            if (value.match(/^\d{4}-\d{2}-\d{2}T/)) {
                return <span className="font-mono text-purple-400">"{value}"</span>;
            }
            const display = value.length > 200 ? value.substring(0, 200) + '...' : value;
            return (
                <span className="font-mono text-sky-300 whitespace-pre-wrap break-all">
                    "<Highlight text={display} term={searchTerm} isActive={isActive} />"
                </span>
            );
        }
        return <span className="text-zinc-300"><Highlight text={String(value)} term={searchTerm} isActive={isActive} /></span>;
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleCommit();
        } else if (e.key === 'Escape') {
            setIsEditing(false);
            setTempValue(String(value));
        }
    };

    const handleCommit = () => {
        setIsEditing(false);
        if (tempValue === String(value)) return;

        let finalValue: any = tempValue;
        // Basic type inference
        if (typeof value === 'number') {
            finalValue = Number(tempValue);
            if (isNaN(finalValue)) finalValue = tempValue; // Fallback
        } else if (typeof value === 'boolean') {
            finalValue = tempValue === 'true';
        }

        onEdit(path, finalValue);
    };

    if (isEditing) {
        return (
            <input
                ref={inputRef}
                value={tempValue}
                onChange={e => setTempValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleCommit}
                className="bg-black/40 border border-cyan-500/50 rounded px-1.5 py-0.5 text-white min-w-[50px] outline-none font-mono text-sm"
            />
        );
    }

    return (
        <span
            className="group/val relative cursor-text hover:bg-white/5 rounded px-1 -ml-1 transition-colors"
            onClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
        >
            {typeof value === 'boolean' && <span className={`font-mono ${value ? 'text-emerald-400' : 'text-rose-400'}`}>{String(value)}</span>}
            {typeof value === 'number' && <span className="font-mono text-orange-400">{value}</span>}
            {typeof value === 'string' && (function () {
                if (value.match(/^\d{4}-\d{2}-\d{2}T/)) {
                    return <span className="font-mono text-purple-400">"{value}"</span>;
                }
                const display = value.length > 200 ? value.substring(0, 200) + '...' : value;
                return (
                    <span className="font-mono text-sky-300 whitespace-pre-wrap break-all">
                        "<Highlight text={display} term={searchTerm} isActive={isActive} />"
                    </span>
                );
            })()}
            {value instanceof Date && <span className="font-mono text-purple-400">"{value.toISOString()}"</span>}

            <Edit2 size={10} className="absolute -right-4 top-1 text-zinc-500 opacity-0 group-hover/val:opacity-100" />
        </span>
    );
};

export function ObjectTree({
    data,
    name,
    searchTerm = '',
    level = 0,
    defaultOpen = true,
    path = [],
    onEdit,
    matchPaths,
    activePath,
    expandAll
}: ObjectTreeProps) {
    const [isOpen, setIsOpen] = useState(level < 2 && defaultOpen);
    const [copied, setCopied] = useState(false);
    const nodeRef = useRef<HTMLDivElement>(null);

    const currentPath = name ? [...path, name] : path;
    const pathString = currentPath.join('.');

    // Check if this node is the active search match
    const isActiveMatch = activePath === pathString;

    // Check if any children match search (to auto-expand)
    const hasChildMatch = useMemo(() => {
        if (!matchPaths) return false;
        // Check if any matching path starts with this path (is a descendant)
        // Optimization: checking exact string prefix might be risky with similar keys, 
        // but pathString is joined by '.' so it's reasonably distinct.
        // A robust check iterates matches.
        for (const match of matchPaths) {
            if (match.startsWith(pathString + '.')) return true;
        }
        return false;
    }, [matchPaths, pathString]);

    // Effect to expand if children match or expandAll is set
    useEffect(() => {
        if (expandAll !== undefined) {
            setIsOpen(expandAll);
        } else if (hasChildMatch && searchTerm) {
            setIsOpen(true);
        }
    }, [expandAll, hasChildMatch, searchTerm]);

    // Scroll into view if active
    useEffect(() => {
        if (isActiveMatch && nodeRef.current) {
            nodeRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, [isActiveMatch]);

    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(JSON.stringify(data, null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const isRoot = level === 0 && !name; // Root call often has no name

    const label = name ? (
        <span className={`font-mono mr-2 ${isActiveMatch ? 'text-yellow-400 font-bold' : 'text-zinc-400 font-medium'}`}>
            <Highlight text={name} term={searchTerm} isActive={isActiveMatch} />:
        </span>
    ) : null;

    // Primitives
    const isPrimitive = data === null || data === undefined || typeof data !== 'object' || data instanceof Date;

    if (isPrimitive) {
        if (data === null) return <div ref={nodeRef} className={`py-0.5 ${isActiveMatch ? 'bg-yellow-500/10 -mx-1 px-1 rounded' : ''}`}>{label}<span className="text-zinc-500 italic">null</span></div>;
        if (data === undefined) return <div ref={nodeRef} className={`py-0.5 ${isActiveMatch ? 'bg-yellow-500/10 -mx-1 px-1 rounded' : ''}`}>{label}<span className="text-zinc-600 italic">undefined</span></div>;
        if (data instanceof Date) return <div ref={nodeRef} className={`py-0.5 ${isActiveMatch ? 'bg-yellow-500/10 -mx-1 px-1 rounded' : ''}`}>{label}<span className="font-mono text-purple-400">"{data.toISOString()}"</span></div>;

        return (
            <div ref={nodeRef} className={`flex items-start py-0.5 ${isActiveMatch ? 'bg-yellow-500/10 -mx-1 px-1 rounded' : ''}`}>
                {label}
                <EditableValue value={data} path={currentPath} onEdit={onEdit} searchTerm={searchTerm} isActive={isActiveMatch} />
            </div>
        );
    }

    // Objects/Arrays
    const isArray = Array.isArray(data);
    const keys = Object.keys(data);
    const isEmpty = keys.length === 0;

    if (isEmpty) {
        return (
            <div ref={nodeRef} className={`flex items-center text-sm pl-1 py-1 ${isActiveMatch ? 'bg-yellow-500/10 -mx-1 px-1 rounded' : ''}`}>
                {label}
                <span className="text-zinc-500">{isArray ? '[]' : '{}'}</span>
            </div>
        );
    }

    return (
        <div className="text-sm">
            <div
                ref={nodeRef}
                className={`flex items-center py-1 hover:bg-white/5 rounded cursor-pointer group select-none ${isActiveMatch ? 'bg-yellow-500/10' : ''}`}
                onClick={() => setIsOpen(!isOpen)}
            >
                <div className="w-5 h-5 flex items-center justify-center mr-1 text-zinc-500 transition-transform duration-200">
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>

                {label}

                <span className="text-zinc-600 text-xs ml-2 font-mono">
                    {isArray ? `[${keys.length}]` : `{${keys.length}}`}
                </span>

                <button onClick={handleCopy} className="ml-auto mr-2 opacity-0 group-hover:opacity-100 transition-opacity p-1.5 hover:bg-white/10 rounded">
                    {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} className="text-zinc-500" />}
                </button>
            </div>

            {isOpen && (
                <div className="pl-3 border-l-2 border-white/5 ml-2.5">
                    {keys.map(key => (
                        <div key={key} className="pl-2">
                            <ObjectTree
                                data={data[key]}
                                name={key}
                                searchTerm={searchTerm}
                                level={level + 1}
                                defaultOpen={defaultOpen}
                                path={currentPath}
                                onEdit={onEdit}
                                matchPaths={matchPaths}
                                activePath={activePath}
                                expandAll={expandAll}
                            />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
