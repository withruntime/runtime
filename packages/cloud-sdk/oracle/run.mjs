/* global console, process */
import { checks, check, assert, restoreNetwork, prohibited, intercepted } from "./context.mjs";
import { runVercel } from "./vercel.mjs";
import { runE2B } from "./e2b.mjs";
import { runE2BDeadline } from "./e2b-deadline.mjs";
import { runE2BFiles } from "./e2b-files.mjs";
import { runE2BInterpreter } from "./e2b-interpreter.mjs";
import { runDaytonaBlaxel } from "./daytona-blaxel.mjs";
try {
  for (const [name, run] of [
    ["Vercel", runVercel],
    [
      "E2B",
      async () => {
        await runE2B();
        await runE2BDeadline();
        await runE2BFiles();
        await runE2BInterpreter();
      },
    ],
    ["Daytona and Blaxel", runDaytonaBlaxel],
  ])
    await check(name + " suite completes", run);
  await check("No attempts through guarded network entry points", () =>
    assert.deepEqual(prohibited, []),
  );
  console.log(
    JSON.stringify({
      passed: checks.filter((t) => t.ok).length,
      failed: checks.filter((t) => !t.ok).length,
      interceptedFixtureRequests: intercepted,
      guardedNetworkAttempts: prohibited.length,
    }),
  );
  if (checks.some((t) => !t.ok)) process.exitCode = 1;
} finally {
  restoreNetwork();
}
