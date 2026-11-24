# withruntime

The official client for [Runtime Cloud](https://withruntime.com): Linux machines for AI agents and apps, each a
microVM with its own kernel, disk and network, created in milliseconds and billed for the CPU it uses and the memory
it holds. The client is generated from the API's OpenAPI description, so every product and every operation of
`https://api.withruntime.com/v2` is here, typed.

## Install

```bash
npm install withruntime
```

Node.js 22.12 or later, or Bun. The package has no runtime dependencies.

## Authentication

The client reads your API key from `RUNTIME_API_KEY`. Create a key at https://withruntime.com/account/keys and keep it
in a secret manager, never in source code or a URL. A key pair's `rtsk_` secret also works: the client signs each
request with it and never sends it.

## Quickstart

```ts
import { Sandbox } from "withruntime";

await using sbx = await Sandbox.create();
await sbx.files.write("/workspace/invoice.py", "print(sum([125, 250, 375]))\n");
const result = await sbx.exec("python3 /workspace/invoice.py");
console.log(result.exitCode, result.stdout); // 0 "750\n"
```

`await using` deletes the sandbox when the block ends (Node.js 24, Bun, or TypeScript 5.2 and later). Elsewhere,
call `await sbx.delete()` in a `finally` block.

## Configuration

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime({
  apiKey: process.env.RUNTIME_API_KEY, // the default
  project: "prj_...",                  // default: RUNTIME_PROJECT
  baseUrl: "https://api.withruntime.com", // default: RUNTIME_API_URL
  maxRetries: 3,
});
const sbx = await runtime.sandboxes.create({ vcpu: 4, memoryGB: 8 });
```

## Products

| Class | Create one | What it is |
| --- | --- | --- |
| `Sandbox` | `await Sandbox.create()` | A Linux machine with its own kernel, made in milliseconds, paused with its memory kept when idle and resumed where it was. |
| `FunctionMachine` | `await FunctionMachine.create()` | A machine that answers HTTP with a handler in /app/index.ts (`export default { fetch(request) }`, as Cloudflare Workers and Vercel take one) on port 8080, reached at its preview. |
| `App` | `await App.create()` | A machine that keeps a web app in /app running on port 8080 (its Procfile's `web:`, else `npm start`, else `python3 app.py`, as Render and Heroku start one), reached at its preview. |
| `Site` | `await Site.create()` | A machine that serves the static files in /site on port 8080 (as Netlify and Vercel serve a build's output), reached at its preview. |
| `CiMachine` | `await CiMachine.create()` | A machine that runs a repository's checks to their end (its `run`) with git, Docker, Node, Bun, Python and a compiler, and is stopped then. |
| `Browser` | `await Browser.create()` | A machine running headless Chromium, driven over the Chrome DevTools Protocol at its preview on port 9222: one WebSocket address for Playwright's `connectOverCDP` and Puppeteer's `connect`, as Browserbase gives one. |
| `Desktop` | `await Desktop.create()` | A machine running a Linux desktop with Chromium, for agents that use a computer: screenshot returns what its screen shows and act moves and clicks its mouse and types on its keyboard. |
| `Notebook` | `await Notebook.create()` | A machine running JupyterLab on port 8888 over /workspace, with NumPy, pandas and matplotlib, reached at its private preview. |
| `Workspace` | `await Workspace.create()` | A development environment: a machine running VS Code in the browser (code-server) on port 8080 over /workspace, reached at its private preview, as Codespaces and Gitpod give one. |
| `Container` | `await Container.create()` | A machine that runs one OCI image from any registry under Docker on its own network (`start` `runtime-container <image>`), the port it listens on reached at its preview, as Cloud Run and Fly Machines run one. |
| `Build` | `await Build.create()` | The machine an image's build runs on: Docker's own builder (BuildKit), its run `runtime-image-build`, deleted once its image is made. |
| `Job` | `await Job.create()` | A command run in a fresh machine, once or on a cron schedule in a timezone. |
| `Image` | `await Image.create()` | What a machine boots: a root filesystem, its environment and its start. |
| `Volume` | `await Volume.create()` | A disk that outlives the machines it is attached to. |
| `Domain` | `await Domain.create()` | Your own hostname serving a machine's port, with HTTPS. |

Every machine (each class above with `files`) has `refresh`, `delete`, `pause`, `resume`, `exec`, `metrics`, `fork`, `snapshot`, `update`, `screenshot`, `act`, `runCode`, `spawn`, `files.read`, `files.write`, `files.remove`, `files.stat`, `files.list`, `files.downloadFolder`, `files.uploadFolder`, `files.beginFolderUpload`, `files.writeFolderUpload`, `files.commitFolderUpload`, `files.abortFolderUpload`, `files.mkdir`, `files.rename`, `files.link`, `files.revokeLinks`, `processes.output`, `processes.write`, `processes.signal`, `processes.resize`, `processes.list`, `network.get`, `network.set`.

- `Sandbox` also has `execStream`, `previews.create`.
- `Job` also has `run`.
- `Image` also has `logs`.
- `Domain` also has `verify`.

The API's other resources (keys, projects, roles, secrets, snapshots, webhooks, usage and more) are clients on the
runtime object. The [API reference](https://withruntime.com/docs/reference) lists every operation.

## Errors

Every error the API returns is thrown as a `RuntimeApiError` with `code`, `message`, `status`, `requestId`,
`hint`, `param` and `retryable`. Each error family has its own subclass, such as `NotFoundError`,
`InvalidRequestError`, `RateLimitedError` and `CapacityUnavailableError`:

```ts
import { NotFoundError } from "withruntime";

try {
  await runtime.sandboxes.get("sbx_missing");
} catch (err) {
  if (err instanceof NotFoundError) console.log(err.code, err.requestId);
  else throw err;
}
```

## Retries and idempotency

The client retries a rate-limited (429) or unavailable (503) answer, and a lost connection on a call that is safe to send again, up to `maxRetries` times (default 3). Every write sends an `Idempotency-Key` header, generated when you do not pass `idempotencyKey`, so a retry never runs a write twice. Pass `signal` to cancel a call.

## Lists

A `list` call returns the first page when awaited, and every item across pages when iterated:

```ts
for await (const s of runtime.sandboxes.list({ state: "running" })) console.log(s.id);
```

## Command line and MCP server

The package installs the `runtime` command. It reads `RUNTIME_API_KEY`, or the key that `runtime login` saves:

```bash
npx withruntime login
npx withruntime sandboxes list
npx withruntime --help
```

`runtime mcp` serves every API verb as an MCP tool over stdio. To add it to an MCP client:

```json
{ "mcpServers": { "runtime": { "command": "npx", "args": ["-y", "withruntime", "mcp"], "env": { "RUNTIME_API_KEY": "..." } } } }
```

Drop-in modules for code written against other sandbox SDKs are exported as `withruntime/e2b`, `withruntime/daytona`,
`withruntime/vercel`, `withruntime/blaxel`, `withruntime/morph`, `withruntime/modal`, `withruntime/cloudflare` and
`withruntime/fly`.

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
