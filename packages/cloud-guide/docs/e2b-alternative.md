# Runtime vs E2B

Runtime runs agent code in Firecracker microVMs, like E2B, **for 77% less** on an agent that spends most of its time waiting on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU, 4 GiB sandbox cost **$0.64 on
Runtime and $2.76 on E2B**. At 100,000 runs a month that is $63.89 against
$276.00, **$212 a month saved**. Your E2B code keeps working: change one import.

## Where Runtime is better

- **You pay for the CPU you use.** E2B bills every vCPU for as long as the
  sandbox runs. Runtime measures the CPU your code actually uses, so time spent
  waiting on a model costs only a small floor, a twentieth of a vCPU.
- **Lower rates on both meters.** $0.025 per vCPU-hour against E2B's $0.0504,
  and $0.0075 per GiB-hour of memory against $0.0162. Even with every CPU busy
  the whole time, the example job costs $1.33 on Runtime and $2.76 on E2B.
- **No plan fee for long sessions.** E2B caps a session at 1 hour on Hobby and
  needs the $150-a-month Pro plan for 24. A Runtime sandbox runs as long as you
  keep extending its lease, with no plan at all: prepaid credit from $10.
- **A one-line switch.** `withruntime/e2b` runs code written for E2B's SDK, in
  JavaScript and Python, including the code interpreter.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file, and the [MCP server](./mcp) reuses the same
  connection.
- **Guardrails for agents.** Give an agent a read-only key or a daily spending
  limit per key, and cap any create with `maxCostMicros`. Every write takes an
  idempotency key and the SDKs retry with it, so a lost response never creates
  a second sandbox.

## At a glance

E2B's figures come from its public pricing and documentation, checked
23 September 2026.

|                  | Runtime                                                  | E2B                                              |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Isolation        | Firecracker microVM, own kernel                          | Firecracker microVM, own kernel                  |
| CPU billing      | $0.025 per vCPU-hour of measured CPU, with a small floor | $0.0504 per allocated vCPU-hour                  |
| Memory billing   | $0.0075 per reserved GiB-hour                            | $0.0162 per GiB-hour                             |
| Plan fee         | None; prepaid credit from $10                            | Hobby $0; Pro $150 a month                       |
| Free start       | 100 sandbox hours, no card                               | $100 of usage credit on Hobby                    |
| Session length   | Leases of up to an hour, extended as often as needed     | 1 hour on Hobby, 24 hours on Pro                 |
| Pause and resume | Files, memory and running processes                      | Files, memory and running processes              |
| Interfaces       | API, CLI, MCP server, JavaScript and Python SDKs         | API, CLI, MCP server, JavaScript and Python SDKs |
| Agent sign-in    | Browser approval; no key in the agent's config           | API key                                          |

## Cost for the same job

Take 1,000 runs of a 2 vCPU, 4 GiB sandbox. Each run lasts 60 seconds and
keeps the CPU busy for 20 CPU-seconds: an agent that spends most of its time
waiting for a model.

```
Runtime  CPU    1,000 × 20 s / 3,600 × $0.025      = $0.14
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0075 = $0.50
         Total                                        $0.64

E2B      CPU    1,000 × 60 s / 3,600 × 2 × $0.0504 = $1.68
         Memory 1,000 × 60 s / 3,600 × 4 × $0.0162 = $1.08
         Total                                        $2.76
```

- **Saving:** 77%, or $2.12 per 1,000 runs.
- **Per month:** at 100,000 runs, $63.89 on Runtime against $276.00 on E2B.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on
  Runtime against $2.76 on E2B. At this size, Runtime is cheaper however busy the
  sandbox is.

Plan fees, storage, network, taxes and free credits are left out of both. See
[pricing](./pricing) for Runtime's terms.

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
512 MiB and a 300-second timeout, after which they stop. They use the free
trial while the account has trial time, then prepaid credit.

`commands.run` returns the command's whole output and throws
`CommandExitError` on a non-zero exit, as E2B's does. If any output was lost
before it was read, the result's `truncated` is set and a warning says so.

A call Runtime handles differently, such as E2B templates, workload identity or
a single lease over an hour, throws `NotSupportedError` before anything happens
and names what to use instead. `E2B.md` in the package lists every mapping.

### Or port the calls

The calls map one to one for most integrations.

E2B:

```js
import { Sandbox } from "e2b";
const sbx = await Sandbox.create();
const result = await sbx.commands.run("python3 -c 'print(6 * 7)'");
await sbx.kill();
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

E2B's `commands.run` throws `CommandExitError` on a non-zero exit; Runtime's
`exec` returns the result with `exitCode` (and `timedOut: true` on a timeout),
and `{ check: true }`, as above, makes it throw `CommandError` instead.

## When E2B may fit better

- **Self-hosting.** E2B publishes its runtime under Apache-2.0, so you can run
  it on your own servers. Runtime is a hosted service.
- **Keeping paused sandboxes forever.** E2B keeps a paused sandbox with no
  expiry. Runtime keeps one for the retention you set, up to 365 days.

## Sources

Checked 23 September 2026.

- [E2B pricing](https://e2b.dev/pricing)
- [E2B sandbox persistence](https://docs.e2b.dev/sandbox/persistence)
- [E2B security](https://e2b.dev/security)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
