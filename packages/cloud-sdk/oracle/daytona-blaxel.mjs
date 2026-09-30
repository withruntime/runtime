/* global URL, Response, AbortSignal */
import { assert, check, shell, loadOfficial, loadRuntime, setFixture } from "./context.mjs";
export async function runDaytonaBlaxel() {
  const { Process: OfficialDaytona } = await loadOfficial("@daytona/sdk", "esm/Process.js"),
    { Process: RuntimeDaytona } = await loadRuntime("daytona/process.ts"),
    { SandboxProcess: OfficialBlaxel } = await loadOfficial(
      "@blaxel/core",
      "dist/cjs/sandbox/process/process.js",
    ),
    { SandboxProcess: RuntimeBlaxel } = await loadRuntime("blaxel/process.ts"),
    original = new OfficialDaytona(
      { basePath: "http://offline-fixture.invalid" },
      {
        executeCommand: async (req) => {
          const r = await shell(req.command, { env: req.envs });
          return { data: { exitCode: r.exitCode, result: r.stdout + r.stderr } };
        },
        codeRun: async (req) => {
          const r = await shell(["python3", "-c", req.code, ...(req.argv ?? [])], {
            env: req.envs,
          });
          return { data: { exitCode: r.exitCode, result: r.stdout + r.stderr } };
        },
      },
      async () => "",
      "python",
    ),
    runtime = new RuntimeDaytona({
      language: "python",
      env: {},
      live: async () => ({ exec: (cmd, opts) => shell(cmd, { env: opts.env }) }),
      ensureHome: async () => {},
    });
  for (const command of ["printf hello", "printf err >&2; exit 7", "true"])
    await check("Daytona command " + JSON.stringify(command), async () =>
      assert.deepEqual(
        await runtime.executeCommand(command),
        await original.executeCommand(command),
      ),
    );
  await check("Daytona Python argv and env", async () => {
    const code = 'import os,sys; print(os.environ["CHECK"]+":"+sys.argv[1])',
      params = { argv: ["quoted space"], env: { CHECK: "ok" } };
    assert.deepEqual(await runtime.codeRun(code, params), await original.codeRun(code, params));
  });
  const expected = {
    pid: "p1",
    name: "fixture",
    command: "printf hello",
    status: "failed",
    exitCode: 7,
    stdout: `hello
`,
    stderr: `oops
`,
    logs: `hello
oops
`,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    workingDir: "",
  };
  setFixture(async (req) => {
    assert.equal(new URL(req.url).pathname, "/process");
    assert.equal(req.method, "POST");
    const events = [
      {
        type: "stdout",
        data: `hello
`,
      },
      {
        type: "stderr",
        data: `oops
`,
      },
      { type: "result", data: JSON.stringify(expected) },
    ];
    return new Response(
      events.map((e) => JSON.stringify(e)).join(`
`) +
        `
`,
      { headers: { "content-type": "application/x-ndjson" } },
    );
  });
  try {
    const a = new OfficialBlaxel({
        metadata: { name: "offline-fixture" },
        forceUrl: "http://offline-fixture.invalid",
        headers: {},
      }),
      b = new RuntimeBlaxel({
        id: "offline-reference",
        live: async () => ({
          async *execStream() {
            yield { type: "start", processId: "p1" };
            yield {
              type: "stdout",
              data: `hello
`,
            };
            yield {
              type: "stderr",
              data: `oops
`,
            };
            yield { type: "exit", exitCode: 7, timedOut: !1, state: "exited" };
          },
        }),
        keepAliveEnded: async () => {},
        keepAwake: async () => {},
        wake: async () => {},
      });
    await check("Blaxel streaming nonzero results and callback order", async () => {
      const values = [];
      for (const api of [a, b]) {
        const callbacks = [],
          r = await api.exec({
            name: "fixture",
            command: "printf hello",
            waitForCompletion: !0,
            onStdout: (d) => callbacks.push(["stdout", d]),
            onStderr: (d) => callbacks.push(["stderr", d]),
            onLog: (d) => callbacks.push(["log", d]),
          });
        values.push({
          result: Object.fromEntries(
            ["stdout", "stderr", "logs", "status", "exitCode", "workingDir"].map((k) => [k, r[k]]),
          ),
          callbacks,
        });
      }
      assert.deepEqual(values[1], values[0]);
    });
    for (const options of [
      { maxWait: 0 },
      { maxWait: -2 },
      { interval: 0 },
      { signal: AbortSignal.abort("cancelled-by-customer") },
    ])
      await check("Blaxel wait " + JSON.stringify(options), async () => {
        const values = [];
        for (const api of [a, b])
          try {
            await api.wait("p1", options);
            values.push("unexpected success");
          } catch (e) {
            values.push(typeof e === "object" ? { name: e.name, message: e.message } : e);
          }
        assert.deepEqual(values[1], values[0]);
      });
  } finally {
    setFixture();
  }
}
