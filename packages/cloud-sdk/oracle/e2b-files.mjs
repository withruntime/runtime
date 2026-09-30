/* global AbortSignal */
import { assert, check, loadOfficial, loadRuntime } from "./context.mjs";
export async function runE2BFiles() {
  const { Sandbox } = await loadOfficial("e2b", "dist/index.js"),
    { Filesystem } = await loadRuntime("e2b/filesystem.ts"),
    sandbox = () =>
      new Sandbox({
        sandboxId: "fixture",
        envdVersion: "0.6.4",
        apiKey: "fixture",
        domain: "invalid.example",
      });
  await check("E2B file remove refuses caller cancellation before effects", async () => {
    const values = {};
    for (const variant of ["official", "runtime"]) {
      let effects = 0;
      const signal = AbortSignal.abort(Error("caller canceled")),
        remove = async (body, opts) => {
          opts?.signal?.throwIfAborted();
          effects++;
          return {};
        };
      let files;
      if (variant === "official") {
        const sb = sandbox();
        sb.files.rpc = { remove };
        files = sb.files;
      } else
        files = new Filesystem({
          envs: {},
          ensureHome: async () => {},
          runtime: { files: { remove } },
        });
      const result = await files.remove("/workspace/customer-file", { signal }).then(
        () => "success",
        (e) => e.message,
      );
      values[variant] = { effects, result };
    }
    assert.deepEqual(values.official, { effects: 0, result: "caller canceled" });
    assert.deepEqual(values.runtime, values.official);
  });
  await check("E2B unlimited file watch keeps native lifetime unlimited", async () => {
    let officialTimeout, nativeTimeout;
    const sb = sandbox();
    sb.files.rpc = {
      watchDir: (body, opts) => {
        officialTimeout = opts.timeoutMs;
        return (async function* () {
          yield { event: { case: "start", value: {} } };
        })();
      },
    };
    let officialHandle, runtimeHandle;
    try {
      officialHandle = await sb.files.watchDir("/workspace", () => {}, { timeoutMs: 0 });
      runtimeHandle = await new Filesystem({
        envs: {},
        ensureHome: async () => {},
        runtime: {
          files: {
            watch: async (path, callback, opts) => {
              nativeTimeout = opts.timeoutMs;
              return { stop: async () => {} };
            },
          },
        },
      }).watchDir("/workspace", () => {}, { timeoutMs: 0 });
      assert.equal(officialTimeout, 0);
      assert.equal(nativeTimeout, officialTimeout);
    } finally {
      await officialHandle?.stop();
      await runtimeHandle?.stop();
    }
  });
}
