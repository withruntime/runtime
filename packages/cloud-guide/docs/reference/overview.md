# API reference

The Runtime API v2, generated from the same spec the API parses every request with, so this reference matches what the API accepts and returns.

Base URL: `https://api.withruntime.com/v2`.

## Products

| Product | Path | Description |
| --- | --- | --- |
| [Sandbox](./sandboxes) | `/v2/sandboxes` | A Linux machine with its own kernel, made in milliseconds, paused with its memory kept when idle and resumed where it was. Its life: running, then idle, then paused, until you delete it. A paused sandbox is kept with its memory and disk until it is deleted: it has no time limit, no retention period and no expiry, and nothing deletes it for its age. Every 30 days a sandbox stays paused, counted from its `pausedAt`, a `sandbox.still_paused` event is written for its organization. |
| [Function](./functions) | `/v2/functions` | A machine that answers HTTP with a handler in /app/index.ts (`export default { fetch(request) }`, as Cloudflare Workers and Vercel take one) on port 8080, reached at its preview. It pauses after 60 seconds with nothing happening, its memory kept, and a request resumes it. |
| [Secret](./secrets) | `/v2/secrets` | A value a machine uses, sealed at rest and never answered. Hidden (the default): the machine sees a placeholder, and the egress proxy puts the value in its place, only on HTTPS to the secret's hosts. Visible: the machine holds the value, in its environment variable and in /run/secrets/<envName>. |
| [App](./apps) | `/v2/apps` | A machine that keeps a web app in /app running on port 8080 (its Procfile's `web:`, else `npm start`, else `python3 app.py`, as Render and Heroku start one), reached at its preview. It never pauses for being idle. |
| [Site](./sites) | `/v2/sites` | A machine that serves the static files in /site on port 8080 (as Netlify and Vercel serve a build's output), reached at its preview. It pauses after 60 seconds with nothing happening, its memory kept, and a visit resumes it. |
| [Ci](./ci) | `/v2/ci` | A machine that runs a repository's checks to their end (its `run`) with git, Docker, Node, Bun, Python and a compiler, and is stopped then. As an Actions runner, it starts GitHub's runner for the one job of its just-in-time configuration (`run` `runtime-runner`, `RUNNER_JITCONFIG` in its environment) and stops with it; a job of a GitHub account connected through Runtime's GitHub App gets one by itself. |
| [Browser](./browsers) | `/v2/browsers` | A machine running headless Chromium, driven over the Chrome DevTools Protocol at its preview on port 9222: one WebSocket address for Playwright's `connectOverCDP` and Puppeteer's `connect`, as Browserbase gives one. It pauses after 60 seconds with nothing happening, its memory kept, and a connection resumes it. |
| [Desktop](./desktops) | `/v2/desktops` | A machine running a Linux desktop with Chromium, for agents that use a computer: screenshot returns what its screen shows and act moves and clicks its mouse and types on its keyboard. It is shown in the browser through noVNC at its preview on port 6080; its VNC server answers only inside the machine, so a link signed for that preview is the one way to watch it. It pauses after 300 seconds with nothing happening, its memory kept. |
| [Notebook](./notebooks) | `/v2/notebooks` | A machine running JupyterLab on port 8888 over /workspace, with NumPy, pandas and matplotlib, reached at its private preview. It pauses after 300 seconds with nothing happening, its kernels kept in memory, and a visit resumes it where it was. |
| [Workspace](./workspaces) | `/v2/workspaces` | A development environment: a machine running VS Code in the browser (code-server) on port 8080 over /workspace, reached at its private preview, as Codespaces and Gitpod give one. It pauses after 30 minutes with nothing happening, its memory kept. |
| [Container](./containers) | `/v2/containers` | A machine that runs one OCI image from any registry under Docker on its own network (`start` `runtime-container <image>`), the port it listens on reached at its preview, as Cloud Run and Fly Machines run one. |
| [Build](./builds) | `/v2/builds` | The machine an image's build runs on: Docker's own builder (BuildKit), its run `runtime-image-build`, deleted once its image is made. Made by an image's create, and billed as any machine is, for the CPU it uses and the memory it holds while it builds. |
| [Job](./jobs) | `/v2/jobs` | A command run in a fresh machine, once or on a cron schedule in a timezone. Each run is a machine made at its time, deleted when its command ends, and billed as any machine is; its exit code and its last 256 KiB of output are kept. Runs of one job never overlap: a time that comes while one runs is made once it ends, and times missed make one run. |
| [JobRun](./job-runs) | `/v2/job-runs` | One run of a job: a machine made at one of its times, deleted when its command ends. Its record (exit code, times, the last 256 KiB of its output) stays readable for 7 days after. |
| [Snapshot](./snapshots) | `/v2/snapshots` | A machine's memory and disk as they were, kept to start new machines from. |
| [Image](./images) | `/v2/images` | What a machine boots: a root filesystem, its environment and its start. |
| [Volume](./volumes) | `/v2/volumes` | A disk that outlives the machines it is attached to. |
| [Session](./sessions) | `/v2/sessions` | A short-lived token a frontend holds to reach one machine directly: it reads the machine, runs its commands and processes, reads and writes its files, and signs its previews' links, and does nothing else. It acts as the key that made it and ends with that key. |
| [Key](./keys) | `/v2/keys` | An API key: what a program, an agent or a CI pipeline calls the API with, acting as the person or agent who made it and never reaching more. Its secret is shown once, when it is made. |
| [Project](./projects) | `/v2/projects` | A project: where machines, storage, addresses and keys sit, each in one. Every organization has a default project, where a call that names none acts. |
| [Identity](./identities) | `/v2/identities` | An agent or CI pipeline: who a key acts as besides a person, holding grants of its own. |
| [Role](./roles) | `/v2/roles` | One of the organization's own roles: the actions a grant of it allows. The built-in roles (owner, admin, developer, viewer, billing) are not listed here. |
| [AuditLine](./audit) | `/v2/audit` | The organization's audit log: every write and every refused call, with who asked, from where, and what it committed. On the Scale and Enterprise plans. |
| [Me](./me) | `/v2/me` | Who is calling: the key, the organization it acts for, its project, and the role that admits it. |
| [Usage](./usage) | `/v2/usage` | What the organization has used and has left at the price card's rates, and every limit it is held to. |
| [Preview](./previews) | `/v2/previews` | A port of a machine at a public HTTPS address: private with a signed token, or public. |
| [Domain](./domains) | `/v2/domains` | Your own hostname serving a machine's port, with HTTPS. |
| [Port](./ports) | `/v2/ports` | A public TCP port carried to a port of a machine: a database, a game server, anything that is not HTTP. |
| [EgressIp](./egress-ips) | `/v2/egress-ips` | A static egress IP: a public address every machine of the org sends from, the same every time, for others' allow-lists. |
| [Tunnel](./tunnels) | `/v2/tunnels` | A WireGuard tunnel from your own network into your machines. |
| [Network](./networks) | `/v2/networks` | A private network: its machines reach each other by name, over TCP. |
| [Webhook](./webhooks) | `/v2/webhooks` | A signed POST to your URL for each event it names. |
| [Event](./events) | `/v2/events` | What changed in the organization, as it changed: each event a webhook or an OpenTelemetry export is sent, kept 14 days. |
| [Export](./otel) | `/v2/otel` | The org's events as OpenTelemetry logs, sent to your OTLP/HTTP endpoint. |
| [Feedback](./feedback) | `/v2/feedback` | A report to Runtime's team: a bug, a missing feature, a gap against another provider, a migration blocker, unclear docs, a price, or praise. Every report is read. |

Prices, plans and limits: the [pricing reference](./pricing), generated from the price card billing charges by.

## Authentication

Send an API key as a bearer token in the `Authorization` header. A key acts within one project, and only with the actions its grant allows: each call's action is named on its product's page.

## Versions

The SDKs send `Runtime-Version: 2026-10-27`.

## Idempotency

A create takes an `Idempotency-Key` header. Sent again with the same key, it returns the same resource without making another. The SDKs send a key with every change and reuse it when they retry.

## Labels

Labels are text keys with text values. Keys under `runtime.` are Runtime's own: a request that sets one returns 400 `invalid_argument`.

## Errors

Every error has one shape: `code`, a stable identifier to branch on; `message`, what went wrong; and `requestId`, which names the request when you report a problem.

```json
{ "error": { "code": "not_found", "message": "No such sandbox.", "requestId": "req_1d0b14e4db018fed" } }
```
