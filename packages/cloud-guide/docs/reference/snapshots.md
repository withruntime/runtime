# Snapshot API reference

A machine's memory and disk as they were, kept to start new machines from.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `making`, `ready`, `failed`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/snapshots` | [List snapshots](#list-snapshots) |
| `GET` | `/v2/snapshots/{id}` | [Get a snapshot](#get-a-snapshot) |
| `DELETE` | `/v2/snapshots/{id}` | [Delete a snapshot](#delete-a-snapshot) |
| `POST` | `/v2/snapshots/{id}:update` | [update](#update) |

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
| `sandbox` | string | No | Only those taken of this machine, by its ID; a deleted one's snapshots too. |
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

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.snapshots.list
```

```bash title="CLI"
runtime snapshots list
```

## Get a snapshot

`GET /v2/snapshots/{id}`

Returns a snapshot.

Its action, for a key's grant: `snapshots:get`.

Path: `id`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `wait` | number | No | Seconds to wait, at most 60, for its state to differ from `ifState`; it answers once it does, or as it is when the wait ends. At least 0. At most 60. |
| `ifState` | string | No | The state the caller last read, which `wait` waits for it to leave. |

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

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.snapshots.get("SNAPSHOT_ID")
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

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.snapshots.delete("SNAPSHOT_ID")
```

```bash title="CLI"
runtime snapshots delete SNAPSHOT_ID
```

## `update`

`POST /v2/snapshots/{id}:update`

Changes its lifetime (`deleteAfterSeconds`) or delete protection (`deleteProtection`). A lifetime sent again before its end moves the end to that many seconds from now; 0 takes it off. At its end Runtime deletes it as its delete does: final, and it can't be undone. A lifetime and protection are never set together (409 `delete_protected`). Each field left out stays as it is.

Its action, for a key's grant: `snapshots:update`.

Path: `id`.

Body: a [StoredUpdate](#storedupdate).

Returns a [Stored](#stored).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/snapshots/SNAPSHOT_ID:update" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.snapshots.update("SNAPSHOT_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.snapshots.update("SNAPSHOT_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.snapshots.update("SNAPSHOT_ID")
```

```bash title="CLI"
runtime snapshots update SNAPSHOT_ID
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
| `parentId` | string | No | What it was made from (a snapshot's machine, an image's base), if anything. |
| `attachedTo` | string | No | The machine it is attached to now, if any. |
| `createdAt` | string (RFC 3339) | No | When it was made. |
| `version` | integer | No | An image's version of its name: each build or keep of a name is its next. |
| `tags` | list of string | No | An image's tags, each `name:tag`. |
| `error` | string | No | Why an image's build failed. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |
| `deleteAt` | string (RFC 3339) | No | When Runtime deletes it (`deleteAfterSeconds`), finally: it can't be undone, as its delete can't; none: kept until deleted. |
| `deleteWaitsFor` | string | No | Once `deleteAt` has passed, what its delete waits for: the App that boots this image, or the machine this volume is attached to, by its ID. It is deleted as soon as that one no longer does. |
| `deleteProtection` | boolean | No | Whether its delete is refused (409 `delete_protected`) until an update turns this off. |

### StoredUpdate

A change to a snapshot, an image version or a volume: each field left out stays as it is.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `deleteAfterSeconds` | integer | No | Seconds from now until Runtime deletes it, as its delete does: final, and it can't be undone. Sent again before then, it renews it; 0 takes its end off (kept until deleted). At least 0. At most 315360000. |
| `deleteProtection` | boolean | No | true refuses its delete (409 `delete_protected`) until an update sends false. Not while it has a `deleteAt`, unless the same update sends `deleteAfterSeconds` 0. |
