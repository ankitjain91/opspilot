# OpsPilot End-to-End Regression Test Suite

Comprehensive regression tests to catch issues before they reach production.

## Test Coverage

### 📊 Test Categories

1. **Simple (5 tests)** - Basic K8s queries
   - List pods, nodes, deployments, services
   - Count resources, list namespaces

2. **Medium (5 tests)** - Intermediate complexity
   - CRD discovery
   - Namespace-specific queries
   - Service endpoints, storage classes, ConfigMaps

3. **Complex (5 tests)** - Deep investigation
   - Find crashlooping pods
   - Investigate failing pods
   - Resource bottlenecks and node pressure
   - Unhealthy deployment analysis
   - Network policy debugging

4. **CNCF (6 tests)** - Cloud Native components
   - **ArgoCD**: List applications, sync status
   - **Crossplane**: Providers, managed resources
   - **cert-manager**: Certificates, issuers

5. **vcluster (3 tests)** - Virtual cluster operations
   - Discovery, health checks, resource queries

6. **Azure (3 tests)** - Azure-specific queries
   - Load balancer config, node pools, storage

**Total: 27 test cases**

## Running Tests

### Prerequisites

1. **Start agent server:**
   ```bash
   cd python
   dist/agent-server &
   ```

2. **Ensure remote LLM is accessible:**
   ```bash
   curl http://20.56.146.53:11434/api/tags
   ```

3. **Set correct kubectl context:**
   ```bash
   kubectl config use-context dedicated-aks-dev-eastus-ankitj
   ```

### Run Full Test Suite

```bash
cd python/tests
python3 test_e2e_regression.py
```

### Run with Virtual Environment

```bash
cd python
source venv/bin/activate
python tests/test_e2e_regression.py
```

## Test Output

The suite provides detailed output:

```
================================================================================
🧪 OpsPilot E2E Regression Test Suite
================================================================================
Remote LLM: http://20.56.146.53:11434
Agent Server: http://localhost:8765
Context: dedicated-aks-dev-eastus-ankitj
Total Tests: 27
================================================================================

1️⃣ Checking remote LLM connectivity...
✅ Remote LLM accessible - 15 models available

2️⃣ Checking agent server connectivity...

3️⃣ Running tests...

================================================================================
Test: List all pods
Category: simple
Query: 'show me all pods'
================================================================================

✅ RESPONSE (245 chars):
Your cluster has 156 pods running across multiple namespaces...

✅ PASS - PASSED

[... more tests ...]

================================================================================
📊 TEST RESULTS SUMMARY
================================================================================

✅ SIMPLE: 5/5 passed (100.0%)

✅ MEDIUM: 5/5 passed (100.0%)

⚠️  COMPLEX: 4/5 passed (80.0%)
   ❌ Network policy issues: Missing keywords: ['network']

✅ CNCF: 6/6 passed (100.0%)

✅ VCLUSTER: 3/3 passed (100.0%)

✅ AZURE: 3/3 passed (100.0%)

================================================================================
OVERALL: 26/27 passed (96.3%)
================================================================================

⚠️  1 test(s) failed
```

## Exit Codes

- `0`: All tests passed
- `1`: One or more tests failed

## Adding New Tests

Add to the `TEST_CASES` list in `test_e2e_regression.py`:

```python
TestCase(
    name="Your test name",
    query="your query to the agent",
    category="simple|medium|complex|cncf|vcluster|azure",
    expected_keywords=["keyword1", "keyword2"],
    should_not_contain=["error", "failed"],  # Optional
    min_response_length=50,  # Optional, default 50
    timeout=120,  # Optional, default 120s
),
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: E2E Regression Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Start agent server
        run: |
          cd python
          dist/agent-server &
          sleep 5
      - name: Run E2E tests
        run: python python/tests/test_e2e_regression.py
```

### Pre-commit Hook

```bash
#!/bin/bash
# .git/hooks/pre-commit
cd python/tests
python3 test_e2e_regression.py
exit $?
```

## Test Philosophy

- **User-facing queries**: Tests use natural language like real users
- **Keyword validation**: Checks for presence of expected terms, not exact matches
- **Negative testing**: Ensures error messages don't appear in successful queries
- **Length validation**: Prevents empty or incomplete responses
- **Timeout handling**: Long-running investigations have extended timeouts
- **Category organization**: Easy to run specific test subsets

## Troubleshooting

### Test hangs or times out

```bash
# Check agent server is running
curl http://localhost:8765/

# Check remote LLM is accessible
curl http://20.56.146.53:11434/api/tags

# Check kubectl context
kubectl config current-context
```

### Tests fail with "context not found"

Update `TEST_CONTEXT` in `test_e2e_regression.py`:

```python
TEST_CONTEXT = "your-cluster-context-name"
```

### Remote LLM unreachable

Update `REMOTE_ENDPOINT` to point to your LLM:

```python
REMOTE_ENDPOINT = "http://your-llm-host:11434"
```
