# Runtime vs CodeSandbox

Runtime runs agent code in Firecracker microVMs, like the CodeSandbox SDK, and costs **74% less** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **$0.64 on
Runtime and $2.48 on CodeSandbox**. At 100,000 runs a month that is $63.89
against $247.67, **$184 a month saved**.

## Where Runtime is better

- **You pay for the CPU you use.** CodeSandbox bills a VM's size in credits for
  as long as it runs. Runtime measures the CPU your code actually uses, so time
  spent waiting on a model costs only a small floor, a twentieth of a vCPU.
- **Cheaper even when busy.** With both CPUs working the whole time, the example
  job costs $1.33 on Runtime and $2.48 on CodeSandbox.
- **Billed by the second.** CodeSandbox rounds each VM's runtime up to the next
  minute. Runtime compute has no one-minute minimum.
- **Any shape.** CodeSandbox sells fixed VM sizes. On Runtime you choose vCPUs
  and memory for each sandbox and pay for no more.
- **No plan fee for concurrency.** More than 10 VMs at once on CodeSandbox needs
  the $170-a-month Scale plan. Runtime has no plan: a paid account runs 100
  sandboxes at once, 50 in its first week, and support raises the limit on
  request.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.

## At a glance

CodeSandbox's figures come from the Together Code Sandbox documentation, which
covers the CodeSandbox SDK, checked 23 September 2026.

|                  | Runtime                                                  | CodeSandbox SDK                                     |
| ---------------- | -------------------------------------------------------- | --------------------------------------------------- |
| Isolation        | Firecracker microVM, own kernel                          | Firecracker microVM                                 |
| CPU billing      | $0.025 per vCPU-hour of measured CPU, with a small floor | By VM size: Nano (2 cores, 4 GB) is $0.1486 an hour |
| Memory billing   | $0.0075 per reserved GiB-hour                            | Inside the VM size                                  |
| Billing unit     | By the second                                            | By the minute, rounded up                           |
| Plan fee         | None; prepaid credit from $10                            | Build free with 10 VMs at once; Scale $170 a month  |
| Free start       | 100 sandbox hours, no card                               | The free Build plan                                 |
| Snapshots, forks | Files, memory and running processes                      | Memory snapshot and restore                         |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model. On CodeSandbox that is a Nano VM, 10 credits an hour at
$0.01486 a credit.

```
Runtime      CPU    1,000 × 20 s / 3,600 × $0.025      = $0.14
             Memory 1,000 × 60 s / 3,600 × 4 × $0.0075 = $0.50
             Total                                        $0.64

CodeSandbox  Size   1,000 × 60 s / 3,600 × $0.1486     = $2.48
```

- **Saving:** 74%, or $1.84 per 1,000 runs.
- **Per month:** at 100,000 runs, $63.89 on Runtime against $247.67 on
  CodeSandbox.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on Runtime
  against $2.48 on CodeSandbox.

Each run here is a whole minute, so CodeSandbox's rounding adds nothing; a
40-second run would still be billed as a minute there. Plan fees, storage,
network and taxes are left out of both. On Runtime, inbound traffic is free, and
each account's first 100 GiB out a month is free, then $0.02 per GB. See
[pricing](./pricing) for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the CodeSandbox calls on a branch, tests them on the free trial, and
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

## When CodeSandbox may fit better

- **Very large machines.** CodeSandbox VMs go up to 64 cores and 128 GB.
- **Many VMs on a plan.** The Scale plan runs 250 VMs at once.

## Sources

Checked 23 September 2026. The rates are from Together's documentation of the
CodeSandbox SDK; CodeSandbox is a Together company.

- [Together Code Sandbox](https://docs.together.ai/docs/together-code-sandbox)
- [CodeSandbox SDK pricing](https://codesandbox.io/docs/sdk/pricing)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
