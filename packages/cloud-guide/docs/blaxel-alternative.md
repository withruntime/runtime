# Runtime vs Blaxel

Runtime bills the CPU your agent uses. It costs **{{saving:blaxel}} less than Blaxel** while running an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:blaxel}} on Blaxel**. At 100,000 runs a month that is {{cost:runtime:100000}} against
{{cost:blaxel:100000}}, **{{=$0 less:blaxel:100000}} a month saved**. Your Blaxel sandbox code keeps working. Change
one import.

Comparing more than two? [Blaxel alternatives](/compare/blaxel-alternatives) ranks the other providers by the cost of the same job.

## Where Runtime is better

- **Lower cost while running.** Blaxel bills {{=$7 rate:blaxel:memory / 3600}} per GB of memory per
  second of active time, {{rate:blaxel:memory}} per GB-hour. CPU comes with the memory.
  Runtime charges {{memory-rate}} per GiB-hour of memory and measured CPU at {{cpu-rate}} per
  vCPU-hour.
- **A written uptime promise.** {{uptime-promise}} API uptime a month for paid accounts,
  measured from outside. {{uptime-credit}} of a short month's charges comes back as credit
  automatically ([Uptime Promise](/legal/sla)).
- **Cheaper even when busy.** With both CPUs working the whole time, the example
  job costs {{cost:runtime:busy}} on Runtime and {{cost:blaxel}} on Blaxel.
- **CPU and memory chosen apart.** Blaxel sets a sandbox's CPU from its memory:
  8 GB gets 4 cores. On Runtime you choose vCPUs and memory separately. A
  CPU-heavy job does not pay for memory it does not need.
- **Idle time costs no compute here either.** A Runtime sandbox pauses itself
  after {{idle-pause}} with nothing happening in it, or after as few as 10 if you
  set it. A paused sandbox pays only paused storage. A command still
  running, an open connection, network traffic or CPU use keeps it awake.
- **Cheaper to keep paused work.** A paused Runtime sandbox keeps its files,
  memory and processes for {{paused-storage-rate}} per GB (10⁹ bytes) a month, while you have credit. Blaxel's
  standby snapshots cost {{term:blaxel:snapshot}} per GB a month.
- **A one-line switch.** `withruntime/blaxel` runs code written for Blaxel's
  sandbox SDK, in JavaScript and Python: processes, files, previews, snapshots,
  forks and the code interpreter, with no Blaxel key. Credit you add within {{welcome-days}} days of signing up is matched, up to {{welcome-max}} in total.
- **Single sign-on at no extra charge.** SAML or OIDC sign-in, SCIM, roles
  and an audit log come with every Runtime account
  ([single sign-on](./single-sign-on)). Blaxel lists SAML among the enterprise
  features of its Dedicated Support add-on.
