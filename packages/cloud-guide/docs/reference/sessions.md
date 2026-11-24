# Session API reference

A short-lived token a frontend holds to reach one machine directly: it reads the machine, runs its commands and processes, reads and writes its files, and signs its previews' links, and does nothing else. It acts as the key that made it and ends with that key.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `active`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v2/sessions` | [Create a session](#create-a-session) |
| `DELETE` | `/v2/sessions/{id}` | [Delete a session](#delete-a-session) |

## Create a session

`POST /v2/sessions`

Makes a session for one machine the caller reaches and returns its token this once. The token reads the machine, runs its commands and processes, reads and writes its files and signs its previews' links, and nothing else; it acts as the caller, lives `expiresInSeconds` (an hour unless asked, a day at most), never past the caller's key, and ends when that key is revoked. The API answers CORS for its calls, so a web page can make them. Sent again with the same Idempotency-Key and body, it makes none and returns 409 `conflict` with the session it made in `details.made`, without its token; with another body, 409 `idempotency_key_reused`.

Its action, for a key's grant: `sessions:create`.

Body: a [SessionCreate](#sessioncreate).

Returns a [SessionCreated](#sessioncreated).

In v1: `POST /v1/sandboxes/{machineId}/sessions`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/sessions" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "machineId": "example" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.sessions.create({ machineId: "example" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.sessions.create(machine_id="example")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.sessions.create(machine_id: "example")
```

```bash title="CLI"
runtime sessions create --machine-id example
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_sessions_create", "arguments": { "machineId": "example" } } }
```

## Delete a session

`DELETE /v2/sessions/{id}`

Ends a session now: its next call is refused. Its maker ends its own; an owner or an admin, any of the organization's. Ended already, it returns 404.

Its action, for a key's grant: `sessions:delete`.

Path: `id`.

Returns a [Session](#session).

In v1: `POST /v1/sandboxes/{sandbox}/sessions/{id}:revoke`.

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/sessions/SESSION_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.sessions.delete("SESSION_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.sessions.delete("SESSION_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.sessions.delete("SESSION_ID")
```

```bash title="CLI"
runtime sessions delete SESSION_ID
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_sessions_delete", "arguments": { "id": "SESSION_ID" } } }
```

## Objects

### SessionCreate

A session to make.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `machineId` | string | Yes | The machine it reaches (a sandbox, an app, a desktop, any machine), by its ID. |
| `expiresInSeconds` | integer | No | Seconds until it stops working, 60 to 86400; 3600 when omitted. Never past the key that makes it. At least 60. At most 86400. |
| `name` | string | No | Its name: your own handle for it, such as the user it is for. At least 1 character. At most 64 characters. |

### Session

A session: a token for one machine, for a frontend.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `session` | Yes | Always `session`. |
| `machineId` | string | Yes | The machine it reaches, alone. |
| `name` | string | Yes | Its name, as its maker gave it. |
| `accountId` | string | No | The person it acts as or for. |
| `agentId` | string | No | The agent or CI pipeline it acts as. |
| `state` | one of `active`, `deleted` | Yes | `active` while it works; `deleted` once ended: a delete's answer. |
| `createdAt` | string (RFC 3339) | Yes | When it was made. |
| `expiresAt` | string (RFC 3339) | Yes | When it stops working: its own end, or the end of the key that made it, the sooner. |
| `deletedAt` | string (RFC 3339) | No | When a delete ended it, or a revoke of the key that made it: a delete's answer, and a create's sent again once it ended. Omitted for one that ended at `expiresAt`. |

### SessionCreated

A session just made, with its token: shown this once, never again.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `session` | Yes | Always `session`. |
| `machineId` | string | Yes | The machine it reaches, alone. |
| `name` | string | Yes | Its name, as its maker gave it. |
| `accountId` | string | No | The person it acts as or for. |
| `agentId` | string | No | The agent or CI pipeline it acts as. |
| `state` | one of `active`, `deleted` | Yes | `active` while it works; `deleted` once ended: a delete's answer. |
| `createdAt` | string (RFC 3339) | Yes | When it was made. |
| `expiresAt` | string (RFC 3339) | Yes | When it stops working: its own end, or the end of the key that made it, the sooner. |
| `deletedAt` | string (RFC 3339) | No | When a delete ended it, or a revoke of the key that made it: a delete's answer, and a create's sent again once it ended. Omitted for one that ended at `expiresAt`. |
| `token` | string | Yes | The token, to send as `Authorization: Bearer <token>` from the frontend. |
