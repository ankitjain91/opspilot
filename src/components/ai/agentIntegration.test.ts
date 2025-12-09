import { describe, it, expect } from 'vitest';
import {
  extractCommandsFromResponse,
  checkConfidence,
  classifyRequest,
} from './agentUtils';

/**
 * Integration tests for AI Agent behavior
 *
 * These tests simulate realistic LLM responses and verify the agent
 * correctly extracts commands and handles various scenarios.
 *
 * Use these tests to tune prompts - if a test fails, update the prompt
 * or the extraction logic to fix it.
 */

describe('Agent Integration: Action Request Scenarios', () => {
  describe('Get Crossplane controller logs', () => {
    const userMessage = 'Get Crossplane controller logs';

    it('should classify as action request', () => {
      expect(classifyRequest(userMessage)).toBe('action');
    });

    it('should extract command from good LLM response', () => {
      // This is what a GOOD LLM response looks like - immediate command
      const goodResponse = `$ kubectl logs -n upbound-system -l app=crossplane --tail=100`;
      const commands = extractCommandsFromResponse(goodResponse);
      expect(commands).toHaveLength(1);
      expect(commands[0].tool).toBe('RUN_KUBECTL');
      expect(commands[0].args).toContain('logs');
    });

    it('should extract command even with explanation prefix', () => {
      // LLM might add a brief note before the command
      const responseWithPrefix = `I'll get the Crossplane controller logs for you.

$ kubectl logs -n upbound-system -l app=crossplane --tail=100`;
      const commands = extractCommandsFromResponse(responseWithPrefix);
      expect(commands).toHaveLength(1);
      expect(commands[0].args).toContain('logs');
    });

    it('should extract command from TOOL format', () => {
      const toolResponse = `TOOL: RUN_KUBECTL logs -n upbound-system -l app=crossplane --tail=100`;
      const commands = extractCommandsFromResponse(toolResponse);
      expect(commands).toHaveLength(1);
      expect(commands[0].tool).toBe('RUN_KUBECTL');
    });

    it('should extract command from backtick format', () => {
      const backtickResponse = `Running \`kubectl logs -n upbound-system deployment/crossplane --tail=100\``;
      const commands = extractCommandsFromResponse(backtickResponse);
      expect(commands).toHaveLength(1);
    });

    it('should NOT extract command from bad response (just describes)', () => {
      // This is a BAD response - agent should NOT return this without a command
      const badResponse = `The Crossplane controller pod is upbound-system/crossplane-rbac-manager-779f5dbd5c-2r68w with 15 restarts.

However, since you specifically asked for "Get Crossplane controller manager logs", I'll provide some follow-up suggestions:

Let me know if you'd like to proceed!`;
      const commands = extractCommandsFromResponse(badResponse);
      expect(commands).toHaveLength(0);
      // This is a problem! If no commands extracted, agent will just return this text
      // The LLM should have output a command instead
    });

    it('should extract command from markdown code block', () => {
      const markdownResponse = `Here are the logs:

\`\`\`bash
$ kubectl logs -n upbound-system -l app=crossplane --tail=50
\`\`\``;
      const commands = extractCommandsFromResponse(markdownResponse);
      expect(commands.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Show failing pods', () => {
    const userMessage = 'Show me failing pods';

    it('should classify as action request', () => {
      expect(classifyRequest(userMessage)).toBe('action');
    });

    it('should extract correct command', () => {
      const response = `$ kubectl get pods -A --field-selector=status.phase!=Running`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toHaveLength(1);
      expect(commands[0].args).toContain('pods');
    });

    it('should extract grep-based command', () => {
      const response = `$ kubectl get pods -A | grep -v Running`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toHaveLength(1);
      expect(commands[0].args).toContain('grep');
    });
  });

  describe('Check recent events', () => {
    const userMessage = 'Check recent events';

    it('should classify as action request', () => {
      expect(classifyRequest(userMessage)).toBe('action');
    });

    it('should extract events command', () => {
      const response = `$ kubectl get events -A --sort-by=.lastTimestamp | tail -50`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toHaveLength(1);
      expect(commands[0].args).toContain('events');
    });
  });

  describe('List all deployments', () => {
    it('should extract list command', () => {
      const response = `$ kubectl get deployments -A`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toHaveLength(1);
      expect(commands[0].args).toBe('get deployments -A');
    });
  });
});

describe('Agent Integration: CRD vs CR Scenarios', () => {
  describe('How many consumergroups exist?', () => {
    it('should classify as query (not action)', () => {
      expect(classifyRequest('How many consumergroups exist?')).toBe('query');
    });

    it('should extract CRD search command first', () => {
      // Step 1: LLM should search for CRDs
      const step1Response = `$ kubectl get crds | grep -i consumergroup`;
      const commands = extractCommandsFromResponse(step1Response);
      expect(commands).toHaveLength(1);
      expect(commands[0].args).toContain('crds');
    });

    it('should extract CR listing command after finding CRD', () => {
      // Step 2: After finding CRD, LLM should list actual CRs
      const step2Response = `Found the CRD. Now listing actual instances:

$ kubectl get consumergroups -A`;
      const commands = extractCommandsFromResponse(step2Response);
      expect(commands).toHaveLength(1);
      expect(commands[0].args).toBe('get consumergroups -A');
    });

    it('should detect HIGH confidence when CRs are listed', () => {
      const finalResponse = `**Confidence**: HIGH

Found 3 ConsumerGroup resources:
- ns1/cg1
- ns1/cg2
- ns2/cg3`;
      expect(checkConfidence(finalResponse)).toBe('HIGH');
    });

    it('should detect MEDIUM confidence when only CRD found', () => {
      // This is wrong behavior - agent found CRD but didn't list CRs
      const wrongResponse = `**Confidence**: MEDIUM - Found CRD but haven't listed actual resources

Found CRD: consumergroups.eventhub.azure.upbound.io

$ kubectl get consumergroups -A`;
      expect(checkConfidence(wrongResponse)).toBe('MEDIUM');
      // Should also have command to run
      const commands = extractCommandsFromResponse(wrongResponse);
      expect(commands.length).toBeGreaterThan(0);
    });
  });
});

describe('Agent Integration: Troubleshooting Scenarios', () => {
  describe('Why is my pod crashing?', () => {
    it('should classify as troubleshooting', () => {
      expect(classifyRequest('Why is my pod crashing?')).toBe('troubleshooting');
    });

    it('should extract KB search first', () => {
      const response = `TOOL: SEARCH_KNOWLEDGE pod crashloop causes`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toHaveLength(1);
      expect(commands[0].tool).toBe('SEARCH_KNOWLEDGE');
    });

    it('should extract multiple diagnostic commands', () => {
      const response = `Let me investigate:

$ kubectl get pods -A | grep -i crash
TOOL: GET_EVENTS default`;
      const commands = extractCommandsFromResponse(response);
      expect(commands.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Crossplane resources failing to sync', () => {
    it('should classify as troubleshooting', () => {
      expect(classifyRequest('What crossplane resources are failing to sync?')).toBe('troubleshooting');
    });

    it('should extract managed resources command', () => {
      const response = `$ kubectl get managed | grep -i false`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toHaveLength(1);
      expect(commands[0].args).toContain('managed');
    });

    it('should use TOOL format for platform-specific check', () => {
      const response = `TOOL: GET_CROSSPLANE`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toHaveLength(1);
      expect(commands[0].tool).toBe('GET_CROSSPLANE');
    });
  });
});

describe('Agent Integration: Casual Chat Scenarios', () => {
  const casualMessages = [
    'hi',
    'hey',
    'hello',
    'thanks',
    'thank you',
    'ok',
    'okay',
    'cool',
    'great',
    'got it',
    'Good morning',
  ];

  casualMessages.forEach(msg => {
    it(`should classify "${msg}" as casual`, () => {
      expect(classifyRequest(msg)).toBe('casual');
    });
  });

  it('should NOT extract commands from casual response', () => {
    const casualResponse = `Hey there! 👋 Why do Kubernetes pods make terrible comedians? Their jokes keep crashing!

What can I help you investigate in your cluster today?`;
    const commands = extractCommandsFromResponse(casualResponse);
    expect(commands).toHaveLength(0);
  });
});

describe('Agent Integration: Knowledge Question Scenarios', () => {
  describe('What is a StatefulSet?', () => {
    it('should classify as knowledge', () => {
      expect(classifyRequest('What is a StatefulSet?')).toBe('knowledge');
    });

    it('should NOT extract commands from knowledge answer', () => {
      const knowledgeResponse = `A StatefulSet is a Kubernetes workload API object used to manage stateful applications. Unlike a Deployment, a StatefulSet maintains a sticky identity for each pod. Key features include:

- Stable, unique network identifiers
- Stable, persistent storage
- Ordered, graceful deployment and scaling
- Ordered, automated rolling updates`;
      const commands = extractCommandsFromResponse(knowledgeResponse);
      expect(commands).toHaveLength(0);
    });
  });
});

describe('Agent Integration: Multi-command Extraction', () => {
  it('should extract multiple $ commands', () => {
    const response = `Let me check several things:

$ kubectl get pods -A
$ kubectl get nodes
$ kubectl top pods -A`;
    const commands = extractCommandsFromResponse(response);
    expect(commands).toHaveLength(3);
  });

  it('should extract mixed TOOL and $ commands', () => {
    const response = `First, let me search the knowledge base:
TOOL: SEARCH_KNOWLEDGE node not ready

Then check the nodes:
$ kubectl get nodes -o wide

And events:
TOOL: GET_EVENTS kube-system`;
    const commands = extractCommandsFromResponse(response);
    expect(commands).toHaveLength(3);
    expect(commands.find(c => c.tool === 'SEARCH_KNOWLEDGE')).toBeDefined();
    expect(commands.find(c => c.tool === 'RUN_KUBECTL')).toBeDefined();
    expect(commands.find(c => c.tool === 'GET_EVENTS')).toBeDefined();
  });

  it('should deduplicate repeated commands', () => {
    const response = `$ kubectl get pods -A
Check pods: \`kubectl get pods -A\`
kubectl get pods -A`;
    const commands = extractCommandsFromResponse(response);
    // Should be deduplicated to 1
    expect(commands).toHaveLength(1);
  });
});

describe('Agent Integration: Edge Cases', () => {
  it('should handle empty response', () => {
    expect(extractCommandsFromResponse('')).toEqual([]);
  });

  it('should handle response with only whitespace', () => {
    expect(extractCommandsFromResponse('   \n\n   ')).toEqual([]);
  });

  it('should handle response mentioning kubectl but not as a command', () => {
    const response = `The kubectl command is used to interact with Kubernetes clusters. You can use it to get pods, services, and other resources.`;
    const commands = extractCommandsFromResponse(response);
    // Should NOT extract "kubectl command" as a command to run
    expect(commands).toHaveLength(0);
  });

  it('should extract complex kubectl with jsonpath', () => {
    const response = `$ kubectl get secret my-secret -n default -o jsonpath='{.data.password}'`;
    const commands = extractCommandsFromResponse(response);
    expect(commands).toHaveLength(1);
    expect(commands[0].args).toContain('jsonpath');
  });

  it('should extract kubectl with multiple flags', () => {
    const response = `$ kubectl get pods -A -o wide --show-labels -l app=nginx`;
    const commands = extractCommandsFromResponse(response);
    expect(commands).toHaveLength(1);
    expect(commands[0].args).toContain('--show-labels');
  });
});

describe('Agent Integration: Confidence-based Decision Making', () => {
  it('should detect UNKNOWN confidence when not specified', () => {
    const response = `There are 5 pods running in the cluster.`;
    expect(checkConfidence(response)).toBe('UNKNOWN');
  });

  it('should detect LOW confidence', () => {
    const response = `**Confidence**: LOW - I haven't verified this

I think there might be some pods, but I need to check.`;
    expect(checkConfidence(response)).toBe('LOW');
  });

  it('should detect implicit HIGH confidence', () => {
    const response = `I have HIGH confidence in this answer based on the data.`;
    expect(checkConfidence(response)).toBe('HIGH');
  });

  it('should prioritize explicit confidence over implicit', () => {
    const response = `**Confidence**: MEDIUM
But I feel HIGH confidence about this.`;
    expect(checkConfidence(response)).toBe('MEDIUM');
  });
});

describe('Agent Integration: vCluster Detection', () => {
  describe('Is this a vcluster?', () => {
    it('should extract context check command', () => {
      const response = `Let me check if this is a vcluster:

$ kubectl config current-context`;
      const commands = extractCommandsFromResponse(response);
      expect(commands.length).toBeGreaterThanOrEqual(1);
      expect(commands[0].args).toContain('config current-context');
    });

    it('should extract node inspection for vcluster indicators', () => {
      const response = `$ kubectl get nodes -o yaml | grep -i vcluster`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toHaveLength(1);
    });

    it('should NOT conclude "not a vcluster" from missing CRD', () => {
      // This is a BAD conclusion - missing CRD doesn't mean not inside vcluster
      const badResponse = `**Confidence**: HIGH

This is not a vCluster because the vcluster resource type doesn't exist.`;
      // The confidence shouldn't be HIGH for this wrong conclusion
      // Agent should have checked context/nodes instead
    });
  });
});
