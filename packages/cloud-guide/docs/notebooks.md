# Notebooks

JupyterLab with NumPy, pandas and matplotlib, its kernels kept in memory while it is paused.

A machine running JupyterLab on port 8888 over /workspace, with NumPy, pandas and matplotlib, reached at its private preview. It pauses after 300 seconds with nothing happening, its kernels kept in memory, and a visit resumes it where it was.

| Default | Value |
| --- | --- |
| vCPUs | 2 |
| Memory | 4 GB |
| Disk | 4 GB |
| Image | `runtime/notebooks` |
| Pauses when idle | After 300 seconds |

[`POST /v2/notebooks`](./reference/notebooks#create-a-notebook) takes the same [SandboxCreate](./reference/sandboxes#sandboxcreate) as a [sandbox](./sandboxes); every field overrides a default above.

## Open JupyterLab and run code

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const notebook = await runtime.notebooks.create();
try {
  const sum = await notebook.exec(["python3", "-c", "import pandas as pd; print(pd.Series([125, 250, 375]).sum())"]);
  console.log(sum.stdout); // 750
  const preview = (await runtime.previews.create(notebook.id, { port: 8888 })).info;
  const open = () => fetch(`${preview.url}lab`, { headers: { "x-runtime-preview-token": preview.token! } });
  let page = await open();
  for (let i = 0; i < 60 && page.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    page = await open();
  }
  console.log(page.status); // open the address in a browser for JupyterLab
  if (sum.stdout.trim() !== "750" || page.status !== 200) throw new Error(`${sum.stderr} ${page.status}`);
} finally {
  await notebook.delete();
}
```

## Next steps

- Every call on a notebook: [Notebook](./reference/notebooks).
- Run code an AI model writes, one call at a time: [run an agent's code](./agent-loop).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/notebooks.md. Create a Runtime notebook, upload this project's data to /workspace, share port 8888 with a private preview and print its url with `?runtime_preview_token=` so I can open JupyterLab.
>
> This page as Markdown: https://withruntime.com/docs/notebooks.md
