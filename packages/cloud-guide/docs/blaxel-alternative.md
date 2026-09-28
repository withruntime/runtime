# Runtime vs Blaxel

Runtime bills the CPU your agent uses and costs **{{saving:blaxel}} less than Blaxel** while running an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:blaxel}} on Blaxel**. At 100,000 runs a month that is {{cost:runtime:100000}} against
{{cost:blaxel:100000}}, **{{=$0 less:blaxel:100000}} a month saved**. Your Blaxel sandbox code keeps working: change
one import.

## Where Runtime is better

- **Lower cost while running.** Blaxel bills {{=$7 rate:blaxel:memory / 3600}} per GB of memory per
  second of active time, {{rate:blaxel:memory}} per GB-hour, and CPU comes with the memory.
  Runtime charges {{memory-rate}} per GiB-hour of memory and measured CPU at {{cpu-rate}} per
  vCPU-hour.
- **A written uptime promise.** {{uptime-promise}} API uptime a month for paid accounts,
  measured from outside, and {{uptime-credit}} of a short month's charges back as credit
  automatically ([Uptime Promise](/legal/sla)).
- **Cheaper even when busy.** With both CPUs working the whole time, the example
  job costs {{cost:runtime:busy}} on Runtime and {{cost:blaxel}} on Blaxel.
- **CPU and memory chosen apart.** Blaxel sets a sandbox's CPU from its memory:
  8 GB gets 4 cores. On Runtime you choose vCPUs and memory separately, so a
  CPU-heavy job does not pay for memory it does not need.
- **Idle time costs no compute here either.** A Runtime sandbox pauses itself
  after {{idle-pause}} with nothing happening in it, or after as few as 10 if you
  set it, and a paused sandbox pays only paused storage. A command still
  running, an open connection, network traffic or CPU use keeps it awake.
- **Cheaper to keep paused work.** A paused Runtime sandbox keeps its files,
  memory and processes for {{paused-storage-rate}} per GB a month, for 1 to 365 days. Blaxel's
  standby snapshots cost {{term:blaxel:snapshot}} per GB a month.
- **A one-line switch.** `withruntime/blaxel` runs code written for Blaxel's
  sandbox SDK, in JavaScript and Python: processes, files, previews, snapshots,
  forks and the code interpreter, with no Blaxel key. A switch from Blaxel gets
  your first top-up matched, up to {{switching-max}}.
- **Secrets stay outside the sandbox.** Code inside sees a placeholder; the
  real key is added at the egress proxy, only on HTTPS to the hosts you allow
  ([security](./security)).
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Give an agent a read-only key or a daily spending
  limit per key, and cap any create with `maxCostMicros`. Every write takes an
  idempotency key, so a lost response never creates a second sandbox.

## At a glance

Blaxel's figures come from its public pricing and documentation, checked
{{checked:blaxel}}.

|                | Runtime                                                                  | Blaxel                                                              |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Isolation      | Firecracker microVM, own kernel                                          | Lightweight virtual machines                                        |
| CPU billing    | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor           | Included with memory; 8 GB gets 4 cores                             |
| Memory billing | {{memory-rate}} per reserved GiB-hour                                    | {{=$7 rate:blaxel:memory / 3600}} per GB-second of active time      |
| Paused storage | {{paused-storage-rate}} per GB-month; files, memory and processes        | {{term:blaxel:snapshot}} per GB-month snapshot; files and processes |
| Plan fee       | None; prepaid credit from {{topup-min}}                                  | None; tiers grow with credit added                                  |
| Free start     | {{trial-hours}} sandbox hours, no card                                   | Up to {{term:blaxel:credit}} of credit                              |
| Internet out   | First {{outbound-allowance}} a month free, then {{outbound-rate}} per GB | Included                                                            |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox (4 GB on Blaxel). Each run lasts
60 seconds and keeps the CPU busy for 20 CPU-seconds: an agent that spends most of
its time waiting for a model.

```
Runtime  CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}      = {{part:runtime:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}} = {{part:runtime:memory}}
         Total                                        {{cost:runtime}}

Blaxel   Memory 1,000 × 60 s × 4 × {{=$7 rate:blaxel:memory / 3600}}      = {{part:blaxel:memory}}
```

