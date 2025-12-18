"""
ITERATIVE TEST-DRIVEN FIXING

Strategy:
1. Run test N
2. If FAIL → STOP, analyze, fix prompts/code
3. Re-run tests 1 through N to check regression
4. Only proceed to test N+1 when all previous pass

This ensures no regressions and forces fixing root causes.
"""

import asyncio
import httpx
import json
import time
import sys
from typing import List, Optional
from dataclasses import dataclass

# Import test cases from exhaustive suite
sys.path.insert(0, '/Users/ankitjain/lens-killer/python')
from tests.test_e2e_exhaustive import ExhaustiveE2ETester, TestCase, TestResult

AGENT_SERVER_URL = "http://localhost:8766"
LLM_HOST = "http://20.56.146.53:11434"
BRAIN_MODEL = "opspilot-brain:latest"
EXECUTOR_MODEL = "qwen2.5:72b"
KUBE_CONTEXT = "vcluster_management-cluster_taasvstst_dedicated-aks-dev-eastus-ankitj"


class IterativeTestRunner:
    """Run tests one by one, stop on failure, force fix before proceeding."""

    def __init__(self):
        self.tester = ExhaustiveE2ETester()
        self.passed_tests: List[TestResult] = []
        self.current_test_index = 0

    async def initialize(self):
        """Initialize and get test cases."""
        await self.tester.initialize()
        print(f"📋 Loaded {len(self.tester.test_cases)} test cases")

    async def run_single_test(self, test_case: TestCase) -> TestResult:
        """Run a single test."""
        return await self.tester.run_test(test_case)

    async def run_regression_suite(self) -> bool:
        """Re-run all previously passed tests to check for regressions."""
        if not self.passed_tests:
            return True

        print(f"\n🔄 REGRESSION CHECK: Re-running {len(self.passed_tests)} previous tests...")
        regression_failures = []

        for i, old_result in enumerate(self.passed_tests, 1):
            print(f"   [{i}/{len(self.passed_tests)}] Re-testing: {old_result.test_case.name}...", end=" ")

            # Re-run the test
            new_result = await self.tester.run_test(old_result.test_case)

            if new_result.passed:
                print("✅")
            else:
                print(f"❌ REGRESSION!")
                regression_failures.append((old_result.test_case.name, new_result.failure_reasons))

        if regression_failures:
            print(f"\n💥 REGRESSION DETECTED IN {len(regression_failures)} TESTS:")
            for name, reasons in regression_failures:
                print(f"   ❌ {name}")
                for reason in reasons:
                    print(f"      - {reason}")
            return False

        print(f"✅ All {len(self.passed_tests)} previous tests still pass")
        return True

    def analyze_failure(self, result: TestResult):
        """Analyze test failure and provide fix recommendations."""
        print("\n" + "="*80)
        print("FAILURE ANALYSIS")
        print("="*80)

        tc = result.test_case
        print(f"Test: {tc.name}")
        print(f"Category: {tc.category.value}")
        print(f"Query: {tc.query}")
        print(f"Description: {tc.description}")
        if tc.known_issue:
            print(f"Known Issue: {tc.known_issue}")

        print(f"\nExpected:")
        print(f"  Routing: {tc.expected_routing}")
        print(f"  Max Commands: {tc.max_commands}")
        print(f"  Max Time: {tc.max_time_seconds}s")

        print(f"\nActual:")
        print(f"  Routing: {result.actual_routing}")
        print(f"  Commands: {result.command_count}")
        print(f"  Time: {result.execution_time:.1f}s")
        print(f"  Answer Length: {result.answer_length} chars")

        print(f"\nFailure Reasons:")
        for reason in result.failure_reasons:
            print(f"  ❌ {reason}")

        # Diagnose root cause
        print(f"\n🔍 ROOT CAUSE DIAGNOSIS:")

        if result.exception:
            print(f"  • Exception occurred: {result.exception}")

        if not result.actual_routing and tc.expected_routing:
            print(f"  • No routing detected - supervisor may not be emitting intent events")

        if result.actual_routing and result.actual_routing != tc.expected_routing:
            print(f"  • WRONG ROUTING: Supervisor chose {result.actual_routing} instead of {tc.expected_routing}")
            print(f"  • FIX NEEDED: Update supervisor prompt to route '{tc.query}' → {tc.expected_routing}")

            if tc.expected_routing == "smart_executor" and result.actual_routing == "create_plan":
                print(f"  • SPECIFIC: Query misclassified as complex - should be simple discovery/status")
                print(f"  • FILE: /python/agent_server/prompts/supervisor/instructions.py")
                print(f"  • ACTION: Add example showing '{tc.query}' → smart_executor")

            elif tc.expected_routing == "smart_executor" and result.actual_routing == "batch_delegate":
                print(f"  • SPECIFIC: Using batch_delegate for discovery - inefficient")
                print(f"  • FILE: /python/agent_server/prompts/supervisor/instructions.py")
                print(f"  • ACTION: Strengthen smart_executor routing for discovery queries")

        if result.command_count > tc.max_commands:
            print(f"  • PERFORMANCE: Too many commands ({result.command_count} > {tc.max_commands})")
            print(f"  • FIX NEEDED: Optimize execution strategy or fix routing")

            if result.actual_routing == "create_plan":
                print(f"  • LIKELY CAUSE: Creating multi-step plan for simple query")
                print(f"  • SOLUTION: Route to smart_executor instead")

        if result.execution_time > (tc.max_time_seconds or 999):
            print(f"  • PERFORMANCE: Too slow ({result.execution_time:.1f}s > {tc.max_time_seconds}s)")

        if tc.answer_must_contain:
            missing = [term for term in tc.answer_must_contain if term.lower() not in result.answer.lower()]
            if missing:
                print(f"  • ACCURACY: Answer missing required terms: {missing}")
                print(f"  • FIX NEEDED: Improve answer extraction or routing")

        if tc.answer_must_not_contain:
            forbidden = [term for term in tc.answer_must_not_contain if term.lower() in result.answer.lower()]
            if forbidden:
                print(f"  • ACCURACY: Answer contains forbidden terms: {forbidden}")
                print(f"  • Example: Should check CRD status, not pods")

        print("\n" + "="*80)
        print("RECOMMENDED ACTIONS:")
        print("="*80)
        print("1. Analyze the root cause above")
        print("2. Fix the identified file (likely supervisor/instructions.py)")
        print("3. Restart agent server to load changes")
        print("4. Press ENTER to re-run this test + regression suite")
        print("="*80)

    async def run_iterative(self):
        """Run tests iteratively with stop-and-fix on failure."""
        print("\n" + "="*80)
        print("ITERATIVE TEST-DRIVEN FIXING")
        print("="*80)
        print(f"Total Tests: {len(self.tester.test_cases)}")
        print("Strategy: Run → Fail → Stop → Fix → Regression → Continue")
        print("="*80)

        # Separate critical and normal tests
        critical_tests = [t for t in self.tester.test_cases if t.priority == "CRITICAL"]
        normal_tests = [t for t in self.tester.test_cases if t.priority != "CRITICAL"]

        all_tests = critical_tests + normal_tests

        print(f"\n🔥 Will run {len(critical_tests)} CRITICAL tests first")
        print(f"📋 Then {len(normal_tests)} normal tests")

        self.current_test_index = 0

        while self.current_test_index < len(all_tests):
            test_case = all_tests[self.current_test_index]
            test_num = self.current_test_index + 1

            print(f"\n{'='*80}")
            print(f"TEST {test_num}/{len(all_tests)}: {test_case.name}")
            print(f"Category: {test_case.category.value}")
            print(f"Query: {test_case.query}")
            if test_case.priority == "CRITICAL":
                print("🔥 CRITICAL TEST")
            print(f"{'='*80}")

            # Run the test
            result = await self.run_single_test(test_case)

            if result.passed:
                print(f"✅ PASS ({result.command_count} cmds, {result.execution_time:.1f}s)")
                self.passed_tests.append(result)
                self.current_test_index += 1

                # Brief pause between tests
                await asyncio.sleep(1)

            else:
                print(f"❌ FAIL")

                # Analyze failure
                self.analyze_failure(result)

                # STOP and wait for user to fix
                print("\n⏸️  TEST EXECUTION PAUSED")
                print("Please fix the issue, then press ENTER to:")
                print("  1. Re-run this test")
                print("  2. Run regression suite (all previous tests)")
                print("  3. Continue if all pass")
                print("\nOr type 'skip' to skip this test, or 'quit' to exit")

                user_input = input("\n> ").strip().lower()

                if user_input == 'quit':
                    print("Exiting...")
                    break
                elif user_input == 'skip':
                    print(f"⏭️  Skipping test {test_num}")
                    self.current_test_index += 1
                    continue

                # Re-run this test
                print(f"\n🔄 Re-running test: {test_case.name}")
                result = await self.run_single_test(test_case)

                if not result.passed:
                    print(f"❌ Test still fails: {result.failure_reasons}")
                    print("Fix not successful. Staying on this test.")
                    continue

                print(f"✅ Test now passes!")

                # Run regression suite
                if not await self.run_regression_suite():
                    print(f"\n💥 FIX CAUSED REGRESSION!")
                    print("Please fix the regression, then press ENTER")
                    input("\n> ")
                    continue

                # Success! Move to next test
                self.passed_tests.append(result)
                self.current_test_index += 1
                print(f"\n✅ Proceeding to test {test_num + 1}")

        # Final summary
        print("\n" + "="*80)
        print("FINAL SUMMARY")
        print("="*80)
        print(f"✅ Passed: {len(self.passed_tests)}/{len(all_tests)}")
        print(f"Tests completed: {self.current_test_index}/{len(all_tests)}")

        if len(self.passed_tests) == len(all_tests):
            print("\n🎉 ALL TESTS PASSED!")
        else:
            print(f"\n⚠️  {len(all_tests) - len(self.passed_tests)} tests not completed")

    async def close(self):
        await self.tester.close()


async def main():
    runner = IterativeTestRunner()
    try:
        await runner.initialize()
        await runner.run_iterative()
    finally:
        await runner.close()


if __name__ == "__main__":
    asyncio.run(main())
