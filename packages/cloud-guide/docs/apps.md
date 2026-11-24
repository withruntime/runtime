# Apps

Keep a web app running on port 8080, started the way Render and Heroku start one.

A machine that keeps a web app in /app running on port 8080 (its Procfile's `web:`, else `npm start`, else `python3 app.py`, as Render and Heroku start one), reached at its preview. It never pauses for being idle.

| Default | Value |
| --- | --- |
| vCPUs | 2 |
| Memory | 4 GB |
| Disk | 4 GB, or its image's size when larger |
| Image | `runtime/standard` |
| Pauses when idle | Never |

[`POST /v2/apps`](./reference/apps#create-a-app) takes the same [SandboxCreate](./reference/sandboxes#sandboxcreate) as a [sandbox](./sandboxes); every field overrides a default above. An app never pauses, so it is billed for its memory, $0.008 per GiB-hour, the whole time it runs.

## Deploy an app

Upload the app to `/app`, then restart its server.

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const app = await runtime.apps.create();
try {
  await app.files.write("/app/app.py", `from http.server import BaseHTTPRequestHandler, HTTPServer

class Hello(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"hello from a Runtime app")

HTTPServer(("", 8080), Hello).serve_forever()
`);
  await app.exec("sudo pkill -f runtime-app || true; sudo -E -u runtime runtime-app", { wait: false });
  const preview = (await runtime.previews.create(app.id, { port: 8080 })).info;
  const open = () => fetch(preview.url, { headers: { "x-runtime-preview-token": preview.token! } });
  let page = await open();
  for (let i = 0; i < 40 && page.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    page = await open();
  }
  console.log(page.status, await page.text());
  if (page.status !== 200) throw new Error(`the app answered ${page.status}`);
} finally {
  await app.delete();
}
```

## Next steps

- Every call on an app: [App](./reference/apps).
- Keep data across restarts on a volume: [`volumes`](./reference/sandboxes#sandboxcreate).
- A handler that pauses between requests costs less: [functions](./functions).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/apps.md. Deploy this project as a Runtime app: upload it to /app, make sure its Procfile's `web:` (or `npm start`) listens on port 8080, share the port with a preview and print its url.
>
> This page as Markdown: https://withruntime.com/docs/apps.md
