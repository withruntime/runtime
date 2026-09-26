# Runtime vs Cloudflare Sandbox

Runtime bills CPU by use, like Cloudflare's Sandbox SDK, and costs **53% less** for an agent that mostly waits on a model.

**The saving:** 1,000 one-minute runs of a 2 vCPU sandbox cost **$0.64 on Runtime
and $1.35 on Cloudflare**. At 100,000 runs a month that is $63.89 against
$135.04, **$71 a month saved**, with no Worker to deploy and no $5 plan to
hold.

## Where Runtime is better

- **About a third of the CPU price.** Active CPU costs $0.025 a vCPU-hour on
  Runtime and $0.072 on Cloudflare. Memory is cheaper too, $0.0075 per GiB-hour
  against $0.009.
- **Memory sized to the job.** Cloudflare needs at least 3 GiB per vCPU, so a
  2 vCPU sandbox pays for 6 GiB. On Runtime you choose vCPUs and memory
  separately and pay for no more.
- **Work survives idle time.** A paused Runtime sandbox wakes with its files,
  memory and running processes, kept for 1 to 365 days. A Cloudflare sandbox
  that sleeps after 10 idle minutes starts again from its image, with its files
  gone unless you backed them up to R2 first.
- **A desktop built in.** Start a Linux desktop in any sandbox and drive it
  with clicks, keys and screenshots. Cloudflare removed its Sandbox SDK desktop
  in version 0.10.2, in June 2026.
- **Call it from any backend, with no platform to join.** Runtime is an API
  with JavaScript and Python SDKs, a CLI and an [MCP server](./mcp); prepaid
  credit from $10 is the whole account. The Sandbox SDK runs inside a Worker on
  the Workers Paid plan, deployed with Wrangler and a local Docker build.
- **Your agent sets itself up.** It runs `npx withruntime sandbox run --trial -- ...`,
  shows you a link, and starts once you approve in the browser. No API key goes
  into a prompt or a config file.

## At a glance

Cloudflare's sandboxes run on Cloudflare Containers, so their prices are the
Containers prices. Cloudflare's figures come from its public pricing and
documentation, checked 23 September 2026.

|                | Runtime                                                   | Cloudflare Sandbox SDK                                   |
| -------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Isolation      | Firecracker microVM, own kernel                           | A container in its own VM                                |
| CPU billing    | $0.025 per vCPU-hour of measured CPU, with a small floor  | $0.072 per active vCPU-hour, metered in 10 ms steps      |
| Memory billing | $0.0075 per reserved GiB-hour                             | $0.009 per provisioned GiB-hour                          |
| Disk           | Included while running; paused storage $0.08 per GB-month | $0.000252 per provisioned GB-hour                        |
| Plan fee       | None; prepaid credit from $10                             | Workers Paid, at least $5 a month                        |
| Free start     | 100 sandbox hours, no card                                | No free tier; the plan includes 375 vCPU-minutes a month |
| Sizes          | Up to 16 vCPUs and 64 GiB paid, chosen apart              | Up to 4 vCPUs, 12 GiB and 20 GB; at least 3 GiB per vCPU |
| When idle      | Pause keeps files and memory; paid retention 1–365 days   | Sleeps after 10 idle minutes by default; files are lost  |
| Interfaces     | API, CLI, MCP server, JavaScript and Python SDKs          | A TypeScript SDK called from a Cloudflare Worker         |

## Cost for the same job

Take 1,000 runs of a 2 vCPU sandbox. Each run lasts 60 seconds and keeps the CPU
busy for 20 CPU-seconds: an agent that spends most of its time waiting for a
model. Runtime gets 4 GiB. Cloudflare's smallest 2 vCPU size has 6 GiB, because
a custom size needs at least 3 GiB per vCPU; it gets 12 GB of disk, the size in
Cloudflare's own example.

```
Runtime     CPU    1,000 × 20 s / 3,600 × $0.025      = $0.14
            Memory 1,000 × 60 s / 3,600 × 4 × $0.0075 = $0.50
            Total                                        $0.64

Cloudflare  CPU    1,000 × 20 s × $0.000020           = $0.40
            Memory 1,000 × 60 s × 6 × $0.0000025      = $0.90
            Disk   1,000 × 60 s × 12 × $0.00000007    = $0.05
            Total                                        $1.35
```

- **Saving:** 53%, or $0.71 per 1,000 runs.
- **Per month:** at 100,000 runs, $63.89 on Runtime against $135.04 on
  Cloudflare.
- **Busier work:** with both CPUs busy for the whole minute, $1.33 on
  Runtime against $3.35 on Cloudflare, a 60% saving.
- **Smaller shapes:** Cloudflare's `standard-1` (half a vCPU, 4 GiB, 8 GB of
  disk) costs $1.03 for the same runs. Runtime's nearest shape, 1 vCPU and
  4 GiB, still costs $0.64, because CPU is billed as measured.

