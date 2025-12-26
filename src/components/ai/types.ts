/**
 * Types for the Autonomous Investigation Agent
 *
 * These types support hypothesis-driven investigation with proper
 * error tracking, confidence scoring, and tool failure feedback.
 */

// =============================================================================
// TOOL OUTCOME TRACKING
// =============================================================================

export type ToolOutcomeStatus = 'success' | 'error' | 'empty' | 'partial' | 'skipped';

export interface ToolOutcome {
    tool: string;
    args: string | undefined;
    result: string;
    status: ToolOutcomeStatus;
    timestamp: number;
    /** Whether this result provided useful investigation data */
    useful: boolean;
    /** Error message if status is error */
    errorMessage?: string;
    /** Alternative tools suggested on failure */
    alternatives?: string[];
}

// =============================================================================
// HYPOTHESIS TRACKING
// =============================================================================

export type HypothesisStatus = 'investigating' | 'confirmed' | 'refuted' | 'inconclusive';
export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface Hypothesis {
    id: string;
    description: string;
    likelihood?: ConfidenceLevel;
    evidenceFor?: string[];
    evidenceAgainst?: string[];
    evidence: string[];  // Combined evidence list
    toolsToValidate?: string[];
    status: HypothesisStatus;
    createdAt: number;
    updatedAt: number;
}

// =============================================================================
// INVESTIGATION STATE
// =============================================================================

export interface InvestigationState {
    /** Unique ID for this investigation */
    id: string;
    /** Original user query */
    query: string;
    /** Start timestamp */
    startTime: number;
    /** Current iteration */
    iteration: number;
    /** Maximum allowed iterations (can be extended) */
    maxIterations: number;
    /** Base iteration budget (before bonuses) */
    baseIterations: number;
    /** Complete tool history with outcomes */
    toolHistory: ToolOutcome[];
    /** Active hypotheses being investigated */
    hypotheses: Hypothesis[];
    /** Consecutive unproductive iterations (not just errors) */
    consecutiveUnproductive: number;
    /** Total unproductive iterations in current investigation leg */
    unproductiveIterations: number;
    /** Tools that have failed (for alternative suggestions) */
    failedTools: Map<string, number>;
    /** Executed tool signatures to prevent duplicates */
    executedSignatures: Set<string>;
    /** Scratchpad notes for context */
    scratchpadNotes: string[];
    /** Current phase of investigation */
    phase: InvestigationPhase;
    /** Detected symptoms from cluster state */
    detectedSymptoms: string[];

    /** Investigation plan (LLM-generated) */
    plan?: InvestigationPlan;
}

export type InvestigationPhase =
    | 'initializing'
    | 'gathering'      // Running discovery tools
    | 'investigating'  // Running targeted tools based on findings
    | 'confirming'     // Validating hypotheses
    | 'concluding';    // Generating final answer

// =============================================================================
// CONFIDENCE ASSESSMENT
// =============================================================================

export interface ConfidenceFactors {
    /** Number of successful tools executed */
    successfulTools: number;
    /** Number of unique evidence sources */
    evidenceSources: number;
    /** Quality of evidence: direct (logs/events) vs indirect (status) */
    evidenceQuality: 'direct' | 'indirect' | 'circumstantial';
    /** Number of hypotheses tested */
    hypothesesTested: number;
    /** Number of hypotheses confirmed */
    hypothesesConfirmed: number;
    /** Number of errors encountered */
    errorsEncountered: number;
}

export interface ConfidenceAssessment {
    level: ConfidenceLevel;
    score: number;  // 0-100
    factors: ConfidenceFactors;
    explanation: string;
}

// =============================================================================
// INVESTIGATION PROGRESS (for UI)
// =============================================================================

export interface InvestigationProgress {
    phase: InvestigationPhase;
    iteration: number;
    maxIterations: number;
    toolsRun: number;
    hypothesesActive: number;
    confidence: ConfidenceAssessment;
    currentAction: string;
    timeElapsed: number;
    consecutiveUnproductive: number;
}

// =============================================================================
// TIMEOUT CONFIGURATION
// =============================================================================

export interface TimeoutConfig {
    /** Timeout per tool execution (ms) */
    TOOL_EXECUTION: number;
    /** Timeout per iteration (ms) */
    ITERATION: number;
    /** Total investigation timeout (ms) */
    TOTAL_INVESTIGATION: number;
    /** Timeout per LLM call (ms) */
    LLM_CALL: number;
}

export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
    TOOL_EXECUTION: 30_000,      // 30s per tool
    ITERATION: 60_000,           // 60s per iteration
    TOTAL_INVESTIGATION: 240_000, // 4 minutes total (extended for deeper runs)
    LLM_CALL: 45_000,            // 45s per LLM call
};

// =============================================================================
// ITERATION BUDGET CONFIGURATION
// =============================================================================

export interface IterationConfig {
    /** Base iteration count */
    BASE_ITERATIONS: number;
    /** Maximum iterations (even with bonuses) */
    MAX_ITERATIONS: number;
    /** Minimum successful tools to reset unproductive counter */
    MIN_PRODUCTIVE_TOOLS: number;
    /** Bonus triggers */
    BONUS_TRIGGERS: {
        /** Bonus for finding a new angle to investigate */
        newHypothesis: number;
        /** Bonus for finding partial evidence */
        partialEvidence: number;
        /** Bonus for starting to investigate a new resource type */
        newResourceType: number;
    };
}

export const DEFAULT_ITERATION_CONFIG: IterationConfig = {
    BASE_ITERATIONS: 10,
    MAX_ITERATIONS: 16,
    MIN_PRODUCTIVE_TOOLS: 2,
    BONUS_TRIGGERS: {
        newHypothesis: 2,
        partialEvidence: 1,
        newResourceType: 1,
    },
};



