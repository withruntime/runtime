# AuditLine API reference

The organization's audit log: every write and every refused call, with who asked, from where, and what it committed. On the Scale and Enterprise plans.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: .

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/audit` | [List audit](#list-audit) |

## List audit

`GET /v2/audit`

Lists the organization's audit log, newest first, paginated: each write and each refused call, over the days the plan keeps (365 on Scale). On other plans it returns 403.

Its action, for a key's grant: `audit:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |
| `action` | string | No | Only lines of this action (`keys:create`), or of every action of a product (`keys:`). |

Returns a page: `items`, each a [AuditLine](#auditline), and `next`, where the next page starts, none on the last.

In v1: `GET /v1/audit`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/audit" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.audit.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.audit.list()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.audit.list
```

```bash title="CLI"
runtime audit list
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_audit_list", "arguments": {  } } }
```

## Objects

### AuditLine

One line of the audit log: a call Access judged, allowed or refused.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `audit` | Yes | Always `audit`. |
| `action` | string | Yes | What was asked (`sandboxes:create`, `keys:delete`). |
| `allowed` | boolean | Yes | Whether it was allowed. |
| `reason` | string | No | Why it was refused, or what it changed, when it says. |
| `target` | string | No | What it acted on: a resource's ID, when it names one. |
| `accountId` | string | No | The person who asked, or for whom an agent asked. |
| `agentId` | string | No | The agent or CI pipeline that asked. |
| `keyId` | string | No | The key it was asked with; none for the console. |
| `projectId` | string | No | The project it acted in. |
| `cost` | string (US dollars, decimal) | No | What it committed, in US dollars. |
| `address` | string | No | The client address it came from. |
| `requestId` | string | No | The request's ID. |
| `createdAt` | string (RFC 3339) | Yes | When it was asked. |
