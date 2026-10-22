# Custom images

Build an image once with your code and dependencies, then start every sandbox
from it. An image is built from any Dockerfile, from any public or private
container image, or from a short recipe of packages. Each build of a name is
its next version, tags such as `latest` and `prod` point at versions, and an
image can say what a sandbox from it runs and when that sandbox is ready.

## Build from a Dockerfile

Point the SDK or the CLI at a folder with a Dockerfile. The folder is the build
context, exactly as with `docker build`: every file its `.dockerignore` leaves
in is packed, and only the parts that changed since your last build are
uploaded.

```bash no-run
runtime images build . -t web:v1
runtime sandboxes create --image web:v1
```

A Dockerfile somewhere else goes with `-f`, read from where you run the
command, as `docker build` reads it; a path inside the folder works too. In a
monorepo, the repository is the context and the app's Dockerfile names it:

```bash no-run
runtime images build . -f apps/web/Dockerfile -t web:v1
```

```ts check
import { readFile } from "node:fs/promises";
import { Runtime } from "withruntime";

const runtime = new Runtime();
const image = await runtime.images.build(
  { name: "web", dockerfile: await readFile("Dockerfile", "utf8"), contextDir: "." },
  { onLog: (line) => console.log(line.text) },
);
await using sbx = await runtime.sandboxes.create({ image: "web" });
console.log(image.version, sbx.id);
```

```python check
from withruntime import Runtime

runtime = Runtime()
with open("Dockerfile") as handle:
    image = runtime.images.build(name="web", dockerfile=handle.read(), context_dir=".",
                                 on_log=lambda line: print(line["text"]))
sandbox = runtime.sandboxes.create(image="web")
```

What a Dockerfile can use:

- Multi-stage builds. `FROM <stage>`, `COPY --from=<stage>` and
  `COPY --from=<image>` all work, and only the stages the image needs are
  built. `--target` (the SDKs' `target`) builds a named stage instead of the
  last one.
- `ARG` before and after `FROM`, build arguments, and the platform arguments
  (`TARGETARCH` is `amd64`).
- Heredocs: `RUN <<EOF`, `RUN python3 <<EOF`, a script with its own `#!`, and
  `COPY <<EOF /path`.
- `ADD` from an `http` or `https` URL, checked when you give
  `--checksum=sha256:...`, and `ADD` of a local `.tar`, `.tar.gz`, `.tgz`,
  `.tar.bz2` or `.tar.xz` archive, which is unpacked.
- `FROM scratch`, any public image, a private image (see below), or
  `FROM runtime` for Runtime's own base image with Python, Node, Bun and the
  usual tools.
- `COPY --chown`, `COPY --chmod` (octal such as `755`, or symbolic such as
  `a+x` or `u+x,go-w` for files from the build context), `WORKDIR`, `ENV`,
  `USER`, `SHELL` and `RUN --mount=type=cache`, which runs without the cache
  mount. As on Docker, an `ENV` beats an `ARG` of the same name, and an `ARG`
  with no value and no build argument stays unset. As in Docker, root owns
  what `COPY` and `ADD` write unless `--chown` names an owner, and the
  directories a `WORKDIR` creates belong to the `USER` of the time, so
  `USER node`, `WORKDIR /app`, `COPY . .`, `RUN npm ci` builds.
- `CMD`, `ENTRYPOINT` and `HEALTHCHECK` become the image's start and ready
  commands (see below).
- A stage `FROM` an image starts where that image says, as on Docker: in its
  `WORKDIR`, as its `USER`, with its `CMD` and `ENTRYPOINT`. `FROM golang`
  then `COPY main.go .` puts the file in `/go`. A base the API cannot read
  (a private registry, or one that does not answer in 5 seconds) starts at
  `/`, as root, with no start command, and the build's notes say so.

A few forms are refused with a message that says what to do instead:
`RUN --mount=type=secret`, `type=ssh` and `type=bind`, `ONBUILD`, `ADD` from a
git repository, and `COPY --exclude`. Only the last stage can start
`FROM runtime`; start earlier stages from a public image such as
`ubuntu:24.04`.

The build runs in its own Firecracker virtual machine with the same web access
as a sandbox. `USER` applies to the build's `RUN` steps; commands in a sandbox
run as the sandbox user, uid 1000, with passwordless `sudo` as in the base
image: an image with its own `sudo` keeps it, and one without gets Runtime's.
A command that names no directory starts in
the last `WORKDIR`, as on Docker and E2B, and in `/workspace` when there is
none; so do the image's start and ready commands (`CMD`, `ENTRYPOINT`,
`HEALTHCHECK`). The build gives that directory and everything in it to the
sandbox user, so commands can write where they start. A system directory such
as `/usr` or `/tmp` stays root's, and the build log says so. A file the image
puts in `/tmp` is there when a sandbox starts, as on Docker; until 9 October
2026 a sandbox from an image on Runtime's base started with `/tmp` empty. An
image built earlier with a `WORKDIR` outside `/workspace` starts commands in
`/workspace` until it is built again.

