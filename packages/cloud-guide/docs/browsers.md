---
launch: browsers
---

# Browsers

A browser is Chromium on its own sandbox, ready to drive. Create one, then
connect Playwright, Puppeteer, browser-use or Stagehand to its private CDP
address. Or request a page's screenshot in one call. It is billed as its
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

## Run a task

A run does a task you describe in plain words. An agent opens Chromium in a
sandbox of its own, browses until the task is done, and returns the answer.
Each step's page is kept as a JPEG frame: the run's recording.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const run = await runtime.browsers.run({
  task: "Find the title of the page",
  startUrl: "https://example.com",
});
console.log(run.state, run.output ?? run.error);
```

```bash no-run
npx withruntime secrets set ANTHROPIC_API_KEY --host api.anthropic.com
npx withruntime browsers run "Find the title of the page" --url https://example.com --frames ./frames
```

The agent is [browser-use](https://github.com/browser-use/browser-use) with
your model. The model's key is your [egress secret](./security#secrets-sandboxes-never-see),
so the sandbox never holds it: `ANTHROPIC_API_KEY` for `claude-` models (the
default, `claude-sonnet-5-5`), `OPENAI_API_KEY` for `gpt-` and o-series models,
and `GEMINI_API_KEY` for `gemini-` models. A run whose key is not stored is
refused with 403 and the command that stores it.

`POST /v1/browsers/runs` returns the run immediately with state `queued`. It
moves to `running`, then ends `done` (with `output`), `failed` (with `error`)
or `stopped`. `runtime.browsers.run` waits for the end; `runs.create` does not.

| Field            |                                                                 |
| ---------------- | --------------------------------------------------------------- |
| `task`           | What to do, up to 16 KiB. Required.                             |
| `startUrl`       | An `http://` or `https://` page to open before the first step.  |
| `model`          | A `claude-`, `gpt-`, `o1`, `o3`, `o4` or `gemini-` model.       |
| `maxSteps`       | 1 to 200; 30 by default.                                        |
| `allowedDomains` | Only these domains are opened (`example.com`, `*.example.com`). |
| `labels`         | Up to 30 labels.                                                |

`runs.steps(id)` returns its steps, paginated by `after`, each with the page's
`url`, `title`, the agent's `goal`, its `actions` and the `frame` (base64 JPEG,
at most 40 KiB; `frames=false` leaves it out). With `wait` (seconds, up to 30)
the request is held until a new step arrives. `runs.follow(id)` returns every
step as it arrives until the run ends. Steps are kept after the run ends.
`runs.stop(id)` stops a run and deletes its sandbox.

Each API key has its own runs agent, `browser-runs-<id>` on the
[Agents](./agents) page, which the key's first run creates. A run executes on
the key that starts it and on no other key, with that key's permissions,
egress secrets and limits. If an agent with that name was set by another key,
the run returns 409 `conflict`; delete it with `runtime agents rm <name>` and
start the run again. `runs.list()` returns the runs of every runs agent the key
can read. The console's Run button on the Browsers page starts runs of a runs
agent that one of your own keys created, once one exists. It never uses another
member's agent, or a runs agent changed from the `browser` template.

The agent solves no CAPTCHAs and does not disguise the browser. Sites see
Chromium as it is.

## Connect a client

`cdpUrl` is a `wss://` address with a private token in it. `headers` carry the
same token for clients that send headers. Give both to your client unchanged:

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

The token expires at `expiresAt`. Call `get` again for a fresh `cdpUrl`. `get`
does not wake a paused browser. Inside the sandbox, Chromium is at
`http://127.0.0.1:9222`, for code you run there.

## Screenshots

`screenshot` opens `url` in a new tab of the browser's own Chromium. It waits
for the page's load event, plus `waitMs` more (up to 10 seconds) for late
scripts. It returns the image as `base64`, with the page's final `url`, `title`
and HTTP `status`. The tab is closed afterward. Cookies and storage stay in the
browser's profile, so a page you signed in to over CDP is shot signed in.
`fullPage: true` shoots the whole page. `format: "jpeg"` returns a JPEG. Without
`url`, it shoots what the browser shows now, so an agent sees what it did. A
shot runs inside the browser's sandbox. Nothing crosses the network except the
image.

## Settings

- **memoryMiB**: 1024 to 16384, 2048 by default. Heavy apps (Google Sheets,
  YouTube, StackBlitz) need 2048. 1024 suits light pages and scraping. A browser
  under 2048 says so in `hint`.
- **vcpu**: 1 to 16, 1 by default.
- **width** and **height**: the window and every new tab's page, 1280 by 800
  by default.
- **headless**: `false` shows Chromium on a Linux desktop in the sandbox and
  adds `liveViewUrl`, a private live view of it.
- **timeoutSeconds**: 60 to 86400, 3600 by default. When it ends, the browser
  and its sandbox are deleted.
- **idlePauseSeconds**: the browser pauses after this long with no activity,
  with memory kept. It wakes on the next request. 0 never pauses.

A headless browser at the default `width` and `height` starts from a
snapshot of Chromium that is already running, so its create returns as soon
as its sandbox runs. Each copy has its own CDP secret, its own random state
(`crypto.getRandomValues()` and, in every page, `Math.random()`), and an empty
profile: no cookies, storage, history or cache. Any other settings start
Chromium in the new sandbox, which takes 1 to 3 seconds.

A browser's `state` is `starting`, `running`, `paused`, `stopped`, `failed`
or `deleted`. `failed` with `browser_not_running` means Chromium has exited. A
screenshot starts it again with the browser's settings. `sandboxId` is its
sandbox's id, for `exec`, files and previews.

## Change and delete

`update` renames a browser (`name: null` clears it) or replaces its labels, at
most 30. Two of its sandbox's 32 are Runtime's own. `delete` deletes the
browser, its sandbox and its disk. Lists filter by name, labels and state.

## What it costs

A browser is billed as its sandbox: active CPU and reserved memory while it
runs, at the [sandbox rates](./pricing#browsers-and-desktops). Browsers have
no price of their own. A paused one is billed as a paused sandbox. A run is
billed as its sandbox's time at the same rates (2 vCPU, 4 GiB, deleted when
the run ends); the model's use is billed to your key by its provider.

## Limits

A browser is a sandbox, so it counts toward the account's sandboxes immediately
and their memory ([limits](./limits)).
