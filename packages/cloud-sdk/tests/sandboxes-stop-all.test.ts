import { expect, test } from "bun:test";
import { Runtime } from "../src/index";

/* No way to stop a group of sandboxes by label (live product, 2 October
   2026): runtime.sandboxes.stopAll({ labels }) stops every live one that
   matches, reports each failure, and never stops everything by accident. */

const sandbox = (n: number, state = "running") => ({
  id: `11111111-2222-4333-8444-00000000000${n}`,
  kind: "sandbox",
  state,
  labels: { run: "afternoon" },
});

function api(failing: number) {
  const seen: string[] = [];
  const keys = new Set<string>();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.method === "GET" && url.pathname === "/v1/sandboxes")
      return Response.json({ data: [1, 2, 3].map((n) => sandbox(n)), nextCursor: null });
    const stop = /^\/v1\/sandboxes\/([^/]+):stop$/.exec(url.pathname);
    if (stop) {
      keys.add(request.headers.get("idempotency-key") ?? "");
      if (stop[1]!.endsWith(String(failing)))
        return Response.json(
          { error: { code: "conflict", status: 409, message: "Busy.", requestId: "req_test" } },
          { status: 409 },
        );
      return Response.json({ ...sandbox(Number(stop[1]!.at(-1)), "stopped") });
    }
    return Response.json({ error: { code: "route_not_found", status: 404 } }, { status: 404 });
  }) as typeof fetch;
  const runtime = new Runtime({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    fetch: fetcher,
    maxRetries: 0,
  });
  return { runtime, seen, keys };
}

test("stopAll stops every live sandbox with the labels and names the one that failed", async () => {
  const { runtime, seen, keys } = api(2);
  const result = await runtime.sandboxes.stopAll(
    { labels: { run: "afternoon" } },
    { idempotencyKey: "one-key" },
  );
  expect(result.stopped).toEqual([sandbox(1).id, sandbox(3).id]);
  expect(result.failed.map((f) => f.id)).toEqual([sandbox(2).id]);
  expect(result.failed[0]!.error).toMatchObject({ code: "conflict" });
  expect(seen[0]).toBe("GET /v1/sandboxes?label=run%3Aafternoon&limit=100");
  // Each stop carries its own key: one key for three stops would replay the first.
  expect(keys.size).toBe(3);
  expect(keys.has("one-key")).toBe(false);
});

test("stopAll with no label stops nothing", async () => {
  const { runtime, seen } = api(0);
  for (const filter of [{ labels: {} }, {} as { labels: Record<string, string> }])
    expect(await runtime.sandboxes.stopAll(filter).catch((e: unknown) => e)).toMatchObject({
      code: "invalid_request",
    });
  expect(seen).toEqual([]);
});
