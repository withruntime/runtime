import { expect, test } from "bun:test";
import { suiteFailure } from "../scripts/test";

// Each runner's own output for one failing test, 11 October 2026.
test("a failing unittest is named with the line that says why, in Python 3.12's form and 3.10's", () => {
  const output = [
    "test_ok (tests.test_client.Parity.test_ok) ... ok",
    "",
    "======================================================================",
    "FAIL: test_bad (tests.test_client.Parity.test_bad)",
    "----------------------------------------------------------------------",
    "Traceback (most recent call last):",
    '  File "tests/test_client.py", line 4, in test_bad',
    "    self.assertEqual(1, 2)",
    "AssertionError: 1 != 2",
    "",
    "FAILED (failures=1)",
  ].join("\n");
  expect(suiteFailure(output)).toBe("tests.test_client.Parity.test_bad: AssertionError: 1 != 2");
  expect(
    suiteFailure(
      output.replace("(tests.test_client.Parity.test_bad)", "(tests.test_client.Parity)"),
    ),
  ).toBe("tests.test_client.Parity.test_bad: AssertionError: 1 != 2");
  expect(
    suiteFailure("ERROR: test_x (tests.test_async.Files.test_x)\n----\nTraceback:\nTimeoutError\n"),
  ).toBe("tests.test_async.Files.test_x: TimeoutError");
});

test("a failing go test is named by its innermost subtest, with its t.Errorf line before or after", () => {
  const plain = [
    "--- FAIL: TestBad (0.00s)",
    "    --- FAIL: TestBad/sub (0.00s)",
    "        x_test.go:3: want 1, got 2",
    "FAIL",
    "FAIL\tx\t0.002s",
  ].join("\n");
  expect(suiteFailure(plain)).toBe("TestBad/sub: x_test.go:3: want 1, got 2");
  const verbose = [
    "=== RUN   TestBad",
    "    x_test.go:3: want 1, got 2",
    "--- FAIL: TestBad (0.00s)",
    "FAIL",
  ].join("\n");
  expect(suiteFailure(verbose)).toBe("TestBad: x_test.go:3: want 1, got 2");
});

test("a failing Java test is TestMain's FAIL line; a minitest failure its name and message", () => {
  expect(
    suiteFailure(
      "ok    files (12 ms)\nFAIL  exec streams: java.lang.AssertionError: want 1\n\tat Check.equal\n1 passed, 1 failed, 0 skipped",
    ),
  ).toBe("exec streams: java.lang.AssertionError: want 1");
  const minitest = [
    "  1) Failure:",
    "ClientTest#test_bad [test/client_test.rb:3]:",
    "Expected: 1",
    "  Actual: 2",
    "",
    "1 runs, 1 assertions, 1 failures, 0 errors, 0 skips",
  ].join("\n");
  expect(suiteFailure(minitest)).toBe("ClientTest#test_bad: Expected: 1 Actual: 2");
  expect(suiteFailure("  1) Error:\nClientTest#test_x:\nErrno::ECONNRESET: reset\n")).toBe(
    "ClientTest#test_x: Errno::ECONNRESET: reset",
  );
});

test("output that names no failing test ends the reason with its last line", () => {
  expect(
    suiteFailure("starting\nThe Java tests did not finish within 5 minutes and were stopped.\n\n"),
  ).toBe(
    "no failing test named; it ended: The Java tests did not finish within 5 minutes and were stopped.",
  );
  expect(suiteFailure("")).toBe("it printed nothing");
  expect(suiteFailure(`FAIL  ${"x".repeat(300)}`)).toHaveLength(200);
});
