/* global TextEncoder, Bun, Response */
import { assert, check, loadOfficial, loadRuntime } from "./context.mjs";
export async function runE2B() {
  const { Sandbox: OfficialSandbox } = await loadOfficial("e2b", "dist/index.js"),
    { CommandHandle } = await loadRuntime("e2b/commands.ts"),
    { Process } = await loadRuntime("sandbox.ts"),
    { Transport } = await loadRuntime("transport.ts"),
    event = (kind, value) => ({ event: { event: { case: kind, value } } });
  async function* events(code = 0, gate = Promise.resolve()) {
    yield event("start", { pid: 1 });
    await gate;
    yield event("data", { output: { case: "stdout", value: new TextEncoder().encode("hello") } });
    yield event("end", { exitCode: code, error: code ? "exit status " + code : "" });
  }
  const nativeProcess = (code = 0) => ({
    id: "p",
    async *output() {
      yield { type: "stdout", data: "hello" };
      yield { type: "exit", exitCode: code, timedOut: !1 };
    },
    kill: async () => {},
    write: async () => {},
  });
  async function officialHandle(code = 0, opts = {}) {
    const sb = new OfficialSandbox({
      sandboxId: "offline-fixture",
      envdVersion: "0.5.0",
      apiKey: "offline-fixture",
      domain: "invalid.example",
    });
    sb.commands.rpc = {
      start: () => events(code),
      sendSignal: async () => {},
      sendInput: async () => {},
      closeStdin: async () => {},
    };
    return sb.commands.run("fixture", { ...opts, background: !0 });
  }
  async function result(h) {
    try {
      return { ok: !0, result: await h.wait(), exitCode: h.exitCode, error: h.error };
    } catch (e) {
      return {
        ok: !1,
        name: e.name,
        message: e.message,
        stdout: e.stdout,
        stderr: e.stderr,
        exitCode: e.exitCode,
        error: h.error,
      };
    }
  }
  for (const code of [0, 7])
    await check("E2B command result and error " + code, async () =>
      assert.deepEqual(
        await result(new CommandHandle(nativeProcess(code), { stdin: !1, timeoutMs: 60000 })),
        await result(await officialHandle(code)),
      ),
    );
  await check("E2B async stdout callback awaited", async () => {
    for (const variant of ["official", "runtime"]) {
      let finished = !1;
      const onStdout = async () => {
        await Bun.sleep(10);
        finished = !0;
      };
      await (
        variant === "official"
          ? await officialHandle(0, { onStdout })
          : new CommandHandle(nativeProcess(), { stdin: !1, timeoutMs: 60000, onStdout })
      ).wait();
      assert.equal(finished, !0, variant);
    }
  });
  await check("E2B async callback exception propagation", async () => {
    const onStdout = async () => {
      throw Error("customer-callback-failed");
    };
    assert.deepEqual(
      await result(new CommandHandle(nativeProcess(), { stdin: !1, timeoutMs: 60000, onStdout })),
      await result(await officialHandle(0, { onStdout })),
    );
  });
  await check("E2B disconnect prevents buffered callbacks and successful wait", async () => {
    const values = {};
    for (const provider of ["official", "runtime"]) {
      let release;
      const gate = new Promise((r) => (release = r));
      let h;
      const seen = [],
        onStdout = async (data) => {
          seen.push(data);
          if (data === "first") await h.disconnect();
        };
      if (provider === "official") {
        const sb = new OfficialSandbox({
          sandboxId: "fixture",
          envdVersion: "0.5.0",
          apiKey: "fixture",
          domain: "invalid.example",
        });
        sb.commands.rpc = {
          start: () =>
            (async function* () {
              yield event("start", { pid: 1 });
              await gate;
              for (const data of ["first", "second"])
                yield event("data", {
                  output: { case: "stdout", value: new TextEncoder().encode(data) },
                });
              yield event("end", { exitCode: 0, error: "" });
            })(),
        };
        h = await sb.commands.run("fixture", { background: !0, onStdout });
      } else {
        const t = new Transport({
          apiKey: "fixture",
          baseUrl: "http://localhost",
          fetch: async () => {
            await gate;
            return new Response(
              [
                { type: "stdout", data: "first", offset: 0 },
                { type: "stdout", data: "second", offset: 5 },
                { type: "exit", exitCode: 0, timedOut: !1, state: "exited" },
              ].map(JSON.stringify).join(`
`) +
                `
`,
              { headers: { "content-type": "application/x-ndjson" } },
            );
          },
        });
        h = new CommandHandle(new Process(t, "fixture", { id: "p", stdinOffset: 0 }), {
          stdin: !1,
          timeoutMs: 60000,
          onStdout,
        });
      }
      try {
        release();
        values[provider] = {
          seen,
          result: await h.wait().then(
            () => ({ ok: !0 }),
            (e) => ({ ok: !1, name: e.name }),
          ),
        };
      } finally {
        await h.disconnect();
      }
    }
    assert.deepEqual(values.runtime, values.official);
  });
}
