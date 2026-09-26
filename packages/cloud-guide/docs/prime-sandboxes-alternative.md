# Runtime vs Prime Sandboxes

Runtime and Prime Sandboxes both give every sandbox a microVM with its own kernel; Runtime costs **58% less** for an agent that mostly waits on a model, and can pause and fork today.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **$0.64 on
Runtime and $1.52 on Prime Sandboxes**. At 100,000 runs a month that is $63.89
against $151.67, **$88 a month saved**.

## Where Runtime is better

- **You pay for the CPU you use.** Prime bills the vCPUs, memory and disk a
  sandbox is given for as long as it runs. Runtime measures the CPU your code
  actually uses, so time spent waiting on a model costs only a small floor, a
  twentieth of a vCPU. Even with both CPUs busy the whole minute, the example
  job costs $1.33 on Runtime and $1.52 on Prime.
- **Cheaper memory.** $0.0075 per GiB-hour against Prime's $0.0125, and memory
  is most of what an agent sandbox costs while it waits.
- **Pause and fork now.** A paused Runtime sandbox keeps its memory and
  running processes for 1 to 365 days, and a fork copies a running sandbox into
  up to 10 copies. Prime lists snapshots, and saving, restoring and forking a
  sandbox mid-run, as coming soon.
- **Prices that do not lapse.** Prime's published rates hold through
  22 December 2026. Runtime's rates are fixed in each resource's quote, and
  there is no plan fee: prepaid credit from $10.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Read-only keys, a daily spending limit per key and
  `maxCostMicros` on each create keep an agent inside its budget, and every
  write takes an idempotency key.

## At a glance

Prime's figures come from its sandbox documentation and launch post, checked
25 September 2026.

|                    | Runtime                                                  | Prime Sandboxes                                |
| ------------------ | -------------------------------------------------------- | ---------------------------------------------- |
| Isolation          | Firecracker microVM, own kernel                          | Hardware-virtualized microVM, own guest kernel |
| CPU billing        | $0.025 per vCPU-hour of measured CPU, with a small floor | $0.02 per vCPU-hour while running              |
| Memory billing     | $0.0075 per reserved GiB-hour                            | $0.0125 per GiB-hour while running             |
| Disk while it runs | Included                                                 | $0.0002 per GiB-hour; 5 GiB by default         |
| Sizes              | Up to 16 vCPUs and 64 GiB paid, chosen apart             | Up to 16 vCPUs, 64 GiB and 128 GiB of disk     |
| Pause and fork     | Files, memory and processes; forks of a running sandbox  | Snapshots and forks listed as coming soon      |
| At once            | 100 on a paid account; 50 in its first week              | 1,024 per account to start                     |
| Plan fee           | None; prepaid credit from $10                            | None; rates published through 22 December 2026 |
| Free start         | 100 sandbox hours, no card                               | None published                                 |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model. Prime's sandbox keeps its default 5 GiB disk.

```
Runtime  CPU    1,000 × 20 s / 3,600 × $0.025          = $0.14
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0075     = $0.50
         Total                                            $0.64

Prime    CPU    1,000 × 60 s / 3,600 × 2 × $0.02       = $0.67
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0125     = $0.83
         Disk   1,000 × 60 s / 3,600 × 5 × $0.0002     = $0.02
         Total                                            $1.52
```

- **Saving:** 58%, or $0.88 per 1,000 runs.
- **Per month:** at 100,000 runs, $63.89 on Runtime against $151.67 on Prime.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on Runtime
  against $1.52 on Prime. At this size Runtime is cheaper however busy the
  sandbox is.

Network, taxes and free allowances are left out of both. See
[pricing](./pricing) for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Prime calls on a branch, tests them on the free trial, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

An RL rollout that sets up an environment once and runs many episodes from it
is a good fit for a fork: install once, then start every episode from the same
running machine.

```ts check
import { Sandbox } from "withruntime";

await using base = await Sandbox.create({ funding: "trial" });
await base.exec("pip install --quiet numpy");
const episodes = await base.fork({ count: 4 }); // four running copies, memory included
await Promise.all(episodes.map((episode) => episode.stop()));
```

## When Prime Sandboxes may fit better

- **Thousands at once from day one.** An account starts at 1,024 active
  sandboxes and 4,096 vCPUs. A paid Runtime account runs 100, after a first week
  at 50, and raises it on request.
- **Training on Prime Intellect.** Prime Sandboxes are built for agentic RL
  training on Prime's own platform, and Prime Tunnels reach inference running
  on its cluster nodes.

## Sources

Checked 25 September 2026.

- [Prime Sandboxes overview](https://docs.primeintellect.ai/sandboxes/overview)
- [Prime Sandboxes launch](https://www.primeintellect.ai/blog/sandboxes)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
