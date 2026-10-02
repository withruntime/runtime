import { expect, test } from "bun:test";
import { WatchHandle } from "../src/products/watch";
import type { Transport } from "../src/transport";

test("resume refuses an active reader and stop cancels that sole reader", async () => {
  const signals: AbortSignal[] = [];
  const deletion = Promise.withResolvers<void>();
  const handle = new WatchHandle(
    {
      json: async () => {
        deletion.resolve();
        return { stopped: true };
      },
      async *events({ signal }: { signal: AbortSignal }) {
        signals.push(signal);
        await deletion.promise;
        yield { k: "end", reason: "stopped", cursor: 1 };
      },
    } as unknown as Transport,
    "/watches",
    "id",
    "/workspace",
    0,
    {},
  ).begin();
  expect(() => handle.resume()).toThrow("already delivering");
  expect(() => handle.begin()).toThrow("already delivering");
  await handle.stop();
  expect(signals).toHaveLength(1);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

test("a paused exit callback may resume without the old reader retiring its replacement", async () => {
  let streams = 0;
  const started = Promise.withResolvers<void>();
  const deletion = Promise.withResolvers<void>();
  const exits: string[] = [];
  const handle = new WatchHandle(
    {
      json: async () => {
        deletion.resolve();
        return { stopped: true };
      },
      async *events() {
        if (++streams === 1) {
          yield { k: "paused", cursor: 7 };
          return;
        }
        started.resolve();
        await deletion.promise;
        yield { k: "end", reason: "stopped", cursor: 8 };
      },
    } as unknown as Transport,
    "/watches",
    "id",
    "/workspace",
    0,
    {
      onExit: (reason) => {
        exits.push(reason);
        if (reason === "paused") handle.resume();
      },
    },
  ).begin();
  await started.promise;
  await Promise.resolve();
  expect(() => handle.resume()).toThrow("already delivering");
  await handle.stop();
  await handle.done;
  expect(streams).toBe(2);
  expect(handle.cursor).toBe(8);
  expect(exits).toEqual(["paused", "stopped"]);
});

test("a resumed watch keeps connection errors on done without an unhandled rejection", async () => {
  // A separate process observes the real unhandled-rejection boundary without
  // installing a process-wide error handler in the test runner.
  const source = new URL("../src/products/watch.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
      const { WatchHandle } = await import(process.argv[1]);
      const unhandled = [];
      process.on("unhandledRejection", error => unhandled.push(String(error)));
      const transport = { async *events() { throw new Error("connection lost"); } };
      const handle = new WatchHandle(transport, "/watches", "w-test", "/workspace", 0, {});
      handle.begin();
      await handle.done.catch(() => undefined);
      handle.resume();
      await new Promise(resolve => setTimeout(resolve, 20));
      let observed;
      await handle.done.catch(error => { observed = error.message; });
      console.log(JSON.stringify({ unhandled, observed }));
      `,
      source,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(status, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ unhandled: [], observed: "connection lost" });
});
