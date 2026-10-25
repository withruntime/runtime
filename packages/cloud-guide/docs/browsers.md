---
launch: browsers
---

# Browsers

A browser is Chromium on a sandbox of its own, ready to drive: create one and
connect Playwright, Puppeteer, browser-use or Stagehand to its private CDP
address, or ask it for a page's screenshot in one call. It is billed as its
sandbox, at the sandbox rates.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const browser = await runtime.browsers.create({ name: "scraper" });
const shot = await runtime.browsers.screenshot(browser.id, { url: "https://example.com" });
console.log(shot.status, shot.title, shot.bytes);
await browser.delete();
```

```bash no-run
npx withruntime browsers create --name scraper
npx withruntime browsers screenshot scraper https://example.com --out example.png
npx withruntime browsers rm scraper
```

## Connect a client

`cdpUrl` is a `wss://` address with a private token in it; `headers` carry
the same token for clients that send headers. Give both to your client as
they are:

```ts check
import { chromium } from "playwright";
import { Runtime } from "withruntime";

const runtime = new Runtime();
await using browser = await runtime.browsers.create();
const [endpoint, options] = browser.connectOptions().playwright;
const connected = await chromium.connectOverCDP(endpoint, options);
const page = await connected.contexts()[0]!.newPage();
await page.goto("https://example.com");
console.log(await page.title());
```

The token ends at `expiresAt`; `get` the browser again for a fresh
`cdpUrl`, which reads it without waking a paused browser. Inside the sandbox
Chromium is at `http://127.0.0.1:9222`, for code you run there.

## Screenshots

`screenshot` opens `url` in a new tab of the browser's own Chromium, waits
for the page's load event (and `waitMs` more, up to 10 seconds, for late
scripts), and answers the image as `base64` with the page's final `url`,
`title` and HTTP `status`. The tab is closed after; cookies and storage stay
in the browser's profile, so a page you signed in to over CDP is shot signed
in. `fullPage: true` shoots the whole page; `format: "jpeg"` a JPEG. Without
`url` it shoots what the browser shows now, so an agent driving it sees what
it did. A shot runs inside the browser's sandbox: nothing crosses the
network but the image.

## Settings

- **memoryMiB**: 1024 to 16384, 2048 by default. Heavy apps (Google Sheets,
  YouTube, StackBlitz) need 2048; 1024 suits light pages and scraping, and a
  browser under 2048 says so in `hint`.
- **vcpu**: 1 to 16, 1 by default.
- **width** and **height**: the window and every new tab's page, 1280 by 800
  by default.
- **headless**: `false` shows Chromium on a Linux desktop in the sandbox and
  adds `liveViewUrl`, a private live view of it.
- **timeoutSeconds**: 60 to 86400, 3600 by default; at its end the browser
  and its sandbox are deleted.
- **idlePauseSeconds**: it pauses after this long with nothing happening,
  memory kept, and wakes on the next request; 0 never pauses.

A browser's `state` is `starting`, `running`, `paused`, `stopped`, `failed`
or `deleted`. `failed` with `browser_not_running` means Chromium ended; a
screenshot starts it again with the browser's settings. `sandboxId` is its
sandbox's id, for `exec`, files and previews.

## Change and delete

`update` renames a browser (`name: null` clears it) or replaces its labels, at
most 30: two of its sandbox's 32 are Runtime's own. `delete` deletes the
browser, its sandbox and its disk. Lists filter by name, labels and state.

## What it costs

A browser is billed as its sandbox: active CPU and reserved memory while it
runs, at the [sandbox rates](./pricing#browsers-and-desktops). Browsers have
no price of their own; a paused one is billed as a paused sandbox.

## Limits

A browser is a sandbox, so it counts toward the account's sandboxes at once
and their memory ([limits](./limits)).
