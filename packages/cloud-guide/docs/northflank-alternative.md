# Runtime vs Northflank

Runtime is built for agent sandboxes and costs **42% less than Northflank** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **$0.64 on
Runtime and $1.11 on Northflank**. At 100,000 runs a month that is $63.89
against $111.10, **$47 a month saved**.

## Where Runtime is better

- **You pay for the CPU you use.** Northflank bills the vCPUs and memory a
  sandbox holds for as long as it runs. Runtime measures the CPU your code
  actually uses, so time spent waiting on a model costs only a small floor, a
  twentieth of a vCPU.
- **Cheaper memory.** $0.0075 per GiB-hour on Runtime against $0.00833 per
  GB-hour on Northflank, and a GiB is about 7% larger than a GB.
- **A sandbox is one call.** `Sandbox.create()` returns a running sandbox, with
  no service, project or deployment plan to set up. Northflank creates each
  sandbox as a service.
- **Pause and fork keep memory.** A paused Runtime sandbox wakes with its
  processes still running, kept for 1 to 365 days, and a fork copies a running
  sandbox with its memory.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Give an agent a read-only key or a daily spending
  limit per key, and cap any create with `maxCostMicros`. Every write takes an
  idempotency key, so a lost response never creates a second sandbox.

## At a glance

Northflank's figures come from its public pricing and documentation, checked
23 September 2026.

|                | Runtime                                                  | Northflank                                        |
| -------------- | -------------------------------------------------------- | ------------------------------------------------- |
| Isolation      | Firecracker microVM, own kernel                          | A microVM per workload, Kata Containers or gVisor |
| CPU billing    | $0.025 per vCPU-hour of measured CPU, with a small floor | $0.01667 per allocated vCPU-hour                  |
| Memory billing | $0.0075 per reserved GiB-hour                            | $0.00833 per GB-hour                              |
| Plan fee       | None; prepaid credit from $10                            | None published for compute                        |
| Free start     | 100 sandbox hours, no card                               | 2 free services and 1 free database               |
| Sandbox model  | A sandbox, created in one call                           | A service with a deployment plan                  |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox (4 GB on Northflank). Each run lasts
60 seconds and keeps the CPU busy for 20 CPU-seconds: an agent that spends most
of its time waiting for a model.

```
Runtime     CPU    1,000 × 20 s / 3,600 × $0.025        = $0.14
            Memory 1,000 × 60 s / 3,600 × 4 × $0.0075   = $0.50
            Total                                          $0.64

Northflank  CPU    1,000 × 60 s / 3,600 × 2 × $0.01667  = $0.556
            Memory 1,000 × 60 s / 3,600 × 4 × $0.00833  = $0.555
            Total                                          $1.11
```

- **Saving:** 42%, or $0.47 per 1,000 runs.
- **Per month:** at 100,000 runs, $63.89 on Runtime against $111.10 on
  Northflank.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on Runtime
  against $1.11 on Northflank.

The more of its time an agent spends waiting, the more Runtime saves. Storage,
network, taxes and free allowances are left out of both. On Runtime, inbound
traffic is free, and each account's first 100 GiB out a month is free, then
$0.02 per GB. See [pricing](./pricing) for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Northflank calls on a branch, tests them on the free trial, and
tells you what you save each month. Your old code stays on the main branch until
you merge.

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

## When Northflank may fit better

- **Work that keeps every CPU busy.** Northflank's allocated vCPU rate is lower
  than Runtime's measured rate, so a job that uses all its CPUs all the time
  costs less there: $1.11 against $1.33 in the example.
- **GPUs.** Northflank rents GPUs by the hour, including L4, A100 and H100.
- **Your own cloud and many regions.** Northflank runs in your AWS, GCP or Azure
  account as well as its own regions. Runtime runs in one US region.

## Sources

Checked 23 September 2026; isolation rechecked 25 September 2026.

- [Northflank pricing](https://northflank.com/pricing)
- [Northflank sandboxes](https://northflank.com/product/sandboxes)
- [Sandboxes on Northflank](https://northflank.com/docs/v1/application/sandboxes/sandboxes-on-northflank)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
