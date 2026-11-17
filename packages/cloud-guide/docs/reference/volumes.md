# Volume API reference

A disk that outlives the machines it is attached to.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `making`, `ready`, `failed`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v2/volumes` | [Create a volume](#create-a-volume) |
| `GET` | `/v2/volumes` | [List volumes](#list-volumes) |
| `GET` | `/v2/volumes/{id}` | [Get a volume](#get-a-volume) |
| `DELETE` | `/v2/volumes/{id}` | [Delete a volume](#delete-a-volume) |

## Create a volume

`POST /v2/volumes`

Creates an empty volume. Asked again with the same Idempotency-Key, it returns the same one.

Its action, for a key's grant: `volumes:create`.

Body: a [VolumeCreate](#volumecreate).

Returns a [Stored](#stored).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/volumes" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "sizeMiB": 1 }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.volumes.create({ sizeMiB: 1 });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.volumes.create(size_mib=1)
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.volumes.create(size_mib: 1)
```

```bash title="CLI"
runtime volumes create --size-mib 1
```

## List volumes

`GET /v2/volumes`

Lists the project's volumes, newest first.

Its action, for a key's grant: `volumes:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | No | Only those of this name. |
| `state` | string | No | Only those in these states, comma-separated. |
| `label` | list of string | No | Only those with every label given (repeat it for several): key:value, or a key for any value. |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Stored](#stored), and `next`, where the next page starts, none on the last.

In v1: `GET /v1/volumes`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/volumes" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.volumes.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.volumes.list()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.volumes.list
```

```bash title="CLI"
runtime volumes list
```

## Get a volume

`GET /v2/volumes/{id}`

Returns a volume.

Its action, for a key's grant: `volumes:get`.

Path: `id`.

Returns a [Stored](#stored).

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/volumes/VOLUME_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.volumes.get("VOLUME_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.volumes.get("VOLUME_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.volumes.get("VOLUME_ID")
```

```bash title="CLI"
runtime volumes get VOLUME_ID
```

## Delete a volume

`DELETE /v2/volumes/{id}`

Deletes a volume and what it holds. One attached to a sandbox is refused: delete the sandbox first.

Its action, for a key's grant: `volumes:delete`.

Path: `id`.

Returns a [Stored](#stored).

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/volumes/VOLUME_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.volumes.delete("VOLUME_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.volumes.delete("VOLUME_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.volumes.delete("VOLUME_ID")
```

```bash title="CLI"
runtime volumes delete VOLUME_ID
```

## Objects

### VolumeCreate

A volume to create: an empty disk, formatted ext4 at its first mount.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | No | Its name, unique in its project among volumes. |
| `labels` | labels (keys under `runtime.` are Runtime's) | No | Labels to find it by. |
| `sizeMiB` | integer | Yes | Its size in MiB, 64 to 409600 (400 GiB). |

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