export type PlanStepStatus = 'pending' | 'running' | 'done' | 'skipped';

export interface PlanStep {
    tool: string;
    args?: string;
    rationale?: string;
    status: PlanStepStatus;
}

export interface InvestigationPlan {
    steps: PlanStep[];
    currentStep: number;
    generatedAt: number;
}

// =============================================================================
// EMPTY/USELESS RESULT PATTERNS
// =============================================================================

/** Patterns that indicate a "successful" tool returned no useful data */
export const EMPTY_RESULT_PATTERNS = [
    /no (pods?|events?|resources?|items?|endpoints?|services?) found/i,
    /^(none|empty|n\/a|\[\]|\{\})$/i,
    /0 items/i,
    /no (issues|problems|errors) found/i,
    /[OK] no/i,
    /not found/i,
];

/** Check if a result is empty/useless despite not being an error */
export function isEmptyResult(result: string): boolean {
    const trimmed = result.trim();
    if (!trimmed || trimmed.length < 10) return true;
    return EMPTY_RESULT_PATTERNS.some(p => p.test(trimmed));
}

/** Check if a result contains actual evidence */
export function hasUsefulEvidence(result: string): boolean {
    // Check for error/warning indicators that ARE useful evidence
    const errorIndicators = [
        /error|fail|crash|oom|killed|backoff|refused|timeout|denied/i,
        /exit code [1-9]/i,
        /not ready|unhealthy|degraded/i,
        /pending|terminating|evicted/i,
        /insufficient|exceeded|limit/i,
    ];

    if (errorIndicators.some(p => p.test(result))) return true;

    // Check for status information
    const statusIndicators = [
        /status:/i,
        /running|succeeded|completed/i,
        /ready:\s*\d+\/\d+/i,
        /restart(s|ed)?:\s*\d+/i,
    ];

    return statusIndicators.some(p => p.test(result));
}

// =============================================================================
// CIRCUIT BREAKER FOR TOOL FAILURES
// =============================================================================

export interface CircuitBreakerState {
    /** Current state */
    state: 'closed' | 'open' | 'half-open';
    /** Number of consecutive failures */
    failureCount: number;
    /** Timestamp of last failure */
    lastFailure: number;
    /** Cooldown period in ms before trying again */
    cooldownMs: number;
}

/** Default circuit breaker config */
export const CIRCUIT_BREAKER_CONFIG = {
    /** Number of failures before opening circuit */
    FAILURE_THRESHOLD: 3,
    /** Cooldown period before half-open */
    COOLDOWN_MS: 30_000,
    /** Default state */
    DEFAULT_STATE: {
        state: 'closed' as const,
        failureCount: 0,
        lastFailure: 0,
        cooldownMs: 30_000,
    },
};

/** Circuit breaker registry for tools */
export class ToolCircuitBreaker {
    private breakers: Map<string, CircuitBreakerState> = new Map();

    /** Check if tool is available (circuit closed or half-open after cooldown) */
    canExecute(toolName: string): { allowed: boolean; reason?: string } {
        const breaker = this.breakers.get(toolName);
        if (!breaker) return { allowed: true };

        if (breaker.state === 'closed') {
            return { allowed: true };
        }

        if (breaker.state === 'open') {
            const elapsed = Date.now() - breaker.lastFailure;
            if (elapsed >= breaker.cooldownMs) {
                // Move to half-open - allow one try
                breaker.state = 'half-open';
                return { allowed: true };
            }
            const remainingS = Math.ceil((breaker.cooldownMs - elapsed) / 1000);
            return {
                allowed: false,
                reason: `Tool ${toolName} temporarily disabled (${breaker.failureCount} failures). Retry in ${remainingS}s.`,
            };
        }

        // Half-open - allow
        return { allowed: true };
    }

    /** Record a successful execution */
    recordSuccess(toolName: string): void {
        const breaker = this.breakers.get(toolName);
        if (breaker) {
            breaker.state = 'closed';
            breaker.failureCount = 0;
        }
    }

    /** Record a failed execution */
    recordFailure(toolName: string): void {
        let breaker = this.breakers.get(toolName);
        if (!breaker) {
            breaker = { ...CIRCUIT_BREAKER_CONFIG.DEFAULT_STATE };
            this.breakers.set(toolName, breaker);
        }

        breaker.failureCount++;
        breaker.lastFailure = Date.now();

        if (breaker.failureCount >= CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD) {
            breaker.state = 'open';
        }
    }

    /** Reset all breakers */
    reset(): void {
        this.breakers.clear();
    }

    /** Get status for display */
    getStatus(): Map<string, CircuitBreakerState> {
        return new Map(this.breakers);
    }
}

// =============================================================================
// SEMANTIC HISTORY COMPRESSION
// =============================================================================

export interface CompressedResult {
    toolName: string;
    content: string;
    priority: number;
    isError: boolean;
    timestamp: number;
}

/**
 * Calculate priority score for a tool result
 * Higher priority = more important to keep detailed
 */
export function calculateResultPriority(
    result: string,
    toolName: string,
    index: number,
    totalResults: number
): number {
    let priority = 0;

    // Error indicators = HIGH priority (keep details)
    const errorPatterns = [
        /error|fail|crash|oom|killed/i,
        /exit code [1-9]/i,
        /backoff|refused|timeout/i,
        /not ready|unhealthy/i,
    ];
    if (errorPatterns.some(p => p.test(result))) {
        priority += 50;
    }

    // Direct evidence tools = HIGH priority
    const directEvidenceTools = ['GET_LOGS', 'GET_EVENTS', 'DESCRIBE'];
    if (directEvidenceTools.includes(toolName)) {
        priority += 30;
    }

    // Discovery tools = MEDIUM priority
    const discoveryTools = ['FIND_ISSUES', 'CLUSTER_HEALTH'];
    if (discoveryTools.includes(toolName)) {
        priority += 20;
    }

    // Recency bonus (newer = higher priority)
    const recencyBonus = ((index + 1) / totalResults) * 25;
    priority += recencyBonus;

    // Content length bonus (more content = probably more useful)
    if (result.length > 500) priority += 10;
    if (result.length > 1000) priority += 5;

    return Math.round(priority);
}

