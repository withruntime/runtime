# Usage API reference

What the organization has used and has left at the price card's rates, and every limit it is held to.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: .

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/usage` | [Get a usage](#get-a-usage) |
| `GET` | `/v2/usage/export` | [export](#export) |

## Get a usage

`GET /v2/usage`

Returns the organization's credit and charges (everything credited and spent, what is left, and this month's use and charges by meter), its plan, and every limit it is held to with what it uses of each now; with key, that key's spend.

Its action, for a key's grant: `usage:get`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | string | No | One key's spend too, by its ID: a key the caller may see (its own holder's, or any for an owner or admin); any other is 404. |

Returns a [Usage](#usage).

In v1: `GET /v1/usage`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/usage" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.usage.get();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.usage.get()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.usage.get
```

```bash title="CLI"
runtime usage get
```

## `export`

`GET /v2/usage/export`

Returns the organization's measured usage in a time range, of every resource or only those named: each meter of each machine's, disk's or address's hour, what it used and its price at the card, oldest first, paginated. Each line settles at its hour's end and is final once finalThrough reaches it, so closed hours can be read while resources run.

Its action, for a key's grant: `usage:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `since` | string (RFC 3339) | Yes | The range's first moment, inclusive (UTC, RFC 3339). |
| `until` | string (RFC 3339) | Yes | The range's end, exclusive (UTC, RFC 3339). |
| `by` | string | No | What the range selects lines by: `hour`, each line's hour's start, or `settled`, its settledAt (its hour's end), of hours that have ended. Ranges by `settled`, each from the last one's end to no later than `finalThrough`, read every line once, final. Default: "hour". |
| `resourceId` | list of string | No | Only the usage of these resources (repeat it for several, up to 100): each line's `resourceId`, such as a sandbox's ID. |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | At most this many machine-hours. At least 1. At most 500. Default: 100. |

Returns a [UsageExport](#usageexport).

In v1: `GET /v1/usage/export`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/usage/export?since=example&until=example" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.usage.export({ since: "example", until: "example" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.usage.export(since="example", until="example")
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.usage.export(since: "example", until: "example")
```

```bash title="CLI"
runtime usage export --since example --until example
```

## Objects

### MeterUse

One meter's use and charges this month.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `meter` | string | Yes | The card's meter (`cpu`, `memory`, `traffic-out`, ...). |
| `quantity` | string | Yes | Used this month, in the meter's base unit, as an integer in text. |
| `unit` | string | Yes | The base unit: `core-microseconds`, `vcpu-microseconds`, `byte-seconds`, `bytes`, `calls` or `seconds`. |
| `charged` | string (US dollars, decimal) | Yes | Charged this month at the card's rate, in US dollars. |

### Limit

One limit the org is held to, and what it uses of it now.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | `running.vcpus`, `running.memory`, `machine.vcpus`, `machine.memory` or `starts.per-second`. |
| `unit` | one of `count`, `bytes`, `per-second` | Yes | What `max` and `used` count. |
| `max` | integer | No | The most it may hold; none for no limit. |
| `used` | integer | Yes | What it holds now. |

### KeyUsage

One key's spend and what its holder runs: a coordinator reads what each worker's key spent.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `keyId` | string | Yes | The key's ID. |
| `name` | string | Yes | Its name. |
| `agentId` | string | No | The agent or CI pipeline it acts as. |
| `accountId` | string | No | The person it acts as or for. |
| `daySpent` | string (US dollars, decimal) | Yes | What its calls committed in the last 24 hours, in US dollars, as its spend caps count it. |
| `periodSpent` | string (US dollars, decimal) | Yes | What its calls committed this month (UTC), in US dollars. |
| `running` | integer | Yes | Its holder's machines running now. |
| `machines` | integer | Yes | Its holder's machines, not deleted. |

### KeySpendCap

The spend cap a key's creates are held to, and what is left under it.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cap` | string (US dollars, decimal) | Yes | The most its holder's sandboxes may spend over windowSeconds, in US dollars. |
| `spent` | string (US dollars, decimal) | Yes | What they spent over the window, in US dollars, as the cap counts it. |
| `remaining` | string (US dollars, decimal) | Yes | What is left: cap less spent, never below 0. Once 0, a create is refused 403 until the window passes it. |
| `windowSeconds` | integer | Yes | The rolling window the cap counts over, in seconds. |

### Usage

What the org has used and has left, at the card's prices.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `orgId` | string | Yes | The organization. |
| `periodStart` | string (RFC 3339) | Yes | The month's first moment (UTC). |
| `credited` | string (US dollars, decimal) | Yes | Every credit ever added, in US dollars. |
| `spent` | string (US dollars, decimal) | Yes | Every charge ever settled, in US dollars. |
| `available` | string (US dollars, decimal) | Yes | What can still be spent: credited less spent, in US dollars. |
| `periodSpent` | string (US dollars, decimal) | Yes | Charged this month, in US dollars. |
| `meters` | list of [MeterUse](#meteruse) | Yes | This month's use and charges by meter. |
| `plan` | string | Yes | Its plan on the price card. |
| `limits` | list of [Limit](#limit) | Yes | Every limit it is held to, with what it uses of each now: the figures a create past one is refused by. |
| `spendCap` | string (US dollars, decimal) | No | The org's own cap on a month's charges, in US dollars. |
| `key` | [KeyUsage](#keyusage) | No | One key's spend, when the call names it (`key`). |
| `keySpendCap` | [KeySpendCap](#keyspendcap) | No | The spend cap this key's creates are held to: the tightest of its own, those of the keys it was made with, and its holder's grants'. Omitted when none holds it. |

### UsageLine

One meter of one machine's, disk's or address's hour, as measured, at the card's price.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | The line's ID: the same line has the same ID on every read. |
| `subjectId` | string | Yes | The resource it was used by: a machine, a disk or an address. |
| `resourceId` | string | Yes | The ID its product names it by (a sandbox's own ID). |
| `projectId` | string | Yes | Its project. |
| `meter` | string | Yes | The card's meter (`cpu`, `memory`, `standard`, `traffic-out`, ...). |
| `startsAt` | string (RFC 3339) | Yes | The hour's first moment (UTC). |
| `endsAt` | string (RFC 3339) | Yes | The hour's end. |
| `quantity` | string | Yes | What was used, in the meter's base unit, as an integer in text. |
| `unit` | string | Yes | The base unit: `core-microseconds`, `vcpu-microseconds`, `byte-seconds`, `bytes`, `calls` or `seconds`. |
| `chargedMicros` | string | Yes | The hour alone at the card's rate, rounded down, in integer microdollars as text. |
| `rateMicros` | string | Yes | The card's rate, in microdollars per priced unit, as an integer in text. |
| `settledAt` | string (RFC 3339) | Yes | When the line settles: its hour's end (UTC). A line can change only until the page's `finalThrough` reaches it. |
| `final` | boolean | Yes | Whether the line is final: its `settledAt` is at or before the page's `finalThrough`, and it never changes again. |
| `resourceFinal` | boolean | Yes | Whether its resource is deleted and every line it will ever have is final. |

### UsageExport

The organization's measured usage in a time range, oldest hour first.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `since` | string (RFC 3339) | Yes | The range's first moment, inclusive (UTC). |
| `until` | string (RFC 3339) | Yes | The range's end, exclusive (UTC). |
| `finalThrough` | string (RFC 3339) | No | Every line whose `settledAt` is at or before this moment is final: all usage before it has been measured. It never moves back; a later hour stays open until its usage is measured. None: no line is final yet. |
| `items` | list of [UsageLine](#usageline) | Yes | Each meter of each resource's hour. |
| `next` | string | No | Pass as cursor, with the same range, for the next page; none on the last. |
| `cursor` | string | No | The cursor this page was asked from; none on the first page. |
