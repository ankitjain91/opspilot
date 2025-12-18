import React from 'react';
import { Terminal, Play, CheckCircle2, Copy } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface PythonCodeBlockProps {
    code: string;
    output?: string;
    isExecuting?: boolean;
}

export const PythonCodeBlock: React.FC<PythonCodeBlockProps> = ({ code, output, isExecuting }) => {
    const [copied, setCopied] = React.useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="rounded-md overflow-hidden bg-[#1e1e1e] border border-[#333] my-2 font-mono text-sm shadow-md">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-1.5 bg-[#252526] border-b border-[#333]">
                <div className="flex items-center gap-2 text-xs text-blue-400">
                    <Terminal size={14} />
                    <span className="font-semibold">Python 3.11</span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleCopy}
                        className="p-1 hover:bg-[#333] rounded text-zinc-400 hover:text-white transition-colors"
                        title="Copy Code"
                    >
                        {copied ? <CheckCircle2 size={13} className="text-green-500" /> : <Copy size={13} />}
                    </button>
                </div>
            </div>

            {/* Code Area */}
            <div className="relative">
                <SyntaxHighlighter
                    language="python"
                    style={vscDarkPlus}
                    customStyle={{ margin: 0, padding: '12px', fontSize: '13px', backgroundColor: '#1e1e1e' }}
                    showLineNumbers={true}
                    wrapLines={true}
                >
                    {code}
                </SyntaxHighlighter>
            </div>

            {/* Output Area (Terminal Style) */}
            {(output || isExecuting) && (
                <div className="border-t border-[#333] bg-black/50">
                    <div className="px-3 py-1 text-[10px] uppercase font-bold text-zinc-500 tracking-wider">
                        Output
                    </div>
                    <div className="px-3 pb-3 pt-1 text-xs font-mono text-zinc-300 whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
                        {isExecuting && !output && (
                            <div className="flex items-center gap-2 text-yellow-500 animate-pulse">
                                <Play size={12} />
                                <span>Executing script...</span>
                            </div>
                        )}
                        {output}
                    </div>
                </div>
            )}
        </div>
    );
};
