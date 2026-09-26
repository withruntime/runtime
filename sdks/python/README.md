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
    result = sbx.exec("python3 -c 'print(6 * 7)'")
    print(result.exit_code, result.stdout)
```

`Sandbox.create()` needs no arguments and returns once the sandbox is running;
leaving the `with` block stops it. With no arguments you get the free trial
while it lasts: 100 free hours, no card, up to eight sandboxes running at once.
The current default image includes NumPy, pandas and matplotlib; see the
[sandbox environment](https://withruntime.com/docs/sandbox-environment).
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
`wake`, `extend`, `update`, `keep_alive`, `fork` and `snapshot`, and the
`interpreter`, `network`, `previews` and `desktop` products. A paused sandbox
also wakes by itself on the next call, and `Sandbox.get_or_create(name)` returns
the sandbox with that name or creates it. The client has `sandboxes`, `images`,
`volumes`, `snapshots`, `limits`, `feedback` and `support`;
`runtime.limits.get()` (0.3.1 and later) says whether the key is read-only and
what its agent may still spend today. Every write carries an
idempotency key, so retries never do anything twice; errors are typed and carry
`code`, `hint` and `request_id`.

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

`withruntime.e2b` runs code written for E2B's Python SDK on Runtime. Change
the import and set `RUNTIME_API_KEY`:

```python no-run
from withruntime.e2b import Sandbox, AsyncSandbox  # was: from e2b import ...
from withruntime.e2b.code_interpreter import Sandbox  # was: from e2b_code_interpreter import Sandbox
```

Sandboxes get E2B's defaults: 2 vCPU, 512 MiB and a 300-second timeout.
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
pausing after 15 minutes without calls; Vercel's 2 vCPUs with 2048 MiB each, 5
minutes, persistent. `runtime_create={...}` passes Runtime's own create
fields. A Daytona or Vercel key is never sent anywhere. What Runtime does not do
the same way raises `NotSupportedError` before anything happens, naming what to
use instead. The sync modules are generated from the async ones by
`scripts/generate_dropin_sync.py`. `DAYTONA.md` and `VERCEL.md` in the
JavaScript package list every mapping and gap.

## Agent frameworks

`withruntime.openai_agents` is a sandbox client for the OpenAI Agents SDK's
`SandboxAgent` (`pip install "withruntime[openai-agents]"`), and
`withruntime.deepagents` is a Deep Agents sandbox backend. `withruntime.tools`
gives LangChain, CrewAI, LlamaIndex, Pydantic AI, Google ADK and any framework
that takes typed functions four sandbox tools. See
https://withruntime.com/docs/frameworks.

Docs: https://withruntime.com/docs/python.

The package was called `withruntime-cloud`, imported as `runtime_cloud`, until
0.3.0. That name stopped at 0.5.1 and gets no new releases: use `withruntime`.
