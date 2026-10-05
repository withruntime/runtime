# Runtime Cloud Python SDK

One client for every Runtime Cloud product, sync and async. Python 3.10 or
later, standard library only.

```bash no-run
pip install withruntime
```

The client uses `RUNTIME_API_KEY` when it is set, and otherwise the connection
this machine saved when `npx withruntime login` connected it (one browser
approval, no key to copy). On a server or a CI runner, set `RUNTIME_API_KEY`
from your secret manager: `npx withruntime keys create` prints a new key once
after an owner, admin or developer of the account approves it in the browser, or create one at
https://withruntime.com/account/keys. Never put a key in source code, a URL or a
command-line argument.

```python
from withruntime import Sandbox

with Sandbox.create() as sbx:
    sbx.files.write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n")
    result = sbx.exec("python3 /workspace/invoice.py")
    print(result.exit_code, result.stdout)
```

`Sandbox.create()` needs no arguments and returns once the sandbox is running;
leaving the `with` block stops it. With no arguments you get the free trial
while it lasts: 100 free hours, no card, up to eight sandboxes running at once.
The current default image includes NumPy, pandas and matplotlib; see the
[sandbox environment](https://withruntime.com/docs/sandbox-environment).
The trial's hours are spent first, then prepaid credit, with nothing to
choose; `funding` is accepted and ignored.
`AsyncRuntime` is the same client for asyncio, method for method:

```python
import asyncio
from withruntime import AsyncRuntime


async def main():
    async with AsyncRuntime() as runtime:
        async with await runtime.sandboxes.create() as sbx:
            print((await sbx.exec("uname -a")).stdout)


asyncio.run(main())
```

A sandbox has `exec`, `exec_stream`, `spawn`, `terminal`, `forward_port` (any
TCP port in the sandbox on a local port), `files` (read, write,
list, glob, stat, move, remove, upload and download directories), `pause`,
`wake`, `extend`, `update` (its name, environment and settings), `keep_alive`,
`fork`, `snapshot`, `switch_image` (move it to a new image keeping /workspace)
and `delete` (remove it for good), and the
`interpreter`, `network`, `previews`, `desktop`, `mounts` (your S3, R2 or Google
Cloud Storage bucket as a folder), `tailscale` (a paid sandbox on your own
tailnet), `metrics` and `mcp` (servers from the MCP catalog, run in the
sandbox) products. A paused sandbox
also wakes by itself on the next call, and `Sandbox.get_or_create(name)` returns
the sandbox with that name or creates it. A sandbox pauses itself after 60 seconds
with nothing happening in it, keeping its memory and processes, so an
idle sandbox costs no compute; `idle_pause_seconds` sets 10 to 86,400, or 0 for
never. `runtime.sandbox`, `snapshot`, `image`, `volume`, `job`, `domain`,
`port` and `address` name the products as the CLI does. Their existing plural
names remain aliases of the same product clients. The client has `sandboxes`, `images`, `volumes`, `snapshots`, `jobs`,
`secrets`, `limits`, `feedback` and `support`; `webhooks`, `events`, `otel` and
`audit` to watch the account; `domains`, `ports`, `addresses`, `tunnel` and
`network` to connect sandboxes to your own world (paid accounts); and `mcp`,
`sso`, `billing`, `referrals` and `switching`. `runtime.limits.get()` (0.3.1 and later) says whether the key is read-only and
what its agent may still spend today. Every write carries an
idempotency key, so retries never do anything twice; errors are typed and carry
`code`, `hint` and `request_id`. `RuntimeAPIError` and
`RuntimeConnectionError` name the SDK errors without shadowing Python's built-in
errors; the previous `RuntimeError` and `ConnectionError` exports remain aliases.
`runtime.usage_requests("7d")` reads the account's API call counts and error rates;
counts are exact decimal strings, and an empty window has `errorPercent: None`.

## Behind a proxy

The client reads `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (upper or lower
case; lower wins when both are set), sync and async. Calls to the API and
terminal WebSockets go through `HTTPS_PROXY` as a CONNECT tunnel, with any
`user:password@` in its address sent to the proxy. `HTTP_PROXY` is used only
for `http://` addresses, never for the HTTPS API. `NO_PROXY` lists hosts to
reach directly, split by commas or spaces: a name covers its subdomains, a
leading dot is allowed, `host:port` limits it to one port, and `*` means every
host. A proxy address without a scheme is `http://`; only `http://` proxies are
supported, and anything else fails at once with `invalid_proxy`. When a call
cannot get through, the error names the proxy it tried (without the password),
for example `No answer from Runtime at https://api.withruntime.com through the
proxy http://proxy.internal:3128 (HTTPS_PROXY).`

## Code written for E2B

`withruntime.e2b` translates supported E2B Python sandbox calls. Change
the import and set `RUNTIME_API_KEY`:

```python no-run
from withruntime.e2b import Sandbox, AsyncSandbox  # was: from e2b import ...
from withruntime.e2b.code_interpreter import Sandbox  # was: from e2b_code_interpreter import Sandbox
```

Sandboxes get E2B's defaults, 2 vCPU and 512 MiB, and no time limit unless
you pass `timeout`: a sandbox runs while it works and pauses itself when idle.
Timeouts are in seconds, as in E2B's Python SDK. `runtime_create={...}` passes
Runtime's own create fields, for example `{"funding": "trial"}`. What Runtime
does not do the way E2B does raises `NotSupportedException` before anything
happens, naming what to use instead. Importing `withruntime` alone does not
load it. The sync `Sandbox` is generated from the async one by
`scripts/generate_e2b_sync.py`.

## Code written for Daytona or Vercel Sandbox

`withruntime.daytona` and `withruntime.vercel` do the same for Daytona's
Python SDK and Vercel Sandbox's. Change the import:

```python no-run
from withruntime.daytona import Daytona, AsyncDaytona  # was: from daytona import ...
from withruntime.vercel import sandbox  # was: from vercel import sandbox
from withruntime.vercel.sandbox import sync as sandbox  # was: from vercel.sandbox import sync as sandbox
```

Sandboxes get the rival's defaults: Daytona's 1 vCPU, 1 GiB and 3 GiB disk,
pausing after 15 idle minutes; Vercel's 2 vCPUs with 2048 MiB each,
persistent, with no time limit unless you pass one. `runtime_create={...}` passes Runtime's own create
fields. A Daytona or Vercel key is never sent anywhere. What Runtime does not do
the same way raises `NotSupportedError` before anything happens, naming what to
use instead. The sync modules are generated from the async ones by
`scripts/generate_dropin_sync.py`. `DAYTONA.md` and `VERCEL.md` in the
JavaScript package list every mapping and gap.

## Code written for Blaxel

`withruntime.blaxel` translates supported Blaxel Python sandbox calls (`blaxel`
0.4.11) on Runtime. Change the import and set `RUNTIME_API_KEY`, or run
`npx withruntime login` once:

```python no-run
from withruntime.blaxel import SandboxInstance  # was: from blaxel.core import SandboxInstance
from withruntime.blaxel import SyncSandboxInstance  # was: from blaxel.core import SyncSandboxInstance
```

`withruntime.blaxel.core` holds the same names, so replacing `blaxel.` with
`withruntime.blaxel.` works too. A Runtime key in `BL_API_KEY` is used; a
Blaxel key is never sent anywhere.

How it maps:

- **Sandboxes.** `create`, `create_if_not_exists` (one sandbox when two calls
  race), `get`, `get_by_external_id`, `list`, `delete`, `fork`, `snapshots` and
  the `update_*` calls work. `memory` is kept, with one vCPU for every 2048 MB.
  Blaxel's general templates (`blaxel/base-image`, `py-app`, `ts-app`, `node`,
  `jupyter-server`, `docker-in-sandbox`) run on Runtime's image. Any other
  image `ns/name:tag` starts from the ready Runtime image `ns-name:tag`
  (every `/` becomes `-`; the tag is `latest` when none is given), so the
  code keeps Blaxel's image string. A missing one raises `NotSupportedError`
  with the build command, for example `npx withruntime image build
--dockerfile Dockerfile --name my-company-agent-image -t
my-company-agent-image:latest`. Volumes mount Runtime volumes of the same
  name. On the free trial a sandbox has at most 4096 MB of memory (2 vCPUs).