Names resolve through Runtime's resolver in every image: the image's own
`/etc/resolv.conf` is replaced, in each `RUN` step and in the sandbox, as
Docker replaces it when a container runs. An image built before 30 September
2026 from a Debian or Ubuntu base, such as `python:3.12-slim`, may fail to look
up names; build it again.

## Build from an image or a recipe

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.images.build({ name: "py", image: "python:3.12-slim" });
await runtime.images.build({ name: "data", recipe: { pip: ["pandas"], apt: ["jq"] } });
```

A recipe takes `base` (`runtime` by default, or any image), `apt`, `pip`,
`npm`, `commands`, `files`, `env` and `workdir`. The CLI builds one with
`--pip`, `--apt` and `--npm`, and uses an image as it is with `--from`.

## Private registries

Store a credential for a registry once, and every build of your account pulls
from it. The secret is sealed to Runtime's servers the moment it arrives. No
call returns it, and the API that stored it cannot read it back. A build opens
it only to pull, inside its own build machine.

```bash no-run
echo "$GHCR_TOKEN" | runtime images registry set ghcr.io --username my-user
echo "$AWS_SECRET_ACCESS_KEY" | runtime images registry set 123456789012.dkr.ecr.us-east-1.amazonaws.com --access-key-id AKIA...
runtime images registry ls
```

| Registry                                                | Give                                                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Docker Hub (`docker.io`)                                | your user name and an access token                                                                                    |
| GitHub (`ghcr.io`)                                      | your user name and a token that can read packages                                                                     |
| Google (`gcr.io`, `*-docker.pkg.dev`)                   | `_json_key` and the service account key's JSON, or `oauth2accesstoken` and an access token                            |
| Amazon ECR (`<account>.dkr.ecr.<region>.amazonaws.com`) | an access key id and secret that may call `ecr:GetAuthorizationToken` and pull; each build asks ECR for a fresh token |
| Any other                                               | a user name and a token or password                                                                                   |

The same credentials cover `FROM`, `COPY --from=<image>` and a recipe's `base`.

A pull refused without credentials may mean the image does not exist: Docker
Hub answers a name it lacks as it answers a private one, so check the spelling
before storing a credential. A tag the registry lacks fails the build with the
tag named.
In the SDKs: `runtime.images.registries.set(...)`, `.list()` and `.delete(...)`.

## Names, versions and tags

Every build of a name gets the next version number. When a build is ready, it
takes the tags you gave it, or `latest` when you gave none. A tag points at one
version and moves when another version takes it; a later version keeps a tag
even if an earlier build finishes after it.

Wherever an image is named, including `image` when you create a sandbox, it can
be its id, `name` (its `latest` tag), `name:tag` or `name@version`.

A sandbox starts only from an image of your account, so a public image is
built first. Build it under its own name and tag, and the same words then name
it:

```bash no-run
runtime images build --from python:3.12-slim -t python:3.12-slim
runtime sandboxes create --image python:3.12-slim
```

A reference that names nothing answers `image_not_found`. For a name you have
built, it lists the name's tags and versions, and `details` carries them; for a
name you never built, it gives the build command above.

```bash no-run
runtime images build . -t web:v2 -t web:latest
runtime images versions web
runtime images tag web@2 prod
runtime images untag web@1 prod
runtime images rm web@1
```

Deleting a version removes its tags too. Sandboxes already started from it
keep running. A version an App still needs, the one it runs, the one it would
roll back to, or one it is deploying, is not deleted: the answer is
`image_in_use` (409), naming the App.

A name rebuilt on every change, such as a site deployed on each merge, keeps
every version until you delete it, and each counts toward your image disk.
`--keep` deletes the older ones once the new build is ready, keeping the
newest that many and any an App still needs:

```bash no-run
runtime images build . -t web:"$(git rev-parse --short HEAD)" --keep 3
```

## Move a sandbox to a new version

A new build leaves the sandboxes already running an image alone. To move one
to the new version and keep its files, switch its image:

```bash no-run
runtime sandboxes switch-image "${id}" web:v2 --keep-workspace
```

`sbx.switchImage("web:v2")` in JavaScript, `sbx.switch_image("web:v2")` in
Python, and `POST /v1/sandboxes/{id}:switch-image` with `{"image": "web:v2"}`
do the same ([API](./api#sandboxes)).

- **What it keeps:** its id and name, `/workspace` (your home, with its
  dotfiles and what `pip install` and `npm install -g` put there), its
  volumes, environment, labels, previews and ports.
- **What it loses:** its running processes, which start again with the new
  image's start command, and everything else on its old disk: packages
  installed with `sudo` or apt, and changes to `/etc`. To keep everything,
  snapshot the sandbox first.
- A running sandbox is paused for the switch; a paused one, or a stopped
  persistent one, is switched as it is. It is charged as a wake.
- If anything goes wrong the switch is undone: the answer is
  `switch_undone`, and the sandbox is on its old image with its files and
  memory as they were.
- A switch of a {{switch-time-workspace}} `/workspace` in {{switch-time-files}}
  files takes {{switch-time}} on its server, measured until the sandbox runs
  the new image: it boots twice, and the copy runs between the boots.
- The new image must be ready, stored on the sandbox's server
  (`image_on_another_host` otherwise), and fit its disk. Copying `/workspace`
  may take up to {{switch-copy-time}}; a larger one is refused and undone.

## Start and ready commands

An image can say what runs when a sandbox starts from it, and when that
sandbox counts as ready. A Dockerfile's `CMD` and `ENTRYPOINT` become the start
command and its `HEALTHCHECK` becomes the ready check. An image built from
`image` alone starts what Docker runs: `{image: "redis:7"}` starts
`docker-entrypoint.sh redis-server` in `/data`. A shell or a language's prompt
as `CMD` (`bash`, `python3`) starts nothing, since it would exit at once. You
can set or change both with `start`:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.images.build({
  name: "api",
  recipe: {
    pip: ["fastapi", "uvicorn"],
    files: [
      {
        path: "/workspace/main.py",
        content:
          'from fastapi import FastAPI\n\napp = FastAPI()\n\n@app.get("/")\ndef home():\n    return {"ok": True}\n',
      },
    ],
  },
  start: {
    command: "uvicorn main:app --host 0.0.0.0 --port 8000",
    readyPort: 8000,
    readyTimeoutSeconds: 60,
  },
});
const sbx = await runtime.sandboxes.create({ image: "api" });
console.log(sbx.info.start); // { state: "ready", readyMs: ... }
```

