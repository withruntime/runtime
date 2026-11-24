# Desktops

A Linux desktop with Chromium for an agent that uses a computer: the agent reads its screen with [`GET /v2/desktops/{id}/screenshot`](./reference/desktops#screenshot) and moves, clicks, scrolls and types with [`POST /v2/desktops/{id}:act`](./reference/desktops#act), and you watch it in the browser.

A machine running a Linux desktop with Chromium, for agents that use a computer: screenshot returns what its screen shows and act moves and clicks its mouse and types on its keyboard. It is shown in the browser through noVNC at its preview on port 6080; its VNC server answers only inside the machine, so a link signed for that preview is the one way to watch it. It pauses after 300 seconds with nothing happening, its memory kept.

| Default | Value |
| --- | --- |
| vCPUs | 2 |
| Memory | 4 GB |
| Disk | 4 GB, or its image's size when larger |
| Image | `runtime/desktops` |
| Pauses when idle | After 300 seconds |

[`POST /v2/desktops`](./reference/desktops#create-a-desktop) takes the same [SandboxCreate](./reference/sandboxes#sandboxcreate) as a [sandbox](./sandboxes); every field overrides a default above.

## Use the computer

A screenshot is the screen's PNG (or a JPEG, with `format: "jpeg"`), at its own size, 1280 by 800. An act runs its steps in order, as one call: each a `move`, `click`, `mouseDown`, `mouseUp`, `drag`, `scroll`, `type`, `key` or `wait`; it returns where the mouse is then. Coordinates are pixels from the screen's top left corner, as in the screenshot, so a model's click lands where it saw.

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const desktop = await runtime.desktops.create();
try {
  const before = await desktop.screenshot();
  // Chromium is open on the desktop: focus its address bar, type a URL and go.
  const acted = await desktop.act([
    { type: "key", keys: "ctrl+l" },
    { type: "type", text: "https://example.com" },
    { type: "key", keys: "Return" },
    { type: "wait", ms: 1500 },
    { type: "click", x: 640, y: 400 },
  ]);
  const after = await desktop.screenshot({ format: "jpeg", quality: 70 });
  console.log(before.length > 0, after.length > 0, acted.cursor); // true true { x: 640, y: 400 }
} finally {
  await desktop.delete();
}
```

| Step | Takes |
| --- | --- |
| `move` | `x`, `y` |
| `click` | `x`, `y` (where the mouse is when omitted), `button` (`left`, `middle`, `right`), `count` (2 a double click, 3 a triple click), `keys` held (`shift`, `ctrl+alt`) |
| `mouseDown`, `mouseUp` | `button` |
| `drag` | `x`, `y` to press at, `toX`, `toY` to release at, `button` |
| `scroll` | `dy` wheel clicks down (negative up), `dx` right (negative left), `x`, `y`, `keys` held |
| `type` | `text`, any Unicode, at most 8,192 characters an act |
| `key` | `keys`: chords in turn, space-separated, in X key names (`ctrl+l`, `Return`, `ctrl+shift+t`, `Escape`) |
| `wait` | `ms`, at most 20,000 an act |

An act types and waits at most 45 seconds in all, a typed character taking 7 ms: send longer text as several acts. It stops at the first step that fails, or at a key name X does not know, returned 409 `act_failed` with the step's number in `details.step`; the steps before it ran, and every key and button it held down is let go. Both are verbs of every machine, so a sandbox whose image runs an X display at `:1` with `scrot` and `xdotool` takes them too; one with no display returns 409 `display_not_running`. A program starts on the desktop as a process with `DISPLAY=:1` in its environment, for example `chromium https://example.com` through [`POST /v2/desktops/{id}:exec`](./reference/desktops#exec) with `wait: false`.

## Watch the desktop

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const desktop = await runtime.desktops.create();
try {
  const preview = (await runtime.previews.create(desktop.id, { port: 6080 })).info;
  const view = `${preview.url}vnc.html?runtime_preview_token=${preview.token}`;
  let page = await fetch(view);
  for (let i = 0; i < 40 && page.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    page = await fetch(view);
  }
  console.log(page.status, view.split("?")[0]); // open the full address in a browser to watch
  if (page.status !== 200) throw new Error(`the desktop answered ${page.status}`);
} finally {
  await desktop.delete();
}
```

## Next steps

- Every call on a desktop: [Desktop](./reference/desktops).
- A browser alone, driven over CDP: [browsers](./browsers).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/desktops.md. Create a Runtime desktop, take a screenshot, open https://example.com in its Chromium with act (focus the address bar, type the URL, press Return), take another screenshot and save both as PNG files. Share port 6080 with a private preview and print its url with `vnc.html?runtime_preview_token=` so I can watch it. Delete it when I say I'm done.
>
> This page as Markdown: https://withruntime.com/docs/desktops.md