- **Standby.** A sandbox pauses after a minute with no call (Blaxel: about 15
  seconds). It keeps its memory and processes, and wakes on the next command,
  file call or preview visit. `archive` pauses it and keeps its memory too.
  It has no time limit, so a long command is never paused on a clock.
  `keep_alive` raises the idle pause to the process's time limit, or turns it
  off for a process with none. The first call from any client that finds no
  `keep_alive` process running gives the old idle pause back.
- **How long it is kept.** A paused sandbox with no `ttl` or `lifecycle` is
  kept 365 days. Blaxel keeps it until you delete it. A limit is rounded up to
  whole days of pause. A limit of an hour or less that counts from creation
  also ends the sandbox at that time. On the free trial a paused sandbox is kept
  seven days, the most Blaxel's first tier keeps one.
- **Envs** reach every process, from any client: they are kept on the
  sandbox, and a process's own `env` wins.
- **Paths.** `/blaxel`, Blaxel's working directory and `HOME`, is
  `/workspace`. Relative paths and `~` start there.
- **Processes.** You can find a process by name from any client, as long as
  Runtime still has its record. Runtime keeps the running processes and the
  last 16 that ended.
- **Previews** are Runtime previews of each port. A private preview's
  `tokens.create(expires_at)` gives a token, which works as Blaxel's
  `X-Blaxel-Preview-Token` header or `bl_preview_token` address parameter.
  `fetch(port)` uses a private preview for you.
