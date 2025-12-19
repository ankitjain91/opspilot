/**
 * Format Kubernetes resource quantities into human-readable format
 */

/**
 * Parse Kubernetes CPU quantity (e.g., "100m", "2", "950517798n")
 * Returns value in millicores for display
 */
export function parseCpuQuantity(quantity: string | number | undefined): { value: number; display: string } {
    if (quantity === undefined || quantity === null) {
        return { value: 0, display: '-' };
    }

    const str = String(quantity).trim();
    if (!str) return { value: 0, display: '-' };

    let millicores: number;

    if (str.endsWith('n')) {
        // Nanocores -> millicores
        millicores = parseFloat(str.slice(0, -1)) / 1_000_000;
    } else if (str.endsWith('u')) {
        // Microcores -> millicores
        millicores = parseFloat(str.slice(0, -1)) / 1_000;
    } else if (str.endsWith('m')) {
        // Already millicores
        millicores = parseFloat(str.slice(0, -1));
    } else {
        // Cores -> millicores
        millicores = parseFloat(str) * 1000;
    }

    // Format for display
    if (millicores >= 1000) {
        const cores = millicores / 1000;
        return { value: millicores, display: `${cores.toFixed(2)} cores` };
    } else if (millicores >= 1) {
        return { value: millicores, display: `${Math.round(millicores)}m` };
    } else {
        return { value: millicores, display: `${millicores.toFixed(2)}m` };
    }
}

/**
 * Parse Kubernetes memory quantity (e.g., "128Mi", "1Gi", "17364188Ki")
 * Returns value in bytes for calculations
 */
export function parseMemoryQuantity(quantity: string | number | undefined): { bytes: number; display: string } {
    if (quantity === undefined || quantity === null) {
        return { bytes: 0, display: '-' };
    }

    const str = String(quantity).trim();
    if (!str) return { bytes: 0, display: '-' };

    const units: Record<string, number> = {
        'Ki': 1024,
        'Mi': 1024 ** 2,
        'Gi': 1024 ** 3,
        'Ti': 1024 ** 4,
        'Pi': 1024 ** 5,
        'K': 1000,
        'M': 1000 ** 2,
        'G': 1000 ** 3,
        'T': 1000 ** 4,
        'P': 1000 ** 5,
        'E': 1000 ** 6,
        'Ei': 1024 ** 6,
    };

    let bytes: number;

    // Check for units (Ki, Mi, Gi, etc.)
    const match = str.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/);
    if (match) {
        const value = parseFloat(match[1]);
        const unit = match[2] || '';
        bytes = value * (units[unit] || 1);
    } else {
        // Plain number = bytes
        bytes = parseFloat(str) || 0;
    }

    // Format for display
    return { bytes, display: formatBytes(bytes) };
}

/**
 * Format bytes to human-readable format
 */
export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';

    const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    if (i >= units.length) {
        return `${(bytes / Math.pow(k, units.length - 1)).toFixed(2)} ${units[units.length - 1]}`;
    }

    const value = bytes / Math.pow(k, i);

    // Show more precision for smaller values
    if (value < 10) {
        return `${value.toFixed(2)} ${units[i]}`;
    } else if (value < 100) {
        return `${value.toFixed(1)} ${units[i]}`;
    } else {
        return `${Math.round(value)} ${units[i]}`;
    }
}

/**
 * Format CPU usage as percentage with color hint
 */
export function formatCpuPercent(used: string | number | undefined, capacity: string | number | undefined): { percent: number; display: string; color: string } {
    const usedVal = parseCpuQuantity(used).value;
    const capVal = parseCpuQuantity(capacity).value;

    if (capVal === 0) return { percent: 0, display: '-', color: 'text-zinc-500' };

    const percent = (usedVal / capVal) * 100;
    const color = percent >= 90 ? 'text-red-400' : percent >= 70 ? 'text-amber-400' : 'text-emerald-400';

    return { percent, display: `${percent.toFixed(1)}%`, color };
}

/**
 * Format memory usage as percentage with color hint
 */
export function formatMemoryPercent(used: string | number | undefined, capacity: string | number | undefined): { percent: number; display: string; color: string } {
    const usedVal = parseMemoryQuantity(used).bytes;
    const capVal = parseMemoryQuantity(capacity).bytes;

    if (capVal === 0) return { percent: 0, display: '-', color: 'text-zinc-500' };

    const percent = (usedVal / capVal) * 100;
    const color = percent >= 90 ? 'text-red-400' : percent >= 70 ? 'text-amber-400' : 'text-emerald-400';

    return { percent, display: `${percent.toFixed(1)}%`, color };
}

/**
 * Parse Helm date format like "2024-01-15 10:30:45.123456789 +0000 UTC"
 * or standard ISO format
 */
export function parseHelmDate(dateStr: string | undefined): Date | null {
    if (!dateStr) return null;

    try {
        // First try standard ISO parse
        const isoDate = new Date(dateStr);
        if (!isNaN(isoDate.getTime())) {
            return isoDate;
        }

        // Try Helm's format: "2024-01-15 10:30:45.123456789 +0000 UTC"
        // Remove fractional seconds beyond milliseconds and UTC suffix
        const helmMatch = dateStr.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{4})?\s*(?:UTC)?$/);
        if (helmMatch) {
            const [, date, time, tz = '+0000'] = helmMatch;
            const isoStr = `${date}T${time}${tz.slice(0, 3)}:${tz.slice(3)}`;
            const parsed = new Date(isoStr);
            if (!isNaN(parsed.getTime())) {
                return parsed;
            }
        }

        // Try other common formats
        const cleaned = dateStr
            .replace(/\.\d{6,}/, '') // Remove nanoseconds
            .replace(/\s+UTC$/, '') // Remove trailing UTC
            .replace(/\s+/, 'T'); // Replace space with T for ISO

        const cleanedDate = new Date(cleaned);
        if (!isNaN(cleanedDate.getTime())) {
            return cleanedDate;
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Format time ago for Helm releases (handles Helm's special date format)
 */
export function formatHelmTimeAgo(dateStr: string | undefined): string {
    if (!dateStr) return 'Unknown';

    const date = parseHelmDate(dateStr);
    if (!date) return 'Unknown';

    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 0) return 'Just now'; // Future date edge case
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 30) return `${diffDays}d ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
    return `${Math.floor(diffDays / 365)}y ago`;
}
