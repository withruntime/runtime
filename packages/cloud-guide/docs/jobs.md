# Scheduled jobs

A job runs a command in a fresh sandbox, once at a time you choose or on a
cron schedule, and keeps each run's exit code and output. Use it for a nightly
report, a cleanup every hour, or one task that should start at 03:00 without a
machine of yours waiting to start it.

```bash no-run
runtime job create nightly-report --cron "0 3 * * *" --timezone Europe/Berlin \
  -- python3 /workspace/report.py          # prints the job id
runtime job create hello --at now -- bash -lc 'echo hello from a job'
runtime job ls                              # state, schedule, next run
runtime job logs "${job}" -f                # its latest run's output, followed
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

Agents use the `runtime_job` MCP tool, with `action` `create`, `list`,
`get`, `runs`, `run`, `logs`, `pause`, `resume` or `cancel`.

## What a run is

Every run starts a new sandbox, runs the command in it and stops it. Nothing
carries over from one run to the next, so a job that needs data reads it from
somewhere that lasts, such as your own bucket or database, and writes its
results back there.

- **The command runs as given, without a shell.** Pass an argv list. For pipes,
  `&&` or variables, run it through bash: `-- bash -lc 'cd /workspace && make'`.
  A command is at most {{job-command-size}}, and `cwd` must be under `/workspace`.
- **The size is a sandbox's.** 2 vCPU and 4 GiB with a 4 GiB disk unless you
  say otherwise, up to {{max-vcpu}} vCPUs and {{max-memory}}. The disk is at
  least 3 GiB, the size of the system image, and at most {{max-disk}}.
- **A run may last up to {{job-max-run}}.** The timeout is
  {{job-timeout-default}} unless you set it, counted from when the command
  starts. At the timeout the run is stopped, and every process it started with
  it, and it ends `failed` with the reason `timeout`.
- **Output is kept.** A run keeps its last {{job-log-kept}} of standard output
  and standard error together; `logsTruncated` says when earlier output was
  dropped.

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

`runtime job pause <id>` stops new runs and `resume` starts them again; a run
already going finishes. `runtime job cancel <id>` ends the job for good and
stops a run in progress. A run that already finished keeps its result, and
cancelling a job twice changes nothing.

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
every {{job-blocked-retry}}: `credits` (the included usage cannot take the run and the
account has no credit: add credit), `cost_cap` (a limit you
set, or the key's daily limit, was reached), `capacity` (no room right now) or
`permission` (the key that made the job was revoked or narrowed).

## What it costs

A run is paid for as any sandbox is, for exactly the time it runs, with
nothing for the job itself. The [included usage](./included-usage) comes first, then
credit, with nothing to choose:

- **Without credit,** a run is a sandbox without credit. It spends the included usage while it fits the limits without credit: at most 2 vCPU and 4 GiB, and no more than
  {{trial-sandboxes}} sandboxes without credit running at once. Like every sandbox without credit, it reaches the internet on ports 80 and 443 only.
- **Once the account holds credit,** a run spends the included usage while it lasts and then credit, at the sandbox rates: {{cpu-rate}} per active
  vCPU-hour and {{memory-rate}} per reserved GiB-hour. A paid run holds its
  cost for its time limit before it starts, and is charged only what it used,
  through the same [spending limits](./security) as every sandbox.

A run the included usage cannot take, on an account with no credit, waits with
`blockedReason` `credits`: once the included usage is spent, or when the run is larger than the limits without credit or would be one sandbox too many. It starts by itself once there
is credit or room.

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
runtime job create backup --cron "0 2 * * *" --secret DB_PASSWORD=PGPASSWORD \
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

## Commands

| CLI                                | SDK                          | What it does                                  |
| ---------------------------------- | ---------------------------- | --------------------------------------------- |
| `runtime job create <name> ... --` | `jobs.create`                | Schedule a job; prints its id                 |
| `runtime job ls`                   | `jobs.list`                  | Your jobs, oldest first                       |
| `runtime job get <id>`             | `jobs.get`                   | One job, in full                              |
| `runtime job runs <id>`            | `jobs.runs`                  | Its runs: attempt, state, exit code           |
| `runtime job logs <id> [-f]`       | `jobs.logs(runId, {cursor})` | A run's output; a job id means its latest run |
| `runtime job pause`, `resume <id>` | `jobs.pause`, `jobs.resume`  | Stop or restart scheduling                    |
| `runtime job cancel <id>`          | `jobs.cancel`                | End it and stop a run in progress             |

The HTTP routes are `POST /v1/jobs`, `GET /v1/jobs`, `GET /v1/jobs/{id}`,
`GET /v1/jobs/{id}/runs`, `POST /v1/jobs/{id}:pause`, `:resume` and `:cancel`,
`GET /v1/job-runs/{id}` and `GET /v1/job-runs/{id}/logs`. Every write takes an
`Idempotency-Key`; the SDKs and the CLI send one for you, so a retry after a
lost reply never makes a second job.
