# Runtime vs Freestyle

Runtime runs agent code in its own microVMs, like Freestyle's VMs, and costs **72% less** for an agent that mostly waits on a model, with no plan to buy for more at once.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **$0.64 on
Runtime and $2.25 on Freestyle**. At 100,000 runs a month that is $63.89
against $224.99, **$161 a month saved**.

## Where Runtime is better

- **You pay for the CPU you use.** Freestyle bills the vCPUs, memory and disk
  allocated to a VM for as long as it is allocated; its pricing page says a
  reserved core is yours whether or not the guest is busy. Runtime measures the
  CPU your code actually uses, so time spent waiting on a model costs only a
  small floor, a twentieth of a vCPU.
- **Lower rates on both meters.** $0.025 per vCPU-hour against $0.04032, and
  $0.0075 per GiB-hour of memory against $0.0129. With both CPUs busy the whole
  time, the example job costs $1.33 on Runtime and $2.25 on Freestyle.
- **Scale without a plan.** Freestyle runs 10 VMs at once on its free plan, 40
  on the $50-a-month Hobby plan and 400 on the $500-a-month Pro plan. A paid
  Runtime account runs 100 sandboxes at once, 50 in its first week or first $50
  of use, with no plan fee: prepaid credit from $10, and support raises the
  limit when you ask.
- **Bigger sandboxes without Pro.** A paid Runtime sandbox takes up to 16 vCPUs
  and 64 GiB. On Freestyle, 64 GiB needs the Pro plan; Hobby stops at 8 vCPUs
  and 16 GiB.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Read-only keys, a daily spending limit per key and
  `maxCostMicros` on each create keep an agent inside its budget, and every
  write takes an idempotency key.
- **Python and JavaScript.** Runtime has SDKs for both, a CLI and an MCP server.

## At a glance

Freestyle's figures come from its public pricing page and VM documentation,
checked 25 September 2026.

|                    | Runtime                                                  | Freestyle                                                 |
| ------------------ | -------------------------------------------------------- | --------------------------------------------------------- |
| Isolation          | Firecracker microVM, own kernel                          | Full Linux virtual machines                               |
| CPU billing        | $0.025 per vCPU-hour of measured CPU, with a small floor | $0.04032 per allocated vCPU-hour                          |
| Memory billing     | $0.0075 per reserved GiB-hour                            | $0.0129 per allocated GiB-hour                            |
| Disk while it runs | Included                                                 | $0.000086 per allocated GiB-hour                          |
| Sizes              | Up to 16 vCPUs and 64 GiB paid, chosen apart             | 4 vCPUs and 8 GiB free; 8 and 16 Hobby; 32 and 64 Pro     |
| At once            | 100 paid (50 in the first week), no plan                 | 10 free, 40 Hobby, 400 Pro                                |
| Plan fee           | None; prepaid credit from $10                            | Free $0; Hobby $50 and Pro $500 a month, counted to usage |
| Free start         | 100 sandbox hours, no card                               | 200 vCPU-hours and 400 GiB-hours of memory a month        |
| Pause              | Files, memory and processes, kept 1 to 365 days          | Hibernate with memory, billed as storage while paused     |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model. Freestyle's VM keeps its default 32 GiB disk.

```
Runtime    CPU    1,000 × 20 s / 3,600 × $0.025              = $0.14
           Memory 1,000 × 60 s / 3,600 × 4 × $0.0075         = $0.50
           Total                                                $0.64

Freestyle  CPU    1,000 × 60 s / 3,600 × 2 × $0.04032        = $1.34
           Memory 1,000 × 60 s / 3,600 × 4 × $0.0129         = $0.86
           Disk   1,000 × 60 s / 3,600 × 32 × $0.000086      = $0.05
           Total                                                $2.25
```

- **Saving:** 72%, or $1.61 per 1,000 runs.
- **Per month:** at 100,000 runs, $63.89 on Runtime against $224.99 on
  Freestyle, before any plan fee.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on Runtime
  against $2.25 on Freestyle. At this size Runtime is cheaper however busy the
  sandbox is.

Plan fees, free allowances, data transfer, paused storage and taxes are left out
of both. On Runtime, inbound traffic is free, and each account's first 100 GiB
out a month is free, then $0.02 per GB. See [pricing](./pricing) for Runtime's
terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Freestyle calls on a branch, tests them on the free trial, and
tells you what you save each month. Your old code stays on the main branch until
you merge.

A Freestyle snapshot you start VMs from maps to a Runtime
[snapshot](./javascript#snapshots-and-forks) or a [custom image](./images), and a
VM kept for weeks maps to a sandbox paused with a long retention:

```ts check
import { Sandbox } from "withruntime";

const box = await Sandbox.create({ funding: "paid", timeoutSeconds: 3600 });
await box.exec("pip install --quiet requests");
await box.pause(); // memory, processes and files are kept
await box.setRetention(90); // for 90 days
await box.wake(); // later: it carries on where it stopped
await box.stop();
```

## When Freestyle may fit better

- **More than 16 vCPUs in one VM.** Freestyle's Pro plan goes to 32 vCPUs.
- **Forking without a pause.** Freestyle clones a running VM without pausing
  it. A Runtime fork pauses the source for about a second.
- **The fastest start.** Freestyle states VMs provision with a p99 under
  400 ms. A Runtime sandbox ran its first command 374 ms after the request at
  the median and 495 ms at the 95th percentile on 26 September 2026
  ([speed](./speed)).

## Sources

Checked 25 September 2026.

- [Freestyle pricing](https://www.freestyle.sh/pricing)
- [Freestyle VM pricing and limits](https://www.freestyle.sh/docs/vms/pricing-and-limits)
- [Freestyle VMs](https://www.freestyle.sh/docs/vms)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
