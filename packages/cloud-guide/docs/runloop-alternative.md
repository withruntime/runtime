# Runtime vs Runloop

Runtime runs agent code in microVMs, like Runloop's devboxes, and costs **88% less** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **$0.64 on
Runtime and $5.33 on Runloop**. At 100,000 runs a month that is $63.89 against
$532.56, **$469 a month saved**.

## Where Runtime is better

- **You pay for the CPU you use.** Runloop bills a devbox's CPUs and memory for
  as long as it runs. Runtime measures the CPU your code actually uses, so time
  spent waiting on a model costs only a small floor, a twentieth of a vCPU.
- **Lower rates on every meter.** $0.025 per vCPU-hour against Runloop's
  $0.108 per CPU-hour, and $0.0075 per GiB-hour of memory against $0.0252 per
  GB-hour. Even with both CPUs busy the whole time, the example job costs $1.33
  on Runtime and $5.33 on Runloop.
- **Pause keeps memory.** A paused Runtime sandbox wakes with its processes
  still running, kept for 1 to 365 days. A suspended Runloop devbox keeps only
  its disk, and its processes must be restarted.
- **Forks of a running sandbox.** Copy a sandbox with its memory and running
  processes, and try several things from exactly that point.
- **No plan fee.** Runloop's Pro plan is $250 a month plus usage. Runtime is
  prepaid credit from $10, with 100 free sandbox hours to start.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.

## At a glance

Runloop's figures come from its public pricing and documentation, checked
23 September 2026.

|                 | Runtime                                                  | Runloop                                   |
| --------------- | -------------------------------------------------------- | ----------------------------------------- |
| Isolation       | Firecracker microVM, own kernel                          | microVM, with a container inside          |
| CPU billing     | $0.025 per vCPU-hour of measured CPU, with a small floor | $0.108 per CPU-hour while the devbox runs |
| Memory billing  | $0.0075 per reserved GiB-hour                            | $0.0252 per GB-hour                       |
| Disk            | Included while running                                   | $0.00034236 per GB-hour                   |
| Plan fee        | None; prepaid credit from $10                            | Basic free; Pro $250 a month plus usage   |
| Free start      | 100 sandbox hours, no card                               | $50 of credit, no card                    |
| Suspend, resume | Pause keeps files, memory and processes                  | Suspend keeps the disk; processes restart |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model. On Runloop that is the `MEDIUM` devbox: 2 CPUs, 4 GB and
8 GB of disk.

```
Runtime  CPU    1,000 × 20 s / 3,600 × $0.025           = $0.14
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0075      = $0.50
         Total                                             $0.64

Runloop  CPU    1,000 × 60 s / 3,600 × 2 × $0.108       = $3.60
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0252      = $1.68
         Disk   1,000 × 60 s / 3,600 × 8 × $0.00034236 = $0.05
         Total                                             $5.33
```

- **Saving:** 88%, or $4.69 per 1,000 runs.
- **Per month:** at 100,000 runs, $63.89 on Runtime against $532.56 on Runloop.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on Runtime
  against $5.33 on Runloop.

Plan fees, storage while suspended, network, taxes and free credit are left out
of both. On Runtime, inbound traffic is free, and each account's first 100 GiB
out a month is free, then $0.02 per GB. See [pricing](./pricing) for Runtime's
terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Runloop calls on a branch, tests them on the free trial, and tells
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

## When Runloop may fit better

- **Agent benchmarks.** Runloop runs SWE-Bench and other public benchmarks, and
  builds custom ones from your data.
- **Your own cloud and compliance.** Runloop deploys into your cloud account and
  states SOC 2, HIPAA and GDPR readiness.

## Sources

Checked 23 September 2026.

- [Runloop pricing](https://www.runloop.ai/pricing)
- [Devbox sizes](https://docs.runloop.ai/docs/devboxes/configuration/sizes)
- [Devbox lifecycle](https://docs.runloop.ai/docs/devboxes/lifecycle)
- [Runloop](https://www.runloop.ai/)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
