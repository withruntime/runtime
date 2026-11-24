# Domain API reference

Your own hostname serving a machine's port, with HTTPS.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `making`, `ready`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v2/domains` | [Create a domain](#create-a-domain) |
| `GET` | `/v2/domains` | [List domains](#list-domains) |
| `GET` | `/v2/domains/{hostname}` | [Get a domain](#get-a-domain) |
| `POST` | `/v2/domains/{hostname}:verify` | [verify](#verify) |
| `DELETE` | `/v2/domains/{hostname}` | [Delete a domain](#delete-a-domain) |

## Create a domain

`POST /v2/domains`

Adds a hostname to serve a machine's port, checks its TXT record, and returns the DNS records to set. Asked again with another machine or port, it points the name there.

Its action, for a key's grant: `domains:create`.

Body: a [DomainCreate](#domaincreate).

Returns a [Domain](#domain).

In v1: `POST /v1/domains`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/domains" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "hostname": "example", "sandboxId": "SANDBOX_ID", "port": 3000 }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.domains.create({ hostname: "example", sandboxId: "SANDBOX_ID", port: 3000 });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.domains.create(hostname="example", sandbox_id="SANDBOX_ID", port=3000)
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.domains.create(hostname: "example", sandbox_id: "SANDBOX_ID", port: 3000)
```

```bash title="CLI"
runtime domains create --hostname example --sandbox-id SANDBOX_ID --port 3000
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_domains_create", "arguments": { "hostname": "example", "sandboxId": "SANDBOX_ID", "port": 3000 } } }
```

## List domains

`GET /v2/domains`

Lists the org's custom domains, by hostname.

Its action, for a key's grant: `domains:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Domain](#domain), and `next`, where the next page starts, none on the last.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/domains" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.domains.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.domains.list()
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.domains.list
```

```bash title="CLI"
runtime domains list
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_domains_list", "arguments": {  } } }
```

## Get a domain

`GET /v2/domains/{hostname}`

Returns a custom domain and the DNS records it needs.

Its action, for a key's grant: `domains:get`.

Path: `hostname`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `wait` | number | No | Seconds to wait, at most 60, for its state to differ from `ifState`; it answers once it does, or as it is when the wait ends. At least 0. At most 60. |
| `ifState` | string | No | The state the caller last read, which `wait` waits for it to leave. |

Returns a [Domain](#domain).

In v1: `GET /v1/domains/{hostname}`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/domains/HOSTNAME_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.domains.get("HOSTNAME_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.domains.get("HOSTNAME_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.domains.get("HOSTNAME_ID")
```

```bash title="CLI"
runtime domains get HOSTNAME_ID
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_domains_get", "arguments": { "hostname": "HOSTNAME_ID" } } }
```

## `verify`

`POST /v2/domains/{hostname}:verify`

Checks the TXT record now; the name is served once it matches.

Its action, for a key's grant: `domains:create`.

Path: `hostname`.

Returns a [Domain](#domain).

In v1: `POST /v1/domains/{hostname}:verify`.

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/domains/HOSTNAME_ID:verify" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.domains.verify("HOSTNAME_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.domains.verify("HOSTNAME_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.domains.verify("HOSTNAME_ID")
```

```bash title="CLI"
runtime domains verify HOSTNAME_ID
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_domains_verify", "arguments": { "hostname": "HOSTNAME_ID" } } }
```

## Delete a domain

`DELETE /v2/domains/{hostname}`

Stops serving the hostname. Remove its DNS records too.

Its action, for a key's grant: `domains:delete`.

Path: `hostname`.

Returns a [Domain](#domain).

In v1: `DELETE /v1/domains/{hostname}`.

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/domains/HOSTNAME_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.domains.delete("HOSTNAME_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.domains.delete("HOSTNAME_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.domains.delete("HOSTNAME_ID")
```

```bash title="CLI"
runtime domains delete HOSTNAME_ID
```

```json title="MCP"
{ "method": "tools/call", "params": { "name": "runtime_domains_delete", "arguments": { "hostname": "HOSTNAME_ID" } } }
```

## Objects

### DomainCreate

A custom domain to add, or to point at another machine or port.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `hostname` | string | Yes | The hostname, at most 253 characters. |
| `sandboxId` | string | Yes | The machine to serve. |
| `port` | integer | Yes | The port inside the machine, 1 to 65535. |

### DomainSettings

A custom domain's settings, as it keeps them: the port it serves, and its proof of ownership as facts.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `port` | integer | Yes | The port inside the machine. At least 1. At most 65535. |
| `token` | string | Yes | The token the TXT record at `_runtime-challenge.<hostname>` holds as `runtime-verify=<token>`. |
| `verifiedAt` | string (RFC 3339) | No | When the TXT record was last found to hold the token; none until it is. |
| `checkedAt` | string (RFC 3339) | No | When the TXT record was last looked up. |
| `checkError` | string | No | What the last lookup found wrong; none when it proved the name. |

### Domain

A custom domain: your own hostname serving a machine's port.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `port` | integer | Yes | The port inside the machine. At least 1. At most 65535. |
| `token` | string | Yes | The token the TXT record at `_runtime-challenge.<hostname>` holds as `runtime-verify=<token>`. |
| `verifiedAt` | string (RFC 3339) | No | When the TXT record was last found to hold the token; none until it is. |
| `checkedAt` | string (RFC 3339) | No | When the TXT record was last looked up. |
| `checkError` | string | No | What the last lookup found wrong; none when it proved the name. |
| `id` | string | Yes | Its ID. |
| `object` | one of `domain` | Yes | Always `domain`. |
| `hostname` | string | Yes | The hostname, lower case. |
| `sandboxId` | string | Yes | The machine it serves. |
| `state` | one of `making`, `ready`, `deleted` | Yes | Its state: `ready` once every serving host routes it. |
| `disabled` | boolean | Yes | Turned off by Runtime. |
| `createdAt` | string (RFC 3339) | Yes | When it was added. |
| `records` | list of object of strings | No | The DNS records to set: the TXT record that proves the name, and the CNAME that sends visitors here. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |
