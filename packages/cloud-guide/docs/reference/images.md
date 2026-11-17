# Image API reference

What a machine boots: a root filesystem, its environment and its start.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `making`, `ready`, `failed`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/images/{id}` | [Get a image](#get-a-image) |
| `GET` | `/v2/images` | [List images](#list-images) |
| `POST` | `/v2/images/context:missing` | [missing](#missing) |
| `PUT` | `/v2/images/context/{digest}` | [put](#put) |
| `DELETE` | `/v2/images/{id}` | [Delete a image](#delete-a-image) |
| `POST` | `/v2/images` | [Create a image](#create-a-image) |
| `GET` | `/v2/images/{id}/logs` | [logs](#logs) |

## Get a image

`GET /v2/images/{id}`

Returns an image, by its ID, its name (its newest version) or one of its tags (`name:tag`).

Its action, for a key's grant: `images:get`.

Path: `id`.

Returns a [Stored](#stored).

In v1: `GET /v1/images/{id}`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/images/IMAGE_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.images.get("IMAGE_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.images.get("IMAGE_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.images.get("IMAGE_ID")
```

```bash title="CLI"
runtime images get IMAGE_ID
```

## List images

`GET /v2/images`

Lists the project's images, newest first.

Its action, for a key's grant: `images:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | No | Only those of this name. |
| `state` | string | No | Only those in these states, comma-separated. |
| `label` | list of string | No | Only those with every label given (repeat it for several): key:value, or a key for any value. |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Stored](#stored), and `next`, where the next page starts, none on the last.

In v1: `GET /v1/images`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/images" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.images.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.images.list()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.images.list
```

```bash title="CLI"
runtime images list
```

## `missing`

`POST /v2/images/context:missing`

Returns which chunks of a build context still need uploading. The chunks it holds count as used, so they are kept for the build that names them: a chunk is kept 24 hours after its last use, and an organization's build context holds at most 200 MiB.

Its action, for a key's grant: `images:write`.

Body: a [ContextAsked](#contextasked).

Returns a [ContextMissing](#contextmissing).

In v1: `POST /v1/images/context/missing`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/images/context:missing" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "digests": ["example"] }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.images.missing({ digests: ["example"] });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.images.missing(digests=["example"])
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.images.missing(digests: ["example"])
```

```bash title="CLI"
runtime images missing --digests example
```

## `put`

`PUT /v2/images/context/{digest}`

Uploads one chunk of a build context: the request's bytes, 1 byte to 1 MiB, named by their SHA-256. Asked again, it stores nothing more.

Its action, for a key's grant: `images:write`.

Path: `digest`.

Body: the bytes, `application/octet-stream`.

Returns a [ChunkStored](#chunkstored).

In v1: `PUT /v1/images/context/{digest}`.

Examples:

```bash title="curl"
curl -X PUT "https://api.withruntime.com/v2/images/context/DIGEST_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary 'hello'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.images.put("DIGEST_ID", new TextEncoder().encode("hello\n"));
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.images.put("DIGEST_ID", b"hello\n")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.images.put("DIGEST_ID", "hello\n")
```

```bash title="CLI"
runtime images put DIGEST_ID < hello.txt
```

## Delete a image

`DELETE /v2/images/{id}`

Deletes an image version. Sandboxes already started from it keep running. One an App boots from is refused with image_in_use (409) naming the App.

Its action, for a key's grant: `images:delete`.

Path: `id`.

Returns a [Stored](#stored).

In v1: `POST /v1/images/{id}:delete`.

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/images/IMAGE_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.images.delete("IMAGE_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.images.delete("IMAGE_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.images.delete("IMAGE_ID")
```

```bash title="CLI"
runtime images delete IMAGE_ID
```

## Create a image

`POST /v2/images`

Builds an image from an OCI image or a Dockerfile on a machine of its own, and returns it at once, `making`: `ready` once built, else `failed` with `error`. Each build of a name is its next version. Asked again with the same Idempotency-Key, it returns the same one.

Its action, for a key's grant: `images:create`.

Body: a [ImageCreate](#imagecreate).

Returns a [Stored](#stored).

In v1: `POST /v1/images`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/images" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.images.create();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.images.create()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.images.create
```

```bash title="CLI"
runtime images create
```

## `logs`

`GET /v2/images/{id}/logs`

Returns an image's build log after a line, as the build writes it and once it has ended.

Its action, for a key's grant: `images:read`.

Path: `id`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `after` | integer | No | Lines after this one. At least 0. Default: 0. |
| `limit` | integer | No | At most this many lines. At least 1. At most 1000. Default: 1000. |
| `follow` | boolean | No | Answer as NDJSON events until the build ends: `line` for each, then `done` with the image, or `continue` with the `after` to follow on from; as `Accept: application/x-ndjson` does. |

Returns a [ImageLogs](#imagelogs).

In v1: `GET /v1/images/{id}/logs`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/images/IMAGE_ID/logs" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.images.logs("IMAGE_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.images.logs("IMAGE_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.images.logs("IMAGE_ID")
```

```bash title="CLI"
runtime images logs IMAGE_ID
```

## Objects

### Stored

Stored data: a snapshot, an image or a volume.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `snapshot`, `image`, `volume` | Yes | Its kind: `snapshot`, `image` or `volume`. |
| `name` | string | No | Its name, unique in its project among its kind. |
| `state` | one of `making`, `ready`, `failed`, `deleted` | Yes | Where it is. |
| `labels` | labels (keys under `runtime.` are Runtime's) | Yes | Its labels. |
| `sizeBytes` | integer | Yes | What it was made to hold, in bytes. |
| `storedBytes` | integer | Yes | What it holds now, in bytes. |
| `parentId` | string | No | What it was made from (a snapshot's sandbox, an image's base), if anything. |
| `attachedTo` | string | No | The machine it is attached to now, if any. |
| `createdAt` | string (RFC 3339) | No | When it was made. |
| `version` | integer | No | An image's version of its name: each build or keep of a name is its next. |
| `tags` | list of string | No | An image's tags, each `name:tag`. |
| `error` | string | No | Why an image's build failed. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |

### ContextAsked

Chunks of a build's context, by their SHA-256.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `digests` | list of string | Yes | At most 10,000 SHA-256 digests, each 64 lowercase hex digits. |

### ContextMissing

Which chunks of a build's context still need uploading.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `missing` | list of string | Yes | The digests asked for that the organization's build context does not hold, sorted, each once. |

### ChunkStored

A chunk of a build's context, uploaded.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sha256` | string | Yes | Its SHA-256. |
| `size` | integer | Yes | Its size in bytes. |
| `stored` | boolean | Yes | Stored by this call: false when the build context held it already. |

### ImageFile

A file of an image build's context, sent inline.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | Its path in the build context, which `COPY` and `ADD` read. |
| `content` | string | Yes | Its content: UTF-8 text, or base64 when `encoding` says so. |
| `encoding` | one of `utf8`, `base64` | No | `utf8` (the default) or `base64`. |
| `mode` | integer | No | Its permission bits, 0 to 511 (0777 in octal). At least 0. At most 511. |

### ImageRecipe

An image described by its packages, files and commands, rendered into a Dockerfile: `FROM` its base, its `env`, one `RUN` each for its apt, pip and npm packages, its files, then its commands in `workdir`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `base` | string | No | The image it starts from: `runtime` (the default, Runtime's own) or an OCI image, such as `python:3.12-slim`. |
| `apt` | list of string | No | Debian packages, each `name` or `name=version`. At most 500 items. |
| `pip` | list of string | No | Python packages, each as pip takes one: `pandas`, `numpy==2.1`, `uvicorn[standard]>=0.30`. At most 500 items. |
| `npm` | list of string | No | npm packages, installed globally: `typescript`, `@scope/tool@1`. At most 500 items. |
| `commands` | list of string | No | Shell commands, each run by `/bin/sh` in `workdir` after the packages and files. At most 500 items. |
| `env` | object of strings | No | Environment set before the packages; `$NAME` names its base's. |
| `files` | list of [ImageFile](#imagefile) | No | Files written into the image, each `path` absolute: at most 1 MiB in all. At most 256 items. |
| `workdir` | string | No | Where its commands run and its machines start: `/workspace` by default. |

### ImageArchive

A build context's archive: a tar (gzip allowed), cut into chunks of at most 1 MiB, each uploaded first (`images.context.put`).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sha256` | string | Yes | The whole archive's SHA-256, in hex. |
| `size` | integer | Yes | Its size in bytes. At least 1. |
| `chunks` | list of string | Yes | Its chunks' SHA-256s, in order. At most 200 items. |

### ImageContextFile

A regular file of a build context's archive.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | Its path in the context. |
| `sha256` | string | Yes | Its SHA-256, in hex. |
| `size` | integer | Yes | Its size in bytes. |
| `mode` | integer | No | Its permission bits. |

### ImageContext

A build context uploaded as chunks: the SDKs and CLI make it from a folder and its `.dockerignore`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `archive` | [ImageArchive](#imagearchive) | Yes | The archive. |
| `files` | list of [ImageContextFile](#imagecontextfile) | Yes | Every regular file in it. |

### MachineStart

A command a machine starts at every fresh boot.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cmd` | string (run by `bash -lc`) or list of strings (the program and its arguments) | Yes | The command: text, run by `bash -lc`, or the program and its arguments as a list, run without a shell. |
| `cwd` | string | No | The directory it runs in; the user's home when omitted. |
| `env` | object of strings | No | Environment variables to add. |
| `readyPort` | integer | No | A port it listens on once ready: a create answers once something listens there. At least 1. At most 65535. |
| `readyCommand` | string | No | A shell command that exits 0 once it is ready, run by `/bin/sh -c` in `cwd` until it does: a create answers once it has. |
| `readyTimeoutSeconds` | integer | No | How long a create waits for `readyPort` or `readyCommand`, 1 to 300 seconds: 60 when omitted. At least 1. At most 300. |

### ImageBuild

What an image's build runs on: a machine of its own, deleted once the build ends.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `vcpu` | integer | No | Its vCPUs. At least 1. At most 8. Default: 2. |
| `memoryGB` | number | No | Its memory in GB. At least 1. At most 16. Default: 4. |
| `diskGB` | number | No | Its disk in GB: the base image, the earlier stages and the context. At least 4. At most 32. Default: 16. |
| `timeoutSeconds` | integer | No | Seconds the build may run before it fails. At least 60. At most 3600. Default: 1800. |

### ImageCreate

An image to build, from exactly one of `image` and `dockerfile`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | No | Its name, 1 to 64 of `a-z`, `0-9`, `.`, `_` and `-`: each build of a name is its next version. |
| `labels` | labels (keys under `runtime.` are Runtime's) | No | Labels to find it by. |
| `tags` | list of string | No | Tags its name takes for it once it is ready; `latest` when it has a name and none is given. At most 16 items. |
| `image` | string | No | An OCI image to use as it is, from a public registry: `python:3.12-slim`, `ghcr.io/org/app:1`. |
| `dockerfile` | string | No | A Dockerfile: multi-stage builds, `ARG`, `COPY --from`, heredocs. `COPY` reads `files`. |
| `recipe` | [ImageRecipe](#imagerecipe) | No | Packages, files and commands, rendered into a Dockerfile. Not with `files` or `context`. |
| `files` | list of [ImageFile](#imagefile) | No | The Dockerfile's build context, inline: at most 1 MiB in all. Not with `context`. At most 256 items. |
| `context` | [ImageContext](#imagecontext) | No | The Dockerfile's build context, uploaded first as chunks: up to 200 MiB. Not with `files`. |
| `dockerignore` | string | No | The context's `.dockerignore`: what it names is never copied. |
| `target` | string | No | The stage to build instead of the last. |
| `buildArgs` | object of strings | No | The Dockerfile's `ARG` values. |
| `env` | object of strings | No | Environment every machine from it starts with, over the Dockerfile's `ENV`. |
| `start` | [MachineStart](#machinestart) | No | What every machine from it starts at each fresh boot, in place of the Dockerfile's `ENTRYPOINT` and `CMD`. |
| `build` | [ImageBuild](#imagebuild) | No | What its build runs on. |

### ImageLogLine

One line of an image's build log.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `seq` | integer | Yes | Its number, from 1. |
| `at` | string (RFC 3339) | Yes | When it was written. |
| `stream` | one of `build`, `system` | Yes | `build` (the build's output) or `system` (Runtime's). |
| `text` | string | Yes | The line, without its newline. |

### ImageLogs

An image's build log after a line.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `lines` | list of [ImageLogLine](#imagelogline) | Yes | The lines after `after`, in order. |
| `nextAfter` | integer | Yes | The last line's number: send it as `after` to read on. |
| `state` | one of `making`, `ready`, `failed`, `deleted` | Yes | The image's state. |
| `truncated` | boolean | Yes | Whether lines before these were dropped. |
| `done` | boolean | Yes | Whether the build has ended: no line comes after these. |
