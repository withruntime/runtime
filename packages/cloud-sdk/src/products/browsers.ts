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

/** A task in plain words, done by an agent that browses (POST /v1/browsers/runs). */
export type BrowserRunInput = {
  /** What to do, in plain words; at most 16 KiB. */
  task: string;
  /** Opened before the agent's first step. */
  startUrl?: string;
  /** A claude-, gpt-, o1, o3, o4 or gemini- model; the server defaults to
   * claude-sonnet-5-5. Its key is your egress secret ANTHROPIC_API_KEY,
   * OPENAI_API_KEY or GEMINI_API_KEY. */
  model?: string;
  /** 1 to 200; the server defaults to 30. */
  maxSteps?: number;
  /** Only these domains are opened (example.com, *.example.com). */
  allowedDomains?: string[];
  labels?: Record<string, string>;
};
export type BrowserRunState = "queued" | "running" | "done" | "failed" | "stopped";
export type BrowserRun = {
  id: string;
  state: BrowserRunState;
  task: string | null;
  model: string | null;
  startUrl: string | null;
  /** The agent's answer, once done. */
  output: string | null;
  /** Why it failed, and what to do. */
  error: string | null;
  steps: number;
  /** The page the browser ended on. */
  url: string | null;
  sandboxId: string | null;
  labels: Record<string, string>;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
};
/** One step of a run: the page the agent saw and what it did. */
export type BrowserRunStep = {
  /** 0 is the page before the first step; the last is the page at the end. */
  n: number;
  url: string | null;
  title: string | null;
  goal: string | null;
  actions: unknown[];
  /** The page as a JPEG, base64; null when asked without frames. */
  frame: string | null;
  at: string;
  /** Its place in the run's log: pass as `after`. */
  seq: number;
};
export type BrowserRunSteps = { data: BrowserRunStep[]; after: number; ended: boolean };
const RUN_ENDED: readonly BrowserRunState[] = ["done", "failed", "stopped"];

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
  const runs = browserRuns(t);
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
    /** Do a task in a browser, described in plain words, and wait for its
     * end: `output` once done, `error` once failed. A string is the task.
     * Its steps, each with the page it saw, are `runs.steps(run.id)`. */
    async run(input: string | BrowserRunInput, options?: RequestOptions): Promise<BrowserRun> {
      const started = await runs.create(
        typeof input === "string" ? { task: input } : input,
        options,
      );
      return runs.wait(started.id, options?.signal ? { signal: options.signal } : {});
    },
    runs,
  };
}

/** Browser runs: start one, follow its steps, wait for its end. */
function browserRuns(t: Transport) {
  const runPath = (id: string) => `/v1/browsers/runs/${encodeURIComponent(id)}`;
  const get = (id: string, options?: RequestOptions) =>
    t.json<BrowserRun>({ method: "GET", path: runPath(id), ...options });
  const steps = (
    id: string,
    query: { after?: number; limit?: number; frames?: boolean; wait?: number } = {},
    options?: RequestOptions,
  ) =>
    t.json<BrowserRunSteps>({
      method: "GET",
      path: `${runPath(id)}/steps`,
      query,
      ...options,
      ...(query.wait ? { timeoutMs: 0 } : {}),
    });
  /** Every step after `after`, as each comes, waiting up to 30 seconds a
   * call; ends when the run has ended. */
  async function* follow(
    id: string,
    options: { after?: number; frames?: boolean; signal?: AbortSignal } = {},
  ): AsyncGenerator<BrowserRunStep> {
    let after = options.after ?? 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const read = await steps(
        id,
        { after, wait: 30, ...(options.frames === false ? { frames: false } : {}) },
        options.signal ? { signal: options.signal } : {},
      );
      for (const step of read.data) yield step;
      after = read.after;
      if (read.ended && read.data.length === 0) return;
    }
  }
  const list = async (
    query: { cursor?: string; limit?: number } = {},
    options?: RequestOptions,
  ): Promise<Page<BrowserRun>> => {
    const page = await t.json<{ data: BrowserRun[]; nextCursor: string | null }>({
      method: "GET",
      path: "/v1/browsers/runs",
      query,
      ...options,
    });
    return new Page(page.data, page.nextCursor, (cursor) => list({ ...query, cursor }, options));
  };
  const runs = {
    /** Start a run and return it at once (state queued). */
    create: (input: BrowserRunInput, options?: RequestOptions) =>
      t.json<BrowserRun>({ method: "POST", path: "/v1/browsers/runs", body: input, ...options }),
    get,
    list,
    /** One page of a run's steps; `wait` (seconds, up to 30) waits for one. */
    steps,
    /** Every step, as it comes, until the run ends: its recording. */
    follow,
    /** Stop a run; its sandbox is deleted and its steps are kept. */
    stop: (id: string, options?: RequestOptions) =>
      t.json<BrowserRun>({ method: "POST", path: `${runPath(id)}:stop`, body: {}, ...options }),
    /** Until the run has ended; answers it then. */
    async wait(id: string, options: { signal?: AbortSignal } = {}): Promise<BrowserRun> {
      const now = await get(id, options);
      if (RUN_ENDED.includes(now.state)) return now;
      for await (const _ of follow(id, { frames: false, ...options }));
      return get(id, options);
    },
  };
  return runs;
}
