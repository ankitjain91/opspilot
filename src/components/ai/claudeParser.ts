/**
 * Claude Code Output Parser
 * Parses Claude Code CLI output into structured blocks for rich UI rendering
 */

export type BlockType = 'tool_call' | 'tool_result' | 'thinking' | 'text' | 'diff' | 'error' | 'status' | 'trust_prompt';
export type BlockStatus = 'running' | 'success' | 'error' | 'pending';

export interface ParsedBlock {
    id: string;
    type: BlockType;
    toolName?: string;
    content: string;
    status?: BlockStatus;
    filePath?: string;
    language?: string;
    timestamp: Date;
    isStreaming?: boolean;
}

// Tool name mappings for Claude Code
const TOOL_PATTERNS: Record<string, { pattern: RegExp; icon: string }> = {
    'Read': { pattern: /(?:Read|Reading|read)\s+(?:file\s+)?([^\s]+)/i, icon: 'file' },
    'Write': { pattern: /(?:Write|Writing|write)\s+(?:to\s+)?([^\s]+)/i, icon: 'file-plus' },
    'Edit': { pattern: /(?:Edit|Editing|edit)\s+([^\s]+)/i, icon: 'edit' },
    'Bash': { pattern: /(?:Bash|bash|Running|running|Execute|execute|Shell|shell)/i, icon: 'terminal' },
    'Glob': { pattern: /(?:Glob|glob|Finding files)/i, icon: 'search' },
    'Grep': { pattern: /(?:Grep|grep|Searching|searching)/i, icon: 'search' },
    'Task': { pattern: /(?:Task|task|Agent|agent|Spawning)/i, icon: 'cpu' },
    'WebFetch': { pattern: /(?:WebFetch|Fetching|fetch)/i, icon: 'globe' },
    'WebSearch': { pattern: /(?:WebSearch|Search.*web)/i, icon: 'search' },
    'TodoWrite': { pattern: /(?:TodoWrite|Todo|task list)/i, icon: 'list-todo' },
};

// ANSI escape code stripper
export function stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str
        .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/\x1B\][^\x07]*\x07/g, '')
        .replace(/\x1B\[\?[0-9;]*[a-zA-Z]/g, '')
        .replace(/\r/g, '');
}

// Lines to filter out (terminal UI noise)
const NOISE_PATTERNS = [
    /^[\s│|]*$/,                           // Empty lines with box chars
    /Do you trust the files/i,             // Trust prompt
    /Claude Code may read/i,               // Trust warning
    /This can pose security/i,             // Security warning
    /trusted sources/i,                    // Trust message
    /Enter to confirm/i,                   // Prompt
    /Esc to exit/i,                        // Prompt
    /Try "edit/i,                          // Hint
    /\? for shortcuts/i,                   // Hint
    /In \w+\.\w+$/,                         // "In worker.py"
    /^[╭╮╯╰│─┌┐┘└├┤┬┴┼]+$/,               // Pure box drawing
    /^\s*[│|]\s*$/,                        // Vertical bars only
    /^\s*[│|]\s+[│|]\s*$/,                 // Nested vertical bars
    /^\/Users\//,                          // Raw file paths
    /^~\//,                                // Home dir paths
    /contained in this directory/i,        // Trust prompt content
];

// Check if line is terminal noise that should be filtered
export function isNoiseLine(text: string): boolean {
    const stripped = stripAnsi(text).trim();
    if (!stripped) return true;

    for (const pattern of NOISE_PATTERNS) {
        if (pattern.test(stripped)) {
            return true;
        }
    }
    return false;
}

// Detect tool from text
export function detectTool(text: string): { name: string; icon: string; filePath?: string } | null {
    const stripped = stripAnsi(text);

    for (const [name, { pattern, icon }] of Object.entries(TOOL_PATTERNS)) {
        const match = stripped.match(pattern);
        if (match) {
            return {
                name,
                icon,
                filePath: match[1] || undefined
            };
        }
    }
    return null;
}

// Detect if text contains a diff
export function isDiffContent(text: string): boolean {
    const stripped = stripAnsi(text);
    return (
        stripped.includes('@@') ||
        stripped.includes('--- a/') ||
        stripped.includes('+++ b/') ||
        (stripped.includes('- ') && stripped.includes('+ ') && stripped.split('\n').length > 3)
    );
}

// Detect language from file path
export function detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const langMap: Record<string, string> = {
        'ts': 'typescript',
        'tsx': 'typescript',
        'js': 'javascript',
        'jsx': 'javascript',
        'py': 'python',
        'rs': 'rust',
        'go': 'go',
        'rb': 'ruby',
        'java': 'java',
        'c': 'c',
        'cpp': 'cpp',
        'h': 'c',
        'hpp': 'cpp',
        'css': 'css',
        'scss': 'scss',
        'html': 'html',
        'json': 'json',
        'yaml': 'yaml',
        'yml': 'yaml',
        'md': 'markdown',
        'sh': 'bash',
        'bash': 'bash',
        'zsh': 'bash',
        'sql': 'sql',
        'toml': 'toml',
    };
    return langMap[ext || ''] || 'text';
}

