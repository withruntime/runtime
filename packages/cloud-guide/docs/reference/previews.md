# Preview API reference

A port of a sandbox at a public HTTPS address: private with a signed token, or public.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `making`, `ready`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v2/sandboxes/{id}/previews` | [Create a preview](#create-a-preview) |
| `GET` | `/v2/previews` | [List previews](#list-previews) |
| `GET` | `/v2/previews/{name}` | [Get a preview](#get-a-preview) |
| `POST` | `/v2/previews/{name}:sign` | [sign](#sign) |
| `POST` | `/v2/previews/{name}:rotate` | [rotate](#rotate) |
| `DELETE` | `/v2/previews/{name}` | [Delete a preview](#delete-a-preview) |

## Create a preview

`POST /v2/sandboxes/{id}/previews`

Shares a port of a sandbox at an HTTPS address and returns its url and, for a private one, a token; or changes its visibility and sites when it is shared. Asked again, the same preview.

Its action, for a key's grant: `previews:create`.

Path: `id`.

Body: a [PreviewCreate](#previewcreate).

Returns a [Preview](#preview).

In v1: `POST /v1/sandboxes/{id}/previews`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/sandboxes/PREVIEW_ID/previews" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "port": 3000 }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.previews.create("PREVIEW_ID", { port: 3000 });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.previews.create("PREVIEW_ID", port=3000)
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.previews.create("PREVIEW_ID", port: 3000)
```

```bash title="CLI"
runtime previews create PREVIEW_ID --port 3000
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_sandboxes_previews_create", "arguments": { "id": "PREVIEW_ID", "port": 3000 } } }
```

## List previews

`GET /v2/previews`

Lists a sandbox's previews, lowest port first.

Its action, for a key's grant: `previews:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sandboxId` | string | Yes | The sandbox whose previews to list. |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Preview](#preview), and `next`, where the next page starts, none on the last.

In v1: `GET /v1/sandboxes/{id}/previews`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/previews?sandboxId=SANDBOX_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.previews.list({ sandboxId: "SANDBOX_ID" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.previews.list(sandbox_id="SANDBOX_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.previews.list(sandbox_id: "SANDBOX_ID")
```

```bash title="CLI"
runtime previews list --sandbox-id SANDBOX_ID
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_sandboxes_previews_list", "arguments": { "sandboxId": "SANDBOX_ID" } } }
```

## Get a preview

`GET /v2/previews/{name}`

Returns a preview; `sign` returns one with a token.

Its action, for a key's grant: `previews:get`.

Path: `name`.

Returns a [Preview](#preview).

In v1: `GET /v1/sandboxes/{id}/previews/{port}`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/previews/example" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.previews.get("example");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.previews.get("example")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.previews.get("example")
```

```bash title="CLI"
runtime previews get example
```

## `sign`

`POST /v2/previews/{name}:sign`

Returns a private preview with a new token; tokens signed before keep their own expiry.

Its action, for a key's grant: `previews:sign`.

Path: `name`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ttlSeconds` | integer | No | The token's lifetime in seconds, from 60 until the calling key's own end (a year at most); a day when omitted, or the key's end when that is sooner. At least 60. At most 31536000. Default: 86400. |

Returns a [Preview](#preview).

In v1: `GET /v1/sandboxes/{id}/previews/{port}`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/previews/example:sign" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.previews.sign("example");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.previews.sign("example")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.previews.sign("example")
```

```bash title="CLI"
runtime previews sign example
```

## `rotate`

`POST /v2/previews/{name}:rotate`

Refuses every token signed for a preview so far, and returns a new one.

Its action, for a key's grant: `previews:create`.

Path: `name`.

Returns a [Preview](#preview).

In v1: `POST /v1/sandboxes/{id}/previews/{port}:rotate`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/previews/example:rotate" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.previews.rotate("example");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.previews.rotate("example")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.previews.rotate("example")
```

```bash title="CLI"
runtime previews rotate example
```

## Delete a preview

`DELETE /v2/previews/{name}`

Stops sharing a port.

Its action, for a key's grant: `previews:delete`.

Path: `name`.

Returns a [Preview](#preview).

In v1: `DELETE /v1/sandboxes/{id}/previews/{port}`.

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/previews/example" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.previews.delete("example");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.previews.delete("example")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.previews.delete("example")
```

```bash title="CLI"
runtime previews delete example
```

## Objects

### PreviewCreate

A preview of the sandbox its path names to create, or its visibility and sites to change.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `port` | integer | Yes | The port inside the sandbox. At least 1. At most 65535. |
| `visibility` | one of `private`, `public` | No | `private` (default): a token is needed. `public`: anyone with the address. |
| `embedOrigins` | list of string | No | The sites that may show it in an iframe; omitted on one that exists, kept as it is; empty for any site. |
| `ttlSeconds` | integer | No | The token's lifetime in seconds, from 60 until the calling key's own end (a year at most); a day when omitted, or the key's end when that is sooner. At least 60. At most 31536000. Default: 86400. |

### Preview

A preview.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `preview` | Yes | Always `preview`. |
| `sandboxId` | string | Yes | The sandbox whose port it shares. |
| `port` | integer | Yes | The port inside the sandbox. |
| `visibility` | one of `private`, `public` | Yes | `private` or `public`. |
| `url` | string | Yes | Its address. A private one also needs the token. |
| `state` | one of `making`, `ready`, `deleted` | Yes | Where it is: `ready` once every serving host routes it. |
| `token` | string | No | A token signed for this answer, for a private preview and a key that may create one: send it in the `x-runtime-preview-token` header, or open the url with `?runtime_preview_token=<token>` in a browser. |
| `tokenExpiresAt` | string (RFC 3339) | No | When this answer's token stops working. |
| `embedOrigins` | list of string | No | The sites that may show it in an iframe; none for any site. |
| `createdAt` | string (RFC 3339) | Yes | When it was created. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |
