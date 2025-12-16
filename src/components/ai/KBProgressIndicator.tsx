import React from 'react';
import { KBProgress } from './useSentinel';

interface KBProgressIndicatorProps {
    progress: KBProgress | null;
}

export const KBProgressIndicator: React.FC<KBProgressIndicatorProps> = ({ progress }) => {
    if (!progress) return null;

    const percentage = (progress.current / progress.total) * 100;

    return (
        <div className="fixed top-4 right-4 bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-4 min-w-[300px] z-50 animate-slide-up">
            <div className="flex items-center gap-3">
                <div className="flex-shrink-0">
                    <svg className="animate-spin h-5 w-5 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                </div>
                <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-gray-200">Loading CRDs</span>
                        <span className="text-xs text-gray-400">{progress.current}/{progress.total}</span>
                    </div>
                    <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                        <div
                            className="bg-blue-500 h-2 rounded-full transition-all duration-300 ease-out"
                            style={{ width: `${percentage}%` }}
                        ></div>
                    </div>
                    <p className="text-xs text-gray-400 mt-1 truncate">{progress.message}</p>
                </div>
            </div>
        </div>
    );
};