/**
 * Compress tool history with semantic prioritization
 * Keeps high-priority results detailed, summarizes lower priority
 */
export function compressToolHistorySemantic(
    results: Array<{ toolName: string; content: string; timestamp?: number }>,
    keepDetailedCount: number = 4,
    maxSummaryChars: number = 300
): string {
    if (results.length === 0) return 'No tool results yet.';
    if (results.length <= keepDetailedCount) {
        return results.map(r => `## ${r.toolName}\n${r.content}`).join('\n\n---\n\n');
    }

    // Calculate priorities
    const prioritized = results.map((r, i) => ({
        ...r,
        priority: calculateResultPriority(r.content, r.toolName, i, results.length),
        isError: /^[X]|error|fail/i.test(r.content),
    })).sort((a, b) => b.priority - a.priority);

    // Keep top N detailed
    const detailed = prioritized.slice(0, keepDetailedCount);
    const summarized = prioritized.slice(keepDetailedCount);

    const detailedSection = detailed
        .map(r => `## ${r.toolName} (Priority: ${r.priority})\n${r.content}`)
        .join('\n\n---\n\n');

    const summarizedSection = summarized
        .map(r => {
            const summary = r.content.length > maxSummaryChars
                ? r.content.slice(0, maxSummaryChars) + '...'
                : r.content;
            const firstLine = summary.split('\n')[0];
            return `• **${r.toolName}**: ${firstLine}`;
        })
        .join('\n');

    return `=== KEY EVIDENCE (detailed) ===
${detailedSection}

=== SUPPORTING EVIDENCE (summarized) ===
${summarizedSection}`;
}

// =============================================================================
// ERROR CATEGORIZATION
// =============================================================================

export type ErrorCategory =
    | 'not_found'       // Resource doesn't exist
    | 'permission'      // RBAC or auth issues
    | 'timeout'         // Operation timed out
    | 'invalid_args'    // Bad arguments provided
    | 'empty_result'    // Valid but no data
    | 'network'         // Network/connectivity issues
    | 'unknown';        // Other errors

/** Categorize an error for better recovery suggestions */
export function categorizeError(errorMessage: string): ErrorCategory {
    const lower = errorMessage.toLowerCase();

    if (/not found|doesn't exist|no such|unknown|404/i.test(lower)) {
        return 'not_found';
    }
    if (/forbidden|unauthorized|permission|rbac|403|401/i.test(lower)) {
        return 'permission';
    }
    if (/timeout|timed out|deadline exceeded/i.test(lower)) {
        return 'timeout';
    }
    if (/invalid|bad request|malformed|400/i.test(lower)) {
        return 'invalid_args';
    }
    if (/no (pods?|events?|resources?|items?) found|empty|none/i.test(lower)) {
        return 'empty_result';
    }
    if (/connection refused|network|unreachable|dial/i.test(lower)) {
        return 'network';
    }

    return 'unknown';
}

/** Get recovery suggestions based on error category */
export function getRecoverySuggestions(category: ErrorCategory, toolName: string): string[] {
    const suggestions: Record<ErrorCategory, string[]> = {
        'not_found': [
            'Run LIST_ALL to discover actual resource names',
            'Check if the namespace is correct',
            'Verify the resource type (Pod vs Deployment, etc.)',
        ],
        'permission': [
            'Check RBAC permissions with RUN_KUBECTL auth can-i',
            'Verify service account has correct roles',
            'Check if namespace has resource quotas',
        ],
        'timeout': [
            'Try a simpler query first',
            'Check cluster connectivity with CLUSTER_HEALTH',
            'The cluster may be under heavy load',
        ],
        'invalid_args': [
            'Check argument format: kind namespace name',
            'Use LIST_ALL to find correct resource names',
            'Verify namespace exists',
        ],
        'empty_result': [
            'This may be expected - no issues in this area',
            'Try a broader search with FIND_ISSUES',
            'Check a different namespace',
        ],
        'network': [
            'Check cluster connectivity',
            'Verify kubeconfig is correct',
            'Run CLUSTER_HEALTH to check overall status',
        ],
        'unknown': [
            'Try an alternative tool',
            'Check cluster health first',
            'Run FIND_ISSUES for a broader view',
        ],
    };

    return suggestions[category] || suggestions['unknown'];
}

// =============================================================================
// PARALLEL EXECUTION HELPERS
// =============================================================================

export interface ParallelToolExecution {
    toolName: string;
    args: string | undefined;
    priority: number;  // Higher = execute first
}

/** Group tools for parallel execution based on dependencies */
export function groupToolsForParallelExecution(
    tools: Array<{ toolName: string; args: string | undefined }>
): ParallelToolExecution[][] {
    // Discovery tools should run first
    const discoveryTools = ['FIND_ISSUES', 'CLUSTER_HEALTH', 'LIST_ALL'];
    // These tools depend on discovery results
    const dependentTools = ['DESCRIBE', 'GET_LOGS', 'GET_ENDPOINTS', 'GET_EVENTS'];

    const discovery: ParallelToolExecution[] = [];
    const dependent: ParallelToolExecution[] = [];
    const other: ParallelToolExecution[] = [];

    for (const tool of tools) {
        if (discoveryTools.includes(tool.toolName)) {
            discovery.push({ ...tool, priority: 10 });
        } else if (dependentTools.includes(tool.toolName)) {
            dependent.push({ ...tool, priority: 5 });
        } else {
            other.push({ ...tool, priority: 3 });
        }
    }

    // Return groups in order: discovery first, then dependent, then other
    const groups: ParallelToolExecution[][] = [];
    if (discovery.length > 0) groups.push(discovery);
    if (dependent.length > 0) groups.push(dependent);
    if (other.length > 0) groups.push(other);

    return groups;
}

