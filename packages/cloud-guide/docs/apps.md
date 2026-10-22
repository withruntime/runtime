---
launch: apps
---

# Apps

An App is a web server Runtime runs for you: copies of one version of your
code behind one HTTPS address. Runtime starts more copies as requests arrive,
freezes the quiet ones, and switches to a new version only once it answers
its health check. A copy is a machine, the same kind as a sandbox, and bills at
the Apps rate ([price](./pricing#apps)).

Deploy an image of your account ([custom images](./images)): a Dockerfile,
any public or registry image, or a recipe.

## Deploy an app

Make the image once. Its start command runs with `PORT` set, and must serve
HTTP on that port:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.images.build({
  name: "hello",
  dockerfile: 'FROM python:3.12-slim\nCMD ["sh", "-c", "python -m http.server $PORT"]\n',
});
```

Then create the App and deploy the image. `wait: true` returns once the
version is live, or once it has failed, with the reason:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const app = await runtime.apps.create({ name: "hello", maxCopies: 3, vcpu: 1, memoryMiB: 512 });
const deploy = await runtime.apps.deploy(app.id, { image: "hello", wait: true });
if (deploy.state === "live") console.log(deploy.url);
else console.log(deploy.error?.code, deploy.error?.hint, deploy.error?.lastOutput);
```

The same over HTTP:

```bash no-run
curl -sS https://api.withruntime.com/v1/apps \
  -H "Authorization: Bearer $RUNTIME_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"hello","maxCopies":3,"vcpu":1,"memoryMiB":512}'
curl -sS "https://api.withruntime.com/v1/apps/$APP_ID/deploys" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" -H "Content-Type: application/json" \
  -d '{"image":"hello"}'
curl -sS "https://api.withruntime.com/v1/apps/$APP_ID/deploys/$DEPLOY_ID?waitFor=live" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

The address is `https://<the App's id without dashes>.runtimehost.com/`, the
`url` of every deploy. A create or deploy with the same `Idempotency-Key`
within 24 hours answers the first one again, so a retry never makes a second
App or version. Agents reach the same calls through the MCP tools
`runtime_apps_create`, `runtime_apps_deploy`, `runtime_apps_get_deploy`,
`runtime_apps_rollback`, `runtime_apps_versions` and `runtime_apps_copies`.

## Settings

| Setting       | What it does                                                           | Default  |
| ------------- | ---------------------------------------------------------------------- | -------- |
| `vcpu`        | vCPUs of each copy, 1 to {{max-vcpu}}                                  | Required |
| `memoryMiB`   | Memory of each copy, 128 MiB to {{max-memory}}                         | Required |
| `maxCopies`   | The most copies at once, 1 to 1,000 and the account's limit            | Required |
| `minCopies`   | Copies kept awake and billed even with no requests                     | 0        |
| `concurrency` | Requests one copy takes at once, 1 to 10,000                           | 100      |
| `spares`      | Frozen copies kept ready for the next burst, free, 0 to 16             | 2        |
| `port`        | The port the server listens on, given to it as `PORT`                  | 8080     |
| `healthPath`  | A path that must answer 200; without it, the port accepting is healthy | None     |

Change any of them in place with `runtime.apps.update(id, { ... })` (`POST
/v1/apps/{id}:update`); a setting left out stays as it is. A deploy can also
set `port` and `healthPath` for its version.

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const app = await runtime.apps.create({
  name: `settings-${Date.now()}`,
  maxCopies: 2,
  vcpu: 1,
  memoryMiB: 256,
});
const changed = await runtime.apps.update(app.id, { minCopies: 1, spares: 0 });
console.log(changed.state, changed.minCopies, changed.maxCopies, changed.concurrency);
await runtime.apps.delete(app.id);
```

## How copies scale

Runtime runs as many copies as the requests in flight need: requests in
flight divided by `concurrency`, rounded up, never fewer than `minCopies` and
never more than `maxCopies`. A request that finds every copy busy waits for
one. A new copy starts from a frozen spare first, which takes milliseconds,
and otherwise from the version's saved copy: a snapshot of the warm server,
with its memory, taken once when the version was deployed.

A copy above `minCopies` freezes once it has been quiet for a moment, and no
open connection (a WebSocket or a stream) or CPU work holds it. A frozen copy
is free. Each server running the App keeps up to `spares` of its frozen
copies in memory, the most recently used first, so the next request thaws one
in milliseconds; the rest, and any copy frozen for 30 minutes, are parked:
free too, and woken in a few hundred milliseconds. The server a copy runs
on wakes it, so a wake never waits on Runtime's central scheduler, even when
that is down.

With `minCopies: 0` an App has no copy awake while nobody calls it, and pays
only for its saved copies ([price](./pricing#apps)). It still keeps one copy
frozen, so the first request waits for that copy to wake, not for a new one
to start: milliseconds within 30 minutes of the last request, a few hundred
milliseconds after that, or with `spares: 0`.

## Deploys, health checks and rollback

A deploy makes a new version beside the live one. It goes from `building`
(the image is made ready) to `warming` (the server is started once,
answers its health check, and is saved with its memory) to `switching` (its
copies start beside the old ones) to `live`. The address moves to the new
version only once as many of its copies answer as the old version had awake.

A version that never answers its health check ends `failed` with
`deploy_health_failed`, a hint and its server's last output, and the old
version keeps serving.

A deploy from an image warms the version on a machine of your account, with
a key of the App's owner: the agent or API key that created the App. That
owner must be allowed `create`, `list`, `get`, `stop`, `exec` and
`write_file` on sandboxes. If it is not, the version ends `failed` at once
with `deploy_build_failed` and the last output "Runtime's machine that saves
this version was refused: …"; grant the owner those actions, then deploy
again. A newer deploy started before one finishes replaces
it: that one ends `superseded`. Follow one deploy by its id,
`runtime.apps.getDeploy(app, deploy, { waitFor: "live" })`, which waits up to
60 seconds a call; a deploy's state belongs to that deploy, so an older
version can stay live while a newer one fails.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const [app] = (await runtime.apps.list({ name: "hello" })).data;
for (const version of await runtime.apps.versions(app!.id))
  console.log(version.version, version.live ? "live" : version.previous ? "previous" : "");
const back = await runtime.apps.rollback(app!.id, { wait: true });
console.log(back.state, back.version);
```

`rollback` returns to the previous version without building anything. For 15 minutes
after a deploy goes live the previous version's copies keep running, so a
rollback then is served within a second; later it starts copies from the
previous version's saved copy. Only the live and previous versions keep
saved copies. With no previous version, a rollback answers
`rollback_unavailable`.

`runtime.apps.copies(id)` lists each copy with its version, region and state
(`starting`, `serving`, `draining`, `frozen` or `parked`).

## Environment and secrets

A deploy's `env` sets the server's environment: up to 256 names, 64 KiB of
names and values in all, each name made of letters, digits and underscores.
The values are sealed as secrets, bound to the App; a version keeps only
their names.

`keepEnv: true` carries the last deploy's environment, still sealed, so a
deploy need not send it again. It needs a key that may reveal the App's
secrets (`secrets_reveal`); with `env` beside it, the environment is kept
with `env`'s names changed. A key without it is refused.

## Limits

An App needs credit on the account. The account limits (copies at once,
Apps) and every limit of one App are on the [limits page](./limits#apps).

## Errors

Every refusal has a code, a hint and, for a deploy, the server's last output.

| Code                   | Status | What to do                                                                |
| ---------------------- | ------ | ------------------------------------------------------------------------- |
| `copies_invalid`       | 400    | Lower `minCopies` or raise `maxCopies`                                    |
| `scale_invalid`        | 400    | Use whole numbers within the bounds above                                 |
| `scale_over_limit`     | 409    | Lower `maxCopies` to the account's limit, or ask support to raise it      |
| `image_not_ready`      | 409    | Deploy the image once its build is ready                                  |
| `deploy_build_failed`  | 409    | Fix what the last output names, then deploy again                         |
| `deploy_health_failed` | 409    | Check the port and health path against the last output, then deploy again |
| `deploy_superseded`    | 409    | A newer deploy replaced this one; follow that deploy instead              |
| `rollback_unavailable` | 409    | Deploy another version before rolling back                                |
| `keep_env_refused`     | 409    | Send `env`, or keep the environment as described above                    |
