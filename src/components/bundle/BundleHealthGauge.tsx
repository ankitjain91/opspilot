import React from 'react';

interface BundleHealthGaugeProps {
    score: number;
}

export function BundleHealthGauge({ score }: BundleHealthGaugeProps) {
    // Determine color based on score
    const color = score >= 80 ? 'emerald' : score >= 60 ? 'amber' : 'red';

    // SVG parameters
    const size = 160;
    const strokeWidth = 12;
    const center = size / 2;
    const radius = center - strokeWidth;
    const circumference = 2 * Math.PI * radius;
    // 75% circle (open at bottom)
    const dashArray = circumference * 0.75;
    const dashOffset = dashArray - (score / 100) * dashArray;

    // Rotate to position the opening at the bottom
    // We want the gap to be 25%, so we rotate 135deg (90 + 45) to center the 270deg arc

    return (
        <div className="relative flex flex-col items-center justify-center p-4">
            <div className="relative" style={{ width: size, height: size }}>
                {/* Background Track */}
                <svg className="w-full h-full transform rotate-[135deg]">
                    <circle
                        cx={center}
                        cy={center}
                        r={radius}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={strokeWidth}
                        className="text-zinc-800/50"
                        strokeLinecap="round"
                        strokeDasharray={dashArray}
                        strokeDashoffset={0}
                        style={{ strokeDasharray: `${dashArray} ${circumference}` }}
                    />
                </svg>

                {/* Value Arc */}
                <svg className="absolute top-0 left-0 w-full h-full transform rotate-[135deg]">
                    <circle
                        cx={center}
                        cy={center}
                        r={radius}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={strokeWidth}
                        className={`text-${color}-500 transition-all duration-1000 ease-out`}
                        strokeLinecap="round"
                        style={{
                            strokeDasharray: `${dashArray} ${circumference}`,
                            strokeDashoffset: dashOffset
                        }}
                    />
                </svg>

                {/* Score Text (Absolute centered) */}
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none mt-4">
                    <span className={`text-4xl font-bold text-white`}>
                        {score}
                    </span>
                    <span className={`text-xs font-medium uppercase tracking-wider text-${color}-400 mt-1`}>
                        Health Score
                    </span>
                </div>
            </div>

            {/* Status Label */}
            <div className={`mt-[-1rem] px-3 py-1 rounded-full bg-${color}-500/10 border border-${color}-500/20`}>
                <span className={`text-sm font-medium text-${color}-400`}>
                    {score >= 80 ? 'Healthy' : score >= 60 ? 'Degraded' : 'Critical'}
                </span>
            </div>
        </div>
    );
}
