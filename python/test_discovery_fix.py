"""
Test that discovery_strategies correctly extracts short names from CRDs
"""
from agent_server.discovery_strategies import get_progressive_discovery_strategies

def test_crd_short_name_extraction():
    """Test that eventhubs.azure.upbound.io -> eventhubs in kubectl commands"""

    # Test with full CRD name
    strategies = get_progressive_discovery_strategies("eventhubs.azure.upbound.io", "find eventhubs")

    # Check first strategy (direct_get)
    first_strategy = strategies[0]
    print(f"\n✅ First strategy: {first_strategy.name}")
    print(f"   Commands: {first_strategy.commands}")

    # Verify it uses short name "eventhubs" not full CRD
    assert "eventhubs.azure.upbound.io" not in first_strategy.commands[0], \
        f"❌ FAIL: Still using full CRD name in command: {first_strategy.commands[0]}"

    assert "kubectl get eventhubs -A" in first_strategy.commands[0], \
        f"❌ FAIL: Expected 'kubectl get eventhubs -A', got: {first_strategy.commands[0]}"

    print(f"\n✅ SUCCESS: Using correct short name 'eventhubs' in kubectl command!")
    print(f"   Command: {first_strategy.commands[0]}")

    # Check that other strategies also use short name
    for i, strat in enumerate(strategies[:3]):
        for cmd in strat.commands:
            if "eventhubs.azure.upbound.io" in cmd:
                print(f"❌ Strategy {i} ({strat.name}) still has full CRD: {cmd}")
                return False

    print(f"\n✅ All strategies using short name correctly!")
    return True

if __name__ == "__main__":
    success = test_crd_short_name_extraction()
    exit(0 if success else 1)
