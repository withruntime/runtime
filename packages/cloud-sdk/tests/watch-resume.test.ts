import { expect, test } from "bun:test";

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
