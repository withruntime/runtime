import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { RuntimeError } from "../errors.js";
import type { DesktopRecording } from "../products/desktop.js";
import type { RuntimeSandbox } from "./client.js";
import { guard, NotSupportedError } from "./errors.js";

/* Daytona's computer use (`sandbox.computerUse`) over Runtime's desktop
   (`sandbox.withruntime.desktop`): the same classes, methods and answers,
   each one or two calls of Runtime's desktop actions. Only the stable action
   API is used, so the browser the desktop runs does not matter here. */

type Desktop = RuntimeSandbox["desktop"];
type Live = () => Promise<RuntimeSandbox>;

export interface ScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ScreenshotOptions {
  showCursor?: boolean;
  format?: string;
  quality?: number;
  scale?: number;
}
export interface Position {
  x?: number;
  y?: number;
}
export interface ScreenshotResponse {
  cursorPosition?: Position;
  /** The image, base64. */
  screenshot?: string;
  sizeBytes?: number;
}
export interface DisplayInfo {
  height?: number;
  id?: number;
  isActive?: boolean;
  width?: number;
  x?: number;
  y?: number;
}
export interface WindowInfo {
  height?: number;
  id?: number;
  isActive?: boolean;
  title?: string;
  width?: number;
  x?: number;
  y?: number;
}
export interface ProcessStatus {
  autoRestart?: boolean;
  pid?: number;
  priority?: number;
  running?: boolean;
}
export interface ComputerUseStartResponse {
  message?: string;
  status?: Record<string, ProcessStatus>;
}
export type ComputerUseStopResponse = ComputerUseStartResponse;
export interface ComputerUseStatusResponse {
  status?: string;
}
export interface Recording {
  durationSeconds?: number;
  endTime?: string;
  fileName: string;
  filePath: string;
  id: string;
  sizeBytes?: number;
  startTime: string;
  status: string;
}
export interface ListRecordingsResponse {
  recordings: Recording[];
}

const ALTERNATIVE_STREAM =
  "Open the live desktop from `(await sandbox.withruntime.desktop.start()).streamUrl`.";

async function desktop(live: Live): Promise<Desktop> {
  return (await live()).desktop;
}

