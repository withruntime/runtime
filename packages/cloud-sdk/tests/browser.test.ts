import { expect, test } from "bun:test";
import { sandboxBrowser } from "../src/products/browser";
import { Transport } from "../src/transport";

/* sbx.browser against a stub API: the paths and bodies it sends, and that
   start waits through browser_installing. Registration on the sandbox is a
   shared-file patch (products/index.ts). */

const SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const RUNNING = {
  running: true,
  headless: true,
  version: "Chrome/154.0.8037.92",
  cdpUrl: "wss://9223-x.runtimehost.test/s/devtools/browser/b?runtime_preview_token=T",
  httpUrl: "https://9223-x.runtimehost.test/s/",
  headers: { "x-runtime-preview-token": "T" },
  expiresAt: null,
};

test("start waits for the install, then get and stop", async () => {
  const seen: string[] = [];
  let installing = 1;
  const t = new Transport({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    maxRetries: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === "GET" ? "" : await request.text();
      seen.push(`${request.method} ${url.pathname} ${body}`);
      if (url.pathname.endsWith("browser:start") && installing-- > 0)
        return Response.json(
          { error: { code: "browser_installing", message: "installing", retryAfterMs: 1 } },
          { status: 409 },
        );
      if (url.pathname.endsWith(":stop")) return Response.json({ stopped: true });
      return Response.json(RUNNING);
    }) as typeof fetch,
  });
  const browser = sandboxBrowser(t, { id: SANDBOX } as never);
  expect((await browser.start({ headless: false })).cdpUrl).toBe(RUNNING.cdpUrl);
  expect(await browser.get()).toMatchObject({ running: true });
  expect(await browser.stop()).toEqual({ stopped: true });
  const base = `/v1/sandboxes/${SANDBOX}/browser`;
  expect(seen).toEqual([
    `POST ${base}:start {"headless":false}`,
    `POST ${base}:start {"headless":false}`,
    `GET ${base} `,
    `POST ${base}:stop `,
  ]);
});
