# Runtime vs Fly.io

Runtime runs agent code in Firecracker microVMs, like Fly.io, and costs **81% less than Sprites** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **$0.64 on
Runtime, $3.31 on Fly Sprites and $1.44 on a Fly Machine**. At 100,000 runs a
month that is $63.89 against $330.56 on Sprites, **$267 a month saved**, or
against $143.50 on Machines, $80 saved.

## Where Runtime is better

- **Lower rates.** Measured CPU costs $0.025 a vCPU-hour, about a third of
  Sprites' $0.07. Reserved memory costs $0.0075 per GiB-hour, about a sixth of
  Sprites' $0.04375 per GB-hour of memory in use.
- **You pay for the CPU you use.** A Machine bills its whole size for every
  second it is started, busy or not. Runtime bills measured CPU, so time spent
  waiting on a model costs only a small floor, a twentieth of a vCPU.
- **Memory survives a pause, for as long as you choose.** A paused Runtime
  sandbox keeps its processes for the retention you set, 1 to 365 days. A
  Sprite drops its memory when it goes cold, at a time you do not choose, and a
  Machine's root disk is temporary.
- **Sized to the job.** You set vCPUs and memory for each sandbox and are billed
  for no more. A Sprite's memory is managed by Fly and is not a fixed figure to
  plan against.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Safe retries.** Every write takes an idempotency key, and the SDKs retry
  with it automatically, so a lost response never creates a second sandbox.

## At a glance

This compares Runtime with Fly.io's two ways to run agent code: Sprites, its
sandboxes for agents, and Machines, its general-purpose VMs. Fly.io's figures
come from its public pricing and documentation, checked 23 September 2026, with
Machines at the rates of its Ashburn (`iad`) region.

|                | Runtime                                                  | Fly Sprites                                               | Fly Machines                                                        |
| -------------- | -------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| Isolation      | Firecracker microVM, own kernel                          | Firecracker microVM                                       | Firecracker microVM                                                 |
| CPU billing    | $0.025 per vCPU-hour of measured CPU, with a small floor | $0.07 per CPU-hour of measured CPU                        | By size while started; 2 performance vCPUs and 4 GB $0.0861 an hour |
| Memory billing | $0.0075 per reserved GiB-hour                            | $0.04375 per GB-hour of memory in use                     | Included in the size; more at $5 per GB a month                     |
| Size           | Up to 16 vCPUs and 64 GiB paid, chosen apart             | Memory managed by Fly, 100 GB disk                        | Up to 16 performance vCPUs and 128 GB                               |
| Plan fee       | None; prepaid credit from $10                            | None required; optional monthly plans                     | None; pay as you go                                                 |
| Free start     | 100 sandbox hours, no card                               | $30 of trial credit                                       | Not stated on the pricing page                                      |
| When idle      | Pause keeps files and memory; paid retention 1–365 days  | Pauses itself; memory kept at first, the disk kept always | Root disk is temporary; volumes keep files; suspend, 2 GB or less   |
| Interfaces     | API, CLI, MCP server, JavaScript and Python SDKs         | API, CLI, MCP server; JavaScript, Python, Go, Elixir SDKs | Machines API and flyctl                                             |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model. The Sprite is assumed to use all 4 GB for the whole
minute. The Machine is a `performance-2x` with 4 GB.

```
Runtime   CPU    1,000 × 20 s / 3,600 × $0.025        = $0.14
          Memory 1,000 × 60 s / 3,600 × 4 × $0.0075   = $0.50
          Total                                          $0.64

Sprites   CPU    1,000 × 20 s / 3,600 × $0.07         = $0.39
          Memory 1,000 × 60 s / 3,600 × 4 × $0.04375  = $2.92
          Total                                          $3.31

Machines  Size   1,000 × 60 s / 3,600 × $0.0861       = $1.44
```

- **Saving:** 81% against Sprites ($2.67 per 1,000 runs) and 55% against
  Machines ($0.80 per 1,000 runs).
- **Per month:** at 100,000 runs, $63.89 on Runtime against $330.56 on Sprites
  and $143.50 on Machines.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on Runtime,
  $5.25 on Sprites and $1.44 on Machines.

A Sprite bills the memory it actually uses, so a job that uses 1 GB pays $1.12
in total, and a Sprite stays awake for about 30 seconds after its last activity
unless you delete it. A Machine's performance vCPUs are whole cores kept for
it, which Runtime's default shared CPU is not; Runtime's `cpu: "reserved"` keeps
every vCPU for you too.

A `shared-cpu-2x` Machine with 4 GB costs about $0.50 for the same runs, but its
shared vCPUs are guaranteed 6.25% of a core each and start with a small burst
allowance, so a new one would not fit 20 CPU-seconds into the minute. Storage,
network, plan fees, taxes and free credits are left out of all three. On
Runtime, inbound traffic is free, and each account's first 100 GiB out a month
is free, then $0.02 per GB. See [pricing](./pricing) for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Fly.io calls on a branch, tests them on the free trial, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

### From Sprites

```js
import { SpritesClient } from "@fly/sprites";
const client = new SpritesClient(process.env.SPRITE_TOKEN);
const sprite = await client.createSprite("my-sprite");
const result = await sprite.execFile("python3", ["-c", "print(6 * 7)"]);
console.log(result.stdout);
await sprite.delete();
```

Runtime:

```ts
import { Sandbox } from "withruntime";
const box = await Sandbox.create({ funding: "trial" });
try {
  console.log((await box.exec(["python3", "-c", "print(6 * 7)"], { check: true })).stdout);
} finally {
  await box.stop();
}
```

### From Machines

If you create a Machine for each job through the Machines API, create a Runtime
sandbox instead and stop it when the job ends.

## When Fly.io may fit better

- **Regions.** Machines run in 18 regions. Runtime runs in one US region.
- **Very cheap sleep.** A sleeping Sprite's disk costs $0.02 per GB-month.
  Runtime's paused storage, which also keeps memory, costs $0.08 per GB-month.
- **A wider platform today.** Machines, volumes and Managed Postgres sit in the
  same account.

## Sources

Checked 23 September 2026; Machine suspend rechecked 25 September 2026.

- [Fly.io pricing](https://fly.io/pricing/) for Machines and Sprites
- [Sprites](https://fly.io/sprites/) and its pricing questions
- [Sprites documentation](https://docs.sprites.dev/) and
  [lifecycle and persistence](https://docs.sprites.dev/concepts/lifecycle/)
- [Machine CPU performance](https://fly.io/docs/machines/cpu-performance/)
- [Machine suspend and resume](https://docs.fly.io/reference/suspend-resume/)
- [Fly Volumes](https://fly.io/docs/volumes/overview/)
- [Fly.io regions](https://fly.io/docs/reference/regions/)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
