# Runtime vs Northflank

Runtime is built for agent sandboxes and costs **{{saving:northflank}} less than Northflank** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:northflank}} on Northflank**. At 100,000 runs a month that is {{cost:runtime:100000}}
against {{cost:northflank:100000}}, **{{=$0 less:northflank:100000}} a month saved**.

Weighing more than two? [Northflank alternatives](/compare/northflank-alternatives) ranks the other providers by the cost of the same job.

## Where Runtime is better

- **You pay for the CPU you use.** Northflank bills the vCPUs and memory a
  sandbox holds for as long as it runs. Runtime measures the CPU your code
  actually uses, so time spent waiting on a model costs only a small floor, {{cpu-floor-share}}.
- **It pauses itself when idle.** After {{idle-pause}} with no request, command,
  connection, traffic or CPU use, a Runtime sandbox pauses and pays only paused
  storage, {{paused-storage-rate}} per GB a month. The next request wakes it with its
  processes still running and its next command done {{server-wake-command}}
  after the request reaches Runtime.
- **An uptime promise that pays itself.** Paid accounts are promised
  {{uptime-promise}} API uptime each month; a month below it returns {{uptime-credit}} of that
  month's charges as credit, with no claim to file ([Uptime Promise](/legal/sla)).
- **Cheaper memory.** {{memory-rate}} per GiB-hour on Runtime against {{rate:northflank:memory}} per
  GB-hour on Northflank, and a GiB is about 7% larger than a GB.
- **A sandbox is one call.** `Sandbox.create()` returns a running sandbox, with
  no service, project or deployment plan to set up. Northflank creates each
  sandbox as a service.
- **Pause and fork keep memory.** A paused Runtime sandbox wakes with its
  processes still running, kept for 1 to 365 days, and a fork copies a running
  sandbox with its memory.
- **Teams at no extra charge.** Single sign-on over SAML or OIDC (Okta,
  Microsoft Entra ID, Google Workspace), SCIM, roles and an audit log come with
  every account ([single sign-on](./single-sign-on)). Northflank lists SAML and OIDC
  sign-in on its Enterprise plan.
- **A fixed outbound address on any paid account.** Every sandbox of the
  account sends from one dedicated address you can allow-list, for
  {{address-month}} a month ([dedicated addresses](./networking#dedicated-outbound-addresses)).
  Northflank lists egress IPs on its Enterprise plan.
- **Keys the sandbox never sees.** Store an API key once; the sandbox holds a
  placeholder and Runtime's proxy adds the value only to HTTPS requests to the
  hosts you name, so a prompt injection has nothing to leak ([security](./security)).
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Give an agent a read-only key or a daily spending
  limit per key, and cap any create with `maxCostMicros`. Every write takes an
  idempotency key, so a lost response never creates a second sandbox.

**Also included:** a code interpreter, network allow and deny lists, custom
images, volumes backed up daily, private previews, a Linux desktop, metrics,
webhooks, OpenTelemetry export, S3, R2 and GCS bucket mounts, MCP servers from a
catalog and identity tokens for AWS and Google Cloud. Paid accounts add custom
domains, TCP ports and WireGuard private networks. See [products](./products).

## At a glance

Northflank's figures come from its public pricing and documentation, checked
{{checked:northflank}}.

|                | Runtime                                                        | Northflank                                        |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| Isolation      | Firecracker microVM, own kernel                                | A microVM per workload, Kata Containers or gVisor |
| CPU billing    | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor | {{rate:northflank:cpu}} per allocated vCPU-hour   |
| Memory billing | {{memory-rate}} per reserved GiB-hour                          | {{rate:northflank:memory}} per GB-hour            |
| Plan fee       | None; prepaid credit from {{topup-min}}                        | None published for compute                        |
| Free start     | {{trial-hours}} sandbox hours, no card                         | 2 free services and 1 free database               |
| Sandbox model  | A sandbox, created in one call                                 | A service with a deployment plan                  |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox (4 GB on Northflank). Each run lasts
60 seconds and keeps the CPU busy for 20 CPU-seconds: an agent that spends most
of its time waiting for a model.

```
Runtime     CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}        = {{part:runtime:cpu}}
            Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}}   = {{part:runtime:memory}}
            Total                                          {{cost:runtime}}

Northflank  CPU    1,000 × 60 s / 3,600 × 2 × {{rate:northflank:cpu}}  = $0.556
            Memory 1,000 × 60 s / 3,600 × 4 × {{rate:northflank:memory}}  = $0.555
            Total                                          {{cost:northflank}}
```

- **Saving:** {{saving:northflank}}, or {{less:northflank}} per 1,000 runs.
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:northflank:100000}} on
  Northflank.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on Runtime
  against {{cost:northflank}} on Northflank.

The more of its time an agent spends waiting, the more Runtime saves. Storage,
network, taxes and free allowances are left out of both. On Runtime, inbound
traffic is free, and each account's first {{outbound-allowance}} out a month is free, then
{{outbound-rate}} per GB. See [pricing](./pricing) for Runtime's terms.

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
  await box.files.write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n");
  console.log((await box.exec("python3 /workspace/invoice.py", { check: true })).stdout);
} finally {
  await box.stop();
}
```

## When Northflank may fit better

- **Work that keeps every CPU busy.** Northflank's allocated vCPU rate is lower
  than Runtime's measured rate, so a job that uses all its CPUs all the time
  costs less there: {{cost:northflank:busy}} against {{cost:runtime:busy}} in the example.
- **GPUs.** Northflank rents GPUs by the hour, including L4, A100 and H100.
- **Your own cloud and many regions.** Northflank runs in your AWS, GCP or Azure
  account as well as its own regions. Runtime runs in one US region.

## Sources

Checked 23 September 2026; isolation rechecked 25 September 2026; single
sign-on and egress IPs checked 27 September 2026.

- [Northflank pricing](https://northflank.com/pricing)
- [Northflank sandboxes](https://northflank.com/product/sandboxes)
- [Sandboxes on Northflank](https://northflank.com/docs/v1/application/sandboxes/sandboxes-on-northflank)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
