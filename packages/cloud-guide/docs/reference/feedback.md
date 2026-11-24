# Feedback API reference

A report to Runtime's team: a bug, a missing feature, a gap against another provider, a migration blocker, unclear docs, a price, or praise. Every report is read.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: .

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v2/feedback` | [Create a feedback](#create-a-feedback) |

## Create a feedback

`POST /v2/feedback`

Sends a report to Runtime's team. Quote the requestId of an error you hit; never send credentials, private files or user data.

Its action, for a key's grant: `feedback:create`.

Body: a [FeedbackCreate](#feedbackcreate).

Returns a [Feedback](#feedback).

In v1: `POST /v1/feedback`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/feedback" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "kind": "bug", "summary": "example" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.feedback.create({ kind: "bug", summary: "example" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.feedback.create(kind="bug", summary="example")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.feedback.create(kind: "bug", summary: "example")
```

```bash title="CLI"
runtime feedback create --kind bug --summary example
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_feedback_create", "arguments": { "kind": "bug", "summary": "example" } } }
```

## Objects

### FeedbackCreate

A report to send.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | one of `bug`, `missing_feature`, `competitor_gap`, `migration_blocker`, `docs`, `pricing`, `praise`, `other` | Yes | `bug`, `missing_feature`, `competitor_gap` (something another provider does better), `migration_blocker` (what stops a move to Runtime), `docs`, `pricing`, `praise` or `other`. |
| `summary` | string | Yes | One line. At least 1 character. At most 200 characters. |
| `detail` | string | No | What happened, what you expected, how to reproduce. At most 8000 characters. |
| `competitor` | string | No | The other provider, for a gap or a migration (E2B, Daytona, Modal). At most 80 characters. |
| `resourceId` | string | No | The resource it is about. At most 64 characters. |
| `requestId` | string | No | The requestId of the error you are reporting. At most 64 characters. |
| `page` | string | No | The page it is about, for a report from the site. At most 300 characters. |
| `rating` | integer | No | A page's rating: 1 helpful, -1 not. At least -1. At most 1. |
| `contactEmail` | string | No | An address to reply to, for a report from someone not signed in. At most 254 characters. |
| `context` | object of strings | No | Anything else useful, at most 16 entries of text. |

### Feedback

A report as it was received.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `feedback` | Yes | Always `feedback`. |
| `kind` | one of `bug`, `missing_feature`, `competitor_gap`, `migration_blocker`, `docs`, `pricing`, `praise`, `other` | Yes | What it is about. |
| `summary` | string | Yes | Its one line. |
| `createdAt` | string (RFC 3339) | Yes | When it was received. |
