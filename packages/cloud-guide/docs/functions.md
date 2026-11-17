# Functions

Answer HTTP requests with one TypeScript handler that pauses when idle and resumes on the next request.

A machine that answers HTTP with a handler in /app/index.ts (`export default { fetch(request) }`, as Cloudflare Workers and Vercel take one) on port 8080, reached at its preview. It pauses after 60 seconds with nothing happening, its memory kept, and a request resumes it.

| Default | Value |
| --- | --- |
| vCPUs | 1 |
| Memory | 1 GB |
| Disk | 4 GB |
| Image | `runtime/standard` |
| Pauses when idle | After 60 seconds |

A function is a machine like a [sandbox](./sandboxes): [`POST /v2/functions`](./reference/functions#create-a-function) takes the same [SandboxCreate](./reference/sandboxes#sandboxcreate), and every field overrides a default above. You pay for the CPU it uses while it answers, $0.03 per busy vCPU-hour, and nothing for CPU while it is paused.

## Deploy a handler

Write the handler to `/app/index.ts`. The function serves the new file on the next request.

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const fn = await runtime.functions.create();
try {
  await fn.files.write("/app/index.ts", `export default {
  fetch(request: Request) {
    return Response.json({ path: new URL(request.url).pathname });
  },
};
`);
  const preview = (await runtime.previews.create(fn.id, { port: 8080 })).info;
  let answer = await fetch(`${preview.url}hello`, { headers: { "x-runtime-preview-token": preview.token! } });
  for (let i = 0; i < 20 && answer.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 250)); // the handler may still be loading
    answer = await fetch(`${preview.url}hello`, { headers: { "x-runtime-preview-token": preview.token! } });
  }
  console.log(answer.status, await answer.text()); // 200 {"path":"/hello"}
  if (answer.status !== 200) throw new Error(`the function answered ${answer.status}`);
} finally {
  await fn.delete();
}
```

A private preview needs its token in the `x-runtime-preview-token` header. Make it public with [`visibility`](./reference/previews#previewcreate) to serve anyone. See [previews](./web-app).

## Next steps

- Every call on a function: [Function](./reference/functions).
- Keep secrets out of the handler's code with [secrets](./secrets).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/functions.md. Deploy this project's HTTP handler as a Runtime function: write it to /app/index.ts, share port 8080 with a preview, call it once and print the answer and the preview's url.
>
> This page as Markdown: https://withruntime.com/docs/functions.md
