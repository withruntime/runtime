# Scheduled jobs

A job runs a command in a fresh sandbox. It runs once, at a time you choose, or on a cron schedule. It keeps each run's exit code and output. Use a job for a nightly report, an hourly cleanup, or one task that should start at 3 AM. You need no machine of your own waiting to start it.

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

Agents use the `runtime_jobs` MCP tool. Set `action` to `create`, `list`, `get`, `runs`, `run`, `logs`, `pause`, `resume`, `trigger`, `reschedule`, `update` or `cancel`.

Every job also appears on the [Jobs page](https://withruntime.com/account/jobs) of your account. The page shows the job's schedule, size, last and next run. It shows each run's exit code, length, cost and output. It has buttons to run the job now, change its schedule, pause it, resume it or cancel it.

## What a run is

Every run starts a new sandbox, runs the command in it, and stops the sandbox. Nothing on the sandbox's own disk carries over to the next run. So a job that keeps data between runs either [attaches a volume](#keep-data-between-runs), or reads and writes somewhere else that lasts, such as your own bucket or database.

- **The command runs as given, without a shell.** Pass an argv list. For pipes, `&&` or variables, run it through bash: `-- bash -lc 'cd /workspace && make'`. A command can be at most {{job-command-size}}. `cwd` must be under `/workspace`.
- **The size is the same as a sandbox's.** The default is 2 vCPU and 4 GiB of memory, with a 4 GiB disk, unless you set a different size. You can go up to {{max-vcpu}} vCPUs and {{max-memory}}. An odd memory size in MiB is rounded up to the next even one. The disk is at least 3 GiB, the size of the system image. It can be at most {{max-disk}}.
- **A run may last up to {{job-max-run}}.** The timeout is {{job-timeout-default}} unless you set it. It counts from when the command starts. At the timeout, the run is stopped, along with every process it started. The run ends `failed` with the reason `timeout`. A timeout as long as the run's paid time (`durationSeconds`) falls 15 seconds before that time ends. So the run's exit and output are kept, and a retry you set still runs.
- **It can prove which sandbox it is.** The command's environment has `RUNTIME_ID_TOKEN_REQUEST_URL` and `RUNTIME_ID_TOKEN_REQUEST_TOKEN`, as in any sandbox. So `Sandbox.identityToken()` (`identity_token()` in Python), or curl, gets an [identity token](./identity-tokens) for AWS, Google Cloud or your own API. No stored key is needed. The token names the run's sandbox.
- **Output is kept.** A run keeps its last {{job-log-kept}} of standard output and standard error, combined. `logsTruncated` is set when earlier output was dropped.
- **It starts from the standard image, or yours.** `--image` (`image` in the SDKs and API) takes an [image](./images) of your account. You can name it by id, by name (its `latest` tag), as `name:tag`, or as `name@version`. So a job's code and tools can sit in the image, not in its command. Like an App deploy, the name resolves to the image's id when the job is made. Moving a tag later changes no job. To move a job to a new version, run `runtime jobs update <id> --image <ref>`. The image must be ready, in the job's region, and fit its disk. An image that fails any of these is refused when the job is made, never at a run.

## Keep data between runs

A job attaches up to four existing [volumes](./storage#attaching-a-volume) to every run's sandbox. Each one attaches at a path, as a sandbox create does. Read-write is the default. It allows one sandbox at a time. So each run in turn gets the volume, and reads what the run before it wrote. `snapshot` is a read-only copy of the volume, taken as the run starts. Any number of sandboxes and runs can hold a snapshot at the same time.

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

- **A run starts on its volume's server,** in the volume's region. Give the job that region (`compute.region`; the CLI takes it from the volume). A job in another region is refused when you create it.
- **What a run wrote is on the volume when the next run starts.** A run's sandbox writes its volumes out as it stops, even at its timeout. It keeps no disk of its own, so it releases the volumes then. The next run waits the few seconds that takes.
- **A volume held read-write by another sandbox holds the job.** Any other sandbox keeps its volume until that sandbox is deleted. This includes a sandbox that is running, paused or stopped ([a stop keeps the disk](./storage#what-is-kept-where)). To free the volume, delete that sandbox. The job waits with `blockedReason` `volume`. It starts within 30 seconds of the volume coming free. A `snapshot` attachment is never held.
- **The key that makes the job** is allowed to attach the volume. It needs `write_file` on the volume for read-write, or `read_file` for a snapshot. A sandbox create needs the same.
- **Update a job to change its volumes:** `runtime jobs update <id> --volume "${vol}":/data` (or `compute.volumes` in an update) replaces its whole list. `--no-volumes` removes them. The next run attaches them. Its history stays.
- **A volume is paid for as always,** by the GiB-hour while it exists. It is backed up every day ([backups](./storage#volume-backups)). Each run is paid for as any run is.

A run never starts in an existing sandbox, whether running, paused or stopped. Every run is a fresh sandbox. To keep a sandbox's whole disk, use a [persistent sandbox](./javascript#keep-a-sandbox-running) and run the command in it yourself. To keep data for a job, put it on a volume.

## Schedules

- **Once:** `--at` takes an ISO time with its offset, such as `2026-10-01T03:00:00Z`, or `now`. In the SDKs, `at` also takes a date or Unix milliseconds. A time already past runs immediately.
- **Recurring:** `--cron` takes the five cron fields: minute, hour, day of month, month and day of week. Each field is `*`, a number, a list, a range or a step. `*/15 * * * *` runs every fifteen minutes. `--timezone` takes an IANA name, such as `America/New_York`. It is UTC unless you set it. Set a time zone so a schedule follows daylight saving time where you are.
- **Missed times run once.** If runs were missed, for example while the service was down or while a run was still going, the job runs once for all of them. Then it keeps to its schedule.
- **One run at a time.** A job never has two runs going at the same time.

`runtime jobs pause <id>` stops new runs. `resume` starts them again. A run already going finishes. `runtime jobs cancel <id>` ends the job for good and stops a run in progress. A run that has already finished keeps its result. Cancelling a job twice changes nothing.

**Run it now.** `runtime jobs trigger <id>` (`jobs.trigger` in the SDKs) runs the job once, now, in a fresh sandbox. Its schedule stays as it was. A paused job runs once and stays paused. A job has one run at a time. While a run is starting or going, a trigger is refused with `run_in_progress`. A cancelled or finished job is refused with `invalid_state`. The run is listed with its others, with `trigger` `manual`. It is paid for as any run is.

**Change the schedule.** `runtime jobs reschedule <id> --cron "30 4 * * 1-5" --timezone Europe/Berlin`, or `--at` for one run (`jobs.reschedule(id, schedule)` in the SDKs), gives the job a new schedule. It keeps the job's id and its runs. The next run is at the new schedule's next time. A run already going finishes as it started. A paused job stays paused until you resume it. On the Jobs page, Change schedule needs no cron. Pick every hour, day, weekday, week or month, or pick once. Then pick a time zone. The page describes the schedule in words before you confirm. Choose Custom to enter a cron.

**Change a job.** `runtime jobs update <id>` (`jobs.update(id, changes)` in the SDKs, `PATCH /v1/jobs/{id}` in the API) changes a job in place. You can change its command (after `--`), image (`--image`, or `--standard-image` to go back), size, secrets, alert, timeout, retries or cost cap. Its id, its runs and its schedule stay. Change the schedule with `reschedule`. The name does not change. Fields you leave out stay as they are. `compute` and `retry` change only the fields you give. `secrets` replaces the whole list. A run already bought or going finishes with the command it started with. The next run uses the new job. A cancelled or finished job is refused with `invalid_state`.

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

A run that exits with a code other than 0 has failed. By default, a job tries once. `--attempts 3 --backoff 60` (in the SDKs, `retry: { maxAttempts, backoffSeconds }`) retries a failed run in a fresh sandbox. It makes up to {{job-max-attempts}} attempts per occurrence. It waits up to {{job-backoff-max}} between them.

A run whose outcome Runtime could not see ends in state `unknown`. This happens when its sandbox stopped under it. Runtime never runs that occurrence again, even with retries set. The command may have done its work. Check what it did before you run it by hand. The schedule carries on. The next occurrence runs as usual.

If a run cannot start, the job's `blockedReason` says why. The job tries again every {{job-blocked-retry}}. The reasons are:

- `credits`: the account has no credit. Scheduled jobs run only on an account that holds credit, so add credit.
- `cost_cap`: a limit you set, or the key's daily limit, was reached.
- `capacity`: there is no room right now.
- `volume`: a volume it attaches was deleted, is not ready, or is attached read-write to another sandbox.
- `permission`: the key that made the job was revoked or narrowed, or the key may not use a volume it attaches.

## Alerts

A job can tell you when its runs fail. Then nothing has to poll its runs. Once `afterFailures` runs in a row end `failed`, timed out or `unknown`, one alert goes out. The default is 1, unless you set another number. While runs keep failing, no more alerts go out. Once a run succeeds again, one more alert says the job recovered. A run that will be retried counts when its last attempt ends. A run you cancel does not count.

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

- **A webhook** (`alert.webhook`) gets a POST. It takes `url` and `secretId`. The `url` is an https address on the public internet, named by a host name or an IPv4 address. The `secretId` is a secret stored with `--jobs`. The POST has the same body that an [account webhook](./observability#webhooks) gets for the same run. Its `type` is `job.run.failed` or `job.recovered`. It has `data.job`, and `data.run`, which holds the run's state, `reason` (such as `timeout`), exit code and times. It also has `data.logTail`, the run's last 20 lines of output. With a `secretId`, the POST is signed with that secret's value. Account webhooks are signed with their secrets the same way, in `Runtime-Signature`. So `verifyWebhook(body, header, value)` checks it. Without a `secretId`, the POST is sent unsigned. `Runtime-Webhook-Id` is the alert's id. It is the same on every attempt. A send that does not get a 2xx is tried again for about three days, as webhooks are. The key that sets the alert, and the job's key, must be allowed to reveal the secret as well as use it (`secrets_reveal`). A run's output is the job's to choose. So a key that can only use a secret in a run never gets that output signed with its real value. In a run, its sandbox sees a stand-in. If the secret is deleted, or the job's key may no longer use and reveal it, the alert stops. It is not sent unsigned.
- **An email** (`alert.email: true`) goes to the job's person. That is whoever made the job, or the person whose key made it. It goes only while they are an active member of the account. The email names the job, the run, its reason and exit code. It links to the run. It never carries the run's output. The job's page shows the output to anyone who may read it. Once that person is removed or suspended, the job's alerts are no longer mailed to them.
- **Your account's webhooks** receive every failing run as `job.run.failed`. They receive each recovery as `job.recovered`. This happens whether or not the job has an alert ([events](./observability#events)). The run's output is not included.

Only the job's own key, or another key of the same agent, can change a job. A new command, image, size or secret list then runs with the key that wrote it. That key must be allowed every secret the job binds, including an alert's `secretId`. It must also be allowed the job's image. A rule that stops the key's agent from starting sandboxes from an image also stops a job from being set to that image. It also stops each run of a job that already uses it.

A job shows `failingRuns`, the number of runs in a row that ended failing. It also shows `alertingSince` and `lastAlert`. `lastAlert` is its last alert and how its delivery went.

## What it costs

A run is paid for as any sandbox is. You pay for exactly the time it runs. The job itself costs nothing extra. The [free usage](./included-usage) applies first, then credit. You do not choose the order:

- **Without credit,** no run starts. A job waits until the account holds credit. Adding credit lets the job run.
- **Once the account holds credit,** a run uses the free usage while it lasts. Then it spends credit, at the sandbox rates: {{cpu-rate}} per active vCPU-hour and {{memory-rate}} per reserved GiB-hour. Before a paid run starts, it holds its cost for its time limit. It is charged only for what it used. The same [spending limits](./security) apply as for every sandbox.

A job on an account with no credit waits with `blockedReason` `credits`. It starts by itself once the account holds credit.

Two limits cap what a job spends. `--max-cost` caps one run. `--max-total-cost` caps every run of the job together. In the SDKs and API, they are `compute.maxCostMicros` and `maxTotalCostMicros`. An account holds up to {{paid-jobs}} jobs, active or paused. A finished or cancelled job does not count. [Ask](./feedback-and-support) for more.

## Secrets in a job

A job puts secrets into its run's environment. Store the value once with `--jobs`. Then bind it by name when you create the job:

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

The name in the run's environment is the secret's own name. Give another name after `=` to change it. Names that start with `RUNTIME_`, `LD_` or `PYTHON` are reserved. So are `PATH` and `HOME`. A job that binds a reserved name is refused with `env_name_reserved`. Bind the secret to another name instead, as `PGPASSWORD` does above.

One `runtime secrets` entry can hold both kinds of use. A secret can go to sandboxes, to jobs, or to both (`--host` and `--jobs` together). The two copies behave differently:

|                    | For sandboxes (`--host`)                                | For jobs (`--jobs`)                                                         |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| What the code sees | A placeholder; the egress proxy adds the value on HTTPS | The value itself, in the variable you name                                  |
| Size               | Up to {{egress-secret-size}} of plain text              | Up to {{job-secret-size}}                                                   |
| How many           | Up to {{sandbox-secrets}} per account                   | Up to {{paid-secrets}} per account                                          |
| Read it back       | Never, by anyone                                        | `runtime secrets reveal NAME`, with a key allowed to reveal                 |
| Change it          | `set` again                                             | `runtime secrets rotate NAME`: a new version, the old one stops immediately |
| Belongs to         | The account                                             | The person whose key stored it                                              |
| Delete             | `runtime secrets rm NAME` deletes both copies           | The same; the name cannot be used again                                     |

A job takes up to {{job-secrets-max}} secrets. A run gets the value only while it is going. A secret that is rotated or deleted after a run started is refused to that run. The value is in the run's environment. So a command that prints it puts it in the job's logs.

A jobs secret stored by an API key belongs to that key. Your other keys cannot list, read, rotate, delete or bind it until you share it. To share it, use `runtime secrets share NAME --agent <id>`. Share it once per agent. An agent's id is the `principalId` that `runtime me` prints for its key. Or use `--all` to share it with every key of yours. Or use `--none` to share it with only the key that stored it. You, signed in, can always use it. A secret stored on the website is every key's, as before. A job created with a secret its key may not use is refused with `secret_not_shared`. A job that binds a secret another key stored stops at its next run. This applies whenever the job was made. The job stays stopped until that key or you share the secret with the job's key. If another of your keys could reach a secret before now, rotate it.

## Move jobs from another platform

Jobs from Trigger.dev, Inngest, Modal, Google Cloud Run and AWS Batch move with one import or one command. They run unchanged. Each keeps its schedule, its size, its timeout and its retries. What cannot be carried over is listed with the reason. Nothing is silently dropped.

| From                                 | Change                                                                                                      | Then                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Trigger.dev `schedules.task`, `task` | `@trigger.dev/sdk` (or `/v3`) to `withruntime/trigger`                                                      | `npx withruntime jobs deploy`                       |
| Inngest functions                    | `inngest` (and `inngest/next` and the other serve adapters) to `withruntime/inngest`                        | `npx withruntime jobs deploy`                       |
| Modal scheduled Functions            | `import modal` to `from withruntime import modal`                                                           | `python -m withruntime.modal deploy app.py`         |
| Google Cloud Run jobs                | Nothing: export the job and its Cloud Scheduler job                                                         | `runtime jobs import job.yaml scheduler.yaml`       |
| AWS Batch                            | Nothing: export the job definition and its EventBridge schedule or rule, or use the CloudFormation template | `runtime jobs import definition.json schedule.json` |

The drop-ins need SDK 0.36.0 or later (Python 0.34.0).

### Trigger.dev and Inngest

`runtime jobs deploy` builds the project into one image. The project's own lockfile installs its dependencies, with npm, pnpm, Yarn or Bun. Bun runs the TypeScript as written. The command then lists the tasks the project's files declare and makes one job per task, named `<project>-<task id>`. Deploying again updates each job in place.

```ts check
import { logger, schedules, task } from "withruntime/trigger";

export const nightly = schedules.task({
  id: "nightly-report",
  cron: { pattern: "0 3 * * *", timezone: "Europe/Berlin" },
  machine: "small-2x",
  maxDuration: 600,
  retry: { maxAttempts: 3 },
  run: async (payload) => {
    logger.log("report", { for: payload.timestamp, last: payload.lastTimestamp });
  },
});

export const resize = task({
  id: "resize-image",
  run: async (payload: { url: string }) => ({ resized: payload.url }),
});
```

- **A scheduled task** is a job on its cron. Its payload has `timestamp` (the time the run was due), `lastTimestamp`, `timezone`, `scheduleId` and the next ten `upcoming` times, as on Trigger.dev.
- **A task run on demand** is a paused job. `tasks.trigger(id, payload)`, or the task's own `trigger(payload)`, runs it once, now, in a fresh sandbox, with that payload. The payload is at most 64 KiB as JSON. The caller needs `RUNTIME_API_KEY`. The task's job is found by the task's id. If two deployed projects have a task with that id, set `RUNTIME_JOBS_PROJECT` to the project's name where `trigger` is called.
- **Size and limits.** `machine` sets the size: `micro` and `small-1x` are 1 vCPU with 256 or 512 MiB, `small-2x` 1 vCPU and 1 GiB, `medium-1x` 1 vCPU and 2 GiB, `medium-2x` 2 vCPU and 4 GiB, `large-1x` 4 vCPU and 8 GiB, and `large-2x` 8 vCPU and 16 GiB. `maxDuration` is the run's timeout, at most {{job-max-run}}. `retry.maxAttempts` is the number of attempts, at most {{job-max-attempts}}. `trigger.config.ts`'s `maxDuration`, `machine` and `retries.default.maxAttempts` apply to every task that sets none.
- **Hooks** (`init`, `onStart`, `onSuccess`, `onFailure`, `onComplete`, `cleanup`) and `wait.for` and `wait.until` work. A wait counts toward the run's timeout.

An Inngest function with a `cron` trigger is a job on that schedule. A time zone written as `TZ=Europe/Paris 0 12 * * 5` is the job's time zone. A function with an `event` trigger is a paused job. `inngest.send(event)` runs every function of the app triggered by that event name once, now, with the event as its payload. The functions must be imported where `send` is called, as `serve()` imports them. Inside a run, `step.run` runs its code and returns its result. `step.sleep` and `step.sleepUntil` wait in the run. `step.sendEvent` sends events. A function's `retries` (4 by default, as on Inngest) become its attempts, at most {{job-max-attempts}}. `timeouts.finish` is the run's timeout. A `NonRetriableError` ends the run with no more attempts. `serve()` returns 410 Gone, because nothing calls the app's endpoint any more.

### Modal

```python check
from withruntime import modal

app = modal.App("reports")
image = modal.Image.debian_slim().pip_install("requests")


@app.function(image=image, schedule=modal.Cron("0 9 * * MON-FRI", timezone="America/New_York"),
              cpu=2, memory=2048, timeout=900, retries=2,
              secrets=[modal.Secret.from_name("reports", required_keys=["API_TOKEN"])])
def morning_report():
    print("sent")
```

`python -m withruntime.modal deploy app.py` (or `app.deploy()`) makes each function with a `schedule` a job named `<app>-<function>`. All the app's functions run from one image that holds every function's packages. So a scheduled function's `.remote()`, `.local()`, `.map()`, `.for_each()` and `.spawn()` calls run in the same sandbox, as plain calls. Every function must start from the same base image. `cpu`, `memory`, `timeout` and `retries` size the job. Each of a secret's `required_keys` is bound from the jobs secret of that name. Every function's secrets are bound to every job, because the functions a scheduled function calls run in its sandbox. Store it first with `runtime secrets set NAME --jobs`.

`modal.Cron` keeps its expression and time zone. `modal.Period` becomes the cron that runs as often: `Period(hours=1)` is `0 * * * *`, and `Period(days=1)` is `0 0 * * *`. Unlike on Modal, these runs fall on the clock's marks, not on intervals counted from the deploy. A period under a minute, such as `Period(seconds=5)` in Modal's own example, runs as a job each minute that calls the function every 5 seconds through that minute. Its sandbox is billed for the whole minute.

### Google Cloud Run and AWS Batch

```bash no-run
gcloud run jobs describe nightly-export --format export > job.yaml
gcloud scheduler jobs describe nightly-export-trigger --format yaml > scheduler.yaml
runtime jobs import job.yaml scheduler.yaml --dry-run    # the plan; creates nothing
runtime jobs import job.yaml scheduler.yaml              # builds and creates the job

runtime jobs import template.yaml --parameter AWS::Region=us-east-1 --parameter AWS::AccountId=123456789012
```

`runtime jobs import` reads the files into a plan (`POST /v1/job-imports`, `jobs.importPlan` in the SDKs, or the `runtime_jobs_import` MCP tool). For each job, it builds an image `FROM` the job's container image. It adds the job's environment and working directory, with the platform's command and args as the image's `ENTRYPOINT` and `CMD`. It then creates the job, which runs the image's start command, or updates the job of the same name. Pulling from Artifact Registry, ECR or another private registry needs its credential once: `runtime images registry set <host>`.

- **Size, timeout and retries** carry over. CPU rounds up to whole vCPUs. A timeout over {{job-max-run}}, or a job with none (AWS Batch's default), is {{job-max-run}}. Cloud Run's `maxRetries` and Batch's `retryStrategy.attempts` become attempts, at most {{job-max-attempts}}.
- **Schedules.** A Cloud Scheduler job's cron and time zone carry over unchanged. An EventBridge `cron(...)` becomes five fields: `?` becomes `*`, and days of the week count from Sunday as 0. A `rate(...)` becomes the cron that runs as often, on the clock's marks. `at(...)` runs once, in the schedule's time zone. A job with no schedule in the files runs when triggered, or at `--cron`.
- **Secrets.** A value from Secret Manager, Secrets Manager or SSM is bound from the jobs secret of the same name. The import refuses the job until that secret is stored. A secret never goes into the image.
- **Batch parameters.** `Ref::name` in a command is filled in from the definition's `parameters`, then from the parameters its schedule submits. The schedule's container overrides apply too.
- **CloudFormation.** `!Ref`, `!Join` and `!Sub` of the template's parameters (their defaults, or `--parameter`) are worked out. A value that still names something only CloudFormation knows blocks the job, and the reason names the `--parameter` to give.

Some settings have no equivalent. A job that would not run as it did is blocked, with the reason, and the rest move. `--dry-run` also prints each image's full Dockerfile. A user or working directory that is not a plain value (letters, digits and `- _ . / : @ +`) blocks the job, so a file cannot add its own build steps.

- More than one task at once (Cloud Run's `taskCount`), a multi-node Batch job, or sidecar containers. A job runs one command on one machine.
- A GPU.
- A mounted volume: a Cloud Storage bucket, NFS, EFS or a secret mounted as a file. Read the data over the network, or keep it on a [volume](#keep-data-between-runs).

Others are left out with a note: VPC connectors (reach private hosts over a [WireGuard network](./networking)), Cloud SQL sockets, a job queue's priority and compute environments (each run gets its own sandbox when it is due), and log drivers (a run's output is kept with the run). A service account or job role becomes an [identity token](./identity-tokens) the run trades for that account's access, with no stored key.

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
| `runtime jobs import <file>...`     | `jobs.importPlan`            | Move Cloud Run or AWS Batch jobs              |
| `runtime jobs deploy [<dir>]`       | -                            | Run Trigger.dev tasks or Inngest functions    |

The HTTP routes are `POST /v1/jobs`, `GET /v1/jobs`, `GET /v1/jobs/{id}`, `GET /v1/jobs/{id}/runs` (oldest first; `?order=newest` for newest first), `POST /v1/jobs/{id}:pause`, `:resume`, `:trigger`, `:reschedule` (body `{"schedule": ...}`), `:cancel`, `PATCH /v1/jobs/{id}` (also `POST /v1/jobs/{id}:update`; a body of the fields that change), `GET /v1/job-runs/{id}`, `GET /v1/job-runs/{id}/logs` and `POST /v1/job-imports` (a plan; it changes nothing). Every write takes an `Idempotency-Key`. The SDKs and the CLI send one for you. So a retry after a lost response never creates a second job.
