import { expect, test } from "bun:test";
import { run } from "../src/cli";
import type { RuntimeError } from "../src/errors";
import { onFakeClock } from "./fixtures/fake-clock";

onFakeClock();

/* `runtime sandboxes never-park <id> on|off`: Runtime's own operator marks the
   release path's sandboxes never parked (20261028190617_cloud_never_park.sql).
   Not in the help; the API refuses it for anyone else. */

const SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
const info = { id: SANDBOX, kind: "sandbox", state: "running", status: "active", labels: {} };

async function cli(argv: string[]) {
  const original = globalThis.fetch;
  const sent: Array<{ method: string; path: string; mark: string | null; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const mark = request.headers.get("runtime-never-park");
    sent.push({
      method: request.method,
      path: new URL(request.url).pathname,
      mark,
      body: request.method === "GET" ? "" : await request.text(),
    });
    return Response.json({ ...info, ...(mark === "true" ? { neverPark: true } : {}) });
  }) as typeof fetch;
  const lines: string[] = [];
  try {
    const code = await run(argv, env, {
      json: false,
      write: (t) => lines.push(t),
      error: (t) => lines.push(`ERR ${t}`),
    });
    return { code, text: lines.join("\n"), sent, error: undefined };
  } catch (error) {
    return { code: 1, text: lines.join("\n"), sent, error: error as RuntimeError };
  } finally {
    globalThis.fetch = original;
  }
}

test("never-park sends the mark on an update of the sandbox and says what it holds", async () => {
  const on = await cli(["sandboxes", "never-park", SANDBOX, "on"]);
  const update = on.sent.find((r) => r.path.endsWith(":update"));
  expect(update).toMatchObject({
    method: "POST",
    path: `/v1/sandboxes/${SANDBOX}:update`,
    mark: "true",
    body: "{}",
  });
  expect(on.text).toBe(`${SANDBOX} never parked: on`);
  const off = await cli(["sandboxes", "never-park", SANDBOX, "off"]);
  expect(off.sent.find((r) => r.path.endsWith(":update"))?.mark).toBe("false");
  expect(off.text).toBe(`${SANDBOX} never parked: off`);
  // No other call carries it.
  expect(on.sent.filter((r) => !r.path.endsWith(":update")).every((r) => r.mark === null)).toBe(
    true,
  );
});

test("never-park takes on or off and nothing else, and sends nothing otherwise", async () => {
  for (const argv of [
    ["sandboxes", "never-park", SANDBOX],
    ["sandboxes", "never-park", SANDBOX, "yes"],
    ["sandboxes", "never-park", SANDBOX, "on", "--bogus"],
  ]) {
    const { sent, error } = await cli(argv);
    expect(error?.code).toBe("usage");
    expect(sent).toEqual([]);
  }
});
