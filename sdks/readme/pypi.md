# withruntime

The official client for [Runtime Cloud](https://withruntime.com): Linux machines for AI agents and apps, each a
microVM with its own kernel, disk and network, created in milliseconds and billed for the CPU it uses and the memory
it holds. The client is generated from the API's OpenAPI description, so every product and every operation of
`https://api.withruntime.com/v2` is here, typed.

## Install

```bash
pip install withruntime
```

Python 3.9 or later. The one dependency is httpx; `pip install withruntime[keypair]` adds signing with a key pair.

## Authentication

The client reads your API key from `RUNTIME_API_KEY`. Create a key at https://withruntime.com/account/keys and keep it
in a secret manager, never in source code or a URL. A key pair's `rtsk_` secret also works: the client signs each
request with it and never sends it.

## Quickstart

```python
from withruntime import Sandbox

with Sandbox.create() as sbx:
    sbx.files.write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n")
    result = sbx.exec("python3 /workspace/invoice.py")
    print(result.exit_code, result.stdout)  # 0 750
```

Leaving the `with` block deletes the sandbox. `AsyncRuntime`, `AsyncSandbox` and the other `Async` classes are the
same for asyncio, with `async with` and `await`.

## Configuration

```python
import os
from withruntime import Runtime

runtime = Runtime(
    api_key=os.environ["RUNTIME_API_KEY"],  # the default
    project="prj_...",                      # default: RUNTIME_PROJECT
    base_url="https://api.withruntime.com", # default: RUNTIME_API_URL
    max_retries=3,
)
sbx = runtime.sandboxes.create(vcpu=4, memory_gb=8)
```

## Products

| Class | Create one | What it is |
| --- | --- | --- |
| `Sandbox` | `Sandbox.create()` | A Linux machine with its own kernel, made in milliseconds, paused with its memory kept when idle and resumed where it was. |
| `FunctionMachine` | `FunctionMachine.create()` | A machine that answers HTTP with a handler in /app/index.ts (`export default { fetch(request) }`, as Cloudflare Workers and Vercel take one) on port 8080, reached at its preview. |
| `App` | `App.create()` | A machine that keeps a web app in /app running on port 8080 (its Procfile's `web:`, else `npm start`, else `python3 app.py`, as Render and Heroku start one), reached at its preview. |
| `Site` | `Site.create()` | A machine that serves the static files in /site on port 8080 (as Netlify and Vercel serve a build's output), reached at its preview. |
| `CiMachine` | `CiMachine.create()` | A machine that runs a repository's checks to their end (its `run`) with git, Docker, Node, Bun, Python and a compiler, and is stopped then. |
| `Browser` | `Browser.create()` | A machine running headless Chromium, driven over the Chrome DevTools Protocol at its preview on port 9222: one WebSocket address for Playwright's `connectOverCDP` and Puppeteer's `connect`, as Browserbase gives one. |
| `Desktop` | `Desktop.create()` | A machine running a Linux desktop with Chromium, for agents that use a computer: screenshot returns what its screen shows and act moves and clicks its mouse and types on its keyboard. |
| `Notebook` | `Notebook.create()` | A machine running JupyterLab on port 8888 over /workspace, with NumPy, pandas and matplotlib, reached at its private preview. |
| `Workspace` | `Workspace.create()` | A development environment: a machine running VS Code in the browser (code-server) on port 8080 over /workspace, reached at its private preview, as Codespaces and Gitpod give one. |
| `Container` | `Container.create()` | A machine that runs one OCI image from any registry under Docker on its own network (`start` `runtime-container <image>`), the port it listens on reached at its preview, as Cloud Run and Fly Machines run one. |
| `Build` | `Build.create()` | The machine an image's build runs on: Docker's own builder (BuildKit), its run `runtime-image-build`, deleted once its image is made. |
| `Job` | `Job.create()` | A command run in a fresh machine, once or on a cron schedule in a timezone. |
| `Image` | `Image.create()` | What a machine boots: a root filesystem, its environment and its start. |
| `Volume` | `Volume.create()` | A disk that outlives the machines it is attached to. |
| `Domain` | `Domain.create()` | Your own hostname serving a machine's port, with HTTPS. |

Every machine (each class above with `files`) has `refresh`, `delete`, `pause`, `resume`, `exec`, `metrics`, `fork`, `snapshot`, `update`, `screenshot`, `act`, `run_code`, `spawn`, `files.read`, `files.write`, `files.remove`, `files.stat`, `files.list`, `files.download_folder`, `files.upload_folder`, `files.begin_folder_upload`, `files.write_folder_upload`, `files.commit_folder_upload`, `files.abort_folder_upload`, `files.mkdir`, `files.rename`, `files.link`, `files.revoke_links`, `processes.output`, `processes.write`, `processes.signal`, `processes.resize`, `processes.list`, `network.get`, `network.set`.

- `Sandbox` also has `exec_stream`, `previews.create`.
- `Job` also has `run`.
- `Image` also has `logs`.
- `Domain` also has `verify`.

The API's other resources (keys, projects, roles, secrets, snapshots, webhooks, usage and more) are clients on the
runtime object. The [API reference](https://withruntime.com/docs/reference) lists every operation.

## Errors

Every error the API returns is raised as a `RuntimeApiError` with `code`, `message`, `status`, `request_id`,
`hint`, `param` and `retryable`. Each error family has its own subclass, such as `NotFoundError`,
`InvalidRequestError`, `RateLimitedError` and `CapacityUnavailableError`:

```python
from withruntime import NotFoundError

try:
    runtime.sandboxes.get("sbx_missing")
except NotFoundError as err:
    print(err.code, err.request_id)
```

## Retries and idempotency

The client retries a rate-limited (429) or unavailable (503) answer, and a lost connection on a call that is safe to send again, up to `max_retries` times (default 3). Every write sends an `Idempotency-Key` header, generated when you do not pass `idempotency_key`, so a retry never runs a write twice.

## Lists

A `list` call returns a page; iterating it yields every item across pages:

```python
for s in runtime.sandboxes.list(state="running"):
    print(s.id)
```

## Versioning

The package follows [Semantic Versioning](https://semver.org): a minor or patch release never breaks code written
for an earlier release of the same major version. Each request sends the API version the client was generated for in
the `Runtime-Version` header. Every release is listed in [CHANGELOG.md](CHANGELOG.md).

## Resources

- Guides: https://withruntime.com/docs
- API reference: https://withruntime.com/docs/reference
- Pricing: https://withruntime.com/pricing
- Status: https://status.withruntime.com
- Support: support@withruntime.com

## License

Apache-2.0
