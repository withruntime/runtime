# Scheduled jobs

A job runs a command in a fresh sandbox, once at a time you choose or on a
cron schedule, and keeps each run's exit code and output. Use it for a nightly
report, a cleanup every hour, or one task that should start at 3 AM without a
machine of yours waiting to start it.

```bash no-run
runtime jobs create nightly-report --cron "0 3 * * *" --timezone Europe/Berlin \
  -- python3 /workspace/report.py          # prints the job id
runtime jobs create hello --at now -- bash -lc 'echo hello from a job'
runtime jobs ls                              # state, schedule, next run
runtime jobs logs "${job}" -f                # its latest run's output, followed
```

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const job = await runtime.jobs.create({
  name: "nightly-report",
  schedule: { cron: "0 3 * * *", timezone: "Europe/Berlin" },
  command: ["python3", "/workspace/report.py"],
});
for await (const run of await runtime.jobs.runs(job.id))
  console.log(run.id, run.state, run.exitCode);
```

```python check
from withruntime import Runtime

runtime = Runtime()
job = runtime.jobs.create("nightly-report", cron="0 3 * * *", timezone="Europe/Berlin",
                          command=["python3", "/workspace/report.py"])
for run in runtime.jobs.runs(job["id"]):
    print(run["id"], run["state"], run["exitCode"])
```

Agents use the `runtime_jobs` MCP tool, with `action` `create`, `list`,
`get`, `runs`, `run`, `logs`, `pause`, `resume`, `trigger`, `reschedule`,
`update` or `cancel`.

Every job is also on the [Jobs page](https://withruntime.com/account/jobs) of
your account: its schedule, size, last and next run, each run's exit code,
length, cost and output, and buttons to run it now, change its schedule, pause,
resume or cancel it.

## What a run is

Every run starts a new sandbox, runs the command in it and stops it. Nothing
on the sandbox's own disk carries over from one run to the next, so a job that
keeps data between runs [attaches a volume](#keep-data-between-runs), or reads
and writes somewhere else that lasts, such as your own bucket or database.

- **The command runs as given, without a shell.** Pass an argv list. For pipes,
  `&&` or variables, run it through bash: `-- bash -lc 'cd /workspace && make'`.
  A command is at most {{job-command-size}}, and `cwd` must be under `/workspace`.
- **The size is a sandbox's.** 2 vCPU and 4 GiB with a 4 GiB disk unless you
  say otherwise, up to {{max-vcpu}} vCPUs and {{max-memory}}; an odd memory
  size in MiB is rounded up to the next even one. The disk is at
  least 3 GiB, the size of the system image, and at most {{max-disk}}.
- **A run may last up to {{job-max-run}}.** The timeout is
  {{job-timeout-default}} unless you set it, counted from when the command
  starts. At the timeout the run is stopped, and every process it started with
  it, and it ends `failed` with the reason `timeout`. A timeout as long as the
  run's paid time (`durationSeconds`) falls 15 seconds before that time ends,
  so the run's exit and output are kept and a retry you set still runs.
- **It can prove which sandbox it is.** The command's environment has
  `RUNTIME_ID_TOKEN_REQUEST_URL` and `RUNTIME_ID_TOKEN_REQUEST_TOKEN`, as in
  any sandbox, so `Sandbox.identityToken()` (`identity_token()` in Python) or
  curl gets an [identity token](./identity-tokens) for AWS, Google Cloud or
  your own API with no stored key. The token names the run's sandbox.
- **Output is kept.** A run keeps its last {{job-log-kept}} of standard output
  and standard error together; `logsTruncated` says when earlier output was
  dropped.
- **It starts from the standard image, or yours.** `--image` (`image` in the
  SDKs and API) takes an [image](./images) of your account, by id, name (its
  `latest` tag), `name:tag` or `name@version`, so a job's code and tools are
  in the image rather than packed into its command. The name is resolved to the
  image's id when the job is made, as an App deploy takes it: moving a tag later
  changes no job, and `runtime jobs update <id> --image <ref>` moves it on. The
  image must be ready, in the job's region and fit its disk; one that is not is
  refused when the job is made, never at its runs.

## Keep data between runs

A job attaches up to four existing [volumes](./storage#attaching-a-volume) to
every run's sandbox, each at a path, as a sandbox create does. Read-write, the
default, is one sandbox at a time, so each run in turn gets the volume and
reads what the run before it wrote. `snapshot` is a read-only copy of the
volume as the run starts, and any number of sandboxes and runs can hold one at
once.

```bash no-run
vol=$(runtime volumes create --size-mib 10240 --name state)   # the volume id
runtime jobs create count --cron "0 * * * *" --volume "${vol}":/data \
  -- bash -lc 'date >> /data/runs && wc -l < /data/runs'
```

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const volume = await runtime.volumes.create({ sizeMiB: 10_240, name: "state" });
await runtime.jobs.create({
  name: "count",
  schedule: { cron: "0 * * * *" },
  command: ["bash", "-lc", "date >> /data/runs && wc -l < /data/runs"],
  compute: { region: volume.region, volumes: [{ volumeId: volume.id, path: "/data" }] },
});
```

```python check
from withruntime import Runtime

runtime = Runtime()
volume = runtime.volumes.create(10_240, name="state")
runtime.jobs.create("count", cron="0 * * * *",
                    command=["bash", "-lc", "date >> /data/runs && wc -l < /data/runs"],
                    compute={"region": volume["region"],
                             "volumes": [{"volumeId": volume["id"], "path": "/data"}]})
```

- **A run starts on its volume's server,** in the volume's region: give the job
  that region (`compute.region`; the CLI takes it from the volume). A job in
  another region is refused when you create it.
- **What a run wrote is on the volume when the next run starts.** A run's
  sandbox writes its volumes out as it stops, even at its timeout, and,
  keeping no disk of its own, lets them go then. The next run waits the few
  seconds that takes.
- **A volume held read-write by another sandbox holds the job.** Any other
  sandbox, running, paused or stopped, keeps its volume until it is deleted
  ([a stop keeps the disk](./storage#what-is-kept-where)), so delete it to
  free the volume. The job waits with `blockedReason` `volume` and starts
  within 30 seconds of the volume coming free. A `snapshot` attachment is
  never held.
- **The key that makes the job** may attach the volume: it needs `write_file`
  on it for read-write, `read_file` for a snapshot, as a sandbox create does.
- **A job you already have takes volumes in place:**
  `runtime jobs update <id> --volume "${vol}":/data` (or `compute.volumes` in
  an update) replaces its whole list, and `--no-volumes` removes them. The
  next run attaches them; its history stays.
- **A volume is paid for as always,** by the GiB-hour while it exists, and is
  backed up every day ([backups](./storage#volume-backups)). Each run is paid
  for as any run.

A run never starts in an existing sandbox, running, paused or stopped: every
run is a fresh one. To keep a sandbox's whole disk, use a
[persistent sandbox](./javascript#keep-a-sandbox-running) and run the command in it yourself; to keep
data for a job, put it on a volume.

## Schedules

- **Once:** `--at` takes an ISO time with its offset, such as
  `2026-10-01T03:00:00Z`, or `now`. In the SDKs, `at` also takes a date or Unix
  milliseconds; a time already past runs at once.
- **Recurring:** `--cron` takes the five cron fields, minute, hour, day of
  month, month and day of week, each `*`, a number, a list, a range or a step
  (`*/15 * * * *` is every fifteen minutes). `--timezone` takes an IANA name
  such as `America/New_York`, and is UTC unless you set it, so a schedule
  follows daylight saving time where you are.
- **Missed times run once.** If runs were missed, for example while the
  service was down or while a run was still going, the job runs once for all of
  them and then keeps to its schedule.
- **One run at a time.** A job never has two runs going at once.

`runtime jobs pause <id>` stops new runs and `resume` starts them again; a run
already going finishes. `runtime jobs cancel <id>` ends the job for good and
stops a run in progress. A run that already finished keeps its result, and
cancelling a job twice changes nothing.

**Run it now.** `runtime jobs trigger <id>` (`jobs.trigger` in the SDKs) runs
the job once, now, in a fresh sandbox, and its schedule stays as it was. A
paused job runs once and stays paused. A job has one run at a time, so while a
run is starting or going this is refused with `run_in_progress`; a cancelled or
finished job is refused with `invalid_state`. The run is listed with its
others, `trigger` `manual`, and is paid for as any run.

**Change the schedule.** `runtime jobs reschedule <id> --cron "30 4 * * 1-5"
--timezone Europe/Berlin`, or `--at` for one run (`jobs.reschedule(id,
schedule)` in the SDKs), gives the job a new schedule and keeps its id and its
runs. The next run is the new schedule's next time. A run going finishes as it
started, and a paused job stays paused until you resume it. On the Jobs page,
Change schedule needs no cron: pick every hour, day, weekday, week or month, or
once, and a time zone, and the page says the schedule in words before you
confirm; Custom takes a cron.

**Change a job.** `runtime jobs update <id>` (`jobs.update(id, changes)` in
the SDKs, `PATCH /v1/jobs/{id}` in the API) changes a job in place: its
command (after `--`), image (`--image`, or `--standard-image` to go back),
size, secrets, alert, timeout, retries or cost cap. Its id, its runs and its
schedule stay; the schedule moves with `reschedule`, and the name does not
change. What you leave out stays as it is: `compute` and `retry` change only
the fields you give, and `secrets` replaces the whole list. A run already
bought or going finishes with the command it started with; the next run is
the new job. A cancelled or finished job is refused with `invalid_state`.

```bash no-run
runtime jobs update "${job}" --image hub:latest --timeout 600 -- bash -lc 'bun run loop.ts'
```

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.jobs.update("job-id", { image: "hub@8", compute: { memoryMiB: 2048 } });
```

```python check
from withruntime import Runtime

runtime = Runtime()
runtime.jobs.update("job-id", image="hub@8", compute={"memoryMiB": 2048})
```

## Failures and retries

A run that exits with a code other than 0 has failed. By default a job tries
once. `--attempts 3 --backoff 60` (in the SDKs, `retry: { maxAttempts,
backoffSeconds }`) tries a failed run again in a fresh sandbox, up to
{{job-max-attempts}} attempts per occurrence, waiting up to
{{job-backoff-max}} between them.

A run whose outcome Runtime could not see, because its sandbox stopped under
it, ends in state `unknown`. Runtime never runs that occurrence again, even
with retries set, because the command may have done its work; check what it
did before you run it by hand. The schedule carries on: the next occurrence
runs as usual.

If a run cannot start, the job's `blockedReason` says why and it tries again
every {{job-blocked-retry}}: `credits` (the account has no credit: scheduled jobs run only on an account
that holds credit, so add credit), `cost_cap` (a limit you
set, or the key's daily limit, was reached), `capacity` (no room right now),
`volume` (a volume it attaches was deleted, is not ready, or is attached
read-write to another sandbox) or `permission` (the key that made the job was
revoked or narrowed, or may not use a volume it attaches).

## Alerts

A job can tell you when its runs fail, so nothing has to poll its runs. Once
`afterFailures` runs in a row (1 unless you say) end `failed`, timed out or
`unknown`, one alert goes out; while they keep failing, no more; once a run
succeeds again, one more says it recovered. A run that will be retried counts
when its last attempt ends, and a run you cancel does not count.

```bash no-run
printf %s "$HOOK_SECRET" | runtime secrets set HOOK_SECRET --jobs
runtime jobs create loop --cron "*/5 * * * *" --image hub:latest \
  --alert-webhook https://example.com/runtime-alerts --alert-secret HOOK_SECRET --alert-after 3 \
  -- bash -lc 'bun run loop.ts'
runtime jobs update "${job}" --alert-email     # mail me instead
runtime jobs update "${job}" --no-alert        # tell no one
```

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const hook = await runtime.secrets.set("HOOK_SECRET", { value: "…", jobs: true });
await runtime.jobs.create({
  name: "loop",
  schedule: { cron: "*/5 * * * *" },
  command: ["bash", "-lc", "bun run loop.ts"],
  alert: {
    afterFailures: 3,
    webhook: { url: "https://example.com/runtime-alerts", secretId: hook.jobs.id },
  },
});
```

- **A webhook** (`alert.webhook`: `url`, an https address on the public
  internet named by a host name or an IPv4 address, and `secretId`, a secret
  stored with `--jobs`) gets a POST with the same body an [account webhook](./observability#webhooks)
  gets for the same run: `type` `job.run.failed` or `job.recovered`, and
  `data.job`, `data.run` (its state, `reason` such as `timeout`, exit code and
  times) and `data.logTail`, the run's last 20 lines of output. With a
  `secretId` it is signed with that secret's value as account webhooks are
  signed with theirs, in `Runtime-Signature`, so `verifyWebhook(body, header,
value)` checks it; without one it is sent unsigned. `Runtime-Webhook-Id` is
  the alert's id, the same on every attempt. A send that does not get a 2xx is
  tried again for about three days, as webhooks are. The key that sets the
  alert, and the job's key, must be allowed to reveal the secret as well as
  use it (`secrets_reveal`). A run's output is the job's to choose, so a key
  that may only use a secret in a run, where its sandbox sees a stand-in,
  never gets that output signed with its real value. A secret deleted, or one
  the job's key may no longer use and reveal, stops the alert rather than
  sending it unsigned.
- **An email** (`alert.email: true`) goes to the job's person: who made it, or
  the person whose key made it, only while they are an active member of the
  account. It names the job, the run, its reason and exit code, and links to
  the run; it never carries the run's output, which the job's page shows to
  whoever may read it. Once they are removed or suspended, the job's alerts are no longer
  mailed to them.
- **Your account's webhooks** hear every run that ends failing as
  `job.run.failed` and each recovery as `job.recovered`, whether the job has an
  alert or not ([events](./observability#events)), without the run's output.

Only the job's own key, or another key of the same agent, changes a job, and a
new command, image, size or secret list then runs with the key that wrote it:
that key must be allowed every secret the job binds, an alert's `secretId`,
and the job's image. A rule that stops the key's agent from starting
sandboxes from an image also stops a job from being set to it, and each run
of a job that already uses it.

A job shows `failingRuns`, the runs in a row that ended failing,
`alertingSince`, and `lastAlert`, its last alert and how its delivery went.

## What it costs

A run is paid for as any sandbox is, for exactly the time it runs, with
nothing for the job itself. The [free usage](./included-usage) comes first, then
credit, with nothing to choose:

- **Without credit,** no run starts. A job waits until the account holds
  credit; adding it lets the job run.
- **Once the account holds credit,** a run spends the free usage while it lasts and then credit, at the sandbox rates: {{cpu-rate}} per active
  vCPU-hour and {{memory-rate}} per reserved GiB-hour. A paid run holds its
  cost for its time limit before it starts, and is charged only what it used,
  through the same [spending limits](./security) as every sandbox.

A job on an account with no credit waits with `blockedReason` `credits`, and
starts by itself once the account holds credit.

Two limits bound what a job spends: `--max-cost` for one run and
`--max-total-cost` for every run of the job together (`compute.maxCostMicros`
and `maxTotalCostMicros` in the SDKs and API). An account holds up to
{{paid-jobs}} jobs, active or paused; a finished or cancelled job does not
count. [Ask](./feedback-and-support) for more.

## Secrets in a job

A job puts secrets into its run's environment. Store the value once with
`--jobs`, then bind it by name when you create the job:

```bash no-run
printf %s "$DB_PASSWORD" | runtime secrets set DB_PASSWORD --jobs
runtime jobs create backup --cron "0 2 * * *" --secret DB_PASSWORD=PGPASSWORD \
  -- bash -lc 'pg_dump "$DATABASE_URL" | gzip > /workspace/backup.sql.gz'
```

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const saved = await runtime.secrets.set("DB_PASSWORD", { value: "…", jobs: true });
await runtime.jobs.create({
  name: "backup",
  schedule: { cron: "0 2 * * *" },
  command: ["bash", "-lc", 'pg_dump "$DATABASE_URL" > /workspace/backup.sql'],
  secrets: [{ name: "PGPASSWORD", secretId: saved.jobs.id }],
});
```

The name in the run's environment is the secret's own unless you give another
after `=`. Names starting `RUNTIME_`, `LD_` or `PYTHON`, and `PATH` and `HOME`,
are reserved, and a job binding one is refused with `env_name_reserved`: bind
the secret to another name, as `PGPASSWORD` above.

One `runtime secrets` holds both kinds of use. A secret can go to sandboxes,
to jobs, or both (`--host` and `--jobs` together), and the two copies behave
differently:

|                    | For sandboxes (`--host`)                                | For jobs (`--jobs`)                                                     |
| ------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| What the code sees | A placeholder; the egress proxy adds the value on HTTPS | The value itself, in the variable you name                              |
| Size               | Up to {{egress-secret-size}} of plain text              | Up to {{job-secret-size}}                                               |
| How many           | Up to {{sandbox-secrets}} per account                   | Up to {{paid-secrets}} per account                                      |
| Read it back       | Never, by anyone                                        | `runtime secrets reveal NAME`, with a key allowed to reveal             |
| Change it          | `set` again                                             | `runtime secrets rotate NAME`: a new version, the old one stops at once |
| Belongs to         | The account                                             | The person whose key stored it                                          |
| Delete             | `runtime secrets rm NAME` deletes both copies           | The same; the name cannot be used again                                 |

A job takes up to {{job-secrets-max}} secrets. A run gets the value only while
it is going, and a secret rotated or deleted after a run started is refused to
that run. The value is in the run's environment, so a command that prints it
puts it in the job's logs.

A jobs secret stored by an API key is that key's: other keys of yours cannot
list, read, rotate, delete or bind it until you share it. Share it with
`runtime secrets share NAME --agent <id>` (once per agent; an agent's id is the
`principalId` that `runtime me` prints for its key), or with `--all` for every
key of yours, or `--none` for only the key that stored it. You, signed in, can
always use it. A secret stored on the website is every key's, as before. A job
created with a secret its key may not use is refused with `secret_not_shared`.
A job that binds a secret another key stored stops at its next run, whenever
the job was made, until that key or you share the secret with the job's key.
If another of your keys could reach a secret before now, rotate it.

## Commands

| CLI                                 | SDK                          | What it does                                  |
| ----------------------------------- | ---------------------------- | --------------------------------------------- |
| `runtime jobs create <name> ... --` | `jobs.create`                | Schedule a job; prints its id                 |
| `runtime jobs ls`                   | `jobs.list`                  | Your jobs, oldest first                       |
| `runtime jobs get <id>`             | `jobs.get`                   | One job, in full                              |
| `runtime jobs runs <id> [--all]`    | `jobs.runs(id, {order})`     | Its newest 100 runs; `--all`: every one       |
| `runtime jobs logs <id> [-f]`       | `jobs.logs(runId, {cursor})` | A run's output; a job id means its latest run |
| `runtime jobs pause`, `resume <id>` | `jobs.pause`, `jobs.resume`  | Stop or restart scheduling                    |
| `runtime jobs trigger <id>`         | `jobs.trigger`               | Run it now, once                              |
| `runtime jobs reschedule <id> ...`  | `jobs.reschedule`            | Give it a new schedule                        |
| `runtime jobs update <id> ...`      | `jobs.update`                | Change what it runs, or its alert, in place   |
| `runtime jobs cancel <id>`          | `jobs.cancel`                | End it and stop a run in progress             |

The HTTP routes are `POST /v1/jobs`, `GET /v1/jobs`, `GET /v1/jobs/{id}`,
`GET /v1/jobs/{id}/runs` (oldest first; `?order=newest` for newest first), `POST /v1/jobs/{id}:pause`, `:resume`, `:trigger`,
`:reschedule` (body `{"schedule": ...}`), `:cancel`, `PATCH /v1/jobs/{id}`
(also `POST /v1/jobs/{id}:update`; a body of the fields that change),
`GET /v1/job-runs/{id}` and `GET /v1/job-runs/{id}/logs`. Every write takes an
`Idempotency-Key`; the SDKs and the CLI send one for you, so a retry after a
lost reply never makes a second job.
