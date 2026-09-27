# Runtime vs Vercel Sandbox

Runtime runs Firecracker microVMs and bills active CPU, like Vercel Sandbox, and costs **70% less** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU sandbox with 4 GiB cost **$0.64
on Runtime and $2.12 on Vercel**. At 100,000 runs a month that is $63.89 against
$212.44, **$149 a month saved**. Your Vercel Sandbox code keeps working: change one
import.

## Where Runtime is better

- **About a fifth of the CPU price.** Active CPU costs $0.025 an hour on
  Runtime and $0.128 on Vercel; memory costs about a third. Busier jobs save
  more: with both CPUs busy the whole minute, the example job costs $1.33 on
  Runtime and $5.68 on Vercel.
- **Memory survives a pause.** A paused Runtime sandbox wakes with its
  processes still running, kept for 1 to 365 days. A stopped Vercel sandbox
  keeps its filesystem, and its processes start again.
- **Forks keep memory too.** A Runtime fork copies a running sandbox with its
  memory and running processes. A Vercel snapshot or fork captures the
  filesystem, so processes start again.
- **Private ports by default.** A Runtime preview gives a port an HTTPS address
  that needs a token unless you make it public. Vercel's exposed ports are
  reachable at a public URL.
- **No platform to join.** Runtime needs no hosting plan, team or project;
  prepaid credit from $10 is the whole account.
- **A one-line switch.** `withruntime/vercel` runs code written for Vercel
  Sandbox's SDK, in JavaScript and Python: commands, files, ports, snapshots and
  persistent sandboxes, with no Vercel project or token.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.

## At a glance

Vercel's figures come from its public pricing and documentation, checked
23 September 2026, at the rates of its default `iad1` region.

|                  | Runtime                                              | Vercel Sandbox                                       |
| ---------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Isolation        | Firecracker microVM, own kernel                      | Firecracker microVM, own kernel                      |
| CPU billing      | $0.025 per active vCPU-hour, with a small floor      | $0.128 per active CPU-hour                           |
| Memory billing   | $0.0075 per reserved GiB-hour                        | $0.0212 per provisioned GB-hour                      |
| Plan             | None; prepaid credit from $10                        | Hobby allowance free; usage beyond it needs Pro      |
| Free start       | 100 sandbox hours, no card                           | 5 active CPU-hours and 420 GB-hours a month on Hobby |
| Session length   | Leases of up to an hour, extended as often as needed | 45 minutes on Hobby, 24 hours on Pro                 |
| Stop and resume  | Pause keeps files, memory and processes              | Stop keeps the filesystem; processes start again     |
| Snapshots, forks | Files, memory and running processes                  | The filesystem                                       |
| Port URLs        | Private with a token by default                      | Public                                               |

## Cost for the same job

Take 1,000 runs of a 2 vCPU sandbox with 4 GiB on Runtime and 4 GB on Vercel,
which gives 2 GB per vCPU. Each run lasts 60 seconds and keeps the CPU busy for
20 CPU-seconds: an agent that spends most of its time waiting for a model.

```
Runtime  CPU    1,000 × 20 s / 3,600 × $0.025      = $0.14
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0075 = $0.50
         Total                                        $0.64

Vercel   CPU    1,000 × 20 s / 3,600 × $0.128      = $0.71
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0212 = $1.41
         Total                                        $2.12
```

- **Saving:** 70%, or $1.49 per 1,000 runs.
- **Per month:** at 100,000 runs, $63.89 on Runtime against $212.44 on Vercel.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on
  Runtime against $5.68 on Vercel, a 77% saving.

A GiB is about 7% larger than a GB, so Runtime's memory figure covers slightly
more. Creations, network, storage, plan fees, taxes and free allowances are left
out of both. On Runtime, inbound traffic is free, and each account's first 100
GiB out a month is free, then $0.02 per GB. See [pricing](./pricing) for
Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Vercel calls on a branch, tests them on the free trial, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

### Change one import

Runtime's SDK runs code written for Vercel Sandbox's SDK. Change the import and
set `RUNTIME_API_KEY`, or run `npx withruntime login` once:

```ts no-run
import { Sandbox } from "withruntime/vercel"; // was: from "@vercel/sandbox"
```

```python no-run
from withruntime.vercel import sandbox  # was: from vercel import sandbox
```

Sandboxes get Vercel's defaults: 2 vCPUs with 2048 MiB each, a 5-minute
timeout, and persistence, so `stop()` pauses a sandbox and the next call or
`Sandbox.get({ name })` wakes it. Ports listed at create get public addresses,
and `domain(port)` answers from them. They use the free trial while the account
has trial time, then prepaid credit.

A call Runtime handles differently, such as Drives, other regions or a timeout
over an hour, throws `NotSupportedError` before anything happens and names what
to use instead. `VERCEL.md` in the package lists every mapping.

### Or port the calls

Vercel Sandbox:

```js
import { Sandbox } from "@vercel/sandbox";
const sandbox = await Sandbox.create();
const command = await sandbox.runCommand("echo", ["hello"]);
console.log(await command.stdout());
await sandbox.stop();
```

Runtime:

```ts
import { Sandbox } from "withruntime";
const box = await Sandbox.create({ funding: "trial" });
try {
  console.log((await box.exec("echo hello", { check: true })).stdout);
} finally {
  await box.stop();
}
```

## When Vercel Sandbox may fit better

- **Regions and scale.** Vercel runs sandboxes in 19 regions, with up to 10,000
  at once on Pro. Runtime runs in one US region.
- **Your app already lives on Vercel.** Sandboxes then share its account,
  billing and observability.

## Sources

Checked 23 September 2026.

- [Vercel Sandbox pricing and quotas](https://vercel.com/docs/sandbox/pricing)
- [Understanding Vercel Sandboxes](https://vercel.com/docs/sandbox/concepts)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
