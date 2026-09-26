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
npx withruntime sandbox metrics <id> --range 6h
```

What you get:

| Field             | Meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `cpuPercent`      | CPU in use, as a percent of all the sandbox's vCPUs (0 to 100)        |
| `cpuCores`        | The same as a number of cores                                         |
| `cpuPeakPercent`  | The busiest interval between two readings inside the bucket           |
| `memoryBytes`     | Memory the sandbox's machine holds, as its host measures it           |
| `memoryPeakBytes` | The most it held inside the bucket                                    |
| `latest`          | The newest reading, or null when there is none in the last 15 minutes |

CPU is measured, not estimated: the machine's CPU time between two readings of
its host, the same reading the bill is made from. The host reads every running
sandbox once a minute. A paused or stopped sandbox has no new readings; its
earlier ones stay.

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
A sandbox's own page charts CPU with its events marked on it, and its Metrics
tab charts CPU and memory over any of the ranges above, updating while it runs.
Its Events tab lists what happened to it.

Code written for E2B's `getMetrics()` gets CPU and memory from these readings
through `withruntime/e2b`; its `diskUsed` is null.

## Events

Every lifecycle change of a sandbox, a snapshot or a volume is an event, kept
14 days.

| Type                   | When                                                      |
| ---------------------- | --------------------------------------------------------- |
| `sandbox.created`      | A sandbox is made; it is starting                         |
| `sandbox.running`      | It is ready and running                                   |
| `sandbox.paused`       | It paused, keeping its memory and files                   |
| `sandbox.woken`        | A paused sandbox is running again                         |
| `sandbox.stopped`      | It stopped. `stopReason` says why                         |
| `sandbox.start_failed` | It stopped before it ever ran; `sandbox.stopped` follows  |
| `sandbox.wake_failed`  | A wake did not complete; the sandbox is paused or stopped |
| `snapshot.ready`       | A snapshot finished and can be started from               |
| `snapshot.failed`      | A snapshot could not be taken                             |
| `snapshot.deleted`     | A snapshot was deleted or expired                         |
| `volume.ready`         | A volume is made and can be attached                      |
| `volume.failed`        | A volume could not be made                                |
| `volume.deleted`       | A volume was deleted                                      |

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
      "region": "us-east-vin",
      "funding": "paid",
      "pausable": true
    }
  }
}
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
of the event's JSON. It belongs to the account, so every key and every owner
sees the same webhooks. An account can have 16.

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

Owners can do the same on the [Webhooks page](https://withruntime.com/account/webhooks),
which picks event types grouped by product and shows each webhook's delivery
log, with **Resend** on each finished delivery.

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
(`start_failed`, `wake_failed`, `failed`) is WARN; the rest are INFO.

A push that fails is retried, waiting 30 seconds and doubling to an hour, and
sends from where it stopped. `runtime.otel.get(id)` shows `lastSuccessAt`,
`lastError` and how much it has sent; `runtime.otel.flush(id)` pushes now. An
account can have three exports.

## MCP

`runtime_sandbox_metrics` reads a sandbox's CPU and memory, and
`runtime_events_list` its events. `runtime_webhooks_manage` and
`runtime_otel_manage` list, create, test and change webhooks and exports.
