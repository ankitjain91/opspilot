import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    History,
    MessageSquare,
    Clock,
    FolderOpen,
    Loader2,
    RefreshCw,
    Play,
    ChevronRight
} from 'lucide-react';

interface ClaudeSession {
    id: string;
    project_path: string;
    last_modified: number;
    message_count: number;
    preview: string;
}

interface SessionBrowserProps {
    onResumeSession: (projectPath: string) => void;
    className?: string;
}

function formatRelativeTime(timestamp: number): string {
    const now = Date.now() / 1000;
    const diff = now - timestamp;

    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;

    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString();
}

export function SessionBrowser({ onResumeSession, className }: SessionBrowserProps) {
    const [sessions, setSessions] = useState<ClaudeSession[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [resumingSession, setResumingSession] = useState<string | null>(null);

    const loadSessions = async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await invoke<ClaudeSession[]>('list_claude_sessions');
            setSessions(result);
        } catch (err) {
            setError(String(err));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadSessions();
    }, []);

    const handleResume = async (session: ClaudeSession) => {
        setResumingSession(session.id);
        try {
            await invoke('resume_claude_session', { projectPath: session.project_path });
            onResumeSession(session.project_path);
        } catch (err) {
            setError(String(err));
        } finally {
            setResumingSession(null);
        }
    };

    return (
        <div className={`flex flex-col ${className || ''}`}>
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
                <div className="flex items-center gap-2">
                    <History size={14} className="text-violet-400" />
                    <span className="text-xs font-medium text-zinc-300">Previous Sessions</span>
                </div>
                <button
                    onClick={loadSessions}
                    disabled={loading}
                    className="p-1.5 rounded hover:bg-zinc-800 transition-colors disabled:opacity-50"
                    title="Refresh"
                >
                    <RefreshCw size={12} className={`text-zinc-500 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
                {loading && sessions.length === 0 && (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 size={16} className="text-violet-400 animate-spin" />
                    </div>
                )}

                {error && (
                    <div className="p-3 text-xs text-red-400">
                        {error}
                    </div>
                )}

                {!loading && sessions.length === 0 && !error && (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                        <MessageSquare size={24} className="text-zinc-600 mb-2" />
                        <p className="text-xs text-zinc-500">No previous sessions found</p>
                        <p className="text-[10px] text-zinc-600 mt-1">
                            Sessions are stored in ~/.claude/projects/
                        </p>
                    </div>
                )}

                {sessions.length > 0 && (
                    <div className="divide-y divide-zinc-800/50">
                        {sessions.map((session) => (
                            <div
                                key={`${session.project_path}-${session.id}`}
                                className="group px-3 py-2.5 hover:bg-zinc-800/30 transition-colors cursor-pointer"
                                onClick={() => handleResume(session)}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="flex-1 min-w-0">
                                        {/* Project path */}
                                        <div className="flex items-center gap-1.5 mb-1">
                                            <FolderOpen size={10} className="text-zinc-500 shrink-0" />
                                            <span className="text-[10px] text-zinc-500 truncate" title={session.project_path}>
                                                {session.project_path}
                                            </span>
                                        </div>

                                        {/* Preview */}
                                        <p className="text-xs text-zinc-300 truncate pr-2">
                                            {session.preview || 'No preview available'}
                                        </p>

                                        {/* Meta */}
                                        <div className="flex items-center gap-3 mt-1.5">
                                            <span className="flex items-center gap-1 text-[10px] text-zinc-600">
                                                <Clock size={10} />
                                                {formatRelativeTime(session.last_modified)}
                                            </span>
                                            <span className="flex items-center gap-1 text-[10px] text-zinc-600">
                                                <MessageSquare size={10} />
                                                {session.message_count} messages
                                            </span>
                                        </div>
                                    </div>

                                    {/* Resume button */}
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleResume(session);
                                        }}
                                        disabled={resumingSession === session.id}
                                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded bg-violet-500/20 hover:bg-violet-500/30 transition-all shrink-0"
                                        title="Resume session"
                                    >
                                        {resumingSession === session.id ? (
                                            <Loader2 size={12} className="text-violet-400 animate-spin" />
                                        ) : (
                                            <Play size={12} className="text-violet-400" />
                                        )}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
