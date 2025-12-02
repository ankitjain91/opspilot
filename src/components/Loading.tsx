import { Loader2 } from 'lucide-react';
import React from 'react';

type LoadingProps = {
  size?: number;
  label?: string;
  fullScreen?: boolean;
  className?: string;
};

export default function Loading({ size = 24, label = 'Loading', fullScreen = false, className = '' }: LoadingProps) {
  const containerCls = fullScreen
    ? 'flex items-center justify-center h-full'
    : 'inline-flex items-center gap-2';
  return (
    <div className={`${containerCls} ${className}`}>
      <Loader2 className="animate-spin text-cyan-400" size={size} />
      {label && <span className="text-xs text-cyan-400">{label}</span>}
    </div>
  );
}
