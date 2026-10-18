# Metrics, events and webhooks

See what a sandbox is doing, hear about it when it changes, and send both to
the tools you already watch.

- **Metrics.** Every running sandbox's CPU and memory over time, measured by its
  host. On the sandbox's page in your account, and from the API, the SDKs, the
  CLI and MCP.
- **Events.** Every sandbox, snapshot and volume lifecycle change: created,
  running, paused, woken, stopped, a start that failed.
- **Webhooks.** Those events POSTed to your URL, signed, retried for about three
  days, with a delivery log and a test send.
- **OpenTelemetry export.** Events as logs and CPU and memory as metrics, pushed
  over OTLP/HTTP to Grafana, Honeycomb, Datadog, New Relic, an OpenTelemetry
  Collector or any OTLP endpoint.

None of it costs anything extra.

## Metrics

```ts check
import { Sandbox } from "withruntime";

const sbx = await Sandbox.create();
const m = await sbx.metrics({ range: "1h" });
console.log(m.latest?.cpuPercent, m.latest?.memoryBytes);
for (const point of m.points) console.log(point.at, point.cpuPercent, point.memoryBytes);
```

```python check
from withruntime import Sandbox

sbx = Sandbox.create()
m = sbx.metrics(range="1h")
print(m["latest"]["cpuPercent"], m["latest"]["memoryBytes"])
```

```bash check
npx withruntime sandboxes metrics <id> --range 6h
```

What you get:

| Field                | Meaning                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `cpuPercent`         | CPU in use, as a percent of all the sandbox's vCPUs (0 to 100)              |
| `cpuCores`           | The same as a number of cores                                               |
| `cpuPeakPercent`     | The busiest interval between two readings inside the bucket                 |
| `cpuWaitPercent`     | Measured wall time ready to run while waiting for a processor, as a percent |
| `memoryStallPercent` | Measured wall time with a thread waiting for memory, as a percent           |
| `memoryBytes`        | Memory the sandbox's machine holds, as its host measures it                 |
| `memoryPeakBytes`    | The most it held inside the bucket                                          |
| `latest`             | The newest reading while the sandbox runs; null when it is not running      |

CPU is measured, not estimated: the machine's CPU time between two readings of
its host, the same reading the bill is made from. The host reads every running
sandbox at least every half minute. A paused or stopped sandbox uses nothing
and has no new readings: `latest` is null, and its earlier readings stay in
`points`.

CPU wait and memory stalls use the differences between complete readings of the
same run, weighted by the time measured. A first reading, missing counter or
counter reset returns null, rather than reporting no waiting. The same fields
are in `points` and `latest`; older servers can omit them.

`range` picks the window and the bucket each point sums:

| Range | Bucket     | Kept for |
| ----- | ---------- | -------- |
| `15m` | 10 seconds | 24 hours |
| `1h`  | 20 seconds | 24 hours |
| `6h`  | 2 minutes  | 24 hours |
| `24h` | 8 minutes  | 24 hours |
| `7d`  | 1 hour     | 30 days  |
| `30d` | 1 hour     | 30 days  |

Each reading is kept 24 hours. Hourly averages and peaks are kept 30 days.

