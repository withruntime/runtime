import { describe, expect, test } from "bun:test";
import { errorFor } from "../src/errors.js";
import { browsers, type BrowserInfo, type CreateBrowser } from "../src/products/browsers.js";
import { Transport, type Call, type RequestOptions } from "../src/transport.js";

const INFO: BrowserInfo = {
  id: "browser /?#",
  name: null,
  labels: {},
  state: "running",
  sandboxId: "sandbox-1",
  memoryMiB: 2048,
  vcpu: 1,
  headless: true,
  version: "Chrome/test",
  cdpUrl: "ws://127.0.0.1:9222/devtools/browser/test?token=fake",
  httpUrl: "http://127.0.0.1:9222",
  headers: { authorization: "Bearer fake" },
  expiresAt: "2026-10-06T12:00:00Z",
};
const PATH = "/v1/browsers/browser%20%2F%3F%23";

/** No fetch or socket: record every call before returning a scripted API answer. */
function fake(answer: (call: Call, index: number) => unknown = () => INFO) {
  const calls: Call[] = [];
  const transport = {
    async json<T>(call: Call): Promise<T> {
      calls.push(call);
      return (await answer(call, calls.length - 1)) as T;
    },
  } as Transport;
  return { api: browsers(transport), calls };
}

function options(): RequestOptions {
  return { idempotencyKey: "request-key", signal: new AbortController().signal, timeoutMs: 1234 };
}

