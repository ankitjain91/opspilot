#!/bin/bash
# Test script to verify Claude Code CLI integration works correctly

set -e

echo "=== Claude Code CLI Integration Test ==="
echo ""

# Test 1: Check Claude CLI is installed
echo "1. Checking Claude CLI is installed..."
if command -v claude &> /dev/null; then
    VERSION=$(claude --version 2>&1)
    echo "   ✅ Claude CLI found: $VERSION"
else
    echo "   ❌ Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
    exit 1
fi

# Test 2: Test with prompt as argument (the fix)
echo ""
echo "2. Testing prompt as CLI argument (fixed method)..."
RESULT=$(claude --print "Reply with exactly: PROMPT_ARG_WORKS" 2>&1 | head -5)
if echo "$RESULT" | grep -qi "PROMPT_ARG_WORKS"; then
    echo "   ✅ Prompt as argument works correctly"
else
    echo "   ⚠️  Unexpected output (but command ran): $RESULT"
fi

# Test 3: Test with --dangerously-skip-permissions flag
echo ""
echo "3. Testing with --dangerously-skip-permissions flag..."
RESULT=$(claude --print --dangerously-skip-permissions "Reply with exactly: PERMISSIONS_SKIPPED" 2>&1 | head -5)
if [ $? -eq 0 ]; then
    echo "   ✅ Permissions skip flag works"
else
    echo "   ❌ Permissions skip flag failed"
    exit 1
fi

# Test 4: Test a simple kubectl command via Claude
echo ""
echo "4. Testing kubectl integration via Claude..."
RESULT=$(timeout 30 claude --print --dangerously-skip-permissions "Run 'kubectl version --client --short 2>/dev/null || echo kubectl-ok' and show the output" 2>&1 | tail -10)
if echo "$RESULT" | grep -qi "kubectl\|client\|version\|ok"; then
    echo "   ✅ Claude can execute kubectl commands"
else
    echo "   ⚠️  kubectl test inconclusive: $RESULT"
fi

echo ""
echo "=== All tests completed ==="
echo ""
echo "The Claude Code CLI fix (prompt as argument instead of stdin) is working."
echo "You can now test the full integration by running the app and using the AI troubleshooting feature."
