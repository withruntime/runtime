# JobRun API reference

One run of a job: a machine made at one of its times, deleted when its command ends. Its record (exit code, times, the last 256 KiB of its output) stays readable for 7 days after.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `starting`, `running`, `paused`, `deleted`, `error`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/job-runs` | [List jobRuns](#list-jobruns) |
| `GET` | `/v2/job-runs/{id}` | [Get a jobrun](#get-a-jobrun) |
| `GET` | `/v2/job-runs/{id}/output` | [output](#output) |

## List jobRuns

`GET /v2/job-runs`

Lists a job's runs, oldest first unless `order` is `newest`, deleted ones included while their records are kept.

Its action, for a key's grant: `jobRuns:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `job` | string | Yes | Its job, by ID. |
| `order` | one of `oldest`, `newest` | No | `newest` first, or `oldest` first. Default: "oldest". |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [JobRun](#jobrun), and `next`, where the next page starts, none on the last.

In v1: `GET /v1/jobs/{id}/runs`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/job-runs?job=example" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.jobRuns.list({ job: "example" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.job_runs.list(job="example")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.job_runs.list(job: "example")
```

```bash title="CLI"
runtime jobRuns list --job example
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_job_runs_list", "arguments": { "job": "example" } } }
```

## Get a jobrun

`GET /v2/job-runs/{id}`

Returns a run.

Its action, for a key's grant: `jobRuns:get`.

Path: `id`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `wait` | number | No | Seconds to wait, at most 60, for its state to differ from `ifState`; it answers once it does, or as it is when the wait ends. At least 0. At most 60. |
| `ifState` | string | No | The state the caller last read, which `wait` waits for it to leave. |

Returns a [JobRun](#jobrun).

In v1: `GET /v1/job-runs/{id}`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/job-runs/JOBRUN_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.jobRuns.get("JOBRUN_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.job_runs.get("JOBRUN_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.job_runs.get("JOBRUN_ID")
```

```bash title="CLI"
runtime jobRuns get JOBRUN_ID
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_job_runs_get", "arguments": { "id": "JOBRUN_ID" } } }
```

## `output`

`GET /v2/job-runs/{id}/output`

Returns a run's output after a cursor, stdout and stderr together in the order written, and the cursor to read on from. Its last 256 KiB are kept; truncated says when the cursor fell before them.

Its action, for a key's grant: `jobRuns:read`.

Path: `id`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | integer | No | Output after this byte. At least 0. Default: 0. |
| `maxBytes` | integer | No | At most this many bytes. At least 1. At most 262144. Default: 65536. |

Returns a [JobRunOutput](#jobrunoutput).

In v1: `GET /v1/job-runs/{id}/logs`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/job-runs/JOBRUN_ID/output" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.jobRuns.output("JOBRUN_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.job_runs.output("JOBRUN_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.job_runs.output("JOBRUN_ID")
```

```bash title="CLI"
runtime jobRuns output JOBRUN_ID
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_job_runs_output", "arguments": { "id": "JOBRUN_ID" } } }
```

## Objects

### JobRun

One run of a job: a machine made at one of its times, deleted when its command ended.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `job.run` | Yes | Always `job.run`. |
| `job` | string | Yes | Its job's ID. |
| `state` | one of `starting`, `running`, `paused`, `deleted`, `error` | Yes | Its machine's state: `starting` and `running` while it runs, `deleted` once it ended, `error` when it failed to start. |
| `at` | string (RFC 3339) | Yes | The time it is for: its schedule's, or when it was asked for. |
| `attempt` | integer | Yes | Its attempt at that time, from 1. |
| `manual` | boolean | Yes | Someone asked for it (`run`), rather than its schedule. |
| `createdAt` | string (RFC 3339) | Yes | When it was made. |
| `endedAt` | string (RFC 3339) | No | When its command ended. |
| `exitCode` | integer | No | Its command's exit code, once it ended; none for one a signal or its timeout ended, or one deleted before its end. |
| `succeeded` | boolean | Yes | It ended with exit code 0. |
| `outputBytes` | integer | No | How many bytes its command wrote, stdout and stderr together. |

### OutputChunk

Some of a process's output.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `offset` | integer | Yes | Where it starts in the process's output. |
| `stream` | one of `stdout`, `stderr` | Yes | The stream it was written to. |
| `text` | string | Yes | It, as text. |
| `base64` | string (base64) | No | It, as bytes, when the process answers base64. |

### JobRunOutput

A run's output, stdout and stderr together in the order written, after a cursor: its last 256 KiB are kept.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `chunks` | list of [OutputChunk](#outputchunk) | Yes | The output, in the order it was written. |
| `nextCursor` | integer | Yes | The cursor to read on from. |
| `truncated` | boolean | Yes | Output before what is kept was dropped, past the cursor. |
| `complete` | boolean | Yes | The run ended and nothing is left past the next cursor. |
