import { describe, it, expect } from 'vitest';
import {
  extractCommandsFromResponse,
  checkConfidence,
  classifyRequest,
  extractSuggestions,
  extractLearningMetadata,
} from './agentUtils';

describe('extractCommandsFromResponse', () => {
  describe('TOOL: format', () => {
    it('should extract TOOL: RUN_KUBECTL commands', () => {
      const response = `Let me check the pods.
TOOL: RUN_KUBECTL get pods -A`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toEqual([{ tool: 'RUN_KUBECTL', args: 'get pods -A' }]);
    });

    it('should extract TOOL: SEARCH_KNOWLEDGE commands', () => {
      const response = `TOOL: SEARCH_KNOWLEDGE crashloop oom killed`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toEqual([{ tool: 'SEARCH_KNOWLEDGE', args: 'crashloop oom killed' }]);
    });

    it('should extract multiple TOOL commands', () => {
      const response = `TOOL: LIST_ALL Pod
TOOL: GET_EVENTS kube-system`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toHaveLength(2);
      expect(commands[0]).toEqual({ tool: 'LIST_ALL', args: 'Pod' });
      expect(commands[1]).toEqual({ tool: 'GET_EVENTS', args: 'kube-system' });
    });
  });

  describe('$ kubectl format', () => {
    it('should extract $ kubectl commands at line start', () => {
      const response = `I'll check the pods for you.

$ kubectl get pods -A

This will show all pods.`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toEqual([{ tool: 'RUN_KUBECTL', args: 'get pods -A' }]);
    });

    it('should extract $ kubectl with complex arguments', () => {
      const response = `$ kubectl logs -n upbound-system -l app=crossplane --tail=100`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toEqual([{ tool: 'RUN_KUBECTL', args: 'logs -n upbound-system -l app=crossplane --tail=100' }]);
    });

    it('should extract $ kubectl with grep pipe', () => {
      const response = `$ kubectl get pods -A | grep -v Running`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toEqual([{ tool: 'RUN_KUBECTL', args: 'get pods -A | grep -v Running' }]);
    });
  });

  describe('backtick format', () => {
    it('should extract `kubectl ...` inline commands', () => {
      const response = `You can check using \`kubectl get pods -A\` command.`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toEqual([{ tool: 'RUN_KUBECTL', args: 'get pods -A' }]);
    });

    it('should extract multiple inline commands', () => {
      const response = `Run \`kubectl get pods -A\` and then \`kubectl get nodes\``;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toHaveLength(2);
    });
  });

  describe('bare kubectl format', () => {
    it('should extract kubectl at line start without $', () => {
      const response = `kubectl get pods -A`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toEqual([{ tool: 'RUN_KUBECTL', args: 'get pods -A' }]);
    });

    it('should extract kubectl describe', () => {
      const response = `kubectl describe pod my-pod -n default`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toEqual([{ tool: 'RUN_KUBECTL', args: 'describe pod my-pod -n default' }]);
    });

    it('should extract kubectl logs', () => {
      const response = `kubectl logs my-pod -n kube-system --tail=50`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toEqual([{ tool: 'RUN_KUBECTL', args: 'logs my-pod -n kube-system --tail=50' }]);
    });
  });

  describe('deduplication', () => {
    it('should not duplicate same command in different formats', () => {
      const response = `$ kubectl get pods -A
Also try \`kubectl get pods -A\``;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toHaveLength(1);
    });
  });

  describe('no commands', () => {
    it('should return empty array for casual response', () => {
      const response = `Hello! How can I help you today?`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toEqual([]);
    });

    it('should return empty array for knowledge answer', () => {
      const response = `A StatefulSet is a Kubernetes workload API object used to manage stateful applications.`;
      const commands = extractCommandsFromResponse(response);
      expect(commands).toEqual([]);
    });
  });
});

describe('checkConfidence', () => {
  it('should detect HIGH confidence', () => {
    const response = `**Confidence**: HIGH
I found 5 pods running.`;
    expect(checkConfidence(response)).toBe('HIGH');
  });

  it('should detect MEDIUM confidence', () => {
    const response = `**Confidence**: MEDIUM - need more investigation`;
    expect(checkConfidence(response)).toBe('MEDIUM');
  });

  it('should detect LOW confidence', () => {
    const response = `**Confidence**: LOW
Not sure about this.`;
    expect(checkConfidence(response)).toBe('LOW');
  });

  it('should return UNKNOWN for no confidence marker', () => {
    const response = `There are 5 pods running.`;
    expect(checkConfidence(response)).toBe('UNKNOWN');
  });

  it('should detect implicit HIGH confidence', () => {
    const response = `I have HIGH confidence that there are 5 pods.`;
    expect(checkConfidence(response)).toBe('HIGH');
  });
});

