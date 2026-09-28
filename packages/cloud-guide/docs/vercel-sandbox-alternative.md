# Runtime vs Vercel Sandbox

Runtime runs Firecracker microVMs and bills active CPU, like Vercel Sandbox, and costs **{{saving:vercel}} less** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU sandbox with 4 GiB cost **{{cost:runtime}}
on Runtime and {{cost:vercel}} on Vercel**. At 100,000 runs a month that is {{cost:runtime:100000}} against
{{cost:vercel:100000}}, **{{=$0 less:vercel:100000}} a month saved**. Your Vercel Sandbox code keeps working: change one
import.

## Where Runtime is better

- **{{=n0 100 * ( 1 - cpu-rate / rate:vercel:cpu )}}% cheaper CPU.** Active CPU costs {{cpu-rate}} an hour on Runtime and {{rate:vercel:cpu}} on Vercel; memory costs {{=n0 100 * ( 1 - memory-rate / rate:vercel:memory )}}% less. Busier jobs save
  more: with both CPUs busy the whole minute, the example job costs {{cost:runtime:busy}} on
  Runtime and {{cost:vercel:busy}} on Vercel.
- **It pauses itself when idle.** After {{idle-pause}} with no request, command,
  connection, traffic or CPU use, a Runtime sandbox pauses and pays only paused
  storage, {{paused-storage-rate}} per GB a month. The next request wakes it with its
  processes still running and its next command done {{wake}} later.
- **A written uptime promise.** {{uptime-promise}} API uptime a month for paid accounts,
  measured from outside, and {{uptime-credit}} of a short month's charges back as credit
  automatically ([Uptime Promise](/legal/sla)).
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
  prepaid credit from {{topup-min}} is the whole account.
- **A one-line switch.** `withruntime/vercel` runs code written for Vercel
  Sandbox's SDK, in JavaScript and Python: commands, files, ports, snapshots and
  persistent sandboxes, with no Vercel project or token. Run `runtime switch --from vercel` before your
  first top-up and it is matched, up to {{switching-max}}.
- **Single sign-on included.** SAML or OIDC sign-in, SCIM, roles and an audit
  log come with every Runtime account ([single sign-on](./single-sign-on)).
  Vercel sells SAML single sign-on as an add-on for Pro teams and keeps
  directory sync for Enterprise.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.

**Also included:** a code interpreter, network allow and deny lists, secrets the
sandbox never sees, custom images, volumes backed up daily, a Linux desktop,
metrics, webhooks, OpenTelemetry export, S3, R2 and GCS bucket mounts, MCP
servers from a catalog and identity tokens for AWS and Google Cloud. Paid
accounts add custom domains, TCP ports, dedicated outbound addresses and
WireGuard private networks. See [products](./products).

## At a glance

Vercel's figures come from its public pricing and documentation, checked
{{checked:vercel}}, at the rates of its default `iad1` region.

|                  | Runtime                                                                                                                         | Vercel Sandbox                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Isolation        | Firecracker microVM, own kernel                                                                                                 | Firecracker microVM, own kernel                      |
| CPU billing      | {{cpu-rate}} per active vCPU-hour, with a small floor                                                                           | {{rate:vercel:cpu}} per active CPU-hour              |
| Memory billing   | {{memory-rate}} per reserved GiB-hour                                                                                           | {{rate:vercel:memory}} per provisioned GB-hour       |
| Plan             | None; prepaid credit from {{topup-min}}                                                                                         | Hobby allowance free; usage beyond it needs Pro      |
| Free start       | {{trial-hours}} sandbox hours, no card                                                                                          | 5 active CPU-hours and 420 GB-hours a month on Hobby |
| Session length   | Leases of up to an hour, extended as often as needed, or persistent while credit lasts; pauses itself after {{idle-pause}} idle | 45 minutes on Hobby, 24 hours on Pro                 |
| Stop and resume  | Pause keeps files, memory and processes                                                                                         | Stop keeps the filesystem; processes start again     |
| Snapshots, forks | Files, memory and running processes                                                                                             | The filesystem                                       |
| Port URLs        | Private with a token by default                                                                                                 | Public                                               |

## Cost for the same job

Take 1,000 runs of a 2 vCPU sandbox with 4 GiB on Runtime and 4 GB on Vercel,
which gives 2 GB per vCPU. Each run lasts 60 seconds and keeps the CPU busy for
20 CPU-seconds: an agent that spends most of its time waiting for a model.

```
Runtime  CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}      = {{part:runtime:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}} = {{part:runtime:memory}}
         Total                                        {{cost:runtime}}

Vercel   CPU    1,000 × 20 s / 3,600 × {{rate:vercel:cpu}}      = {{part:vercel:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{rate:vercel:memory}} = {{part:vercel:memory}}
         Total                                        {{cost:vercel}}
```

- **Saving:** {{saving:vercel}}, or {{less:vercel}} per 1,000 runs.
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:vercel:100000}} on Vercel.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on
  Runtime against {{cost:vercel:busy}} on Vercel, a {{saving:vercel:busy}} saving.

A GiB is about 7% larger than a GB, so Runtime's memory figure covers slightly
more. Creations, network, storage, plan fees, taxes and free allowances are left
out of both. On Runtime, inbound traffic is free, and each account's first {{outbound-allowance}} out a month is free, then {{outbound-rate}} per GB. See [pricing](./pricing) for
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

Checked 23 September 2026; single sign-on and the firewall checked
27 September 2026.

- [Vercel Sandbox pricing and quotas](https://vercel.com/docs/sandbox/pricing)
- [Vercel SAML single sign-on](https://vercel.com/docs/saml)
- [Vercel Sandbox firewall](https://vercel.com/docs/sandbox/concepts/firewall)
- [Understanding Vercel Sandboxes](https://vercel.com/docs/sandbox/concepts)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
