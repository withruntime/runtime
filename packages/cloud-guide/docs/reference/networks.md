# Network API reference

A private network: its machines reach each other by name, over TCP.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `making`, `ready`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/networks` | [List networks](#list-networks) |

## List networks

`GET /v2/networks`

Lists the org's private networks, by name.

Its action, for a key's grant: `networks:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Network](#network), and `next`, where the next page starts, none on the last.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/networks" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.networks.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.networks.list()
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.networks.list
```

```bash title="CLI"
runtime networks list
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_networks_list", "arguments": {  } } }
```

## Objects

### NetworkSettings

A private network's settings, as it keeps them.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `members` | list of string | No | The machines in it, by ID; none for every machine of the org. |

### Network

A private network: its members reach each other at `<id>.sandbox.internal`, over TCP.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `members` | list of string | No | The machines in it, by ID; none for every machine of the org. |
| `id` | string | Yes | Its ID. |
| `object` | one of `network` | Yes | Always `network`. |
| `name` | string | Yes | Its name. |
| `state` | one of `making`, `ready`, `deleted` | Yes | Its state: `ready` once every member's host serves it. |
| `createdAt` | string (RFC 3339) | Yes | When it was made. |
