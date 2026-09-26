# Runtime for Harbor and Terminal-Bench

Run Harbor trials, Terminal-Bench 2.0 among them, each in its own Runtime microVM, with the task and the agent unchanged.

`RuntimeEnvironment` is a Harbor environment, like its Docker, E2B or Modal
environments. Harbor loads it by import path, so it works with the Harbor you
already have. Each trial gets a Firecracker microVM with its own kernel, built
from the task's own `Dockerfile` or `docker_image`, and you pay for the CPU it
uses rather than the CPUs it holds.

## Install

```bash no-run
pip install "withruntime[harbor]"
```

Harbor needs Python 3.12 or newer. The key comes from `RUNTIME_API_KEY` or this
machine's `npx withruntime login`, as for the rest of the SDK.

## Run a benchmark

Pass the environment's import path to `-e`, and its options with `--ek`:

```bash no-run
harbor run -t hello-world/hello-world -a oracle -e withruntime.harbor:RuntimeEnvironment --ek funding=trial
harbor run -d terminal-bench@2.0 -a oracle -e withruntime.harbor:RuntimeEnvironment --n-concurrent 8
```

The `oracle` agent runs each task's reference solution against its tests, so it
checks the environment without calling a model. Swap in your own agent and
model with `-a` and `-m`.

In a job config, or from Python:

```python check
import asyncio

from harbor.job import Job
from harbor.models.job.config import JobConfig
from harbor.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig


async def main():
    job = await Job.create(
        JobConfig(
            environment=EnvironmentConfig(
                import_path="withruntime.harbor:RuntimeEnvironment",
                kwargs={"funding": "trial"},
            ),
            agents=[AgentConfig(name="oracle")],
            tasks=[TaskConfig(name="hello-world/hello-world")],
        )
    )
    await job.run()


asyncio.run(main())
```

## Options

Every option is optional.

| `--ek`     | What it does                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `funding`  | `trial` or `paid`. Left out, the account's default: the free trial while it lasts                                         |
| `region`   | The region to run in; left out, the default                                                                               |
| `image`    | A Runtime image (id, name or `name:tag`) to start every trial from, instead of building the task's                        |
| `build`    | Build limits, such as `build='{"disk_mib": 16384}'`: `vcpu`, `memory_mib`, `disk_mib`, `max_image_mib`, `timeout_seconds` |
| `labels`   | Your own labels on each sandbox and image                                                                                 |
| `base_url` | Another API address; `RUNTIME_API_URL` does the same                                                                      |

## What runs in the sandbox

| Harbor                                   | Runtime                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment/Dockerfile`, `docker_image` | A [custom image](./images), built once and kept as `harbor-<task>` with a tag from a hash of the environment. Reruns start from it; `--force-build` builds it again             |
| `cpus`, `memory_mb`, `storage_mb`        | `vcpu`, `memory_mib`, `disk_mib`. A trial sandbox is at most 2 vCPU, 4 GiB and 10 GiB of disk; a larger request on the trial runs at that size, with a warning                  |
| Commands                                 | `bash -c` (`sh -c` in an image without bash), in the task's `workdir` or the Dockerfile's `WORKDIR`, with the task's and the agent's environment. Output streams, however large |
| Users                                    | Root by default, as in Docker, and any named user, through `sudo`                                                                                                               |
| Files                                    | Uploads and downloads of any size, anywhere in the machine, as root                                                                                                             |
| Network policies                         | `no-network`, and allow-lists of hostnames, `*.domain` wildcards, IPv4 addresses and IPv4 CIDR ranges, changed while the trial runs                                             |
| Long trials                              | The sandbox's lease is kept ahead of now until the trial ends, however long it runs                                                                                             |

**Root and `sudo`.** Commands in a Runtime sandbox run as the sandbox user,
uid 1000, and Harbor runs them as root. The environment runs root commands
through the sandbox user's passwordless `sudo`, which Runtime's base image
has. Runtime adds it to every image it builds, from a public image too; an
image built before 25 September 2026 may lack it, and rebuilding adds it. The
environment checks when the trial starts and, when it is missing, stops the
trial with this line to add to the task's `Dockerfile`:

```dockerfile
RUN apt-get update && apt-get install -y sudo && echo '#1000 ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/runtime
```

**Not supported:** Docker Compose tasks with sidecar services, GPUs, Windows
tasks, IPv6 allow-list entries, and Harbor's stream mode, which Harbor offers
only to its built-in environments.

## Limits to plan for

- The trial runs eight sandboxes at once, so keep `--n-concurrent` at 8 or
  below on the trial. A paid account runs more; see [pricing](./pricing#how-many-at-once).
- Each task is its own image. Builds run one at a time until your account has
  bought credit, then four. A free trial keeps its first three images free;
  after that they are billed as stored images
  ([pricing](./pricing#snapshots-images-and-volumes)). `runtime image ls` lists
  them and `runtime image rm` removes them.
- Harbor stops each sandbox when its trial ends.

## What was verified

On 25 September 2026 the environment ran under Harbor 0.23.0 against a fake
Runtime API whose sandbox is a folder on the test machine: Harbor loading it by
import path, building an image once and reusing it, `--force-build`, root and
uid 1000 commands through a real `sudo`, the Dockerfile's `WORKDIR`, task and
per-command variables, streamed output, a 40 KB command with 80 variables,
timeouts, directory and file transfers, the refusal when `sudo` is missing, the
trial's sizes, network policies and cleanup. On the same fake, a whole
`harbor run -a oracle` of Harbor's hello-world example task, with its verifier
changed to check the file without installing packages on the test machine,
scored 1.
