/**
 * PlanProgressUI - Displays execution plan progress for complex K8s debugging
 *
 * Shows a live checklist of investigation steps with status indicators:
 * ⏸️ pending → ⏳ in_progress → ✅ completed / ⏭️ skipped / ❌ failed
 */

import React from 'react';

export interface PlanStep {
    step: number;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';
    result?: string | null;
    command?: string | null;
    output?: string | null;
}

interface PlanProgressUIProps {
    plan: PlanStep[];
    totalSteps: number;
    className?: string;
}

export const PlanProgressUI: React.FC<PlanProgressUIProps> = ({ plan, totalSteps, className = '' }) => {
    if (!plan || plan.length === 0) {
        return null;
    }

    const getStatusEmoji = (status: string): string => {
        switch (status) {
            case 'pending': return '⏸️';
            case 'in_progress': return '⏳';
            case 'completed': return '✅';
            case 'skipped': return '⏭️';
            case 'failed': return '❌';
            default: return '❓';
        }
    };

    const getStatusColor = (status: string): string => {
        switch (status) {
            case 'pending': return 'text-gray-400';
            case 'in_progress': return 'text-blue-500 animate-pulse';
            case 'completed': return 'text-green-500';
            case 'skipped': return 'text-yellow-500';
            case 'failed': return 'text-red-500';
            default: return 'text-gray-500';
        }
    };

    const completedCount = plan.filter(s => s.status === 'completed' || s.status === 'skipped').length;
    const progressPercent = Math.round((completedCount / totalSteps) * 100);

    return (
        <div className={`plan-progress-container bg-gray-800 rounded-lg p-4 mb-4 ${className}`}>
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-200">
                    📋 Investigation Plan
                </h3>
                <span className="text-xs text-gray-400">
                    {completedCount}/{totalSteps} steps ({progressPercent}%)
                </span>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-gray-700 rounded-full h-1.5 mb-4">
                <div
                    className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                    style={{ width: `${progressPercent}%` }}
                />
            </div>

            {/* Step Checklist */}
            <div className="space-y-2">
                {plan.map((step) => (
                    <div
                        key={step.step}
                        className={`flex items-start gap-2 text-sm ${
                            step.status === 'in_progress' ? 'bg-gray-700/50 rounded p-2' : ''
                        }`}
                    >
                        <span className={`text-lg leading-none ${getStatusColor(step.status)}`}>
                            {getStatusEmoji(step.status)}
                        </span>
                        <div className="flex-1 min-w-0">
                            <span className={`${
                                step.status === 'completed' ? 'text-gray-400 line-through' :
                                step.status === 'in_progress' ? 'text-white font-medium' :
                                'text-gray-300'
                            }`}>
                                {step.description}
                            </span>
                            {step.command && step.status === 'in_progress' && (
                                <div className="mt-1 text-xs text-blue-400 font-mono">
                                    {step.command}
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>

            {/* Completion Banner */}
            {completedCount === totalSteps && (
                <div className="mt-3 pt-3 border-t border-gray-700 text-center">
                    <span className="text-sm text-green-400">
                        🎉 Plan execution complete
                    </span>
                </div>
            )}
        </div>
    );
};
