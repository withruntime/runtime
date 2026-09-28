# Speed

**A new default sandbox took 331 ms from the create request through the first
Python result at the median**, measured from a laptop through the public API
on 28 September 2026. The p95 was 465 ms across 20 sequential starts, with no
errors.

**A paused sandbox runs its next command {{wake}} after the call that wakes
it**, and a preview visit to one answers in {{preview-visit}}, measured the same
way on {{operations-date}}. On the server, without the network between your
machine and Virginia, a pause answers in 81 ms, a wake in 75 ms and a stop in
37 ms. A sandbox pauses itself after {{idle-pause}} with nothing happening in
it, so idle time costs paused storage only.

## Startup, 28 September 2026

The script at the end of this page ran 20 sequential starts at 02:35 UTC, then
20 more straight after, from a MacBook Pro in the US Mountain time zone with
Node 24.20.0 and `withruntime` 0.8.1 from npm. Runtime runs in one region, in
Virginia, so these are the times your own code sees, network included. Each
trial sandbox had 2 vCPU, 4 GiB memory and 4 GiB disk, with shared CPU, ran
`python3 -c pass` as its first command, and was stopped before the next began.

| Step                               | Median | p95    | Repeat median | Repeat p95 |
| ---------------------------------- | ------ | ------ | ------------- | ---------- |
| Create until running               | 181 ms | 257 ms | 163 ms        | 359 ms     |
| Create through first Python result | 331 ms | 465 ms | 338 ms        | 604 ms     |
| First Python request after create  | 155 ms | 258 ms | 160 ms        | 472 ms     |

Each run had 20 successful starts and no errors; p95 is nearest-rank. The
server keeps a few sandboxes of the most common shapes started ahead of time,
this one included, and hands one over when a create asks for exactly that
shape; 30 of these 40 creates reached running in under 200 ms. A shape with no
spare starts from a saved template instead. The
[40 recorded samples](/benchmarks/startup-2026-09-28.jsonl) include every
attempt and its cleanup; these are observations, not a latency promise.

## Fork, snapshot, pause and wake, 28 September 2026

Ten rounds from the same laptop at 02:29 UTC, through the public API with
`withruntime` 0.8.1, one source sandbox at a time. The source was the same
trial default shape, running a Python web server.

| Step                                                | Median | p95    | Samples |
| --------------------------------------------------- | ------ | ------ | ------- |
| Pause, until paused                                 | 165 ms | 193 ms | 10      |
| Wake, until running                                 | 282 ms | 414 ms | 10      |
| Wake, through the first command                     | 569 ms | 764 ms | 10      |
| Wake straight after a pause, until running          | 137 ms | 236 ms | 10      |
| Preview visit to a paused sandbox, until it answers | 0.51 s | 0.62 s | 10      |
| Fork of one, until the copy is running              | 4.57 s | 5.03 s | 10      |
| Fork of four, until all four are running            | 5.33 s | 5.67 s | 5       |
| Snapshot of a running sandbox, until it is ready    | 3.27 s | 3.81 s | 10      |
| Create from a snapshot, until running               | 601 ms | 807 ms | 10      |
| Create from a snapshot, through the first command   | 745 ms | 978 ms | 10      |

- **Pause** answers once the sandbox is frozen; its memory is written after.
- **Wake** was asked for 10 seconds after the pause, by which time this
  sandbox's memory had been written to disk, and the wake read it back.
  Straight after a pause the memory has not left the server, so the wake is
  quicker.
- **Preview visit** is a separate run at 02:33 UTC: one request to a private
  preview, with its token, of a sandbox paused 15 seconds earlier, timed until
  the web server in the sandbox answered with 200. Its [samples](/benchmarks/preview-wake-2026-09-28.jsonl)
  are recorded apart.
- **Fork** and **snapshot** pause a running source for the capture and wake it
  again; each answered only when its copies were running, or its snapshot was
  ready and the source running again.
- The [recorded samples](/benchmarks/operations-2026-09-28.jsonl) hold every
  step of every round.

## On the server, 28 September 2026