/** `sandbox.computerUse.mouse`. */
export class Mouse {
  readonly #live: Live;
  /** Use sandbox.computerUse.mouse. */
  constructor(live: Live) {
    this.#live = live;
  }
  async getPosition(): Promise<Position> {
    const { x, y } = await guard("other", async () => (await desktop(this.#live)).cursor());
    return { x, y };
  }
  async move(x: number, y: number): Promise<Position> {
    await guard("other", async () => (await desktop(this.#live)).move(x, y));
    return { x, y };
  }
  async click(x: number, y: number, button = "left", double = false): Promise<Position> {
    await guard("other", async () =>
      (await desktop(this.#live)).click(x, y, { button: buttonOf(button), double }),
    );
    return { x, y };
  }
  async drag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    button = "left",
  ): Promise<Position> {
    const which = buttonOf(button);
    await guard("other", async () => {
      const screen = await desktop(this.#live);
      if (which === "left") return screen.drag([startX, startY], [endX, endY]);
      await screen.move(startX, startY);
      await screen.mouseDown(which);
      await screen.move(endX, endY);
      return screen.mouseUp(which);
    });
    return { x: endX, y: endY };
  }
  /** `amount` wheel clicks up or down at (x, y). */
  async scroll(x: number, y: number, direction: "up" | "down", amount = 1): Promise<boolean> {
    if (direction !== "up" && direction !== "down")
      throw new RangeError(`direction is "up" or "down", not ${JSON.stringify(direction)}.`);
    await guard("other", async () =>
      (await desktop(this.#live)).scroll(direction === "down" ? amount : -amount, { x, y }),
    );
    return true;
  }
}

/** `sandbox.computerUse.keyboard`. Key names are Daytona's (enter, esc,
 * ctrl, cmd, pageup, f5) or xdotool's (Return, Escape, Prior). */
export class Keyboard {
  readonly #live: Live;
  /** Use sandbox.computerUse.keyboard. */
  constructor(live: Live) {
    this.#live = live;
  }
  /** Types `text`, `delay` milliseconds between keys. */
  async type(text: string, delay?: number): Promise<void> {
    await guard("other", async () =>
      (await desktop(this.#live)).type(text, delay === undefined ? {} : { delayMs: delay }),
    );
  }
  async press(key: string, modifiers: string[] = []): Promise<void> {
    await guard("other", async () =>
      (await desktop(this.#live)).press([...modifiers, key].map(keyOf).join("+")),
    );
  }
  /** A combination such as "ctrl+c" or "ctrl+shift+t". */
  async hotkey(keys: string): Promise<void> {
    await guard("other", async () =>
      (await desktop(this.#live)).press(keys.split("+").map(keyOf).join("+")),
    );
  }
}

/** `sandbox.computerUse.screenshot`: the whole screen, PNG or JPEG. */
export class Screenshot {
  readonly #live: Live;
  /** Use sandbox.computerUse.screenshot. */
  constructor(live: Live) {
    this.#live = live;
  }
  takeFullScreen(showCursor = false): Promise<ScreenshotResponse> {
    return this.takeCompressed({ showCursor, format: "png" });
  }
  takeRegion(_region: ScreenshotRegion, _showCursor?: boolean): Promise<ScreenshotResponse> {
    return Promise.reject(region());
  }
  async takeCompressed(options: ScreenshotOptions = {}): Promise<ScreenshotResponse> {
    if (options.showCursor)
      throw new NotSupportedError(
        "Drawing the cursor into a screenshot (showCursor)",
        "Take it without; sandbox.computerUse.mouse.getPosition() says where the cursor is.",
      );
    if (options.scale !== undefined && options.scale !== 1)
      throw new NotSupportedError(
        "Scaling a screenshot",
        "Take it at full size and scale it yourself, or start the desktop smaller: sandbox.withruntime.desktop.start({ width, height }).",
      );
    const format = (options.format ?? "png").toLowerCase();
    if (format !== "png" && format !== "jpeg" && format !== "jpg")
      throw new NotSupportedError(`Screenshots as ${format}`, 'Use format "png" or "jpeg".');
    const bytes = await guard("other", async () =>
      (await desktop(this.#live)).screenshot(
        format === "png"
          ? {}
          : {
              format: "jpeg",
              ...(options.quality === undefined ? {} : { quality: options.quality }),
            },
      ),
    );
    return { screenshot: Buffer.from(bytes).toString("base64"), sizeBytes: bytes.byteLength };
  }
  takeCompressedRegion(
    _region: ScreenshotRegion,
    _options?: ScreenshotOptions,
  ): Promise<ScreenshotResponse> {
    return Promise.reject(region());
  }
}

/** `sandbox.computerUse.display`. */
export class Display {
  readonly #live: Live;
  /** Use sandbox.computerUse.display. */
  constructor(live: Live) {
    this.#live = live;
  }
  /** The one screen, its size read from a screenshot. */
  async getInfo(): Promise<{ displays?: DisplayInfo[] }> {
    const png = await guard("other", async () => (await desktop(this.#live)).screenshot());
    const { width, height } = pngSize(png);
    return { displays: [{ id: 0, x: 0, y: 0, width, height, isActive: true }] };
  }
  async getWindows(): Promise<{ windows?: WindowInfo[] }> {
    const windows = await guard("other", async () => (await desktop(this.#live)).windows());
    return {
      windows: windows.map((one) => ({
        id: Number(one.id),
        title: one.title,
        x: one.x,
        y: one.y,
        width: one.width,
        height: one.height,
      })),
    };
  }
}

/** `sandbox.computerUse.recording`: screen recordings to MP4. */
export class RecordingService {
  readonly #live: Live;
  /** Use sandbox.computerUse.recording. */
  constructor(live: Live) {
    this.#live = live;
  }
  /** Starts recording. Runtime names the file itself; `label` is not used. */
  async start(_label?: string): Promise<Recording> {
    return recordingOf(
      await guard("other", async () => (await desktop(this.#live)).recordings.start()),
    );
  }
  async stop(id: string): Promise<Recording> {
    return recordingOf(
      await guard("other", async () => (await desktop(this.#live)).recordings.stop(id)),
    );
  }
  async list(): Promise<ListRecordingsResponse> {
    const all = await guard("other", async () => (await desktop(this.#live)).recordings.list());
    return { recordings: all.map(recordingOf) };
  }
  async get(id: string): Promise<Recording> {
    return recordingOf(
      await guard("other", async () => (await desktop(this.#live)).recordings.get(id)),
    );
  }
  async delete(id: string): Promise<void> {
    await guard("other", async () => (await desktop(this.#live)).recordings.delete(id));
  }
  /** Saves the MP4 to `localPath`, making its directory. */
  async download(id: string, localPath: string): Promise<void> {
    const bytes = await guard("other", async () =>
      (await desktop(this.#live)).recordings.download(id),
    );
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, bytes);
  }
}

/** `sandbox.computerUse.accessibility`: Runtime's desktop has no
 * accessibility tree; every method throws NotSupportedError. */
export class Accessibility {
  #refuse(): Promise<never> {
    return Promise.reject(
      new NotSupportedError(
        "The desktop's accessibility tree",
        "Find things on screen with a screenshot (sandbox.computerUse.screenshot.takeFullScreen()) and act with the mouse and keyboard.",
      ),
    );
  }
  getTree(_options?: unknown): Promise<never> {
    return this.#refuse();
  }
  findNodes(_options?: unknown): Promise<never> {
    return this.#refuse();
  }
  focusNode(_id: string): Promise<never> {
    return this.#refuse();
  }
  invokeNode(_id: string, _action?: string): Promise<never> {
    return this.#refuse();
  }
  setNodeValue(_id: string, _value: string): Promise<never> {
    return this.#refuse();
  }
}

/** `sandbox.computerUse`: a Linux desktop driven like a person would. */
export class ComputerUse {
  readonly mouse: Mouse;
  readonly keyboard: Keyboard;
  readonly screenshot: Screenshot;
  readonly display: Display;
  readonly recording: RecordingService;
  readonly accessibility: Accessibility;
  readonly #live: Live;

  /** Use sandbox.computerUse. */
  constructor(live: Live) {
    this.#live = live;
    this.mouse = new Mouse(live);
    this.keyboard = new Keyboard(live);
    this.screenshot = new Screenshot(live);
    this.display = new Display(live);
    this.recording = new RecordingService(live);
    this.accessibility = new Accessibility();
  }

  /** Starts the desktop. A sandbox's first start installs it, which takes a
   * minute or two; this waits for that. */
  async start(): Promise<ComputerUseStartResponse> {
    await guard("other", async () => (await desktop(this.#live)).start());
    return {
      message: "Computer use processes started successfully",
      status: { desktop: { running: true } },
    };
  }
  async stop(): Promise<ComputerUseStopResponse> {
    await guard("other", async () => (await desktop(this.#live)).stop());
    return {
      message: "Computer use processes stopped successfully",
      status: { desktop: { running: false } },
    };
  }
  /** "active" while the desktop runs, else "inactive". */
  async getStatus(): Promise<ComputerUseStatusResponse> {
    try {
      await (await desktop(this.#live)).cursor();
      return { status: "active" };
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        (error.code === "desktop_not_running" || error.code === "desktop_not_installed")
      )
        return { status: "inactive" };
      return guard("other", () => {
        throw error;
      });
    }
  }
  getProcessStatus(_processName: string): Promise<never> {
    return processes();
  }
  restartProcess(_processName: string): Promise<never> {
    return processes();
  }
  getProcessLogs(_processName: string): Promise<never> {
    return processes();
  }
  getProcessErrors(_processName: string): Promise<never> {
    return processes();
  }
}

function processes(): Promise<never> {
  return Promise.reject(
    new NotSupportedError(
      "Managing the desktop's processes one by one",
      `Use computerUse.getStatus(), stop() and start(). ${ALTERNATIVE_STREAM}`,
    ),
  );
}

function region(): NotSupportedError {
  return new NotSupportedError(
    "Screenshots of part of the screen",
    "Take the whole screen with takeFullScreen() or takeCompressed() and crop it yourself.",
  );
}

function buttonOf(button: string): "left" | "middle" | "right" {
  if (button === "left" || button === "middle" || button === "right") return button;
  throw new RangeError(`button is "left", "middle" or "right", not ${JSON.stringify(button)}.`);
}

/** Daytona's key names as xdotool's; anything else passes as given. */
const KEYS: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  tab: "Tab",
  space: "space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
  insert: "Insert",
  capslock: "Caps_Lock",
  control: "ctrl",
  ctrl: "ctrl",
  shift: "shift",
  alt: "alt",
  cmd: "super",
  command: "super",
  meta: "super",
  win: "super",
  super: "super",
};
function keyOf(key: string): string {
  const name = key.trim();
  const lower = name.toLowerCase();
  if (KEYS[lower]) return KEYS[lower];
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase();
  return name;
}

const STATUS: Record<DesktopRecording["state"], string> = {
  starting: "recording",
  installing: "recording",
  recording: "recording",
  finished: "completed",
  failed: "failed",
};
function recordingOf(recording: DesktopRecording): Recording {
  const start = recording.startedAt ?? null;
  return {
    id: recording.id,
    fileName: basename(recording.path),
    filePath: recording.path,
    startTime: start === null ? "" : new Date(start).toISOString(),
    ...(start !== null && recording.seconds !== undefined && STATUS[recording.state] !== "recording"
      ? { endTime: new Date(start + recording.seconds * 1000).toISOString() }
      : {}),
    status: STATUS[recording.state] ?? recording.state,
    sizeBytes: recording.bytes,
    ...(recording.seconds === undefined ? {} : { durationSeconds: recording.seconds }),
  };
}

/** Width and height from a PNG's header. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (png.byteLength < 24 || view.getUint32(12) !== 0x49484452)
    throw new RangeError("The desktop's screenshot was not a PNG.");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
