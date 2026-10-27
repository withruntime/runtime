---
launch: apps
---

# Apps

An App is a web server that Runtime runs for you: copies of one version of your
code behind one HTTPS address. Runtime starts more copies as requests arrive,
freezes the quiet ones, and switches to a new version only once it passes
its health check. A copy is a machine, the same kind as a sandbox. It bills at
the Apps rate ([price](./pricing#apps)).

Deploy an image from your account ([custom images](./images)). The image can be
a Dockerfile, any public or registry image, or a recipe.

## Deploy an app

Make the image once. Its start command runs with `PORT` set. It must serve
HTTP on that port:

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
await runtime.images.build({
  name: "hello",
  dockerfile: 'FROM python:3.12-slim\nCMD ["sh", "-c", "python -m http.server $PORT"]\n',
});
```

Then create the App and deploy the image. With `wait: true`, the call returns once the
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

The address is `https://<the App's id without dashes>.runtimehost.com/`. It is the
`url` of every deploy. A create or deploy with the same `Idempotency-Key`
within 24 hours returns the first result again. A retry never makes a second
App or version. Agents use the same calls through the MCP tools
`runtime_apps_create`, `runtime_apps_deploy`, `runtime_apps_get_deploy`,
`runtime_apps_rollback`, `runtime_apps_versions` and `runtime_apps_copies`.

<!-- launch: builds -->

## Deploy from GitHub on every push

Connect a repository to an App once. Every push to its production branch then
builds the commit and deploys it, with no configuration file. Install
Runtime's GitHub App on the repository first if it is private:
`runtime.builds.repositories.installGithub()` returns the install link.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const repo = await runtime.builds.repositories.connect({
  provider: "github",
  repository: "acme/web",
  deploy: "app:web",
});
const build = await runtime.builds.create({ repositoryId: repo.id, ref: "main" });
console.log(build.id, build.state);
```

From the CLI: `runtime builds repos connect acme/web --deploy web`.

When the repository sets no `startCommand`, Runtime reads the build folder
(`rootDirectory`, the repository's root by default) before any machine
starts, and detects its framework. The build's `framework` field names what
it found. An `installCommand` or `buildCommand` you set is used in place of
the detected one. A repository with its own `startCommand` is built with its
own commands and its lockfile's, and no framework is detected.

| Framework                           | Detected by                                             | Server                                       |
| ----------------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| Dockerfile                          | `Dockerfile` (used before anything else)                | The image, its `EXPOSE` port published       |
| Next.js                             | `next` in package.json                                  | `next start`; a static export is served      |
| Nuxt                                | `nuxt`                                                  | `.output/server/index.mjs`                   |
| Remix, React Router                 | `@remix-run/dev`, `@react-router/dev`                   | The `start` script, or the framework's own   |
| Astro                               | `astro`                                                 | `@astrojs/node`'s server, or `dist` served   |
| SvelteKit                           | `@sveltejs/kit` with `adapter-node` or `adapter-static` | `node build`, or `build` served              |
| Vite, Create React App              | `vite`, `react-scripts`                                 | The built folder, as a single-page app       |
| Express, Hono, Fastify, Koa, NestJS | The package                                             | The `start` script, or the `main` file       |
| FastAPI, Flask                      | The package, and its `app = FastAPI()` or `Flask()`     | Uvicorn, or Gunicorn                         |
| Django                              | `manage.py`                                             | Gunicorn with the project's WSGI module      |
| Rails, Sinatra, Rack                | `Gemfile` with `rails`, or `config.ru`                  | `rails server`, or `rackup`                  |
| Go                                  | `go.mod`                                                | The main package, compiled                   |
| Rust                                | `Cargo.toml`                                            | The package's binary, built with `--release` |
| Static site                         | `index.html`                                            | The folder, served                           |

Node.js installs with the lockfile's package manager (bun, pnpm, Yarn or npm).
Python installs with uv, Poetry, Pipenv or pip, by the lockfile the folder
holds. Ruby uses the version that `.ruby-version` or the Gemfile pins. Go
and Rust install their toolchains once. Every server is given `PORT` and
listens on `0.0.0.0`. A SvelteKit project without a server adapter, or a
Python app whose app object Runtime cannot find, fails its build with a
message that names the setting to add.

Each build's install, and the tools' own caches (`.next/cache`, Go's build
cache, Cargo's `target`), are kept between builds of the production branch.
A later build starts from them and runs only its change.

On GitHub, each build shows as a check named `runtime deploy` on its commit:
in progress while it builds, then a success with its time and framework, a
failure with the reason, or neutral when a newer commit supersedes it or it is
cancelled. A successful build deploys to the App, which goes
live once its copies pass their health check (see below). In Node.js, the
deploy's environment is in `process.env` before the first request. Outside
Node.js, a server built from a repository finds the deploy's environment in
`/run/runtime-app/env.json`, a JSON object of names to values, before its
first request. A server that reads its environment only at start should read
that file, or be deployed from an image, whose server starts with the
deploy's environment.

<!-- /launch: builds -->

## Settings

| Setting       | What it does                                                                                              | Default  |
| ------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| `vcpu`        | vCPUs of each copy, 1 to {{max-vcpu}}                                                                     | Required |
| `memoryMiB`   | Memory of each copy, 128 MiB to {{max-memory}}                                                            | Required |
| `maxCopies`   | The most copies running at the same time, 1 to the account's App copies at once ([limits](./limits#apps)) | Required |
| `minCopies`   | Copies kept awake and billed even with no requests                                                        | 0        |
| `concurrency` | Requests one copy takes at the same time, 1 to 10,000                                                     | 100      |
| `spares`      | Frozen copies kept ready for the next burst, free, 0 to 16                                                | 2        |
| `port`        | The port the server listens on, given to it as `PORT`                                                     | 8080     |
| `healthPath`  | A path that must return 200; without it, the port accepting is healthy                                    | None     |

Change any of them in place with `runtime.apps.update(id, { ... })` (`POST
/v1/apps/{id}:update`). A setting left out stays as it is. A deploy can also
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

## Requests at once

An App's copies at once follow the account's plan, as sandboxes do: Free 2,
Pro 100, Pro Max 250, Scale 500 and Enterprise 2,000 across all its Apps
([limits](./limits#apps)). Each copy takes up to `concurrency` requests at the
same time, up to 10,000, so the requests an App serves at once are `maxCopies`
times `concurrency`. For 30,000 requests at once, set `maxCopies: 100` and
`concurrency: 300`, or `maxCopies: 20` and `concurrency: 1500`. An agent's own
API key sets `maxCopies` to at most 20; an account-wide key made at
https://withruntime.com/account/keys sets up to the account's limit. A copy holds
that many requests only if its server does: most event-driven servers (Node.js,
Go, Rust, Python's asyncio) hold thousands on 1 vCPU while they wait.

## Long requests and streaming

A request has no total time limit. A response streams (server-sent events,
chunked bodies, WebSockets) for as long as the copy sends it and the visitor
reads it. The copy has 900 seconds (15 minutes) to send the response head after
the request arrives; a request whose head is later returns `504`. With `cdn`
on, Cloudflare's own limit of 100 seconds to the response head applies instead,
and a later head returns Cloudflare's `524`: set `cdn: false` for requests that
wait longer before they answer. A copy serving an open request or stream never
freezes.

## How copies scale

Runtime runs as many copies as the requests in flight need. The count is requests in
flight divided by `concurrency`, rounded up. It is never fewer than `minCopies`, and
never more than `maxCopies`. A request that finds every copy busy waits for
one. A new copy starts from a frozen spare first, which takes milliseconds.
Otherwise, it starts from the version's saved copy: a snapshot of the warm server,
with its memory, taken once when the version was deployed.

A copy above `minCopies` freezes once it has been quiet for a moment. An open connection (a WebSocket or a stream) or CPU work holds it awake. A frozen copy
is free. Each server running the App keeps up to `spares` of its frozen
copies in memory, the most recently used first, so the next request thaws one
in milliseconds. The rest, and any copy frozen for 30 minutes, are parked.
Parked copies are free too, and wake in a few hundred milliseconds. The server a copy runs
on wakes it. A wake never waits on Runtime's central scheduler, even when
that scheduler is down.

With `minCopies: 0`, an App has no copy awake while nobody calls it. It pays
only for its saved copies ([price](./pricing#apps)). It still keeps one copy
frozen, so the first request waits for that copy to wake, not for a new one
to start. The wait is milliseconds within 30 minutes of the last request. It is a few hundred
milliseconds after that, or with `spares: 0`.

## Deploys, health checks and rollback

A deploy makes a new version beside the live one. It goes from `building`
(the image is made ready) to `warming` (the server is started once,
passes its health check, and is saved with its memory). Then it goes to `switching` (its
copies start beside the old ones) and finally to `live`. The address moves to the new
version only once as many of its copies pass the health check as the old version had awake.
A deploy is `live` only once every router serves the new version's route, so a request
to the address reaches the new version when the deploy reports `live`. Until a first
version is served, the App's `state` is `waiting`.

A version that never passes its health check ends `failed` with
`deploy_health_failed`, a hint and its server's last output. The old
version keeps serving.

A deploy from an image warms the version on a machine of your account. It uses
a key of the App's owner: the agent or API key that created the App. That
owner must be allowed `create`, `list`, `get`, `stop`, `exec` and
`write_file` on sandboxes. If it is not, the version ends `failed` immediately
with `deploy_build_failed`, and the last output reads "Runtime's machine that saves
this version was refused: …". Grant the owner those actions, then deploy
again. A newer deploy started before one finishes replaces
it, and that one ends `superseded`. Follow one deploy by its id with
`runtime.apps.getDeploy(app, deploy, { waitFor: "live" })`. It waits up to
60 seconds per call. A deploy's state belongs to that deploy, so an older
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
after a deploy goes live, the previous version's copies keep running. So a
rollback in that window is served within a second. Later, it starts copies from the
previous version's saved copy. Only the live and previous versions keep
saved copies. With no previous version, a rollback returns
`rollback_unavailable`.

`runtime.apps.copies(id)` lists each copy with its version, region and state
(`starting`, `serving`, `draining`, `frozen` or `parked`).

## Environment and secrets

A deploy's `env` sets the server's environment: up to 256 names, 64 KiB of
names and values in all, each name made of letters, digits and underscores.
The values are sealed as secrets, bound to the App. A version keeps only
their names.

`keepEnv: true` carries the last deploy's environment, still sealed, so a
deploy need not send it again. It needs a key that may reveal the App's
secrets (`secrets_reveal`). With `env` beside it, the environment is kept,
with `env`'s names changed. A key without it is refused.

## Limits

An App needs credit on the account. The account limits (copies running at the same time,
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
