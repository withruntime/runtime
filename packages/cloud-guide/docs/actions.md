---
launch: actions
---

# GitHub Actions

Change one line of a workflow and its job runs on Runtime:

```yaml
jobs:
  test:
    runs-on: runtime # was: ubuntu-latest
```

Each job gets a fresh sandbox of your account running GitHub's own runner,
registered for that one job and deleted when it ends. Nothing else in the
workflow changes: `actions/checkout`, `setup-node`, `setup-python`,
`actions/cache`, `docker build` and matrices run as they do on GitHub's
machines.

## Connect

In the console, open **GitHub Actions** and press **Connect GitHub
Actions**. It installs Runtime's GitHub App on the repositories you choose
and turns runners on. Then push a workflow with `runs-on: runtime`.

Or with the API: install the App with the link
`POST /v1/actions/github:install` answers (open it in a browser within 15
minutes), then turn runners on with an agent key allowed `create`, `list`,
`get`, `stop` and `exec`:

```bash no-run
curl -X POST https://api.withruntime.com/v1/actions:enable \
  -H "authorization: Bearer $RUNTIME_API_KEY" \
  -H "content-type: application/json" \
  -d '{"maxRunning": 10}'
```

Runners act as that key's agent and never with more than that key: its
grants bound every runner's sandbox, and runners stop starting once it is
revoked or expires. `POST /v1/actions:disable` stops starting them; a runner
already running finishes its job.

## Sizes

| `runs-on`       | vCPU | Memory | Disk    |
| --------------- | ---- | ------ | ------- |
| `runtime`       | 2    | 4 GiB  | 40 GiB  |
| `runtime-2cpu`  | 2    | 4 GiB  | 40 GiB  |
| `runtime-4cpu`  | 4    | 8 GiB  | 80 GiB  |
| `runtime-8cpu`  | 8    | 16 GiB | 160 GiB |
| `runtime-16cpu` | 16   | 32 GiB | 160 GiB |

Each vCPU is a whole core. A runner also carries GitHub's self-hosted
labels, so `runs-on: [self-hosted, linux, x64, runtime-4cpu]` matches too. A
`runs-on` that names two sizes, or a label a Runtime runner doesn't carry,
is left for another runner.

## Limits

- Jobs of private repositories only. A public repository's job is refused,
  with the reason in the job's list: anyone can open a pull request on a
  public repository.
- At most `maxRunning` runners at once (default 10, up to 100); more jobs
  wait their turn, oldest first.
- A job runs at most 6 hours, as on GitHub's own machines.
- A runner no job came to within 30 minutes is removed.

## See what ran

`GET /v1/actions/jobs` lists the runners started for your jobs, newest
first: the repository, workflow and job, the size, its state, how the job
ended on GitHub, and why any did not start. The console's GitHub Actions
page shows the same list.

| State       | What it means                                                           |
| ----------- | ----------------------------------------------------------------------- |
| `queued`    | Waiting for room under `maxRunning`.                                    |
| `starting`  | Its sandbox is being made.                                              |
| `waiting`   | Its runner is up, waiting for GitHub to give it the job.                |
| `running`   | Its runner took a job.                                                  |
| `done`      | The job ended; `conclusion` says how. Its sandbox is deleted.           |
| `cancelled` | The job ended before a runner took it, or none came within 30 minutes.  |
| `failed`    | Its runner could not start after 5 tries; `reason` says why.            |
| `refused`   | It never started: `reason` says what to fix (a public repository, say). |

## Billing

A runner's sandbox is billed by the second, as any sandbox of its size, from
when it starts until it is deleted.