The start command runs once per boot, in the background, as the sandbox user, in the
image's `WORKDIR` (or `start.cwd`): at create, and again at each `:restart`
and `:resize`, which boot from the disk with no process left running (a wake
from a pause keeps memory, so its process runs on). The create call answers when the ready
check passes: `readyPort` is being listened on, or `readyCommand` exits 0. It
answers with `start.state` set to `ready`, `started` (no ready check, and
still running 150 ms after it began), `timeout` (the check did not
pass within `readyTimeoutSeconds`, 60 by default and at most 300, within the
SDKs' own five-minute call deadline), or `exited` (the start command ended
first; `start.exitCode` and `start.stderr`, its last lines of error output,
say why). `start: null` drops what the Dockerfile said.

Only the create's answer carries `start`, and the sandbox object it returned
keeps it through later reads. The API keeps no record of it, so a sandbox read
with `sandboxes.get` or `list` has none.

## Fast starts

A few seconds after an image is ready, Runtime keeps a started copy of it at
the default size (2 vCPU, 4 GiB of memory, a 4 GiB disk), and a sandbox of that
size created from the image starts from the copy. Measured through the API on
25 September 2026: 481 ms at the median from create to running, 533 ms at p95,
against 3.7 s to boot the image. A copy serves only its own size, so the first
sandbox of another size boots the image, and Runtime then keeps a started copy
of that size too: up to two more sizes per image, each with up to 8 GiB of
memory. A new build of an image starts with copies at those sizes already:
it gets, before its first sandbox, a started copy of each size your account's
other images have one of on that server (they count among its two), so a
rebuilt image created at 1 vCPU and 512 MiB starts from a copy from its first
create there. An image larger than the default 4 GiB disk gets its started copy at
the default vCPU and memory on the smallest of 8, 16, 32 or 64 GiB of disk
that holds it, so ask for that `diskMiB` to start fast from the first create.
A start that finds no copy boots the image: measured on 8 October 2026, about
2 s from create to running for a 4.4 GiB image, against 0.3 s from a copy.
Each server keeps its own copies, so the first create of a size on a server
that has none boots. A pilot's servers keep one at the pilot's size from the start. Each copy
is your account's alone, goes when the image is deleted, and is neither
charged nor counted toward your image disk quota. A server keeps an image's
started copies while sandboxes are created from it there: once none has been
for 2 days, and the image has been on that server at least as long, the
copies go. The next sandbox of it on that server boots the image, and the
copies are kept again from then on.

