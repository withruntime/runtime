/* global Bun, Request, Response, ReadableStream, TextEncoder, URL, setTimeout, clearTimeout */
import { assert, check, loadOfficial, loadRuntime, setFixture } from "./context.mjs";

function wait(milliseconds, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export async function runE2BInterpreter() {
  const { Sandbox: Official } = await loadOfficial("@e2b/code-interpreter", "dist/index.js");
  const { Sandbox: Adapter } = await loadRuntime("e2b/code-interpreter.ts");
  const { Runtime } = await loadRuntime("client.ts");
  const fixture = "http://offline-fixture.invalid";
  for (const spec of [
    {
      name: "header deadline",
      headers: 60,
      body: 5,
      opts: { requestTimeoutMs: 10, timeoutMs: 0 },
      expected: "Request",
    },
    {
      name: "body deadline",
      headers: 1,
      body: 60,
      opts: { requestTimeoutMs: 1000, timeoutMs: 10 },
      expected: "Execution",
    },
    {
      name: "unlimited body outlives header deadline",
      headers: 1,
      body: 60,
      opts: { requestTimeoutMs: 20, timeoutMs: 0 },
    },
    {
      name: "header wait is outside body deadline",
      headers: 60,
      body: 1,
      opts: { requestTimeoutMs: 0, timeoutMs: 30 },
    },
  ])
    await check(`E2B interpreter ${spec.name}`, async () => {
      const results = {};
      for (const variant of ["official", "runtime"]) {
        setFixture(async (request) => {
          if (request.method === "GET")
            return Response.json({
              id: "fixture",
              state: "running",
              kind: "sandbox",
              status: "active",
            });
          const body = await request.json();
          if (variant === "runtime") {
            assert.equal(body.timeoutMs, 0);
            assert.equal(body.interruptOnDisconnect, false);
            assert.equal(body.stream, true);
          } else assert.equal(Object.hasOwn(body, "timeoutMs"), false);
          await wait(spec.headers, request.signal);
          return new Response(
            new ReadableStream({
              async start(controller) {
                try {
                  await wait(spec.body, request.signal);
                  const events =
                    variant === "official"
                      ? [
                          { type: "stdout", text: "hello\n" },
                          { type: "result", text: "2", is_main_result: true },
                          { type: "number_of_executions", execution_count: 1 },
                        ]
                      : [
                          { k: "stdout", text: "hello\n" },
                          { k: "result", main: true, data: { "text/plain": "2" }, refs: {} },
                          {
                            k: "execution",
                            execution: {
                              status: "ok",
                              stdout: "hello\n",
                              stderr: "",
                              executionCount: 1,
                              results: [{ main: true, data: { "text/plain": "2" }, refs: {} }],
                            },
                          },
                        ];
                  controller.enqueue(
                    new TextEncoder().encode(
                      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
                    ),
                  );
                  controller.close();
                } catch (error) {
                  controller.error(error);
                }
              },
            }),
            { headers: { "content-type": "application/x-ndjson" } },
          );
        });
        let sandbox;
        if (variant === "official") {
          sandbox = new Official({
            sandboxId: "fixture",
            envdVersion: "0.6.4",
            apiKey: "fixture",
            domain: "invalid.example",
          });
          sandbox.getJupyterRequestUrl = () => `${fixture}/execute`;
        } else {
          const client = new Runtime({
            apiKey: "rt_fixture",
            baseUrl: "http://localhost",
            maxRetries: 0,
            fetch: (input, init) =>
              globalThis.fetch(new Request(fixture + new URL(input).pathname, init)),
          });
          sandbox = new Adapter(await client.sandboxes.get("fixture"), client);
        }
        const callbacks = [];
        results[variant] = await sandbox
          .runCode("1+1", {
            ...spec.opts,
            onStdout: async (output) => {
              await Bun.sleep(2);
              assert(Math.abs(output.timestamp / 1000 - Date.now()) < 1000);
              callbacks.push(output.line);
            },
            onResult: async (result) => {
              await Bun.sleep(2);
              callbacks.push(result.text);
            },
          })
          .then(
            (execution) => ({ text: execution.text, callbacks }),
            (error) => ({
              name: error.name,
              stage: error.message.startsWith("Execution") ? "Execution" : "Request",
            }),
          );
      }
      assert.deepEqual(results.runtime, results.official);
      if (spec.expected)
        assert.deepEqual(results.runtime, { name: "TimeoutError", stage: spec.expected });
      else assert.deepEqual(results.runtime, { text: "2", callbacks: ["hello\n", "2"] });
    });
}
