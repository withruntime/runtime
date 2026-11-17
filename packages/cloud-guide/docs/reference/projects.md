# Project API reference

A project: where sandboxes, storage, addresses and keys sit, each in one. Every organization has a default project, where a call that names none acts.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `active`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/projects` | [List projects](#list-projects) |
| `POST` | `/v2/projects` | [Create a project](#create-a-project) |
| `POST` | `/v2/projects/{id}:update` | [update](#update) |
| `DELETE` | `/v2/projects/{id}` | [Delete a project](#delete-a-project) |

## List projects

`GET /v2/projects`

Lists the organization's projects, the default first, then by name.

Its action, for a key's grant: `projects:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Project](#project), and `next`, where the next page starts, none on the last.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/projects" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.projects.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.projects.list()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.projects.list
```

```bash title="CLI"
runtime projects list
```

## Create a project

`POST /v2/projects`

Creates a project. A name another project has returns 409. Asked again with the same Idempotency-Key, it returns the same one.

Its action, for a key's grant: `projects:create`.

Body: a [ProjectCreate](#projectcreate).

Returns a [Project](#project).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/projects" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "example" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.projects.create({ name: "example" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.projects.create(name="example")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.projects.create(name: "example")
```

```bash title="CLI"
runtime projects create --name example
```

## `update`

`POST /v2/projects/{id}:update`

Renames a project; what is in it stays as it is. A name another project has returns 409.

Its action, for a key's grant: `projects:update`.

Path: `id`.

Body: a [Rename](#rename).

Returns a [Project](#project).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/projects/PROJECT_ID:update" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "example" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.projects.update("PROJECT_ID", { name: "example" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.projects.update("PROJECT_ID", name="example")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.projects.update("PROJECT_ID", name: "example")
```

```bash title="CLI"
runtime projects update PROJECT_ID --name example
```

## Delete a project

`DELETE /v2/projects/{id}`

Deletes a project and frees its name, with the grants, keys and invitations held to it. The caller needs `grants:delete` as well, as the grants go with it. The default project, or one that still holds a sandbox, storage or an address, returns 409. Deleted again, it returns 404.

Its action, for a key's grant: `projects:delete`.

Path: `id`.

Returns a [Project](#project).

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/projects/PROJECT_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.projects.delete("PROJECT_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.projects.delete("PROJECT_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.projects.delete("PROJECT_ID")
```

```bash title="CLI"
runtime projects delete PROJECT_ID
```

## Objects

### Project

A project: where sandboxes, storage, addresses and keys sit.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `project` | Yes | Always `project`. |
| `name` | string | Yes | Its name, unique in the organization. |
| `default` | boolean | Yes | Whether it is the organization's default project, where a call that names none acts. |
| `createdAt` | string (RFC 3339) | Yes | When it was made. |
| `state` | one of `active`, `deleted` | Yes | `active`; `deleted` once deleted: a delete's answer. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |

### ProjectCreate

A new project.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Its name, unique in the organization. At least 1 character. At most 64 characters. |

### Rename

A new name; everything else stays as it is.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Its name. At least 1 character. At most 64 characters. |
