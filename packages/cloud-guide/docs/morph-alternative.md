# Runtime vs Morph

Runtime runs each agent sandbox in its own microVM and costs **62% less than Morph** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **$0.64 on
Runtime and $1.67 on Morph**. At 100,000 runs a month that is $63.89 against
$166.67, **$103 a month saved**.

## Where Runtime is better

- **You pay for the CPU you use.** Morph bills a machine's full size in MCUs for
  as long as it runs. Runtime measures the CPU your code actually uses, so time
  spent waiting on a model costs only a small floor, a twentieth of a vCPU.
- **Cheaper even when busy.** With both CPUs working the whole time, the example
  job costs $1.33 on Runtime and $1.67 on Morph.
- **CPU and memory priced apart.** One MCU covers 1 vCPU, 4 GB of memory or
  16 GB of disk, and a machine pays for whichever it needs most of. On Runtime
  you choose vCPUs and memory separately and pay for each.
- **No plan fee.** Morph's plans with included credit cost $40 or $250 a month.
  Runtime is prepaid credit from $10, with 100 free sandbox hours to start.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Give an agent a read-only key or a daily spending
  limit per key, and cap any create with `maxCostMicros`. Every write takes an
  idempotency key, so a lost response never creates a second sandbox.

## At a glance

Morph's figures come from its public pricing and product pages, checked
23 September 2026.

|                  | Runtime                                                  | Morph                                                    |
| ---------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| Isolation        | Firecracker microVM, own kernel                          | Full virtual machines                                    |
| CPU billing      | $0.025 per vCPU-hour of measured CPU, with a small floor | $0.05 per MCU-hour for the machine's size                |
| Memory billing   | $0.0075 per reserved GiB-hour                            | Inside the MCU: 4 GB per MCU                             |
| Plan fee         | None; prepaid credit from $10                            | Free with no credit; Developer $40 and Team $250 a month |
| Free start       | 100 sandbox hours, no card                               | 1,000 MCUs with the $40 Developer plan                   |
| Snapshots, forks | Files, memory and running processes                      | Memory and disk; branches to many replicas               |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model. On Morph, 2 vCPUs and 4 GB is 2 MCUs an hour.

```
Runtime  CPU    1,000 × 20 s / 3,600 × $0.025      = $0.14
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0075 = $0.50
         Total                                        $0.64

Morph    Size   1,000 × 60 s / 3,600 × 2 MCU × $0.05 = $1.67
```

- **Saving:** 62%, or $1.03 per 1,000 runs.
- **Per month:** at 100,000 runs, $63.89 on Runtime against $166.67 on Morph.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on Runtime
  against $1.67 on Morph.

Plan fees, included credit, storage, network and taxes are left out of both. On
Runtime, inbound traffic is free, and each account's first 100 GiB out a month
is free, then $0.02 per GB. See [pricing](./pricing) for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Morph calls on a branch, tests them on the free trial, and tells
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

## When Morph may fit better

- **Branching at scale.** Morph's Infinibranch branches a running machine,
  memory included, to hundreds of parallel replicas.
- **Development environments for people.** Morph Devboxes are shareable
  workspaces that scale to zero when idle and keep their memory.

## Sources

Checked 23 September 2026.

- [Morph Cloud pricing](https://cloud.morph.so/web/pricing)
- [Morph Devboxes](https://cloud.morph.so/web/product/devboxes)
- [Morph snapshots](https://cloud.morph.so/docs/documentation/instances/creating-snapshot)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