The same kind of requests timed inside Runtime: from the moment each reached
the API in Virginia until it answered, read from the API's own timing log for
the 20 runs of create, command, pause, wake, command, extend, pause, wake and
stop that the same laptop made at 02:28 UTC. The host's work and our database
are in it; the network between your machine and Virginia, and TLS, are not. It
is the figure to set beside a provider's own server-side claim.

| Step      | Median | p95    | Of it, the host (median) | Requests |
| --------- | ------ | ------ | ------------------------ | -------- |
| A create  | 89 ms  | 155 ms | 32 ms                    | 21       |
| A command | 71 ms  | 241 ms | –                        | 41       |
| A pause   | 81 ms  | 171 ms | 53 ms                    | 41       |
| A wake    | 75 ms  | 227 ms | 45 ms                    | 40       |
| An extend | 54 ms  | 296 ms | 22 ms                    | 20       |
| A stop    | 37 ms  | 102 ms | 8 ms                     | 20       |

A command's time is the API and the sandbox together; the log does not split
them. The [timings](/benchmarks/server-2026-09-28.json) are published beside
the samples.

## Earlier public benchmarks

The measurements below are dated history, each with its own conditions.

### Pause, wake, snapshot and fork, 27 September 2026

The same scripts a day earlier: a pause in 226 ms, a wake in 294 ms and through
its first command in 588 ms, a preview visit to a paused sandbox in 0.47 s, a
snapshot in 3.49 s, a create from a snapshot in 585 ms and a fork in 4.01 s, at
the median. The [operations](/benchmarks/operations-2026-09-27.jsonl) and
[preview](/benchmarks/preview-wake-2026-09-27.jsonl) samples are kept.

### Startup, 26 September 2026

374 ms at the median from the create request through the first Python result
(495 ms p95) and 193 ms until running, with `withruntime` 0.7.1. The
[40 samples](/benchmarks/startup-2026-09-26.jsonl) are kept.

### Pause, wake, snapshot and fork, 26 September 2026

The same script a day earlier, with `withruntime` 0.7.1: a pause in 207 ms, a
wake in 708 ms and through its first command in 980 ms, a preview visit to a
paused sandbox in 0.77 s, a snapshot in 6.54 s, a create from a snapshot in
550 ms and a fork in 3.29 s, at the median. The
[operations](/benchmarks/operations-2026-09-26.jsonl) and
[preview](/benchmarks/preview-wake-2026-09-26.jsonl) samples are kept.

### Startup and operations, 25 September 2026

The same scripts, with `withruntime` 0.6.1, a day earlier: 391 ms at the median
from the create request through the first Python result (981 ms p95), a pause
in 404 ms, a wake in 865 ms and through its first command in 1,149 ms, a
preview visit to a paused sandbox in 3.99 s, and a create from a snapshot in
795 ms. The [startup](/benchmarks/startup-2026-09-25.jsonl),
[operations](/benchmarks/operations-2026-09-25.jsonl) and
[preview](/benchmarks/preview-wake-2026-09-25.jsonl) samples are kept.

### Matched startup, 24 September 2026

The same client and command (`python3 -c pass`) ran 20 times before and 20 times
after the default start template was rebuilt, on the same shape as above, with
the same guest image in both runs.

| Step                               | Before median | Before p95 | After median | After p95 |
| ---------------------------------- | ------------- | ---------- | ------------ | --------- |
| Create until running               | 3,469 ms      | 3,670 ms   | 207 ms       | 620 ms    |
| Create through first Python result | 3,631 ms      | 3,806 ms   | 351 ms       | 815 ms    |
| First Python request after create  | 137 ms        | 186 ms     | 140 ms       | 226 ms    |

Each phase had 20 successful runs and zero errors. The improvement was
startup: the first Python request itself did not get faster. The before run
began at 19:16 UTC and the after run at 19:23 UTC; the
[40 recorded samples](/benchmarks/startup-2026-09-24.jsonl) include every
attempt and its cleanup result.

### Echo startup, 24 September 2026

