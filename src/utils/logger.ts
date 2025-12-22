/**
 * OpsPilot Application Logger
 * Captures logs to an in-memory buffer that can be exported for diagnostics
 * Also intercepts all console.* calls to capture them in the buffer
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
    timestamp: string;
    level: LogLevel;
    category: string;
    message: string;
    data?: any;
}

const MAX_LOG_ENTRIES = 2000; // Keep last 2000 log entries
const logBuffer: LogEntry[] = [];

// Enable/disable verbose logging
let verboseMode = false;

// Store original console methods
const originalConsole = {
    log: console.log.bind(console),
    debug: console.debug.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
};

// Flag to prevent infinite recursion
let isIntercepting = false;

/**
 * Intercept all console.* calls and add them to the log buffer
 * This ensures ALL logs in the app are captured for diagnostics
 */
function interceptConsole() {
    const intercept = (level: LogLevel, originalFn: (...args: any[]) => void) => {
        return (...args: any[]) => {
            // Prevent recursion when our own logger calls console
            if (isIntercepting) {
                originalFn(...args);
                return;
            }

            isIntercepting = true;
            try {
                // Call original console method
                originalFn(...args);

                // Format message from args
                const message = args.map(arg => {
                    if (typeof arg === 'string') return arg;
                    try {
                        return JSON.stringify(arg);
                    } catch {
                        return String(arg);
                    }
                }).join(' ');

                // Try to extract category from [Category] prefix
                const categoryMatch = message.match(/^\[([^\]]+)\]/);
                const category = categoryMatch ? categoryMatch[1] : 'Console';
                const cleanMessage = categoryMatch ? message.slice(categoryMatch[0].length).trim() : message;

                // Add to buffer
                const entry: LogEntry = {
                    timestamp: new Date().toISOString(),
                    level,
                    category,
                    message: cleanMessage,
                    data: args.length > 1 && typeof args[args.length - 1] === 'object' ? args[args.length - 1] : undefined
                };

                logBuffer.push(entry);
                if (logBuffer.length > MAX_LOG_ENTRIES) {
                    logBuffer.shift();
                }
            } finally {
                isIntercepting = false;
            }
        };
    };

    console.log = intercept('info', originalConsole.log);
    console.debug = intercept('debug', originalConsole.debug);
    console.info = intercept('info', originalConsole.info);
    console.warn = intercept('warn', originalConsole.warn);
    console.error = intercept('error', originalConsole.error);
}

// Intercept console on module load
interceptConsole();

function formatTimestamp(): string {
    return new Date().toISOString();
}

function addToBuffer(entry: LogEntry) {
    logBuffer.push(entry);
    // Keep buffer size limited
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }
}

function formatMessage(category: string, message: string, data?: any): string {
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    return `[${category}] ${message}${dataStr}`;
}

/**
 * Create a logger for a specific category/component
 */
export function createLogger(category: string) {
    return {
        debug: (message: string, data?: any) => {
            const entry: LogEntry = {
                timestamp: formatTimestamp(),
                level: 'debug',
                category,
                message,
                data
            };
            addToBuffer(entry);
            if (verboseMode) {
                console.debug(formatMessage(category, message, data));
            }
        },
        info: (message: string, data?: any) => {
            const entry: LogEntry = {
                timestamp: formatTimestamp(),
                level: 'info',
                category,
                message,
                data
            };
            addToBuffer(entry);
            console.log(formatMessage(category, message, data));
        },
        warn: (message: string, data?: any) => {
            const entry: LogEntry = {
                timestamp: formatTimestamp(),
                level: 'warn',
                category,
                message,
                data
            };
            addToBuffer(entry);
            console.warn(formatMessage(category, message, data));
        },
        error: (message: string, data?: any) => {
            const entry: LogEntry = {
                timestamp: formatTimestamp(),
                level: 'error',
                category,
                message,
                data
            };
            addToBuffer(entry);
            console.error(formatMessage(category, message, data));
        }
    };
}

/**
 * Get all logs from buffer
 */
export function getLogs(): LogEntry[] {
    return [...logBuffer];
}

/**
 * Get logs filtered by level
 */
export function getLogsByLevel(level: LogLevel): LogEntry[] {
    return logBuffer.filter(entry => entry.level === level);
}

/**
 * Get logs filtered by category
 */
export function getLogsByCategory(category: string): LogEntry[] {
    return logBuffer.filter(entry => entry.category.toLowerCase().includes(category.toLowerCase()));
}

/**
 * Clear all logs
 */
export function clearLogs() {
    logBuffer.length = 0;
}

/**
 * Export logs as formatted text
 */
export function exportLogsAsText(): string {
    return logBuffer.map(entry => {
        const dataStr = entry.data ? ` | ${JSON.stringify(entry.data)}` : '';
        return `${entry.timestamp} [${entry.level.toUpperCase().padEnd(5)}] [${entry.category}] ${entry.message}${dataStr}`;
    }).join('\n');
}

/**
 * Export logs as JSON
 */
export function exportLogsAsJson(): string {
    return JSON.stringify(logBuffer, null, 2);
}

/**
 * Set verbose mode (logs debug messages to console)
 */
export function setVerboseMode(enabled: boolean) {
    verboseMode = enabled;
    const logger = createLogger('Logger');
    logger.info(`Verbose mode ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Get log statistics
 */
export function getLogStats() {
    const levels = { debug: 0, info: 0, warn: 0, error: 0 };
    logBuffer.forEach(entry => {
        levels[entry.level]++;
    });
    return {
        total: logBuffer.length,
        levels,
        oldestEntry: logBuffer[0]?.timestamp || null,
        newestEntry: logBuffer[logBuffer.length - 1]?.timestamp || null
    };
}

// Default app-level logger
export const appLogger = createLogger('App');
