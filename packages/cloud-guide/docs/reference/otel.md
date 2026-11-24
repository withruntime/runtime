# Export API reference

The org's events as OpenTelemetry logs, sent to your OTLP/HTTP endpoint.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `active`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v2/otel` | [Create a export](#create-a-export) |
| `GET` | `/v2/otel` | [List otel](#list-otel) |
| `DELETE` | `/v2/otel/{id}` | [Delete a export](#delete-a-export) |

## Create a export

`POST /v2/otel`

Makes an OpenTelemetry export.

Its action, for a key's grant: `otel:create`.

Body: a [ExportCreate](#exportcreate).

Returns a [Export](#export).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/otel" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "endpoint": "example" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.otel.create({ endpoint: "example" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.otel.create(endpoint="example")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.otel.create(endpoint: "example")
```

```bash title="CLI"
runtime otel create --endpoint example
```

## List otel

`GET /v2/otel`

Lists the org's, oldest first.

Its action, for a key's grant: `otel:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Export](#export), and `next`, where the next page starts, none on the last.

In v1: `GET /v1/otel-exports`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/otel" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.otel.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.otel.list()
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.otel.list
```

```bash title="CLI"
runtime otel list
```

## Delete a export

`DELETE /v2/otel/{id}`

Deletes it: nothing more is sent to it.

Its action, for a key's grant: `otel:delete`.

Path: `id`.

Returns a [Export](#export).

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/otel/EXPORT_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.otel.delete("EXPORT_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.otel.delete("EXPORT_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.otel.delete("EXPORT_ID")
```

```bash title="CLI"
runtime otel delete EXPORT_ID
```

## Objects

### ExportCreate

An OpenTelemetry export to make.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `endpoint` | string | Yes | The OTLP/HTTP endpoint's base URL (https). |
| `headers` | object of strings | No | Headers sent with each request (an API key), at most 16. |
| `events` | list of string | No | The events to send it; `["*"]` (every one) when omitted. |

### Export

An OpenTelemetry export: the events as OTLP logs, POSTed to `<endpoint>/v1/logs`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `otel` | Yes | Always `otel`. |
| `endpoint` | string | Yes | The OTLP/HTTP endpoint's base URL (https); in a list, its origin alone. |
| `headerNames` | list of string | Yes | The names of the headers sent with each request; their values are never shown. |
| `events` | list of string | Yes | The events it is sent; `*` for every one. |
| `state` | one of `active`, `deleted` | Yes | `active` while it is sent to; `deleted` once deleted: a delete's answer. |
| `createdAt` | string (RFC 3339) | Yes | When it was made. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |
