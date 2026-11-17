# Switch from E2B

Runtime's sandboxes do what E2B's do, with pause and resume that keep memory, forks of a running sandbox, and CPU billed on use ($0.03 per busy vCPU-hour). Most code moves by renaming calls.

| E2B | Runtime |
| --- | --- |
| `Sandbox.create()` | [`POST /v2/sandboxes`](./reference/sandboxes#create-a-sandbox) |
| `sbx.commands.run(cmd)` | [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec), which returns a non-zero `exitCode` instead of throwing |
| `sbx.commands.run(cmd, { background: true })` | [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) with [`wait`](./reference/sandboxes#execrequest) false |
| `sbx.files.write(path, data)` | [`PUT /v2/sandboxes/{id}/files`](./reference/sandboxes#write) |
| `sbx.files.read(path)` | [`GET /v2/sandboxes/{id}/files`](./reference/sandboxes#read) |
| `sbx.getHost(port)` | [`POST /v2/sandboxes/{id}/previews`](./reference/previews#create-a-preview), private by default |
| `sbx.betaPause()`, `Sandbox.connect(id)` | [`POST /v2/sandboxes/{id}:pause`](./reference/sandboxes#pause), [`POST /v2/sandboxes/{id}:resume`](./reference/sandboxes#resume) |
| `sbx.kill()` | [`DELETE /v2/sandboxes/{id}`](./reference/sandboxes#delete-a-sandbox) |
| Templates | [snapshots](./snapshots) |

## Before and after

E2B:

```ts
import { Sandbox } from "e2b";

const sbx = await Sandbox.create();
await sbx.files.write("/home/user/step.py", "print(21 * 2)");
const r = await sbx.commands.run("python3 /home/user/step.py");
console.log(r.stdout);
await sbx.kill();
```

Runtime:

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const sbx = await runtime.sandboxes.create({});
try {
  await runtime.sandboxes.write(sbx.id, new TextEncoder().encode("print(21 * 2)"), { path: "/tmp/step.py" });
  const r = await runtime.sandboxes.exec(sbx.id, { cmd: ["python3", "/tmp/step.py"] });
  console.log(r.stdout); // 42
  if (r.stdout.trim() !== "42") throw new Error(r.stderr);
} finally {
  await runtime.sandboxes.delete(sbx.id);
}
```

What changes besides the names:

- Commands run as the user `runtime` in `/workspace`, with `sudo` and no password; there is no `/home/user`.
- [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) takes the program and its arguments as a list. For a shell line, pass `["bash", "-c", line]`.
- A sandbox with nothing happening pauses by itself and the next call resumes it, so there is no timeout to keep extending. See [pause and resume](./pause-and-resume).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/switch-from-e2b.md. Replace every E2B call in this project with its Runtime call, on a branch, remove the E2B SDK, run the project's tests and its real job on Runtime, and fix what fails. Never delete the E2B account or its keys.
>
> This page as Markdown: https://withruntime.com/docs/switch-from-e2b.md
