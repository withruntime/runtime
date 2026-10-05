# Runtime vs E2B

Runtime runs agent code in Firecracker microVMs, like E2B, **for {{saving:e2b}} less** on an agent that spends most of its time waiting on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **{{cost:runtime}} on
Runtime and {{cost:e2b}} on E2B**. At 100,000 runs a month that is {{cost:runtime:100000}} against
{{cost:e2b:100000}}, **{{=$0 less:e2b:100000}} a month saved**. Your E2B code keeps working: change one import.

Weighing more than two? [E2B alternatives](/compare/e2b-alternatives) ranks the other providers by the cost of the same job.

## Where Runtime is better

- **You pay for the CPU you use.** E2B bills every vCPU for as long as the
  sandbox runs. Runtime measures the CPU your code actually uses, so time spent
  waiting on a model costs only a small floor, {{cpu-floor-share}}.
- **Waiting costs storage, not compute.** Left idle for {{idle-pause}}, a Runtime
  sandbox pauses by itself with its memory kept, then pays {{paused-storage-rate}} per GB (10⁹ bytes) a
  month until a request wakes it; the next command runs {{server-wake-command}} after that, timed on
  Runtime's servers.
- **Back from a pause in milliseconds.** E2B states a resume takes {{speed:e2b:wake}} and a
  pause {{speed:e2b:pause}}. On Runtime's servers a wake takes {{server-wake}} and a pause
  answers in {{server-pause}}, and a new sandbox is running {{server-create}} after the create
  request, against E2B's {{speed:e2b:create}} ([speed](./speed)).
- **A written uptime promise.** {{uptime-promise}} API uptime a month for paid accounts,
  measured from outside, and {{uptime-credit}} of a short month's charges back as credit
  automatically ([Uptime Promise](/legal/sla)).
- **Lower rates on both meters.** {{cpu-rate}} per vCPU-hour against E2B's {{rate:e2b:cpu}},
  and {{memory-rate}} per GiB-hour of memory against {{rate:e2b:memory}}. Even with every CPU busy
  the whole time, the example job costs {{cost:runtime:busy}} on Runtime and {{cost:e2b}} on E2B.
- **No plan fee for long sessions.** E2B caps a session at 1 hour on Hobby and
  needs the {{term:e2b:pro}}-a-month Pro plan for 24. A Runtime sandbox has no time limit:
  it runs while it works, with no plan at all: prepaid credit from {{topup-min}}.
- **A one-line switch.** `withruntime/e2b` runs code written for E2B's SDK, in
  JavaScript and Python, including the code interpreter. Run `runtime switch --from e2b` before your
  first top-up and it is matched, up to {{switching-max}}.
- **Teams at no extra charge.** Single sign-on over SAML or OIDC (Okta,
  Microsoft Entra ID, Google Workspace), SCIM, roles and an audit log come with
  every account ([single sign-on](./single-sign-on)). E2B lists SSO, SCIM and roles as
  planned for its Enterprise plan.