describe("managed browsers", () => {
  test("create sends exactly the supplied fields and returns a usable Browser", async () => {
    const { api, calls } = fake();
    const input: CreateBrowser = {
      memoryMiB: 1024,
      vcpu: 2,
      headless: false,
      width: 1280,
      height: 720,
      timeoutSeconds: 600,
      idlePauseSeconds: 0,
      name: "checkout",
      labels: { suite: "browser" },
    };
    const request = options();
    const browser = await api.create(input, request);
    expect(calls).toEqual([{ method: "POST", path: "/v1/browsers", body: input, ...request }]);
    expect(browser).toMatchObject(INFO);
    const cdpUrl: string = browser.cdpUrl;
    expect(cdpUrl).toBe(INFO.cdpUrl);
    expect(typeof browser.delete).toBe("function");
    expect(typeof browser[Symbol.asyncDispose]).toBe("function");
  });

  test("default create sends an empty object; partial create adds no defaults", async () => {
    const { api, calls } = fake();
    await api.create();
    await api.create({ headless: false });
    expect(calls.map((call) => call.body)).toEqual([{}, { headless: false }]);
  });

  test("get encodes the id and returns fresh connection credentials", async () => {
    const fresh = { ...INFO, cdpUrl: `${INFO.cdpUrl}-fresh` };
    const { api, calls } = fake(() => fresh);
    const request = options();
    const browser = await api.get(INFO.id, request);
    expect(calls).toEqual([{ method: "GET", path: PATH, ...request }]);
    expect(browser.connectOptions().puppeteer.browserWSEndpoint).toBe(fresh.cdpUrl);
  });

  test("await list fetches one page; iteration follows three pages and stops", async () => {
    const answers = [
      { data: [{ ...INFO, id: "a" }], nextCursor: "second" },
      { data: [], nextCursor: "third" },
      {
        data: [
          { ...INFO, id: "b" },
          { ...INFO, id: "c" },
        ],
        nextCursor: null,
      },
    ];
    const { api, calls } = fake((_call, index) => {
      if (!answers[index]) throw new Error("Requested a fourth page");
      return answers[index];
    });
    const request = options();
    const page = await api.list({ limit: 2, cursor: "first" }, request);
    expect(calls).toHaveLength(1);
    expect(page.data.map((browser) => browser.id)).toEqual(["a"]);
    expect(page.hasMore).toBe(true);
    const ids: string[] = [];
    for await (const browser of page) {
      ids.push(browser.id);
      expect(typeof browser.connectOptions).toBe("function");
    }
    expect(ids).toEqual(["a", "b", "c"]);
    expect(calls).toEqual(
      ["first", "second", "third"].map((cursor) => ({
        method: "GET",
        path: "/v1/browsers",
        query: { limit: 2, cursor },
        ...request,
      })),
    );
  });

  test("empty terminal page stops; early exit never fetches another page", async () => {
    const empty = fake(() => ({ data: [], nextCursor: null }));
    const page = await empty.api.list();
    expect(page.hasMore).toBe(false);
    expect(await page.next()).toBeNull();
    expect(await page.toArray()).toEqual([]);
    expect(empty.calls).toHaveLength(1);
    const more = fake(() => ({ data: [INFO], nextCursor: "later" }));
    for await (const browser of await more.api.list()) {
      expect(browser.id).toBe(INFO.id);
      break;
    }
    expect(more.calls).toHaveLength(1);
  });

  test("update and delete preserve their paths, bodies and request options", async () => {
    const { api, calls } = fake();
    const input = { name: null, labels: {} };
    const request = options();
    const browser = await api.update(INFO.id, input, request);
    expect(browser.id).toBe(INFO.id);
    expect(await api.delete(INFO.id, request)).toBeUndefined();
    expect(calls).toEqual([
      { method: "POST", path: `${PATH}:update`, body: input, ...request },
      { method: "DELETE", path: PATH, ...request },
    ]);
  });

  test("the real transport sends update as POST :update and accepts an empty DELETE response", async () => {
    const seen: Request[] = [];
    const transport = new Transport({
      apiKey: "fake-key",
      baseUrl: "http://127.0.0.1:9222",
      maxRetries: 0,
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        seen.push(request);
        return request.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json(INFO);
      }) as typeof fetch,
    });
    const api = browsers(transport);
    const updated = await api.update(INFO.id, { name: "renamed" }, options());
    expect(updated.cdpUrl).toBe(INFO.cdpUrl);
    expect(await api.delete(INFO.id)).toBeUndefined();
    expect(seen.map((request) => request.method)).toEqual(["POST", "DELETE"]);
    expect(seen[0]!.url).toBe(`http://127.0.0.1:9222${PATH}:update`);
    expect(await seen[0]!.json()).toEqual({ name: "renamed" });
    expect(seen[0]!.headers.get("idempotency-key")).toBe("request-key");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer fake-key");
  });

  test("await using deletes once at normal scope exit", async () => {
    const { api, calls } = fake();
    {
      await using browser = await api.create();
      expect(browser.id).toBe(INFO.id);
      expect(calls).toHaveLength(1);
    }
    expect(calls).toEqual([
      { method: "POST", path: "/v1/browsers", body: {} },
      { method: "DELETE", path: PATH },
    ]);
  });

  test("await using deletes once when the block throws, preserving the original error", async () => {
    const { api, calls } = fake();
    const original = new Error("Workflow failed");
    const workflow = async () => {
      await using browser = await api.create();
      expect(browser.cdpUrl).toBe(INFO.cdpUrl);
      throw original;
    };
    await expect(workflow()).rejects.toBe(original);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  test("dispose treats a 404 as complete, including during a throwing workflow", async () => {
    const missing = errorFor(404, {
      error: { code: "browser_not_found", hint: "Create a browser." },
    });
    const { api, calls } = fake((call) => {
      if (call.method === "DELETE") throw missing;
      return INFO;
    });
    const browser = await api.create();
    await browser[Symbol.asyncDispose]();
    await browser[Symbol.asyncDispose]();
    expect(calls).toHaveLength(2);
    const original = new Error("Workflow failed");
    await expect(
      (async () => {
        await using scoped = await api.create();
        expect(scoped.id).toBe(INFO.id);
        throw original;
      })(),
    ).rejects.toBe(original);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
  });

  test("manual and concurrent deletion share one request; dispose does not repeat it", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { api, calls } = fake((call) => (call.method === "DELETE" ? pending : INFO));
    const browser = await api.create();
    const request = options();
    const first = browser.delete(request);
    const second = browser.delete();
    const disposing = browser[Symbol.asyncDispose]();
    expect(first).toBe(second);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ method: "DELETE", path: PATH, ...request });
    finish();
    await Promise.all([first, second, disposing]);
    await browser.delete();
    await browser[Symbol.asyncDispose]();
    expect(calls).toHaveLength(2);
  });

  test("failed deletion is observable and can be retried", async () => {
    const failure = errorFor(409, {
      error: { code: "browser_failed", hint: "Inspect the browser." },
    });
    let attempts = 0;
    const { api, calls } = fake((call) => {
      if (call.method === "DELETE" && ++attempts === 1) throw failure;
      return INFO;
    });
    const browser = await api.create();
    await expect(browser[Symbol.asyncDispose]()).rejects.toBe(failure);
    await browser.delete(options());
    await browser[Symbol.asyncDispose]();
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
  });

  test("explicit delete still reports 404; later dispose does not repeat it", async () => {
    const missing = errorFor(404, {
      error: { code: "browser_not_found", hint: "Create a browser." },
    });
    const { api, calls } = fake((call) => {
      if (call.method === "DELETE") throw missing;
      return INFO;
    });
    const browser = await api.create();
    await expect(browser.delete()).rejects.toBe(missing);
    await browser[Symbol.asyncDispose]();
    expect(calls).toHaveLength(2);
  });

  test("cleanup does not inherit creation's aborted signal, timeout or idempotency key", async () => {
    const { api, calls } = fake();
    const controller = new AbortController();
    {
      await using browser = await api.create({}, { ...options(), signal: controller.signal });
      expect(browser.id).toBe(INFO.id);
      controller.abort();
    }
    expect(calls[1]).toEqual({ method: "DELETE", path: PATH });
  });

  for (const [status, code] of [
    [404, "browser_not_found"],
    [409, "browser_failed"],
    [400, "invalid_request"],
  ] as const) {
    test(`${code} retains the original error, code and hint across every API method`, async () => {
      const error = errorFor(status, { error: { code, hint: "Inspect the request, then retry." } });
      const { api } = fake(() => {
        throw error;
      });
      for (const call of [
        () => api.create(),
        () => api.get(INFO.id),
        () => api.list(),
        () => api.update(INFO.id, { name: "new" }),
        () => api.delete(INFO.id),
      ]) {
        await expect(call()).rejects.toBe(error);
      }
      expect(error.code).toBe(code);
      expect(error.hint).toBe("Inspect the request, then retry.");
    });
  }

  test("later pagination errors propagate instead of silently truncating the list", async () => {
    const error = errorFor(400, { error: { code: "invalid_request", hint: "Start a new list." } });
    const { api } = fake((_call, index) => {
      if (index) throw error;
      return { data: [INFO], nextCursor: "expired" };
    });
    await expect((await api.list()).toArray()).rejects.toBe(error);
  });

  test("connectOptions supplies both libraries' arguments with independent header copies", async () => {
    const { api, calls } = fake();
    const browser = await api.create();
    const connection = browser.connectOptions();
    expect(connection).toEqual({
      playwright: [INFO.cdpUrl, { headers: INFO.headers }],
      puppeteer: { browserWSEndpoint: INFO.cdpUrl, headers: INFO.headers },
    });
    // These signatures exercise the documented one-liners without installing or launching browsers.
    const chromium = {
      connectOverCDP: (endpoint: string, config: { headers: Record<string, string> }) => ({
        endpoint,
        ...config,
      }),
    };
    const puppeteer = {
      connect: (config: { browserWSEndpoint: string; headers: Record<string, string> }) => config,
    };
    expect(chromium.connectOverCDP(...connection.playwright)).toEqual({
      endpoint: INFO.cdpUrl,
      headers: INFO.headers,
    });
    expect(puppeteer.connect(connection.puppeteer).browserWSEndpoint).toBe(INFO.cdpUrl);
    connection.playwright[1].headers.authorization = "changed";
    expect(connection.puppeteer.headers.authorization).toBe("Bearer fake");
    expect(browser.headers.authorization).toBe("Bearer fake");
    expect(calls).toHaveLength(1);
  });
});

