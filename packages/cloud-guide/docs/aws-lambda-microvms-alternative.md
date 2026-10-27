# Runtime vs AWS Lambda MicroVMs

Runtime runs agent code in Firecracker microVMs, like Lambda MicroVMs. For an agent that mostly waits on a model, it costs **{{saving:lambda-microvms}} less**.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:lambda-microvms}} on Lambda MicroVMs**. At 100,000 runs a month, that is {{cost:runtime:100000}}
against {{cost:lambda-microvms:100000}}, **{{=$0 less:lambda-microvms:100000}} a month saved**. Runtime needs no AWS account, IAM role or VPC set up first.

Comparing more than two providers? [AWS Lambda MicroVMs alternatives](/compare/aws-lambda-microvms-alternatives) ranks the other providers by the cost of the same job.

## Where Runtime is better

- **You pay for the CPU you use.** Lambda MicroVMs bill the baseline vCPUs and
  memory for every second a MicroVM runs, busy or not. Runtime measures the CPU
  your code actually uses. Time spent waiting on a model costs only a small
  floor, {{cpu-floor-share}}.
- **Idle time bills only storage.** A Runtime sandbox pauses itself after {{idle-pause}}
  with nothing happening in it. It keeps its memory and processes. While paused, it pays
  {{paused-storage-rate}} per GB (10⁹ bytes) of saved state a month.
- **An uptime promise that pays itself.** Paid accounts get
  {{uptime-promise}} API uptime each month. A month below that returns {{uptime-credit}} of that
  month's charges as credit. No claim is needed ([Uptime Promise](/legal/sla)).
- **Lower rates on both meters.** {{cpu-rate}} per vCPU-hour, against about {{=$4 rate:lambda-microvms:cpu}},
  and {{memory-rate}} per GiB-hour of memory, against about {{=$4 rate:lambda-microvms:memory}} per GB-hour. With
  both CPUs busy the whole time, the example job still costs {{cost:runtime:busy}} on Runtime
  and {{cost:lambda-microvms}} on Lambda MicroVMs.
- **Bigger sandboxes.** A paid Runtime sandbox takes up to {{max-vcpu}} vCPUs and {{max-memory}}.
  Memory is chosen apart from CPU. A MicroVM's baseline tops out at 4 vCPUs
  and 8 GB, always 2 GB per vCPU.
- **Sessions that last.** A MicroVM keeps its state for up to 8 hours. A Runtime
  sandbox has no time limit. It runs while it works, or stays up idle with
  `persistent: true`. A paused one keeps its memory while you have credit.
- **Fork a running machine.** A Runtime fork copies a sandbox as it is now,
  memory and processes included, into up to {{fork-copies}} running copies.
- **Keys the sandbox never sees.** Store an API key once. The sandbox holds a
  placeholder. Runtime's proxy adds the value only to HTTPS requests to the
  hosts you name, so a prompt injection has nothing to leak ([security](./security)).
- **Your agent sets itself up.** It runs `npx withruntime sandboxes run -- ...`,
  shows you a link, and starts once you approve in the browser. No access key
  goes into a prompt or a config file. The [MCP server](./mcp) reuses the
  same connection.
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

Lambda MicroVMs' figures come from AWS's public pricing and product pages.
Last checked {{checked:lambda-microvms}}. Rates are for Arm (Graviton) in US East (N. Virginia).

|                | Runtime                                                        | AWS Lambda MicroVMs                                                                  |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Isolation      | Firecracker microVM, own kernel                                | Firecracker microVM                                                                  |
| CPU billing    | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor | {{=$10 rate:lambda-microvms:cpu / 3600}} per baseline vCPU-second while running      |
| Memory billing | {{memory-rate}} per reserved GiB-hour                          | {{=$10 rate:lambda-microvms:memory / 3600}} per baseline GB-second while running     |
| Sizes          | Up to {{max-vcpu}} vCPUs and {{max-memory}} paid, chosen apart | Baseline up to 4 vCPUs and 8 GB, 2 GB per vCPU                                       |
| Session length | No time limit: runs while it works, or `persistent`            | State kept up to 8 hours                                                             |
| Suspend        | Files, memory and processes, kept while you have credit        | Memory and disk in a snapshot, at {{paused-storage-rate}} per GB (10⁹ bytes) a month |
| Free start     | {{included-machine}} in the first 30 days, no card             | No free tier for MicroVMs                                                            |
| Plan fee       | None; prepaid credit from {{topup-min}}                        | None; an AWS account                                                                 |
| Agent sign-in  | Browser approval; no key in the agent's config                 | AWS credentials and IAM                                                              |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox (a 2 vCPU, 4 GB baseline on Lambda
MicroVMs). Each run lasts 60 seconds and keeps the CPU busy for 20 CPU-seconds.
This is an agent that spends most of its time waiting for a model.

```
Runtime  CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}                 = {{part:runtime:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}}            = {{part:runtime:memory}}
         Total                                                   {{cost:runtime}}

Lambda   CPU    1,000 × 60 s × 2 × {{=$10 rate:lambda-microvms:cpu / 3600}}              = {{part:lambda-microvms:cpu}}
         Memory 1,000 × 60 s × 4 × {{=$10 rate:lambda-microvms:memory / 3600}}              = {{part:lambda-microvms:memory}}
         Total                                                   {{cost:lambda-microvms}}
```

- **Saving:** {{saving:lambda-microvms}}, or {{less:lambda-microvms}} per 1,000 runs.
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:lambda-microvms:100000}} on Lambda
  MicroVMs.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on Runtime
  against {{cost:lambda-microvms}} on Lambda. At this size, Runtime is cheaper however busy the
  sandbox is.

Snapshot storage and its reads and writes, data transfer, taxes and credits are
excluded from both. On Runtime, inbound traffic is free. Each account's first
{{outbound-allowance}} out a month is free, then {{outbound-rate}} per GB (10⁹ bytes). See [pricing](./pricing) for
Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the MicroVM calls on a branch, tests them on the free usage, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

A MicroVM image built from a container image maps to a
[custom image](./images) built from the same Dockerfile. A MicroVM's HTTPS
endpoint maps to a [preview](./javascript#share-a-port):

```ts check
import { Sandbox } from "withruntime";

const box = await Sandbox.create();
try {
  await box.spawn("python3 -m http.server 8080");
  const preview = await box.previews.create(8080);
  console.log(preview.urlWithToken);
} finally {
  await box.stop();
}
```

## When Lambda MicroVMs may fit better

- **Everything else is on AWS.** A MicroVM reaches your VPC through the Lambda
  Network Connector. It is governed by the IAM policies you already run.
- **Many regions.** AWS runs Lambda in regions worldwide. Runtime runs in one US
  region.
- **Arm code.** MicroVMs run on Graviton. Runtime sandboxes are x86-64.

## Sources

Checked 26 October 2026.

- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- [Lambda MicroVMs](https://aws.amazon.com/lambda/lambda-microvms/)
- [Announcing Lambda MicroVMs](https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