- **OpenTelemetry export on every account.** Runtime pushes events as logs and
  CPU and memory as metrics to any OTLP endpoint, at no charge
  ([observability](./observability#opentelemetry-export)). E2B sends OTLP
  metrics and logs on its Enterprise plan.
- **Custom domains built in.** A paid account serves a sandbox port at your own
  hostname, with HTTPS, from one command ([custom domains](./networking#custom-domains)).
  E2B's custom domain guide has you run your own proxy on a virtual machine.
- **Secrets stay outside the sandbox.** Code inside sees a placeholder; the
  real key is added at the egress proxy, only on HTTPS to the hosts you allow
  ([security](./security)).
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Give an agent a read-only key or a daily spending
  limit per key, and cap any sandbox's whole cost with `maxTotalCostMicros`. Every write takes an
  idempotency key and the SDKs retry with it, so a lost response never creates
  a second sandbox.

**Also included:** a code interpreter, network allow and deny lists, custom
images, volumes backed up daily, snapshots and forks with memory, private
previews, a Linux desktop, metrics, webhooks, S3, R2 and GCS bucket mounts, MCP
servers from a catalog and identity tokens for AWS and Google Cloud. Paid
accounts add TCP ports, dedicated outbound addresses and WireGuard private
networks. See [products](./products).

## At a glance

E2B's figures come from its public pricing and documentation, checked
{{checked:e2b}}.

|                  | Runtime                                                                     | E2B                                                    |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| Isolation        | Firecracker microVM, own kernel                                             | Firecracker microVM, own kernel                        |
| CPU billing      | {{cpu-rate}} per vCPU-hour of measured CPU, with a small floor              | {{rate:e2b:cpu}} per allocated vCPU-hour               |
| Memory billing   | {{memory-rate}} per reserved GiB-hour                                       | {{rate:e2b:memory}} per GiB-hour                       |
| Plan fee         | None; prepaid credit from {{topup-min}}                                     | Hobby {{term:e2b:hobby}}; Pro {{term:e2b:pro}} a month |
| Free start       | {{trial-hours}} sandbox hours, no card                                      | {{term:e2b:credit}} of usage credit on Hobby           |
| Session length   | No time limit: runs while it works, pauses itself after {{idle-pause}} idle | 1 hour on Hobby, 24 hours on Pro                       |
| Pause and resume | Files, memory and running processes                                         | Files, memory and running processes                    |
| Interfaces       | API, CLI, MCP server, JavaScript, Python, Go, Ruby and Java SDKs            | API, CLI, MCP server, JavaScript and Python SDKs       |
| Agent sign-in    | Browser approval; no key in the agent's config                              | API key                                                |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model.

```
Runtime  CPU    1,000 × 20 s / 3,600 × {{cpu-rate}}      = {{part:runtime:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{memory-rate}} = {{part:runtime:memory}}
         Total                                        {{cost:runtime}}

E2B      CPU    1,000 × 60 s / 3,600 × 2 × {{rate:e2b:cpu}} = {{part:e2b:cpu}}
         Memory 1,000 × 60 s / 3,600 × 4 × {{rate:e2b:memory}} = {{part:e2b:memory}}
         Total                                        {{cost:e2b}}
```

- **Saving:** {{saving:e2b}}, or {{less:e2b}} per 1,000 runs.
- **Per month:** at 100,000 runs, {{cost:runtime:100000}} on Runtime against {{cost:e2b:100000}} on E2B.
- **Busier work:** with both CPUs busy for the whole minute, {{cost:runtime:busy}} on
  Runtime against {{cost:e2b:busy}} on E2B. At this size, Runtime is cheaper however busy the
  sandbox is.

Plan fees, storage, network, taxes and free credits are left out of both.
`runtime compare --from e2b` prices your own usage the same way, with
sandboxes the free trial paid for at the standard rates, so trial time never
counts as a saving. On Runtime, inbound traffic is free, and each account's
first {{outbound-allowance}} out a month is free, then {{outbound-rate}} per GB (10⁹ bytes). See [pricing](./pricing)
for Runtime's terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the E2B calls on a branch, tests them on the free trial, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

### Change one import

Runtime's SDK (0.4.0 and later) runs code written for E2B's SDK. Change the
import and set `RUNTIME_API_KEY`:

```ts no-run
import { Sandbox } from "withruntime/e2b"; // was: from "e2b"
```

```python no-run
from withruntime.e2b import Sandbox  # was: from e2b import Sandbox
```

`withruntime/e2b/code-interpreter` and `withruntime.e2b.code_interpreter`
replace E2B's code interpreter packages. Sandboxes get E2B's defaults: 2 vCPU,
512 MiB and a 300-second timeout, after which they stop. Unlike E2B's, they
pause after {{idle-pause}} with nothing happening and wake on the next call;
`runtime: { create: { idlePauseSeconds: 0 } }` keeps them running. They use the free
trial while the account has trial time, then prepaid credit, with nothing to
choose.

`commands.run` returns the command's whole output and, as E2B's does, throws
`CommandExitError` (Python `CommandExitException`) on a non-zero exit and
`TimeoutError` (Python `TimeoutException`) past its timeout, so your existing
error handling keeps working. If any output was lost before it was read, the
result's `truncated` is set and a warning says so.

A call Runtime handles differently, such as E2B templates, workload identity or
ending a sandbox earlier than its time limit, throws `NotSupportedError` before
anything happens and names what to use instead. `E2B.md` in the package lists
every mapping.

### Or port the calls

The calls map one to one for most integrations.

E2B:

```js
import { Sandbox } from "e2b";
const sbx = await Sandbox.create();
const result = await sbx.commands.run("python3 -c 'print(sum([125, 250, 375]))'");
await sbx.kill();
```

Runtime:

```ts
import { Sandbox } from "withruntime";
const box = await Sandbox.create({ funding: "trial" });
try {
  await box.files.write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n");
  console.log((await box.exec("python3 /workspace/invoice.py", { check: true })).stdout);
} finally {
  await box.stop();
}
```

E2B's `commands.run` throws `CommandExitError` on a non-zero exit; Runtime's
`exec` returns the result with `exitCode` (and `timedOut: true` on a timeout),
and `{ check: true }`, as above, makes it throw `CommandError` instead.

## When E2B may fit better

- **Self-hosting.** E2B publishes its runtime under Apache-2.0, so you can run
  it on your own servers. Runtime is a hosted service.

## Sources

Checked 23 September 2026; single sign-on, OpenTelemetry and custom domains
checked 27 September 2026.

- [E2B pricing](https://e2b.dev/pricing)
- [E2B Enterprise](https://e2b.dev/enterprise)
- [E2B custom domain](https://docs.e2b.dev/sandbox/custom-domain)
- [E2B sandbox persistence](https://docs.e2b.dev/sandbox/persistence)
- [E2B security](https://e2b.dev/security)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