## Faster rebuilds

A build keeps up to three checkpoints of its filesystem: where its image
stage starts (after the base image is pulled, or after the earlier stage it is
built `FROM`), and the latest two points after a command that more steps
follow. A later build of your account that starts the same way begins at the
latest matching checkpoint instead of from the beginning:

- Every Dockerfile, recipe or image on the same base, such as
  `python:3.12-slim`, skips the pull once one build on it has run.
- Changing your code reruns only the steps after the `COPY` that brings it in.
- Builds of different `--target` stages that are built `FROM` the same stage
  share the checkpoint after that stage, so it is not built again.
- An earlier stage that the image only reads with `COPY --from` is built again
  whenever a step that reads it runs; its result is not kept.

A build that fails keeps its checkpoints too, so fixing it is quick: change
the failing step and build again, and the build starts after the last
command that ran before the failure (or after the pull, when nothing had run)
instead of from the beginning. Only the steps from there on run again. A
failed build's checkpoints go when a build of your account started after the
failure finishes, whether it succeeds or fails; one that fails keeps its own
in their place. The build log says what a failed build kept and where the next one
will start, which image's checkpoint a build started from, and `cache` on
the image says what it keeps.

Checkpoints stay on the server with the image that made them and go when it is
deleted. They count toward your image disk quota and are not charged. When a
new build would go over that quota, the oldest checkpoints kept from failed
builds are let go first, so they never stop a build.

A base named by its tag, such as `FROM python:3.12-slim` or `:latest`, is
looked up when the build is created and pinned to the digest the tag names
then, as `docker buildx build` does. A tag that has moved since an earlier
build is a different base, so the build pulls it again and reuses no step
built on the old one. A base on a private registry, or one that does not
answer within 5 seconds, cannot be looked up this way; it keeps its tag, the
build's notes say so, and a checkpoint after its pull holds it as it was then.
Pin such a base with `@sha256:<digest>`, or pass `cache: false` (`--no-cache`)
to pull it again, build every step from scratch and keep no checkpoints.

