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
