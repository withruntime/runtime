# Tunnel API reference

A WireGuard tunnel from your own network into your sandboxes.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `making`, `ready`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/tunnels` | [List tunnels](#list-tunnels) |

## List tunnels

`GET /v2/tunnels`

Lists the org's WireGuard tunnels.

Its action, for a key's grant: `tunnels:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Tunnel](#tunnel), and `next`, where the next page starts, none on the last.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/tunnels" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.tunnels.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.tunnels.list()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.tunnels.list
```

```bash title="CLI"
runtime tunnels list
```

## Objects

### TunnelPeer

One of the org's own machines or routers on a tunnel.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `name` | string | Yes | Its name, unique in the tunnel. |
| `publicKey` | string | Yes | Its WireGuard public key. |
| `address` | string | Yes | Its address in the tunnel's subnet. |
| `routes` | list of string | Yes | The org's own ranges behind it that sandboxes may reach. |
| `createdAt` | string (RFC 3339) | Yes | When it was added. |
| `rotatedAt` | string (RFC 3339) | No | When its key was last replaced. |

### TunnelMember

A sandbox's address in a tunnel's subnet.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sandboxId` | string | Yes | The sandbox. |
| `address` | string | Yes | Its address in the subnet. |

### TunnelSettings

A WireGuard tunnel's settings, as it keeps them; its gateway's private key is kept sealed and never answered.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `subnet` | string | Yes | Its private IPv4 range, /16 to /24. |
| `gatewayAddress` | string | Yes | The gateway's address in the subnet. |
| `endpoint` | string | Yes | Where peers send WireGuard: address:port. |
| `gatewayPublicKey` | string | No | The gateway's WireGuard public key; none until the gateway has made its pair. |
| `rate` | string (US dollars, decimal) | Yes | Its monthly price when it was made, in US dollars (`"5.00"`); it does not change. |
| `peers` | list of [TunnelPeer](#tunnelpeer) | Yes | The org's machines and routers on it. |
| `members` | list of [TunnelMember](#tunnelmember) | Yes | Each sandbox's address in the subnet. |

### Tunnel

A WireGuard tunnel from the org's own network into its sandboxes.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `subnet` | string | Yes | Its private IPv4 range, /16 to /24. |
| `gatewayAddress` | string | Yes | The gateway's address in the subnet. |
| `endpoint` | string | Yes | Where peers send WireGuard: address:port. |
| `gatewayPublicKey` | string | No | The gateway's WireGuard public key; none until the gateway has made its pair. |
| `rate` | string (US dollars, decimal) | Yes | Its monthly price when it was made, in US dollars (`"5.00"`); it does not change. |
| `peers` | list of [TunnelPeer](#tunnelpeer) | Yes | The org's machines and routers on it. |
| `members` | list of [TunnelMember](#tunnelmember) | Yes | Each sandbox's address in the subnet. |
| `id` | string | Yes | Its ID. |
| `object` | one of `tunnel` | Yes | Always `tunnel`. |
| `state` | one of `making`, `ready`, `deleted` | Yes | Its state: `ready` once its gateway answers. |
| `disabled` | boolean | Yes | Turned off: no traffic passes. |
| `createdAt` | string (RFC 3339) | Yes | When it was made. |
