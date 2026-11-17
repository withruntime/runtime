# Event API reference

What changed in the organization, as it changed: each event a webhook or an OpenTelemetry export is sent, kept 14 days.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: .

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/events` | [List events](#list-events) |

## List events

`GET /v2/events`

Lists the organization's lifecycle events of the last 14 days, newest first, paginated: each one a webhook is sent, with the same `id` and `type`.

Its action, for a key's grant: `events:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |
| `type` | string | No | Only events of this type (`sandbox.created`). |
| `resourceId` | string | No | Only the events of this resource, by its ID. |

Returns a page: `items`, each a [Event](#event), and `next`, where the next page starts, none on the last.

In v1: `GET /v1/events`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/events" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.events.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.events.list()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.events.list
```

```bash title="CLI"
runtime events list
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_events_list", "arguments": {  } } }
```

## Objects

### Event

A lifecycle event: what changed, as a webhook is sent it.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID (`evt_...`), the `runtime-webhook-id` of its webhook delivery. |
| `object` | one of `event` | Yes | Always `event`. |
| `type` | string | Yes | What happened (`sandbox.created`, `sandbox.paused`), a webhook's `runtime-event-type`. |
| `resourceId` | string | Yes | The ID of the resource it happened to. |
| `state` | string | No | The resource's state after it, when it says one. |
| `reason` | string | No | Why, when it says why (a stop's or a failure's). |
| `exitCode` | integer | No | The exit code of a run that ended. |
| `createdAt` | string (RFC 3339) | Yes | When it happened. |
