# Runtime vs Fly.io

Runtime runs agent code in Firecracker microVMs, like Fly.io, and costs **{{saving:fly-sprites}} less than Sprites** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime, {{cost:fly-sprites}} on Fly Sprites and {{cost:fly-machines}} on a Fly Machine**. At 100,000 runs a
month that is {{cost:runtime:100000}} against {{cost:fly-sprites:100000}} on Sprites, **{{=$0 less:fly-sprites:100000}} a month saved**, or
against {{cost:fly-machines:100000}} on Machines, {{=$0 less:fly-machines:100000}} saved.

Weighing more than two? [Fly.io alternatives for agent sandboxes](/compare/fly-io-alternatives) ranks the other providers by the cost of the same job.

## Where Runtime is better

- **Lower rates.** Measured CPU costs {{cpu-rate}} a vCPU-hour, {{=n0 100 * ( 1 - cpu-rate / rate:fly-sprites:cpu )}}% below Sprites' {{rate:fly-sprites:cpu}}. Reserved memory costs {{memory-rate}} per GiB-hour, {{=n0 100 * ( 1 - memory-rate / rate:fly-sprites:memory )}}% below Sprites' {{rate:fly-sprites:memory}} per GB-hour of memory in use.
- **Idle time bills only storage.** A Runtime sandbox pauses itself after
  {{idle-pause}} with nothing happening in it, keeps its memory and processes,
  and runs its next command {{server-wake-command}} after the request that
  wakes it reaches Runtime. Paused, it
  pays {{paused-storage-rate}} per GB (10⁹ bytes) of saved state a month.
- **An uptime promise that pays itself.** Paid accounts are promised
  {{uptime-promise}} API uptime each month; a month below it returns {{uptime-credit}} of that
  month's charges as credit, with no claim to file ([Uptime Promise](/legal/sla)).
- **You pay for the CPU you use.** A Machine bills its whole size for every
  second it is started, busy or not. Runtime bills measured CPU, so time spent
  waiting on a model costs only a small floor, {{cpu-floor-share}}.
- **Memory survives a pause, for as long as you choose.** A paused Runtime
  sandbox keeps its processes while you have credit. A
  Sprite drops its memory when it goes cold, at a time you do not choose, and a
  Machine's root disk is temporary.
- **Sized to the job.** You set vCPUs and memory for each sandbox and are billed
  for no more. A Sprite's memory is managed by Fly and is not a fixed figure to
  plan against.
- **Keys the sandbox never sees.** Store an API key once; the sandbox holds a
  placeholder and Runtime's proxy adds the value only to HTTPS requests to the
  hosts you name, so a prompt injection has nothing to leak ([security](./security)).
- **Switching credit.** Run `runtime switch --from fly` before your first
  top-up and that top-up is matched, up to {{switching-max}}
  ([switching credit](./pricing#switching-credit)).
- **Your agent sets itself up.** It runs `npx withruntime sandbox run -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Safe retries.** Every write takes an idempotency key, and the SDKs retry
  with it automatically, so a lost response never creates a second sandbox.

**Also included:** a code interpreter, network allow and deny lists, custom
images, volumes backed up daily, snapshots and forks with memory, private
previews, a Linux desktop, metrics, webhooks, OpenTelemetry export, S3, R2 and
GCS bucket mounts, MCP servers from a catalog, identity tokens for AWS and
Google Cloud and free single sign-on. Paid accounts add custom domains, TCP
ports, dedicated outbound addresses and WireGuard private networks. See
[products](./products).

## At a glance

This compares Runtime with Fly.io's two ways to run agent code: Sprites, its
sandboxes for agents, and Machines, its general-purpose VMs. Fly.io's figures
come from its public pricing and documentation, checked 2 October 2026, with
Machines at the rates of its Ashburn (`iad`) region.

|                | Runtime                                                          | Fly Sprites                                               | Fly Machines                                                                           |
| -------------- | ---------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Isolation      | Firecracker microVM, own kernel                                  | Firecracker microVM                                       | Firecracker microVM                                                                    |
| CPU billing    | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor   | {{rate:fly-sprites:cpu}} per CPU-hour of measured CPU     | By size while started; 2 performance vCPUs and 4 GB {{rate:fly-machines:size}} an hour |
| Memory billing | {{memory-rate}} per reserved GiB-hour                            | {{rate:fly-sprites:memory}} per GB-hour of memory in use  | Included in the size; more at {{term:fly-machines:extra-memory}} per GB a month        |
| Size           | Up to {{max-vcpu}} vCPUs and {{max-memory}} paid, chosen apart   | Memory managed by Fly, 100 GB disk                        | Up to 16 performance vCPUs and 128 GB                                                  |
| Plan fee       | None; prepaid credit from {{topup-min}}                          | None required; optional monthly plans                     | None; pay as you go                                                                    |
| Free start     | {{included-machine}} every month, no card                        | {{term:fly-sprites:credit}} of trial credit               | Not stated on the pricing page                                                         |
| When idle      | Pause keeps files and memory; kept while you have credit         | Pauses itself; memory kept at first, the disk kept always | Root disk is temporary; volumes keep files; suspend, 2 GB or less                      |
| Interfaces     | API, CLI, MCP server, JavaScript, Python, Go, Ruby and Java SDKs | API, CLI, MCP server; JavaScript, Python, Go, Elixir SDKs | Machines API and flyctl                                                                |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model. The Sprite is assumed to use all 4 GB for the whole
minute. The Machine is a `performance-2x` with 4 GB.

```
Runtime   CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}        = {{part:runtime:cpu}}
          Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}}   = {{part:runtime:memory}}
          Total                                          {{cost:runtime}}

