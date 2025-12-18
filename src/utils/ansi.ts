
// Regex to match ANSI escape codes
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/**
 * Strips ANSI escape codes from a string to make it safe for Markdown rendering.
 */
export function stripAnsi(str: string): string {
    if (!str) return '';
    return str.replace(ANSI_REGEX, '');
}
