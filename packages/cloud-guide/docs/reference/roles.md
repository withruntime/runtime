# Role API reference

One of the organization's own roles: the actions a grant of it allows. The built-in roles (owner, admin, developer, viewer, billing) are not listed here.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `active`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/roles` | [List roles](#list-roles) |
| `POST` | `/v2/roles/{id}:actions` | [actions](#actions) |
| `POST` | `/v2/roles/{id}:update` | [update](#update) |
| `DELETE` | `/v2/roles/{id}` | [Delete a role](#delete-a-role) |

## List roles

`GET /v2/roles`

Lists the organization's own roles, by name.

Its action, for a key's grant: `roles:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Role](#role), and `next`, where the next page starts, none on the last.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/roles" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.roles.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.roles.list()
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.roles.list
```

```bash title="CLI"
runtime roles list
```

## `actions`

`POST /v2/roles/{id}:actions`

Adds actions to a role and removes actions from it, in place, and returns the role. Every key and grant that gives the role has the new actions from its next call; no key's secret changes. Only an owner or an admin may change a role's actions, and only to add actions the caller may perform itself across the whole organization: any other caller or action returns 403. An action no call has returns 400. A role Runtime manages (its name starts with `runtime.`) returns 409, as does a removal from a role that a deny grant gives (a deny is lifted only by deleting that grant; an addition is allowed), a removal that would leave the role with no actions, or one that removes an action the role still holds through a wildcard such as `images:*`. Adding an action the role already holds, or removing one it does not hold, changes nothing, so the call is safe to retry. Each change is one audit log entry, `roles:actions`, whose reason lists the actions added and removed.

Its action, for a key's grant: `roles:update`.

Path: `id`.

Body: a [RoleActionsChange](#roleactionschange).

Returns a [Role](#role).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/roles/ROLE_ID:actions" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.roles.actions("ROLE_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.roles.actions("ROLE_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.roles.actions("ROLE_ID")
```

```bash title="CLI"
runtime roles actions ROLE_ID
```

## `update`

`POST /v2/roles/{id}:update`

Renames a role; its actions and its grants stay as they are. A built-in role's name, or another role's, returns 409.

Its action, for a key's grant: `roles:update`.

Path: `id`.

Body: a [Rename](#rename).

Returns a [Role](#role).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/roles/ROLE_ID:update" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "example" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.roles.update("ROLE_ID", { name: "example" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.roles.update("ROLE_ID", name="example")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.roles.update("ROLE_ID", name: "example")
```

```bash title="CLI"
runtime roles update ROLE_ID --name example
```

## Delete a role

`DELETE /v2/roles/{id}`

Deletes a role and frees its name, with the grants and invitations that give it. The caller needs `grants:delete` as well, as the grants go with it. A role that a deny grant gives returns 409: a deny is lifted only by deleting that grant. Deleted again, it returns 404.

Its action, for a key's grant: `roles:delete`.

Path: `id`.

Returns a [Role](#role).

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/roles/ROLE_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.roles.delete("ROLE_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.roles.delete("ROLE_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.roles.delete("ROLE_ID")
```

```bash title="CLI"
runtime roles delete ROLE_ID
```

## Objects

### Role

One of the organization's own roles: the actions a grant of it allows.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `role` | Yes | Always `role`. |
| `name` | string | Yes | Its name, unique in the organization. |
| `actions` | list of string | Yes | The actions it holds, each `product:action`, `product:*` or `*`. |
| `createdAt` | string (RFC 3339) | Yes | When it was made. |
| `state` | one of `active`, `deleted` | Yes | `active`; `deleted` once deleted: a delete's answer. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |

### RoleActionsChange

A change to a role's actions: the actions to add and the actions to remove, in one step. Each is `product:action`, `product:*` or `*`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `add` | list of string | No | The actions to add. One the role already holds as written is left as it is. At most 100 items. |
| `remove` | list of string | No | The actions to remove, each as the role holds it. One the role does not hold is ignored. At most 100 items. |

### Rename

A new name; everything else stays as it is.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Its name. At least 1 character. At most 64 characters. |