- **Code interpreter.** `CodeInterpreter.run_code` and `create_code_context`
  run on Runtime's interpreter and return Blaxel's result classes.
- **Errors.** Errors keep Blaxel's classes: `SandboxAPIError`,
  `ResponseError` and `SnapshotAPIError`. Each also carries Runtime's `code`,
  `hint` and `request_id`.
- **Runtime fields.** `runtime_create={...}` passes Runtime's own create
  fields, for example `{"funding": "trial"}`. `sandbox.withruntime` is the
  Runtime sandbox underneath.

Differences you can hit:

- Commands run as root, as on Blaxel, with the sandbox's `PATH` and `HOME`
  (`/workspace`). File calls act as the sandbox user and fall back to `sudo`
  where only root may: they reach files a root process made, including private
  ones, and a file they write is the sandbox user's.
- A key sees the sandboxes it made, and another key's answer 404, unless an
  owner or admin makes the key account-wide, as a Blaxel workspace key is
  ([teams](https://withruntime.com/docs/teams#keys-in-a-team)).
- Public previews need a paid sandbox.
- A process's `pid` is Runtime's process id, not an operating-system number.
- `sandbox.sessions` makes a Runtime sandbox session, and
  `SandboxInstance.from_session` drives the sandbox with its token: commands,
  files and previews of that one sandbox. A session lasts a day at most, and
  `Access-Control-Allow-Origin` in `response_headers` names the page that may
  use it.

These raise `NotSupportedError` before anything happens, naming what to use:
regions outside the US, read-only and ephemeral volumes, drives, `extra_args`
other than `iptables`, egress and subnet settings, preview headers, custom
domains and preview expiry, restoring a snapshot in place (fork from it
instead), codegen, `system`, schedules, and Blaxel's agents, models,
tools, jobs and applications. The sync module is generated from the async one
by `scripts/generate_dropin_sync.py`.

## Agent frameworks

`withruntime.openai_agents` is a sandbox client for the OpenAI Agents SDK's
`SandboxAgent` (`pip install "withruntime[openai-agents]"`), and
`withruntime.deepagents` is a Deep Agents sandbox backend. `withruntime.tools`
gives LangChain, CrewAI, LlamaIndex, Pydantic AI, Google ADK and any framework
that takes typed functions four sandbox tools. See
https://withruntime.com/docs/frameworks.

## Reliability and support

- **Status:** https://withruntime.com/status checks the API from outside every
  two minutes and starts a real sandbox every ten, with every day's record
  kept; also as https://withruntime.com/status.md and
  https://withruntime.com/status.json.
- **Uptime Promise:** paid accounts are promised 99% API uptime
  each calendar month, and a month below it pays 10% of that
  month's charges back as credit, automatically
  (https://withruntime.com/legal/sla).
- **Security and compliance:** https://withruntime.com/docs/trust.
- **What changed:** https://withruntime.com/changelog.
- **Help:** `npx withruntime support "<question>"`, or
  `npx withruntime feedback "<text>"` for anything that got in your way.

Docs: https://withruntime.com/docs/python.

The package was called `withruntime-cloud`, imported as `runtime_cloud`, until
0.3.0. That name stopped at 0.5.1 and gets no new releases: use `withruntime`.
