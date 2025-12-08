import React from 'react';

// Refined color palette with better visual hierarchy
export const COLORS = {
    // Pod status colors
    running: '#10b981',     // Emerald - calmer green for running state
    pending: '#f59e0b',     // Amber - attention-grabbing yellow
    succeeded: '#06b6d4',   // Cyan - completed successfully
    failed: '#ef4444',      // Red - error state
    unknown: '#6b7280',     // Gray - unknown state

    // Resource utilization
    cpu: '#0ea5e9',         // Sky blue - CPU
    memory: '#a855f7',      // Purple - Memory

    // Health indicators
    healthy: '#10b981',     // Emerald
    warning: '#f59e0b',     // Amber
    critical: '#ef4444',    // Red

    // Accent colors
    info: '#3b82f6',        // Blue - informational
    accent: '#8b5cf6',      // Violet - accent/highlight
};

// Analog Speedometer Gauge - like a car speedometer
export const SpeedometerGauge = ({ value, max, label, color, unit, size = 160 }: { value: number, max: number, label: string, color: string, unit?: string, size?: number }) => {
    const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
    const startAngle = -225; // Start from bottom-left
    const endAngle = 45; // End at bottom-right
    const angleRange = endAngle - startAngle;
    const currentAngle = startAngle + (percentage / 100) * angleRange;

    const getColor = () => {
        if (percentage >= 90) return COLORS.critical;
        if (percentage >= 75) return COLORS.warning;
        return color;
    };

    // Create tick marks
    const ticks = [];
    for (let i = 0; i <= 10; i++) {
        const tickAngle = startAngle + (i / 10) * angleRange;
        const rad = (tickAngle * Math.PI) / 180;
        const outerR = size / 2 - 8;
        const innerR = i % 2 === 0 ? outerR - 12 : outerR - 6;
        const x1 = size / 2 + Math.cos(rad) * outerR;
        const y1 = size / 2 + Math.sin(rad) * outerR;
        const x2 = size / 2 + Math.cos(rad) * innerR;
        const y2 = size / 2 + Math.sin(rad) * innerR;
        ticks.push(
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={i >= 8 ? COLORS.critical : i >= 7 ? COLORS.warning : '#52525b'} strokeWidth={i % 2 === 0 ? 2 : 1} />
        );
        if (i % 2 === 0) {
            const labelR = innerR - 12;
            const lx = size / 2 + Math.cos(rad) * labelR;
            const ly = size / 2 + Math.sin(rad) * labelR;
            ticks.push(
                <text key={`label-${i}`} x={lx} y={ly} fill="#71717a" fontSize="9" textAnchor="middle" dominantBaseline="middle">
                    {i * 10}
                </text>
            );
        }
    }

    // Needle
    const needleRad = (currentAngle * Math.PI) / 180;
    const needleLength = size / 2 - 30;
    const needleX = size / 2 + Math.cos(needleRad) * needleLength;
    const needleY = size / 2 + Math.sin(needleRad) * needleLength;

    return (
        <div className="flex flex-col items-center relative">
            <svg width={size} height={size * 0.7} viewBox={`0 0 ${size} ${size * 0.85}`}>
                {/* Background arc */}
                <path
                    d={`M ${size / 2 + Math.cos((startAngle * Math.PI) / 180) * (size / 2 - 15)} ${size / 2 + Math.sin((startAngle * Math.PI) / 180) * (size / 2 - 15)}
             A ${size / 2 - 15} ${size / 2 - 15} 0 1 1 ${size / 2 + Math.cos((endAngle * Math.PI) / 180) * (size / 2 - 15)} ${size / 2 + Math.sin((endAngle * Math.PI) / 180) * (size / 2 - 15)}`}
                    fill="none"
                    stroke="#27272a"
                    strokeWidth={6}
                    strokeLinecap="round"
                />
                {/* Value arc */}
                <path
                    d={`M ${size / 2 + Math.cos((startAngle * Math.PI) / 180) * (size / 2 - 15)} ${size / 2 + Math.sin((startAngle * Math.PI) / 180) * (size / 2 - 15)}
             A ${size / 2 - 15} ${size / 2 - 15} 0 ${(percentage / 100) * angleRange > 180 ? 1 : 0} 1 ${size / 2 + Math.cos((currentAngle * Math.PI) / 180) * (size / 2 - 15)} ${size / 2 + Math.sin((currentAngle * Math.PI) / 180) * (size / 2 - 15)}`}
                    fill="none"
                    stroke={getColor()}
                    strokeWidth={6}
                    strokeLinecap="round"
                    className="transition-all duration-500"
                    style={{ filter: `drop-shadow(0 0 6px ${getColor()})` }}
                />
                {/* Tick marks */}
                {ticks}
                {/* Needle */}
                <line
                    x1={size / 2}
                    y1={size / 2}
                    x2={needleX}
                    y2={needleY}
                    stroke={getColor()}
                    strokeWidth={3}
                    strokeLinecap="round"
                    className="transition-all duration-500"
                    style={{ filter: `drop-shadow(0 0 4px ${getColor()})` }}
                />
                {/* Center dot */}
                <circle cx={size / 2} cy={size / 2} r={6} fill={getColor()} />
                <circle cx={size / 2} cy={size / 2} r={3} fill="#18181b" />
            </svg>
            <div className="text-center -mt-2">
                <div className="text-xl font-bold text-white">{percentage.toFixed(0)}%</div>
                <div className="text-[10px] text-zinc-400 uppercase tracking-wider">{label}</div>
                {unit && <div className="text-xs text-zinc-300 font-mono">{unit}</div>}
            </div>
        </div>
    );
};