/** Execute tools in parallel with concurrency limit */
export async function executeToolsInParallel<T>(
    tools: Array<{ toolName: string; args: string | undefined }>,
    executor: (toolName: string, args: string | undefined) => Promise<T>,
    maxConcurrency: number = 3
): Promise<Array<{ toolName: string; args: string | undefined; result: T }>> {
    const results: Array<{ toolName: string; args: string | undefined; result: T }> = [];

    // Process in batches
    for (let i = 0; i < tools.length; i += maxConcurrency) {
        const batch = tools.slice(i, i + maxConcurrency);
        const batchResults = await Promise.all(
            batch.map(async (tool) => ({
                toolName: tool.toolName,
                args: tool.args,
                result: await executor(tool.toolName, tool.args),
            }))
        );
        results.push(...batchResults);
    }

    return results;
}

// =============================================================================
// RESOURCE DISCOVERY CACHE
// =============================================================================

export interface DiscoveredResource {
    kind: string;
    namespace: string;
    name: string;
    status?: string;
    timestamp: number;
}

export class ResourceDiscoveryCache {
    private resources: Map<string, DiscoveredResource[]> = new Map();
    private readonly TTL_MS = 60_000; // 1 minute cache

    /** Add discovered resources */
    addResources(kind: string, resources: DiscoveredResource[]): void {
        const key = kind.toLowerCase();
        this.resources.set(key, resources);
    }

    /** Get cached resources of a kind */
    getResources(kind: string): DiscoveredResource[] | null {
        const key = kind.toLowerCase();
        const cached = this.resources.get(key);
        if (!cached || cached.length === 0) return null;

        // Check if expired
        const now = Date.now();
        if (cached[0].timestamp + this.TTL_MS < now) {
            this.resources.delete(key);
            return null;
        }

        return cached;
    }

    /** Check if we have a specific resource */
    hasResource(kind: string, namespace: string, name: string): boolean {
        const resources = this.getResources(kind);
        if (!resources) return false;
        return resources.some(r =>
            r.namespace === namespace && r.name === name
        );
    }

    /** Get resource names for a kind in a namespace */
    getResourceNames(kind: string, namespace?: string): string[] {
        const resources = this.getResources(kind);
        if (!resources) return [];

        const filtered = namespace
            ? resources.filter(r => r.namespace === namespace)
            : resources;

        return filtered.map(r => `${r.namespace}/${r.name}`);
    }

    /** Clear cache */
    clear(): void {
        this.resources.clear();
    }
}

// =============================================================================
// INVESTIGATION MEMORY
// =============================================================================

export interface InvestigationMemory {
    /** Previous queries and their outcomes */
    previousQueries: Array<{
        query: string;
        timestamp: number;
        outcome: 'resolved' | 'partial' | 'failed';
        keyFindings: string[];
    }>;
    /** Known problematic resources */
    knownIssues: Array<{
        kind: string;
        namespace: string;
        name: string;
        issue: string;
        lastSeen: number;
    }>;
    /** Cached resource discovery */
    discoveryCache: ResourceDiscoveryCache;
}

