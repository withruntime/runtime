# Custom images

Build an image once, with your code and dependencies. Then start every sandbox from it. You can build an image from any Dockerfile. You can also build one from any public or private container image, or from a short recipe of packages. Each build of a name becomes its next version. Tags such as `latest` and `prod` point at versions. An image can also say what a sandbox from it runs, and when that sandbox is ready.

## Build from a Dockerfile

Point the SDK or the CLI at a folder with a Dockerfile. The folder is the build context, as with `docker build`. Every file that its `.dockerignore` leaves in is packed. Only the parts that changed since your last build are uploaded.

```bash no-run
runtime images build . -t web:v1
runtime sandboxes create --image web:v1
```

For a Dockerfile somewhere else, use `-f`. The path is read from where you run the command, as with `docker build`. A path inside the folder works too. In a monorepo, the repository is the context. The command passes the app's Dockerfile with `-f`:

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

A Dockerfile can use:

- Multi-stage builds. `FROM <stage>`, `COPY --from=<stage>` and `COPY --from=<image>` all work. Only the stages that the image needs are built. `--target` (the SDKs' `target`) builds a named stage instead of the last one.
- `ARG` before and after `FROM`, build arguments, and the platform arguments (`TARGETARCH` is `amd64`).
- Heredocs: `RUN <<EOF`, `RUN python3 <<EOF`, a script with its own `#!`, and `COPY <<EOF /path`.
- `ADD` from an `http` or `https` URL. It is checked when you give `--checksum=sha256:...`. `ADD` also takes a local `.tar`, `.tar.gz`, `.tgz`, `.tar.bz2` or `.tar.xz` archive, and unpacks it.
- `FROM scratch`, any public image, a private image (see below), or `FROM runtime` for Runtime's own base image with Python, Node, Bun and the usual tools.
- `COPY --chown`, and `COPY --chmod`. `--chmod` takes octal, such as `755`, or symbolic, such as `a+x` or `u+x,go-w`, for files from the build context. Also `WORKDIR`, `ENV`, `USER`, `SHELL`, and `RUN --mount=type=cache`. The cache mount is not used. The step runs without the cache mount. As on Docker, an `ENV` beats an `ARG` of the same name. An `ARG` with no value and no build argument stays unset. As in Docker, root owns what `COPY` and `ADD` write, unless `--chown` names an owner. The directories a `WORKDIR` creates belong to the `USER` in effect at that time. So `USER node`, `WORKDIR /app`, `COPY . .` and `RUN npm ci` build.
- `CMD`, `ENTRYPOINT` and `HEALTHCHECK` become the image's start and ready commands (see below).
- A stage that starts `FROM` an image starts where that image says, as on Docker. It starts in the image's `WORKDIR`, as its `USER`, with its `CMD` and `ENTRYPOINT`. For example, `FROM golang` and then `COPY main.go .` puts the file in `/go`. A base the API cannot read starts at `/`, as root, with no start command. The build's notes say so. A base the API cannot read is one on a private registry, or one that does not respond within 5 seconds.

A few forms are refused. The refusal message says what to do instead. These are `RUN --mount=type=secret`, `type=ssh` and `type=bind`, `ONBUILD`, `ADD` from a git repository, and `COPY --exclude`. Only the last stage can start `FROM runtime`. Start earlier stages from a public image, such as `ubuntu:24.04`.

The build runs in its own Firecracker virtual machine. It has the same web access as a sandbox. `USER` applies to the build's `RUN` steps. Commands in a sandbox run as the sandbox user, uid 1000, with passwordless `sudo`, as in the base image. An image with its own `sudo` keeps it. An image without one gets Runtime's. A command that names no directory starts in the last `WORKDIR`, as on Docker and E2B. If there is no `WORKDIR`, it starts in `/workspace`. The image's start and ready commands (`CMD`, `ENTRYPOINT`, `HEALTHCHECK`) start the same way. The build gives that directory, and everything in it, to the sandbox user. So commands can write where they start. A system directory such as `/usr` or `/tmp` stays root's. The build log says so. A file the image
puts in `/tmp` is there when a sandbox starts, as on Docker. Until 9 October 2026, a sandbox from an image on Runtime's base started with `/tmp` empty. An image built earlier with a `WORKDIR` outside `/workspace` starts commands in `/workspace`. It does so until it is built again.

Names resolve through Runtime's resolver in every image. The image's own `/etc/resolv.conf` is replaced. This happens in each `RUN` step and in the sandbox, as Docker replaces it when a container runs. An image built before 30 September 2026 from a Debian or Ubuntu base, such as `python:3.12-slim`, may fail to look up names. Build it again.

## Build from an image or a recipe

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.images.build({ name: "py", image: "python:3.12-slim" });
await runtime.images.build({ name: "data", recipe: { pip: ["pandas"], apt: ["jq"] } });
```

A recipe takes `base` (`runtime` by default, or any image), `apt`, `pip`, `npm`, `commands`, `files`, `env` and `workdir`. The CLI builds one with `--pip`, `--apt` and `--npm`, and uses an image as it is with `--from`.

## Private registries

Store a credential for a registry once. Every build of your account then pulls from that registry with it. The secret is sealed to Runtime's servers as soon as it arrives. No call returns it. The API that stored it cannot read it back. A build opens it only to pull, inside its own build machine.

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

A pull refused without credentials may mean the image does not exist. Docker Hub returns the same answer for a missing name as for a private one. So check the spelling before you store a credential. A tag the registry lacks fails the build, with the tag named. In the SDKs, use `runtime.images.registries.set(...)`, `.list()` and `.delete(...)`.

## Names, versions and tags

Every build of a name gets the next version number. When a build is ready, it takes the tags you gave it. If you gave none, it takes `latest`. A tag points at one version. It moves when another version takes it. A later version keeps a tag, even if an earlier build finishes after it.

Wherever an image is named, including `image` when you create a sandbox, you can use its id. You can also use `name` (its `latest` tag), `name:tag` or `name@version`.

A sandbox starts only from an image of your account. So build a public image first. Build it under its own name and tag. Then the same words name it:

```bash no-run
runtime images build --from python:3.12-slim -t python:3.12-slim
runtime sandboxes create --image python:3.12-slim
```

A reference that names nothing returns `image_not_found`. For a name you have built, the error lists the name's tags and versions in `details`. For a name you never built, it gives the build command above.

```bash no-run
runtime images build . -t web:v2 -t web:latest
runtime images versions web
runtime images tag web@2 prod
runtime images untag web@1 prod
runtime images rm web@1
```

Deleting a version also removes its tags. Sandboxes already started from it keep running. A version that an App still needs is not deleted. That includes the version it runs, the version it would roll back to, and a version it is deploying. Deleting it returns `image_in_use` (409), and the error names the App.

A name rebuilt on every change, such as a site deployed on each merge, keeps every version until you delete it. Each version counts toward your image disk. `--keep` deletes the older versions once the new build is ready. It keeps the newest that many, and any version an App still needs:

```bash no-run
runtime images build . -t web:"$(git rev-parse --short HEAD)" --keep 3
```

## Move a sandbox to a new version

A new build does not change sandboxes that already run an image. To move one to the new version and keep its files, switch its image:

```bash no-run
runtime sandboxes switch-image "${id}" web:v2 --keep-workspace
```

`sbx.switchImage("web:v2")` in JavaScript, `sbx.switch_image("web:v2")` in Python, and `POST /v1/sandboxes/{id}:switch-image` with `{"image": "web:v2"}` do the same ([API](./api#sandboxes)).

- **What it keeps:** its id and name, `/workspace` (your home, with its dotfiles and what `pip install` and `npm install -g` put there), its volumes, environment, labels, previews and ports.
- **What it loses:** its running processes, which start again with the new image's start command. It also loses everything else on its old disk: packages installed with `sudo` or apt, and changes to `/etc`. To keep everything, take a snapshot of the sandbox first.
- A running sandbox is paused for the switch. A paused one, or a stopped persistent one, is switched as it is. It is charged as a wake.
- If anything goes wrong, the switch is undone. The result is `switch_undone`. The sandbox is on its old image, with its files and memory as they were.
- A switch of a {{switch-time-workspace}} `/workspace` with {{switch-time-files}} files takes {{switch-time}} on its server. This is measured until the sandbox runs the new image. The sandbox boots twice, and the copy runs between the boots.
- The new image must be ready. It must be stored on the sandbox's server, or the switch fails with `image_on_another_host`. It must also fit the sandbox's disk. Copying `/workspace` may take up to {{switch-copy-time}}. A larger `/workspace` is refused, and the switch is undone.

## Start and ready commands

An image can say what runs when a sandbox starts from it. It can also say when that sandbox counts as ready. A Dockerfile's `CMD` and `ENTRYPOINT` become the start command. Its `HEALTHCHECK` becomes the ready check. An image built from `image` alone starts what Docker runs. For example, `{image: "redis:7"}` starts `docker-entrypoint.sh redis-server` in `/data`. A shell or a language's prompt as `CMD` (`bash`, `python3`) starts nothing, because it would exit immediately. You can set or change both with `start`:

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

The start command runs once per boot. It runs in the background, as the sandbox user, in the image's `WORKDIR` (or `start.cwd`). It runs at create. It runs again at each `:restart` and `:resize`. Those boot from the disk with no process left running. A wake from a pause keeps memory, so its process runs on. The create call returns when the ready check passes. The ready check passes when `readyPort` is being listened on, or when `readyCommand` exits 0. The response sets `start.state` to one of these values:

- `ready`: the ready check passed.
- `started`: there is no ready check, and the command is still running 150 ms after it began.
- `timeout`: the check did not pass within `readyTimeoutSeconds`. The default is 60, and the maximum is 300. The wait must fit within the SDKs' own five-minute call deadline.
- `exited`: the start command ended first. `start.exitCode` and `start.stderr` say why. `start.stderr` holds the last lines of error output.

`start: null` drops what the Dockerfile said.

Only the create response carries `start`. The sandbox object it returned keeps it through later reads. The API keeps no record of it, so a sandbox read with `sandboxes.get` or `list` has none.

## Fast starts

A few seconds after an image is ready, Runtime keeps a started copy of it at the default size. The default is 2 vCPU, 4 GiB of memory and a 4 GiB disk. A sandbox of that size created from the image starts from the copy. Measured through the API on 25 September 2026, the median from create to running was 481 ms. At p95 it was 533 ms. Booting the image takes 3.7 s. A copy serves only its own size. So the first sandbox of another size boots the image. Runtime then keeps a started copy of that size too. That is up to two more sizes per image, each with up to 8 GiB of memory. A new build of an image starts with copies at those sizes already. Before its first sandbox, it gets a started copy of each size that your account's other images have on that server. Those copies count among its two. So a rebuilt image created at 1 vCPU and 512 MiB starts from a copy from its first create there. An image larger than the default 4 GiB disk gets its started copy at the default vCPU and memory. That copy uses the smallest of 8, 16, 32 or 64 GiB of disk that holds the image. A create from an image of up to 8 GiB that names no `diskMiB` gets the 8 GiB disk. That is within the {{running-disk-included}} a running sandbox's disk includes. It starts from that copy. From a larger image, the create is refused with `disk_too_small`. The error names the `diskMiB` to ask for. A `diskMiB` you name is kept.

A start that finds no copy boots the image. Measured on 8 October 2026, that took about 2 s from create to running for a 4.4 GiB image. A copy took 0.3 s. Each server keeps its own copies. So the first create of a size on a server that has none boots. A pilot's servers keep one at the pilot's size from the start. Each copy belongs to your account alone. It goes when the image is deleted. It is neither charged nor counted toward your image disk quota. A server keeps an image's started copies while sandboxes are created from it there. Once none has been used for 2 days, and the image has been on that server at least as long, the copies go. The next sandbox of it on that server boots the image. The copies are kept again from then on.

## Faster rebuilds

A build keeps up to three checkpoints of its filesystem. The first is where its image stage starts. That is after the base image is pulled, or after the earlier stage it is built `FROM`. The other two are the latest points after a command that more steps follow. A later build of your account that starts the same way begins at the latest matching checkpoint. It does not start from the beginning:

- Every Dockerfile, recipe or image on the same base, such as `python:3.12-slim`, skips the pull once one build on it has run.
- Changing your code reruns only the steps after the `COPY` that brings it in.
- Builds of different `--target` stages that are built `FROM` the same stage share the checkpoint after that stage, so it is not built again.
- An earlier stage that the image only reads with `COPY --from` is built again whenever a step that reads it runs. Its result is not kept.

A build that fails keeps its checkpoints too. That makes the fix quick. Change the failing step and build again. The build starts after the last command that ran before the failure. If nothing had run, it starts after the pull. It does not start from the beginning. Only the steps from there on run again. A failed build's checkpoints go when a build of your account that started after the failure finishes. This applies whether that build succeeds or fails. A build that fails keeps its own checkpoints in their place. The build log says what a failed build kept. It says where the next build will start, and which image's checkpoint a build started from. The `cache` field on the image says what it keeps.

Checkpoints stay on the server with the image that made them. They go when that image is deleted. They count toward your image disk quota, but they are not charged. When a new build would go over that quota, the oldest checkpoints from failed builds are released first. So they never stop a build.

A base named by its tag, such as `FROM python:3.12-slim` or `:latest`, is looked up when the build is created. It is pinned to the digest that the tag names at that time, as `docker buildx build` does. A tag that has moved since an earlier build is a different base. So the build pulls it again, and reuses no step built on the old base. A base on a private registry cannot be looked up this way. Neither can a base that does not respond within 5 seconds. Such a base keeps its tag. The build's notes say so. A checkpoint after its pull holds it as it was then. To pin such a base, use `@sha256:<digest>`. Or pass `cache: false` (`--no-cache`). That pulls the base again, builds every step from scratch, and keeps no checkpoints.

An identical build of your account is copied immediately instead of built. It must have the same plan, the same files, and the same builder version. This does not apply if the build passes `cache: false`.

## Build machine

Each build runs in its own virtual machine. Its size is set apart from the sandboxes that will use the image. Its scratch disk holds the build context and every earlier stage. So a large multi-stage build can need more than the default 4 GiB. To set the scratch disk and the rest of the build machine, use `build`:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.images.build({
  name: "ml",
  recipe: { pip: ["torch"] },
  build: { vcpu: 4, memoryMiB: 8192, diskMiB: 16_384, maxImageMiB: 12_288 },
});
```

In Python, it is `build={"vcpu": 4, "memory_mib": 8192, "disk_mib": 16384}`. Over HTTP, use `build.diskMiB` in the body of `POST /v1/images`. The ranges are under [Limits](#limits). An odd `memoryMiB` is rounded up to the next even number, as a sandbox's is. The scratch disk must fit the builder image. Requests smaller than the builder image are refused before a build is queued. In the CLI, `--disk-mib`, `--max-image-mib` and `--timeout` set the scratch disk, the image size and the build time.

## Build logs

`images.build` streams the log to `onLog` (`on_log`) as it is written. The CLI prints it while it builds. `runtime images logs <image> --follow` streams it again. Over HTTP, `GET /v1/images/{id}/logs?follow=true` returns one JSON event per line. It returns each `line`, then `done` with the image.

In your account, [Images](https://withruntime.com/account/images) lists each image. Its page shows every version with its tags, and the build log. The log follows a build while it runs. **Build image** accepts a Dockerfile with a small inline context, a registry image, or a package recipe. From an image's detail page, you can start a sandbox, add or remove tags, or delete the selected version. Spending and deletion ask for confirmation. They use the permissions already granted to the console's agent.

A build that fails in one of your steps ends with that step's output in the log. When the server that builds the image is busy, the build waits up to five minutes for room to start its build machine. The log says it is waiting. That wait counts toward the build time. A build can also fail on our side. This happens when its build machine did not start, or the server failed. Its error says so, and does not blame your Dockerfile. We are alerted. Build again in a few minutes.

## Limits

| Limit                | Value                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent builds    | 1 until your account holds credit, then 4                                                                                                         |
| Build machine        | 1 to 8 vCPUs (2 by default), 1 to 16 GiB of memory (4 GiB), {{image-build-disk-min-gib}} to 32 GiB of scratch disk ({{image-build-disk-min-gib}}) |
| Build time           | 60 seconds to 1 hour (30 minutes by default), counting starting the build machine and saving the image                                            |
| Image size           | 512 MiB to 20 GiB (8 GiB by default); at least {{runtime-base-image-mib}} from Runtime's base, which is that size before any step                 |
| Build context        | 100 MiB compressed, 20,000 files, 2 GiB unpacked                                                                                                  |
| Context upload       | 1 MiB chunks, kept 24 hours after last use; 200 MiB held and 1 GiB uploaded a day per account                                                     |
| Inline `files`       | 256 files and 1 MiB in all                                                                                                                        |
| Dockerfile           | 256 KiB, 200 steps across all stages, 16 earlier stages                                                                                           |
| Registry credentials | 20 per account                                                                                                                                    |

## Pricing

A stored image is charged on its whole file. Storage quotas follow the same allocation ([pricing](./pricing#snapshots-images-and-volumes)). Building an image is free with credit. Without credit, a build counts toward the free usage, only for the time it builds. It is at most 2 vCPU and 4 GiB, {{trial-build-time}} and {{trial-builds-a-day}} builds a day. A build that fails through a fault of ours, such as a build machine that does not start, uses none of the free usage. The [free usage](./included-usage) stores your first three images free for as long as you keep them, even after you add credit, outside the monthly allowance for saved copies. This applies even after you add credit. It sits outside the monthly allowance for saved copies. `storedBytes` on an image is not what it is charged on: `sizeBytes` is.