// Vertical Bar Meter - like an audio VU meter
// inverseColors: when true, 0% is green (healthy), higher is worse
// positiveMetric: when true, higher is good (e.g., healthy nodes) so thresholds are not treated as warnings
export const VerticalMeter = ({ value, max, label, color, icon: Icon, inverseColors = false, positiveMetric = false }: { value: number, max: number, label: string, color: string, icon?: React.ComponentType<{ size?: number, className?: string }>, inverseColors?: boolean, positiveMetric?: boolean }) => {
    const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
    const getColor = () => {
        if (positiveMetric) {
            return color;
        }
        if (inverseColors) {
            // For "bad" metrics like unhealthy nodes: 0% is green, higher is red
            if (percentage === 0) return COLORS.healthy;
            if (percentage <= 10) return COLORS.warning;
            return COLORS.critical;
        }
        // Normal: higher percentage = worse
        if (percentage >= 90) return COLORS.critical;
        if (percentage >= 75) return COLORS.warning;
        return color;
    };

    return (
        <div className="flex flex-col items-center gap-2">
            <div className="relative w-8 h-32 bg-zinc-900 rounded-full border border-zinc-800 overflow-hidden">
                {/* Scale markers */}
                {[0, 25, 50, 75, 100].map(mark => (
                    <div key={mark} className="absolute left-0 right-0 h-px bg-zinc-700" style={{ bottom: `${mark}%` }} />
                ))}
                {/* Fill */}
                <div
                    className="absolute bottom-0 left-0 right-0 transition-all duration-500 rounded-b-full"
                    style={{
                        height: `${percentage}%`,
                        background: `linear-gradient(to top, ${getColor()}, ${getColor()}88)`,
                        boxShadow: `0 0 20px ${getColor()}66`
                    }}
                />
                {/* Glow effect at top */}
                <div
                    className="absolute left-1 right-1 h-2 rounded-full transition-all duration-500"
                    style={{
                        bottom: `calc(${percentage}% - 4px)`,
                        background: getColor(),
                        boxShadow: `0 0 8px ${getColor()}`
                    }}
                />
            </div>
            <div className="text-center">
                {Icon && <span style={{ color: getColor() }}><Icon size={16} className="mx-auto mb-1" /></span>}
                <div className="text-sm font-bold text-white">{percentage.toFixed(0)}%</div>
                <div className="text-[10px] text-zinc-400 font-medium">{label}</div>
            </div>
        </div>
    );
};

// Horizontal Progress with gradient
export const GradientProgress = ({ value, max, label, sublabel }: { value: number, max: number, label: string, sublabel?: string }) => {
    const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
    const getGradient = () => {
        if (percentage >= 90) return 'from-red-600 to-red-400';
        if (percentage >= 75) return 'from-yellow-600 to-yellow-400';
        return 'from-cyan-600 to-cyan-400';
    };

    return (
        <div className="w-full">
            <div className="flex justify-between items-center mb-1">
                <span className="text-xs text-zinc-400">{label}</span>
                <span className="text-xs font-mono text-zinc-300">{percentage.toFixed(1)}%</span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                    className={`h-full bg-gradient-to-r ${getGradient()} rounded-full transition-all duration-500`}
                    style={{ width: `${percentage}%` }}
                />
            </div>
            {sublabel && <div className="text-[10px] text-zinc-400 mt-0.5">{sublabel}</div>}
        </div>
    );
};

// Simple ring gauge for compact display
export const Gauge = ({ value, max, label, color, size = 120, isHealthMetric = true }: { value: number, max: number, label: string, color: string, size?: number, isHealthMetric?: boolean }) => {
    const percentage = max > 0 ? Math.min((value / max) * 100, 100) : 0;
    const strokeWidth = 8;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (percentage / 100) * circumference;

    const getColor = () => {
        if (isHealthMetric) {
            // For health metrics: higher is better (green), lower is worse (red)
            if (percentage >= 90) return COLORS.healthy;
            if (percentage >= 70) return COLORS.warning;
            return COLORS.critical;
        } else {
            // For utilization metrics: higher is worse (red), lower is better (green)
            if (percentage >= 90) return COLORS.critical;
            if (percentage >= 75) return COLORS.warning;
            return color;
        }
    };

    return (
        <div className="flex flex-col items-center">
            <svg width={size} height={size} className="transform -rotate-90">
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke="#27272a"
                    strokeWidth={strokeWidth}
                />
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke={getColor()}
                    strokeWidth={strokeWidth}
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={strokeDashoffset}
                    className="transition-all duration-500"
                    style={{ filter: `drop-shadow(0 0 4px ${getColor()})` }}
                />
            </svg>
            <div className="absolute flex flex-col items-center justify-center" style={{ width: size, height: size }}>
                <span className="text-2xl font-bold text-white">{percentage.toFixed(0)}%</span>
                <span className="text-xs text-zinc-300 font-medium">{label}</span>
            </div>
        </div>
    );
};

// Status indicator
export const StatusIndicator = ({ status, count, label }: { status: 'healthy' | 'warning' | 'critical', count: number, label: string }) => (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${status === 'critical' ? 'bg-red-500/10 border-red-500/30' :
        status === 'warning' ? 'bg-yellow-500/10 border-yellow-500/30' :
            'bg-green-500/10 border-green-500/30'
        }`}>
        <div className={`w-2 h-2 rounded-full ${status === 'critical' ? 'bg-red-500 animate-pulse' :
            status === 'warning' ? 'bg-yellow-500' :
                'bg-green-500'
            }`} />
        <span className={`text-sm font-medium ${status === 'critical' ? 'text-red-400' :
            status === 'warning' ? 'text-yellow-400' :
                'text-green-400'
            }`}>{count}</span>
        <span className="text-xs text-zinc-500">{label}</span>
    </div>
);
