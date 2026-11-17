# Dev environments

A development environment with VS Code in the browser, like Codespaces and Gitpod.

A development environment: a machine running VS Code in the browser (code-server) on port 8080 over /workspace, reached at its private preview, as Codespaces and Gitpod give one. It pauses after 30 minutes with nothing happening, its memory kept.

| Default | Value |
| --- | --- |
| vCPUs | 4 |
| Memory | 8 GB |
| Disk | 16 GB |
| Image | `runtime/workspaces` |
| Pauses when idle | After 30 minutes |

[`POST /v2/workspaces`](./reference/workspaces#create-a-workspace) takes the same [SandboxCreate](./reference/sandboxes#sandboxcreate) as a [sandbox](./sandboxes); every field overrides a default above.

## Open VS Code

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const workspace = await runtime.workspaces.create();
try {
  await workspace.exec("git clone --depth 1 https://github.com/withruntime/examples /workspace/examples || mkdir -p /workspace/examples");
  const preview = (await runtime.previews.create(workspace.id, { port: 8080 })).info;
  const editor = `${preview.url}?folder=/workspace&runtime_preview_token=${preview.token}`;
  let page = await fetch(editor);
  for (let i = 0; i < 60 && page.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    page = await fetch(editor);
  }
  console.log(page.status); // open the address in a browser for VS Code
  if (page.status !== 200) throw new Error(`the workspace answered ${page.status}`);
} finally {
  await workspace.delete();
}
```

## Next steps

- Every call on a workspace: [Workspace](./reference/workspaces).
- Pause it overnight and pick up where you left off: [pause and resume](./pause-and-resume).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/workspaces.md. Create a Runtime workspace, clone this repository into /workspace, share port 8080 with a private preview and print its url with `?runtime_preview_token=` so I can open VS Code.
>
> This page as Markdown: https://withruntime.com/docs/workspaces.md
