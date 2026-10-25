---
launch: desktops
---

# Desktops

A desktop is a Linux desktop on a sandbox of its own, for agents that use a
computer the way a person does: watch it through a private live view, take
screenshots, move the mouse, click, type and open pages in its Chromium. It
is billed as its sandbox, at the sandbox rates.

```ts check
import { Runtime } from "withruntime";

const runtime = new Runtime();
const desktop = await runtime.desktops.create({ name: "qa", width: 1280, height: 800 });
console.log(desktop.liveViewUrl);
await runtime.desktops.act(desktop.id, { action: "open", url: "https://example.com" });
const png = await runtime.desktops.screenshot(desktop.id);
console.log(png.length);
await runtime.desktops.delete(desktop.id);
```

```bash no-run
npx withruntime desktops create --name qa
npx withruntime desktops open qa https://example.com
npx withruntime desktops screenshot qa --out screen.png
npx withruntime desktops rm qa
```

## Computer use

`act` takes one step at a time:

- `move`, `click` (`double` for a double click), `mouseDown`, `mouseUp`,
  `drag` (`from`, `to`) and `scroll` (`dy`, `dx`), by pixel `x` and `y`;
- `type` (`text`, `delayMs`) and `key` (xdotool names: `ctrl+l`, `Return`);
- `windows` lists the windows, `focus` brings one forward, `cursor` says
  where the pointer is;
- `open` opens a `url` in Chromium; `launch` runs a program (`argv`).

`screenshot` (`POST /v1/desktops/{id}:screenshot`) answers the screen as PNG,
or JPEG with `{"format": "jpeg"}`. Like `act` and the live view, it needs a
key that may run commands: a read-only key reads a desktop's state, never its
screen. The MCP tools are `runtime_desktops_act` and
`runtime_desktops_screenshot`.

## Settings

- **width** and **height**: the screen, 640x480 to 3840x2160, 1280 by 800 by
  default.
- **memoryMiB**: 1024 to 16384, 2048 by default; **vcpu**: 1 to 16, 2 by
  default.
- **timeoutSeconds**: 60 to 86400, 3600 by default; at its end the desktop and
  its sandbox are deleted.
- **idlePauseSeconds**: it pauses after this long with nothing happening,
  memory kept, and wakes on the next request; 0 never pauses.

`liveViewUrl` opens the live desktop in a browser and carries a private token
that ends at `expiresAt`; `get` the desktop again for a fresh one, which
never wakes a paused desktop. `sandboxId` is its sandbox's id, and
`actions.record` records the screen to an MP4 in the sandbox.

## Change and delete

`update` renames a desktop or replaces its labels, at most 30. `delete`
deletes the desktop, its sandbox and its disk.

## What it costs

A desktop is billed as its sandbox: active CPU and reserved memory while it
runs, at the [sandbox rates](./pricing#browsers-and-desktops). Desktops have
no price of their own.

## Limits

A desktop is a sandbox, so it counts toward the account's sandboxes at once
and their memory ([limits](./limits)).
