# Runtime vs Daytona

Runtime gives every agent sandbox its own microVM kernel and costs **77% less than Daytona** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **$0.64 on
Runtime and $2.76 on Daytona**. At 100,000 runs a month that is $63.89 against
$276.00, **$212 a month saved**. Your Daytona code keeps working: change one import.

## Where Runtime is better

- **You pay for the CPU you use.** Daytona bills every vCPU for as long as the
  sandbox runs. Runtime measures the CPU your code actually uses, so time spent
  waiting on a model costs only a small floor, a twentieth of a vCPU.
- **Lower rates on both meters.** $0.025 per vCPU-hour against Daytona's
  $0.0504, and $0.0075 per GiB-hour of memory against $0.0162. Even with every
  CPU busy the whole time, the example job costs $1.33 on Runtime and $2.76 on
  Daytona.
- **A microVM every time.** Every Runtime sandbox is a Firecracker microVM with
  its own kernel, and every one can pause with its memory. Daytona's default
  sandbox is a container; pausing with memory needs its VM class.
- **Disk included while running.** Daytona charges for disk past 5 GiB whether
  the sandbox runs or not. Runtime's disk is part of a running sandbox.
- **A one-line switch.** `withruntime/daytona` runs code written for Daytona's
  SDK, in JavaScript and Python: sessions, files, git, snapshots built from
  Daytona's `Image`, and the code interpreter.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Give an agent a read-only key or a daily spending
  limit per key, and cap any create with `maxCostMicros`. Every write takes an
  idempotency key and the SDKs retry with it, so a lost response never creates
  a second sandbox.

## At a glance

Daytona's figures come from its public pricing and documentation, checked
23 September 2026.

|                  | Runtime                                                   | Daytona                                                       |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| Isolation        | Firecracker microVM for every sandbox                     | Containers by default; VM sandboxes as a separate class       |
| CPU billing      | $0.025 per vCPU-hour of measured CPU, with a small floor  | $0.0504 per allocated vCPU-hour                               |
| Memory billing   | $0.0075 per reserved GiB-hour                             | $0.0162 per GiB-hour                                          |
| Disk             | Included while running; paused storage $0.08 per GB-month | First 5 GiB free, then $0.000108 per GiB-hour, stopped or not |
| Plan fee         | None; prepaid credit from $10                             | None published                                                |
| Free start       | 100 sandbox hours, no card                                | $200 of compute                                               |
| Pause and resume | Files and memory, every sandbox                           | Files and memory on VM sandboxes                              |
| Snapshots, forks | Copies of a running sandbox, with memory and processes    | Memory snapshots on VM sandboxes                              |
| Agent sign-in    | Browser approval; no key in the agent's config            | API key                                                       |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model.

```
Runtime  CPU    1,000 × 20 s / 3,600 × $0.025      = $0.14
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0075 = $0.50
         Total                                        $0.64

Daytona  CPU    1,000 × 60 s / 3,600 × 2 × $0.0504 = $1.68
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0162 = $1.08
         Total                                        $2.76
```

- **Saving:** 77%, or $2.12 per 1,000 runs.
- **Per month:** at 100,000 runs, $63.89 on Runtime against $276.00 on Daytona.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on
  Runtime against $2.76 on Daytona. At this size, Runtime is cheaper however busy the
  sandbox is.

Disk, network, taxes and free credits are left out of both.
`runtime compare --from daytona` prices your own usage the same way, with
sandboxes the free trial paid for at the standard rates, so trial time never
counts as a saving. On Runtime, inbound traffic is free, and each account's
first 100 GiB out a month is free, then $0.02 per GB. See [pricing](./pricing)
for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Daytona calls on a branch, tests them on the free trial, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

### Change one import

Runtime's SDK runs code written for Daytona's SDK. Change the import and set
`RUNTIME_API_KEY`, or run `npx withruntime login` once:

```ts no-run
import { Daytona } from "withruntime/daytona"; // was: from "@daytona/sdk"
```

```python no-run
from withruntime.daytona import Daytona  # was: from daytona import Daytona
```

Sandboxes get Daytona's defaults: 1 vCPU, 1 GiB of memory and a 3 GiB disk,
pausing after 15 minutes without calls. `stop()` pauses a sandbox with its
files and its memory, and `start()` carries on. They use the free trial while
the account has trial time, then prepaid credit.

A call Runtime handles differently, such as GPUs, PTY sessions or computer use,
throws `NotSupportedError` before anything happens and names what to use
instead. `DAYTONA.md` in the package lists every mapping.

### Or port the calls

The calls map one to one. Daytona:

```js
import { Daytona } from "@daytonaio/sdk";
const daytona = new Daytona();
const sandbox = await daytona.create();
const response = await sandbox.process.executeCommand("python3 -c 'print(6 * 7)'");
await sandbox.delete();
```

Runtime:

```ts
import { Sandbox } from "withruntime";
const box = await Sandbox.create({ funding: "trial" });
try {
  console.log((await box.exec("python3 -c 'print(6 * 7)'", { check: true })).stdout);
} finally {
  await box.stop();
}
```

## When Daytona may fit better

- **GPUs and Windows.** Daytona offers GPU sandboxes and Windows machines.
  Runtime runs Linux on CPUs.
- **Regions.** Daytona runs in the US and the EU. Runtime runs in one US
  region.

## Sources

Checked 23 September 2026.

- [Daytona pricing](https://www.daytona.io/pricing)
- [Daytona sandboxes](https://www.daytona.io/docs/en/sandboxes)
- [Daytona on microVMs, pause and fork](https://www.daytona.io/dotfiles/vms-pause-and-fork)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