The Cloudflare figure assumes each sandbox is destroyed when its run ends; one
left alone keeps billing memory and disk until it has been idle for 10 minutes.
Workers requests, Durable Object time, the $5 plan minimum, network, taxes and
free allowances are left out of both. See [pricing](./pricing) for Runtime's
terms.

## How to switch

Give your coding agent the one instruction in [migration](./migrate). It
replaces the Cloudflare calls on a branch, tests them on the free trial, and tells
you what you save each month. Your old code stays on the main branch until you
merge.

### From the Sandbox SDK

Cloudflare, inside a Worker (the stable `@cloudflare/sandbox` package; the 1.0
preview returns a process handle from `exec` instead):

```js
import { getSandbox } from "@cloudflare/sandbox";
export { Sandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request, env) {
    const sandbox = getSandbox(env.Sandbox, "my-sandbox");
    const result = await sandbox.exec("python3 -c 'print(6 * 7)'");
    await sandbox.destroy();
    return Response.json({ stdout: result.stdout });
  },
};
```

Runtime, from any server:

```ts
import { Sandbox } from "withruntime";
const box = await Sandbox.create({ funding: "trial" });
try {
  console.log((await box.exec("python3 -c 'print(6 * 7)'", { check: true })).stdout);
} finally {
  await box.stop();
}
```

### Calling Runtime from a Worker

If your application stays on Workers, the Worker can call Runtime itself. This
needs SDK version 0.4.0 or later, and the `nodejs_compat` compatibility flag in
your Wrangler config:

```toml
compatibility_flags = ["nodejs_compat"]
```

A Worker has no saved login, so create a key at
https://withruntime.com/account/keys and store it as a Worker secret, never in
`wrangler.toml` or the source:

```bash no-run
npx wrangler secret put RUNTIME_API_KEY
```

Then create, run and stop:

```ts check
import { Runtime } from "withruntime";

type Env = { RUNTIME_API_KEY: string };

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const runtime = new Runtime({ apiKey: env.RUNTIME_API_KEY });
    // A backstop: the sandbox stops after 5 minutes even if this request is cut off.
    const box = await runtime.sandboxes.create({
      funding: "trial",
      timeoutSeconds: 300,
      onLeaseEnd: "stop",
    });
    try {
      const result = await box.exec("python3 -c 'print(6 * 7)'", { check: true });
      return Response.json({ stdout: result.stdout });
    } finally {
      await box.stop();
    }
  },
};
```

Earlier SDK versions fail inside a Worker with `connection_error`, and without
`nodejs_compat` the Worker does not start. This sample is type-checked against
the SDK, and on 23 September 2026 it ran under `wrangler dev`: it created a
sandbox, ran the command and stopped it.

What does not carry over:

- **The Durable Object binding.** Runtime sandboxes are not part of your Worker,
  so the `Sandbox` export, its Durable Object binding and the `containers`
  entry are not needed for Runtime. Remove them only when nothing uses
  Cloudflare's sandboxes any more.
- **Sandboxes by name.** `getSandbox(env.Sandbox, "my-sandbox")` becomes
  `Sandbox.getOrCreate("my-sandbox", { client: runtime })`: it returns the
  sandbox with that name, woken if it is paused, or creates it. Names are
  unique in your Runtime account, so no KV entry is needed to find it again.
- **`proxyToSandbox`.** Cloudflare routes a sandbox's preview URLs through your
  Worker. Runtime serves a port from its own address instead:
  `box.previews.create(port)` returns an HTTPS URL under `runtimehost.com` and
  a token (see [share a port](./javascript#share-a-port)). The Worker does not proxy it.

## When Cloudflare may fit better

- **Placement near users.** A Cloudflare sandbox starts in the nearest location
  that has its image, across Cloudflare's network. Runtime runs in one US
  region.
- **Your app already lives on Workers.** Sandboxes then share its account,
  billing and bindings, and a directory backed up to R2 can be restored by any
  sandbox.
- **Very large fleets.** A Cloudflare account can run 1,500 vCPUs and 6 TiB of
  memory at once. A paid Runtime account runs 100 sandboxes, 200 vCPUs and 400
  GiB at once (50 sandboxes in its first week), raised on request.

## Sources

Checked 23 September 2026.

- [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Sandbox SDK pricing](https://developers.cloudflare.com/sandbox/platform/pricing/)
- [Containers limits and instance types](https://developers.cloudflare.com/containers/platform/limits/)
- [Containers architecture](https://developers.cloudflare.com/containers/concepts/architecture/)
- [Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/)
  and [sandbox options](https://developers.cloudflare.com/sandbox/configuration/sandbox-options/)
- [Sandbox backup and restore](https://developers.cloudflare.com/sandbox/guides/backup-restore/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Deprecating Sandbox SDK features](https://developers.cloudflare.com/changelog/post/2026-06-09-deprecating-sandbox-sdk-features/)
- [Containers and Sandboxes generally available](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/)
- Runtime [pricing](./pricing), [security](./security) and [products](./products)