/**
 * Claude Code Output Parser Class
 * Handles streaming output and converts to structured blocks
 */
export class ClaudeOutputParser {
    private buffer: string = '';
    private blocks: ParsedBlock[] = [];
    private currentBlock: Partial<ParsedBlock> | null = null;
    private blockIdCounter: number = 0;
    private inToolBlock: boolean = false;
    private inCodeBlock: boolean = false;
    private codeBlockContent: string = '';
    private codeBlockLang: string = '';

    constructor() {
        this.reset();
    }

    reset(): void {
        this.buffer = '';
        this.blocks = [];
        this.currentBlock = null;
        this.blockIdCounter = 0;
        this.inToolBlock = false;
        this.inCodeBlock = false;
        this.codeBlockContent = '';
        this.codeBlockLang = '';
    }

    private genId(): string {
        return `block-${++this.blockIdCounter}-${Date.now()}`;
    }

    /**
     * Process incoming chunk of output
     */
    processChunk(chunk: string): ParsedBlock[] {
        this.buffer += chunk;
        const newBlocks: ParsedBlock[] = [];

        // Process line by line
        const lines = this.buffer.split('\n');
        // Keep last incomplete line in buffer
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            const stripped = stripAnsi(line);

            // Detect trust prompt (ASCII box or specific text)
            if (stripped.match(/Do you trust the files/i) || stripped.match(/Enter to confirm/i) || stripped.match(/Claude Code may read/i)) {
                // If we are already in a trust block, accumulate
                if (this.currentBlock?.type === 'trust_prompt') {
                    this.currentBlock.content += '\n' + stripped;
                    continue;
                }

                // Start new trust block - finalize any existing block first
                if (this.currentBlock) {
                    newBlocks.push(this.finalizeBlock(this.currentBlock));
                }
                this.currentBlock = {
                    id: this.genId(),
                    type: 'trust_prompt' as BlockType,
                    content: stripped,
                    timestamp: new Date(),
                    isStreaming: true,
                    status: 'pending' // pending user action
                };
                continue;
            }

            // Skip noise lines (trust prompts, hints, etc.) unless in a block
            // Note: We removed the trust prompt patterns from NOISE_PATTERNS list implicitly by handling them above
            // But we should verify they don't get filtered by isNoiseLine if they fall through.
            if (!this.inToolBlock && !this.inCodeBlock && isNoiseLine(stripped)) {
                continue;
            }

            // Detect tool block start (Claude Code uses box drawing)
            if (stripped.includes('╭─') || stripped.match(/^[▶►●◆]\s/)) {
                // Start new tool block
                if (this.currentBlock && this.currentBlock.content) {
                    newBlocks.push(this.finalizeBlock(this.currentBlock));
                }

                const tool = detectTool(stripped);
                this.currentBlock = {
                    id: this.genId(),
                    type: 'tool_call',
                    toolName: tool?.name || 'Tool',
                    filePath: tool?.filePath,
                    content: stripped,
                    status: 'running',
                    timestamp: new Date(),
                    isStreaming: true
                };
                this.inToolBlock = true;
                continue;
            }

            // Detect tool block end
            if (this.inToolBlock && (stripped.includes('╰─') || stripped.includes('✓') || stripped.includes('✔'))) {
                if (this.currentBlock) {
                    this.currentBlock.content += '\n' + stripped;
                    this.currentBlock.status = 'success';
                    this.currentBlock.isStreaming = false;
                    newBlocks.push(this.finalizeBlock(this.currentBlock));
                    this.currentBlock = null;
                }
                this.inToolBlock = false;
                continue;
            }

            // Detect error in tool block
            if (this.inToolBlock && (stripped.includes('✗') || stripped.includes('✘') || stripped.toLowerCase().includes('error'))) {
                if (this.currentBlock) {
                    this.currentBlock.content += '\n' + stripped;
                    this.currentBlock.status = 'error';
                }
                continue;
            }

            // Detect code block start
            if (stripped.startsWith('```')) {
                if (!this.inCodeBlock) {
                    this.inCodeBlock = true;
                    this.codeBlockLang = stripped.slice(3).trim() || 'text';
                    this.codeBlockContent = '';
                } else {
                    // End of code block
                    this.inCodeBlock = false;
                    const isDiff = isDiffContent(this.codeBlockContent);
                    newBlocks.push({
                        id: this.genId(),
                        type: isDiff ? 'diff' : 'tool_result',
                        content: this.codeBlockContent,
                        language: this.codeBlockLang,
                        timestamp: new Date()
                    });
                    this.codeBlockContent = '';
                    this.codeBlockLang = '';
                }
                continue;
            }

            // Accumulate code block content
            if (this.inCodeBlock) {
                this.codeBlockContent += (this.codeBlockContent ? '\n' : '') + line;
                continue;
            }

            // Accumulate tool block content
            if (this.inToolBlock && this.currentBlock) {
                this.currentBlock.content += '\n' + stripped;
                continue;
            }

            // Detect thinking/reasoning (Claude often prefixes with specific patterns)
            if (stripped.match(/^(Thinking|Let me|I'll|I need to|First,|Next,)/i) && !this.currentBlock) {
                this.currentBlock = {
                    id: this.genId(),
                    type: 'thinking',
                    content: stripped,
                    timestamp: new Date(),
                    isStreaming: true
                };
                continue;
            }

            // Continue thinking block
            if (this.currentBlock?.type === 'thinking') {
                // End thinking on empty line or tool start
                if (stripped.trim() === '' || detectTool(stripped)) {
                    this.currentBlock.isStreaming = false;
                    newBlocks.push(this.finalizeBlock(this.currentBlock));
                    this.currentBlock = null;

                    if (detectTool(stripped)) {
                        // Process this line again as tool
                        const tool = detectTool(stripped);
                        this.currentBlock = {
                            id: this.genId(),
                            type: 'tool_call',
                            toolName: tool?.name || 'Tool',
                            filePath: tool?.filePath,
                            content: stripped,
                            status: 'running',
                            timestamp: new Date(),
                            isStreaming: true
                        };
                        this.inToolBlock = true;
                    }
                } else {
                    this.currentBlock.content += '\n' + stripped;
                }
                continue;
            }

            // Regular text
            if (stripped.trim()) {
                // Check if this is a status message
                if (stripped.match(/^(Done|Completed|Finished|Success)/i)) {
                    newBlocks.push({
                        id: this.genId(),
                        type: 'status',
                        content: stripped,
                        status: 'success',
                        timestamp: new Date()
                    });
                } else if (stripped.match(/^(Error|Failed|Warning)/i)) {
                    newBlocks.push({
                        id: this.genId(),
                        type: 'error',
                        content: stripped,
                        status: 'error',
                        timestamp: new Date()
                    });
                } else {
                    // Regular text content
                    newBlocks.push({
                        id: this.genId(),
                        type: 'text',
                        content: stripped,
                        timestamp: new Date()
                    });
                }
            }
        }

        // Update blocks array
        this.blocks.push(...newBlocks);
        return newBlocks;
    }

    private finalizeBlock(block: Partial<ParsedBlock>): ParsedBlock {
        return {
            id: block.id || this.genId(),
            type: block.type || 'text',
            toolName: block.toolName,
            content: (block.content || '').trim(),
            status: block.status,
            filePath: block.filePath,
            language: block.language || (block.filePath ? detectLanguage(block.filePath) : undefined),
            timestamp: block.timestamp || new Date(),
            isStreaming: block.isStreaming
        };
    }

    /**
     * Get current pending/streaming block
     */
    getCurrentBlock(): ParsedBlock | null {
        if (this.currentBlock) {
            return this.finalizeBlock(this.currentBlock);
        }
        return null;
    }

    /**
     * Get all completed blocks
     */
    getBlocks(): ParsedBlock[] {
        return [...this.blocks];
    }

    /**
     * Flush any remaining buffer content
     */
    flush(): ParsedBlock[] {
        const newBlocks: ParsedBlock[] = [];

        // Finalize current block if any
        if (this.currentBlock && this.currentBlock.content) {
            this.currentBlock.isStreaming = false;
            newBlocks.push(this.finalizeBlock(this.currentBlock));
            this.currentBlock = null;
        }

        // Process remaining buffer
        if (this.buffer.trim()) {
            newBlocks.push({
                id: this.genId(),
                type: 'text',
                content: stripAnsi(this.buffer),
                timestamp: new Date()
            });
            this.buffer = '';
        }

        // Handle unclosed code block
        if (this.inCodeBlock && this.codeBlockContent) {
            newBlocks.push({
                id: this.genId(),
                type: 'tool_result',
                content: this.codeBlockContent,
                language: this.codeBlockLang,
                timestamp: new Date()
            });
            this.inCodeBlock = false;
            this.codeBlockContent = '';
        }

        this.blocks.push(...newBlocks);
        return newBlocks;
    }
}

/**
 * Merge consecutive text blocks for cleaner display
 */
export function mergeTextBlocks(blocks: ParsedBlock[]): ParsedBlock[] {
    const merged: ParsedBlock[] = [];
    let currentText: ParsedBlock | null = null;

    for (const block of blocks) {
        if (block.type === 'text') {
            if (currentText) {
                currentText.content += '\n' + block.content;
            } else {
                currentText = { ...block };
            }
        } else {
            if (currentText) {
                merged.push(currentText);
                currentText = null;
            }
            merged.push(block);
        }
    }

    if (currentText) {
        merged.push(currentText);
    }

    return merged;
}
