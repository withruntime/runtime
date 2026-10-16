import { expect, test } from "bun:test";
import { Runtime } from "../src/index";

/* An agent that started fifty labelled sandboxes could stop them in one call
   but had to delete them one by one (outside audit, 11 October 2026).
   runtime.sandboxes.deleteAll({ labels }) deletes every match, stopped ones
   included, reports each failure, and never deletes everything by accident. */

const id = (n: number) => `11111111-2222-4333-8444-${String(n).padStart(12, "0")}`;
const sandbox = (n: number, state = "running") => ({
  id: id(n),
  kind: "sandbox",
  state,
  labels: { run: "afternoon" },
});

/** An API with `count` matching sandboxes, `perPage` to a page; `failing`
 * refuses its delete. Counts how many deletes run at once. */
function api({ count = 3, perPage = 100, failing = 0 } = {}) {
  const seen: string[] = [];
  const keys = new Set<string>();
  let running = 0;
  let most = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.method === "GET" && url.pathname === "/v1/sandboxes") {
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const to = Math.min(count, from + perPage);
      const states = ["running", "stopped", "paused"];
      return Response.json({
        data: Array.from({ length: to - from }, (_, i) =>
          sandbox(from + i + 1, states[(from + i) % 3]),
        ),
        nextCursor: to < count ? String(to) : null,
      });
    }
    const one = /^\/v1\/sandboxes\/([^/:]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && one) {
      keys.add(request.headers.get("idempotency-key") ?? "");
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      if (failing && one[1] === id(failing))
        return Response.json(
          { error: { code: "conflict", status: 409, message: "Busy.", requestId: "req_test" } },
          { status: 409 },
        );
      return Response.json({ id: one[1], kind: "sandbox", deleted: true });
    }
    return Response.json({ error: { code: "route_not_found", status: 404 } }, { status: 404 });
  }) as typeof fetch;
  const runtime = new Runtime({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    fetch: fetcher,
    maxRetries: 0,
  });
  return { runtime, seen, keys, most: () => most };
}

test("deleteAll deletes every sandbox with the labels, stopped ones too, and names the one that failed", async () => {
  const { runtime, seen, keys } = api({ failing: 2 });
  const result = await runtime.sandboxes.deleteAll(
    { labels: { run: "afternoon" } },
    { idempotencyKey: "one-key" },
  );
  expect(result.deleted).toEqual([id(1), id(3)]);
  expect(result.failed.map((f) => f.id)).toEqual([id(2)]);
  expect(result.failed[0]!.error).toMatchObject({ code: "conflict" });
  expect(seen[0]).toBe("GET /v1/sandboxes?includeStopped=true&label=run%3Aafternoon&limit=100");
  // Each delete carries its own key: one key for three deletes would replay the first.
  expect(keys.size).toBe(3);
  expect(keys.has("one-key")).toBe(false);
});

test("deleteAll with no label deletes nothing", async () => {
  const { runtime, seen } = api();
  for (const filter of [
    { labels: {} },
    {} as { labels: Record<string, string> },
    undefined as unknown as { labels: Record<string, string> },
  ])
    expect(await runtime.sandboxes.deleteAll(filter).catch((e: unknown) => e)).toMatchObject({
      code: "invalid_request",
      message: "deleteAll needs at least one label to match.",
    });
  expect(seen).toEqual([]);
});

test("deleteAll reads every page before it deletes, so no match is skipped", async () => {
  const { runtime, seen } = api({ count: 7, perPage: 3 });
  const result = await runtime.sandboxes.deleteAll({ labels: { run: "afternoon" } });
  expect(result.deleted).toEqual([1, 2, 3, 4, 5, 6, 7].map(id));
  const gets = seen.filter((line) => line.startsWith("GET"));
  expect(gets).toHaveLength(3);
  expect(seen.slice(0, 3)).toEqual(gets);
});

test("deleteAll deletes at most eight at once", async () => {
  const { runtime, most } = api({ count: 30 });
  const result = await runtime.sandboxes.deleteAll({ labels: { run: "afternoon" } });
  expect(result.deleted).toHaveLength(30);
  expect(most()).toBe(8);
});

test("deleteAll with no match deletes nothing and says so", async () => {
  const { runtime, seen } = api({ count: 0 });
  expect(await runtime.sandboxes.deleteAll({ labels: { run: "evening" } })).toEqual({
    deleted: [],
    failed: [],
  });
  expect(seen.filter((line) => line.startsWith("DELETE"))).toEqual([]);
});
