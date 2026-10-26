---
launch: actions
---

# GitHub Actions

Change one line of a workflow, and its job runs on Runtime:

```yaml
jobs:
  test:
    runs-on: runtime # was: ubuntu-latest
```

Each job gets its own sandbox of your account. The sandbox runs GitHub's own runner,
registered for that one job and deleted when it ends. Nothing else in the
workflow changes. `actions/checkout`, `setup-node`, `setup-python`,
`actions/cache`, `docker build` and matrices run as they do on GitHub's
machines, only sooner: each job starts warm.
[CI head to head](./ci-head-to-head) times six public projects' own jobs,
in Node.js, Rust, Python, Go, Java and a monorepo, here and on GitHub's
hosted runners.

## Starts warm

A job's sandbox starts as a copy of its repository's runner. It is already set up
at your default branch's latest commit, with nothing to configure:

- GitHub's runner is unpacked, so no download comes before the first step.
- The Node, Python, Go and Rust versions your workflows name
  (`node-version`, `python-version`, `go-version`, `toolchain`, their
  matrices, `.nvmrc`, `.python-version`, `go.mod`, `rust-toolchain.toml`) are
  in the runner's tool cache. So `setup-node` and the rest find them and
  download nothing.
- Docker is running when a workflow uses it. The images of your `services:`, `container:` jobs
  and `docker://` steps are already pulled. The first `docker` command
  returns immediately. A service's pull only asks the
  registry whether its tag moved (about a second) before it starts.
- Your dependencies' downloads are kept (npm, pnpm, yarn, bun, pip, uv,
  poetry, Go modules, Cargo's registry). So the job's install reads them
  locally.

It is set up from your default branch only, with no secret and no job run.
A pull request's code never runs in what later jobs start from. After a job
starts, it is set up again in the background when your default branch has
moved and the last one has paid for itself (see Billing). This happens at most every 10
minutes for each repository and size. Until a repository's first one is
ready, its jobs start from an empty machine.

## Connect

In the console, open **GitHub Actions** and press **Connect GitHub
Actions**. It installs Runtime's GitHub App on the repositories you choose
and turns runners on. Then push a workflow with `runs-on: runtime`.

Or with the API: install the App with the link that `POST /v1/actions/github:install`
returns. Open it in a browser within 15 minutes. Then turn runners on with an agent key allowed `create`, `list`,
`get`, `stop` and `exec`:

```bash no-run
curl -X POST https://api.withruntime.com/v1/actions:enable \
  -H "authorization: Bearer $RUNTIME_API_KEY" \
  -H "content-type: application/json" \
  -d '{"maxRunning": 10}'
```

Runners act as that key's agent and never with more than that key. Its
grants bound every runner's sandbox. Runners stop starting once the key is
revoked or expires. `POST /v1/actions:disable` stops starting them. A runner
already running finishes its job.

## Sizes

| `runs-on`       | vCPU | Memory | Disk    |
| --------------- | ---- | ------ | ------- |
| `runtime`       | 2    | 8 GiB  | 40 GiB  |
| `runtime-2cpu`  | 2    | 8 GiB  | 40 GiB  |
| `runtime-4cpu`  | 4    | 16 GiB | 80 GiB  |
| `runtime-8cpu`  | 8    | 32 GiB | 160 GiB |
| `runtime-16cpu` | 16   | 64 GiB | 160 GiB |

Each vCPU is a whole core, with 4 GiB of memory. A runner also carries GitHub's self-hosted
labels, so `runs-on: [self-hosted, linux, x64, runtime-4cpu]` matches too. A
`runs-on` that names two sizes, or a label a Runtime runner doesn't carry,
is left for another runner.

## Docker and service containers

Docker works in every runner as on GitHub's: `services:` (Postgres, Redis,
MySQL or any image, with their health checks and ports), `container:` jobs,
`docker build`, Buildx with `docker/setup-buildx-action`, and `docker
compose`. A job that starts warm has Docker running and its images pulled
(see Starts warm). Otherwise, Docker Engine, Buildx and Compose install as the runner starts,
while it downloads and GitHub hands it the job. A `docker` command run
before they are ready waits for them. A job that runs no `docker` command
never starts Docker.

```yaml
jobs:
  test:
    runs-on: runtime
    container: node:20
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready --health-interval 2s --health-retries 30
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test # reaches the database at postgres:5432
```

In a `container:` job, services are reached by their names (`postgres`,
`redis`). In a job on the runner itself, they are reached at `localhost` on the ports they
publish (`ports: ["5432:5432"]`). Containers reach the web with no proxy
settings. Docker Hub images come through Google's mirror of it,
`mirror.gcr.io`, first.

## Coming from another runner

A job written for Blacksmith, Namespace, Depot, BuildJet, WarpBuild,
Ubicloud or RunsOn runs on Runtime with its `runs-on` unchanged. Connect the
repository, and its label is taken as the Runtime size below. Change the
label to a `runtime` size, or keep it.

