# Runtime vs Blaxel

Runtime bills the CPU your agent uses and costs **77% less than Blaxel** while running an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **$0.64 on
Runtime and $2.76 on Blaxel**. At 100,000 runs a month that is $63.89 against
$276.00, **$212 a month saved**.

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
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Give an agent a read-only key or a daily spending
  limit per key, and cap any create with `maxCostMicros`. Every write takes an
  idempotency key, so a lost response never creates a second sandbox.

## At a glance

Blaxel's figures come from its public pricing and documentation, checked
23 September 2026.

|                | Runtime                                                  | Blaxel                                           |
| -------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Isolation      | Firecracker microVM, own kernel                          | Lightweight virtual machines                     |
| CPU billing    | $0.025 per vCPU-hour of measured CPU, with a small floor | Included with memory; 8 GB gets 4 cores          |
| Memory billing | $0.0075 per reserved GiB-hour                            | $0.0000115 per GB-second of active time          |
| Paused storage | $0.08 per GB-month; files, memory and processes          | $0.20 per GB-month snapshot; files and processes |
| Plan fee       | None; prepaid credit from $10                            | None; tiers grow with credit added               |
| Free start     | 100 sandbox hours, no card                               | Up to $200 of credit                             |

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
closes. Storage, network, taxes and free credit are left out of both. See
[pricing](./pricing) for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Blaxel calls on a branch, tests them on the free trial, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

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

## When Blaxel may fit better

- **Idle for free, back in milliseconds.** A Blaxel sandbox goes to standby by
  itself when connections close, costs nothing for compute there, and resumes
  in about 25 ms.
- **Very large fleets.** Blaxel's top tier runs over 100,000 sandboxes at once.

## Sources

Checked 23 September 2026.

- [Blaxel pricing](https://blaxel.ai/pricing)
- [Blaxel sandboxes](https://docs.blaxel.ai/Sandboxes/Overview)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
