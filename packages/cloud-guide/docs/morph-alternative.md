# Runtime vs Morph

Runtime runs each agent sandbox in its own microVM. For an agent that mostly waits on a model, it costs **{{saving:morph}} less than Morph**.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:morph}} on Morph**. At 100,000 runs a month, that is {{cost:runtime:100000}} against
{{cost:morph:100000}}, **{{=$0 less:morph:100000}} a month saved**.

Comparing more than two providers? [Morph Cloud alternatives](/compare/morph-alternatives) ranks the other providers by the cost of the same job.

## Where Runtime is better

- **You pay for the CPU you use.** Morph bills a machine's full size in MCUs for
  as long as it runs. Runtime measures the CPU your code actually uses. Time
  spent waiting on a model costs only a small floor, {{cpu-floor-share}}.
- **Idle time bills only storage.** A Runtime sandbox pauses itself after
  {{idle-pause}} with nothing happening in it. It keeps its memory and processes.
  The next command runs {{server-wake-command}} after the request that wakes it
  reaches Runtime. While paused, the sandbox pays {{paused-storage-rate}} per GB (10⁹ bytes)
  of saved state a month.
- **A written uptime promise.** Paid accounts get {{uptime-promise}} API uptime a month,
  measured from outside. If a month falls short, {{uptime-credit}} of that month's charges
  is returned as credit automatically ([Uptime Promise](/legal/sla)).
- **Cheaper even when busy.** With both CPUs working the whole time, the example
  job costs {{cost:runtime:busy}} on Runtime and {{cost:morph}} on Morph.
- **CPU and memory priced apart.** One MCU covers 1 vCPU, 4 GB of memory or
  16 GB of disk. A machine pays for whichever it needs most. On Runtime, you choose
  vCPUs and memory separately and pay for each.
- **No plan fee.** Morph's plans with included credit cost {{term:morph:team}} or {{term:morph:scale}} a month.
  Runtime is prepaid credit from {{topup-min}}, with {{included-machine}} in the first 30 days.
- **Secrets stay outside the sandbox.** Code inside sees a placeholder. The
  real key is added at the egress proxy, only on HTTPS to the hosts you allow
  ([security](./security)).
- **Your agent sets itself up.** It runs `npx withruntime sandboxes run -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file. The [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Give an agent a read-only key or a daily spending
  limit per key. Cap any sandbox's total cost with `maxTotalCostMicros`. Every write takes an
  idempotency key, so a lost response never creates a second sandbox.

**Also included:** a code interpreter, network allow and deny lists, custom
images, volumes backed up daily, snapshots and forks with memory, private
previews, a Linux desktop, metrics, webhooks, OpenTelemetry export, S3, R2 and
GCS bucket mounts, MCP servers from a catalog, identity tokens for AWS and
Google Cloud, and free single sign-on. Paid accounts add custom domains, TCP
ports, dedicated outbound addresses and WireGuard private networks. See
[products](./products).

## At a glance

Morph's figures come from its public pricing and product pages. Last checked
{{checked:morph}}.

|                  | Runtime                                                        | Morph                                                                                          |
| ---------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Isolation        | Firecracker microVM, own kernel                                | Full virtual machines                                                                          |
| CPU billing      | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor | {{rate:morph:unit}} per MCU-hour for the machine's size                                        |
| Memory billing   | {{memory-rate}} per reserved GiB-hour                          | Inside the MCU: 4 GB per MCU                                                                   |
| Plan fee         | None; prepaid credit from {{topup-min}}                        | Developer free with no credit; Team {{term:morph:team}} and Scale {{term:morph:scale}} a month |
| Free start       | {{included-machine}} in the first 30 days, no card             | 1,000 MCUs with the {{term:morph:team}} Team plan                                              |
| Snapshots, forks | Files, memory and running processes                            | Memory and disk; branches to many replicas                                                     |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds. This is an agent that spends most of its time
waiting for a model. On Morph, 2 vCPUs and 4 GB is 2 MCUs an hour.

```
Runtime  CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}      = {{part:runtime:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}} = {{part:runtime:memory}}
         Total                                        {{cost:runtime}}

Morph    Size   1,000 × 60 s / 3,600 × 2 MCU × {{rate:morph:unit}} = {{part:morph:size}}
```

- **Saving:** {{saving:morph}}, or {{less:morph}} per 1,000 runs.
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:morph:100000}} on Morph.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on Runtime
  against {{cost:morph}} on Morph.

Plan fees, included credit, storage, network and taxes are excluded from both. On
Runtime, inbound traffic is free. Each account's first {{outbound-allowance}} out a month
is free, then {{outbound-rate}} per GB (10⁹ bytes). See [pricing](./pricing) for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Morph calls on a branch, tests them on the free usage, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

Or keep your Morph code and change one import:

```ts no-run
import { MorphCloudClient } from "withruntime/morph"; // was "morphcloud"
const client = new MorphCloudClient();
const snapshot = await client.snapshots.create({ vcpus: 2, memory: 4096, diskSize: 8192 });
const ready = await snapshot.setup("pip install pandas"); // cached after the first run
const instance = await client.instances.start({ snapshotId: ready.id });
console.log((await instance.exec("python3 -c 'import pandas; print(pandas.__version__)'")).stdout);
const { instances } = await instance.branch(4); // four copies, memory included
```

In Python, change `morphcloud` to `withruntime.morph`:

```python no-run
from withruntime.morph import MorphCloudClient  # was: from morphcloud import MorphCloudClient
client = MorphCloudClient()
snapshot = client.snapshots.create(vcpus=2, memory=4096, disk_size=8192)
ready = snapshot.setup("pip install pandas")  # cached after the first run
with client.instances.start(ready.id) as instance:
    print(instance.exec("python3 -c 'import pandas; print(pandas.__version__)'").stdout)
    branched, copies = instance.branch(4)  # four copies, memory included
```

Runtime's own SDK:

```ts
import { Sandbox } from "withruntime";
const box = await Sandbox.create();
try {
  await box.files.write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n");
  console.log((await box.exec("python3 /workspace/invoice.py", { check: true })).stdout);
} finally {
  await box.stop();
}
```

## When Morph may fit better

- **Branching at scale.** Morph's Infinibranch branches a running machine,
  memory included, to hundreds of parallel replicas.
- **Development environments for people.** Morph Devboxes are shareable
  workspaces. They scale to zero when idle and keep their memory.

## Sources

Checked 23 September 2026; plan names and included MCUs reread 17 October 2026.

- [Morph Cloud pricing](https://cloud.morph.so/web/pricing)
- [Morph Devboxes](https://cloud.morph.so/web/product/devboxes)
- [Morph snapshots](https://cloud.morph.so/docs/documentation/instances/creating-snapshot)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
