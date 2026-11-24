# Key API reference

An API key: what a program, an agent or a CI pipeline calls the API with, acting as the person or agent who made it and never reaching more. Its secret is shown once, when it is made.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `active`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/keys` | [List keys](#list-keys) |
| `POST` | `/v2/keys` | [Create a key](#create-a-key) |
| `POST` | `/v2/keys/{id}:update` | [update](#update) |
| `DELETE` | `/v2/keys/{id}` | [Delete a key](#delete-a-key) |

## List keys

`GET /v2/keys`

Lists the organization's live keys, newest first, without their secrets: every key for an owner or an admin, the caller's own otherwise.

Its action, for a key's grant: `keys:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Key](#key), and `next`, where the next page starts, none on the last.

In v1: `GET /v1/keys`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/keys" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.keys.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.keys.list()
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.keys.list
```

```bash title="CLI"
runtime keys list
```

## Create a key

`POST /v2/keys`

Makes a key that acts as the caller, or as one of the organization's agents for the caller, and returns its secret this once. With `userCode` or `authorization`, the key goes to the device or OAuth client that asked for it instead, which collects it once from `/v2/oauth/token`. A key made with a key works until its own end, never past that key's: it lives on when that key is revoked, so a key is rotated by making its next with it.

Its action, for a key's grant: `keys:create`.

Body: a [KeyCreate](#keycreate).

Returns a [KeyCreated](#keycreated).

In v1: `POST /v1/keys`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/keys" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "example" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.keys.create({ name: "example" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.keys.create(name="example")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.keys.create(name: "example")
```

```bash title="CLI"
runtime keys create --name example
```

## `update`

`POST /v2/keys/{id}:update`

Renames a key, or sets or removes its caps (`maxCost`, `spendCap`); its secret stays as it is. A cap is never set above that of a key it was made with, nor above the caller's own key's, so a key never raises its own caps. An owner or an admin changes any key of the organization; everyone else, their own.

Its action, for a key's grant: `keys:update`.

Path: `id`.

Body: a [KeyUpdate](#keyupdate).

Returns a [Key](#key).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/keys/KEY_ID:update" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.keys.update("KEY_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.keys.update("KEY_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.keys.update("KEY_ID")
```

```bash title="CLI"
runtime keys update KEY_ID
```

## Delete a key

`DELETE /v2/keys/{id}`

Revokes a key: refused from its next call, with the hand-off tokens made from it; a key made with it works on. An owner or an admin revokes any key of the organization; everyone else, their own. Revoked again, it returns 404.

Its action, for a key's grant: `keys:delete`.

Path: `id`.

Returns a [Key](#key).

In v1: `DELETE /v1/keys/{id}`.

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/keys/KEY_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.keys.delete("KEY_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.keys.delete("KEY_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.keys.delete("KEY_ID")
```

```bash title="CLI"
runtime keys delete KEY_ID
```

## Objects

### Key

An API key, without its secret.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `key` | Yes | Always `key`. |
| `name` | string | Yes | Its name, as its maker gave it. |
| `state` | one of `active`, `deleted` | Yes | `active` while it works; `deleted` once revoked: a delete's answer. |
| `accountId` | string | No | The person it acts as or for. |
| `agentId` | string | No | The agent or CI pipeline it acts as. |
| `projectId` | string | No | The one project it acts in; every project its holder reaches when omitted. |
| `createdAt` | string (RFC 3339) | Yes | When it was made. |
| `expiresAt` | string (RFC 3339) | No | When it stops working; never when omitted. |
| `lastUsedAt` | string (RFC 3339) | No | When it was last used. |
| `maxCost` | string (US dollars, decimal) | No | The most one request made with it commits, in US dollars. |
| `spendCap` | string (US dollars, decimal) | No | The most the machines made with it, with those of every key made with it, may spend over spendCapWindowSeconds, in US dollars. |
| `spendCapWindowSeconds` | integer | No | The rolling window spendCap counts over, in seconds. |
| `spent` | string (US dollars, decimal) | No | What it spent over spendCapWindowSeconds (the last 24 hours when it has no spendCap), in US dollars, as spendCap counts it: its machines' and those of every key made with it. Listed and updated keys only. |
| `deletedAt` | string (RFC 3339) | No | When it was revoked: a delete's answer, its state `deleted`. |

### KeyAuthorization

An OAuth client's request for a key, as `/v2/oauth/authorize` received it.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `clientId` | string | Yes | The client's `client_id`. |
| `redirectUri` | string | Yes | Where the client is sent back: one of its redirect URIs. |
| `codeChallenge` | string | Yes | Its S256 `code_challenge`. |
| `state` | string | No | Its `state`, sent back unchanged. |

### KeyCreate

A key to make.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Its name. At least 1 character. At most 64 characters. |
| `projectId` | string | No | Held to this one project (Growth and up); every project its holder reaches when omitted. |
| `agentId` | string | No | One of the organization's agents or CI pipelines it acts as, for the caller; the caller itself when omitted. |
| `actions` | list of string | No | The actions it holds, each `product:action` as each call's reference page names it (`sandboxes:create`, `sandboxes:exec`), on every plan: it acts as an agent of its own granted exactly these, never more than its caller may do or spend, in every project its caller reaches (one held to one project, with projectId or by a caller that reaches one alone, starts at Growth), and its agent and role are deleted with it. Omitted, it holds every action its holder's grant allows, or, made with a key that has actions, those actions. Not with agentId. |
| `expiresInSeconds` | integer | No | Seconds until it stops working; never when omitted. At least 60. At most 31536000. |
| `maxCost` | string (US dollars, decimal) | No | The most one request made with it may commit, in US dollars (`"5.00"`): one asking more is refused 403, and a create that names no maxCost gets this one. Made with a key that has one, at most that key's. |
| `spendCap` | string (US dollars, decimal) | No | The most the machines made with it, with those of every key made with it, may spend over spendCapWindowSeconds, in US dollars, as billed: once reached, a create is refused 403 until the window passes it, and a create that names no maxCost gets what is left as its maxCost. Running machines may pass it. Made with a key that has one, at most that key's, and counted in it too. |
| `spendCapWindowSeconds` | integer | No | The rolling window spendCap counts over, in seconds; a day when omitted. At least 60. At most 2592000. |
| `userCode` | string | No | The code a device shows (OAuth 2.0 device flow, RFC 8628): the key goes to that device, never in this answer. |
| `authorization` | [KeyAuthorization](#keyauthorization) | No | An OAuth client's request (authorization code with PKCE): the key goes to that client, never in this answer. |

### KeyCreated

A key just made, with its secret: shown this once, never again.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `key` | Yes | Always `key`. |
| `name` | string | Yes | Its name, as its maker gave it. |
| `state` | one of `active`, `deleted` | Yes | `active` while it works; `deleted` once revoked: a delete's answer. |
| `accountId` | string | No | The person it acts as or for. |
| `agentId` | string | No | The agent or CI pipeline it acts as. |
| `projectId` | string | No | The one project it acts in; every project its holder reaches when omitted. |
| `createdAt` | string (RFC 3339) | Yes | When it was made. |
| `expiresAt` | string (RFC 3339) | No | When it stops working; never when omitted. |
| `lastUsedAt` | string (RFC 3339) | No | When it was last used. |
| `maxCost` | string (US dollars, decimal) | No | The most one request made with it commits, in US dollars. |
| `spendCap` | string (US dollars, decimal) | No | The most the machines made with it, with those of every key made with it, may spend over spendCapWindowSeconds, in US dollars. |
| `spendCapWindowSeconds` | integer | No | The rolling window spendCap counts over, in seconds. |
| `spent` | string (US dollars, decimal) | No | What it spent over spendCapWindowSeconds (the last 24 hours when it has no spendCap), in US dollars, as spendCap counts it: its machines' and those of every key made with it. Listed and updated keys only. |
| `deletedAt` | string (RFC 3339) | No | When it was revoked: a delete's answer, its state `deleted`. |
| `secret` | string | No | The key itself, to send as `Authorization: Bearer <secret>`; omitted for a key a device or an OAuth client collects. |
| `redirectTo` | string | No | For an OAuth client's key: where to send the person, with the code the client exchanges for it. |

### KeyUpdate

A change to a key: each field left out stays as it is.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | No | Its name. At least 1 character. At most 64 characters. |
| `maxCost` | string (US dollars, decimal) | No | The most one request made with it may commit, in US dollars (`"5.00"`). Never more than a key it was made with, nor than the key that changes it: a key never raises its own caps. |
| `spendCap` | string (US dollars, decimal) | No | The most the machines made with it, with those of every key made with it, may spend over spendCapWindowSeconds, in US dollars, as billed. Never more than a key it was made with, nor than the key that changes it. |
| `spendCapWindowSeconds` | integer | No | The rolling window spendCap counts over, in seconds; kept when omitted, a day for a key that had no spendCap. At least 60. At most 2592000. |
| `remove` | list of one of `maxCost`, `spendCap` | No | Caps to remove: `maxCost`, `spendCap`. The key is then held only by the caps of the keys it was made with and of its holder's grants. |
