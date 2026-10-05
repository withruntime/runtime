# Runtime for ComputeSDK

Create Runtime sandboxes through ComputeSDK's provider interface, with commands, streaming, files, preview URLs and snapshots.

`@computesdk/runtime` is a ComputeSDK provider, like its E2B, Modal or Daytona
providers. Change the provider and the same `compute.sandbox` code runs in a
Firecracker microVM with its own kernel. It is built on Runtime's TypeScript
SDK, `withruntime`.

## Install

ComputeSDK publishes its providers to npm itself, from its own repository. The
Runtime provider is written for that repository; this command works once
ComputeSDK has merged and published it:

```bash no-run
npm install computesdk @computesdk/runtime
```

It needs Node.js 22.12 or later. The key comes from `RUNTIME_API_KEY` or this
machine's `npx withruntime login`, as for the rest of the SDK.

## Example

```js
import { runtime } from "@computesdk/runtime";

const compute = runtime({ apiKey: process.env.RUNTIME_API_KEY });
const sandbox = await compute.sandbox.create({ envs: { NODE_ENV: "production" } });
try {
  const result = await sandbox.runCommand("node --version");
  console.log(result.stdout);

  await sandbox.runCommand("python3 -m http.server 3000", { background: true });
  console.log(await sandbox.getUrl({ port: 3000 }));
} finally {
  await sandbox.destroy();
}
```

`sandbox.getInstance()` returns the `withruntime` sandbox, for everything
ComputeSDK's interface does not cover: processes, terminals, network rules,
the desktop and the rest.

## Options

Every option is optional.

| Option              | What it does                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apiKey`            | The API key; defaults to `RUNTIME_API_KEY`, then the key `npx withruntime login` saved                       |
| `baseUrl`           | The API origin; defaults to `RUNTIME_API_URL`, then `https://api.withruntime.com`                            |
| `create`            | Defaults for every create: `funding`, `region`, `image`, `vcpu`, memory, disk, `network` and any other field |
| `previewVisibility` | `private` (default): the URL from `getUrl` carries its token; `public`: anyone with the address, paid only   |
| `previewTtlSeconds` | How long a private preview's token lasts, 60 seconds to 7 days; one day by default                           |

`compute.sandbox.create()` takes ComputeSDK's own options and maps them:
`templateId` is a Runtime [image](./images), `snapshotId` a Runtime snapshot,
`metadata` becomes labels, `timeout` a time limit, `vcpus`, `memoryMiB` and
`diskMiB` the size, and `envs` is set on every command the provider runs in
that sandbox.

## How ComputeSDK's calls behave

- **Commands** run under `bash -c`, for 60 seconds unless `timeout` says
  otherwise (up to 24 hours). One that runs past its timeout returns exit code
  124 with its output so far. `background: true` starts a Runtime process and
  returns at once.
- **Streaming.** `onStdout` and `onStderr` receive output through Runtime's API
  as the command writes it, so ComputeSDK needs no port inside the sandbox.
- **Files** use Runtime's file calls, not shell commands.
- **`getUrl`** shares the port as a private
  [preview](./javascript#share-a-port) and returns a link that carries its
  token. The link works as it is in a browser, `fetch`, `curl` or a
  WebSocket client, until the token expires.
- **`destroy`** stops the sandbox. `getById` returns `null` for a stopped one,
  and a paused one wakes when used.
- **Snapshots** keep files, memory and running processes; `create`, `list` and
  `delete` work, and `snapshotId` starts a sandbox from one.
- **`envs` from create** are held by the provider object that created the
  sandbox. A sandbox reached through `getById` or `list` does not have them;
  pass `env` to `runCommand` there.

## What was verified

On 25 September 2026 the provider was built in a clone of ComputeSDK's
repository (commit `d52afb5`) against `withruntime` 0.5.1 from npm. There its
CommonJS and ESM builds, type declarations, typecheck and lint passed; 28 unit
tests passed with the Runtime SDK mocked; ComputeSDK's shared provider suite
passed against ComputeSDK's own mock sandbox; and both builds loaded
`withruntime` and called a local stand-in for Runtime's API.

With `RUNTIME_API_KEY` set, ComputeSDK's shared suite and the create,
reconnect, list and destroy test run against Runtime itself.
