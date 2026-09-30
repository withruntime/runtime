import { expect, test } from "bun:test";
import { WatchHandle } from "../src/products/watch";
import type { Transport } from "../src/transport";

/* Defect, 29 September 2026: a write that finished before `watch.stop()` was
   never delivered. The docs' example printed only "watch ended: stopped". The
   watch in the sandbox reports what it had not yet sent when it is stopped,
   then ends; stop() waits for that. */

function fixture(finalBatch: boolean) {
  let deleted = false;
  const exits: string[] = [];
  const seen: string[] = [];
  const transport = {
    json: async () => {
      deleted = true;
      return { stopped: true };
    },
    async *events() {
      // Nothing until the stop: the write sat in the watch's batch.
      while (!deleted) await new Promise((resolve) => setTimeout(resolve, 5));
      if (finalBatch)
        yield {
          k: "events",
          cursor: 40,
          events: [{ type: "write", path: "/workspace/note.txt", isDir: false }],
        };
      yield { k: "end", reason: "stopped", cursor: 60 };
    },
  } as unknown as Transport;
  const handle = new WatchHandle(
    transport,
    "/watch",
    "id",
    "/workspace",
    0,
    { onExit: (reason) => exits.push(reason) },
    (event) => {
      seen.push(event.path);
    },
  ).begin();
  return { handle, exits, seen };
}

test("stop delivers what changed before it, then ends once", async () => {
  const { handle, exits, seen } = fixture(true);
  await handle.stop();
  expect(seen).toEqual(["/workspace/note.txt"]);
  expect(exits).toEqual(["stopped"]);
  expect(handle.cursor).toBe(60);
  // After stop, nothing more, and a second stop is a no-op.
  await handle.stop();
  expect(exits).toEqual(["stopped"]);
});

test("stop with nothing pending returns as soon as the watch ends", async () => {
  const { handle, seen } = fixture(false);
  const started = Date.now();
  await handle.stop();
  expect(seen).toEqual([]);
  expect(Date.now() - started).toBeLessThan(1_000);
});
