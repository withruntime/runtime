# Port API reference

A public TCP port carried to a port of a machine: a database, a game server, anything that is not HTTP.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `making`, `ready`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v2/ports` | [Create a port](#create-a-port) |
| `GET` | `/v2/ports` | [List ports](#list-ports) |
| `DELETE` | `/v2/ports/{id}` | [Delete a port](#delete-a-port) |

## Create a port

`POST /v2/ports`

Opens a public TCP port to a port of a machine: raw TCP, carried as it is. The public port is assigned from a pool of 10,000; returns 409 when every one is in use. Asked again for the same machine and port, it returns the same public port.

Its action, for a key's grant: `ports:create`.

Body: a [PortCreate](#portcreate).

Returns a [Port](#port).

In v1: `POST /v1/ports`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/ports" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "sandboxId": "SANDBOX_ID", "port": 3000 }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.ports.create({ sandboxId: "SANDBOX_ID", port: 3000 });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.ports.create(sandbox_id="SANDBOX_ID", port=3000)
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.ports.create(sandbox_id: "SANDBOX_ID", port: 3000)
```

```bash title="CLI"
runtime ports create --sandbox-id SANDBOX_ID --port 3000
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_ports_create", "arguments": { "sandboxId": "SANDBOX_ID", "port": 3000 } } }
```

## List ports

`GET /v2/ports`

Lists the org's public TCP ports, or one machine's, by `connect`.

Its action, for a key's grant: `ports:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sandboxId` | string | No | Only this machine's ports. |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Port](#port), and `next`, where the next page starts, none on the last.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/ports" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.ports.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.ports.list()
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.ports.list
```

```bash title="CLI"
runtime ports list
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_ports_list", "arguments": {  } } }
```

## Delete a port

`DELETE /v2/ports/{id}`

Closes a public TCP port and the connections through it.

Its action, for a key's grant: `ports:delete`.

Path: `id`.

Returns a [Port](#port).

In v1: `DELETE /v1/ports/{id}`.

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/ports/PORT_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.ports.delete("PORT_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.ports.delete("PORT_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.ports.delete("PORT_ID")
```

```bash title="CLI"
runtime ports delete PORT_ID
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_ports_delete", "arguments": { "id": "PORT_ID" } } }
```

## Objects

### PortCreate

A public TCP port to open.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sandboxId` | string | Yes | The machine to carry to. |
| `port` | integer | Yes | The port inside the machine, 1 to 65535. |

### PortSettings

A public TCP port's settings, as it keeps them.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `port` | integer | Yes | The port inside the machine. At least 1. At most 65535. |

### Port

A public TCP port: raw TCP from a public address and port to a port of a machine.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `port` | integer | Yes | The port inside the machine. At least 1. At most 65535. |
| `id` | string | Yes | Its ID. |
| `object` | one of `port` | Yes | Always `port`. |
| `connect` | string | Yes | `address:publicPort` (`[address]:publicPort` for IPv6), for a client's host and port. |
| `address` | string | Yes | The public address to connect to. |
| `publicPort` | integer | Yes | The public port to connect to. |
| `sandboxId` | string | Yes | The machine it carries to. |
| `state` | one of `making`, `ready`, `deleted` | Yes | Its state: `ready` once every edge carries it. |
| `disabled` | boolean | Yes | Turned off by Runtime: no connection passes. |
| `createdAt` | string (RFC 3339) | Yes | When it was opened. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |
