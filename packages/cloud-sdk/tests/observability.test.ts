import { expect, test } from "bun:test";
import { run } from "../src/cli";
import { Runtime } from "../src/client";
import { Sandbox as E2BSandbox } from "../src/e2b/sandbox";
import { verifyWebhook, WebhookVerificationError } from "../src/index";

/* sbx.metrics(), runtime.webhooks, runtime.otel, runtime.events, verifyWebhook
   and their CLI commands against a stub API. The routes are tested over
   Postgres in packages/cloud (observability-api.test.ts). */

const SANDBOX_ID = "11111111-2222-4333-8444-555555555555";
const HOOK_ID = "22222222-3333-4444-8555-666666666666";
const sandbox = {
  id: SANDBOX_ID,
  kind: "sandbox",
  state: "running",
  name: null,
  labels: {},
  vcpu: 2,
  memoryMiB: 4096,
};
const metrics = {
  sandboxId: SANDBOX_ID,
  range: "1h",
  stepSeconds: 20,
  since: "2026-09-23T10:00:00.000Z",
  until: "2026-09-23T11:00:00.000Z",
  vcpu: 2,
  memoryLimitBytes: 4294967296,
  diskLimitBytes: 10737418240,
  state: "running",
  latest: {
    at: "2026-09-23T10:59:00.000Z",
    cpuPercent: 25,
    cpuCores: 0.5,
    cpuPeakPercent: 25,
    memoryBytes: 1073741824,
    memoryPeakBytes: 1073741824,
    samples: 1,
  },
  points: [
    {
      at: "2026-09-23T10:58:00.000Z",
      cpuPercent: null,
      cpuCores: null,
      cpuPeakPercent: null,
      memoryBytes: 900000000,
      memoryPeakBytes: 900000000,
      samples: 1,
    },
    {
      at: "2026-09-23T10:59:00.000Z",
      cpuPercent: 25,
      cpuCores: 0.5,
      cpuPeakPercent: 25,
      memoryBytes: 1073741824,
      memoryPeakBytes: 1073741824,
      samples: 1,
    },
  ],
};
const webhook = {
  id: HOOK_ID,
  url: "https://example.com/hooks/runtime",
  description: null,
  events: ["*"],
  enabled: true,
  secretHint: "whsec_…abcd",
  previousSecretExpiresAt: null,
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
  lastSuccessAt: null,
  lastFailureAt: null,
  failingSince: null,
};

async function withStub(work: (seen: string[]) => Promise<void>) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.text() : "";
    seen.push(`${request.method} ${url.pathname}${url.search}${body ? ` ${body}` : ""}`);
    if (url.pathname === `/v1/sandboxes/${SANDBOX_ID}`) return Response.json(sandbox);
    if (url.pathname.endsWith("/metrics")) return Response.json(metrics);
    if (url.pathname === "/v1/webhooks" && request.method === "POST")
      return Response.json({ ...webhook, secret: `whsec_${"a".repeat(43)}` });
    if (url.pathname === "/v1/webhooks")
      return Response.json({ data: [webhook], nextCursor: null });
    if (url.pathname.endsWith(":test"))
      return Response.json({
        id: "d",
        state: "succeeded",
        lastStatus: 204,
        lastDurationMs: 31,
        eventType: "webhook.test",
      });
    if (url.pathname.startsWith("/v1/otel-exports"))
      return Response.json({
        data: [],
        nextCursor: null,
        id: "x",
        endpoint: "https://otlp.example.com",
        headerNames: ["Authorization"],
        signals: ["logs", "metrics"],
        enabled: true,
      });
    if (url.pathname === "/v1/events") return Response.json({ data: [], nextCursor: null });
    return Response.json(webhook);
  }) as typeof fetch;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = original;
  }
}
const client = () => new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });

test("sbx.metrics() reads the sandbox's metrics route with its range", async () => {
  await withStub(async (seen) => {
    const sbx = await client().sandboxes.get(SANDBOX_ID);
    const result = await sbx.metrics({ range: "1h" });
    expect(result.latest?.cpuPercent).toBe(25);
    expect(seen.at(-1)).toBe(`GET /v1/sandboxes/${SANDBOX_ID}/metrics?range=1h`);
    await sbx.metrics();
    expect(seen.at(-1)).toBe(`GET /v1/sandboxes/${SANDBOX_ID}/metrics`);
  });
});

