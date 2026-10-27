# Speed

Runtime times every operation of every product from outside, as a customer:
through the public API, with a production key, from a fixed place in eastern
North America, every one to five minutes. Each result records the API's own
time for the request (its `Server-Timing` header) and the time the client saw,
at p50, p95 and p99, with the sample and failure counts.

This page lists an operation once its own time is within 2× of its floor: the
least time the work it must do can take on today's hardware. An operation that
is not yet that close is not listed, and no older figure stands in for it. The
figures this page showed from September 2026 were taken down on 27 October
2026, because they were no longer what customers see.

## Run the measurement yourself

This script times sequential sandbox starts from your own machine, with 2 vCPU,
4 GiB memory and 4 GiB disk. The first command is `python3 -c pass`. The script
opens the API connection before timing. It disables automatic request and
capacity retries. It confirms each sandbox is stopped before the next.

1. Save the script as `bench.mts` in an empty folder.
2. Run `npm install withruntime` and sign in with `npx withruntime login`, or set
   `RUNTIME_API_KEY`.
3. Run `OUT=after.json node bench.mts` (Node 22.18 or later), or use
   `OUT=after.json bun bench.mts`.

`RUNS` defaults to 20 and accepts 1–100. It runs without credit's hours first,
then on the account's credit if it has some. Ctrl-C prevents further starts. It
lets the current attempt finish its cleanup. A failed or uncertain create stops
the benchmark after cleanup. Its five-minute time limit is a backstop. If
cleanup fails, the script prints the attempt labels for follow-up, and the
command fails.

For a before and after comparison, run the identical script on the same client,
connection and shape. Save separate output files. Record the SDK version and
when each run happened.

```ts check
// bench.mts
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Runtime, VERSION, type Sandbox } from "withruntime";

const count = Number(process.env.RUNS ?? 20);
if (!Number.isInteger(count) || count < 1 || count > 100)
  throw new Error("RUNS must be an integer from 1 to 100");
const runtime = new Runtime({ maxRetries: 0, waitForCapacityMs: 0, timeoutMs: 60_000 });
const run = randomUUID();
const at = new Date().toISOString();
const shape = {
  vcpu: 2,
  memoryMiB: 4096,
  diskMiB: 4096,
  timeoutSeconds: 300,
  autoWake: false,
  idlePauseSeconds: 0,
};
type Sample = {
  index: number;
  ok: boolean;
  cleanup: boolean;
  id?: string;
  createMs?: number;
  firstExecMs?: number;
  totalMs?: number;
  error?: string;
};
const samples: Sample[] = [];
let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
});
process.once("SIGTERM", () => {
  interrupted = true;
});
const message = (error: unknown) => (error instanceof Error ? error.message : "Request failed");

async function cleanup(known: Sandbox | undefined, labels: Record<string, string>) {
  const failures: string[] = [];
  const stop = async (sandbox: Sandbox) => {
    try {
      await sandbox.stop();
      await sandbox.waitFor("stopped");
    } catch (error) {
      failures.push(`${sandbox.id}: ${message(error)}`);
    }
  };
  if (known) await stop(known); // A discovery error must not skip the known guest.
  try {
    for (const sandbox of (await runtime.sandboxes.list({ labels })).data) await stop(sandbox);
    if ((await runtime.sandboxes.list({ labels })).data.length)
      failures.push("An attempt sandbox still exists");
  } catch (error) {
    failures.push(message(error));
  }
  if (failures.length) throw new Error(JSON.stringify({ labels, failures }));
}

try {
  await runtime.me(); // Establish the API connection outside the measured interval.
  for (let index = 1; index <= count && !interrupted; index++) {
    const labels = { benchmark: "startup-python", run, index: String(index) };
    const input = { ...shape, labels, name: `startup-${run}-${index}` };
    const options = { idempotencyKey: `startup-${run}-${index}` };
    const sample: Sample = { index, ok: false, cleanup: false };
    let sandbox: Sandbox | undefined;
    let createUncertain = false;
    const began = performance.now();
    try {
      sandbox = await runtime.sandboxes.create(input, options);
      sample.id = sandbox.id;
      sample.createMs = Math.round(performance.now() - began);
      if (interrupted) throw new Error("Interrupted; cleaning up");
      if (sandbox.state !== "running") throw new Error("Create did not reach running");
      const execAt = performance.now();
      await sandbox.exec(["python3", "-c", "pass"], { check: true });
      sample.firstExecMs = Math.round(performance.now() - execAt);
      sample.totalMs = Math.round(performance.now() - began);
      sample.ok = true;
    } catch (error) {
      sample.error = message(error);
      // Recover a lost create reply with the SAME request key, never a new allocation key.
      if (!sandbox) {
        try {
          sandbox = await runtime.sandboxes.create(input, options);
        } catch {
          createUncertain = true;
          console.error("Create remains uncertain:", options.idempotencyKey, labels);
        }
      }
    } finally {
      try {
        await cleanup(sandbox, labels);
        sample.cleanup = !createUncertain;
      } catch (error) {
        sample.error = message(error);
      }
      samples.push(sample);
      console.log(JSON.stringify(sample));
    }
    if (!sample.ok || !sample.cleanup) throw new Error(sample.error ?? "Attempt failed");
  }
} catch (error) {
  console.error(message(error));
  process.exitCode = 1;
}
if (interrupted) process.exitCode = 130;

const stats = (key: "createMs" | "firstExecMs" | "totalMs") => {
  const values = samples
    .filter((s) => s.ok)
    .map((s) => s[key]!)
    .sort((a, b) => a - b);
  const n = values.length;
  return {
    n,
    median: n ? (values[Math.floor((n - 1) / 2)]! + values[Math.ceil((n - 1) / 2)]!) / 2 : null,
    p95: n ? values[Math.ceil(n * 0.95) - 1]! : null,
  };
};
const result = {
  at,
  run,
  sdk: VERSION,
  engine: process.versions.bun ?? process.version,
  api: runtime.transport.baseUrl,
  shape,
  requested: count,
  attempts: samples.length,
  errors: samples.filter((s) => !s.ok).length,
  cleanupFailures: samples.filter((s) => !s.cleanup).length,
  interrupted,
  createMs: stats("createMs"),
  firstExecMs: stats("firstExecMs"),
  totalMs: stats("totalMs"),
  samples,
};
console.log(JSON.stringify(result, null, 2));
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(result, null, 2) + "\n");
```