In your account, [Sandboxes](https://withruntime.com/account/sandboxes) shows
each sandbox's CPU and memory now, and Home draws a trace of each running one.
A sandbox's own page charts CPU with its events marked on it, and its Activity
tab charts CPU, memory, CPU wait and memory stalls over any of the ranges above,
updating while it runs,
and lists its commands and what happened to it. Once it has stopped, its page
shows its whole life: CPU and memory from start to stop, and a timeline of its
events and commands. CPU wait is time ready to run while waiting for a
processor; a memory stall is time with a thread waiting for memory. A first
reading, a missing counter or a counter reset shows as not measured, never as
no waiting.

## Account API calls

[Usage & billing](https://withruntime.com/account/billing) shows the account's
recorded authenticated calls, its error rate and service errors, grouped by
operation, over 24 hours, 7, 30 or 90 days. Refused calls are 4xx answers; service errors are 5xx. The error rate
includes both, with every recorded answer, redirects included, in its total. A
window with no counted calls has a null rate. A failed read remains unavailable.

`GET /v1/usage/requests?range=24h` serves the same counts. The other ranges are
`7d`, `30d` and `90d`. Each window is a fixed number of hourly buckets, ending
with the current partial hour; `since` is inclusive and `until` is the read
time. Counts are written about once a minute. Requests that never authenticated
are excluded, and a key needs the `usage` scope or a read-only or all-products
key. Every account member can read the account's counts on the website.

`calls`, `clientErrors` and `serverErrors` are exact integer decimal strings.
`errorPercent` is a percentage rounded to two decimal places, or null with no
calls. `operations` contains the same fields and an `operation` name per row.
These are recorded API answers; they are separate from the [uptime promise](/legal/sla).

For billing detail over a chosen period, the same page exports settled usage
as a CSV file, and [export settled usage](./api#export-settled-usage) covers
every resource visible to your key. It keeps exact amounts and includes
settled charges, while pending holds stay separate.

## Commands

Each command run in a sandbox through the API, an SDK, the CLI or MCP is kept
14 days as its program's name, its exit code and how long it ran:
`pytest · exit 1 · 28 s`. A command still running shows as running; a process
started in the background gets its exit when a read or a list of its processes
sees it end, and one never read before its sandbox stopped says so. The name
is the program alone (`python3` for `FOO=1 python3 train.py --key …`, `pytest`
for `bash -c "pytest -q"`); arguments and environment values are never stored
([security](./security#keys-and-secrets)). A terminal is kept as its shell
(`bash`), never what is typed in it. A code interpreter cell, including E2B's
`runCode`, is kept as its language and `-cell` (`python-cell · exit 1 · 2 s`
for a cell that raised), never its code.

Code written for E2B's `getMetrics()` gets CPU and memory from these readings
through `withruntime/e2b`; its `diskUsed` is null.

## Events

Every lifecycle change of a sandbox, a snapshot or a volume is an event, kept
14 days, and so is every change to your egress secrets and your upstream
proxy.

| Type                         | When                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sandbox.created`            | A sandbox is made; it is starting                                                                            |
| `sandbox.running`            | It is ready and running                                                                                      |
| `sandbox.paused`             | It paused, keeping its memory and files                                                                      |
| `sandbox.woken`              | A paused sandbox is running again                                                                            |
| `sandbox.stopped`            | It stopped. `stopReason` says why                                                                            |
| `sandbox.start_failed`       | It stopped before it ever ran; `sandbox.stopped` follows                                                     |
| `sandbox.wake_failed`        | A wake did not complete; the sandbox is paused or stopped                                                    |
| `sandbox.host_unreachable`   | Its server has not answered for 35 s, so what runs there is frozen; `host.unreachableSince` says since when  |
| `sandbox.host_reachable`     | Its server answers again, and the sandbox runs on as it was                                                  |
| `sandbox.recovered`          | Its server was lost and it is back; `recovery` says from when                                                |
| `sandbox.recovery_failed`    | Its server was lost and it cannot come back; `recovery.reason` says why                                      |
| `sandbox.files.changed`      | Files changed under a watch that sends to webhooks                                                           |
| `sandbox.out_of_memory`      | The sandbox ran out of memory and Linux ended a command's program; `outOfMemory` says how many and its size  |
| `sandbox.secret_not_applied` | A request carried a secret's placeholder that was not replaced; `secretNotApplied` says which secret and why |
| `snapshot.ready`             | A snapshot finished and can be started from                                                                  |
| `snapshot.failed`            | A snapshot could not be taken                                                                                |
| `snapshot.deleted`           | A snapshot was deleted or expired                                                                            |
| `volume.ready`               | A volume is made and can be attached                                                                         |
| `volume.failed`              | A volume could not be made                                                                                   |
| `volume.deleted`             | A volume was deleted                                                                                         |
| `volume.recovered`           | Its server was lost and it is back on another, from the copy kept of it; `recovery` says from when           |
| `egress_secret.created`      | An egress secret was added; `secret` has its name, hosts and number of rules, never its value                |
| `egress_secret.updated`      | An egress secret was replaced                                                                                |
| `egress_secret.deleted`      | An egress secret was deleted                                                                                 |
| `upstream_proxy.set`         | Your upstream proxy was set or changed; `upstreamProxy` has its address, credential's name and hosts         |
| `upstream_proxy.removed`     | Your upstream proxy was removed                                                                              |
| `credit.low`                 | Credit lasts under 5 days at this month's pace; `credit` has what is left and what 5 days need               |
| `credit.empty`               | No credit is left; `credit` has `availableMicros` and `agentOnly`                                            |

Each event carries the resource as it was:

```json
{
  "id": "0b8f2a61-4c3e-4e7a-9d2f-6c1b0e5a7d94",
  "type": "sandbox.stopped",
  "createdAt": "2026-09-23T15:04:05.123Z",
  "data": {
    "sandbox": {
      "id": "7f3a2c10-58d4-4b9e-9c61-0a2b3c4d5e6f",
      "name": "build-runner",
      "labels": { "team": "ml" },
      "state": "stopped",
      "previousState": "stopping",
      "stopReason": "requested",
      "vcpu": 2,
      "memoryMiB": 4096,
      "diskMiB": 10240,
      "region": "us-east",
      "funding": "paid",
      "pausable": true
    }
  }
}
```

`sandbox.out_of_memory` is sent once for each command the out-of-memory killer
ended: for a command run to its end, with its result; for a background
process, when it is first read, got or listed after it ended. A process
nobody reads after it ends sends none. The command is named by its program
only, never its arguments:

```json
{
  "type": "sandbox.out_of_memory",
  "data": {
    "sandbox": {
      "id": "7f3a2c10-58d4-4b9e-9c61-0a2b3c4d5e6f",
      "state": "running",
      "memoryMiB": 512
    },
    "command": { "program": "node", "processId": "p-4", "exitCode": -9, "outcome": "exited" },
    "outOfMemory": { "code": "out_of_memory", "processesKilled": 1, "memoryMiB": 512 }
  }
}
```

`sandbox.secret_not_applied` is sent when a request from the sandbox carried
an [egress secret](./security#secrets-sandboxes-never-see)'s placeholder that
went out as it is, so the server got the placeholder and not the key. It is
sent once for each secret, reason and destination of a sandbox, with the
host's next usage reading, within about a minute. The placeholder is never the
secret, so nothing leaked; the event names the secret, never its placeholder
or value. `reason` is one of:

| `reason`                   | What happened                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `unencrypted`              | It went without TLS, over plain HTTP or another cleartext protocol. A secret goes only over HTTPS |
| `not_in_credential_header` | It went to the secret's host in the path or query (`place` is `target`) or in the `place` header  |
| `rule_not_matched`         | It went in a credential header, but none of the secret's `rules` allows that method and path      |
| `by_address`               | HTTPS went to an IP address, asking for one of the secret's hosts. Use the host name in the URL   |
| `withheld`                 | HTTPS went to the secret's host, but its server could not add the secret then. Runtime's fault    |

`withheld` is sent for a connection to the secret's host whether or not it
carried the placeholder, since Runtime does not read inside a connection it
could not add the secret to. Try again, and write to support if it repeats.

Runtime does not read inside HTTPS to a host no secret names, so a placeholder
sent there sends no event: check the host against `npx withruntime secrets ls`.

```json
{
  "type": "sandbox.secret_not_applied",
  "data": {
    "sandbox": { "id": "7f3a2c10-58d4-4b9e-9c61-0a2b3c4d5e6f", "state": "running" },
    "secretNotApplied": {
      "secret": { "name": "OPENAI_API_KEY" },
      "reason": "unencrypted",
      "destination": { "host": "api.openai.com", "port": 80 },
      "at": "2026-10-10T18:00:00.000Z",
      "message": "A request to api.openai.com:80 carried the placeholder of OPENAI_API_KEY without HTTPS, so the secret was not added. A secret goes only over HTTPS."
    }
  }
}
```

`credit.low` and `credit.empty` are about the account, so they have no
`resourceId` and carry `data.credit`. Each is sent once for each top-up: a new
top-up starts the count again. `credit.low` is sent when the credit left lasts
under 5 days at this month's pace, the same rule as the low-credit notice in
the inbox and by email. `credit.empty` is sent when none is left. Amounts are
strings of micro-dollars (1,000,000 to the dollar). `requiredMicros` is the
pace over 5 days and is only in `credit.low`. `agentOnly` is `true` when the
account was opened with a wallet and no person may pay for it: its own agent
adds credit itself, with its own key.

```json
{
  "type": "credit.low",
  "data": {
    "credit": { "availableMicros": "3200000", "requiredMicros": "4100000", "agentOnly": true }
  }
}
```

`sandbox.files.changed` comes only from a file watch started with
`webhook: true` ([files in the API guide](./api#files)): Runtime reads the watch
without waking the sandbox and sends what changed since the last read, at most
once every {{file-hook-window}} a watch, with up to {{file-hook-events}}
changes. `more` counts the ones left out, and `overflow` says changes were
dropped (a flood, or the watch fell behind): list the folder again for either.
`ended` says the watch stopped (`timeout`, `stopped`, `root-removed`, `gone`
when the sandbox restarted). While a sandbox that pauses itself does nothing,
its watch is not read, so the watch never keeps it awake; a change arrives
within seconds of the sandbox next doing work, or when it wakes.

```json
{
  "type": "sandbox.files.changed",
  "data": {
    "sandbox": { "id": "7f3a2c10-58d4-4b9e-9c61-0a2b3c4d5e6f", "name": "build-runner" },
    "watch": { "id": "sync", "path": "/workspace/app" },
    "events": [
      { "type": "write", "path": "/workspace/app/notes.md", "isDir": false, "count": 2 },
      {
        "type": "rename",
        "path": "/workspace/app/b.txt",
        "oldPath": "/workspace/app/a.txt",
        "isDir": false
      }
    ]
  }
}
```

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const sbx = await runtime.sandboxes.get("<sandbox id>");
await sbx.files.watches.webhook("/workspace/app", { recursive: true, id: "sync" });
```

List them newest first, for the account or one sandbox:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const { data } = await runtime.events.list({ resourceId: "<sandbox id>" });
```

```bash check
npx withruntime events --sandbox <id>
```

## Webhooks

A webhook sends every event of the types you choose to an HTTPS URL, as a POST
of the event's JSON, for every sandbox in the account. It belongs to the
account, so every key sees the same webhooks. Making, changing or deleting one,
or reading its deliveries, needs a key made by an owner or admin, as do
[OpenTelemetry exports](#opentelemetry-export); another key gets 403 `forbidden`. An
account can have 16.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const hook = await runtime.webhooks.create({
  url: "https://example.com/hooks/runtime",
  events: ["sandbox.stopped", "sandbox.start_failed"], // or leave out for every event
});
console.log(hook.secret); // shown once: keep it with your service
console.log(await runtime.webhooks.test(hook.id)); // your endpoint's answer
```

```bash check
npx withruntime webhooks create https://example.com/hooks/runtime --events sandbox.stopped,sandbox.start_failed
npx withruntime webhooks test <id>
npx withruntime webhooks deliveries <id>
```

Owners and admins can do the same on the [Webhooks page](https://withruntime.com/account/webhooks),
which picks event types grouped by product and shows each webhook's delivery
log, with **Resend** on each finished delivery and a CSV download of every
delivery kept.

### Check the signature

Every delivery carries a `Runtime-Signature` header:

```text
Runtime-Signature: t=1758650000,v1=5f2b…
```

`t` is when it was sent, in Unix seconds. `v1` is the hex HMAC-SHA256 of
`{t}.{body}`, keyed with your secret. Check it before trusting a delivery. The
SDKs do it, and refuse a signature older than five minutes so a captured
delivery cannot be replayed. Pass the raw body, before any JSON parsing.

```ts check
import { verifyWebhook } from "withruntime";

export async function POST(request: Request) {
  const event = await verifyWebhook(
    await request.text(),
    request.headers.get("runtime-signature"),
    process.env.RUNTIME_WEBHOOK_SECRET!,
  );
  if (event.type === "sandbox.stopped") {
    // ...
  }
  return new Response(null, { status: 204 });
}
```

```python check
import os

from withruntime import verify_webhook


def handle(body: bytes, headers: dict) -> int:
    event = verify_webhook(body, headers.get("runtime-signature"), os.environ["RUNTIME_WEBHOOK_SECRET"])
    if event["type"] == "sandbox.stopped":
        pass
    return 204
```

Other headers: `Runtime-Webhook-Id` is the event's id, the same on every
retry, so you can skip one you already handled. `Runtime-Event-Type`,
`Runtime-Delivery-Id` and `Runtime-Delivery-Attempt` are there too.

### Answer, retries and the delivery log

Answer with any 2xx within 10 seconds. Anything else, a timeout, or a redirect
counts as a failure and is retried: after 1 minute, 5 minutes, 15 minutes,
1 hour, 3 hours, 6 hours, 12 hours, 24 hours and 24 hours again, ten attempts
in about three days. Deliveries are not guaranteed to arrive in order; order
them by `createdAt`.

`runtime.webhooks.deliveries(id)` (or `npx withruntime webhooks deliveries <id>`)
lists each delivery with its attempts, your endpoint's status and how long it
took. `runtime.webhooks.retry(deliveryId)` sends one again. The webhook shows
`failingSince` while its deliveries fail. Deliveries are kept 14 days.

### Rotate the secret

`runtime.webhooks.rotateSecret(id)` makes a new secret and shows it once. The
old secret keeps signing beside it for a day, so every delivery carries two
`v1` signatures until your service has the new one; pass
`keepPreviousSeconds` to choose from 0 to a week. `verifyWebhook` accepts a
list of secrets, for the same reason.

### Where webhooks can go

HTTPS on the public internet. A URL that names a private, loopback or
link-local address is refused when the webhook is made. Every delivery resolves
the name again when it is sent, refuses it if any address is private, and
connects only to the address it checked.

## OpenTelemetry export

An export pushes new events as OTLP log records and each sandbox's readings as
OTLP metrics, about every 30 seconds, to any endpoint that takes OTLP over HTTP
with JSON. It starts from the moment you make it.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.otel.create({
  endpoint: "https://otlp-gateway-prod-us-east-0.grafana.net/otlp",
  headers: { Authorization: "Basic <instance id:token, base64>" },
});
```

```bash check
npx withruntime otel create https://api.honeycomb.io --header x-honeycomb-team=<key>
```

- `endpoint` is the OTLP/HTTP base URL, as `OTEL_EXPORTER_OTLP_ENDPOINT`: logs
  go to `<endpoint>/v1/logs` and metrics to `<endpoint>/v1/metrics`.
- `headers` authenticate you to the endpoint, up to 10. They are stored where
  only the sender reads them and never shown again.
- `signals` is `["logs", "metrics"]` by default; send one of them if you prefer.

The metrics are gauges, one resource per sandbox with `runtime.sandbox.id`,
`runtime.sandbox.name`, `runtime.sandbox.vcpu` and `cloud.region`:

| Metric                            | Unit    | Meaning                               |
| --------------------------------- | ------- | ------------------------------------- |
| `runtime.sandbox.cpu.utilization` | `1`     | CPU in use as a fraction of its vCPUs |
| `runtime.sandbox.cpu.usage`       | `{cpu}` | Cores in use                          |
| `runtime.sandbox.memory.usage`    | `By`    | Memory its machine holds              |
| `runtime.sandbox.memory.limit`    | `By`    | Its memory size                       |

Each log record's body is the event type. Its attributes are `event.name`,
`event.id` and the resource's fields, such as `runtime.sandbox.state`,
`runtime.sandbox.stop_reason` and `runtime.sandbox.label.<key>`. A failure
(`start_failed`, `wake_failed`, `recovery_failed`, `failed`) is WARN; the rest
are INFO.

A push that fails is retried, waiting 30 seconds and doubling to an hour, and
sends from where it stopped. `runtime.otel.get(id)` shows `lastSuccessAt`,
`lastError` and how much it has sent; `runtime.otel.flush(id)` pushes now. An
account can have three exports.

## MCP

`runtime_sandboxes_metrics` reads a sandbox's CPU, memory, CPU wait and memory stalls, and
`runtime_events_list` its events. `runtime_webhooks_manage` and
`runtime_otel_manage` list, create, test and change webhooks and exports.