An identical build of your account, same plan and same files, built by the
same builder version, is copied at once instead of built, unless the build
passes `cache: false`.

## Build machine

Each build runs in its own virtual machine, sized apart from the sandboxes that
will use the image. Its scratch disk holds the build context and every earlier
stage, so a large multi-stage build can need more than the default 4 GiB. Set
it, and the rest of the build machine, with `build`:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.images.build({
  name: "ml",
  recipe: { pip: ["torch"] },
  build: { vcpu: 4, memoryMiB: 8192, diskMiB: 16_384, maxImageMiB: 12_288 },
});
```

In Python it is `build={"vcpu": 4, "memory_mib": 8192, "disk_mib": 16384}`;
over HTTP, `build.diskMiB` in the body of `POST /v1/images`. The ranges are
under [Limits](#limits); an odd `memoryMiB` is rounded up to the next even
number, as a sandbox's is. The scratch disk must fit the builder image; smaller
requests are refused before a build is queued. From the CLI, `--disk-mib`, `--max-image-mib` and
`--timeout` set the build's scratch disk, the image size and the build time.

## Build logs

`images.build` streams the log to `onLog` (`on_log`) as it is written. The CLI
prints it while it builds, and `runtime images logs <image> --follow` streams it
again. Over HTTP, `GET /v1/images/{id}/logs?follow=true` answers with one JSON
event per line: each `line`, then `done` with the image.

In your account, [Images](https://withruntime.com/account/images) lists each
image, and its page shows every version with its tags and the build log, which
follows a build while it runs. **Build image** accepts a Dockerfile with a small
inline context, a registry image or a package recipe. From an image's detail
page, start a sandbox, add or remove tags, or delete the selected version.
Spending and deletion ask for confirmation, using the permissions already
granted to the console's agent.

A build that fails in one of your steps ends with that step's output in the
log. When the server that builds the image is busy, the build waits up to five
minutes for room to start its build machine, and its log says it is waiting;
that wait counts toward the build time. A build that fails on our side instead,
because its build machine did not start or the server failed, says so in its
error rather than blaming your Dockerfile, and we are alerted; build again in a
few minutes.

## Limits

| Limit                | Value                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builds at once       | 1 until your account holds credit, then 4                                                                                                         |
| Build machine        | 1 to 8 vCPUs (2 by default), 1 to 16 GiB of memory (4 GiB), {{image-build-disk-min-gib}} to 32 GiB of scratch disk ({{image-build-disk-min-gib}}) |
| Build time           | 60 seconds to 1 hour (30 minutes by default), counting starting the build machine and saving the image                                            |
| Image size           | 512 MiB to 20 GiB (8 GiB by default); at least {{runtime-base-image-mib}} from Runtime's base, which is that size before any step                 |
| Build context        | 100 MiB compressed, 20,000 files, 2 GiB unpacked                                                                                                  |
| Context upload       | 1 MiB chunks, kept 24 hours after last use; 200 MiB held and 1 GiB uploaded a day per account                                                     |
| Inline `files`       | 256 files and 1 MiB in all                                                                                                                        |
| Dockerfile           | 256 KiB, 200 steps across all stages, 16 earlier stages                                                                                           |
| Registry credentials | 20 per account                                                                                                                                    |

## Pricing

A stored image is charged on its whole file. Storage
quotas follow the same allocation ([pricing](./pricing#snapshots-images-and-volumes)). Building an image is free
with credit. Without credit, a build counts toward the free usage, only for the time it builds, and is at most 2 vCPU and 4 GiB, {{trial-build-time}} and {{trial-builds-a-day}} builds
a day. A build that fails through a fault of ours, such as a build machine
that does not start, uses none of the free usage. The [free usage](./included-usage) stores your first three images free for as long as you keep them, even after you add credit, outside the monthly allowance for saved copies. `storedBytes` on an image is not what it is charged on: `sizeBytes` is.
