---
launch: functions
---

# Functions

A Function is an HTTP handler Runtime runs for you at its own HTTPS address.
Copies start when calls come, as many as the calls in flight need, and every
copy goes back to sleep about a second after its last call ends. A Function
nobody calls has no copy awake and costs nothing but its saved copies
([price](./pricing#functions)). A copy is a machine, the same kind as a
sandbox, so the handler can be any program in any language that serves HTTP.

A Function is an [App](./apps) that never keeps a copy awake: the same
calls under `/v1/functions` instead of `/v1/apps`, the same deploys, versions,
rollbacks, copies and logs, without `minCopies`.

## Deploy a function

Make an image once ([custom images](./images)). Its start command runs with
`PORT` set, and must serve HTTP on that port:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.images.build({
  name: "hello-fn",
  dockerfile: 'FROM python:3.12-slim\nCMD ["sh", "-c", "python -m http.server $PORT"]\n',
});
```

Then create the Function and deploy the image. `wait: true` returns once the
version is live, or once it has failed, with the reason:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const fn = await runtime.functions.create({
  name: "hello-fn",
  maxCopies: 10,
  vcpu: 1,
  memoryMiB: 512,
});
const deploy = await runtime.functions.deploy(fn.id, { image: "hello-fn", wait: true });
if (deploy.state === "live") console.log(deploy.url);
else console.log(deploy.error?.code, deploy.error?.hint, deploy.error?.lastOutput);
```

```python check
from withruntime import Runtime

runtime = Runtime()
fn = runtime.functions.create(name="hello-fn", max_copies=10, vcpu=1, memory_mib=512)
deploy = runtime.functions.deploy(fn["id"], image="hello-fn", wait=True)
print(deploy["state"], deploy.get("url"))
```

From a shell:

```bash no-run
runtime functions create hello-fn --vcpu 1 --memory 512 --max-copies 10
runtime functions deploy hello-fn --image hello-fn   # waits until it is live
runtime functions logs hello-fn --follow
```

The same over HTTP:

```bash no-run
curl -sS https://api.withruntime.com/v1/functions \
  -H "Authorization: Bearer $RUNTIME_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"hello-fn","maxCopies":10,"vcpu":1,"memoryMiB":512}'
curl -sS "https://api.withruntime.com/v1/functions/$FUNCTION_ID/deploys" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" -H "Content-Type: application/json" \
  -d '{"image":"hello-fn"}'
curl -sS "https://api.withruntime.com/v1/functions/$FUNCTION_ID/deploys/$DEPLOY_ID?waitFor=live" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

A deploy can also take a build of a connected repository instead of an image
(`build`: a build that succeeded, from `runtime builds`). The address is the `url` of the
Function and of every deploy, and does not change between versions. A create
or deploy with the same `Idempotency-Key` within 24 hours answers the first
one again, so a retry never makes a second Function or version. Agents reach
the same calls through the MCP tools `runtime_functions_create`,
`runtime_functions_deploy`, `runtime_functions_get_deploy`,
`runtime_functions_rollback`, `runtime_functions_versions`,
`runtime_functions_copies` and `runtime_functions_logs`.

## Sleep and wake

A copy stays awake for `sleepAfterMs` after its last call ends, 1 second
unless set, then freezes with its memory: its processes, open files and
anything it loaded stay as they were. The next call thaws it where it
stopped, so a handler that loads a model or opens a pool at start pays that
once per version, not once per call.

- Calls closer together than `sleepAfterMs` keep the copy awake between
  them; a lone first call may sleep sooner, from 250 ms.
- A frozen copy is woken by the server it is on, in milliseconds, without
  waiting on Runtime's central scheduler. Each server keeps up to `spares` of
  its frozen copies in memory; the rest, and any frozen for 30 minutes, are
  parked and woken in a few hundred milliseconds.
- An open connection (a WebSocket or a stream) or CPU work holds a copy
  awake until it ends.
- Awake time with no call in flight is not billed.

`runtime.functions.copies(id)` lists each copy with its version, region and
state (`starting`, `serving`, `draining`, `frozen` or `parked`).

## Settings

| Setting        | What it does                                                             | Default  |
| -------------- | ------------------------------------------------------------------------ | -------- |
| `vcpu`         | vCPUs of each copy, 1 to {{max-vcpu}}                                    | Required |
| `memoryMiB`    | Memory of each copy, 128 MiB to {{max-memory}}                           | Required |
| `maxCopies`    | The most copies awake at once, 1 to 1,000 and the account's limit        | Required |
| `concurrency`  | Calls one copy takes at once, 1 to 10,000                                | 100      |
| `sleepAfterMs` | How long a copy stays awake after its last call, 250 to 5,000 ms         | 1,000    |
| `spares`       | Frozen copies each server keeps in memory for the next call, 0 to 16     | 2        |
| `port`         | The port the handler listens on, given to it as `PORT`                   | 8080     |
| `healthPath`   | A path that must answer 200; without it, the port accepting is healthy   | None     |
| `cdn`          | Cloudflare's CDN in front of the address; false goes straight to Runtime | true     |

Change any of them in place with `runtime.functions.update(id, { ... })`
(`POST /v1/functions/{id}:update`); a setting left out stays as it is.
`minCopies` is refused: a Function that must always answer at once is an
[App](./apps) with `minCopies: 1`.

## Versions, rollback and logs

Deploys go `building`, `warming`, `switching`, `live`, exactly as an App's
([deploys and rollback](./apps#deploys-health-checks-and-rollback)): the
address moves to a new version only once it answers its health check, and a
version that never does ends `failed` with the reason and its last output
while the old one keeps serving. `runtime.functions.rollback(id)` puts the
previous version live again without building anything.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const [fn] = (await runtime.functions.list({ name: "hello-fn" })).data;
for (const version of await runtime.functions.versions(fn!.id))
  console.log(version.version, version.live ? "live" : version.previous ? "previous" : "");
const lines = await runtime.functions.logs(fn!.id, { limit: 20 });
for (const line of lines.lines) console.log(line.stream, line.text);
```

`runtime functions logs hello-fn --follow` prints every line its copies
print as it comes; lines are kept 14 days.

## Environment and secrets

A deploy's `env` sets the handler's environment, sealed as secrets bound to
the Function; a version keeps only their names. `keepEnv: true` carries the
last deploy's environment. Account secrets reach a Function the same way as
an App ([environment and secrets](./apps#environment-and-secrets)): the
copy sees a placeholder, and the egress proxy puts the value into its HTTPS
requests to the secret's hosts.

## Delete

`runtime.functions.delete(id)` (`runtime functions rm hello-fn`) stops its
copies and frees its address; its saved copies are deleted with it.

## Limits and errors

A Function needs credit on the account. Its limits are an App's
([limits](./limits#apps)), and so are its errors
([errors](./apps#errors)). A create or update that sets `minCopies` is refused.
