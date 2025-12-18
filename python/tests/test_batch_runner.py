"""
Batch Test Runner - Run tests in batches of 10

Runs comprehensive E2E tests in manageable batches, reporting after each batch.
"""

import asyncio
import sys
import time
from typing import List

sys.path.insert(0, '/Users/ankitjain/lens-killer/python')
from tests.test_e2e_exhaustive import ExhaustiveE2ETester, TestCase, TestResult

BATCH_SIZE = 10


class BatchTestRunner:
    """Run tests in batches with progress reporting."""

    def __init__(self):
        self.tester = ExhaustiveE2ETester()
        self.all_results: List[TestResult] = []

    async def initialize(self):
        """Initialize tester and load test cases."""
        await self.tester.initialize()
        print(f"📋 Loaded {len(self.tester.test_cases)} test cases")
        print(f"📦 Will run in batches of {BATCH_SIZE}")

    async def run_batch(self, batch_num: int, tests: List[TestCase]) -> List[TestResult]:
        """Run a single batch of tests."""
        print(f"\n{'='*80}")
        print(f"BATCH {batch_num} - Running {len(tests)} tests")
        print(f"{'='*80}")

        results = []
        for i, test_case in enumerate(tests, 1):
            print(f"\n[{i}/{len(tests)}] {test_case.name}")
            print(f"  Query: {test_case.query}")

            result = await self.tester.run_test(test_case)
            results.append(result)

            status = "✅ PASS" if result.passed else "❌ FAIL"
            print(f"  {status} ({result.command_count} cmds, {result.execution_time:.1f}s)")

            if not result.passed:
                print(f"  Failures: {', '.join(result.failure_reasons)}")

            # Small delay between tests
            await asyncio.sleep(2)

        return results

    def print_batch_summary(self, batch_num: int, results: List[TestResult]):
        """Print summary for a batch."""
        passed = [r for r in results if r.passed]
        failed = [r for r in results if not r.passed]

        print(f"\n{'='*80}")
        print(f"BATCH {batch_num} SUMMARY")
        print(f"{'='*80}")
        print(f"✅ Passed: {len(passed)}/{len(results)}")
        print(f"❌ Failed: {len(failed)}/{len(results)}")

        if failed:
            print(f"\nFailed Tests:")
            for r in failed:
                print(f"  • {r.test_case.name}")
                print(f"    Expected routing: {r.test_case.expected_routing}, Got: {r.actual_routing}")
                print(f"    Expected ≤{r.test_case.max_commands} cmds, Got: {r.command_count}")
                for reason in r.failure_reasons:
                    print(f"    - {reason}")

    def print_overall_summary(self):
        """Print overall summary across all batches."""
        passed = [r for r in self.all_results if r.passed]
        failed = [r for r in self.all_results if not r.passed]

        print(f"\n{'='*80}")
        print(f"OVERALL SUMMARY")
        print(f"{'='*80}")
        print(f"Total Tests: {len(self.all_results)}")
        print(f"✅ Passed: {len(passed)} ({len(passed)/len(self.all_results)*100:.1f}%)")
        print(f"❌ Failed: {len(failed)} ({len(failed)/len(self.all_results)*100:.1f}%)")

        # Categorize failures
        routing_failures = []
        performance_failures = []
        accuracy_failures = []
        crash_failures = []

        for r in failed:
            if r.exception:
                crash_failures.append(r)
            elif r.actual_routing and r.actual_routing != r.test_case.expected_routing:
                routing_failures.append(r)
            elif r.command_count > r.test_case.max_commands:
                performance_failures.append(r)
            else:
                accuracy_failures.append(r)

        if routing_failures:
            print(f"\n🔀 ROUTING ISSUES ({len(routing_failures)}):")
            for r in routing_failures:
                print(f"  • {r.test_case.name}: {r.actual_routing} ≠ {r.test_case.expected_routing}")

        if performance_failures:
            print(f"\n⚡ PERFORMANCE ISSUES ({len(performance_failures)}):")
            for r in performance_failures:
                print(f"  • {r.test_case.name}: {r.command_count} cmds > {r.test_case.max_commands} expected")

        if crash_failures:
            print(f"\n💥 CRASH/EXCEPTION ({len(crash_failures)}):")
            for r in crash_failures:
                print(f"  • {r.test_case.name}: {r.exception}")

        if accuracy_failures:
            print(f"\n📊 ACCURACY ISSUES ({len(accuracy_failures)}):")
            for r in accuracy_failures:
                print(f"  • {r.test_case.name}: {', '.join(r.failure_reasons)}")

    async def run_all_batches(self):
        """Run all tests in batches."""
        # Separate critical and normal tests
        critical_tests = [t for t in self.tester.test_cases if t.priority == "CRITICAL"]
        normal_tests = [t for t in self.tester.test_cases if t.priority != "CRITICAL"]

        all_tests = critical_tests + normal_tests

        print(f"\n🔥 {len(critical_tests)} CRITICAL tests")
        print(f"📋 {len(normal_tests)} normal tests")
        print(f"📦 {len(all_tests) // BATCH_SIZE + (1 if len(all_tests) % BATCH_SIZE else 0)} batches total")

        # Create batches
        batches = []
        for i in range(0, len(all_tests), BATCH_SIZE):
            batches.append(all_tests[i:i + BATCH_SIZE])

        # Run each batch
        for batch_num, batch in enumerate(batches, 1):
            print(f"\n\n{'#'*80}")
            print(f"# STARTING BATCH {batch_num}/{len(batches)}")
            print(f"{'#'*80}")

            batch_results = await self.run_batch(batch_num, batch)
            self.all_results.extend(batch_results)

            self.print_batch_summary(batch_num, batch_results)

            # Pause between batches
            if batch_num < len(batches):
                print(f"\n⏸️  Batch {batch_num} complete. Pausing 5 seconds before next batch...")
                await asyncio.sleep(5)

        # Final summary
        self.print_overall_summary()

    async def close(self):
        await self.tester.close()


async def main():
    runner = BatchTestRunner()
    try:
        await runner.initialize()
        await runner.run_all_batches()
    finally:
        await runner.close()


if __name__ == "__main__":
    asyncio.run(main())
