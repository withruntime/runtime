# Runtime vs Prime Sandboxes

Runtime and Prime Sandboxes both give every sandbox a microVM with its own kernel; Runtime costs **{{saving:prime}} less** for an agent that mostly waits on a model, and can pause and fork today.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:prime}} on Prime Sandboxes**. At 100,000 runs a month that is {{cost:runtime:100000}}
against {{cost:prime:100000}}, **{{=$0 less:prime:100000}} a month saved**.

## Where Runtime is better

- **You pay for the CPU you use.** Prime bills the vCPUs, memory and disk a
  sandbox is given for as long as it runs. Runtime measures the CPU your code
  actually uses, so time spent waiting on a model costs only a small floor, {{cpu-floor-share}}. Even with both CPUs busy the whole minute, the example
  job costs {{cost:runtime:busy}} on Runtime and {{cost:prime}} on Prime.
- **Waiting costs storage, not compute.** Left idle for {{idle-pause}}, a Runtime
  sandbox pauses by itself with its memory kept, then pays {{paused-storage-rate}} per GB a
  month until a request wakes it; the next command runs {{wake}} after that.
- **A written uptime promise.** {{uptime-promise}} API uptime a month for paid accounts,
  measured from outside, and {{uptime-credit}} of a short month's charges back as credit
  automatically ([Uptime Promise](/legal/sla)).
- **Cheaper memory.** {{memory-rate}} per GiB-hour against Prime's {{rate:prime:memory}}, and memory
  is most of what an agent sandbox costs while it waits.
- **Pause and fork now.** A paused Runtime sandbox keeps its memory and
  running processes for 1 to 365 days, and a fork copies a running sandbox into
  up to 10 copies. Prime lists snapshots, and saving, restoring and forking a
  sandbox mid-run, as coming soon.
- **Prices that do not lapse.** Prime's published rates hold through
  22 December 2026. Runtime's rates are fixed in each resource's quote, and
  there is no plan fee: prepaid credit from {{topup-min}}.
- **Secrets stay outside the sandbox.** Code inside sees a placeholder; the
  real key is added at the egress proxy, only on HTTPS to the hosts you allow
  ([security](./security)).
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Read-only keys, a daily spending limit per key and
  `maxCostMicros` on each create keep an agent inside its budget, and every
  write takes an idempotency key.

**Also included:** a code interpreter, network allow and deny lists, custom
images, volumes backed up daily, private previews, a Linux desktop, metrics,
webhooks, OpenTelemetry export, S3, R2 and GCS bucket mounts, MCP servers from a
catalog, identity tokens for AWS and Google Cloud and free single sign-on. Paid
accounts add custom domains, TCP ports, dedicated outbound addresses and
WireGuard private networks. See [products](./products).

## At a glance

Prime's figures come from its sandbox documentation and launch post, checked
{{checked:prime}}.

|                    | Runtime                                                                           | Prime Sandboxes                                    |
| ------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| Isolation          | Firecracker microVM, own kernel                                                   | Hardware-virtualized microVM, own guest kernel     |
| CPU billing        | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor                    | {{rate:prime:cpu}} per vCPU-hour while running     |
| Memory billing     | {{memory-rate}} per reserved GiB-hour                                             | {{rate:prime:memory}} per GiB-hour while running   |
| Disk while it runs | Included                                                                          | {{rate:prime:disk}} per GiB-hour; 5 GiB by default |
| Sizes              | Up to {{max-vcpu}} vCPUs and {{max-memory}} paid, chosen apart                    | Up to 16 vCPUs, 64 GiB and 128 GiB of disk         |
| Pause and fork     | Files, memory and processes; forks of a running sandbox                           | Snapshots and forks listed as coming soon          |
| At once            | {{paid-sandboxes}} on a paid account; {{new-account-sandboxes}} in its first week | 1,024 per account to start                         |
| Plan fee           | None; prepaid credit from {{topup-min}}                                           | None; rates published through 22 December 2026     |
| Free start         | {{trial-hours}} sandbox hours, no card                                            | None published                                     |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model. Prime's sandbox keeps its default 5 GiB disk.

```
Runtime  CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}          = {{part:runtime:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}}     = {{part:runtime:memory}}
         Total                                            {{cost:runtime}}

Prime    CPU    1,000 × 60 s / 3,600 × 2 × {{rate:prime:cpu}}       = {{part:prime:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{rate:prime:memory}}     = {{part:prime:memory}}
         Disk   1,000 × 60 s / 3,600 × 5 × {{rate:prime:disk}}     = {{part:prime:disk}}
         Total                                            {{cost:prime}}
```

- **Saving:** {{saving:prime}}, or {{less:prime}} per 1,000 runs.
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:prime:100000}} on Prime.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on Runtime
  against {{cost:prime}} on Prime. At this size Runtime is cheaper however busy the
  sandbox is.

Network, taxes and free allowances are left out of both. On Runtime, inbound
traffic is free, and each account's first {{outbound-allowance}} out a month is free, then
{{outbound-rate}} per GB. See [pricing](./pricing) for Runtime's terms.

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
  at {{new-account-sandboxes}}, and raises it on request.
- **Training on Prime Intellect.** Prime Sandboxes are built for agentic RL
  training on Prime's own platform, and Prime Tunnels reach inference running
  on its cluster nodes.

## Sources

Checked 25 September 2026.

- [Prime Sandboxes overview](https://docs.primeintellect.ai/sandboxes/overview)
- [Prime Sandboxes launch](https://www.primeintellect.ai/blog/sandboxes)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
