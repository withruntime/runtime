# Switch from Vercel Sandbox

| Vercel Sandbox | Runtime |
| --- | --- |
| `Sandbox.create({ source, ports })` | [`POST /v2/sandboxes`](./reference/sandboxes#create-a-sandbox), then write or clone your code in it |
| `sandbox.runCommand(cmd, args)` | [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) |
| `sandbox.runCommand({ detached: true })` | [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) with [`wait`](./reference/sandboxes#execrequest) false |
| `sandbox.writeFiles(files)` | [`PUT /v2/sandboxes/{id}/files`](./reference/sandboxes#write) |
| `sandbox.domain(port)` | [`POST /v2/sandboxes/{id}/previews`](./reference/previews#create-a-preview) |
| `sandbox.stop()` | [`DELETE /v2/sandboxes/{id}`](./reference/sandboxes#delete-a-sandbox), or [`POST /v2/sandboxes/{id}:pause`](./reference/sandboxes#pause) to keep it |

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const sandbox = await runtime.sandboxes.create({});
try {
  const r = await runtime.sandboxes.exec(sandbox.id, { cmd: ["node", "-e", "console.log(process.version.startsWith('v'))"] });
  console.log(r.stdout); // true
  if (r.stdout.trim() !== "true") throw new Error(r.stderr);
} finally {
  await runtime.sandboxes.delete(sandbox.id);
}
```

A Vercel sandbox ends at its timeout. A Runtime sandbox has no timeout: it pauses when nothing happens in it and resumes on the next call.

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/switch-from-vercel.md. Replace every Vercel Sandbox call in this project with its Runtime call, on a branch, run the project's tests and its real job on Runtime, and fix what fails. Never delete the Vercel project or its tokens.
>
> This page as Markdown: https://withruntime.com/docs/switch-from-vercel.md
