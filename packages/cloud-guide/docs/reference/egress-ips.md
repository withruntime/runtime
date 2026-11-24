# EgressIp API reference

A static egress IP: a public address every machine of the org sends from, the same every time, for others' allow-lists.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `making`, `ready`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/egress-ips` | [List egressIps](#list-egressips) |

## List egressIps

`GET /v2/egress-ips`

Lists the org's static egress IPs.

Its action, for a key's grant: `egressIps:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [EgressIp](#egressip), and `next`, where the next page starts, none on the last.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/egress-ips" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.egressIps.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.egress_ips.list()
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.egress_ips.list
```

```bash title="CLI"
runtime egressIps list
```

## Objects

### EgressIpSettings

A static egress IP's settings, as it keeps them.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `family` | integer | Yes | 4 or 6. |
| `rate` | string (US dollars, decimal) | Yes | Its monthly price when it was reserved, in US dollars (`"5.00"`); it does not change. |

### EgressIp

A static egress IP: every machine of the org sends from it.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `family` | integer | Yes | 4 or 6. |
| `rate` | string (US dollars, decimal) | Yes | Its monthly price when it was reserved, in US dollars (`"5.00"`); it does not change. |
| `id` | string | Yes | Its ID. |
| `object` | one of `ip` | Yes | Always `ip`. |
| `address` | string | Yes | The address. |
| `state` | one of `making`, `ready`, `deleted` | Yes | Its state: `ready` once machines send from it. |
| `disabled` | boolean | Yes | Turned off: its machines send from the shared addresses. |
| `createdAt` | string (RFC 3339) | Yes | When it was reserved. |
