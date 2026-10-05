import { expect, test } from "bun:test";
import { Runtime } from "../../src/client";
import { Sandbox } from "../../src/e2b/sandbox";

/* An orchestrator moved from E2B runs one agent per sandbox, a thousand at
   once, each in commands.run. One address may hold 64 connections to the API,
   and each running command's output is a stream that holds one. The adapter
   shares its client's cap: commands past it wait their turn and then run,
   rather than having their connections reset. */
test("many commands at once from one client stay under its connection cap and all finish", async () => {
  let open = 0;
  let peak = 0;
  const encoder = new TextEncoder();
  const fetcher = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    open++;
    peak = Math.max(peak, open);
    if (init.method === "POST" && url.pathname === "/v1/sandboxes") {
      open--;
      return Response.json({
        id: "sbx",
        kind: "sandbox",
        state: "running",
        status: "active",
        labels: {},
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    if (init.method === "POST" && url.pathname.endsWith(":exec")) {
      const id = `p${Math.random()}`;
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              encoder.encode(`${JSON.stringify({ type: "start", processId: id })}\n`),
            );
            await Bun.sleep(15);
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({ type: "stdout", data: "ok\n", offset: 0 })}\n${JSON.stringify({ type: "exit", exitCode: 0, state: "exited", timedOut: false })}\n`,
              ),
            );
            open--;
            controller.close();
          },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }
    open--;
    return Response.json({});
  }) as unknown as typeof fetch;
  const client = new Runtime({
    apiKey: "rk",
    baseUrl: "https://api.example.test",
    fetch: fetcher,
    maxConnections: 12,
  });
  const sbx = await Sandbox.create({ runtime: { client } });
  const results = await Promise.all(
    Array.from({ length: 60 }, (_, i) => sbx.commands.run(`echo ${i}`)),
  );
  expect(results.every((result) => result.exitCode === 0 && result.stdout === "ok\n")).toBe(true);
  expect(peak).toBeLessThanOrEqual(12);
  await sbx.kill();
});