- **Private networks without a custom plan.** A paid Runtime account joins its
  own network to its sandboxes over WireGuard, for {{address-month}} a month
  ([private networks](./networking#private-networks)). Blaxel lists private
  network connectivity on its Custom plan.
- **Your agent sets itself up.** It runs `npx withruntime sandboxes run -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file. The [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Give an agent a read-only key or a daily spending
  limit per key. Cap any sandbox's whole cost with `maxTotalCostMicros`. Every write takes an
  idempotency key, so a lost response never creates a second sandbox.

**Also included:** a code interpreter, network allow and deny lists, secrets the
sandbox never sees, custom images, volumes backed up daily, snapshots and forks
with memory, private previews, a Linux desktop, metrics, webhooks, OpenTelemetry
export, S3, R2 and GCS bucket mounts, MCP servers from a catalog and identity
tokens for AWS and Google Cloud. Paid accounts add custom domains, TCP ports and
dedicated outbound addresses. See [products](./products).

## At a glance

Blaxel's figures come from its public pricing and documentation, checked
{{checked:blaxel}}.

|                | Runtime                                                                              | Blaxel                                                              |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Isolation      | Firecracker microVM, own kernel                                                      | Lightweight virtual machines                                        |
| CPU billing    | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor                       | Included with memory; 8 GB gets 4 cores                             |
| Memory billing | {{memory-rate}} per reserved GiB-hour                                                | {{=$7 rate:blaxel:memory / 3600}} per GB-second of active time      |
| Paused storage | {{paused-storage-rate}} per GB (10⁹ bytes) a month; files, memory and processes      | {{term:blaxel:snapshot}} per GB-month snapshot; files and processes |
| Plan fee       | None; prepaid credit from {{topup-min}}                                              | None; tiers grow with credit added                                  |
| Free start     | {{included-machine}} in the first 30 days, no card                                   | Up to {{term:blaxel:credit}} of credit                              |
| Internet out   | First {{outbound-allowance}} a month free, then {{outbound-rate}} per GB (10⁹ bytes) | Included                                                            |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox (4 GB on Blaxel). Each run lasts
60 seconds and keeps the CPU busy for 20 CPU-seconds. This is an agent that
spends most of its time waiting for a model.

```
Runtime  CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}      = {{part:runtime:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}} = {{part:runtime:memory}}
         Total                                        {{cost:runtime}}

Blaxel   Memory 1,000 × 75 s × 4 × {{=$7 rate:blaxel:memory / 3600}}      = {{part:blaxel:memory}}
```

- **Saving:** {{saving:blaxel}}, or {{less:blaxel}} per 1,000 runs.
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:blaxel:100000}} on Blaxel.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on Runtime
  against {{cost:blaxel}} on Blaxel.

The Blaxel figure includes the 15 seconds or so each sandbox stays billed after
its run, before Blaxel puts it on standby. Storage, network, taxes and free credit are left out of both. On
Runtime, inbound traffic is free. Each account's first {{outbound-allowance}} out a month
is free. After that, outbound traffic costs {{outbound-rate}} per GB (10⁹ bytes). See [pricing](./pricing) for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Blaxel calls on a branch, tests them on the free usage, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

### Change one import

Runtime's SDK runs code written for Blaxel's sandbox SDK. Change the import and
set `RUNTIME_API_KEY`, or run `npx withruntime login` once:

```ts no-run
import { SandboxInstance } from "withruntime/blaxel"; // was: from "@blaxel/core"
```

```python no-run
from withruntime.blaxel import SandboxInstance  # was: from blaxel.core import SandboxInstance
```

Sandboxes get Blaxel's default of 4096 MB, with one vCPU for every 2048 MB. A
sandbox pauses after {{idle-pause}} with nothing happening in it. It keeps its
memory, files and processes. It wakes by itself on the next command, file call or preview visit.
Envs, processes by name, files, previews, snapshots, forks, volumes and the code
interpreter carry over. Sandboxes use the free usage first, then prepaid credit. There is nothing to choose.

Four things to know before the first run:

- **Share sandboxes with an account-wide key.** A Blaxel workspace key sees
  every sandbox. A Runtime key sees the sandboxes it made unless an owner or
  admin makes it account-wide, on the [API keys](https://withruntime.com/account/keys)
  page or with `runtime keys create --account-wide`. Give a web service and a
  worker that share sandboxes account-wide keys, or one key
  ([keys in a team](./teams#keys-in-a-team)).
- **Without credit, a sandbox is at most 2 vCPU and 4096 MB.** Blaxel's default fits.
  `memory: 8192` or more needs paid credit.
- **Custom images are Runtime images.** Blaxel's own templates, such as
  `blaxel/base-image`, start Runtime's stock image. Any other image must be a
  ready Runtime image of the same name. Build it once with
  `npx withruntime images build --dockerfile Dockerfile --name <name>`.
- **Private preview tokens work as they did.** Blaxel's
  `X-Blaxel-Preview-Token` header and `?bl_preview_token=` parameter are
  accepted, as are Runtime's own. The token never reaches your server.

**Sessions work as they did.** `sandbox.sessions.create()` makes a Runtime
[sandbox session](./javascript#a-sandbox-from-a-browser). It is a token your
frontend uses to run commands, use files and reach previews of that one
sandbox, and nothing else. Blaxel's default of a day is Runtime's longest.
`responseHeaders["Access-Control-Allow-Origin"]` names the page that may use
it. `SandboxInstance.fromSession(session)` drives the sandbox with the
token alone.

A call Runtime handles differently, such as drives, schedules or Blaxel's
agent and MCP hosting, throws `NotSupportedError` before anything happens. It
names what to use instead. `BLAXEL.md` in the package lists every
mapping. For MCP, Runtime runs servers from its catalog inside a sandbox
([MCP servers in a sandbox](./javascript#mcp-servers-in-a-sandbox)). A bucket mounted in several sandboxes shares files between them
([mount your own bucket](./storage#mount-your-own-bucket)). A Blaxel schedule runs a command inside one sandbox. On Runtime, a
[scheduled job](./jobs) runs it on a cron schedule or at a time, in a fresh
sandbox each run.

### Or port the calls

Blaxel:

```js
import { SandboxInstance } from "@blaxel/core";
const sandbox = await SandboxInstance.create({ name: "my-sandbox", memory: 4096 });
const result = await sandbox.process.exec({
  command: "python3 -c 'print(sum([125, 250, 375]))'",
  waitForCompletion: true,
});
await sandbox.delete();
```

Runtime:

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

Moving from Blaxel? Credit you add within {{welcome-days}} days of signing up is matched, up to {{welcome-max}} in total ([welcome match](./pricing#welcome-match)).

## When Blaxel may fit better

- **Very large fleets.** Blaxel's top tier runs over 100,000 sandboxes at the same time.
  A tier is the credit topped up over the last 30 days, which is then spent on
  usage: {{term:blaxel:tier-1}} unlocks 50 sandboxes and {{term:blaxel:tier-2}} unlocks 200.
- **Heavy outbound traffic.** Blaxel includes internet egress in its rates.
  Runtime's first {{outbound-allowance}} out a month are free. After that, the rate is {{outbound-rate}} per GB (10⁹ bytes).

## Sources

Checked 27 September 2026.

- [Blaxel pricing](https://blaxel.ai/pricing)
- [Blaxel sandboxes](https://docs.blaxel.ai/Sandboxes/Overview)
- [Blaxel usage and quotas](https://docs.blaxel.ai/Security/Quotas)
- [Blaxel proxy and network](https://docs.blaxel.ai/Sandboxes/Proxy)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