Sprites   CPU    1,000 × 20 s / 3,600 × {{rate:fly-sprites:cpu}}         = {{part:fly-sprites:cpu}}
          Memory 1,000 × 90 s / 3,600 × 4 × {{rate:fly-sprites:memory}}  = {{part:fly-sprites:memory}}
          Total                                          {{cost:fly-sprites}}

Machines  Size   1,000 × 60 s / 3,600 × {{rate:fly-machines:size}}       = {{part:fly-machines:size}}
```

- **Saving:** {{saving:fly-sprites}} against Sprites ({{less:fly-sprites}} per 1,000 runs) and {{saving:fly-machines}} against
  Machines ({{less:fly-machines}} per 1,000 runs).
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:fly-sprites:100000}} on Sprites
  and {{cost:fly-machines:100000}} on Machines.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on Runtime,
  {{cost:fly-sprites:busy}} on Sprites and {{cost:fly-machines}} on Machines.

A Sprite bills the memory it actually uses, so a job that uses 1 GB pays {{cost:fly-sprites:2x1x60x20x1000}}
in total, and every figure here includes the 30 seconds or so a Sprite stays awake, and billed, after its run. A Machine's performance vCPUs are whole cores kept for
it, which Runtime's default shared CPU is not; Runtime's `cpu: "reserved"` keeps
every vCPU for you too.

A `shared-cpu-2x` Machine with 4 GB costs about $0.50 for the same runs, but its
shared vCPUs are guaranteed 6.25% of a core each and start with a small burst
allowance, so a new one would not fit 20 CPU-seconds into the minute. Storage,
network, plan fees, taxes and free credits are left out of all three. On
Runtime, inbound traffic is free, and each account's first {{outbound-allowance}} out a month
is free, then {{outbound-rate}} per GB (10⁹ bytes). See [pricing](./pricing) for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Fly.io calls on a branch, tests them on the included usage, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

### From Sprites

```js
import { SpritesClient } from "@fly/sprites";
const client = new SpritesClient(process.env.SPRITE_TOKEN);
const sprite = await client.createSprite("my-sprite");
const result = await sprite.execFile("python3", ["-c", "print(sum([125, 250, 375]))"]);
console.log(result.stdout);
await sprite.delete();
```

Runtime:

```ts
import { Sandbox } from "withruntime";
const box = await Sandbox.create();
try {
  await box.files.write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n");
  console.log((await box.exec(["python3", "/workspace/invoice.py"], { check: true })).stdout);
} finally {
  await box.stop();
}
```

### From Machines

If you create a Machine for each job through the Machines API, create a Runtime
sandbox instead and stop it when the job ends.

## When Fly.io may fit better

- **Regions.** Machines run in 18 regions. Runtime runs in one US region.
- **Very cheap sleep.** A sleeping Sprite's disk costs {{term:fly-sprites:cold-storage}} per GB-month,
  its cold storage rate ([Fly.io pricing](https://fly.io/pricing/), read 4 October 2026).
  Runtime's paused storage, which also keeps memory, costs {{paused-storage-rate}} per GB (10⁹ bytes) a month.
- **A wider platform today.** Machines, volumes and Managed Postgres sit in the
  same account.

## Sources

Prices checked 2 October 2026; Machine suspend rechecked 25 September 2026.

- [Fly.io pricing](https://fly.io/pricing/) for Machines and Sprites
- [Sprites](https://fly.io/sprites/) and its pricing questions
- [Sprites documentation](https://docs.sprites.dev/) and
  [lifecycle and persistence](https://docs.sprites.dev/concepts/lifecycle/)
- [Machine CPU performance](https://fly.io/docs/machines/cpu-performance/)
- [Machine suspend and resume](https://docs.fly.io/reference/suspend-resume/)
- [Fly Volumes](https://fly.io/docs/volumes/overview/)
- [Fly.io regions](https://fly.io/docs/reference/regions/)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