Before the default start template was rebuilt, a new Runtime sandbox
ran its first command 0.81 seconds after it was asked for, at the median,
measured from a laptop over the public internet.
The slowest of 30 took 1.06 seconds.

At 00:09 UTC, one after another:

| Step                                   | Median | p95    | p99      | Samples |
| -------------------------------------- | ------ | ------ | -------- | ------- |
| Create, until the sandbox is running   | 607 ms | 732 ms | 949 ms   | 30      |
| Create, until the first `echo` answers | 814 ms | 928 ms | 1,059 ms | 30      |
| First `node -e` in a new sandbox       | 219 ms | 265 ms | 410 ms   | 30      |
| First `python3 -c` in a new sandbox    | 116 ms | 136 ms | 217 ms   | 30      |
| A command in a sandbox already in use  | 105 ms | 149 ms | 216 ms   | 100     |
| Pause                                  | 234 ms | 296 ms | 296 ms   | 10      |
| One API call (`GET /v1/me`), for scale | 90 ms  | 232 ms | 232 ms   | 10      |

- **Where from:** a MacBook Pro (Apple M3 Pro, macOS) in the US Mountain time
  zone, on its usual connection, with Node 24.20.0 and `withruntime` 0.5.0 from
  npm. Opening a connection to the API took 67 ms, which is about one network
  round trip. Runtime runs in one region, in Virginia.
- **What ran:** the free trial's default sandbox (2 vCPU, 4 GiB of memory, 4 GiB
  of disk, shared CPU), started from the default template, one at a time. Each
  was stopped before the next began.
- **Percentiles:** p95 and p99 are nearest-rank. With 30 samples p99 is the
  slowest run; with 10, p95 and p99 are both the slowest.
- **A second run:** a run four minutes earlier had medians within 6 per cent of
  these on every step.
- **On the server:** measured on the host itself, with no network, a create took
  a median 270 ms on 22 September 2026.

The client's connection to the API is opened before timing starts, as it would
be in a program that has already made one call. A fresh process pays for that
once, about 140 ms here.

## What others publish

These are each provider's own figures. None says where it was measured from or
whether the network is included, so they are not measured the same way as the
table above.

| Provider               | What it publishes                                                | Source                                                              |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Cloudflare Sandbox     | Container cold starts "can often be in the 1-3 second range"     | [Containers FAQ](https://developers.cloudflare.com/containers/faq/) |
| CodeSandbox (Together) | A new VM from scratch in 2.7 s at p95; from a snapshot in 500 ms | [Together, 20 May 2025](https://www.together.ai/blog/code-sandbox)  |

Both were checked on 23 September 2026. Their workloads and measurement
conditions differ from Runtime's.

## Run the latest measurement yourself

This measures the same workload as the startup table at the top: sequential trial
starts, 2 vCPU, 4 GiB memory, 4 GiB disk, then `python3 -c pass` as the first
command. It opens the API connection before timing, disables automatic request
and capacity retries, and confirms each sandbox is stopped before the next.
There are no pause, wake or fork operations in this measurement.

1. Save the script as `bench.mts` in an empty folder.
2. Run `npm install withruntime` and sign in with `npx withruntime login`, or set
   `RUNTIME_API_KEY`.
3. Run `OUT=after.json node bench.mts` (Node 22.18 or later), or use
   `OUT=after.json bun bench.mts`.

`RUNS` defaults to 20 and accepts 1–100. You need enough trial time remaining;
it never falls back to paid funding. Ctrl-C prevents further starts and lets
the current attempt finish cleanup. A failed or uncertain create stops the
benchmark after cleanup; its five-minute lease is a backstop. Cleanup failures
print the attempt labels for follow-up and make the command fail.

For a before/after comparison, run the identical script on the same client,
connection and shape, saving separate output files. Record the SDK version and
when each run happened. The September comparison used one unchanged guest
image, confirmed by the host operator; the public API does not expose that
image's filesystem hash. Running this now measures the current default image
and templates, rather than recreating the historical before state.

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
  funding: "trial" as const,
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
