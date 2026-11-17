# Job API reference

A command run in a fresh machine, once or on a cron schedule in a timezone. Each run is a machine made at its time, deleted when its command ends, and billed as any machine is; its exit code and its last 256 KiB of output are kept. Runs of one job never overlap: a time that comes while one runs is made once it ends, and times missed make one run.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `scheduled`, `paused`, `finished`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v2/jobs` | [Create a job](#create-a-job) |
| `GET` | `/v2/jobs/{id}` | [Get a job](#get-a-job) |
| `GET` | `/v2/jobs` | [List jobs](#list-jobs) |
| `DELETE` | `/v2/jobs/{id}` | [Delete a job](#delete-a-job) |
| `POST` | `/v2/jobs/{id}:pause` | [pause](#pause) |
| `POST` | `/v2/jobs/{id}:resume` | [resume](#resume) |
| `POST` | `/v2/jobs/{id}:update` | [update](#update) |
| `POST` | `/v2/jobs/{id}:run` | [run](#run) |

## Create a job

`POST /v2/jobs`

Creates a job. Its first run is made at its schedule's first time. Asked again with the same Idempotency-Key, it returns the same job.

Its action, for a key's grant: `jobs:create`.

Body: a [JobCreate](#jobcreate).

Returns a [Job](#job).

In v1: `POST /v1/jobs`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/jobs" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.jobs.create();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.jobs.create()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.jobs.create
```

```bash title="CLI"
runtime jobs create
```

## Get a job

`GET /v2/jobs/{id}`

Returns a job.

Its action, for a key's grant: `jobs:get`.

Path: `id`.

