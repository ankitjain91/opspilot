#!/usr/bin/env python3
"""
Test script for confidence-based plan enforcement.

This tests that low confidence triggers plan creation.
"""

import sys
import json

# Mock parse_supervisor_response output
test_cases = [
    {
        "name": "High confidence, delegate",
        "result": {
            "thought": "This is simple",
            "plan": "List namespaces",
            "next_action": "delegate",
            "confidence": 0.9
        },
        "expected_override": False
    },
    {
        "name": "Low confidence, delegate",
        "result": {
            "thought": "Uncertain about this",
            "plan": "Find customercluster CRD",
            "next_action": "delegate",
            "confidence": 0.5
        },
        "query": "find which customerclusters are in failed state and why",
        "expected_override": True
    },
    {
        "name": "Low confidence, batch_delegate",
        "result": {
            "thought": "Need to check multiple things",
            "plan": "Parallel checks",
            "next_action": "batch_delegate",
            "confidence": 0.6
        },
        "query": "why are pods failing",
        "expected_override": True
    },
    {
        "name": "Low confidence, already create_plan",
        "result": {
            "thought": "This needs investigation",
            "plan": "Multi-step analysis",
            "next_action": "create_plan",
            "confidence": 0.4,
            "execution_steps": ["step1", "step2"]
        },
        "expected_override": False  # Already creating plan
    },
]

def test_enforcement_logic(result, query="test query"):
    """Test the confidence enforcement logic."""
    confidence = result.get('confidence', 1.0)
    next_action = result['next_action']

    print(f"  Initial: action={next_action}, confidence={confidence:.2f}")

    # Apply enforcement logic
    if confidence < 0.7 and next_action in ['delegate', 'batch_delegate']:
        query_lower = query.lower()
        print(f"  ⚠️ Low confidence ({confidence:.2f}) detected - forcing plan creation")

        # Generate default steps
        default_steps = []

        if any(word in query_lower for word in ['why', 'troubleshoot', 'debug', 'investigate', 'root cause']):
            if 'failed' in query_lower or 'failing' in query_lower or 'error' in query_lower:
                default_steps = [
                    "Identify the resource type and list all instances",
                    "Filter to resources in failed/error/unhealthy state",
                    "Check status.conditions or status.message for detailed error information",
                    "If needed, check recent events to understand what triggered the failure",
                    "If status doesn't show root cause, check logs from the failing resource",
                    "Summarize findings with specific error details and root cause"
                ]
        elif 'find' in query_lower or 'which' in query_lower:
            default_steps = [
                "Identify the resource type to search for",
                "List all instances of the resource",
                "Filter based on the query criteria (state, status, labels, etc.)",
                "Present filtered results with relevant details"
            ]

        if default_steps:
            result['next_action'] = 'create_plan'
            result['execution_steps'] = default_steps
            next_action = 'create_plan'
            print(f"  ✅ Override applied: action={next_action}, steps={len(default_steps)}")
            return True
        else:
            print(f"  ⚠️ No default steps generated for query: {query}")
            return False

    print(f"  ℹ️ No override needed")
    return False

print("=" * 80)
print("TESTING CONFIDENCE-BASED PLAN ENFORCEMENT")
print("=" * 80)

passed = 0
failed = 0

for test in test_cases:
    print(f"\nTest: {test['name']}")
    print(f"Query: {test.get('query', 'test query')}")

    result = test['result'].copy()
    query = test.get('query', 'test query')

    was_overridden = test_enforcement_logic(result, query)
    expected = test['expected_override']

    if was_overridden == expected:
        print(f"  ✅ PASS (override={was_overridden})")
        passed += 1
    else:
        print(f"  ❌ FAIL (expected override={expected}, got={was_overridden})")
        failed += 1

print("\n" + "=" * 80)
print(f"RESULTS: {passed} passed, {failed} failed")
print("=" * 80)

sys.exit(0 if failed == 0 else 1)
