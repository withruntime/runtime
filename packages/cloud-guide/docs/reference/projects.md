# Project API reference

A project: where machines, storage, addresses and keys sit, each in one. Every organization has a default project, where a call that names none acts.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `active`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/projects` | [List projects](#list-projects) |
| `POST` | `/v2/projects` | [Create a project](#create-a-project) |
| `POST` | `/v2/projects/{id}:limits` | [limits](#limits) |
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

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.projects.list
```

```bash title="CLI"
runtime projects list
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_projects_list", "arguments": {  } } }
```

## Create a project

`POST /v2/projects`

Creates a project, with its own limits when given. A name another project has returns 409; a limit above its organization's returns 400 `limit_above_org`. Asked again with the same Idempotency-Key, it returns the same one.

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

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.projects.create(name: "example")
```

```bash title="CLI"
runtime projects create --name example
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_projects_create", "arguments": { "name": "example" } } }
```

## `limits`

`POST /v2/projects/{id}:limits`

Sets a project's own limits: each of its organization's plan limits set lower for it alone, by the price card's names. The whole set: a limit left out is its organization's again. One above its organization's returns 400 `limit_above_org`, naming the limit and both figures. Each start in the project is held to its limits and its organization's.

Its action, for a key's grant: `projects:update`.

Path: `id`.

Body: a [ProjectLimitsSet](#projectlimitsset).

Returns a [Project](#project).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/projects/PROJECT_ID:limits" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "limits": {  } }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.projects.limits("PROJECT_ID", { limits: {  } });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.projects.limits("PROJECT_ID", limits={})
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.projects.limits("PROJECT_ID", limits: {  })
```

```bash title="CLI"
runtime projects limits PROJECT_ID --limits '{  }'
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_projects_limits", "arguments": { "id": "PROJECT_ID", "limits": {  } } } }
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

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.projects.update("PROJECT_ID", name: "example")
```

```bash title="CLI"
runtime projects update PROJECT_ID --name example
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_projects_update", "arguments": { "id": "PROJECT_ID", "name": "example" } } }
```

## Delete a project

`DELETE /v2/projects/{id}`

Deletes a project and frees its name, with the grants, keys and invitations held to it. The caller needs `grants:delete` as well, as the grants go with it. The default project, or one that still holds a machine, storage or an address, returns 409. Deleted again, it returns 404.

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

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.projects.delete("PROJECT_ID")
```

```bash title="CLI"
runtime projects delete PROJECT_ID
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_projects_delete", "arguments": { "id": "PROJECT_ID" } } }
```

## Objects

### ProjectLimits

A project's own limits: each of its organization's plan limits set lower for it alone, never higher, by the price card's names and in its units. A start in it is held to both. One not set is its organization's.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `runningVcpu` | integer | No | The most vCPUs its machines run at once. At least 0. |
| `runningMemoryGib` | integer | No | The most memory its machines hold at once, in GiB. At least 0. |
| `machineVcpu` | integer | No | The most vCPUs one of its machines has. At least 0. |
| `machineMemoryGib` | integer | No | The most memory one of its machines has, in GiB. At least 0. |
| `newMachinesPerSecond` | integer | No | The most machines it starts a second. At least 0. |

### Project

A project: where machines, storage, addresses and keys sit.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `project` | Yes | Always `project`. |
| `name` | string | Yes | Its name, unique in the organization. |
| `default` | boolean | Yes | Whether it is the organization's default project, where a call that names none acts. |
| `createdAt` | string (RFC 3339) | Yes | When it was made. |
| `state` | one of `active`, `deleted` | Yes | `active`; `deleted` once deleted: a delete's answer. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |
| `limits` | [ProjectLimits](#projectlimits) | Yes | Its own limits: those of its organization's plan limits set lower for it. One not set is its organization's. |

### ProjectCreate

A new project.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Its name, unique in the organization. At least 1 character. At most 64 characters. |
| `limits` | [ProjectLimits](#projectlimits) | No | Its own limits ([`ProjectLimits`]); none, its organization's. |

### ProjectLimitsSet

A project's own limits, set.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `limits` | [ProjectLimits](#projectlimits) | Yes | Its limits, the whole set: each one given is set, each one left out is its organization's again. |

### Rename

A new name; everything else stays as it is.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Its name. At least 1 character. At most 64 characters. |
