import { expect, test } from "bun:test";
import { Runtime, ServiceUnavailableError, NotFoundError } from "../src/index";

/* An answer later than the API holds its headers (90 s) arrives as a 200
   with `runtime-late-answer: true`, whitespace while the work runs, then its
   JSON: the answer, or {"error": ...} when the work failed after the status
   went (packages/cloud/src/api/hold.ts). A failure must be thrown as the
   typed error it is, not returned as a result. */

const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";

function client(bodies: string[]) {
  let calls = 0;
  const fetcher = (async (url: string) => {
    calls++;
    if (new URL(url).pathname === `/v1/sandboxes/${ID}`)
      return Response.json({ id: ID, kind: "sandbox", state: "running", status: "active" });
    return new Response(bodies.shift() ?? "{}", {
      status: 200,
      headers: { "content-type": "application/json", "runtime-late-answer": "true" },
    });
  }) as unknown as typeof fetch;
  return {
    runtime: new Runtime({
      apiKey: "rk",
      baseUrl: "https://api.example.test",
      fetch: fetcher,
      maxRetries: 1,
    }),
    calls: () => calls,
  };
}

test("a late answer that succeeded is the answer", async () => {
  const { runtime } = client([
    '\n\n{"exitCode":0,"stdout":"done\\n","stderr":"","timedOut":false}',
  ]);
  const sbx = await runtime.sandboxes.get(ID);
  expect(await sbx.exec("sleep 100", { timeoutMs: 50_000 })).toMatchObject({ stdout: "done\n" });
});

test("a late answer that failed is thrown as its typed error, and retried when it may pass", async () => {
  const gone = JSON.stringify({
    error: { code: "sandbox_not_found", status: 404, message: "It stopped.", requestId: "req_1" },
  });
  const { runtime } = client([`\n${gone}`]);
  const sbx = await runtime.sandboxes.get(ID);
  const error = await sbx.exec("x", { timeoutMs: 50_000 }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(NotFoundError);
  expect((error as NotFoundError).requestId).toBe("req_1");
  const busy = JSON.stringify({ error: { code: "busy", status: 503, message: "Busy." } });
  const again = client([busy, busy]);
  const failed = await (
    await again.runtime.sandboxes.get(ID)
  )
    .exec("x", { timeoutMs: 50_000 })
    .catch((e: unknown) => e);
  expect(failed).toBeInstanceOf(ServiceUnavailableError);
  expect(again.calls()).toBe(3);
});

test("an answer with an error of its own, such as a code cell's, stays an answer", async () => {
  const { runtime } = client([
    JSON.stringify({ status: "error", results: [], error: { name: "ValueError", value: "x" } }),
  ]);
  const answer = await runtime.transport.json<{ error: { name: string } }>({
    method: "POST",
    path: "/v1/anything",
    body: {},
  });
  expect(answer.error.name).toBe("ValueError");
});
