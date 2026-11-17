# Browsers

A headless Chromium for an agent, driven with Playwright or Puppeteer over the Chrome DevTools Protocol.

A machine running headless Chromium, driven over the Chrome DevTools Protocol at its preview on port 9222: one WebSocket address for Playwright's `connectOverCDP` and Puppeteer's `connect`, as Browserbase gives one. It pauses after 60 seconds with nothing happening, its memory kept, and a connection resumes it.

| Default | Value |
| --- | --- |
| vCPUs | 2 |
| Memory | 4 GB |
| Disk | 4 GB |
| Image | `runtime/browsers` |
| Pauses when idle | After 60 seconds |

[`POST /v2/browsers`](./reference/browsers#create-a-browser) takes the same [SandboxCreate](./reference/sandboxes#sandboxcreate) as a [sandbox](./sandboxes); every field overrides a default above.

## Connect to the browser

Share port 9222 with a preview. Chromium's DevTools address answers there.

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const browser = await runtime.browsers.create();
try {
  const preview = (await runtime.previews.create(browser.id, { port: 9222 })).info;
  const open = () => fetch(`${preview.url}json/version`, { headers: { "x-runtime-preview-token": preview.token! } });
  let answer = await open();
  for (let i = 0; i < 40 && answer.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    answer = await open();
  }
  const version = await answer.json();
  console.log(version.Browser); // Chrome/...
  if (!String(version.Browser).startsWith("Chrome/")) throw new Error(JSON.stringify(version));
  // Its page as an image, read by the browser itself.
  const shot = await browser.screenshot();
  const png = [0x89, 0x50, 0x4e, 0x47];
  if (!png.every((b, i) => shot[i] === b)) throw new Error("the screenshot is not a PNG");
  console.log(shot.length > 0); // true
} finally {
  await browser.delete();
}
```

[`GET /v2/browsers/{id}/screenshot`](./reference/browsers#screenshot) returns the browser's page as a PNG (or a JPEG, with `format: "jpeg"`), and [`POST /v2/browsers/{id}:act`](./reference/browsers#act) clicks, types, presses keys and scrolls on it, with the same steps as a [desktop's](./desktops): both are the browser's own (the Chrome DevTools Protocol), with no display.

To drive it, pass the preview's address to Playwright's `chromium.connectOverCDP(url, { headers })` or Puppeteer's `puppeteer.connect`, with the token in the `x-runtime-preview-token` header.

## Next steps

- Every call on a browser: [Browser](./reference/browsers).
- A whole desktop for an agent that uses a computer: [desktops](./desktops).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/browsers.md. Give this project's agent a Runtime browser: create one, share port 9222 with a preview, and connect Playwright with `chromium.connectOverCDP` to the preview's url with its token in the `x-runtime-preview-token` header. Delete the browser when the agent is done.
>
> This page as Markdown: https://withruntime.com/docs/browsers.md
