# Runtime vs CodeSandbox

Runtime runs agent code in Firecracker microVMs, like the CodeSandbox SDK, and costs **{{saving:codesandbox}} less** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:codesandbox}} on CodeSandbox**. At 100,000 runs a month that is {{cost:runtime:100000}}
against {{cost:codesandbox:100000}}, **{{=$0 less:codesandbox:100000}} a month saved**.

## Where Runtime is better

- **You pay for the CPU you use.** CodeSandbox bills a VM's size in credits for
  as long as it runs. Runtime measures the CPU your code actually uses, so time
  spent waiting on a model costs only a small floor, {{cpu-floor-share}}.
- **Idle time bills only storage.** A Runtime sandbox pauses itself after
  {{idle-pause}} with nothing happening in it, keeps its memory and processes,
  and runs its next command {{wake}} after the request that wakes it. Paused, it
  pays {{paused-storage-rate}} per GB of saved state a month.
- **A written uptime promise.** {{uptime-promise}} API uptime a month for paid accounts,
  measured from outside, and {{uptime-credit}} of a short month's charges back as credit
  automatically ([Uptime Promise](/legal/sla)).
- **Cheaper even when busy.** With both CPUs working the whole time, the example
  job costs {{cost:runtime:busy}} on Runtime and {{cost:codesandbox}} on CodeSandbox.
- **Billed by the second.** CodeSandbox rounds each VM's runtime up to the next
  minute. Runtime compute has no one-minute minimum.
- **Any shape.** CodeSandbox sells fixed VM sizes. On Runtime you choose vCPUs
  and memory for each sandbox and pay for no more.
- **No plan fee for concurrency.** More than 10 VMs at once on CodeSandbox needs
  the {{term:codesandbox:scale}}-a-month Scale plan. Runtime has no plan: a paid account runs {{paid-sandboxes}}
  sandboxes at once, {{new-account-sandboxes}} in its first week, and support raises the limit on
  request.
- **Secrets stay outside the sandbox.** Code inside sees a placeholder; the
  real key is added at the egress proxy, only on HTTPS to the hosts you allow
  ([security](./security)).
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.

**Also included:** a code interpreter, network allow and deny lists, custom
images, volumes backed up daily, snapshots and forks with memory, private
previews, a Linux desktop, metrics, webhooks, OpenTelemetry export, S3, R2 and
GCS bucket mounts, MCP servers from a catalog, identity tokens for AWS and
Google Cloud and free single sign-on. Paid accounts add custom domains, TCP
ports, dedicated outbound addresses and WireGuard private networks. See
[products](./products).

## At a glance

CodeSandbox's figures come from the Together Code Sandbox documentation, which
covers the CodeSandbox SDK, checked {{checked:codesandbox}}.

|                  | Runtime                                                        | CodeSandbox SDK                                                          |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Isolation        | Firecracker microVM, own kernel                                | Firecracker microVM                                                      |
| CPU billing      | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor | By VM size: Nano (2 cores, 4 GB) is {{rate:codesandbox:size}} an hour    |
| Memory billing   | {{memory-rate}} per reserved GiB-hour                          | Inside the VM size                                                       |
| Billing unit     | By the second                                                  | By the minute, rounded up                                                |
| Plan fee         | None; prepaid credit from {{topup-min}}                        | Build free with 10 VMs at once; Scale {{term:codesandbox:scale}} a month |
| Free start       | {{trial-hours}} sandbox hours, no card                         | The free Build plan                                                      |
| Snapshots, forks | Files, memory and running processes                            | Memory snapshot and restore                                              |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model. On CodeSandbox that is a Nano VM, 10 credits an hour at
{{term:codesandbox:credit-price}} a credit.

```
Runtime      CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}      = {{part:runtime:cpu}}
             Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}} = {{part:runtime:memory}}
             Total                                        {{cost:runtime}}

CodeSandbox  Size   1,000 × 60 s / 3,600 × {{rate:codesandbox:size}}     = {{part:codesandbox:size}}
```

- **Saving:** {{saving:codesandbox}}, or {{less:codesandbox}} per 1,000 runs.
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:codesandbox:100000}} on
  CodeSandbox.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on Runtime
  against {{cost:codesandbox}} on CodeSandbox.

Each run here is a whole minute, so CodeSandbox's rounding adds nothing; a
40-second run would still be billed as a minute there. Plan fees, storage,
network and taxes are left out of both. On Runtime, inbound traffic is free, and
each account's first {{outbound-allowance}} out a month is free, then {{outbound-rate}} per GB. See
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
