# Runtime vs Freestyle

Runtime runs agent code in its own microVMs, like Freestyle's VMs, and costs **{{saving:freestyle}} less** for an agent that mostly waits on a model, with no plan to buy for more at once.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:freestyle}} on Freestyle**. At 100,000 runs a month that is {{cost:runtime:100000}}
against {{cost:freestyle:100000}}, **{{=$0 less:freestyle:100000}} a month saved**.

## Where Runtime is better

- **You pay for the CPU you use.** Freestyle bills the vCPUs, memory and disk
  allocated to a VM for as long as it is allocated; its pricing page says a
  reserved core is yours whether or not the guest is busy. Runtime measures the
  CPU your code actually uses, so time spent waiting on a model costs only a
  small floor, {{cpu-floor-share}}.
- **It pauses itself when idle.** After {{idle-pause}} with no request, command,
  connection, traffic or CPU use, a Runtime sandbox pauses and pays only paused
  storage, {{paused-storage-rate}} per GB a month. The next request wakes it with its
  processes still running and its next command done {{wake}} later.
- **A written uptime promise.** {{uptime-promise}} API uptime a month for paid accounts,
  measured from outside, and {{uptime-credit}} of a short month's charges back as credit
  automatically ([Uptime Promise](/legal/sla)).
- **Lower rates on both meters.** {{cpu-rate}} per vCPU-hour against {{rate:freestyle:cpu}}, and {{memory-rate}} per GiB-hour of memory against {{rate:freestyle:memory}}. With both CPUs busy the whole
  time, the example job costs {{cost:runtime:busy}} on Runtime and {{cost:freestyle}} on Freestyle.
- **Scale without a plan.** Freestyle runs 10 VMs at once on its free plan, 40
  on the {{term:freestyle:hobby}}-a-month Hobby plan and 400 on the {{term:freestyle:pro}}-a-month Pro plan. A paid
  Runtime account runs {{paid-sandboxes}} sandboxes at once, {{new-account-sandboxes}} in its first week or first {{new-account-spend}}
  of use, with no plan fee: prepaid credit from {{topup-min}}, and support raises the
  limit when you ask.
- **Bigger sandboxes without Pro.** A paid Runtime sandbox takes up to {{max-vcpu}} vCPUs
  and {{max-memory}}. On Freestyle, 64 GiB needs the Pro plan; Hobby stops at 8 vCPUs
  and 16 GiB.
- **Teams at no extra charge.** Single sign-on over SAML or OIDC (Okta,
  Microsoft Entra ID, Google Workspace), SCIM, roles and an audit log come with
  every account ([single sign-on](./single-sign-on)).
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
- **Python and JavaScript.** Runtime has SDKs for both, a CLI and an MCP server.

**Also included:** a code interpreter, network allow and deny lists, custom
images, volumes backed up daily, snapshots and forks with memory, private
previews, a Linux desktop, metrics, webhooks, OpenTelemetry export, S3, R2 and
GCS bucket mounts, MCP servers from a catalog and identity tokens for AWS and
Google Cloud. Paid accounts add custom domains, TCP ports, dedicated outbound
addresses and WireGuard private networks. See [products](./products).

## At a glance

Freestyle's figures come from its public pricing page and VM documentation,
checked {{checked:freestyle}}.

|                    | Runtime                                                                        | Freestyle                                                                                        |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Isolation          | Firecracker microVM, own kernel                                                | Full Linux virtual machines                                                                      |
| CPU billing        | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor                 | {{rate:freestyle:cpu}} per allocated vCPU-hour                                                   |
| Memory billing     | {{memory-rate}} per reserved GiB-hour                                          | {{rate:freestyle:memory}} per allocated GiB-hour                                                 |
| Disk while it runs | Included                                                                       | {{rate:freestyle:disk}} per allocated GiB-hour                                                   |
| Sizes              | Up to {{max-vcpu}} vCPUs and {{max-memory}} paid, chosen apart                 | 4 vCPUs and 8 GiB free; 8 and 16 Hobby; 32 and 64 Pro                                            |
| At once            | {{paid-sandboxes}} paid ({{new-account-sandboxes}} in the first week), no plan | 10 free, 40 Hobby, 400 Pro                                                                       |
| Plan fee           | None; prepaid credit from {{topup-min}}                                        | Free $0; Hobby {{term:freestyle:hobby}} and Pro {{term:freestyle:pro}} a month, counted to usage |
| Free start         | {{trial-hours}} sandbox hours, no card                                         | 200 vCPU-hours and 400 GiB-hours of memory a month                                               |
| Pause              | Files, memory and processes, kept 1 to 365 days                                | Hibernate with memory, billed as storage while paused                                            |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model. Freestyle's VM keeps its default 32 GiB disk.

```
Runtime    CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}              = {{part:runtime:cpu}}
           Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}}         = {{part:runtime:memory}}
           Total                                                {{cost:runtime}}

Freestyle  CPU    1,000 × 60 s / 3,600 × 2 × {{rate:freestyle:cpu}}        = {{part:freestyle:cpu}}
           Memory 1,000 × 60 s / 3,600 × 4 × {{rate:freestyle:memory}}         = {{part:freestyle:memory}}
           Disk   1,000 × 60 s / 3,600 × 32 × {{rate:freestyle:disk}}      = {{part:freestyle:disk}}
           Total                                                {{cost:freestyle}}
```

- **Saving:** {{saving:freestyle}}, or {{less:freestyle}} per 1,000 runs.
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:freestyle:100000}} on
  Freestyle, before any plan fee.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on Runtime
  against {{cost:freestyle}} on Freestyle. At this size Runtime is cheaper however busy the
  sandbox is.

Plan fees, free allowances, data transfer, paused storage and taxes are left out
of both. On Runtime, inbound traffic is free, and each account's first {{outbound-allowance}}
out a month is free, then {{outbound-rate}} per GB. See [pricing](./pricing) for Runtime's
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
  it. A Runtime fork pauses the source for the capture and has it running
  again when the call returns, {{fork}} for one copy.
- **The fastest start.** Freestyle states VMs provision with a p99 under
  400 ms. A Runtime sandbox ran its first command {{first-command}} after the request at
  the median and {{first-command-p95}} at the 95th percentile on {{speed-date}}
  ([speed](./speed)).

## Sources

Checked 25 September 2026.

- [Freestyle pricing](https://www.freestyle.sh/pricing)
- [Freestyle VM pricing and limits](https://www.freestyle.sh/docs/vms/pricing-and-limits)
- [Freestyle VMs](https://www.freestyle.sh/docs/vms)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