test("webhooks, exports and events call their routes", async () => {
  await withStub(async (seen) => {
    const runtime = client();
    const made = await runtime.webhooks.create({ url: webhook.url, events: ["sandbox.stopped"] });
    expect(made.secret).toMatch(/^whsec_/);
    await runtime.webhooks.update(HOOK_ID, { enabled: false });
    await runtime.webhooks.rotateSecret(HOOK_ID, { keepPreviousSeconds: 0 });
    await runtime.webhooks.test(HOOK_ID);
    await runtime.webhooks.deliveries(HOOK_ID, { state: "failed" });
    await runtime.webhooks.retry("33333333-4444-4555-8666-777777777777");
    await runtime.webhooks.delete(HOOK_ID);
    await runtime.otel.create({
      endpoint: "https://otlp.example.com",
      headers: { Authorization: "Bearer t" },
    });
    await runtime.otel.flush("x");
    await runtime.events.list({ resourceId: SANDBOX_ID, limit: 5 });
    expect(seen.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
      "POST /v1/webhooks",
      `POST /v1/webhooks/${HOOK_ID}:update`,
      `POST /v1/webhooks/${HOOK_ID}:rotate-secret`,
      `POST /v1/webhooks/${HOOK_ID}:test`,
      `GET /v1/webhooks/${HOOK_ID}/deliveries?state=failed`,
      "POST /v1/webhook-deliveries/33333333-4444-4555-8666-777777777777:retry",
      `POST /v1/webhooks/${HOOK_ID}:delete`,
      "POST /v1/otel-exports",
      "POST /v1/otel-exports/x:flush",
      `GET /v1/events?resourceId=${SANDBOX_ID}&limit=5`,
    ]);
  });
});

test("verifyWebhook accepts Runtime's signature and refuses a wrong secret, a changed body or an old one", async () => {
  // The vector packages/cloud (observability-api.test.ts) and Python share.
  const header = "t=1700000000,v1=38877139021993b830af32feea6e18a8da83eb2f6e49ee50bd9e4cf4ca4d3789";
  const body = '{"a":1}';
  expect(await verifyWebhook(body, header, "whsec_test", { now: 1_700_000_100 })).toEqual({
    a: 1,
  } as never);
  expect(
    await verifyWebhook(new TextEncoder().encode(body), header, ["whsec_other", "whsec_test"], {
      now: 1_700_000_000,
    }),
  ).toEqual({ a: 1 } as never);
  for (const [b, h, s, now] of [
    [body, header, "whsec_wrong", 1_700_000_000],
    ['{"a":2}', header, "whsec_test", 1_700_000_000],
    [body, header, "whsec_test", 1_700_000_301],
    [body, null, "whsec_test", 1_700_000_000],
    [body, "t=x,v1=00", "whsec_test", 1_700_000_000],
  ] as const)
    expect(await verifyWebhook(b, h, s, { now }).catch((e: unknown) => e)).toBeInstanceOf(
      WebhookVerificationError,
    );
});

test("E2B's getMetrics is Runtime's measured readings", async () => {
  await withStub(async () => {
    const original = process.env.RUNTIME_API_URL;
    process.env.RUNTIME_API_URL = "https://api.example.test";
    try {
      const points = await E2BSandbox.getMetrics(SANDBOX_ID, {
        apiKey: "rk_x",
        start: new Date("2026-09-23T10:00:00Z"),
        end: new Date("2026-09-23T12:00:00Z"),
      });
      expect(points).toEqual([
        {
          timestamp: new Date("2026-09-23T10:59:00.000Z"),
          cpuUsedPct: 25,
          cpuCount: 2,
          memUsed: 1073741824,
          memTotal: 4294967296,
          diskUsed: null,
          diskTotal: 10737418240,
        },
      ]);
    } finally {
      if (original === undefined) delete process.env.RUNTIME_API_URL;
      else process.env.RUNTIME_API_URL = original;
    }
  });
});

test("the CLI: sandbox metrics, webhooks and otel", async () => {
  const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
  await withStub(async (seen) => {
    const lines: string[] = [];
    const out = {
      json: false,
      write: (t: string) => lines.push(t),
      error: (t: string) => lines.push(t),
    };
    expect(await run(["sandbox", "metrics", SANDBOX_ID, "--range", "1h"], env, out)).toBe(0);
    expect(seen.at(-1)).toBe(`GET /v1/sandboxes/${SANDBOX_ID}/metrics?range=1h`);
    expect(lines.join("\n")).toContain("25%");
    expect(
      await run(
        ["webhooks", "create", webhook.url, "--events", "sandbox.stopped,sandbox.paused"],
        env,
        out,
      ),
    ).toBe(0);
    expect(seen.at(-1)).toContain('"events":["sandbox.stopped","sandbox.paused"]');
    expect(lines.join("\n")).toContain("whsec_");
    expect(await run(["webhooks", "test", HOOK_ID], env, out)).toBe(0);
    expect(lines.at(-1)).toContain("204");
    expect(await run(["webhooks", "ls"], env, out)).toBe(0);
    expect(
      await run(
        ["otel", "create", "https://otlp.example.com", "--header", "Authorization=Bearer t"],
        env,
        out,
      ),
    ).toBe(0);
    expect(seen.at(-1)).toContain('"headers":{"Authorization":"Bearer t"}');
    expect(await run(["events", "--sandbox", SANDBOX_ID], env, out)).toBe(0);
    expect(seen.at(-1)).toBe(`GET /v1/events?resourceId=${SANDBOX_ID}`);
  });
});
