import { expect, test } from "bun:test";
import { WatchHandle } from "../src/products/watch";
import type { Transport } from "../src/transport";

test("a file event callback can await stop without awaiting itself or delivering the rest of the batch", async () => {
  const exits: string[] = [],
    seen: string[] = [];
  let deletes = 0;
  const transport = {
    json: async () => {
      deletes++;
      return { stopped: true };
    },
    async *events() {
      await Promise.resolve();
      yield {
        k: "events",
        cursor: 1,
        events: [
          { type: "write", path: "/workspace/one", isDir: false },
          { type: "write", path: "/workspace/two", isDir: false },
        ],
      };
    },
  } as unknown as Transport;
  const handle = new WatchHandle(
    transport,
    "/watch",
    "id",
    "/workspace",
    0,
    {
      onExit: (reason) => {
        exits.push(reason);
      },
    },
    async (event) => {
      seen.push(event.path);
      await handle.stop();
    },
  );
  handle.begin();
  await Promise.race([
    handle.done,
    new Promise((_, reject) => setTimeout(() => reject(new Error("watch deadlock")), 200)),
  ]);
  await handle.stop();
  expect(seen).toEqual(["/workspace/one"]);
  expect(exits).toEqual(["stopped"]);
  expect(deletes).toBe(1);
});
