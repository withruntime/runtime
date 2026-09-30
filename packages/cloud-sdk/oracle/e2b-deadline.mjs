/* global Bun, TextEncoder, Response, setTimeout, clearTimeout */
import { assert, check, loadOfficial, loadRuntime } from "./context.mjs";
export async function runE2BDeadline() {
  const { Sandbox } = await loadOfficial("e2b", "dist/index.js"),
    { ConnectError, Code } = await loadOfficial("@connectrpc/connect", "dist/esm/index.js"),
    { Commands } = await loadRuntime("e2b/commands.ts"),
    event = (kind, value) => ({ event: { event: { case: kind, value } } });
  for (const background of [!0, !1])
    await check(
      `E2B ${background ? "background" : "foreground"} deadline preserves process and reconnect deadline`,
      async () => {
        const outcomes = {};
        for (const variant of ["official", "runtime"]) {
          let child,
            text,
            kills = 0,
            spawnOptions;
          const calls = [],
            handles = [],
            start = () => {
              child = Bun.spawn(["bash", "-c", "sleep 0.3; printf completed"], {
                stdin: "ignore",
                stdout: "pipe",
                stderr: "ignore",
              });
              text = new Response(child.stdout).text();
            },
            info = { id: "deadline-process", state: "running", stdinOpen: !1 };
          async function waitForExit(timeoutMs, signal) {
            let timer, abort;
            try {
              signal?.throwIfAborted();
              await Promise.race([
                child.exited,
                new Promise((_, reject) => {
                  if (timeoutMs)
                    timer = setTimeout(
                      () => reject(new ConnectError("deadline exceeded", Code.DeadlineExceeded)),
                      timeoutMs,
                    );
                  if (signal) {
                    abort = () => reject(signal.reason);
                    signal.addEventListener("abort", abort, { once: !0 });
                  }
                }),
              ]);
              signal?.throwIfAborted();
            } finally {
              if (timer) clearTimeout(timer);
              if (abort) signal?.removeEventListener("abort", abort);
            }
          }
          async function* rpc(body, opts) {
            yield event("start", { pid: 123 });
            await waitForExit(opts.timeoutMs);
            yield event("data", {
              output: { case: "stdout", value: new TextEncoder().encode(await text) },
            });
            yield event("end", { exitCode: await child.exited, error: "" });
          }
          let commands;
          if (variant === "official") {
            const sandbox = new Sandbox({
              sandboxId: "fixture",
              envdVersion: "0.5.0",
              apiKey: "fixture",
              domain: "invalid.example",
            });
            sandbox.commands.rpc = {
              start: (body, opts) => {
                calls.push({ method: "start", body, timeoutMs: opts.timeoutMs });
                start();
                return rpc(body, opts);
              },
              connect: (body, opts) => {
                calls.push({ method: "connect", body, timeoutMs: opts.timeoutMs });
                return rpc(body, opts);
              },
              sendSignal: async () => {
                kills++;
                child.kill();
              },
            };
            commands = sandbox.commands;
          } else {
            const proc = {
              id: info.id,
              info,
              async *output({ signal }) {
                await waitForExit(void 0, signal);
                yield { type: "stdout", data: await text, offset: 0 };
                yield { type: "exit", exitCode: await child.exited, timedOut: !1 };
              },
              kill: async () => {
                kills++;
                child.kill();
              },
            };
            commands = new Commands({
              envs: {},
              ensureHome: async () => {},
              runtime: {
                spawn: async (_cmd, opts) => {
                  spawnOptions = opts;
                  start();
                  return proc;
                },
                processes: { list: async () => [info], get: async () => proc },
              },
            });
          }
          try {
            let pid;
            const initial = await (async () => {
              try {
                const result = await commands.run("sleep 0.3; printf completed", {
                  background,
                  timeoutMs: 20,
                });
                if (background) {
                  handles.push(result);
                  pid = result.pid;
                  await result.wait();
                }
                return "success";
              } catch (e) {
                return e.name;
              }
            })();
            assert.equal(initial, "TimeoutError", variant);
            assert.equal(child.exitCode, null, variant + " child remains running");
            assert.equal(kills, 0);
            if (!background)
              pid =
                variant === "official"
                  ? 123
                  : (await loadRuntime("e2b/commands.ts")).pidOf(info.id);
            const short = await commands.connect(pid, { timeoutMs: 20 });
            handles.push(short);
            const next = await short.wait().then(
              () => "success",
              (e) => e.name,
            );
            assert.equal(next, "TimeoutError");
            assert.equal(child.exitCode, null);
            assert.equal(kills, 0);
            const again = await commands.connect(pid, { timeoutMs: 0 });
            handles.push(again);
            const result = await again.wait();
            assert.equal(kills, 0);
            assert.equal(result.stdout, "completed");
            assert.equal(result.exitCode, 0);
            if (variant === "official") {
              assert.deepEqual(
                calls.map((c) => [c.method, c.timeoutMs]),
                [
                  ["start", 20],
                  ["connect", 20],
                  ["connect", 0],
                ],
              );
              assert.deepEqual(calls[0].body, {
                process: {
                  cmd: "/bin/bash",
                  args: ["-l", "-c", "sleep 0.3; printf completed"],
                  cwd: void 0,
                  envs: void 0,
                },
                stdin: !1,
              });
              for (const call of calls.slice(1))
                assert.deepEqual(call.body, { process: { selector: { case: "pid", value: 123 } } });
            } else assert.equal(Object.hasOwn(spawnOptions, "timeoutMs"), !1);
            outcomes[variant] = { initial, next, result, kills };
          } finally {
            for (const handle of handles) await handle.disconnect();
            if (child?.exitCode === null) child.kill();
            if (child) await child.exited;
          }
        }
        assert.deepEqual(outcomes.runtime, outcomes.official);
      },
    );
}
