/**
 * Managed Chromium browsers with authenticated Chrome DevTools Protocol (CDP) connections.
 *
 * await using browser = await runtime.browsers.create();
 * const playwrightBrowser = await chromium.connectOverCDP(...browser.connectOptions().playwright);
 * const puppeteerBrowser = await puppeteer.connect(browser.connectOptions().puppeteer);
 *
 * Use `get(browser.id)` for fresh connection credentials after `expiresAt`.
 */
import { RuntimeError } from "../errors.js";
import { Page } from "../page.js";
import type { RequestOptions, Transport } from "../transport.js";

export type CreateBrowser = {
  /** 1024–16384 MiB; the server defaults to 2048. */
  memoryMiB?: number;
  /** The server defaults to 1 vCPU. */
  vcpu?: number;
  /** Defaults to true; false requests a visible browser. */
  headless?: boolean;
  width?: number;
  height?: number;
  timeoutSeconds?: number;
  idlePauseSeconds?: number;
  name?: string;
  labels?: Record<string, string>;
};

export type UpdateBrowser = { name?: string | null; labels?: Record<string, string> };
export type ListBrowsers = { limit?: number; cursor?: string };

/** A browser resource and its current connection credentials. */
export type BrowserInfo = {
  id: string;
  name: string | null;
  labels: Record<string, string>;
  state: string;
  sandboxId: string;
  memoryMiB: number;
  vcpu: number;
  headless: boolean;
  version: string;
  cdpUrl: string;
  httpUrl: string;
  headers: Record<string, string>;
  expiresAt: string | null;
  liveViewUrl?: string;
  hint?: string;
};

export type BrowserScreenshot = {
  /** An http(s) address, opened in a new tab that is closed after. */
  url?: string;
  /** The whole page, not only the window. */
  fullPage?: boolean;
  format?: "png" | "jpeg";
  /** 0 to 10000 ms after the page loads, for late scripts. */
  waitMs?: number;
};
export type BrowserScreenshotResult = {
  /** Where the page ended, after redirects. */
  url: string;
  title: string;
  /** The page's HTTP status; null for the page already shown. */
  status: number | null;
  mimeType: "image/png" | "image/jpeg";
  bytes: number;
  width: number | null;
  height: number | null;
  /** The image. */
  base64: string;
};

export type BrowserConnectOptions = {
  playwright: [endpointURL: string, options: { headers: Record<string, string> }];
  puppeteer: { browserWSEndpoint: string; headers: Record<string, string> };
};

export type Browser = BrowserInfo & {
  /** End this browser; concurrent calls share one request, and failures can be retried. */
  delete(options?: RequestOptions): Promise<void>;
  /** Get Playwright's argument tuple and Puppeteer's options, including authentication headers. */
  connectOptions(): BrowserConnectOptions;
  /** End this browser on scope exit; an already missing browser counts as cleaned up. */
  [Symbol.asyncDispose](): Promise<void>;
};

/** Browsers follow the shared resource interface: id, name, labels, state. */
export function browsers(t: Transport) {
  const path = (id: string) => `/v1/browsers/${encodeURIComponent(id)}`;
  /** End a browser by id; API errors retain their code and recovery hint. */
  const remove = async (id: string, options?: RequestOptions): Promise<void> => {
    await t.json<unknown>({ method: "DELETE", path: path(id), ...options });
  };
  const wrap = (info: BrowserInfo): Browser => {
    let deleted = false;
    let deleting: Promise<void> | undefined;
    const browser: Browser = {
      ...info,
      delete(options) {
        if (deleted) return Promise.resolve();
        if (!deleting) {
          deleting = remove(info.id, options)
            .then(() => {
              deleted = true;
            })
            .catch((error: unknown) => {
              if (error instanceof RuntimeError && error.status === 404) deleted = true;
              throw error;
            })
            .finally(() => {
              deleting = undefined;
            });
        }
        return deleting;
      },
      connectOptions() {
        return {
          playwright: [browser.cdpUrl, { headers: { ...browser.headers } }],
          puppeteer: {
            browserWSEndpoint: browser.cdpUrl,
            headers: { ...browser.headers },
          },
        };
      },
      async [Symbol.asyncDispose]() {
        // Creation's signal/key belong to creation: an aborted task must still clean up.
        try {
          await browser.delete();
        } catch (error) {
          if (!(error instanceof RuntimeError && error.status === 404)) throw error;
        }
      },
    };
    return browser;
  };
  /** Fetch one page; `for await (const browser of await list())` follows every cursor. */
  const list = async (
    query: ListBrowsers = {},
    options?: RequestOptions,
  ): Promise<Page<Browser>> => {
    const page = await t.json<{ data: BrowserInfo[]; nextCursor: string | null }>({
      method: "GET",
      path: "/v1/browsers",
      query,
      ...options,
    });
    return new Page(page.data.map(wrap), page.nextCursor, (cursor) =>
      list({ ...query, cursor }, options),
    );
  };
  return {
    /** Create a browser ready to connect; omitted fields use the server's defaults. */
    async create(input: CreateBrowser = {}, options?: RequestOptions): Promise<Browser> {
      return wrap(
        await t.json<BrowserInfo>({
          method: "POST",
          path: "/v1/browsers",
          body: input,
          ...options,
        }),
      );
    },
    /** Fetch a browser by id with fresh CDP connection credentials. */
    async get(id: string, options?: RequestOptions): Promise<Browser> {
      return wrap(await t.json<BrowserInfo>({ method: "GET", path: path(id), ...options }));
    },
    list,
    /** Change a browser's name or labels without changing its compute settings. */
    async update(id: string, input: UpdateBrowser, options?: RequestOptions): Promise<Browser> {
      return wrap(
        await t.json<BrowserInfo>({
          method: "POST",
          path: `${path(id)}:update`,
          body: input,
          ...options,
        }),
      );
    },
    /** Open `url` in a new tab and shoot it once it loads (without `url`, what
     * the browser shows now); the image is `base64`, its page's url, title
     * and HTTP status beside it. Runs inside the browser's own sandbox. */
    screenshot(id: string, input: BrowserScreenshot = {}, options?: RequestOptions) {
      return t.json<BrowserScreenshotResult>({
        method: "POST",
        path: `${path(id)}:screenshot`,
        body: input,
        ...options,
      });
    },
    /** End a browser by id; pass RequestOptions to bound or deduplicate the request. */
    delete: remove,
  };
}
