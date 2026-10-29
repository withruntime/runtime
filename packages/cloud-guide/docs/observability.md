# Metrics, events and webhooks

See what a sandbox is doing. Get notified when it changes. Send both to the tools you already use.

- **Metrics.** The CPU, memory, disk use, disk I/O and network traffic of every running sandbox, over time. You can see them on the sandbox's page in your account. You can also get them from the API, the SDKs, the CLI and MCP.
- **Events.** Every lifecycle change for a sandbox, snapshot or volume. Examples: created, running, paused, woken, stopped, or a start that failed.
- **Webhooks.** Those events are sent as POSTs to your URL. Each is signed and retried for about three days. You get a delivery log and a test send.
- **OpenTelemetry export.** Events are pushed as logs. Each sandbox's readings are pushed as metrics. Every API call can be pushed as a trace span. The push uses OTLP/HTTP. Targets include Grafana, Honeycomb, Datadog, New Relic, an OpenTelemetry Collector, or any OTLP endpoint.

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

| Field                                               | Meaning                                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `cpuPercent`                                        | CPU in use, as a percent of all the sandbox's vCPUs (0 to 100)                                                 |
| `cpuCores`                                          | The same as a number of cores                                                                                  |
| `cpuPeakPercent`                                    | The busiest interval between two readings inside the bucket                                                    |
| `cpuWaitPercent`                                    | Measured wall time ready to run while waiting for a processor, as a percent                                    |
| `memoryStallPercent`                                | Measured wall time with a thread waiting for memory, as a percent                                              |
| `memoryBytes`                                       | Memory the sandbox's machine holds, as its host measures it                                                    |
| `memoryPeakBytes`                                   | The most it held inside the bucket                                                                             |
| `diskUsedBytes`                                     | Bytes used on the root file system, as `df /` in the sandbox reports                                           |
| `diskReadBytesPerSecond`, `diskWriteBytesPerSecond` | Bytes read from and written to the sandbox's disks, per second                                                 |
| `diskReadOpsPerSecond`, `diskWriteOpsPerSecond`     | Read and write operations completed, per second                                                                |
| `networkReceivedBytesPerSecond`                     | Bytes received over the sandbox's connections, per second                                                      |
| `networkSentBytesPerSecond`                         | Bytes sent over its connections and served through its preview links, custom domains and TCP ports, per second |
| `latest`                                            | The newest reading while the sandbox runs; null when it is not running                                         |

The response also has `memoryLimitBytes` and `diskLimitBytes`, the sandbox's memory and disk sizes.

CPU is measured, not estimated. It is the machine's CPU time between two readings of its host. The bill uses the same readings. The host reads every running sandbox at least every half minute. A paused or stopped sandbox uses nothing, so it has no new readings. `latest` is null, and its earlier readings stay in `points`.

CPU wait and memory stalls use the differences between complete readings of the same run. Each is weighted by the time measured. A first reading, a missing counter or a counter reset returns null. It does not report no waiting. The same fields are in `points` and `latest`. Older servers can omit them.

Disk use and disk I/O are counted by the sandbox's own kernel. So they include reads served from the host's page cache, which the host cannot see. Network traffic is counted by the host's network proxy, in both directions. It covers every connection the sandbox opens and every request it serves. Rates are per second of the time the bucket's readings cover. A reading the sandbox did not answer in time returns null, not zero. So does a reading from before these fields existed.

`range` picks the window, and the bucket that each point sums:

| Range | Bucket     | Kept for |
| ----- | ---------- | -------- |
| `15m` | 10 seconds | 24 hours |
| `1h`  | 20 seconds | 24 hours |
| `6h`  | 2 minutes  | 24 hours |
| `24h` | 8 minutes  | 24 hours |
| `7d`  | 1 hour     | 30 days  |
| `30d` | 1 hour     | 30 days  |

Each reading is kept 24 hours. Hourly averages and peaks are kept 30 days.

