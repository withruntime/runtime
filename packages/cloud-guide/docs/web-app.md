# Serve a web app

A preview gives one port of a machine an HTTPS address. Use it to show an agent's work, run a dev server, or test a web app before you deploy it.

## Start a server and share its port

Start the server with [`POST /v2/sandboxes/{id}:exec`](./reference/sandboxes#exec) and [`wait`](./reference/sandboxes#execrequest) false, so it keeps running after the call returns. Then share its port with [`POST /v2/sandboxes/{id}/previews`](./reference/previews#create-a-preview).

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const sandbox = await runtime.sandboxes.create();
try {
  const app = `require("http").createServer((req, res) => res.end("hello from " + req.url)).listen(3000);`;
  await sandbox.files.write("/workspace/server.js", app);
  await sandbox.exec(["node", "/workspace/server.js"], { wait: false });

  const preview = (await runtime.previews.create(sandbox.id, { port: 3000 })).info;
  // A private preview needs its token, in a header (or `?runtime_preview_token=` for a browser).
  const open = () => fetch(preview.url, { headers: { "x-runtime-preview-token": preview.token! } });
  let page = await open();
  for (let i = 0; i < 20 && page.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 250)); // the server may still be starting
    page = await open();
  }
  console.log(page.status, await page.text());
  if (page.status !== 200) throw new Error(`preview answered ${page.status}`);
} finally {
  await sandbox.delete();
}
```

## Private and public previews

- [`visibility`](./reference/previews#previewcreate): `private` (default): a token is needed. `public`: anyone with the address.
- [`token`](./reference/previews#preview): A token signed for this answer, for a private preview and a key that may create one: send it in the `x-runtime-preview-token` header, or open the url with `?runtime_preview_token=<token>` in a browser. [`tokenExpiresAt`](./reference/previews#preview) says when it stops working.
- [`ttlSeconds`](./reference/previews#previewcreate): The token's lifetime in seconds, from 60 until the calling key's own end (a year at most); a day when omitted, or the key's end when that is sooner.
- [`embedOrigins`](./reference/previews#previewcreate): The sites that may show it in an iframe; omitted on one that exists, kept as it is; empty for any site.
- [`POST /v2/previews/{name}:rotate`](./reference/previews#rotate) refuses every token issued so far. [`POST /v2/previews/{name}:sign`](./reference/previews#sign) issues a new one.
- [`DELETE /v2/previews/{name}`](./reference/previews#delete-a-preview) stops sharing the port.

A preview's address answers once its [`state`](./reference/previews#preview) is `ready`. Deleting a machine removes its previews.

## Next steps

- Keep the app's files between sessions with [snapshots](./snapshots).
- Expose a raw TCP port instead of HTTPS with [`POST /v2/ports`](./reference/ports#create-a-port) ([networking](./networking)).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/web-app.md. Run this project's web server in a Runtime sandbox, share its port with a private preview, and print the preview's url with its token (`?runtime_preview_token=`) so I can open it. Delete the preview and the sandbox when I say I'm done.
>
> This page as Markdown: https://withruntime.com/docs/web-app.md
