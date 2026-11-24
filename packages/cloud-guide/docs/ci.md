# CI/CD

Run a repository's checks on a machine with git, Docker, Node, Bun and Python, or as a GitHub Actions runner.

A machine that runs a repository's checks to their end (its `run`) with git, Docker, Node, Bun, Python and a compiler, and is stopped then. As an Actions runner, it starts GitHub's runner for the one job of its just-in-time configuration (`run` `runtime-runner`, `RUNNER_JITCONFIG` in its environment) and stops with it; a job of a GitHub account connected through Runtime's GitHub App gets one by itself.

| Default | Value |
| --- | --- |
| vCPUs | 4 |
| Memory | 16 GB |
| Disk | 16 GB, or its image's size when larger |
| Image | `runtime/ci` |

[`POST /v2/ci`](./reference/ci#create-a-ci) takes the same [SandboxCreate](./reference/sandboxes#sandboxcreate) as a [sandbox](./sandboxes); every field overrides a default above. A run costs $0.001 per vCPU-minute while it runs, with 4 GB of memory per vCPU included, billed by the second, and nothing once it ends.

## Run a repository's checks

Give the checks as [`run`](./reference/sandboxes#sandboxcreate), or run them with [`POST /v2/ci/{id}:exec`](./reference/ci#exec) as here.

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const ci = await runtime.ci.create();
try {
  const checks = await ci.exec(
    "git clone --depth 1 https://github.com/python/typing_extensions /workspace/typing_extensions && cd /workspace/typing_extensions/src && python3 -m unittest -q test_typing_extensions && echo checks passed",
    { timeoutSeconds: 300 },
  );
  console.log(checks.exitCode, checks.stdout.trim().split("\n").at(-1)); // 0 checks passed
  if (checks.exitCode !== 0) throw new Error(checks.stderr);
} finally {
  await ci.delete();
}
```

## Run GitHub Actions jobs

1. Signed in to the console, open [withruntime.com/v2/github/install](https://withruntime.com/v2/github/install), install Runtime's GitHub App on your GitHub account and choose its repositories. GitHub returns you to Runtime in the same browser: select **Connect**. You must be an owner of the GitHub account and able to create keys in the Runtime organization.
2. In each workflow, set `runs-on` to a Runtime size:

```yaml
jobs:
  test:
    runs-on: runtime # was: ubuntu-latest
```

| `runs-on` | vCPUs | Memory | Disk |
| --- | --- | --- | --- |
| `runtime`, `runtime-2cpu` | 2 | 8 GB | 40 GB |
| `runtime-4cpu` | 4 | 16 GB | 80 GB |
| `runtime-8cpu` | 8 | 32 GB | 160 GB |
| `runtime-16cpu` | 16 | 64 GB | 160 GB |

`self-hosted`, `linux` and `x64` may be listed beside the size, and a label of Blacksmith, BuildJet, Depot, WarpBuild, Ubicloud, Namespace or RunsOn for Linux on x64 runs unchanged on the nearest Runtime size. Jobs run only for private repositories: anyone can open a pull request on a public one. Each queued job gets a CI machine of its own, with none of your organization's secrets (the job's secrets come from GitHub), named `github-job-<random>`; it runs one job, whichever queued job of its labels GitHub gives it, and is deleted when that job completes. The connection is a key named `GitHub Actions (<account>)` in your organization, which may only create and delete CI machines and spends at most $100 in any 24 hours until you raise its cap ([keys](./keys)). Revoking it disconnects the account, as does removing the App on GitHub.

## Merge pull requests in a queue

Runtime's GitHub App can merge pull requests through a queue on any GitHub plan, so a branch is never broken by two changes that pass on their own but fail together. The queue is off in a repository until a pull request there has the `runtime-queue` label; until then the App does nothing new in it.

1. Run your checks on the queue's branches as well as on pull requests:

```yaml
on:
  pull_request:
  merge_group: # GitHub's own merge queue, if you use it
  push:
    branches: ['runtime-queue/**']
```

2. If a ruleset or branch protection rule restricts pushes to the branch, add Runtime's GitHub App to its bypass list. The App moves the branch only to a commit whose checks passed.
3. Add the label `runtime-queue` to a pull request to queue it, or `runtime-queue-urgent` to queue it ahead of the others.

Each branch that pull requests merge into has a queue of its own, set by that branch's own settings file. The App queues a pull request only if it comes from a branch of the same repository (not a fork), was labeled by someone with write access, and is mergeable under your rules: its required reviews and checks pass.

The App merges up to 10 queued pull requests, oldest first, into a group on a branch named `runtime-queue/<branch>/...`, and your workflow runs on it once. Each group is merged onto the group ahead of it, so it is tested with every change that lands before it, and up to 4 groups are tested at once. An urgent pull request is merged onto the branch's tip alone and lands first. When every required status check of the branch passes on a group (every check, if none is required) and the groups ahead of it have landed, the App fast-forwards the branch to it, and GitHub marks each of its pull requests as merged. If a check fails, the App tests the first half of the group alone, and so on, until it finds the pull request that fails; that pull request leaves the queue, with a comment that names the failed check, and the groups behind it are merged again without it. A pull request that does not merge cleanly leaves the queue the same way. A new push to a queued pull request starts its group again, and the groups behind it.

The App makes its merges on a branch named `runtime-queue-building/<branch>/merges`, whose every commit says `[skip ci]`, so no workflow runs there.

### Queue settings

A file `.github/runtime-queue.json` on the branch sets its queue, as in `{"group": 1, "fromBase": [".github/", "ci/"]}`. The App reads it from the branch alone, never from a pull request. Each field is optional.

| Field | Default | What it does |
| --- | --- | --- |
| `group` | `10` | The most pull requests in one group, 1 to 10. |
| `auto` | `false` | Every ready pull request from the repository waits in the queue, labeled or not. |
| `workflow` | Every check | The one workflow whose checks judge a group, such as `.github/workflows/ci.yml`. |
| `fromBase` | None | Paths whose files a group's checks take from the branch, never from its pull requests: your workflow and the scripts that judge a change. A folder ends in `/`. The `workflow` is always among them. |
| `approvers` | None | Logins, one of whom must approve exactly a pull request's head before it lands when it changes `.github/` or another path that judges a change. |

With `fromBase`, a group's branch holds one more commit, `Checks from <branch>'s <paths> at <commit>`, in which those paths are as they are on the branch: your workflow runs the branch's workflow and scripts on the change, so a pull request cannot change or skip its own checks. The group under that commit is what lands, with the pull request's own versions of those paths, which judge the groups after it.

The queue needs the App's read access to commit statuses (for a CI that reports statuses rather than check runs). Installations from before the queue are asked by GitHub to accept it.

To run a job on a machine you create yourself, create a CI machine with [`run`](./reference/sandboxes#sandboxcreate) set to `runtime-runner` and the job's just-in-time configuration from GitHub (`POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`) in `RUNNER_JITCONFIG` ([`env`](./reference/sandboxes#sandboxcreate)). It runs that one job, then stops.

## Next steps

- Every call on a CI machine: [Ci](./reference/ci).
- Run checks on a schedule: [jobs](./jobs).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/ci.md. Run this repository's tests on a Runtime CI machine: create it with `run` set to clone the repository and run the tests, wait for it to stop, and print its exit code and the last lines of its output.
>
> This page as Markdown: https://withruntime.com/docs/ci.md
