# Runtime vs Daytona

Runtime gives every agent sandbox its own microVM kernel and costs **{{saving:daytona}} less than Daytona** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:daytona}} on Daytona**. At 100,000 runs a month that is {{cost:runtime:100000}} against
{{cost:daytona:100000}}, **{{=$0 less:daytona:100000}} a month saved**. Your Daytona code keeps working: change one import.

Weighing more than two? [Daytona alternatives](/compare/daytona-alternatives) ranks the other providers by the cost of the same job.

## Where Runtime is better

- **You pay for the CPU you use.** Daytona bills every vCPU for as long as the
  sandbox runs. Runtime measures the CPU your code actually uses, so time spent
  waiting on a model costs only a small floor, {{cpu-floor-share}}.
- **It pauses itself when idle.** After {{idle-pause}} with no request, command,
  connection, traffic or CPU use, a Runtime sandbox pauses and pays only paused
  storage, {{paused-storage-rate}} per GB a month. The next request wakes it with its
  processes still running and its next command done {{server-wake-command}}
  after the request reaches Runtime.
- **Back from a pause in milliseconds.** Daytona states a paused VM resumes in
  {{speed:daytona:wake}}. On Runtime's servers a wake takes {{server-wake}}, on every sandbox
  ([speed](./speed)).
- **An uptime promise that pays itself.** Paid accounts are promised
  {{uptime-promise}} API uptime each month; a month below it returns {{uptime-credit}} of that
  month's charges as credit, with no claim to file ([Uptime Promise](/legal/sla)).
- **Lower rates on both meters.** {{cpu-rate}} per vCPU-hour against Daytona's
  {{rate:daytona:cpu}}, and {{memory-rate}} per GiB-hour of memory against {{rate:daytona:memory}}. Even with every
  CPU busy the whole time, the example job costs {{cost:runtime:busy}} on Runtime and {{cost:daytona}} on
  Daytona.
- **A microVM every time.** Every Runtime sandbox is a Firecracker microVM with
  its own kernel, and every one can pause with its memory. Daytona's default
  sandbox is a container; pausing with memory needs its VM class.
- **Disk included while running.** Daytona charges for disk past 5 GiB whether
  the sandbox runs or not. Runtime's disk is part of a running sandbox.
- **A one-line switch.** `withruntime/daytona` runs code written for Daytona's
  SDK, in JavaScript and Python: sessions, files, git, snapshots built from
  Daytona's `Image`, and the code interpreter. Run `runtime switch --from daytona` before your
  first top-up and it is matched, up to {{switching-max}}.
- **Teams at no extra charge.** Single sign-on over SAML or OIDC (Okta,
  Microsoft Entra ID, Google Workspace), SCIM, roles and an audit log come with
  every account ([single sign-on](./single-sign-on)). Daytona's single sign-on is OIDC,
  on its Enterprise plan.
