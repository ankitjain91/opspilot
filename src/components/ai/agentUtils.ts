/**
 * Utility functions for the AI agent
 * Extracted for testability
 */

export interface ExtractedCommand {
  tool: string;
  args: string;
}

/**
 * Extract commands from LLM response
 * Supports multiple formats:
 * - TOOL: RUN_KUBECTL get pods -A
 * - $ kubectl get pods -A
 * - `kubectl get pods -A`
 * - kubectl get pods -A (at line start)
 */
export function extractCommandsFromResponse(response: string): ExtractedCommand[] {
  // Match TOOL: format with robustness for:
  // 1. Case insensitivity (TOOL, Tool, tool)
  // 2. Markdown formatting (**TOOL**, - TOOL)
  // 3. Optional colons
  // 4. "Thought:" pollution
  const toolMatches = [...response.matchAll(/(?:^|\n|[\s*>|\-]*)(?:[*_]*)(?:TOOL|Tool)(?:[*_]*)\s*:?\s*(\w+)(?:\s+(.+?))?(?=\n|(?:\s*Thought:)|$)/gi)];

  // More lenient shell command matching:
  // - Matches "$ kubectl ..." or "$kubectl ..." at line start
  // - Matches "`kubectl ...`" inline
  // - Matches "kubectl ..." at line start (without $)
  const shellPatterns = [
    /^\$\s*(kubectl\s+[^\n`]+)/gm,           // $ kubectl ... (at line start)
    /`(kubectl\s+[^`]+)`/g,                   // `kubectl ...` (inline code)
    /^(kubectl\s+(?:get|describe|logs|top|events|config|api-resources)[^\n]*)/gm  // bare kubectl at line start
  ];

  const commands: ExtractedCommand[] = [];
  const seenCommands = new Set<string>();

  for (const match of toolMatches) {
    let rawArgs = match[2]?.trim() || '';

    // Clean "Thought:" pollution
    rawArgs = rawArgs.split(/Thought:/i)[0].trim();

    // Clean trailing markdown
    rawArgs = rawArgs.replace(/[*_]+$/, '').trim();

    // Strip comments in parens e.g. "deployment (to check volume)"
    const args = rawArgs.split('(')[0].trim();
    const key = `${match[1].toUpperCase()}:${args}`;
    if (!seenCommands.has(key)) {
      seenCommands.add(key);
      commands.push({ tool: match[1].toUpperCase(), args });
    }
  }

  for (const pattern of shellPatterns) {
    const matches = [...response.matchAll(pattern)];
    for (const match of matches) {
      if (!match || !match[1]) continue;
      const kubectlCmd = match[1].replace(/^kubectl\s+/, '').trim();
      const key = `RUN_KUBECTL:${kubectlCmd}`;
      if (kubectlCmd && !seenCommands.has(key)) {
        seenCommands.add(key);
        commands.push({ tool: 'RUN_KUBECTL', args: kubectlCmd });
      }
    }
  }

  return commands;
}

/**
 * Check confidence level from LLM response
 */
export function checkConfidence(response: string): 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN' {
  const confidenceMatch = response.match(/\*\*Confidence\*\*:\s*(HIGH|MEDIUM|LOW)/i);
  if (confidenceMatch) {
    return confidenceMatch[1].toUpperCase() as 'HIGH' | 'MEDIUM' | 'LOW';
  }
  // Check for implicit high confidence signals
  if (response.includes('HIGH') && (response.includes('confidence') || response.includes('Confidence'))) {
    return 'HIGH';
  }
  return 'UNKNOWN';
}

/**
 * Classify the type of user request
 */
export type RequestType = 'action' | 'query' | 'casual' | 'knowledge' | 'troubleshooting' | 'unknown';

export function classifyRequest(message: string): RequestType {
  const lowerMsg = message.toLowerCase().trim();

  // Casual greetings
  const casualPatterns = [
    /^(hi|hey|hello|thanks|thank you|ok|okay|cool|great|awesome|got it|sure)[\s!.,]*$/i,
    /^(good morning|good evening|good afternoon)[\s!.,]*$/i,
  ];
  for (const pattern of casualPatterns) {
    if (pattern.test(lowerMsg)) return 'casual';
  }

  // Action requests - verbs that demand immediate execution
  const actionPatterns = [
    /^(get|show|fetch|check|list|display|find|search|describe|view)\s+/i,
    /logs?\s+(for|of|from)/i,
    /^what\s+(are|is)\s+the\s+(logs?|events?|status)/i,
  ];
  for (const pattern of actionPatterns) {
    if (pattern.test(lowerMsg)) return 'action';
  }

  // Troubleshooting requests
  const troubleshootPatterns = [
    /why\s+(is|are|does|do)\s+/i,
    /what('s| is)\s+wrong/i,
    /(failing|crashed|crashing|not working|broken|error|issue|problem)/i,
    /troubleshoot/i,
    /debug/i,
  ];
  for (const pattern of troubleshootPatterns) {
    if (pattern.test(lowerMsg)) return 'troubleshooting';
  }

  // Knowledge questions
  const knowledgePatterns = [
    /^what\s+is\s+(a|an|the)\s+/i,
    /^how\s+does\s+/i,
    /^explain\s+/i,
    /^describe\s+what\s+/i,
    /^what\s+does\s+.+\s+mean/i,
  ];
  for (const pattern of knowledgePatterns) {
    if (pattern.test(lowerMsg)) return 'knowledge';
  }

  // Simple queries
  const queryPatterns = [
    /^how\s+many\s+/i,
    /^is\s+there\s+/i,
    /^are\s+there\s+/i,
    /^do\s+we\s+have\s+/i,
    /^does\s+this\s+/i,
  ];
  for (const pattern of queryPatterns) {
    if (pattern.test(lowerMsg)) return 'query';
  }

  return 'unknown';
}

// Learning types for investigation recording
interface ToolRecord {
  tool: string;
  args: string | null;
  status: string;
  useful: boolean;
  duration_ms: number;
}

// Helper to record investigation outcome for learning
import { ToolOutcome } from './types';

export async function recordInvestigationForLearning(
  question: string,
  toolHistory: ToolOutcome[],
  confidence: { level: string; score: number },
  hypotheses: Array<{ id: string; description: string; status: string }>,
  rootCause: string | null,
  durationMs: number,
  k8sContext: string
) {
  // In a real implementation with a backend database, this would save the
  // successful investigation path to train/finetune the model or add to RAG.
  // For now, we'll log a structured object that could be scraped/stored.

  const learningRecord = {
    timestamp: new Date().toISOString(),
    context: k8sContext,
    trigger: question,
    outcome: {
      success: confidence.score > 0.7,
      root_cause_identified: !!rootCause,
      confidence_score: confidence.score,
      duration_ms: durationMs
    },
    path: {
      steps_count: toolHistory.length,
      tools_used: toolHistory.map(t => ({
        tool: t.tool,
        args: t.args || null,
        status: t.result.startsWith('Error') ? 'failed' : 'success',
        useful: !t.result.includes('No resources found'), // Simple heuristic
        duration_ms: 0 // We don't track per-tool duration yet
      } as ToolRecord))
    },
    insight: {
      root_cause: rootCause,
      proven_hypotheses: hypotheses.filter(h => h.status === 'confirmed').map(h => h.description)
    }
  };

  // Low-key logging (debug level) so we can see it in console but not clutter
  console.debug('[Agent Learning] Recording successful investigation path:', learningRecord);

  // TODO: Send to backend
  // await invoke('record_agent_learning', { record: learningRecord });
}

/**
 * Extract suggestions from LLM response
 */
export function extractSuggestions(response: string): { cleanedResponse: string; suggestions: string[] } {
  if (!response) return { cleanedResponse: '', suggestions: [] };
  const suggestionsMatch = response.match(/<suggestions>\s*(\[[\s\S]*?\])\s*<\/suggestions>/);
  let suggestions: string[] = [];
  let cleanedResponse = response;

  if (suggestionsMatch) {
    try {
      suggestions = JSON.parse(suggestionsMatch[1]);
      cleanedResponse = response.replace(/<suggestions>[\s\S]*?<\/suggestions>/, '').trim();
    } catch {
      // Ignore parse errors
    }
  }

  return { cleanedResponse, suggestions };
}

/**
 * Detects if the response contains patterns that would benefit from code search.
 * Returns a suggestion object if code search is recommended.
 */
export interface CodeSearchSuggestion {
  shouldSuggest: boolean;
  reason: string;
  searchQuery: string;
  patterns: string[];
}

export function detectCodeSearchOpportunity(
  userQuery: string,
  assistantResponse: string,
  commandOutputs: string[] = []
): CodeSearchSuggestion {
  const patterns: string[] = [];
  const allContent = `${userQuery}\n${assistantResponse}\n${commandOutputs.join('\n')}`;

  // 1. Stack trace patterns (Java, Python, Node.js, Go, etc.)
  const stackTracePatterns = [
    /at\s+[\w.$]+\.(java|kt|scala):\d+/gi,  // Java/Kotlin/Scala
    /File\s+"[^"]+\.py",\s+line\s+\d+/gi,    // Python
    /at\s+[\w./<>]+\s+\([^)]+:\d+:\d+\)/gi,  // Node.js/JavaScript
    /\s+at\s+[\w.]+\s+\(.+\.go:\d+\)/gi,     // Go
    /^\s+at\s+.+\(.+\.(ts|tsx|js|jsx):\d+:\d+\)$/gm, // TypeScript/JS with source maps
    /Traceback \(most recent call last\)/gi, // Python traceback header
    /panic:.*\.go:\d+/gi,                    // Go panic
    /Error:.*at\s+Object\./gi,               // Node.js error
  ];

  for (const pattern of stackTracePatterns) {
    const matches = allContent.match(pattern);
    if (matches && matches.length > 0) {
      patterns.push(`Stack trace detected: ${matches[0].substring(0, 60)}...`);
    }
  }

  // 2. Application error patterns
  const appErrorPatterns = [
    /NullPointerException|NullReferenceException/gi,
    /ClassNotFoundException|NoClassDefFoundError/gi,
    /ModuleNotFoundError|ImportError/gi,
    /TypeError|ReferenceError|SyntaxError/gi,
    /panic:|fatal error:/gi,
    /ENOENT|ECONNREFUSED|ETIMEDOUT/gi,
    /Connection refused|Connection timed out/gi,
    /Failed to load|Failed to initialize/gi,
    /Caused by:|Root cause:/gi,
  ];

  for (const pattern of appErrorPatterns) {
    const matches = allContent.match(pattern);
    if (matches && matches.length > 0) {
      patterns.push(`Application error: ${matches[0]}`);
    }
  }

  // 3. Source file references in logs
  const sourceFilePatterns = [
    /\b[\w./]+\.(java|py|go|ts|tsx|js|jsx|rs|rb|cs|cpp|c|h):\d+/gi,
    /\b(src|lib|app|pkg|internal|cmd)\/[\w./]+\.(java|py|go|ts|tsx|js|jsx)/gi,
    /\bcom\.[\w.]+\.(java|kt)/gi,  // Java package paths
    /\bpackage\s+[\w.]+/gi,         // Go/Java package declarations
  ];

  for (const pattern of sourceFilePatterns) {
    const matches = allContent.match(pattern);
    if (matches && matches.length > 0) {
      patterns.push(`Source file reference: ${matches[0]}`);
    }
  }

  // 4. Container image names that might map to local code
  const imagePatterns = [
    /image:\s*[\w.-]+\/[\w.-]+:[\w.-]+/gi,
    /CrashLoopBackOff|Error|ImagePullBackOff/gi,
  ];

  for (const pattern of imagePatterns) {
    const matches = allContent.match(pattern);
    if (matches && matches.length > 0 && patterns.length < 5) {
      // Only add if we have other patterns (image alone isn't strong enough)
      if (patterns.length > 0) {
        patterns.push(`Container issue: ${matches[0]}`);
      }
    }
  }

  // 5. Error message strings that are likely in source code
  const errorMessagePatterns = [
    /"[^"]{10,80}(error|failed|invalid|exception)[^"]*"/gi,
    /'[^']{10,80}(error|failed|invalid|exception)[^']*'/gi,
  ];

  for (const pattern of errorMessagePatterns) {
    const matches = allContent.match(pattern);
    if (matches && matches.length > 0) {
      patterns.push(`Error message: ${matches[0].substring(0, 50)}...`);
    }
  }

  // Determine if we should suggest code search
  const shouldSuggest = patterns.length >= 1;

  // Build a search query from the patterns
  let searchQuery = '';
  if (shouldSuggest) {
    // Extract the most searchable term
    const stackMatch = allContent.match(/at\s+([\w.$]+)\.(java|py|go|ts|js)/i);
    const errorMatch = allContent.match(/([\w]+Exception|[\w]+Error):/i);
    const fileMatch = allContent.match(/([\w]+)\.(java|py|go|ts|js):\d+/i);

    if (stackMatch) {
      searchQuery = stackMatch[1].split('.').pop() || stackMatch[1];
    } else if (errorMatch) {
      searchQuery = errorMatch[1];
    } else if (fileMatch) {
      searchQuery = fileMatch[1];
    } else {
      // Fallback: extract key error terms from user query
      const keyTerms = userQuery.match(/\b(error|crash|fail|exception|bug|issue)\b/gi);
      searchQuery = keyTerms ? keyTerms.join(' ') : 'error';
    }
  }

  let reason = '';
  if (patterns.length > 0) {
    reason = patterns.length === 1
      ? patterns[0]
      : `Found ${patterns.length} code-related patterns`;
  }

  return {
    shouldSuggest,
    reason,
    searchQuery,
    patterns
  };
}

/**
 * Extract learning metadata (Confidence, Root Cause) from LLM response
 */
export function extractLearningMetadata(response: string): {
  level: string;
  score: number;
  rootCause: string | null;
  hypotheses: Array<{ id: string; description: string; status: string }>;
} {
  // 1. Confidence
  const confidenceMatch = response.match(/\*\*Confidence\*\*:\s*(HIGH|MEDIUM|LOW)/i);
  const level = confidenceMatch ? confidenceMatch[1].toUpperCase() : 'UNKNOWN';
  const score = level === 'HIGH' ? 90 : level === 'MEDIUM' ? 60 : level === 'LOW' ? 30 : 0;

  // 2. Root Cause
  const rootCauseMatch = response.match(/\*\*Root Cause\*\*:\s*(.+?)(?=\n|$)/i);
  const rootCause = rootCauseMatch ? rootCauseMatch[1].trim() : null;

  // 3. Hypotheses (simplified from root cause)
  const hypotheses = rootCause ? [{
    id: 'final',
    description: rootCause,
    status: 'confirmed'
  }] : [];

  return { level, score, rootCause, hypotheses };
}