describe('classifyRequest', () => {
  describe('action requests', () => {
    it('should classify "Get logs" as action', () => {
      expect(classifyRequest('Get crossplane controller logs')).toBe('action');
    });

    it('should classify "Show me pods" as action', () => {
      expect(classifyRequest('Show me all pods')).toBe('action');
    });

    it('should classify "Check events" as action', () => {
      expect(classifyRequest('Check recent events')).toBe('action');
    });

    it('should classify "List deployments" as action', () => {
      expect(classifyRequest('List all deployments')).toBe('action');
    });

    it('should classify "Fetch secrets" as action', () => {
      expect(classifyRequest('Fetch secrets in kube-system')).toBe('action');
    });

    it('should classify "Find failing pods" as action', () => {
      expect(classifyRequest('Find failing pods')).toBe('action');
    });

    it('should classify "Describe the pod" as action', () => {
      expect(classifyRequest('Describe the coredns pod')).toBe('action');
    });
  });

  describe('casual requests', () => {
    it('should classify "hi" as casual', () => {
      expect(classifyRequest('hi')).toBe('casual');
    });

    it('should classify "Hey!" as casual', () => {
      expect(classifyRequest('Hey!')).toBe('casual');
    });

    it('should classify "thanks" as casual', () => {
      expect(classifyRequest('thanks')).toBe('casual');
    });

    it('should classify "ok" as casual', () => {
      expect(classifyRequest('ok')).toBe('casual');
    });

    it('should classify "cool" as casual', () => {
      expect(classifyRequest('cool')).toBe('casual');
    });

    it('should classify "Good morning" as casual', () => {
      expect(classifyRequest('Good morning')).toBe('casual');
    });
  });

  describe('knowledge requests', () => {
    it('should classify "What is a StatefulSet?" as knowledge', () => {
      expect(classifyRequest('What is a StatefulSet?')).toBe('knowledge');
    });

    it('should classify "How does service discovery work?" as knowledge', () => {
      expect(classifyRequest('How does service discovery work?')).toBe('knowledge');
    });

    it('should classify "Explain init containers" as knowledge', () => {
      expect(classifyRequest('Explain init containers')).toBe('knowledge');
    });
  });

  describe('troubleshooting requests', () => {
    it('should classify "Why is my pod failing?" as troubleshooting', () => {
      expect(classifyRequest('Why is my pod failing?')).toBe('troubleshooting');
    });

    it('should classify "What\'s wrong with the deployment?" as troubleshooting', () => {
      expect(classifyRequest("What's wrong with the deployment?")).toBe('troubleshooting');
    });

    it('should classify "Pod keeps crashing" as troubleshooting', () => {
      expect(classifyRequest('Pod keeps crashing')).toBe('troubleshooting');
    });

    it('should classify "Debug the service" as troubleshooting', () => {
      expect(classifyRequest('Debug the service')).toBe('troubleshooting');
    });
  });

  describe('query requests', () => {
    it('should classify "How many pods are running?" as query', () => {
      expect(classifyRequest('How many pods are running?')).toBe('query');
    });

    it('should classify "Is there a coredns pod?" as query', () => {
      expect(classifyRequest('Is there a coredns pod?')).toBe('query');
    });

    it('should classify "Do we have any failed deployments?" as query', () => {
      expect(classifyRequest('Do we have any failed deployments?')).toBe('query');
    });
  });
});

describe('extractSuggestions', () => {
  it('should extract suggestions from response', () => {
    const response = `There are 5 pods running.

<suggestions>["Check pod logs", "View events", "Describe pod"]</suggestions>`;
    const { cleanedResponse, suggestions } = extractSuggestions(response);
    expect(suggestions).toEqual(['Check pod logs', 'View events', 'Describe pod']);
    expect(cleanedResponse).toBe('There are 5 pods running.');
  });

  it('should handle response without suggestions', () => {
    const response = `There are 5 pods running.`;
    const { cleanedResponse, suggestions } = extractSuggestions(response);
    expect(suggestions).toEqual([]);
    expect(cleanedResponse).toBe('There are 5 pods running.');
  });

  it('should handle malformed suggestions gracefully', () => {
    const response = `Answer here.
<suggestions>not valid json</suggestions>`;
    const { cleanedResponse, suggestions } = extractSuggestions(response);
    expect(suggestions).toEqual([]);
  });
});

describe('extractLearningMetadata', () => {
  it('should extract HIGH confidence and root cause', () => {
    const response = `Based on the evidence, the pod is OOMKilled.

**Confidence**: HIGH
**Root Cause**: Memory limit exceeded (OOM)

<suggestions>["Fix memory limit"]</suggestions>`;

    const { level, score, rootCause, hypotheses } = extractLearningMetadata(response);

    expect(level).toBe('HIGH');
    expect(score).toBe(90);
    expect(rootCause).toBe('Memory limit exceeded (OOM)');
    expect(hypotheses).toHaveLength(1);
    expect(hypotheses[0].description).toBe('Memory limit exceeded (OOM)');
    expect(hypotheses[0].status).toBe('confirmed');
  });

  it('should extract MEDIUM confidence', () => {
    const response = `**Confidence**: MEDIUM`;
    const { level, score } = extractLearningMetadata(response);
    expect(level).toBe('MEDIUM');
    expect(score).toBe(60);
  });

  it('should extract LOW confidence', () => {
    const response = `**Confidence**: LOW`;
    const { level, score } = extractLearningMetadata(response);
    expect(level).toBe('LOW');
    expect(score).toBe(30);
  });

  it('should handle missing metadata', () => {
    const response = `Just a normal response without metadata.`;
    const { level, score, rootCause, hypotheses } = extractLearningMetadata(response);

    expect(level).toBe('UNKNOWN');
    expect(score).toBe(0);
    expect(rootCause).toBeNull();
    expect(hypotheses).toHaveLength(0);
  });

  it('should be case insensitive', () => {
    const response = `**confidence**: high
**root cause**: something bad happen`;

    const { level, score, rootCause } = extractLearningMetadata(response);
    expect(level).toBe('HIGH');
    expect(score).toBe(90);
    expect(rootCause).toBe('something bad happen');
  });
});