- **Custom domains built in.** A paid account serves a sandbox port at your own
  hostname, with HTTPS, from one command ([custom domains](./networking#custom-domains)).
  On Daytona, a preview under your own domain needs a preview proxy you deploy
  and run yourself.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Give an agent a read-only key or a daily spending
  limit per key, and cap any create with `maxCostMicros`. Every write takes an
  idempotency key and the SDKs retry with it, so a lost response never creates
  a second sandbox.

**Also included:** a code interpreter, network allow and deny lists, secrets the
sandbox never sees, custom images, volumes backed up daily, snapshots and forks
with memory, private previews, a Linux desktop, metrics, webhooks, OpenTelemetry
export, S3, R2 and GCS bucket mounts, MCP servers from a catalog and identity
tokens for AWS and Google Cloud. Paid accounts add TCP ports, dedicated outbound
addresses and WireGuard private networks. See [products](./products).

## At a glance

Daytona's figures come from its public pricing and documentation, checked
{{checked:daytona}}.

|                  | Runtime                                                                     | Daytona                                                                   |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Isolation        | Firecracker microVM for every sandbox                                       | Containers by default; VM sandboxes as a separate class                   |
| CPU billing      | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor              | {{rate:daytona:cpu}} per allocated vCPU-hour                              |
| Memory billing   | {{memory-rate}} per reserved GiB-hour                                       | {{rate:daytona:memory}} per GiB-hour                                      |
| Disk             | Included while running; paused storage {{paused-storage-rate}} per GB-month | First 5 GiB free, then {{term:daytona:disk}} per GiB-hour, stopped or not |
| Plan fee         | None; prepaid credit from {{topup-min}}                                     | None published                                                            |
| Free start       | {{trial-hours}} sandbox hours, no card                                      | {{term:daytona:credit}} of compute                                        |
| Pause and resume | Files and memory, every sandbox                                             | Files and memory on VM sandboxes                                          |
| Snapshots, forks | Copies of a running sandbox, with memory and processes                      | Memory snapshots on VM sandboxes                                          |
| Agent sign-in    | Browser approval; no key in the agent's config                              | API key                                                                   |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model.

```
Runtime  CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}      = {{part:runtime:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}} = {{part:runtime:memory}}
         Total                                        {{cost:runtime}}

Daytona  CPU    1,000 × 60 s / 3,600 × 2 × {{rate:daytona:cpu}} = {{part:daytona:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{rate:daytona:memory}} = {{part:daytona:memory}}
         Total                                        {{cost:daytona}}
```

- **Saving:** {{saving:daytona}}, or {{less:daytona}} per 1,000 runs.
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:daytona:100000}} on Daytona.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on
  Runtime against {{cost:daytona:busy}} on Daytona. At this size, Runtime is cheaper however busy the
  sandbox is.

Disk, network, taxes and free credits are left out of both.
`runtime compare --from daytona` prices your own usage the same way, with
sandboxes the free trial paid for at the standard rates, so trial time never
counts as a saving. On Runtime, inbound traffic is free, and each account's
first {{outbound-allowance}} out a month is free, then {{outbound-rate}} per GB. See [pricing](./pricing)
for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Daytona calls on a branch, tests them on the free trial, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

### Change one import

Runtime's SDK runs code written for Daytona's SDK. Change the import and set
`RUNTIME_API_KEY`, or run `npx withruntime login` once:

```ts no-run
import { Daytona } from "withruntime/daytona"; // was: from "@daytona/sdk"
```

```python no-run
from withruntime.daytona import Daytona  # was: from daytona import Daytona
```

Sandboxes get Daytona's defaults: 1 vCPU, 1 GiB of memory and a 3 GiB disk,
pausing after 15 minutes without calls. `stop()` pauses a sandbox with its
files and its memory, and `start()` carries on. They use the free trial while
the account has trial time, then prepaid credit.

A call Runtime handles differently, such as GPUs, PTY sessions or computer use,
throws `NotSupportedError` before anything happens and names what to use
instead. `DAYTONA.md` in the package lists every mapping.

### Or port the calls

The calls map one to one. Daytona:

```js
import { Daytona } from "@daytonaio/sdk";
const daytona = new Daytona();
const sandbox = await daytona.create();
const response = await sandbox.process.executeCommand("python3 -c 'print(6 * 7)'");
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

## When Daytona may fit better

- **GPUs and Windows.** Daytona offers GPU sandboxes and Windows machines.
  Runtime runs Linux on CPUs.
- **Regions.** Daytona runs in the US and the EU. Runtime runs in one US
  region.

## Sources

Checked 23 September 2026; single sign-on and custom domains checked
27 September 2026.

- [Daytona pricing](https://www.daytona.io/pricing)
- [Daytona organization SSO](https://www.daytona.io/docs/en/sso)
- [Daytona custom preview proxy](https://www.daytona.io/docs/en/custom-preview-proxy)
- [Daytona sandboxes](https://www.daytona.io/docs/en/sandboxes)
- [Daytona on microVMs, pause and fork](https://www.daytona.io/dotfiles/vms-pause-and-fork)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
