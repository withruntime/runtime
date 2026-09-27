# Runtime vs Blaxel

Runtime bills the CPU your agent uses and costs **77% less than Blaxel** while running an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **$0.64 on
Runtime and $2.76 on Blaxel**. At 100,000 runs a month that is $63.89 against
$276.00, **$212 a month saved**. Your Blaxel sandbox code keeps working: change
one import.

## Where Runtime is better

- **Lower cost while running.** Blaxel bills $0.0000115 per GB of memory per
  second of active time, $0.0414 per GB-hour, and CPU comes with the memory.
  Runtime charges $0.0075 per GiB-hour of memory and measured CPU at $0.025 per
  vCPU-hour.
- **Cheaper even when busy.** With both CPUs working the whole time, the example
  job costs $1.33 on Runtime and $2.76 on Blaxel.
- **CPU and memory chosen apart.** Blaxel sets a sandbox's CPU from its memory:
  8 GB gets 4 cores. On Runtime you choose vCPUs and memory separately, so a
  CPU-heavy job does not pay for memory it does not need.
- **Cheaper to keep paused work.** A paused Runtime sandbox keeps its files,
  memory and processes for $0.08 per GB a month, for 1 to 365 days. Blaxel's
  standby snapshots cost $0.20 per GB a month.
- **A one-line switch.** `withruntime/blaxel` runs code written for Blaxel's
  sandbox SDK, in JavaScript and Python: processes, files, previews, snapshots,
  forks and the code interpreter, with no Blaxel key. A switch from Blaxel gets
  your first top-up matched, up to $100.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Give an agent a read-only key or a daily spending
  limit per key, and cap any create with `maxCostMicros`. Every write takes an
  idempotency key, so a lost response never creates a second sandbox.

## At a glance

Blaxel's figures come from its public pricing and documentation, checked
27 September 2026.

|                | Runtime                                                  | Blaxel                                           |
| -------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Isolation      | Firecracker microVM, own kernel                          | Lightweight virtual machines                     |
| CPU billing    | $0.025 per vCPU-hour of measured CPU, with a small floor | Included with memory; 8 GB gets 4 cores          |
| Memory billing | $0.0075 per reserved GiB-hour                            | $0.0000115 per GB-second of active time          |
| Paused storage | $0.08 per GB-month; files, memory and processes          | $0.20 per GB-month snapshot; files and processes |
| Plan fee       | None; prepaid credit from $10                            | None; tiers grow with credit added               |
| Free start     | 100 sandbox hours, no card                               | Up to $200 of credit                             |
| Internet out   | First 100 GiB a month free, then $0.02 per GB            | Included                                         |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox (4 GB on Blaxel). Each run lasts
60 seconds and keeps the CPU busy for 20 CPU-seconds: an agent that spends most of
its time waiting for a model.

```
Runtime  CPU    1,000 × 20 s / 3,600 × $0.025      = $0.14
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0075 = $0.50
         Total                                        $0.64

Blaxel   Memory 1,000 × 60 s × 4 × $0.0000115      = $2.76
```

- **Saving:** 77%, or $2.12 per 1,000 runs.
- **Per month:** at 100,000 runs, $63.89 on Runtime against $276.00 on Blaxel.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on Runtime
  against $2.76 on Blaxel.

The Blaxel figure assumes each sandbox goes to standby the moment its run ends;
Blaxel's docs say standby starts about 15 seconds after the last connection
closes. Storage, network, taxes and free credit are left out of both. On
Runtime, inbound traffic is free, and each account's first 100 GiB out a month
is free, then $0.02 per GB. See [pricing](./pricing) for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Blaxel calls on a branch, tests them on the free trial, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

### Change one import

Runtime's SDK runs code written for Blaxel's sandbox SDK. Change the import and
set `RUNTIME_API_KEY`, or run `npx withruntime login` once:

```ts no-run
import { SandboxInstance } from "withruntime/blaxel"; // was: from "@blaxel/core"
```

```python no-run
from withruntime.blaxel import SandboxInstance  # was: from blaxel.core import SandboxInstance
```

Sandboxes get Blaxel's default of 4096 MB, with one vCPU for every 2048 MB. A
sandbox pauses after 60 seconds without a call, keeping its memory, files and
processes, and wakes by itself on the next command, file call or preview visit.
Envs, processes by name, files, previews, snapshots, forks, volumes and the code
interpreter carry over. Sandboxes use the free trial while the account has
trial time, then prepaid credit; pass `withruntime: { create: { funding: "trial" } }`
(Python `runtime_create={"funding": "trial"}`) while you test.

Four things to know before the first run:

- **One key sees its own sandboxes.** A sandbox is visible only to the key
  that created it; another key gets a 404, while names stay unique across the
  account ([keys in a team](./teams#keys-in-a-team)). A web service and a worker
  that share sandboxes must use the same key.
- **The trial caps a sandbox at 2 vCPU and 4096 MB.** Blaxel's default fits.
  `memory: 8192` or more needs paid credit.
- **Custom images are Runtime images.** Blaxel's own templates, such as
  `blaxel/base-image`, start Runtime's stock image. Any other image must be a
  ready Runtime image of the same name: build it once with
  `npx withruntime image build --dockerfile Dockerfile --name <name>`.
- **Private preview tokens work as they did.** Blaxel's
  `X-Blaxel-Preview-Token` header and `?bl_preview_token=` parameter are
  accepted, as are Runtime's own, and the token never reaches your server.

A call Runtime handles differently, such as sessions, drives, schedules or
Blaxel's agent and MCP hosting, throws `NotSupportedError` before anything
happens and names what to use instead. `BLAXEL.md` in the package lists every
mapping.

### Or port the calls

Blaxel:

```js
import { SandboxInstance } from "@blaxel/core";
const sandbox = await SandboxInstance.create({ name: "my-sandbox", memory: 4096 });
const result = await sandbox.process.exec({
  command: "python3 -c 'print(6 * 7)'",
  waitForCompletion: true,
});
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

Moving from Blaxel? Run `npx withruntime switch --from blaxel` before your first
top-up, and that top-up is matched with credit, up to $100
([switching credit](./pricing#switching-credit)).

## When Blaxel may fit better

- **Idle for free, back in milliseconds.** A Blaxel sandbox goes to standby by
  itself when connections close, costs nothing for compute there, and resumes
  in about 25 ms.
- **Very large fleets.** Blaxel's top tier runs over 100,000 sandboxes at once.
  A tier is the credit topped up over the last 30 days, which is then spent on
  usage: $20 unlocks 50 sandboxes and $50 unlocks 200.
- **Heavy outbound traffic.** Blaxel includes internet egress in its rates.
  Runtime's first 100 GiB out a month are free, then $0.02 per GB.

## Sources

Checked 27 September 2026.

- [Blaxel pricing](https://blaxel.ai/pricing)
- [Blaxel sandboxes](https://docs.blaxel.ai/Sandboxes/Overview)
- [Blaxel usage and quotas](https://docs.blaxel.ai/Security/Quotas)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
