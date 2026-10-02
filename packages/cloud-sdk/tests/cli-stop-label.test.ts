import { expect, test } from "bun:test";
import { run } from "../src/cli";

/* `runtime sandbox stop --label run=afternoon` took "--label" for a sandbox
   id (live product, 2 October 2026). It stops every live sandbox with the
   labels and exits 1 when any of them failed. Needs the patch
   /tmp/round/shared/sdk-polish-cli.patch (cli.ts is shared). */

const ids = [1, 2].map((n) => `11111111-2222-4333-8444-00000000000${n}`);
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };

test("`sandbox stop --label` stops each match and reports the one that failed", async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.method === "GET" && url.pathname === "/v1/sandboxes")
      return Response.json({
        data: ids.map((id) => ({ id, kind: "sandbox", state: "running", labels: { run: "a" } })),
        nextCursor: null,
      });
    if (url.pathname === `/v1/sandboxes/${ids[1]}:stop`)
      return Response.json(
        { error: { code: "conflict", status: 409, message: "It is busy." } },
        { status: 409 },
      );
    if (url.pathname === `/v1/sandboxes/${ids[0]}:stop`)
      return Response.json({ id: ids[0], kind: "sandbox", state: "stopped" });
    return Response.json({ error: { code: "route_not_found", message: "?" } }, { status: 404 });
  }) as typeof fetch;
  const lines: string[] = [];
  const out = {
    json: false,
    write: (t: string) => lines.push(t),
    error: (t: string) => lines.push(t),
  };
  try {
    expect(await run(["sandbox", "stop", "--label", "run=a"], env, out)).toBe(1);
  } finally {
    globalThis.fetch = original;
  }
  expect(seen[0]).toBe("GET /v1/sandboxes?label=run%3Aa&limit=100");
  const said = lines.join("\n");
  expect(said).toContain("1 stopped, 1 failed.");
  expect(said).toContain(`${ids[0]} stopped`);
  expect(said).toContain(`${ids[1]} failed: It is busy.`);
});
