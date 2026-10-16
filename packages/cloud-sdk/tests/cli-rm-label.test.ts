import { expect, test } from "bun:test";
import { run } from "../src/cli";

/* `runtime sandboxes rm --label run=a` deletes every sandbox with the labels,
   stopped ones too, and exits 1 when any of them failed (outside audit,
   11 October 2026: stop had --label, rm did not). */

const ids = [1, 2].map((n) => `11111111-2222-4333-8444-00000000000${n}`);
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };

async function cli(argv: string[], { json = false, matches = ids } = {}) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.method === "GET" && url.pathname === "/v1/sandboxes")
      return Response.json({
        data: matches.map((id) => ({
          id,
          kind: "sandbox",
          state: "stopped",
          labels: { run: "a" },
        })),
        nextCursor: null,
      });
    if (request.method === "DELETE" && url.pathname === `/v1/sandboxes/${ids[1]}`)
      return Response.json(
        { error: { code: "conflict", status: 409, message: "It is busy." } },
        { status: 409 },
      );
    if (request.method === "DELETE" && url.pathname === `/v1/sandboxes/${ids[0]}`)
      return Response.json({ id: ids[0], kind: "sandbox", deleted: true });
    return Response.json({ error: { code: "route_not_found", message: "?" } }, { status: 404 });
  }) as typeof fetch;
  const lines: string[] = [];
  const out = { json, write: (t: string) => lines.push(t), error: (t: string) => lines.push(t) };
  try {
    const code = await run(argv, env, out).catch((e: unknown) => e);
    return { code, said: lines.join("\n"), seen };
  } finally {
    globalThis.fetch = original;
  }
}

test("`sandboxes rm --label` deletes each match, stopped ones too, and reports the one that failed", async () => {
  const { code, said, seen } = await cli(["sandboxes", "rm", "--label", "run=a"]);
  expect(code).toBe(1);
  expect(seen[0]).toBe("GET /v1/sandboxes?includeStopped=true&label=run%3Aa&limit=100");
  expect(said).toContain("1 deleted, 1 failed.");
  expect(said).toContain(`${ids[0]} deleted`);
  expect(said).toContain(`${ids[1]} failed: It is busy.`);
});

test("`sandboxes rm --label=k=v` and `delete --label` read the same; --json names each", async () => {
  const { code, said } = await cli(["sandbox", "delete", "--label=run=a"], {
    json: true,
    matches: [ids[0]!],
  });
  expect(code).toBe(0);
  expect(JSON.parse(said)).toEqual({ deleted: [ids[0]], failed: [] });
});

test("`sandboxes rm --label` with no match deletes nothing and exits 0", async () => {
  const { code, said, seen } = await cli(["sandboxes", "rm", "--label", "run=a"], { matches: [] });
  expect(code).toBe(0);
  expect(said).toBe("No sandbox has those labels.");
  expect(seen.filter((line) => line.startsWith("DELETE"))).toEqual([]);
});

test("`sandboxes rm` refuses an id beside --label, and a --label that is not KEY=VALUE, before any request", async () => {
  for (const argv of [
    ["sandboxes", "rm", ids[0]!, "--label", "run=a"],
    ["sandboxes", "rm", "--label"],
    ["sandboxes", "rm", "--label", "run"],
    ["sandboxes", "rm", "--label", "=a"],
  ]) {
    const { code, seen } = await cli(argv);
    expect(code).not.toBe(0);
    expect(seen).toEqual([]);
  }
});
