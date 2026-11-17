# Sites

Serve a folder of static files at an HTTPS address, paused when nobody visits.

A machine that serves the static files in /site on port 8080 (as Netlify and Vercel serve a build's output), reached at its preview. It pauses after 60 seconds with nothing happening, its memory kept, and a visit resumes it.

| Default | Value |
| --- | --- |
| vCPUs | 1 |
| Memory | 1 GB |
| Disk | 4 GB |
| Image | `runtime/sites` |
| Pauses when idle | After 60 seconds |

[`POST /v2/sites`](./reference/sites#create-a-site) takes the same [SandboxCreate](./reference/sandboxes#sandboxcreate) as a [sandbox](./sandboxes); every field overrides a default above.

## Publish a page

Write files under `/site`. Upload a whole build folder at once with [`PUT /v2/sites/{id}/files/archive`](./reference/sites#uploadfolder).

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const site = await runtime.sites.create();
try {
  await site.exec("sudo install -d -o runtime /site");
  await site.files.write("/site/index.html", "<h1>Hello from a Runtime site</h1>\n");
  const preview = (await runtime.previews.create(site.id, { port: 8080 })).info;
  const open = () => fetch(preview.url, { headers: { "x-runtime-preview-token": preview.token! } });
  let page = await open();
  for (let i = 0; i < 20 && page.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    page = await open();
  }
  console.log(page.status, await page.text());
  if (page.status !== 200) throw new Error(`the site answered ${page.status}`);
} finally {
  await site.delete();
}
```

To serve it to anyone, make the preview public with [`visibility`](./reference/previews#previewcreate) "public": a public preview needs an account with a kept top-up, and needs no token. Serve it at your own domain with [`POST /v2/domains`](./reference/domains#create-a-domain) ([networking](./networking)).

## Next steps

- Every call on a site: [Site](./reference/sites).
- A server that renders pages instead: [apps](./apps).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/sites.md. Build this project's static site, upload its output folder to a Runtime site's /site, share port 8080 with a preview and print its url with `?runtime_preview_token=` so I can open it.
>
> This page as Markdown: https://withruntime.com/docs/sites.md