In your account, [Sandboxes](https://withruntime.com/account/sandboxes) shows each sandbox's CPU and memory now. Home draws a trace of each running sandbox. A sandbox's own page charts CPU, with its events marked on the chart. Its Activity tab charts CPU, memory, CPU wait, memory stalls, disk used, disk reads and writes, and network in and out over any of the ranges above. The tab updates while the sandbox runs. It also lists the sandbox's commands and what happened to it. Once the sandbox has stopped, its page shows its whole life. That is CPU and memory from start to stop, and a timeline of its events and commands. CPU wait is time ready to run while waiting for a processor. A memory stall is time with a thread waiting for memory. A first reading, a missing counter or a counter reset shows as not measured. It never shows as no waiting.

## Account API calls

[Usage & billing](https://withruntime.com/account/billing) shows the account's recorded authenticated calls. It shows the error rate and service errors, grouped by operation. The window is 24 hours, 7, 30 or 90 days. Refused calls are 4xx responses. Service errors are 5xx responses. The error rate includes both. Its total counts every recorded response, redirects included. A window with no counted calls has a null rate. A failed read remains unavailable.

`GET /v1/usage/requests?range=24h` returns the same counts. The other ranges are `7d`, `30d` and `90d`. Each window is a fixed number of hourly buckets. It ends with the current partial hour. `since` is inclusive. `until` is the read time. Counts are written about once a minute. Requests that never authenticated are excluded. A key needs the `usage` scope, or a read-only or all-products key. Every account member can read the account's counts on the website.

`calls`, `clientErrors` and `serverErrors` are exact integer decimal strings. `errorPercent` is a percentage rounded to two decimal places. It is null when there are no calls. `operations` has the same fields, and an `operation` name for each row. These are recorded API responses. They are separate from the [uptime promise](/legal/sla).

For billing detail over a chosen period, the same page exports settled usage as a CSV file. [Export settled usage](./api#export-settled-usage) covers every resource visible to your key. The export keeps exact amounts and includes settled charges. Pending holds stay separate.

## Commands

Each command run in a sandbox is kept for 14 days. This covers runs through the API, an SDK, the CLI or MCP. Runtime keeps the program's name, its exit code and how long it ran. For example: `pytest · exit 1 · 28 s`. A command still running shows as running. A process started in the background gets its exit when a read or a list of its processes sees it end. If its sandbox is stopped or deleted while it runs, it shows `ended by the sandbox's stop` (or `delete`). That is not a failure. A command whose answer was lost on the way back shows `its answer was lost`. Its connection may have been cut, or the sandbox may have stopped or paused under it. The command may or may not have run to the end. So check its effects before you run it again. A command that timed out is kept with the time limit it ran under. The name is the program alone. For example, `python3` for `FOO=1 python3 train.py --key …`, and `pytest` for `bash -c "pytest -q"`. Arguments and environment values are never stored ([security](./security#keys-and-secrets)). A terminal is kept as its shell (`bash`). What is typed in it is never kept. A code interpreter cell, including E2B's `runCode`, is kept as its language and `-cell`. For example, `python-cell · exit 1 · 2 s` for a cell that raised an error. Its code is never kept.

Code written for E2B's `getMetrics()` gets CPU and memory from these readings through `withruntime/e2b`. Its `diskUsed` is null.

## Events

Every lifecycle change of a sandbox, snapshot or volume is an event. Events are kept for 14 days. Every change to your egress secrets and your upstream proxy is an event too, kept the same way.

| Type                         | When                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sandbox.created`            | A sandbox is made; it is starting                                                                            |
| `sandbox.running`            | It is ready and running                                                                                      |
| `sandbox.paused`             | It paused, keeping its memory and files                                                                      |
| `sandbox.woken`              | A paused sandbox is running again                                                                            |
| `sandbox.stopped`            | It stopped. `stopReason` says why                                                                            |
| `sandbox.start_failed`       | It stopped before it ran; `sandbox.stopped` follows                                                          |
| `sandbox.wake_failed`        | A wake did not complete; the sandbox is paused or stopped                                                    |
| `sandbox.host_unreachable`   | Its server has not responded for 35 s, so what runs there is frozen; `host.unreachableSince` says since when |
| `sandbox.host_reachable`     | Its server responds again. The sandbox runs on as it was                                                     |
| `sandbox.unreachable`        | It is running but does not respond; `unreachable.reason` says why and `unreachable.since` since when         |
| `sandbox.reachable`          | It responds again; `unreachable.since` and `unreachable.reachableAt` say from when to when                   |
| `sandbox.recovered`          | Its server was lost and it is back; `recovery` says from when                                                |
| `sandbox.recovery_failed`    | Its server was lost and it cannot come back; `recovery.reason` says why                                      |
| `sandbox.files.changed`      | Files changed under a watch that sends to webhooks                                                           |
| `sandbox.out_of_memory`      | The sandbox ran out of memory and Linux ended a command's program; `outOfMemory` says how many and its size  |
| `sandbox.oom_kill`           | Linux's out-of-memory killer ended a process in the sandbox; `oomKill` names it, its PID and its memory      |
| `sandbox.secret_not_applied` | A request carried a secret's placeholder that was not replaced; `secretNotApplied` says which secret and why |
| `sandbox.network.limited`    | The sandbox met an outbound connection limit; `networkLimited` says which and its figure                     |
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
| `job.run.failed`             | A [job](./jobs#alerts)'s run ended failed, timed out or unknown, with no retry left                          |
| `job.recovered`              | A job's run succeeded after runs that failed                                                                 |
| `agent.call.held`            | An agent trigger held a call no session took; `call` says which, its key and why                             |

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

`job.run.failed` and `job.recovered` carry the job and the run. They never carry its output, because a run's output can hold the secrets in its environment. A run that will be retried sends none until its last attempt ends. `job.run.failed` is sent for every run that ends failing. `failingRuns` says how many in a row. A job's own [alert](./jobs#alerts) sends the same body to its own URL. It adds `logTail`, the run's last 20 lines of output (at most 2,000 bytes):

```json
{
  "type": "job.run.failed",
  "data": {
    "job": { "id": "5d1c…", "name": "nightly", "failingRuns": 3, "afterFailures": 3 },
    "run": {
      "id": "9a7e…",
      "attempt": 1,
      "trigger": "schedule",
      "state": "failed",
      "reason": "timeout",
      "exitCode": -9,
      "scheduledFor": "2026-10-18T09:00:00.000Z",
      "startedAt": "2026-10-18T09:00:04.210Z",
      "endedAt": "2026-10-18T09:30:04.215Z"
    },
    "logTail": ["fetching page 412", "still waiting on api.example.com"]
  }
}
```

`sandbox.out_of_memory` is sent once for each command that the out-of-memory killer ended. For a command run to its end, it is sent with the command's result. For a background process, it is sent when the process is first read, got or listed after it ended. A process that nobody reads after it ends sends none. The command is named by its program only, never by its arguments:

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

`sandbox.oom_kill` is sent once for each process that Linux's out-of-memory killer ended in the sandbox, within about a minute. It is sent whether or not the process belonged to a command: a service, a container or a background process counts too. `inCommand` says whether a command or process started through the API ran it. `memoryMiB` is the memory the process used when it was ended. Runtime's own agent is never ended this way, so the sandbox keeps answering:

```json
{
  "type": "sandbox.oom_kill",
  "data": {
    "sandbox": {
      "id": "7f3a2c10-58d4-4b9e-9c61-0a2b3c4d5e6f",
      "state": "running",
      "memoryMiB": 32768
    },
    "oomKill": {
      "process": { "name": "rustc", "pid": 4242, "user": "sandbox", "memoryMiB": 2048 },
      "inCommand": true,
      "at": "2026-10-27T22:39:12.000Z",
      "message": "The sandbox ran out of memory, and Linux's out-of-memory killer ended rustc (pid 4242, using 2048 MiB). Give the sandbox more memory (memoryMiB) or make the program use less."
    }
  }
}
```

`sandbox.unreachable` is sent when a running sandbox stops responding, within about 5 seconds. Its server checks Runtime's agent in each sandbox every 2 seconds. While it lasts, `GET /v1/sandboxes/{id}` returns the same `unreachable` object and `state` stays `running`. `sandbox.reachable` is sent when it responds again, with `since` and `reachableAt`. `reason` is one of:

| `reason`              | What happened                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `agent_not_answering` | Runtime's agent in the sandbox does not respond. Its processes may still run. Restart the sandbox if this lasts                  |
| `disk_stalled`        | Its server has not finished a write to the sandbox's disk for over 5 seconds. New commands return 503; running commands continue |
| `host_quarantined`    | Its server took it out of running after a fault. Its disk is kept. Restart the sandbox                                           |

```json
{
  "type": "sandbox.unreachable",
  "data": {
    "sandbox": {
      "id": "7f3a2c10-58d4-4b9e-9c61-0a2b3c4d5e6f",
      "state": "running",
      "memoryMiB": 32768
    },
    "unreachable": {
      "since": "2026-10-29T06:08:11.000Z",
      "reason": "disk_stalled",
      "message": "The sandbox's server has not finished a write to its disk for over 5 seconds, so new commands return 503. Commands already running continue."
    }
  }
}
```

`sandbox.secret_not_applied` is sent when a request from the sandbox carried an [egress secret](./security#secrets-sandboxes-never-see)'s placeholder. The placeholder went out as it was. So the server got the placeholder, not the key. It is sent once for each secret, reason and destination of a sandbox. It goes out with the host's next usage reading, within about a minute. The placeholder is never the secret, so nothing leaked. The event names the secret. It never names the placeholder or the value. `reason` is one of:

| `reason`                   | What happened                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `unencrypted`              | It went without TLS, over plain HTTP or another cleartext protocol. A secret goes only over HTTPS |
| `not_in_credential_header` | It went to the secret's host in the path or query (`place` is `target`) or in the `place` header  |
| `rule_not_matched`         | It went in a credential header, but none of the secret's `rules` allows that method and path      |
| `by_address`               | HTTPS went to an IP address, asking for one of the secret's hosts. Use the host name in the URL   |
| `withheld`                 | HTTPS went to the secret's host, but its server could not add the secret then. Runtime's fault    |

`withheld` is sent for a connection to the secret's host. It is sent whether or not the connection carried the placeholder. When the server has not heard from Runtime's API within the last minute, a request that carries the placeholder is not sent: it returns `503 Service Unavailable` with `X-Runtime-Egress: secret-not-current` and `Retry-After: 1`, and the connection closes. The next request on a new connection carries the value once the server hears from the API again. When the secret's value cannot be opened on the server, Runtime does not read inside the connection. Try again. If it repeats, write to support.

Runtime does not read inside HTTPS to a host that no secret names. So a placeholder sent there sends no event. Check the host against `npx withruntime secrets ls`.

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

`credit.low` and `credit.empty` are about the account. So they have no `resourceId`, and they carry `data.credit`. Each is sent once for each top-up. A new top-up starts the count again. `credit.low` is sent when the credit left lasts under 5 days at this month's pace. This is the same rule as the low-credit notice in the inbox and by email. `credit.empty` is sent when no credit is left. Amounts are strings of micro-dollars (1,000,000 to the dollar). `requiredMicros` is the pace over 5 days. It appears only in `credit.low`. `agentOnly` is `true` when the account was opened with a wallet and no person may pay for it. Its own agent adds credit itself, with its own key.

```json
{
  "type": "credit.low",
  "data": {
    "credit": { "availableMicros": "3200000", "requiredMicros": "4100000", "agentOnly": true }
  }
}
```

`sandbox.files.changed` comes only from a file watch started with `webhook: true` ([files in the API guide](./api#files)). Runtime reads the watch without waking the sandbox. It sends what changed since the last read. It sends at most once every {{file-hook-window}} for each watch. Each event holds up to {{file-hook-events}} changes. `more` counts the changes left out. `overflow` says changes were dropped, because of a flood or because the watch fell behind. For either, list the folder again. `ended` says the watch stopped. Its values are `timeout`, `stopped`, `root-removed`, and `gone` (when the sandbox restarted). While a sandbox that pauses itself does nothing, its watch is not read. So the watch never keeps it awake. A change arrives within seconds of the sandbox next doing work, or when it wakes.

`sandbox.network.limited` is sent when a sandbox meets one of its [outbound connection limits](./sandbox-environment#the-network). It is sent at most once an hour for each limit. It goes out with the host's next usage reading, within about a minute. `limit` is `connections`, `new-connections` or `destinations`. `connections` means open at the same time: a new one was refused. `new-connections` means a second. `destinations` means new hosts and ports a minute. For the last two, a connection waited its turn. `most` is the figure it was held to. `count` is how many times it was met, by the report. `at` is when it was first met that hour. `GET /v1/sandboxes/{id}/network` shows every limit in `limits`.

```json
{
  "type": "sandbox.network.limited",
  "data": {
    "sandbox": { "id": "7f3a2c10-58d4-4b9e-9c61-0a2b3c4d5e6f", "state": "running" },
    "networkLimited": {
      "limit": "connections",
      "most": 64,
      "count": 1,
      "at": "2026-10-15T18:00:00.000Z",
      "message": "The sandbox reached its limit of 64 open connections at once, so a new one was refused. Close or reuse connections it no longer needs. GET /v1/sandboxes/7f3a2c10-58d4-4b9e-9c61-0a2b3c4d5e6f/network shows its limits."
    }
  }
}
```

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

A webhook sends every event of the types you choose to an HTTPS URL. It sends each event as a POST of the event's JSON, for every sandbox in the account. The webhook belongs to the account, so every key sees the same webhooks. Making, changing or deleting a webhook, or reading its deliveries, needs a key made by an owner or admin. So do [OpenTelemetry exports](#opentelemetry-export). Another key gets 403 `forbidden`. An account can have 16 webhooks.

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

Owners and admins can do the same on the [Webhooks page](https://withruntime.com/account/webhooks). The page picks event types grouped by product. It shows each webhook's delivery log, with **Resend** on each finished delivery. It also offers a CSV download of every delivery kept.

### Check the signature

Every delivery carries a `Runtime-Signature` header:

```text
Runtime-Signature: t=1758650000,v1=5f2b…
```

`t` is when it was sent, in Unix seconds. `v1` is the hex HMAC-SHA256 of `{t}.{body}`, keyed with your secret. Check it before you trust a delivery. The SDKs do this for you. They refuse a signature older than five minutes, so a captured delivery cannot be replayed. Pass the raw body, before any JSON parsing.

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

Other headers: `Runtime-Webhook-Id` is the event's ID. It is the same on every retry, so you can skip an event you already handled. `Runtime-Event-Type`, `Runtime-Delivery-Id` and `Runtime-Delivery-Attempt` are there too.

### Answer, retries and the delivery log

Respond with any 2xx status code within 10 seconds. Anything else counts as a failure. So does a timeout or a redirect. A failure is retried after 1 minute, 5 minutes, 15 minutes, 1 hour, 3 hours, 6 hours, 12 hours, 24 hours and 24 hours again. That is ten attempts in about three days. Deliveries are not guaranteed to arrive in order. Order them by `createdAt`.

`runtime.webhooks.deliveries(id)` (or `npx withruntime webhooks deliveries <id>`) lists each delivery, with its attempts, your endpoint's status, and how long it took. `runtime.webhooks.retry(deliveryId)` sends one again. The webhook shows `failingSince` while its deliveries fail. Deliveries are kept for 14 days.

### Rotate the secret

`runtime.webhooks.rotateSecret(id)` makes a new secret and shows it once. The old secret keeps signing for a day, next to the new one. So every delivery carries two `v1` signatures until your service has the new secret. To choose a different period, pass `keepPreviousSeconds`, from 0 to a week. `verifyWebhook` accepts a list of secrets, for the same reason.

### Where webhooks can go

Webhook URLs must use HTTPS on the public internet. A URL that names a private, loopback or link-local address is refused when the webhook is made. Every delivery resolves the name again when it is sent. It refuses the delivery if any address is private. It connects only to the address it checked.

## OpenTelemetry export

An export pushes new events as OTLP log records. It pushes each sandbox's readings as OTLP metrics. This happens about every 30 seconds. If you ask for traces, it also pushes every API call as an OTLP span, within about a second. The target is any endpoint that takes OTLP over HTTP with JSON. The export starts from the moment you make it.

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

- `endpoint` is the OTLP/HTTP base URL, as in `OTEL_EXPORTER_OTLP_ENDPOINT`. Logs go to `<endpoint>/v1/logs`. Metrics go to `<endpoint>/v1/metrics`. Spans go to `<endpoint>/v1/traces`.
- `headers` authenticate you to the endpoint. You can set up to 10. They are stored where only the sender reads them, and they are never shown again.
- `signals` is `["logs", "metrics"]` by default. Add `"traces"` for API call spans. You can also send any one or two of the three.

The metrics have one resource per sandbox with `runtime.sandbox.id`, `runtime.sandbox.name`, `runtime.sandbox.vcpu` and `cloud.region`. The first six are gauges. The I/O metrics are delta sums: each point is the amount since the reading before it (`startTimeUnixNano`). They are split by the OpenTelemetry attributes `disk.io.direction` (`read`, `write`) and `network.io.direction` (`receive`, `transmit`):

| Metric                            | Unit          | Meaning                                        |
| --------------------------------- | ------------- | ---------------------------------------------- |
| `runtime.sandbox.cpu.utilization` | `1`           | CPU in use as a fraction of its vCPUs          |
| `runtime.sandbox.cpu.usage`       | `{cpu}`       | Cores in use                                   |
| `runtime.sandbox.memory.usage`    | `By`          | Memory its machine holds                       |
| `runtime.sandbox.memory.limit`    | `By`          | Its memory size                                |
| `runtime.sandbox.disk.usage`      | `By`          | Bytes used on its root file system             |
| `runtime.sandbox.disk.limit`      | `By`          | Its disk size                                  |
| `runtime.sandbox.disk.io`         | `By`          | Bytes read and written, by `disk.io.direction` |
| `runtime.sandbox.disk.operations` | `{operation}` | Reads and writes completed                     |
| `runtime.sandbox.network.io`      | `By`          | Bytes received and sent                        |

A reading the sandbox did not answer carries no disk or network points. The next measured one covers only its own interval.

Each log record's body is the event type. Its attributes are `event.name`, `event.id` and the resource's fields. Examples are `runtime.sandbox.state`, `runtime.sandbox.stop_reason` and `runtime.sandbox.label.<key>`. A failure (`start_failed`, `wake_failed`, `recovery_failed`, `failed`) is logged at WARN. The rest are logged at INFO.

A push that fails is retried. It waits 30 seconds, then doubles the wait, up to an hour. It sends from where it stopped. `runtime.otel.get(id)` shows `lastSuccessAt`, `lastError` and how much it has sent. `runtime.otel.flush(id)` pushes now. An account can have three exports.

### Traces

With `"traces"` in `signals`, every call your account makes to the API is a span. That includes creates, commands, file reads and writes, pauses, wakes and snapshots, whether they succeed or are refused.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.otel.create({
  endpoint: "https://api.honeycomb.io",
  headers: { "x-honeycomb-team": process.env.HONEYCOMB_KEY ?? "" },
  signals: ["logs", "metrics", "traces"],
});
```

Each span is a `SERVER` span named for the route, such as `POST /v1/sandboxes/{id}:exec`. It is timed from when the request arrived to when it was answered. It has the OpenTelemetry HTTP attributes `http.request.method`, `http.route`, `http.response.status_code`, `url.path`, `url.scheme` and `server.address`, and `error.type` for a 5xx response. It also has these:

| Attribute             | Meaning                                                |
| --------------------- | ------------------------------------------------------ |
| `runtime.operation`   | The operation, such as `sandboxes.exec`                |
| `runtime.request.id`  | The request's ID, as in the `x-request-id` header      |
| `runtime.error.code`  | The error code of a 4xx or 5xx response                |
| `runtime.resource.id` | The sandbox, snapshot or other resource the call names |
| `runtime.sandbox.id`  | The sandbox, for a call under `/v1/sandboxes/{id}`     |
| `runtime.client`      | The SDK or tool that made the call, with its version   |

A 5xx response sets the span's status to `ERROR`. A 4xx response is an error in your request, not in the server, so it leaves the status unset, as the HTTP conventions say.

**Your own trace.** A call that carries a W3C `traceparent` header is a child of that span. So Runtime's spans appear inside your own traces. The TypeScript and Python SDKs send the header for you when OpenTelemetry is set up in your process (`@opentelemetry/api`, or `opentelemetry-api` for Python) and a span is active. For example, a `Sandbox.create()` or `sbx.exec()` inside your own `startActiveSpan` shows as its child. No other setting is needed, and without an active span the SDKs send no header. A call that its caller did not sample (`traceparent` flags `00`) is not exported.

Spans are sent in batches as each call is answered, within about a second. If an endpoint refuses a batch, or does not answer within 2 seconds, that batch is lost, as with an OpenTelemetry SDK's exporter. That export's spans are then dropped for 5 seconds, doubling up to 5 minutes while its endpoint keeps failing, and sending resumes after the first success. Each export is separate: another export of the same account keeps receiving every span. Spans that cannot be held because the endpoint falls behind are also dropped and reported. `tracesLastError` says why, and `exportedSpans` counts what arrived. Spans have their own `tracesLastAttemptAt`, `tracesLastSuccessAt`, `tracesLastError` and `tracesFailures`. `lastSuccessAt`, `lastError` and `failures` describe logs and metrics only, so one signal's failure never hides behind another's success.

## What metrics and traces cost

Disk, disk I/O and network metrics, and a trace span of every API call,
measured for what they cost on 25 October 2026 at 7:20 p.m. US Mountain time, in a production Runtime
sandbox with 4 vCPU (AMD EPYC), Bun 1.4.0 and Python 3.12.3. Percentiles are
nearest-rank.

| What                                                     | p50     | p95     | p99      | Samples |
| -------------------------------------------------------- | ------- | ------- | -------- | ------- |
| The sandbox's CPU for one disk reading                   | 54 µs   | 60 µs   | 86 µs    | 5,000   |
| Recording one API call's span                            | 0.87 µs | 7.03 µs | 14.23 µs | 100,000 |
| Recording one span inside your own trace (`traceparent`) | 1.08 µs | 5.61 µs | 12.97 µs | 100,000 |
| An API call of an account that exports no traces         | 0.04 µs | 0.05 µs | 0.05 µs  | 100,000 |
| Encoding 512 spans as one OTLP/JSON body                 | 0.82 ms | 2.35 ms | 2.87 ms  | 300     |

- **Disk reading.** The host asks each running sandbox's kernel for its disk
  counters once a reading, every 30 seconds: 54 µs of the sandbox's CPU in 30
  seconds is under 0.0002% of one vCPU. A sandbox that does not answer in
  250 ms is not waited for; that reading has no disk figures. Network traffic
  is counted on the host and costs the sandbox nothing.
- **Spans.** A span is made in memory when the call is answered and sent
  within about a second, so it adds about a microsecond to the call and
  nothing to the database.
- **Reading the metrics.** A day of readings, one every 30 seconds, read as
  the `1h` range reads it took 3.19 ms at the median (3.43 ms p95) with disk
  and network, against 2.02 ms (6.04 ms p95) without; as the `24h` range reads
  it, 20.9 ms (30.3 ms p95) against 12.2 ms (18.8 ms p95). Measured on
  Postgres 18 in the same sandbox, 50 reads each.

The [recorded figures](/benchmarks/metrics-traces-2026-10-25.json) and the
[test that measures them](https://github.com/withruntime/runtime/blob/main/packages/cloud/tests/metrics-traces.speed.test.ts)
are published. These are observations, not a latency promise.

## MCP

`runtime_sandboxes_metrics` reads a sandbox's CPU, memory, CPU wait, memory stalls, disk and network. `runtime_events_list` reads its events. `runtime_webhooks_manage` and `runtime_otel_manage` list, create, test and change webhooks and exports.
