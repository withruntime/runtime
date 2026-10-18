import type { Sandbox } from "../sandbox.js";
import type { RequestOptions, Transport } from "../transport.js";
import { whileInstalling } from "../wait.js";

export type SandboxBrowser =
  | { running: false }
  | {
      running: true;
      headless: boolean;
      /** Chromium's version, e.g. "Chrome/154.0.8037.92". */
      version: string;
      /** The browser's DevTools WebSocket with its private token: give it as it
       * is to Playwright's `chromium.connectOverCDP`, `puppeteer.connect({
       * browserWSEndpoint })`, browser-use or Stagehand. */
      cdpUrl: string;
      /** The DevTools HTTP endpoint; send `headers` with it. */
      httpUrl: string;
      headers: Record<string, string>;
      /** When the token in cdpUrl ends; `get()` returns a fresh one. */
      expiresAt: string | null;
      /** headless: false only: the desktop's live view. */
      streamUrl?: string;
      /** start() only: the sandbox's memory, which is the browser's. */
      memoryMiB?: number;
      /** start() only, under 2 GiB: heavy apps such as Google Sheets, YouTube
       * and StackBlitz need a 2 GiB sandbox; 1 GiB suits light pages. */
      hint?: string;
    };
export type BrowserStartOptions = {
  /** true (the default): no window. false: on the sandbox's desktop, with a live view. */
  headless?: boolean;
  width?: number;
  height?: number;
};

/** `sbx.browser`: Chromium in the sandbox, for agents that speak CDP.
 *
 *   const { cdpUrl } = await sbx.browser.start();
 *   const browser = await chromium.connectOverCDP(cdpUrl);
 *
 * Inside the sandbox the same browser is at http://127.0.0.1:9222. */
export function sandboxBrowser(t: Transport, sandbox: Sandbox) {
  const base = () => `/v1/sandboxes/${encodeURIComponent(sandbox.id)}/browser`;
  return {
    /** Starts Chromium and returns its CDP address. A start in a new
     * sandbox takes about 1 to 2 seconds: Chromium comes from the host. A
     * sandbox from a custom image that is not Ubuntu 24.04 x86_64 installs it
     * on the first start, about a minute; this waits for it (up to 10
     * minutes, or the call's timeoutMs). Starting a running browser returns it
     * as it is. */
    async start(input: BrowserStartOptions = {}, options?: RequestOptions) {
      return whileInstalling(["browser_installing", "desktop_installing"], options, (request) =>
        t.json<Extract<SandboxBrowser, { running: true }>>({
          method: "POST",
          path: `${base()}:start`,
          body: input,
          ...request,
        }),
      );
    },
    /** Whether it runs, and a fresh cdpUrl when it does. */
    get: (options?: RequestOptions) =>
      t.json<SandboxBrowser>({ method: "GET", path: base(), ...options }),
    stop: (options?: RequestOptions) =>
      t.json<{ stopped: boolean }>({ method: "POST", path: `${base()}:stop`, ...options }),
  };
}
