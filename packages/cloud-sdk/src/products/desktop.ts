import type { Sandbox } from "../sandbox.js";
import type { RequestOptions, Transport } from "../transport.js";
import type { Preview } from "./previews.js";

export type MouseButton = "left" | "middle" | "right";
export type DesktopWindow = {
  id: string;
  desktop: number;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  className: string;
  title: string;
};
export type DesktopStart = {
  ok: boolean;
  display: string;
  size: string;
  /** Opens the live desktop (noVNC) in a browser; carries a private preview token. */
  streamUrl: string;
  preview: Preview;
};

export type DesktopRecording = {
  id: string;
  state: "starting" | "installing" | "recording" | "finished" | "failed";
  /** The MP4 file in the sandbox. */
  path: string;
  bytes: number;
  seconds?: number;
  /** Why it ended: stopped, max-seconds, max-bytes, disk-low, desktop-gone, error. */
  reason: string | null;
  startedAt?: number | null;
};
export type RecordOptions = {
  /** Frames a second, 1 to 30. Default 10. */
  fps?: number;
  /** Stop after this much video, up to 7200. Default 1800. */
  maxSeconds?: number;
  /** The file never grows past this, 16 to 4096. Default 512. */
  maxMiB?: number;
  /** Quality, 18 (sharp, large) to 45 (small). Default 30. */
  crf?: number;
};

/** `sbx.desktop`: a Linux desktop in the sandbox, driven like a person would.
 *
 *   const { streamUrl } = await sbx.desktop.start();
 *   await sbx.desktop.open("https://example.com");
 *   await sbx.desktop.click(640, 400);
 *   await sbx.desktop.type("hello");
 *   const png = await sbx.desktop.screenshot();
 *
 * Coordinates are pixels from the top left of the screen. */
export function sandboxDesktop(t: Transport, sandbox: Sandbox) {
  const base = () => `/v1/sandboxes/${encodeURIComponent(sandbox.id)}/desktop`;
  const act = <T = { ok: true }>(body: Record<string, unknown>, options?: RequestOptions) =>
    t.json<T>({ method: "POST", path: `${base()}:act`, body, ...options });
  return {
    /** Starts the desktop. The first start in a sandbox installs it, which
     * takes a minute or two; this waits for that (up to 10 minutes). */
    async start(size: { width?: number; height?: number } = {}, options?: RequestOptions) {
      const deadline = Date.now() + 600_000;
      for (;;) {
        try {
          return await t.json<DesktopStart>({
            method: "POST",
            path: `${base()}:start`,
            body: size,
            ...options,
          });
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== "desktop_installing" || Date.now() > deadline) throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, (error as { retryAfterMs?: number }).retryAfterMs ?? 10_000),
          );
        }
      }
    },
    stop: (options?: RequestOptions) =>
      t.json<{ ok: boolean }>({ method: "POST", path: `${base()}:stop`, ...options }),
    /** PNG bytes, or JPEG with `format: "jpeg"`. */
    screenshot: (
      input: { format?: "png" | "jpeg"; quality?: number } = {},
      options?: RequestOptions,
    ) => t.bytes({ method: "GET", path: `${base()}/screenshot`, query: input, ...options }),
    move: (x: number, y: number, options?: RequestOptions) =>
      act({ action: "move", x, y }, options),
    click: (
      x?: number,
      y?: number,
      input: { button?: MouseButton; double?: boolean } = {},
      options?: RequestOptions,
    ) => act({ action: "click", ...(x === undefined ? {} : { x, y }), ...input }, options),
    doubleClick: (x?: number, y?: number, options?: RequestOptions) =>
      act({ action: "click", double: true, ...(x === undefined ? {} : { x, y }) }, options),
    rightClick: (x?: number, y?: number, options?: RequestOptions) =>
      act({ action: "click", button: "right", ...(x === undefined ? {} : { x, y }) }, options),
    mouseDown: (button: MouseButton = "left", options?: RequestOptions) =>
      act({ action: "mouseDown", button }, options),
    mouseUp: (button: MouseButton = "left", options?: RequestOptions) =>
      act({ action: "mouseUp", button }, options),
    drag: (from: [number, number], to: [number, number], options?: RequestOptions) =>
      act({ action: "drag", from, to }, options),
    /** Wheel clicks: positive `dy` scrolls down, positive `dx` right. */
    scroll: (
      dy: number,
      input: { dx?: number; x?: number; y?: number } = {},
      options?: RequestOptions,
    ) => act({ action: "scroll", dy, ...input }, options),
    type: (text: string, input: { delayMs?: number } = {}, options?: RequestOptions) =>
      act({ action: "type", text, ...input }, options),
    /** xdotool key names, space separated: "ctrl+l", "Return", "alt+Tab". */
    press: (keys: string, options?: RequestOptions) => act({ action: "key", keys }, options),
    cursor: (options?: RequestOptions) =>
      act<{ x: number; y: number }>({ action: "cursor" }, options),
    windows: async (options?: RequestOptions) =>
      (await act<{ windows: DesktopWindow[] }>({ action: "windows" }, options)).windows,
    focus: (windowId: string, options?: RequestOptions) =>
      act({ action: "focus", windowId }, options),
    /** Opens `url` in Chromium on the desktop. Right after a sandbox's first
     * start, Chromium may still be installing; this waits for it. */
    async open(url: string, options?: RequestOptions) {
      const deadline = Date.now() + 600_000;
      for (;;) {
        try {
          return await act({ action: "open", url }, options);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== "desktop_installing" || Date.now() > deadline) throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, (error as { retryAfterMs?: number }).retryAfterMs ?? 10_000),
          );
        }
      }
    },
    /** Starts a program on the desktop, detached. */
    launch: (argv: string[], options?: RequestOptions) => act({ action: "launch", argv }, options),
    /** Screen recordings to MP4: `const rec = await sbx.desktop.recordings.start();`
     * ... `await sbx.desktop.recordings.stop(rec.id)`, then `download(rec.id)`. */
    recordings: {
      start: (input: RecordOptions = {}, options?: RequestOptions) =>
        t.json<DesktopRecording>({
          method: "POST",
          path: `${base()}/recordings`,
          body: input,
          ...options,
        }),
      stop: (id: string, options?: RequestOptions) =>
        t.json<DesktopRecording>({
          method: "POST",
          path: `${base()}/recordings/${encodeURIComponent(id)}:stop`,
          ...options,
        }),
      get: (id: string, options?: RequestOptions) =>
        t.json<DesktopRecording>({
          method: "GET",
          path: `${base()}/recordings/${encodeURIComponent(id)}`,
          ...options,
        }),
      list: async (options?: RequestOptions) =>
        (
          await t.json<{ data: DesktopRecording[] }>({
            method: "GET",
            path: `${base()}/recordings`,
            ...options,
          })
        ).data,
      /** The MP4 bytes. */
      download: (id: string, options?: RequestOptions) =>
        t.bytes({
          method: "GET",
          path: `${base()}/recordings/${encodeURIComponent(id)}/video`,
          ...options,
        }),
      delete: (id: string, options?: RequestOptions) =>
        t.json<{ deleted: boolean }>({
          method: "DELETE",
          path: `${base()}/recordings/${encodeURIComponent(id)}`,
          ...options,
        }),
    },
  };
}
