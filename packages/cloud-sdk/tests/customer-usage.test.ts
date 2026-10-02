import { expect, test } from "bun:test";
import { Runtime } from "../src/client";
import { PermissionDeniedError } from "../src/errors";

test("the singular sandbox product aliases the existing client and transport", async () => {
  const seen: Array<{ method: string; path: string; headers: Headers }> = [];
  const runtime = new Runtime({
    apiKey: "rk_alias_test",
    baseUrl: "https://api.example.com",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      seen.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        headers: new Headers(init?.headers),
      });
      return Response.json({ id: "sandbox-alias", state: "running" });
    }) as typeof fetch,
  });
  expect(runtime.sandbox).toBe(runtime.sandboxes);
  expect((await runtime.sandbox.create({ wait: false })).id).toBe("sandbox-alias");
  expect((await runtime.sandboxes.get("sandbox-alias")).id).toBe("sandbox-alias");
  expect(seen.map(({ method, path }) => ({ method, path }))).toEqual([
    { method: "POST", path: "/v1/sandboxes" },
    { method: "GET", path: "/v1/sandboxes/sandbox-alias" },
  ]);
  expect(seen.every(({ headers }) => headers.get("authorization") === "Bearer rk_alias_test")).toBe(
    true,
  );
});

test("account API counts use the account endpoint, bounded range and authenticated transport without rounding counts", async () => {
  const seen: Array<{ url: URL; headers: Headers }> = [];
  const counts = {
    range: "24h" as const,
    since: "2026-09-29T00:00:00.000Z",
    until: "2026-09-30T00:00:00.000Z",
    calls: "9007199254740993",
    clientErrors: "0",
    serverErrors: "1",
    errorPercent: 0,
    operations: [
      {
        operation: "sandboxes.create",
        calls: "9007199254740993",
        clientErrors: "0",
        serverErrors: "1",
        errorPercent: 0,
      },
    ],
  };
  const runtime = new Runtime({
    apiKey: "rk_usage_test",
    baseUrl: "https://api.example.com",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      seen.push({ url, headers: new Headers(init?.headers) });
      return Response.json({ ...counts, range: url.searchParams.get("range") });
    }) as typeof fetch,
  });
  expect(await runtime.usageRequests()).toEqual(counts);
  for (const range of ["7d", "30d", "90d"] as const) {
    expect((await runtime.usageRequests(range)).range).toBe(range);
  }
  expect(seen.map(({ url }) => url.pathname)).toEqual(Array(4).fill("/v1/usage/requests"));
  expect(seen.map(({ url }) => [...url.searchParams])).toEqual([
    [["range", "24h"]],
    [["range", "7d"]],
    [["range", "30d"]],
    [["range", "90d"]],
  ]);
  expect(seen.every(({ headers }) => headers.get("authorization") === "Bearer rk_usage_test")).toBe(
    true,
  );
});

test("API counts preserve an empty denominator and ordinary permission errors", async () => {
  let forbidden = false;
  const runtime = new Runtime({
    apiKey: "rk_usage_test",
    maxRetries: 0,
    fetch: (async () =>
      forbidden
        ? Response.json({ error: { code: "forbidden", message: "Not allowed." } }, { status: 403 })
        : Response.json({
            range: "24h",
            since: "2026-09-29T00:00:00.000Z",
            until: "2026-09-30T00:00:00.000Z",
            calls: "0",
            clientErrors: "0",
            serverErrors: "0",
            errorPercent: null,
            operations: [],
          })) as unknown as typeof fetch,
  });
  expect(await runtime.usageRequests("24h", { timeoutMs: 1000 })).toMatchObject({
    calls: "0",
    errorPercent: null,
    operations: [],
  });
  forbidden = true;
  await expect(runtime.usageRequests()).rejects.toBeInstanceOf(PermissionDeniedError);
});

test("date-range export follows the shared backend and preserves CSV and exact measurements", async () => {
  const seen: URL[] = [];
  const page = {
    since: "2026-09-01T00:00:00.000Z",
    until: "2026-09-02T00:00:00.000Z",
    data: [{ chargedMicros: "9007199254740993", measurementsJson: '{"n":9007199254740993}' }],
    nextCursor: "continuation",
    csv: "server CSV\r\n",
  };
  const runtime = new Runtime({
    apiKey: "rk_usage_test",
    baseUrl: "https://api.example.com",
    fetch: (async (input: RequestInfo | URL) => {
      seen.push(new URL(input instanceof Request ? input.url : input));
      return Response.json(page);
    }) as typeof fetch,
  });
  expect<unknown>(
    await runtime.usageExport({ since: page.since, until: page.until, limit: 17 }),
  ).toEqual(page);
  await runtime.usageExport({
    since: page.since,
    until: page.until,
    cursor: page.nextCursor,
    limit: 17,
  });
  expect(seen.map((url) => url.pathname)).toEqual(["/v1/usage/export", "/v1/usage/export"]);
  expect(Object.fromEntries(seen[1]!.searchParams)).toEqual({
    since: page.since,
    until: page.until,
    cursor: "continuation",
    limit: "17",
  });
});