/** Create empty investigation memory */
export function createInvestigationMemory(): InvestigationMemory {
    return {
        previousQueries: [],
        knownIssues: [],
        discoveryCache: new ResourceDiscoveryCache(),
    };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/** Create a new investigation state */
export function createInvestigationState(
    query: string,
    config: IterationConfig = DEFAULT_ITERATION_CONFIG
): InvestigationState {
    return {
        id: `inv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        query,
        startTime: Date.now(),
        iteration: 0,
        maxIterations: config.BASE_ITERATIONS,
        baseIterations: config.BASE_ITERATIONS,
        toolHistory: [],
        hypotheses: [],
        consecutiveUnproductive: 0,
        unproductiveIterations: 0,
        failedTools: new Map(),
        executedSignatures: new Set(),
        scratchpadNotes: [],
        phase: 'initializing',
        detectedSymptoms: [],

        plan: undefined,
    };
}

/** Evaluate tool outcome status from result string */
export function evaluateToolOutcome(
    result: string,
    toolName: string
): { status: ToolOutcomeStatus; useful: boolean } {
    // Check for explicit errors
    if (result.startsWith('[X]')) {
        return { status: 'error', useful: false };
    }

    // Check for warnings (partial success)
    if (result.startsWith('[WARN]')) {
        // Warnings about missing data can still be useful
        const hasInfo = hasUsefulEvidence(result);
        return { status: 'partial', useful: hasInfo };
    }

    // Check for empty results
    if (isEmptyResult(result)) {
        return { status: 'empty', useful: false };
    }

    // Check if result has actual useful evidence
    const useful = hasUsefulEvidence(result) || result.length > 100;

    return { status: 'success', useful };
}

/** Calculate confidence score based on investigation state */
export function calculateConfidence(state: InvestigationState): ConfidenceAssessment {
    const factors: ConfidenceFactors = {
        successfulTools: state.toolHistory.filter(t => t.status === 'success' && t.useful).length,
        evidenceSources: new Set(state.toolHistory.filter(t => t.useful).map(t => t.tool)).size,
        evidenceQuality: determineEvidenceQuality(state.toolHistory),
        hypothesesTested: state.hypotheses.filter(h => h.status !== 'investigating').length,
        hypothesesConfirmed: state.hypotheses.filter(h => h.status === 'confirmed').length,
        errorsEncountered: state.toolHistory.filter(t => t.status === 'error').length,

    };

    let score = 0;

    // CORE PRINCIPLE: Confirming a hypothesis IS the goal of investigation
    // If we successfully identify the root cause, that's HIGH confidence territory

    // Hypothesis confirmation is the PRIMARY driver (max 40 points)
    // This is what matters most - did we find the answer?
    if (factors.hypothesesConfirmed > 0) {
        score += 35; // One confirmed hypothesis = major success
        score += Math.min((factors.hypothesesConfirmed - 1) * 5, 5); // Bonus for multiple
    } else if (factors.hypothesesTested > 0) {
        score += 15; // Tested but refuted still shows progress
    } else if (state.hypotheses.length > 0) {
        score += 5; // At least we're investigating something
    }

    // Evidence contribution (max 30 points)
    // Tools provide supporting evidence for our hypothesis
    score += Math.min(factors.successfulTools * 8, 24);
    score += Math.min(factors.evidenceSources * 3, 6);

    // Evidence quality bonus (max 15 points)
    // Direct evidence strengthens confidence in our conclusion
    if (factors.evidenceQuality === 'direct') score += 15;
    else if (factors.evidenceQuality === 'indirect') score += 10;
    else score += 3;



    // Investigation thoroughness (max 5 points)
    score += Math.min(state.iteration, 5);

    // Penalty for errors - minimal impact (max -5)
    // Errors are normal during investigation, shouldn't tank confidence
    // What matters is: did we find the answer despite the errors?
    score -= Math.min(factors.errorsEncountered, 5);

    // Clamp score
    score = Math.max(0, Math.min(100, score));

    // Thresholds: HIGH at 55, MEDIUM at 30
    // Lowered HIGH threshold because confirmed hypothesis is the key metric
    const level: ConfidenceLevel = score >= 55 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';

    return {
        level,
        score,
        factors,
        explanation: generateConfidenceExplanation(factors, score, level),
    };
}

function determineEvidenceQuality(history: ToolOutcome[]): 'direct' | 'indirect' | 'circumstantial' {
    const directTools = ['GET_LOGS', 'GET_EVENTS', 'DESCRIBE'];
    const indirectTools = ['LIST_ALL', 'FIND_ISSUES', 'CLUSTER_HEALTH'];

    const usefulTools = history.filter(t => t.useful);
    const hasDirect = usefulTools.some(t => directTools.includes(t.tool));
    const hasIndirect = usefulTools.some(t => indirectTools.includes(t.tool));

    if (hasDirect) return 'direct';
    if (hasIndirect) return 'indirect';
    return 'circumstantial';
}

function generateConfidenceExplanation(
    factors: ConfidenceFactors,
    score: number,
    level: ConfidenceLevel
): string {
    const parts: string[] = [];

    parts.push(`${factors.successfulTools} useful tool results`);
    parts.push(`${factors.evidenceSources} evidence sources`);
    parts.push(`${factors.evidenceQuality} evidence quality`);

    if (factors.hypothesesConfirmed > 0) {
        parts.push(`${factors.hypothesesConfirmed} hypothesis confirmed`);
    }

    if (factors.errorsEncountered > 0) {
        parts.push(`${factors.errorsEncountered} errors encountered`);
    }

    return `${level} confidence (${score}/100): ${parts.join(', ')}`;
}

/** Check if investigation should continue */
export function shouldContinueInvestigation(state: InvestigationState): boolean {
    // Hard limits
    if (state.iteration >= state.maxIterations) return false;
    if (state.consecutiveUnproductive >= 3) return false;

    // Check timeout
    const elapsed = Date.now() - state.startTime;
    if (elapsed >= DEFAULT_TIMEOUT_CONFIG.TOTAL_INVESTIGATION) return false;

    // Continue if we haven't confirmed any hypothesis
    const hasConfirmed = state.hypotheses.some(h => h.status === 'confirmed');
    if (hasConfirmed) {
        // Even with confirmed hypothesis, continue if confidence is low
        const confidence = calculateConfidence(state);
        return confidence.level === 'LOW';
    }

    return true;
}

/** Calculate remaining iteration budget */
export function calculateRemainingBudget(
    state: InvestigationState,
    config: IterationConfig = DEFAULT_ITERATION_CONFIG
): number {
    let budget = state.maxIterations - state.iteration;

    // Grant bonus iterations for productive investigation
    const lastIterationTools = state.toolHistory.filter(
        t => t.timestamp > state.startTime + (state.iteration - 1) * 60000
    );

    const foundNewEvidence = lastIterationTools.some(t => t.useful && t.status === 'success');
    if (foundNewEvidence && state.iteration > 0) {
        budget += config.BONUS_TRIGGERS.partialEvidence;
    }

    // Cap at max
    return Math.min(budget, config.MAX_ITERATIONS - state.iteration);
}

// =============================================================================
// HYPOTHESIS EXTRACTION FROM LLM RESPONSES
// =============================================================================

/**
 * Extract hypotheses from LLM response text.
 * Looks for patterns like:
 * - H1: [cause] → Status: INVESTIGATING
 * - **Hypothesis**: ...
 * - I suspect that...
 * - This could be caused by...
 * - Root Cause: ...
 * - The issue is...
 */
export function extractHypotheses(
    response: string,
    existingHypotheses: Hypothesis[] = []
): Hypothesis[] {
    const hypotheses: Hypothesis[] = [...existingHypotheses];
    const now = Date.now();

    // Pattern 1: H1: [cause] (flexible format - with or without status)
    // Matches: "H1: pods crashing", "- H1: OOM issue → INVESTIGATING", etc.
    const hPattern = /[-•*]?\s*H(\d+)[:\s]+([^→\n]{10,150})(?:\s*→?\s*(?:Status:?\s*)?(\w+))?/gi;
    let match;
    while ((match = hPattern.exec(response)) !== null) {
        const id = `H${match[1]}`;
        const cause = match[2].trim().replace(/\*\*/g, ''); // Remove markdown bold
        const statusText = (match[3] || 'investigating').toLowerCase();

        const status: HypothesisStatus =
            statusText.includes('confirm') ? 'confirmed' :
                statusText.includes('refut') ? 'refuted' :
                    'investigating';

        // Update existing or add new
        const existingIdx = hypotheses.findIndex(h => h.id === id);
        if (existingIdx >= 0) {
            hypotheses[existingIdx] = {
                ...hypotheses[existingIdx],
                status,
                updatedAt: now,
            };
        } else if (cause.length >= 10) {
            hypotheses.push({
                id,
                description: cause,
                status,
                evidence: [],
                createdAt: now,
                updatedAt: now,
            });
        }
    }

    // Pattern 2: More natural language patterns for hypothesis extraction
    const suspectPatterns = [
        /(?:I\s+)?(?:suspect|believe|think)\s+(?:that\s+)?(.{15,150}?)(?:\.|$)/gi,
        /(?:likely|probable|possible)\s+(?:cause|issue|problem)[:\s]+(.{15,150}?)(?:\.|$)/gi,
        /(?:root\s+cause|problem|issue)\s+(?:is|seems?\s+to\s+be|appears?\s+to\s+be)[:\s]+(.{15,150}?)(?:\.|$)/gi,
        /(?:this\s+(?:is|indicates?|suggests?|points?\s+to))[:\s]+(.{15,150}?)(?:\.|$)/gi,
        /(?:caused\s+by|due\s+to|because\s+of)[:\s]+(.{15,150}?)(?:\.|$)/gi,
    ];

    for (const pattern of suspectPatterns) {
        pattern.lastIndex = 0;
        while ((match = pattern.exec(response)) !== null) {
            const cause = match[1].trim().replace(/\*\*/g, '');
            if (cause.length >= 15 && cause.length <= 200) {
                // Check if similar hypothesis already exists (fuzzy match)
                const causeWords = cause.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                const similar = hypotheses.some(h => {
                    const hWords = h.description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                    const overlap = causeWords.filter(w => hWords.some(hw => hw.includes(w) || w.includes(hw)));
                    return overlap.length >= Math.min(2, causeWords.length * 0.4);
                });

                if (!similar) {
                    hypotheses.push({
                        id: `H${hypotheses.length + 1}`,
                        description: cause,
                        status: 'investigating',
                        evidence: [],
                        createdAt: now,
                        updatedAt: now,
                    });
                }
            }
        }
    }

    // Pattern 3: Detect confirmation in various formats
    const confirmPatterns = [
        /(?:confirmed?|verified|identified)[:\s]+(.{15,150}?)(?:\n|$)/gi,
        /root\s+cause[:\s]+\*?\*?(.{15,150}?)\*?\*?(?:\n|$)/gi,
        /\*\*root\s+cause[:\s]*\*\*[:\s]*(.{15,150}?)(?:\n|$)/gi,
        /##\s*root\s*cause[:\s]*\n+(.{15,150}?)(?:\n|$)/gi,
        /the\s+(?:actual|real|underlying)\s+(?:cause|issue|problem)\s+(?:is|was)[:\s]+(.{15,150}?)(?:\.|$)/gi,
    ];

    for (const pattern of confirmPatterns) {
        pattern.lastIndex = 0;
        while ((match = pattern.exec(response)) !== null) {
            const cause = match[1].trim().replace(/\*\*/g, '');
            if (cause.length >= 10) {
                // Mark matching hypotheses as confirmed, or create new confirmed one
                let foundMatch = false;
                const causeWords = cause.toLowerCase().split(/\s+/).filter(w => w.length > 3);

                for (const h of hypotheses) {
                    const hWords = h.description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                    const overlap = causeWords.filter(w => hWords.some(hw => hw.includes(w) || w.includes(hw)));
                    if (overlap.length >= Math.min(2, causeWords.length * 0.3)) {
                        h.status = 'confirmed';
                        h.updatedAt = now;
                        foundMatch = true;
                    }
                }

                // If no matching hypothesis, create a confirmed one
                if (!foundMatch && cause.length <= 150) {
                    hypotheses.push({
                        id: `H${hypotheses.length + 1}`,
                        description: cause,
                        status: 'confirmed',
                        evidence: [],
                        createdAt: now,
                        updatedAt: now,
                    });
                }
            }
        }
    }

    // Pattern 4: Detect refutation
    const refutePatterns = [
        /(?:ruled\s+out|refuted?|not\s+the\s+cause|unlikely)[:\s]+(.{10,100}?)(?:\n|$)/gi,
        /(?:this\s+is\s+not|doesn't?\s+appear\s+to\s+be)[:\s]+(.{10,100}?)(?:\n|$)/gi,
    ];

    for (const pattern of refutePatterns) {
        pattern.lastIndex = 0;
        while ((match = pattern.exec(response)) !== null) {
            const cause = match[1].trim();
            // Mark matching hypotheses as refuted
            for (const h of hypotheses) {
                if (h.status === 'investigating' &&
                    cause.toLowerCase().includes(h.description.toLowerCase().slice(0, 20))) {
                    h.status = 'refuted';
                    h.updatedAt = now;
                }
            }
        }
    }

    return hypotheses;
}

/**
 * Extract key evidence points from tool results
 */
export function extractEvidencePoints(toolResult: string, toolName: string): string[] {
    const evidence: string[] = [];

    // Error patterns - high value evidence
    const errorPatterns = [
        /Error:\s*(.+?)(?:\n|$)/gi,
        /Exit\s+code[:\s]+(\d+)/gi,
        /OOMKilled|CrashLoopBackOff|ImagePullBackOff|ErrImagePull/gi,
        /Reason:\s*(.+?)(?:\n|$)/gi,
        /Message:\s*(.+?)(?:\n|$)/gi,
    ];

    for (const pattern of errorPatterns) {
        const matches = toolResult.matchAll(pattern);
        for (const match of matches) {
            const point = match[0].trim();
            if (point.length > 5 && point.length < 200) {
                evidence.push(`[${toolName}] ${point}`);
            }
        }
    }

    // Status patterns
    const statusPatterns = [
        /Status:\s*(Running|Pending|Failed|Succeeded|Unknown)/gi,
        /Ready:\s*(\d+\/\d+)/gi,
        /Restarts?:\s*(\d+)/gi,
        /Age:\s*(\w+)/gi,
    ];

    for (const pattern of statusPatterns) {
        const matches = toolResult.matchAll(pattern);
        for (const match of matches) {
            evidence.push(`[${toolName}] ${match[0].trim()}`);
        }
    }

    // Limit to most relevant
    return evidence.slice(0, 5);
}

/**
 * Format hypotheses for display in investigation
 */
export function formatHypothesesForPrompt(hypotheses: Hypothesis[]): string {
    if (hypotheses.length === 0) {
        return 'No hypotheses formed yet - gather initial evidence first.';
    }

    const lines = hypotheses.map(h => {
        const emoji =
            h.status === 'confirmed' ? '✅' :
                h.status === 'refuted' ? '❌' :
                    '🔍';

        const evidenceStr = h.evidence.length > 0
            ? ` | Evidence: ${h.evidence.slice(-2).join('; ')}`
            : '';

        return `${emoji} ${h.id}: ${h.description} → ${h.status.toUpperCase()}${evidenceStr}`;
    });

    return lines.join('\n');
}

/**
 * Suggest next tools based on hypotheses and evidence
 */
export function suggestToolsForHypothesis(hypothesis: Hypothesis): string[] {
    const desc = hypothesis.description.toLowerCase();
    const suggestions: string[] = [];

    if (desc.includes('crash') || desc.includes('oom') || desc.includes('restart')) {
        suggestions.push('GET_LOGS <namespace> <pod> --previous', 'DESCRIBE Pod <namespace> <pod>');
    }

    if (desc.includes('pending') || desc.includes('schedul')) {
        suggestions.push('DESCRIBE Pod <namespace> <pod>', 'GET_EVENTS <namespace>', 'TOP_PODS');
    }

    if (desc.includes('network') || desc.includes('connect') || desc.includes('service')) {
        suggestions.push('GET_ENDPOINTS <namespace> <service>', 'DESCRIBE Service <namespace> <svc>');
    }

    if (desc.includes('config') || desc.includes('secret') || desc.includes('mount')) {
        suggestions.push('DESCRIBE Pod <namespace> <pod>', 'LIST_ALL ConfigMap <namespace>');
    }

    if (desc.includes('permission') || desc.includes('rbac') || desc.includes('forbidden')) {
        suggestions.push('RUN_KUBECTL auth can-i --list');
    }

    if (desc.includes('image') || desc.includes('pull')) {
        suggestions.push('DESCRIBE Pod <namespace> <pod>', 'GET_EVENTS <namespace>');
    }

    // Default suggestions if none matched
    if (suggestions.length === 0) {
        suggestions.push('DESCRIBE Pod <namespace> <pod>', 'GET_EVENTS <namespace>');
    }

    return suggestions.slice(0, 3);
}

// =============================================================================
// INTELLIGENT TOOL SELECTION
// =============================================================================

/**
 * Tool metadata for intelligent selection
 */
export interface ToolMetadata {
    name: string;
    description: string;
    useCases: string[];
    requires: string[];  // What info is needed before calling this tool
    provides: string[];  // What info this tool reveals
    priority: number;    // 1-10, higher = use first
}

export const TOOL_CATALOG: ToolMetadata[] = [
    {
        name: 'FIND_ISSUES',
        description: 'Scan entire cluster for problems - best FIRST tool',
        useCases: ['initial investigation', 'health check', 'finding problems'],
        requires: [],
        provides: ['pod names', 'namespaces', 'error types', 'resource status'],
        priority: 10,
    },
    {
        name: 'CLUSTER_HEALTH',
        description: 'Get cluster overview - nodes, pods, deployments summary',
        useCases: ['quick status', 'resource utilization', 'node health'],
        requires: [],
        provides: ['node count', 'pod counts', 'deployment health', 'CPU/memory usage'],
        priority: 9,
    },
    {
        name: 'LIST_ALL',
        description: 'List all resources of a kind (e.g., LIST_ALL Pod)',
        useCases: ['finding resources', 'discovering names', 'status overview'],
        requires: ['resource kind'],
        provides: ['resource names', 'namespaces', 'status'],
        priority: 8,
    },
    {
        name: 'GET_EVENTS',
        description: 'Get warning/error events for a namespace or cluster-wide',
        useCases: ['recent problems', 'scheduling failures', 'error history'],
        requires: [],
        provides: ['event messages', 'timestamps', 'involved resources'],
        priority: 7,
    },
    {
        name: 'DESCRIBE',
        description: 'Get detailed resource info including events (DESCRIBE kind ns name)',
        useCases: ['deep investigation', 'configuration check', 'event history'],
        requires: ['kind', 'namespace', 'resource name'],
        provides: ['full spec', 'status', 'events', 'conditions'],
        priority: 6,
    },
    {
        name: 'GET_LOGS',
        description: 'Get container logs (GET_LOGS ns pod [container])',
        useCases: ['crash investigation', 'error messages', 'application logs'],
        requires: ['namespace', 'pod name'],
        provides: ['application output', 'error messages', 'stack traces'],
        priority: 6,
    },
    {
        name: 'TOP_PODS',
        description: 'Get pod CPU/memory usage (requires metrics-server)',
        useCases: ['resource usage', 'OOM investigation', 'capacity planning'],
        requires: [],
        provides: ['CPU millicores', 'memory MiB', 'per-pod usage'],
        priority: 5,
    },
    {
        name: 'SEARCH_KNOWLEDGE',
        description: 'Search internal knowledge base for troubleshooting guides',
        useCases: ['finding solutions', 'best practices', 'known issues'],
        requires: ['search query'],
        provides: ['troubleshooting steps', 'solutions', 'recommendations'],
        priority: 5,
    },
    {
        name: 'WEB_SEARCH',
        description: 'Search web for Kubernetes docs, Stack Overflow, GitHub issues',
        useCases: ['unfamiliar errors', 'external documentation', 'community solutions'],
        requires: ['search query'],
        provides: ['external solutions', 'documentation links', 'similar issues'],
        priority: 4,
    },
    {
        name: 'GET_ENDPOINTS',
        description: 'Check service endpoints (GET_ENDPOINTS ns service)',
        useCases: ['service connectivity', 'routing issues', 'no endpoints'],
        requires: ['namespace', 'service name'],
        provides: ['ready addresses', 'not ready addresses', 'ports'],
        priority: 5,
    },
    {
        name: 'GET_NAMESPACE',
        description: 'Get namespace status and conditions',
        useCases: ['terminating namespaces', 'namespace issues'],
        requires: ['namespace name'],
        provides: ['phase', 'conditions', 'finalizers'],
        priority: 4,
    },
    {
        name: 'LIST_FINALIZERS',
        description: 'Find resources with finalizers blocking deletion',
        useCases: ['stuck deletions', 'terminating resources'],
        requires: ['namespace'],
        provides: ['finalizer names', 'blocking resources'],
        priority: 4,
    },
    {
        name: 'RUN_KUBECTL',
        description: 'Run arbitrary read-only kubectl commands',
        useCases: ['complex queries', 'specific fields', 'custom filtering'],
        requires: ['kubectl command'],
        provides: ['command output'],
        priority: 3,
    },
];

/**
 * Get recommended next tools based on investigation context
 */
export function getNextToolRecommendations(
    state: InvestigationState,
    lastResult: string,
): string[] {
    const executedTools = new Set(state.toolHistory.map(t => t.tool));
    const recommendations: string[] = [];

    // If no tools executed yet, always start with FIND_ISSUES
    if (executedTools.size === 0) {
        return ['FIND_ISSUES'];
    }

    // Analyze last result for clues
    const resultLower = lastResult.toLowerCase();

    // Crashloop detected → GET_LOGS
    if (resultLower.includes('crashloop') || resultLower.includes('restart')) {
        if (!executedTools.has('GET_LOGS')) {
            recommendations.push('GET_LOGS');
        }
    }

    // OOM detected → TOP_PODS
    if (resultLower.includes('oom') || resultLower.includes('exit code 137') || resultLower.includes('memory')) {
        if (!executedTools.has('TOP_PODS')) {
            recommendations.push('TOP_PODS');
        }
    }

    // Service issues → GET_ENDPOINTS
    if (resultLower.includes('service') || resultLower.includes('endpoint') || resultLower.includes('connect')) {
        if (!executedTools.has('GET_ENDPOINTS')) {
            recommendations.push('GET_ENDPOINTS');
        }
    }

    // Pending pods → DESCRIBE for events
    if (resultLower.includes('pending') || resultLower.includes('scheduling')) {
        if (!executedTools.has('DESCRIBE')) {
            recommendations.push('DESCRIBE');
        }
    }

    // Unknown error → WEB_SEARCH
    if (recommendations.length === 0 && state.consecutiveUnproductive >= 1) {
        if (!executedTools.has('WEB_SEARCH')) {
            recommendations.push('WEB_SEARCH');
        }
    }

    // NOTE: SEARCH_KNOWLEDGE is no longer auto-recommended
    // LLM decides when to use KB search based on user intent

    return recommendations.slice(0, 3);
}

/**
 * Build a tool guidance section for the LLM prompt
 */
export function buildToolGuidance(
    state: InvestigationState,
    discoveredResources: Array<{ kind: string; namespace: string; name: string }>
): string {
    const executedTools = new Set(state.toolHistory.map(t => t.tool));
    const failedTools = new Set(
        state.toolHistory.filter(t => t.status === 'error').map(t => `${t.tool}:${t.args}`)
    );

    const lines: string[] = ['=== TOOL GUIDANCE ==='];

    // Show discovered resources that can be used in tool calls
    if (discoveredResources.length > 0) {
        lines.push('\n**Discovered Resources (use these in tool calls):**');
        const byKind = new Map<string, string[]>();
        for (const r of discoveredResources.slice(0, 20)) {
            const list = byKind.get(r.kind) || [];
            list.push(`${r.namespace}/${r.name}`);
            byKind.set(r.kind, list);
        }
        for (const [kind, names] of byKind) {
            lines.push(`- ${kind}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` (+${names.length - 5} more)` : ''}`);
        }
    }

    // Show recommended next tools
    const lastResult = state.toolHistory.length > 0
        ? state.toolHistory[state.toolHistory.length - 1].result
        : '';
    const recommendations = getNextToolRecommendations(state, lastResult);

    if (recommendations.length > 0) {
        lines.push('\n**Recommended Next Tools:**');
        for (const tool of recommendations) {
            const meta = TOOL_CATALOG.find(t => t.name === tool);
            if (meta) {
                lines.push(`→ ${tool}: ${meta.description}`);
            } else {
                lines.push(`→ ${tool}`);
            }
        }
    }

    // Show failed attempts to avoid
    if (failedTools.size > 0) {
        lines.push('\n**Avoid (already failed):**');
        for (const sig of Array.from(failedTools).slice(0, 5)) {
            lines.push(`[X] ${sig}`);
        }
    }

    lines.push('=== END GUIDANCE ===');
    return lines.join('\n');
}
