# Runtime for Inspect AI

Run each Inspect sample's tools in its own Runtime microVM, from the Dockerfile or compose file your eval already has.

Installing the package registers a sandbox named `runtime` with Inspect, next to
its `docker` and `local` sandboxes. Every sample gets a Firecracker microVM with
its own kernel, built from the same Dockerfile or single-service
`compose.yaml` the Docker sandbox takes, and you pay for the CPU it uses rather
than the CPUs it holds.

## Install

```bash no-run
pip install "withruntime[inspect-ai]"
```

The key comes from `RUNTIME_API_KEY` or this machine's `npx withruntime login`,
as for the rest of the SDK. Nothing needs importing: the package's entry point
tells Inspect about `runtime`.

## Use it

```python check
from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.scorer import includes
from inspect_ai.solver import generate, use_tools
from inspect_ai.tool import bash


@task
def kernel():
    return Task(
        dataset=[Sample(input="Which Linux kernel version is running? Answer with the version.", target="6.")],
        solver=[use_tools(bash()), generate()],
        scorer=includes(),
        sandbox="runtime",
    )
```

`sandbox="runtime"` runs Runtime's base image: Ubuntu with Python, Node.js, git
and the usual tools ([what is installed](./sandbox-environment)). To use your
own image, name the file as you would for Docker, or switch an existing eval
from the command line:

```bash no-run
inspect eval task.py --sandbox runtime
inspect eval task.py --sandbox runtime:compose.yaml
```

```python check
from inspect_ai import Task
from withruntime.inspect_ai import RuntimeSandboxEnvironmentConfig

from_dockerfile = Task(sandbox=("runtime", "Dockerfile"))
from_compose = Task(sandbox=("runtime", "compose.yaml"))
configured = Task(
    sandbox=("runtime", RuntimeSandboxEnvironmentConfig(image="python:3.12-slim", funding="trial", memory_mib=2048))
)
```

A Dockerfile or a compose service's `build` or `image` is built once as a
[custom image](./images), named `inspect-<name>` with a tag from a hash of the
Dockerfile and its build context, and every sample starts from it. It is built
again only when those files change.

## Options

`RuntimeSandboxEnvironmentConfig` takes these, all optional. A compose file can
set them under `x-runtime` on the service.

| Field                            | What it does                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `image`                          | A container image such as `python:3.12-slim`, built once as a Runtime image                                                    |
| `dockerfile`                     | A Dockerfile's path; its folder is the build context                                                                           |
| `runtime_image`                  | A Runtime image (id, name or `name:tag`), used as it is                                                                        |
| `funding`                        | `trial` or `paid`. Left out, the account's default: the free trial while it lasts                                              |
| `vcpu`, `memory_mib`, `disk_mib` | The sandbox's size. On the trial, at most 2 vCPU, 4 GiB and 10 GiB of disk; a larger request runs at that size, with a warning |
| `user`                           | Who commands and file operations run as when Inspect names no user: `root` by default                                          |
| `workdir`                        | Where relative paths and commands start: `/workspace` by default, or the Dockerfile's `WORKDIR`                                |
| `env`                            | Variables for every command                                                                                                    |
| `network`                        | Network rules from the start, such as `{"internet": False}`                                                                    |
| `region`, `labels`, `build`      | The region, your own labels, and build limits such as `{"disk_mib": 16384}`                                                    |

From a compose service, `cpus` and `mem_limit` (or `deploy.resources.limits`)
set the size, `working_dir`, `environment` and `user` carry over, and
`network_mode: none` turns the network off.

## What runs in the sandbox

- **Commands** run as root unless Inspect names a user, as in the Docker
  sandbox. Commands in a Runtime sandbox run as the sandbox user, uid 1000,
  so root and named users go through its passwordless `sudo`, which Runtime's
  base image has. An image built from a public image needs it too; the sandbox
  checks when a sample starts and, when it is missing, stops with this line to
  add to the Dockerfile:

```dockerfile
RUN apt-get update && apt-get install -y sudo && echo '#1000 ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/runtime
```

- **Output** streams, so Inspect's own 10 MiB limit applies, and input of any
  size reaches the command.
- **Files** of any size, anywhere in the machine; Inspect's 100 MiB read limit
  applies.
- **Timeouts** raise `TimeoutError` and are retried as Inspect asks.
- **Long samples** keep their sandbox: its lease is kept ahead of now until the
  sample ends.
- `inspect sandbox cleanup runtime` stops sandboxes an interrupted eval left,
  and `connection()` gives `runtime sandbox ssh <id>` to open a shell in one.

**Not supported:** a compose file with more than one service, and the trio
async backend.

## Limits to plan for

- The trial runs {{trial-sandboxes}} sandboxes at once, so the sandbox asks Inspect for
  eight at a time. On a paid account raise it with `--max-sandboxes`; see
  [pricing](./pricing#how-many-at-once).
- Builds run one at a time until your account has bought credit, then four. A
  free trial keeps its first three images free; after that they are billed as
  stored images ([pricing](./pricing#snapshots-images-and-volumes)).

## What was verified

On 25 September 2026 Inspect AI 0.3.268's own portable sandbox checks
(`inspect_ai.util._sandbox.self_check`) ran against this sandbox over a fake
Runtime API whose sandbox is a folder on the test machine, with commands run
through a real `sudo`. Every check passed except three that expect the default
user to be refused a file, which root is not, and one that adds a user account,
which was left out because it would have changed the test machine. The same
run covered building a Dockerfile once, a compose service's settings, the
refusal of several services, the output limit, a missing `sudo`, and cleanup,
and an `eval()` of a task with `sandbox="runtime"` on the same fake. In a fresh
install of the package, Inspect found `runtime` through its entry point.