- **Saving:** {{saving:blaxel}}, or {{less:blaxel}} per 1,000 runs.
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:blaxel:100000}} on Blaxel.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on Runtime
  against {{cost:blaxel}} on Blaxel.

The Blaxel figure assumes each sandbox goes to standby the moment its run ends;
Blaxel's docs say standby starts about 15 seconds after the last connection
closes. Storage, network, taxes and free credit are left out of both. On
Runtime, inbound traffic is free, and each account's first {{outbound-allowance}} out a month
is free, then {{outbound-rate}} per GB. See [pricing](./pricing) for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Blaxel calls on a branch, tests them on the free trial, and tells
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
sandbox pauses after {{idle-pause}} with nothing happening in it, keeping its
memory, files and processes, and wakes by itself on the next command, file call or preview visit.
Envs, processes by name, files, previews, snapshots, forks, volumes and the code
interpreter carry over. Sandboxes use the free trial while the account has
trial time, then prepaid credit; pass `withruntime: { create: { funding: "trial" } }`
(Python `runtime_create={"funding": "trial"}`) while you test.

Four things to know before the first run:

- **Share sandboxes with an account-wide key.** A Blaxel workspace key sees
  every sandbox. A Runtime key sees the sandboxes it made unless an owner or
  admin makes it account-wide, on the [API keys](https://withruntime.com/account/keys)
  page or, from CLI 0.8.2, with `runtime keys create --account-wide`. Give a web service and a
  worker that share sandboxes account-wide keys, or one key
  ([keys in a team](./teams#keys-in-a-team)).
- **The trial caps a sandbox at 2 vCPU and 4096 MB.** Blaxel's default fits.
  `memory: 8192` or more needs paid credit.
- **Custom images are Runtime images.** Blaxel's own templates, such as
  `blaxel/base-image`, start Runtime's stock image. Any other image must be a
  ready Runtime image of the same name: build it once with
  `npx withruntime image build --dockerfile Dockerfile --name <name>`.
- **Private preview tokens work as they did.** Blaxel's
  `X-Blaxel-Preview-Token` header and `?bl_preview_token=` parameter are
  accepted, as are Runtime's own, and the token never reaches your server.

A call Runtime handles differently, such as sessions, drives, schedules or
Blaxel's agent and MCP hosting, throws `NotSupportedError` before anything
happens and names what to use instead. `BLAXEL.md` in the package lists every
mapping.

### Or port the calls

Blaxel:

```js
import { SandboxInstance } from "@blaxel/core";
const sandbox = await SandboxInstance.create({ name: "my-sandbox", memory: 4096 });
const result = await sandbox.process.exec({
  command: "python3 -c 'print(6 * 7)'",
  waitForCompletion: true,
});
await sandbox.delete();
```

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

Moving from Blaxel? Run `npx withruntime switch --from blaxel` before your first
top-up, and that top-up is matched with credit, up to {{switching-max}}
([switching credit](./pricing#switching-credit)).

## When Blaxel may fit better

- **Back from idle in milliseconds.** A Blaxel sandbox resumes from standby in
  about 25 ms. A paused Runtime sandbox runs its next command {{wake}} after
  the call that wakes it.
- **Very large fleets.** Blaxel's top tier runs over 100,000 sandboxes at once.
  A tier is the credit topped up over the last 30 days, which is then spent on
  usage: {{term:blaxel:tier-1}} unlocks 50 sandboxes and {{term:blaxel:tier-2}} unlocks 200.
- **Heavy outbound traffic.** Blaxel includes internet egress in its rates.
  Runtime's first {{outbound-allowance}} out a month are free, then {{outbound-rate}} per GB.

## Sources

Checked 27 September 2026.

- [Blaxel pricing](https://blaxel.ai/pricing)
- [Blaxel sandboxes](https://docs.blaxel.ai/Sandboxes/Overview)
- [Blaxel usage and quotas](https://docs.blaxel.ai/Security/Quotas)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
