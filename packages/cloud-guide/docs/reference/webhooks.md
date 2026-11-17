# Webhook API reference

A signed POST to your URL for each event it names.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `active`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v2/webhooks` | [Create a webhook](#create-a-webhook) |
| `GET` | `/v2/webhooks` | [List webhooks](#list-webhooks) |
| `DELETE` | `/v2/webhooks/{id}` | [Delete a webhook](#delete-a-webhook) |

## Create a webhook

`POST /v2/webhooks`

Makes a webhook, returning its signing secret this once.

Its action, for a key's grant: `webhooks:create`.

Body: a [WebhookCreate](#webhookcreate).

Returns a [Webhook](#webhook).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/webhooks" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "example" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.webhooks.create({ url: "example" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.webhooks.create(url="example")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.webhooks.create(url: "example")
```

```bash title="CLI"
runtime webhooks create --url example
```

## List webhooks

`GET /v2/webhooks`

Lists the org's, oldest first.

Its action, for a key's grant: `webhooks:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Webhook](#webhook), and `next`, where the next page starts, none on the last.

In v1: `GET /v1/webhooks`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/webhooks" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.webhooks.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.webhooks.list()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.webhooks.list
```

```bash title="CLI"
runtime webhooks list
```

## Delete a webhook

`DELETE /v2/webhooks/{id}`

Deletes it: nothing more is sent to it.

Its action, for a key's grant: `webhooks:delete`.

Path: `id`.

Returns a [Webhook](#webhook).

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/webhooks/WEBHOOK_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.webhooks.delete("WEBHOOK_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.webhooks.delete("WEBHOOK_ID")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.webhooks.delete("WEBHOOK_ID")
```

```bash title="CLI"
runtime webhooks delete WEBHOOK_ID
```

## Objects

### WebhookCreate

A webhook to make.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | Yes | The https URL to send each event to. |
| `events` | list of string | No | The events to send it, at most 32; `["*"]` (every one) when omitted. |

### Webhook

A webhook: a signed POST to your URL for each event it names.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `webhook` | Yes | Always `webhook`. |
| `url` | string | Yes | The https URL each event is sent to; in a list, its origin alone (`https://host/…`). |
| `events` | list of string | Yes | The events it is sent (`sandbox.created`); `*` for every one. |
| `state` | one of `active`, `deleted` | Yes | `active` while it is sent to; `deleted` once deleted: a delete's answer. |
| `createdAt` | string (RFC 3339) | Yes | When it was made. |
| `secret` | string | No | Its signing secret (`whsec_...`): returned when it is made, and never again. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |
