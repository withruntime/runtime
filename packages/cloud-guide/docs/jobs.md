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
`get`, `runs`, `run`, `logs`, `pause`, `resume`, `trigger`, `reschedule` or
`cancel`.

Every job is also on the [Jobs page](https://withruntime.com/account/jobs) of
your account: its schedule, size, last and next run, each run's exit code,
length, cost and output, and buttons to run it now, change its schedule, pause,
resume or cancel it.

## What a run is

Every run starts a new sandbox, runs the command in it and stops it. Nothing
carries over from one run to the next, so a job that needs data reads it from
somewhere that lasts, such as your own bucket or database, and writes its
results back there.

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
set, or the key's daily limit, was reached), `capacity` (no room right now) or
`permission` (the key that made the job was revoked or narrowed).

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

## Commands

| CLI                                 | SDK                          | What it does                                  |
| ----------------------------------- | ---------------------------- | --------------------------------------------- |
| `runtime jobs create <name> ... --` | `jobs.create`                | Schedule a job; prints its id                 |
| `runtime jobs ls`                   | `jobs.list`                  | Your jobs, oldest first                       |
| `runtime jobs get <id>`             | `jobs.get`                   | One job, in full                              |
| `runtime jobs runs <id>`            | `jobs.runs`                  | Its runs: attempt, state, exit code           |
| `runtime jobs logs <id> [-f]`       | `jobs.logs(runId, {cursor})` | A run's output; a job id means its latest run |
| `runtime jobs pause`, `resume <id>` | `jobs.pause`, `jobs.resume`  | Stop or restart scheduling                    |
| `runtime jobs trigger <id>`         | `jobs.trigger`               | Run it now, once                              |
| `runtime jobs reschedule <id> ...`  | `jobs.reschedule`            | Give it a new schedule                        |
| `runtime jobs cancel <id>`          | `jobs.cancel`                | End it and stop a run in progress             |

The HTTP routes are `POST /v1/jobs`, `GET /v1/jobs`, `GET /v1/jobs/{id}`,
`GET /v1/jobs/{id}/runs`, `POST /v1/jobs/{id}:pause`, `:resume`, `:trigger`,
`:reschedule` (body `{"schedule": ...}`) and `:cancel`,
`GET /v1/job-runs/{id}` and `GET /v1/job-runs/{id}/logs`. Every write takes an
`Idempotency-Key`; the SDKs and the CLI send one for you, so a retry after a
lost reply never makes a second job.