| `runs-on` you have                                                                              | Runtime size         |
| ----------------------------------------------------------------------------------------------- | -------------------- |
| `blacksmith-<n>vcpu-ubuntu-<2204, 2404, 2604>`                                                  | `n` vCPU             |
| `buildjet-<n>vcpu-ubuntu-<2004, 2204>`                                                          | `n` vCPU             |
| `depot-ubuntu-<22.04, 24.04, latest>`, `-<n>` after it                                          | 2 vCPU, or `n`       |
| `warp-ubuntu-<latest, 2204, 2404, 2604>-x64-<n>x`                                               | `n` vCPU             |
| `ubicloud`, `ubicloud-standard-<n>`, `-ubuntu-<version>` after either                           | 2 vCPU, or `n`       |
| `nscloud-ubuntu-<version>-amd64-<n>x<GB>`, options like `-with-cache` after it                  | `n` vCPU (4 without) |
| `namespace-profile-<name>`                                                                      | 4 vCPU               |
| `runs-on=<id>` with `runner=<n>cpu-linux-x64`, `cpu=<n>` or `ram=<GB>`, in one label or several | `n` vCPU (2 without) |
| `runs-on` with `run-id=<id>` (RunsOn v2's form), and the same                                   | `n` vCPU (2 without) |

A count between sizes gets the next size up (6 vCPU runs on 8). A count above 16
gets 16. RunsOn's settings for buying its machine (`spot`, `family`,
`region`, `volume` and the like) are taken as they are. Its `s3-cache` extra
is Runtime's own cache for `actions/cache`. Its own AMI, a `pool` or `efs` stay
with RunsOn. Every job runs on Runtime's runner image, whichever Ubuntu its label
names. Arm, macOS and Windows labels are left for that company's runner, as
is a label Runtime doesn't know. If the other company's App is still
installed on the repository, a job goes to whichever runner GitHub gives it
first. Uninstall it to run every job on Runtime.

Their own actions keep working, unedited. On a Runtime runner, each is run by
the action GitHub's own runners use for the same thing, with the same
inputs:

| Action                                                                                                                          | Runs as                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `useblacksmith/cache`, `buildjet/cache`, `WarpBuilds/cache`, `ubicloud/cache`, `runs-on/cache` (and their `restore` and `save`) | `actions/cache`                                                |
| `namespacelabs/nscloud-cache-action` (`path`, and `cache` modes like `go`, `pnpm`, `rust`)                                      | `actions/cache`, keyed by the job and its lock files           |
| `buildjet/setup-node`                                                                                                           | `actions/setup-node`                                           |
| `useblacksmith/setup-docker-builder`, `namespacelabs/nscloud-setup-buildx-action`                                               | `docker/setup-buildx-action`, building on the runner           |
| `useblacksmith/build-push-action`, `depot/build-push-action`                                                                    | `docker/build-push-action`, building on the runner             |
| `depot/bake-action`                                                                                                             | `docker/bake-action`, building on the runner                   |
| `depot/setup-action`, `depot/use-action`                                                                                        | a `depot` command whose `build` and `bake` run `docker buildx` |
| `useblacksmith/stickydisk` (`key`, `path`, `commit`)                                                                            | `actions/cache`: the newest saved restored, saved at the end   |
| `namespacelabs/nscloud-checkout-action`                                                                                         | `actions/checkout`                                             |

Each one takes every input and gives every output the company's own action
does, pinned to a tag or a commit, spelled `WarpBuilds/cache` or
`warpbuilds/cache`. Docker's own inputs, like `network`, `add-hosts` and
`shm-size`, reach Docker's action. Inputs that only mean something to the
other company, like Depot's `project` and `token`, are accepted and left
unused.

## Limits

- Jobs of private repositories only. A public repository's job is refused,
  with the reason in the job's list. Anyone can open a pull request on a
  public repository.
- At most `maxRunning` runners at the same time (default 10, up to 100). More jobs
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

Setting a repository's runner up warm is billed as its own usage. It is done
only when it saves your jobs more time than it takes. Each refresh runs
in a sandbox of your jobs' size, billed by the second like any sandbox. No
jobs, no refresh, no charge. The first refresh is made after a repository and
size's third job. Each one after it runs only once the jobs that started
warm since the last refresh have together saved more seconds than that
refresh ran. A job's saving is measured, not assumed: its time against the
middle of the same job's starts from an empty machine. Measured on 2 vCPU on
22 October 2026: expressjs/express's test job takes 34.3 s from an empty
machine and 10.7 s warm, 23.6 s saved. Its refresh runs 44 s, so it pays for
itself by the second job. BurntSushi/ripgrep's build and test job goes from
55.2 s to 45.7 s, 9.5 s saved. Its refresh runs 50 s, paid back by the sixth.
The warm snapshot is billed as any snapshot of yours. One is kept for each
repository and size, and the one before it is deleted once a newer is ready.
None is kept past 7 days.
