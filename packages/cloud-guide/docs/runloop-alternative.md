# Runtime vs Runloop

Runtime runs agent code in microVMs, like Runloop's devboxes, and costs **{{saving:runloop}} less** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:runloop}} on Runloop**. At 100,000 runs a month that is {{cost:runtime:100000}} against
{{cost:runloop:100000}}, **{{=$0 less:runloop:100000}} a month saved**.

## Where Runtime is better

- **You pay for the CPU you use.** Runloop bills a devbox's CPUs and memory for
  as long as it runs. Runtime measures the CPU your code actually uses, so time
  spent waiting on a model costs only a small floor, {{cpu-floor-share}}.
- **Idle time bills only storage.** A Runtime sandbox pauses itself after
  {{idle-pause}} with nothing happening in it, keeps its memory and processes,
  and runs its next command {{wake}} after the request that wakes it. Paused, it
  pays {{paused-storage-rate}} per GB of saved state a month.
- **An uptime promise that pays itself.** Paid accounts are promised
  {{uptime-promise}} API uptime each month; a month below it returns {{uptime-credit}} of that
  month's charges as credit, with no claim to file ([Uptime Promise](/legal/sla)).
- **Lower rates on every meter.** {{cpu-rate}} per vCPU-hour against Runloop's
  {{rate:runloop:cpu}} per CPU-hour, and {{memory-rate}} per GiB-hour of memory against {{rate:runloop:memory}} per
  GB-hour. Even with both CPUs busy the whole time, the example job costs {{cost:runtime:busy}}
  on Runtime and {{cost:runloop:busy}} on Runloop.
- **Pause keeps memory, on every account.** A paused Runtime sandbox wakes
  with its processes still running, kept for 1 to 365 days. A suspended Runloop
  devbox keeps only its disk, its processes must be restarted, and suspend and
  resume come with Runloop's Pro plan.
- **Forks of a running sandbox.** Copy a sandbox with its memory and running
  processes, and try several things from exactly that point.
- **No plan fee.** Runloop's Pro plan is {{term:runloop:pro}} a month plus usage. Runtime is
  prepaid credit from {{topup-min}}, with {{trial-hours}} free sandbox hours to start.
- **Teams at no extra charge.** Single sign-on over SAML or OIDC (Okta,
  Microsoft Entra ID, Google Workspace), SCIM, roles and an audit log come with
  every account ([single sign-on](./single-sign-on)).
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.

**Also included:** a code interpreter, network allow and deny lists, secrets the
sandbox never sees, custom images, volumes backed up daily, private previews, a
Linux desktop, metrics, webhooks, OpenTelemetry export, S3, R2 and GCS bucket
mounts, MCP servers from a catalog and identity tokens for AWS and Google Cloud.
Paid accounts add custom domains, TCP ports, dedicated outbound addresses and
WireGuard private networks. See [products](./products).

## At a glance

Runloop's figures come from its public pricing and documentation, checked
{{checked:runloop}}.

|                 | Runtime                                                        | Runloop                                                 |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| Isolation       | Firecracker microVM, own kernel                                | microVM, with a container inside                        |
| CPU billing     | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor | {{rate:runloop:cpu}} per CPU-hour while the devbox runs |
| Memory billing  | {{memory-rate}} per reserved GiB-hour                          | {{rate:runloop:memory}} per GB-hour                     |
| Disk            | Included while running                                         | {{rate:runloop:disk}} per GB-hour                       |
| Plan fee        | None; prepaid credit from {{topup-min}}                        | Basic free; Pro {{term:runloop:pro}} a month plus usage |
| Free start      | {{trial-hours}} sandbox hours, no card                         | {{term:runloop:credit}} of credit, no card              |
| Suspend, resume | Pause keeps files, memory and processes                        | Suspend keeps the disk; processes restart               |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model. On Runloop that is the `MEDIUM` devbox: 2 CPUs, 4 GB and
8 GB of disk.

```
Runtime  CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}           = {{part:runtime:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}}      = {{part:runtime:memory}}
         Total                                             {{cost:runtime}}

Runloop  CPU    1,000 × 60 s / 3,600 × 2 × {{rate:runloop:cpu}}       = {{part:runloop:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{rate:runloop:memory}}      = {{part:runloop:memory}}
         Disk   1,000 × 60 s / 3,600 × 8 × {{rate:runloop:disk}} = {{part:runloop:disk}}
         Total                                             {{cost:runloop}}
```

- **Saving:** {{saving:runloop}}, or {{less:runloop}} per 1,000 runs.
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:runloop:100000}} on Runloop.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on Runtime
  against {{cost:runloop}} on Runloop.

Plan fees, storage while suspended, network, taxes and free credit are left out
of both. On Runtime, inbound traffic is free, and each account's first {{outbound-allowance}}
out a month is free, then {{outbound-rate}} per GB. See [pricing](./pricing) for Runtime's
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
- **Your own cloud.** Runloop deploys into your cloud account.

## Sources

Checked 23 September 2026; plan features checked 27 September 2026.

- [Runloop pricing](https://www.runloop.ai/pricing)
- [Devbox sizes](https://docs.runloop.ai/docs/devboxes/configuration/sizes)
- [Devbox lifecycle](https://docs.runloop.ai/docs/devboxes/lifecycle)
- [Runloop](https://www.runloop.ai/)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