Returns a [Job](#job).

In v1: `GET /v1/jobs/{id}`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/jobs/JOB_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.jobs.get("JOB_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.jobs.get("JOB_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.jobs.get("JOB_ID")
```

```bash title="CLI"
runtime jobs get JOB_ID
```

## List jobs

`GET /v2/jobs`

Lists the project's jobs, newest first.

Its action, for a key's grant: `jobs:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `label` | list of string | No | Only those with every label given (repeat it for several): key:value, or a key for any value. |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Job](#job), and `next`, where the next page starts, none on the last.

In v1: `GET /v1/jobs`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/jobs" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.jobs.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.jobs.list()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.jobs.list
```

```bash title="CLI"
runtime jobs list
```

## Delete a job

`DELETE /v2/jobs/{id}`

Deletes a job: no run is made from then on, and a run in flight is ended. Its runs' records stay readable for 7 days.

Its action, for a key's grant: `jobs:delete`.

Path: `id`.

Returns a [Job](#job).

In v1: `POST /v1/jobs/{id}:cancel`.

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/jobs/JOB_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.jobs.delete("JOB_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.jobs.delete("JOB_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.jobs.delete("JOB_ID")
```

```bash title="CLI"
runtime jobs delete JOB_ID
```

## `pause`

`POST /v2/jobs/{id}:pause`

Pauses a job: no run is made at its times until it is resumed. A run in flight runs to its end.

Its action, for a key's grant: `jobs:pause`.

Path: `id`.

Returns a [Job](#job).

In v1: `POST /v1/jobs/{id}:pause`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/jobs/JOB_ID:pause" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.jobs.pause("JOB_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.jobs.pause("JOB_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.jobs.pause("JOB_ID")
```

```bash title="CLI"
runtime jobs pause JOB_ID
```

## `resume`

`POST /v2/jobs/{id}:resume`

Resumes a paused job: its next run is made at its schedule's next time from now.

Its action, for a key's grant: `jobs:wake`.

Path: `id`.

Returns a [Job](#job).

In v1: `POST /v1/jobs/{id}:resume`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/jobs/JOB_ID:resume" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.jobs.resume("JOB_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.jobs.resume("JOB_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.jobs.resume("JOB_ID")
```

```bash title="CLI"
runtime jobs resume JOB_ID
```

## `update`

`POST /v2/jobs/{id}:update`

Changes a job's settings: each one named replaces its own, the rest are kept. Runs made from then on use them; one in flight runs as it was made. A new schedule's next run is at its next time from now.

Its action, for a key's grant: `jobs:update`.

Path: `id`.

Body: a [JobSettings](#jobsettings).

Returns a [Job](#job).

In v1: `POST /v1/jobs/{id}:update`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/jobs/JOB_ID:update" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.jobs.update("JOB_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.jobs.update("JOB_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.jobs.update("JOB_ID")
```

```bash title="CLI"
runtime jobs update JOB_ID
```

## `run`

`POST /v2/jobs/{id}:run`

Makes a run now, beside its schedule; a paused job stays paused. Refused 409 while a run of it is in flight. Asked again with the same Idempotency-Key, it makes nothing more.

Its action, for a key's grant: `jobs:exec`.

Path: `id`.

Returns a [Job](#job).

In v1: `POST /v1/jobs/{id}:trigger`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/jobs/JOB_ID:run" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.jobs.run("JOB_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.jobs.run("JOB_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.jobs.run("JOB_ID")
```

```bash title="CLI"
runtime jobs run JOB_ID
```

## Objects

### JobSchedule

When a job runs: once, at `at`; or at each time of its `cron` in its `timezone`. One of the two.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `at` | string (RFC 3339) | No | The one time it runs. |
| `cron` | string | No | A cron expression of five fields (minute, hour, day of month, month, day of week), as cron reads them, or `@hourly`, `@daily`, `@weekly`, `@monthly` or `@yearly`. |
| `timezone` | string | No | The IANA timezone its cron's times are in (`America/Denver`), daylight saving included; UTC when omitted. |

### SandboxRun

A command a sandbox runs once it starts: when it ends, the sandbox stops.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cmd` | string (run by `bash -lc`) or list of strings (the program and its arguments) | Yes | The command: text, run by `bash -lc`, or the program and its arguments as a list, run without a shell. |
| `cwd` | string | No | The directory it runs in; the user's home when omitted. |
| `env` | object of strings | No | Environment variables to add. |
| `timeoutSeconds` | number | No | Seconds it may run before it is stopped (`1.5` for 1,500 ms); no limit when omitted or 0. At least 0. |

### JobRetry

How a failed run is run again: a run that ends with an exit code other than 0, or at its timeout.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `maxAttempts` | integer | No | Attempts in all for one time, the first included; 1 (no retry) when omitted. At least 1. At most 10. Default: 1. |
| `backoffSeconds` | integer | No | Seconds from a failed attempt's end to the next. At least 0. At most 86400. Default: 30. |

### JobSecrets

Which of its org's secrets each run gets, and under which variables.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `only` | list of string | No | The secrets each run gets in their own variables, by name: only those of them whose scope admits it; [] none. At most 64 items. |
| `env` | object of strings | No | Variables each holding the value of one of the org's visible secrets whose scope admits the run, by the secret's name, `only` or not: `{"WEBSITE_TOKEN": "CRON_SECRET"}`. |

### VolumeMount

A volume a machine attaches at its create, mounted read-write in it, one machine at a time; detached when the machine is deleted.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `volume` | string | Yes | The volume, by name or ID, in the machine's project. |
| `path` | string | Yes | Where it is mounted, such as `/data`: an absolute path, not under `/proc`, `/sys`, `/dev`, `/etc`, `/usr`, `/bin`, `/sbin`, `/lib` or `/boot`. |

### JobSettings

A job's settings: what each of its runs is made with.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `schedule` | [JobSchedule](#jobschedule) | No | When it runs. |
| `run` | [SandboxRun](#sandboxrun) | No | The command each run runs; the run ends when it ends. |
| `retry` | [JobRetry](#jobretry) | No | How a failed run is run again; never when omitted. |
| `secrets` | [JobSecrets](#jobsecrets) | No | Which of its org's secrets each run gets; every one whose scope admits it when omitted. |
| `vcpu` | integer | No | Each run's vCPUs. At least 1. Default: 1. |
| `memoryGB` | number | No | Each run's memory in GB (1 GB is 1,024 MiB); a fraction is taken to the MiB (`0.5`). At least 1. Default: 1. |
| `diskGB` | number | No | Each run's disk in GB, to the MiB, over a fresh copy of its image. At least 1. Default: 4. |
| `image` | string | No | The image each run boots, by name (its newest version), `name:version` or ID; Runtime's default image when omitted. |
| `user` | one of `runtime`, `root` | No | Who its command runs as: `runtime` (uid 1000, with passwordless sudo) or `root`. Its image's when omitted, else `runtime`. |
| `volumes` | list of [VolumeMount](#volumemount) | No | Volumes each run attaches and mounts, at most one, in the job's project; a run waits while another machine holds it. |
| `maxCost` | string (US dollars, decimal) | No | The most one run may cost, in US dollars (`"0.50"`): a run pauses once it has cost that, as a machine at its maxCost does. |

### JobCreate

A job to create: its schedule and run are required.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `schedule` | [JobSchedule](#jobschedule) | No | When it runs. |
| `run` | [SandboxRun](#sandboxrun) | No | The command each run runs; the run ends when it ends. |
| `retry` | [JobRetry](#jobretry) | No | How a failed run is run again; never when omitted. |
| `secrets` | [JobSecrets](#jobsecrets) | No | Which of its org's secrets each run gets; every one whose scope admits it when omitted. |
| `vcpu` | integer | No | Each run's vCPUs. At least 1. Default: 1. |
| `memoryGB` | number | No | Each run's memory in GB (1 GB is 1,024 MiB); a fraction is taken to the MiB (`0.5`). At least 1. Default: 1. |
| `diskGB` | number | No | Each run's disk in GB, to the MiB, over a fresh copy of its image. At least 1. Default: 4. |
| `image` | string | No | The image each run boots, by name (its newest version), `name:version` or ID; Runtime's default image when omitted. |
| `user` | one of `runtime`, `root` | No | Who its command runs as: `runtime` (uid 1000, with passwordless sudo) or `root`. Its image's when omitted, else `runtime`. |
| `volumes` | list of [VolumeMount](#volumemount) | No | Volumes each run attaches and mounts, at most one, in the job's project; a run waits while another machine holds it. |
| `maxCost` | string (US dollars, decimal) | No | The most one run may cost, in US dollars (`"0.50"`): a run pauses once it has cost that, as a machine at its maxCost does. |
| `name` | string | No | Its name, unique in its project. |
| `labels` | labels (keys under `runtime.` are Runtime's) | No | Labels to find it by; each run carries them. |

### JobError

Why a time's run was not made and will not be tried again: the answer its create got. The job waits for its next time; a run made takes it off.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `at` | string (RFC 3339) | Yes | The time whose run was not made. |
| `status` | integer | Yes | The HTTP status its create was answered with. |
| `code` | string | Yes | The error's code, as any call's error names it. |
| `message` | string | Yes | What went wrong. |
| `requestId` | string | No | The create's request ID, for support. |

### Job

A job.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `schedule` | [JobSchedule](#jobschedule) | No | When it runs. |
| `run` | [SandboxRun](#sandboxrun) | No | The command each run runs; the run ends when it ends. |
| `retry` | [JobRetry](#jobretry) | No | How a failed run is run again; never when omitted. |
| `secrets` | [JobSecrets](#jobsecrets) | No | Which of its org's secrets each run gets; every one whose scope admits it when omitted. |
| `vcpu` | integer | No | Each run's vCPUs. At least 1. Default: 1. |
| `memoryGB` | number | No | Each run's memory in GB (1 GB is 1,024 MiB); a fraction is taken to the MiB (`0.5`). At least 1. Default: 1. |
| `diskGB` | number | No | Each run's disk in GB, to the MiB, over a fresh copy of its image. At least 1. Default: 4. |
| `image` | string | No | The image each run boots, by name (its newest version), `name:version` or ID; Runtime's default image when omitted. |
| `user` | one of `runtime`, `root` | No | Who its command runs as: `runtime` (uid 1000, with passwordless sudo) or `root`. Its image's when omitted, else `runtime`. |
| `volumes` | list of [VolumeMount](#volumemount) | No | Volumes each run attaches and mounts, at most one, in the job's project; a run waits while another machine holds it. |
| `maxCost` | string (US dollars, decimal) | No | The most one run may cost, in US dollars (`"0.50"`): a run pauses once it has cost that, as a machine at its maxCost does. |
| `id` | string | Yes | Its ID. |
| `object` | one of `job` | Yes | Always `job`. |
| `name` | string | No | Its name, unique in its project. |
| `state` | one of `scheduled`, `paused`, `finished`, `deleted` | Yes | Where it is: `scheduled` (its runs are made at their times), `paused` (none is), `finished` (its one time ran). |
| `labels` | labels (keys under `runtime.` are Runtime's) | Yes | Its labels. |
| `nextRunAt` | string (RFC 3339) | No | When its next run is made, or its next retry; none when paused or finished. |
| `lastError` | [JobError](#joberror) | No | Why its last time's run was not made, when it was refused: that time failed and it waits for its next; none once a run is made. |
| `createdAt` | string (RFC 3339) | No | When it was created. |
| `revision` | integer | No | Its revision, changed by every change to it. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |
