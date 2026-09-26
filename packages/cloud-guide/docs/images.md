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
runtime image build . -t web:v1
runtime sandbox create --image web:v1
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
- `COPY --chown`, `COPY --chmod`, `WORKDIR`, `ENV`, `USER`, `SHELL` and
  `RUN --mount=type=cache`, which runs without the cache mount.
- `CMD`, `ENTRYPOINT` and `HEALTHCHECK` become the image's start and ready
  commands (see below).

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
the last `WORKDIR` when it is inside `/workspace`, and in `/workspace`
otherwise.

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
echo "$GHCR_TOKEN" | runtime image registry set ghcr.io --username my-user
echo "$AWS_SECRET_ACCESS_KEY" | runtime image registry set 123456789012.dkr.ecr.us-east-1.amazonaws.com --access-key-id AKIA...
runtime image registry ls
```

| Registry                                                | Give                                                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Docker Hub (`docker.io`)                                | your user name and an access token                                                                                    |
| GitHub (`ghcr.io`)                                      | your user name and a token that can read packages                                                                     |
| Google (`gcr.io`, `*-docker.pkg.dev`)                   | `_json_key` and the service account key's JSON, or `oauth2accesstoken` and an access token                            |
| Amazon ECR (`<account>.dkr.ecr.<region>.amazonaws.com`) | an access key id and secret that may call `ecr:GetAuthorizationToken` and pull; each build asks ECR for a fresh token |
| Any other                                               | a user name and a token or password                                                                                   |

The same credentials cover `FROM`, `COPY --from=<image>` and a recipe's `base`.
In the SDKs: `runtime.images.registries.set(...)`, `.list()` and `.delete(...)`.

## Names, versions and tags

Every build of a name gets the next version number. When a build is ready, it
takes the tags you gave it, or `latest` when you gave none. A tag points at one
version and moves when another version takes it; a later version keeps a tag
even if an earlier build finishes after it.

Wherever an image is named, including `image` when you create a sandbox, it can
be its id, `name` (its `latest` tag), `name:tag` or `name@version`.

```bash no-run
runtime image build . -t web:v2 -t web:latest
runtime image versions web
runtime image tag web@2 prod
runtime image untag web@1 prod
runtime image rm web@1
```

Deleting a version removes its tags too. Sandboxes already started from it
keep running.

## Start and ready commands

An image can say what runs when a sandbox starts from it, and when that
sandbox counts as ready. A Dockerfile's `CMD` and `ENTRYPOINT` become the start
command and its `HEALTHCHECK` becomes the ready check. You can set or change
both with `start`:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.images.build({
  name: "api",
  recipe: { pip: ["fastapi", "uvicorn"] },
  start: { command: "uvicorn main:app --port 8000", readyPort: 8000, readyTimeoutSeconds: 60 },
});
const sbx = await runtime.sandboxes.create({ image: "api" });
console.log(sbx.info.start); // { state: "ready", readyMs: ... }
```

The start command runs once, in the background, as the sandbox user. The create
call answers when the ready check passes: `readyPort` is being listened on, or
`readyCommand` exits 0. It answers with `start.state` set to `ready`,
`started` (no ready check), `timeout` (the check did not pass within
`readyTimeoutSeconds`, 60 by default and at most 300, within the SDKs' own five-minute call deadline), or `exited` (the start
command ended first). `start: null` drops what the Dockerfile said.

## Fast starts

A few seconds after an image is ready, Runtime keeps a started copy of it at
the default size (2 vCPU, 4 GiB of memory, a 4 GiB disk), and a sandbox of that
size created from the image starts from the copy. Measured through the API on
25 September 2026: 481 ms at the median from create to running, 533 ms at p95,
against 3.7 s to boot the image. Other sizes boot the image as before. The copy
is your account's alone, stays on the server with the image, goes when the
image is deleted, and counts toward your image disk quota; it is not charged.

## Faster rebuilds

A build keeps up to three checkpoints of its filesystem: after the base image
is pulled, and after the last commands before later steps. A later build of your
account that begins with the same steps starts from the latest matching
checkpoint instead of from the beginning, so changing your code reruns only the
steps after the `COPY` that brings it in. The build log says which image's
checkpoint it started from, and `cache` on the image says what it keeps.

Checkpoints stay on the server with the image that made them and go when it is
deleted. They count toward your image disk quota and are not charged. Pass
`cache: false` (`--no-cache`) to build every step from scratch and keep none.

An identical build of your account, same plan and same files, built by the
same builder version, is copied at once instead of built.

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
under [Limits](#limits). From the CLI, `--disk-mib`, `--max-image-mib` and
`--timeout` set the build's scratch disk, the image size and the build time.

## Build logs

`images.build` streams the log to `onLog` (`on_log`) as it is written. The CLI
prints it while it builds, and `runtime image logs <image> --follow` streams it
again. Over HTTP, `GET /v1/images/{id}/logs?follow=true` answers with one JSON
event per line: each `line`, then `done` with the image.

In your account, [Images](https://withruntime.com/account/images) lists each
image, and its page shows every version with its tags and the build log, which
follows a build while it runs.

## Limits

| Limit                | Value                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Builds at once       | 1 until your account has bought credit, then 4                                                  |
| Build machine        | 1 to 8 vCPUs (2 by default), 1 to 16 GiB of memory (4 GiB), 1 to 32 GiB of scratch disk (4 GiB) |
| Build time           | 60 seconds to 1 hour (30 minutes by default)                                                    |
| Image size           | 512 MiB to 20 GiB (8 GiB by default)                                                            |
| Build context        | 100 MiB compressed, 20,000 files, 2 GiB unpacked                                                |
| Context upload       | 1 MiB chunks, kept 24 hours after last use; 200 MiB held and 1 GiB uploaded a day per account   |
| Inline `files`       | 256 files and 1 MiB in all                                                                      |
| Dockerfile           | 256 KiB, 200 steps across all stages, 16 earlier stages                                         |
| Registry credentials | 20 per account                                                                                  |

## Pricing

A stored image is charged on its whole file
([pricing](./pricing#snapshots-images-and-volumes)). Building an image is free
and does not use trial hours. A free trial keeps its first three images free.
