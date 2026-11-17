# Snapshot API reference

A sandbox's memory and disk as they were, kept to start new sandboxes from.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `making`, `ready`, `failed`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/snapshots` | [List snapshots](#list-snapshots) |
| `GET` | `/v2/snapshots/{id}` | [Get a snapshot](#get-a-snapshot) |
| `DELETE` | `/v2/snapshots/{id}` | [Delete a snapshot](#delete-a-snapshot) |

## List snapshots

`GET /v2/snapshots`

Lists the project's snapshots, newest first.

Its action, for a key's grant: `snapshots:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | No | Only those of this name. |
| `state` | string | No | Only those in these states, comma-separated. |
| `label` | list of string | No | Only those with every label given (repeat it for several): key:value, or a key for any value. |
| `sandbox` | string | No | Only those taken of this sandbox (or other machine), by its ID; a deleted one's snapshots too. |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Stored](#stored), and `next`, where the next page starts, none on the last.

In v1: `GET /v1/snapshots`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/snapshots" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.snapshots.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.snapshots.list()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.snapshots.list
```

```bash title="CLI"
runtime snapshots list
```

## Get a snapshot

`GET /v2/snapshots/{id}`

Returns a snapshot.

Its action, for a key's grant: `snapshots:get`.

Path: `id`.

Returns a [Stored](#stored).

In v1: `GET /v1/snapshots/{id}`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/snapshots/SNAPSHOT_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.snapshots.get("SNAPSHOT_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.snapshots.get("SNAPSHOT_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.snapshots.get("SNAPSHOT_ID")
```

```bash title="CLI"
runtime snapshots get SNAPSHOT_ID
```

## Delete a snapshot

`DELETE /v2/snapshots/{id}`

Deletes a snapshot, its memory and its disk.

Its action, for a key's grant: `snapshots:delete`.

Path: `id`.

Returns a [Stored](#stored).

In v1: `POST /v1/snapshots/{id}:delete`.

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/snapshots/SNAPSHOT_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.snapshots.delete("SNAPSHOT_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.snapshots.delete("SNAPSHOT_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.snapshots.delete("SNAPSHOT_ID")
```

```bash title="CLI"
runtime snapshots delete SNAPSHOT_ID
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
