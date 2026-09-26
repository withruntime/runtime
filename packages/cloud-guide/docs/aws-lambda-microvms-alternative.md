# Runtime vs AWS Lambda MicroVMs

Runtime runs agent code in Firecracker microVMs, like Lambda MicroVMs, and costs **85% less** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **$0.64 on
Runtime and $4.20 on Lambda MicroVMs**. At 100,000 runs a month that is $63.89
against $420.33, **$356 a month saved**, with no AWS account, IAM role or VPC to
set up first.

## Where Runtime is better

- **You pay for the CPU you use.** Lambda MicroVMs bill the baseline vCPUs and
  memory for every second a MicroVM runs, busy or not. Runtime measures the CPU
  your code actually uses, so time spent waiting on a model costs only a small
  floor, a twentieth of a vCPU.
- **Lower rates on both meters.** $0.025 per vCPU-hour against about $0.0997,
  and $0.0075 per GiB-hour of memory against about $0.0132 per GB-hour. With
  both CPUs busy the whole time, the example job still costs $1.33 on Runtime
  and $4.20 on Lambda MicroVMs.
- **Bigger sandboxes.** A paid Runtime sandbox takes up to 16 vCPUs and 64 GiB,
  with memory chosen apart from CPU. A MicroVM's baseline tops out at 4 vCPUs
  and 8 GB, always 2 GB per vCPU.
- **Sessions that last.** A MicroVM keeps its state for up to 8 hours. A Runtime
  sandbox runs as long as you extend its lease, or stays up with
  `persistent: true`, and a paused one keeps its memory for 1 to 365 days.
- **Fork a running machine.** A Runtime fork copies a sandbox as it is now,
  memory and processes included, into up to 10 running copies.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No access key
  goes into a prompt or a config file, and the [MCP server](./mcp) reuses the
  same connection.
- **Guardrails for agents.** Read-only keys, a daily spending limit per key and
  `maxCostMicros` on each create keep an agent inside its budget, and every
  write takes an idempotency key.

## At a glance

Lambda MicroVMs' figures come from AWS's public pricing and product pages,
checked 25 September 2026. Rates are for Arm (Graviton) in US East (N. Virginia).

|                | Runtime                                                  | AWS Lambda MicroVMs                                  |
| -------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| Isolation      | Firecracker microVM, own kernel                          | Firecracker microVM                                  |
| CPU billing    | $0.025 per vCPU-hour of measured CPU, with a small floor | $0.0000276944 per baseline vCPU-second while running |
| Memory billing | $0.0075 per reserved GiB-hour                            | $0.0000036667 per baseline GB-second while running   |
| Sizes          | Up to 16 vCPUs and 64 GiB paid, chosen apart             | Baseline up to 4 vCPUs and 8 GB, 2 GB per vCPU       |
| Session length | Leases extended as needed, or `persistent`               | State kept up to 8 hours                             |
| Suspend        | Files, memory and processes, kept 1 to 365 days          | Memory and disk in a snapshot, at $0.08 per GB-month |
| Free start     | 100 sandbox hours, no card                               | No free tier for MicroVMs                            |
| Plan fee       | None; prepaid credit from $10                            | None; an AWS account                                 |
| Agent sign-in  | Browser approval; no key in the agent's config           | AWS credentials and IAM                              |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox (a 2 vCPU, 4 GB baseline on Lambda
MicroVMs). Each run lasts 60 seconds and keeps the CPU busy for 20 CPU-seconds:
an agent that spends most of its time waiting for a model.

```
Runtime  CPU    1,000 × 20 s / 3,600 × $0.025                 = $0.14
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0075            = $0.50
         Total                                                   $0.64

Lambda   CPU    1,000 × 60 s × 2 × $0.0000276944              = $3.32
         Memory 1,000 × 60 s × 4 × $0.0000036667              = $0.88
         Total                                                   $4.20
```

- **Saving:** 85%, or $3.56 per 1,000 runs.
- **Per month:** at 100,000 runs, $63.89 on Runtime against $420.33 on Lambda
  MicroVMs.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on Runtime
  against $4.20 on Lambda. At this size Runtime is cheaper however busy the
  sandbox is.

Snapshot storage and its reads and writes, data transfer, taxes and credits are
left out of both. See [pricing](./pricing) for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the MicroVM calls on a branch, tests them on the free trial, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

A MicroVM image built from a container image maps to a
[custom image](./images) built from the same Dockerfile, and a MicroVM's HTTPS
endpoint maps to a [preview](./javascript#share-a-port):

```ts check
import { Sandbox } from "withruntime";

const box = await Sandbox.create({ funding: "trial" });
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
  Network Connector and is governed by the IAM policies you already run.
- **Many regions.** AWS runs Lambda in regions worldwide. Runtime runs in one US
  region.
- **Arm code.** MicroVMs run on Graviton. Runtime sandboxes are x86-64.

## Sources

Checked 25 September 2026.

- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- [Lambda MicroVMs](https://aws.amazon.com/lambda/lambda-microvms/)
- [Announcing Lambda MicroVMs](https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
