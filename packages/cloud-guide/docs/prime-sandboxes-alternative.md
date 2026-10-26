# Runtime vs Prime Sandboxes

Runtime and Prime Sandboxes both give every sandbox a microVM with its own kernel. For an agent that mostly waits on a model, Runtime costs **{{saving:prime}} less**. Runtime can also pause and fork today.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:prime}} on Prime Sandboxes**. At 100,000 runs a month, that is {{cost:runtime:100000}}
against {{cost:prime:100000}}, **{{=$0 less:prime:100000}} a month saved**.

Comparing more than two providers? [Prime Sandboxes alternatives](/compare/prime-sandboxes-alternatives) ranks the other providers by the cost of the same job.

## Where Runtime is better

- **You pay for the CPU you use.** Prime bills the vCPUs, memory and disk a
  sandbox is given for as long as it runs. Runtime measures the CPU your code
  actually uses. Time spent waiting on a model costs only a small floor, {{cpu-floor-share}}. Even with both CPUs busy the whole minute, the example
  job costs {{cost:runtime:busy}} on Runtime and {{cost:prime}} on Prime.
- **Waiting costs storage, not compute.** Left idle for {{idle-pause}}, a Runtime
  sandbox pauses by itself with its memory kept. While paused, it pays {{paused-storage-rate}} per GB (10⁹ bytes) a
  month until a request wakes it. The next command runs {{server-wake-command}} after that, timed on
  Runtime's servers.
- **A written uptime promise.** Paid accounts get {{uptime-promise}} API uptime a month,
  measured from outside. If a month falls short, {{uptime-credit}} of that month's charges
  is returned as credit automatically ([Uptime Promise](/legal/sla)).
- **Cheaper memory.** {{memory-rate}} per GiB-hour, against Prime's {{rate:prime:memory}}. Memory
  is most of what an agent sandbox costs while it waits.
- **Pause and fork with memory.** A paused Runtime sandbox keeps its memory and
  running processes while you have credit. A fork copies a running sandbox into
  up to {{fork-copies}} copies. Prime's checkpoints and forks save the
  filesystem only: processes start fresh and nothing in memory carries over.
- **Prices that do not lapse.** Prime's published rates hold through
  22 December 2026. Runtime's rates are fixed in each resource's quote. There is
  no plan fee: prepaid credit from {{topup-min}}.
- **Secrets stay outside the sandbox.** Code inside sees a placeholder. The
  real key is added at the egress proxy, only on HTTPS to the hosts you allow
  ([security](./security)).
- **Your agent sets itself up.** It runs `npx withruntime sandboxes run -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file. The [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Read-only keys, a daily spending limit per key and
  `maxTotalCostMicros` on each sandbox keep an agent inside its budget. Every
  write takes an idempotency key.

**Also included:** a code interpreter, network allow and deny lists, custom
images, volumes backed up daily, private previews, a Linux desktop, metrics,
webhooks, OpenTelemetry export, S3, R2 and GCS bucket mounts, MCP servers from a
catalog, identity tokens for AWS and Google Cloud, and free single sign-on. Paid
accounts add custom domains, TCP ports, dedicated outbound addresses and
WireGuard private networks. See [products](./products).

## At a glance

Prime's figures come from its sandbox documentation and launch post. Last checked
{{checked:prime}}.

|                      | Runtime                                                        | Prime Sandboxes                                    |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| Isolation            | Firecracker microVM, own kernel                                | Hardware-virtualized microVM, own guest kernel     |
| CPU billing          | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor | {{rate:prime:cpu}} per vCPU-hour while running     |
| Memory billing       | {{memory-rate}} per reserved GiB-hour                          | {{rate:prime:memory}} per GiB-hour while running   |
| Disk while it runs   | Included                                                       | {{rate:prime:disk}} per GiB-hour; 5 GiB by default |
| Sizes                | Up to {{max-vcpu}} vCPUs and {{max-memory}} paid, chosen apart | Up to 16 vCPUs, 64 GiB and 128 GiB of disk         |
| Pause and fork       | Files, memory and processes; forks of a running sandbox        | Filesystem checkpoints and forks; no memory        |
| Concurrent sandboxes | {{paid-sandboxes}} on a paid account                           | 1,024 per account to start                         |
| Plan fee             | None; prepaid credit from {{topup-min}}                        | None; rates published through 22 December 2026     |
| Free start           | {{included-machine}} in the first 30 days, no card             | None published                                     |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds. This is an agent that spends most of its time
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
  against {{cost:prime}} on Prime. At this size, Runtime is cheaper however busy the
  sandbox is.

Network, taxes and free allowances are excluded from both. On Runtime, inbound
traffic is free. Each account's first {{outbound-allowance}} out a month is free, then
{{outbound-rate}} per GB (10⁹ bytes). See [pricing](./pricing) for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Prime calls on a branch, tests them on the free usage, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

An RL rollout that sets up an environment once and runs many episodes from it
is a good fit for a fork. Install once, then start every episode from the same
running machine.

```ts check
import { Sandbox } from "withruntime";

await using base = await Sandbox.create();
await base.exec("pip install --quiet numpy");
const episodes = await base.fork({ count: 4 }); // four running copies, memory included
await Promise.all(episodes.map((episode) => episode.stop()));
```

## When Prime Sandboxes may fit better

- **Thousands running at the same time from day one.** An account starts at 1,024 active
  sandboxes and 4,096 vCPUs. A paid Runtime account runs 100, and raises it on request.
- **Training on Prime Intellect.** Prime Sandboxes are built for agentic RL
  training on Prime's own platform. Prime Tunnels reach inference running
  on its cluster nodes.

## Sources

Checked 26 October 2026.

- [Prime Sandboxes overview](https://docs.primeintellect.ai/sandboxes/overview)
- [Prime Sandboxes launch](https://www.primeintellect.ai/blog/sandboxes)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
