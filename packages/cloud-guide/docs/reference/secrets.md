# Secret API reference

A value a machine uses, sealed at rest and never answered. Hidden (the default): the machine sees a placeholder, and the egress proxy puts the value in its place, only on HTTPS to the secret's hosts. Visible: the machine holds the value, in its environment variable and in /run/secrets/<envName>.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `active`, `deleted`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/secrets` | [List secrets](#list-secrets) |
| `GET` | `/v2/secrets/{name}` | [Get a secret](#get-a-secret) |
| `PUT` | `/v2/secrets/{name}` | [set](#set) |
| `DELETE` | `/v2/secrets/{name}` | [Delete a secret](#delete-a-secret) |

## List secrets

`GET /v2/secrets`

Lists the organization's secrets by name, without their values.

Its action, for a key's grant: `secrets:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Secret](#secret), and `next`, where the next page starts, none on the last.

In v1: `GET /v1/egress-secrets`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/secrets" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.secrets.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.secrets.list()
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.secrets.list
```

```bash title="CLI"
runtime secrets list
```

## Get a secret

`GET /v2/secrets/{name}`

Returns a secret, without its value.

Its action, for a key's grant: `secrets:get`.

Path: `name`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `wait` | number | No | Seconds to wait, at most 60, for its state to differ from `ifState`; it answers once it does, or as it is when the wait ends. At least 0. At most 60. |
| `ifState` | string | No | The state the caller last read, which `wait` waits for it to leave. |

Returns a [Secret](#secret).

In v1: `GET /v1/egress-secrets/{name}`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/secrets/example" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.secrets.get("example");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.secrets.get("example")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.secrets.get("example")
```

```bash title="CLI"
runtime secrets get example
```

## `set`

`PUT /v2/secrets/{name}`

Stores or replaces a secret with its value, or changes one without it. Replacing it keeps its placeholder and raises its version; machines' new requests carry the new value within a second, and a visible secret's file holds it within a second. A running machine's processes keep the environment they started with; new commands get the new one. Asked again with the same Idempotency-Key and body, it returns the secret as that request left it. A deleted secret's name stored again is a new secret with a new placeholder, and so is a visible secret stored hidden. Without its value, it changes only the hosts, rules (`policies.rules`) and scope it names and keeps every other setting: hosts and rules only narrow, refused 400 when wider, since widening needs the value; a visible secret's scope only narrows, since its machines hold its value, and its file is removed within a second from each machine the scope leaves out. A secret not stored yet needs its value (404).

Its action, for a key's grant: `secrets:write`.

Path: `name`.

Body: a [SecretSet](#secretset).

Returns a [Secret](#secret).

In v1: `PUT /v1/egress-secrets/{name}`.

Examples:

```bash title="curl"
curl -X PUT "https://api.withruntime.com/v2/secrets/example" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.secrets.set("example");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.secrets.set("example")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.secrets.set("example")
```

```bash title="CLI"
runtime secrets set example
```

## Delete a secret

`DELETE /v2/secrets/{name}`

Deletes a secret and its value: no request carries it from then on, open connections' included, and a visible secret's file is removed from every machine within a second. Deleted again, it returns the same deleted secret.

Its action, for a key's grant: `secrets:delete`.

Path: `name`.

Returns a [Secret](#secret).

In v1: `DELETE /v1/egress-secrets/{name}`.

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/secrets/example" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.secrets.delete("example");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.secrets.delete("example")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.secrets.delete("example")
```

```bash title="CLI"
runtime secrets delete example
```

## Objects

### SecretScope

Which machines may use a secret.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `labelsAny` | list of object of strings | No | Machines with every label of any one of these sets. Give this or `none`. |
| `none` | boolean | No | `true`: no machine. Runtime alone uses the secret: it is in no machine's requests or environment. A registry login an image import pulls with (`pullSecret`) has this scope. Give this or `labelsAny`. |

### SecretRule

Which requests to a secret's hosts may carry it.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `methods` | list of string | No | Only these methods (`POST`); every method when omitted. |
| `paths` | list of string | Yes | Only these paths: exact (`/v1/chat/completions`), or a prefix ending in `/*`. |

### SecretGit

What a git push carrying a secret may update.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `push` | list of string | Yes | The branches a push may update: 1 to 16 patterns of 12 to 256 characters, `refs/heads/` then a branch name, `*` only at the end, and `{label.<key>}` for the machine's own label right below a fixed first segment (`refs/heads/task/{label.task}`). A tag, a delete or any other ref is refused, and so is every API write that moves a ref. Opening or editing a pull request, reviewing it, and commenting on a pull request or an issue go under any rule that allows the path. Any other API write goes only when a rule names its exact path, with no `*`. A secret with no rules makes no API write. |

### SecretGraphql

The GraphQL mutations a request carrying a secret may make.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | No | The GraphQL endpoint's path; `/graphql` when omitted. |
| `mutations` | list of string | Yes | Only these mutations, by name (at most 64); a request making any other is refused. |

### SecretApi

What API calls carrying a secret may do.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `graphql` | [SecretGraphql](#secretgraphql) | No | Its GraphQL mutations. |

### SecretPolicies

How a secret may be used, beyond its hosts: a request carries it only when every policy it holds allows it.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `rules` | list of [SecretRule](#secretrule) | No | Only requests one of these rules allows carry it; every request to its hosts when omitted. A set with its value and without rules removes them; one without its value keeps them, or narrows them to these. |
| `git` | [SecretGit](#secretgit) | No | Its git pushes' branches. Kept when a set leaves it out; only a set with the value changes it. |
| `api` | [SecretApi](#secretapi) | No | Its API calls' limits. Kept when a set leaves it out; only a set with the value changes it. |

### SecretSettings

A secret's settings: what it keeps beside its sealed value.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `visible` | boolean | No | The machine holds the value itself, in its environment variable from its start and in the file `/run/secrets/<envName>` (mode 0400, owned by root), which is rewritten within a second of each change and removed within a second of a delete or a scope that leaves the machine out. For values the proxy cannot put in, such as a database password or an SSH key. Changed only by a set with the value; false when omitted. |
| `hosts` | list of string | No | The hosts its value goes to on HTTPS: a name, or `*.` and a name for every name under it. Required unless visible; refused when visible. |
| `header` | string | No | The header it is set in on every request to its hosts; when omitted, its placeholder is replaced in the credential headers (Authorization, x-api-key and the like). Hidden secrets only. |
| `format` | string | No | The header's value, `{value}` replaced by the secret; `{value}` when omitted. Hidden secrets only. |
| `envName` | string | No | The environment variable that holds its placeholder (or, when visible, its value) in each machine it reaches; its name when omitted. When two secrets that reach one machine name the same variable, it holds the one first by name. |
| `scope` | [SecretScope](#secretscope) | No | The machines that may use it; every machine of the organization when omitted. |
| `policies` | [SecretPolicies](#secretpolicies) | No | How it may be used. Hidden secrets only. |

### Secret

A secret, without its value.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `visible` | boolean | No | The machine holds the value itself, in its environment variable from its start and in the file `/run/secrets/<envName>` (mode 0400, owned by root), which is rewritten within a second of each change and removed within a second of a delete or a scope that leaves the machine out. For values the proxy cannot put in, such as a database password or an SSH key. Changed only by a set with the value; false when omitted. |
| `hosts` | list of string | No | The hosts its value goes to on HTTPS: a name, or `*.` and a name for every name under it. Required unless visible; refused when visible. |
| `header` | string | No | The header it is set in on every request to its hosts; when omitted, its placeholder is replaced in the credential headers (Authorization, x-api-key and the like). Hidden secrets only. |
| `format` | string | No | The header's value, `{value}` replaced by the secret; `{value}` when omitted. Hidden secrets only. |
| `envName` | string | No | The environment variable that holds its placeholder (or, when visible, its value) in each machine it reaches; its name when omitted. When two secrets that reach one machine name the same variable, it holds the one first by name. |
| `scope` | [SecretScope](#secretscope) | No | The machines that may use it; every machine of the organization when omitted. |
| `policies` | [SecretPolicies](#secretpolicies) | No | How it may be used. Hidden secrets only. |
| `name` | string | Yes | Its name. |
| `object` | one of `secret` | Yes | Always `secret`. |
| `state` | one of `active`, `deleted` | Yes | `active` while requests carry it; `deleted` once deleted: a delete's answer. |
| `placeholder` | string | No | What a machine holds in the value's place; none when visible. |
| `version` | integer | Yes | Raised by each change. |
| `valueBytes` | integer | No | Its value's length in bytes. |
| `updatedAt` | string (RFC 3339) | No | When it was last changed. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |

### SecretSet

A secret to store or replace, or, without its value, to change.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `visible` | boolean | No | The machine holds the value itself, in its environment variable from its start and in the file `/run/secrets/<envName>` (mode 0400, owned by root), which is rewritten within a second of each change and removed within a second of a delete or a scope that leaves the machine out. For values the proxy cannot put in, such as a database password or an SSH key. Changed only by a set with the value; false when omitted. |
| `hosts` | list of string | No | The hosts its value goes to on HTTPS: a name, or `*.` and a name for every name under it. Required unless visible; refused when visible. |
| `header` | string | No | The header it is set in on every request to its hosts; when omitted, its placeholder is replaced in the credential headers (Authorization, x-api-key and the like). Hidden secrets only. |
| `format` | string | No | The header's value, `{value}` replaced by the secret; `{value}` when omitted. Hidden secrets only. |
| `envName` | string | No | The environment variable that holds its placeholder (or, when visible, its value) in each machine it reaches; its name when omitted. When two secrets that reach one machine name the same variable, it holds the one first by name. |
| `scope` | [SecretScope](#secretscope) | No | The machines that may use it; every machine of the organization when omitted. |
| `policies` | [SecretPolicies](#secretpolicies) | No | How it may be used. Hidden secrets only. |
| `value` | string, never answered (the CLI reads it from standard input or `--from-file`) | No | Its value, never answered. Hidden: 1 to 8192 visible ASCII characters and spaces, one line, since it goes into an HTTP header. Visible: 1 byte to 64 KiB of UTF-8 text with no NUL, newlines included (a PEM file, an SSH key, a service account's JSON). With it, the set stores the secret whole, as its fields say. Without it, the set changes only the hosts, `policies.rules` and scope it names, and keeps the rest: hosts and rules only narrow, since widening needs the value, and so does a visible secret's scope, whose machines hold its value; any other field is refused 400. |
| `expectedVersion` | integer | No | Replaced only from this version; 409 otherwise. |
