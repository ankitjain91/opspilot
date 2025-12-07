import React from 'react';
import { Loader2 } from 'lucide-react';

export function LoadingScreen({ message }: { message: string }) {
    return (
        <div className="h-screen bg-[#0f0f12] text-white flex flex-col items-center justify-center relative overflow-hidden">
            <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] bg-blue-600/10 rounded-full blur-[120px] pointer-events-none" />
            <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-purple-600/10 rounded-full blur-[120px] pointer-events-none" />

            <div className="z-10 flex flex-col items-center">
                <div className="relative mb-8">
                    <div className="absolute inset-0 bg-blue-500/20 blur-xl rounded-full animate-pulse" />
                    <Loader2 className="animate-spin text-blue-500 relative z-10" size={48} />
                </div>
                <div className="flex items-center gap-3 mb-2">
                    <img src="/icon.png" alt="OpsPilot" className="w-8 h-8" />
                    <h2 className="text-2xl font-bold tracking-tight">OpsPilot</h2>
                </div>
                <p className="text-gray-400 animate-pulse font-medium">{message}</p>
            </div>
        </div>
    );
}
