import React, { useState } from 'react';
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';

interface CopyableCodeBlockProps {
    children: React.ReactNode;
    className?: string;
    language?: string;
}

export const CopyableCodeBlock: React.FC<CopyableCodeBlockProps> = ({ children, className, language }) => {
    const [copied, setCopied] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);

    // Extract text content from children
    const getTextContent = (node: React.ReactNode): string => {
        if (typeof node === 'string') return node;
        if (typeof node === 'number') return String(node);
        if (Array.isArray(node)) return node.map(getTextContent).join('');
        if (React.isValidElement(node) && node.props.children) {
            return getTextContent(node.props.children);
        }
        return '';
    };

    const codeText = getTextContent(children);
    const lines = codeText.split('\n');
    const isLongOutput = lines.length > 12;
    const shouldTruncate = isLongOutput && !isExpanded;

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(codeText);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    // Detect language from className (e.g., "language-yaml")
    const detectedLang = className?.match(/language-(\w+)/)?.[1] || language || 'code';

    return (
        <div className="relative group/code my-4">
            {/* Header with language badge and copy button */}
            <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/80 border border-white/10 border-b-0 rounded-t-lg">
                <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                    {detectedLang}
                </span>
                <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium text-zinc-400 hover:text-white bg-white/5 hover:bg-white/10 rounded transition-all"
                    title="Copy to clipboard"
                >
                    {copied ? (
                        <>
                            <Check size={12} className="text-emerald-400" />
                            <span className="text-emerald-400">Copied!</span>
                        </>
                    ) : (
                        <>
                            <Copy size={12} />
                            <span>Copy</span>
                        </>
                    )}
                </button>
            </div>

            {/* Code content */}
            <pre className={`text-[12px] bg-black/60 p-4 rounded-b-lg overflow-x-auto border border-white/10 border-t-0 font-mono leading-relaxed ${shouldTruncate ? 'max-h-[300px] overflow-hidden' : ''}`}>
                <code className="text-zinc-300">{children}</code>
            </pre>

            {/* Expand/Collapse for long outputs */}
            {isLongOutput && (
                <button
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-2 py-2 bg-gradient-to-t from-black/90 to-transparent text-zinc-400 hover:text-white text-[11px] font-medium transition-all rounded-b-lg"
                >
                    {isExpanded ? (
                        <>
                            <ChevronUp size={14} />
                            Show less
                        </>
                    ) : (
                        <>
                            <ChevronDown size={14} />
                            Show {lines.length - 12} more lines
                        </>
                    )}
                </button>
            )}
        </div>
    );
};

// Inline code with copy on click
export const CopyableInlineCode: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        const text = typeof children === 'string' ? children : String(children);
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    return (
        <code
            onClick={handleCopy}
            className={`text-[12px] bg-white/5 border border-white/10 px-1.5 py-0.5 rounded font-mono cursor-pointer transition-all hover:bg-white/10 break-all ${
                copied ? 'text-emerald-400 border-emerald-500/30' : 'text-emerald-400'
            }`}
            title={copied ? 'Copied!' : 'Click to copy'}
        >
            {children}
            {copied && <Check size={10} className="inline ml-1" />}
        </code>
    );
};