describe("browser runs", () => {
  const RUN = "6a0b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
  const run = (state: string, extra: Record<string, unknown> = {}) => ({
    id: RUN,
    state,
    task: "Find the title",
    model: "claude-sonnet-5-5",
    output: null,
    error: null,
    steps: 0,
    ...extra,
  });
  const step = (n: number, seq: number) => ({ n, seq, url: "https://example.com/", frame: null });

  test("run starts one and follows its steps by long poll until it ends, then reads it", async () => {
    const { api, calls } = fake((call) => {
      if (call.method === "POST") return run("queued");
      if (call.path.endsWith("/steps")) {
        const after = (call.query as { after: number }).after;
        if (after === 0) return { data: [step(0, 2), step(1, 3)], after: 3, ended: false };
        return { data: [], after, ended: true };
      }
      const reads = calls.filter((c) => c.method === "GET" && !c.path.endsWith("/steps"));
      return reads.length === 1
        ? run("running")
        : run("done", { output: "Example Domain", steps: 1 });
    });
    const done = await api.run("Find the title");
    expect(done).toMatchObject({ state: "done", output: "Example Domain" });
    expect(calls.map((c) => [c.method, c.path, c.body ?? c.query])).toEqual([
      ["POST", "/v1/browsers/runs", { task: "Find the title" }],
      ["GET", `/v1/browsers/runs/${RUN}`, undefined],
      ["GET", `/v1/browsers/runs/${RUN}/steps`, { after: 0, wait: 30, frames: false }],
      ["GET", `/v1/browsers/runs/${RUN}/steps`, { after: 3, wait: 30, frames: false }],
      ["GET", `/v1/browsers/runs/${RUN}`, undefined],
    ]);
    // A long poll is never cut by the client's own timeout.
    expect(calls[2]!.timeoutMs).toBe(0);
  });

  test("runs: create sends exactly its fields; get, list, steps and stop go to their routes", async () => {
    const { api, calls } = fake((call) =>
      call.path === "/v1/browsers/runs" && call.method === "GET"
        ? { data: [run("done")], nextCursor: null }
        : call.path.endsWith("/steps")
          ? { data: [], after: 0, ended: true }
          : run("queued"),
    );
    const input = {
      task: "Sign in and read the invoice total",
      startUrl: "https://example.com/login",
      model: "gpt-5",
      maxSteps: 12,
      allowedDomains: ["example.com"],
      labels: { team: "billing" },
    };
    await api.runs.create(input);
    await api.runs.get(RUN);
    expect((await api.runs.list({ limit: 5 })).data[0]!.state).toBe("done");
    await api.runs.steps(RUN, { after: 4, frames: true });
    await api.runs.stop(RUN);
    expect(calls.map((c) => [c.method, c.path, c.body ?? c.query])).toEqual([
      ["POST", "/v1/browsers/runs", input],
      ["GET", `/v1/browsers/runs/${RUN}`, undefined],
      ["GET", "/v1/browsers/runs", { limit: 5 }],
      ["GET", `/v1/browsers/runs/${RUN}/steps`, { after: 4, frames: true }],
      ["POST", `/v1/browsers/runs/${RUN}:stop`, {}],
    ]);
    // A run that has ended is answered without a wait.
    const { api: ended, calls: once } = fake(() => run("failed", { error: "no key" }));
    expect((await ended.runs.wait(RUN)).error).toBe("no key");
    expect(once).toHaveLength(1);
  });
});
