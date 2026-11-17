# Me API reference

Who is calling: the key, the organization it acts for, its project, and the role that admits it.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: .

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/v2/me` | [Get a me](#get-a-me) |

## Get a me

`GET /v2/me`

Returns who the key is: the agent it acts as, its organization, plan, project and the role that admits it.

Its action, for a key's grant: `me:get`.

Returns a [Me](#me).

In v1: `GET /v1/me`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/me" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.me.get();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.me.get()
```

```ruby title="Ruby"
require "withruntime"

kit = Withruntime::Generated::Kit.new # RUNTIME_API_KEY from the environment
result = kit.me.get
```

```bash title="CLI"
runtime me get
```

## Objects

### Me

Who is calling: the key, the agent it is, the org it acts for, and what admits it.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `object` | one of `me` | Yes | Always `me`. |
| `orgId` | string | Yes | The organization the key acts for. |
| `orgName` | string | Yes | The organization's name, as its members see it. |
| `plan` | string | Yes | Its plan on the price card. |
| `keyId` | string | Yes | The key's ID. |
| `agentId` | string | No | Who the key acts as: an agent, a CI pipeline, a team or a person, by its ID. |
| `projectId` | string | Yes | The project the call acts in. |
| `projectName` | string | No | The project's name. |
| `role` | string | No | The built-in role of the grant that admits it (owner, admin, developer, viewer, billing); none for an org's own role. |
| `scope` | one of `org`, `project` | Yes | What a call that names no resource reaches: `org` (the whole organization) or `project` (the key's project alone). |
| `billing` | one of `test`, `trial`, `live`, `grace`, `paused` | No | How the organization pays: `test` (no card yet: every call is answered, and nothing runs or is billed), `trial`, `live`, `grace` (a payment is due; work runs until it pauses) or `paused` (work paused until paid; nothing deleted). |
