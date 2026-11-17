# Identity API reference

An agent or CI pipeline: who a key acts as besides a person, holding grants of its own.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `active`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/identities` | [List identities](#list-identities) |
| `POST` | `/v2/identities/{id}:update` | [update](#update) |
| `DELETE` | `/v2/identities/{id}` | [Delete a identity](#delete-a-identity) |

## List identities

`GET /v2/identities`

Lists the organization's agents and CI pipelines, by name.

Its action, for a key's grant: `identities:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Identity](#identity), and `next`, where the next page starts, none on the last.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/identities" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.identities.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.identities.list()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.identities.list
```

```bash title="CLI"
runtime identities list
```

## `update`

`POST /v2/identities/{id}:update`

Renames an agent or CI pipeline; its keys and grants stay as they are. A name another of its kind has returns 409.

Its action, for a key's grant: `identities:update`.

Path: `id`.

Body: a [Rename](#rename).

Returns a [Identity](#identity).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/identities/IDENTITY_ID:update" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "example" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.identities.update("IDENTITY_ID", { name: "example" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.identities.update("IDENTITY_ID", name="example")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.identities.update("IDENTITY_ID", name: "example")
```

```bash title="CLI"
runtime identities update IDENTITY_ID --name example
```

## Delete a identity

`DELETE /v2/identities/{id}`

Deletes an agent or CI pipeline and frees its name, with its grants and keys: refused from their next call. The caller needs `grants:delete` as well, as the grants go with it. What it made stays. Deleted again, it returns 404.

Its action, for a key's grant: `identities:delete`.

Path: `id`.

Returns a [Identity](#identity).

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/identities/IDENTITY_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.identities.delete("IDENTITY_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.identities.delete("IDENTITY_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.identities.delete("IDENTITY_ID")
```

```bash title="CLI"
runtime identities delete IDENTITY_ID
```

## Objects

### Identity

An agent or CI pipeline: who a key acts as, besides a person.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID, a key's `agentId`. |
| `object` | one of `identity` | Yes | Always `identity`. |
| `kind` | one of `agent`, `ci` | Yes | `agent` or `ci`. |
| `name` | string | Yes | Its name, unique in the organization for its kind. |
| `createdAt` | string (RFC 3339) | Yes | When it was made. |
| `state` | one of `active`, `deleted` | Yes | `active`; `deleted` once deleted: a delete's answer. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |

### Rename

A new name; everything else stays as it is.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Its name. At least 1 character. At most 64 characters. |
