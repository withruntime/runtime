import { expect, test } from "bun:test";
import { volumes } from "../src/products/volumes";
import type { Call, Transport } from "../src/transport";
test("native volume mutations preserve encoded identity, exact bodies, wait overrides and request options", async () => {
  const calls: Call[] = [];
  const t = {
    json: async (call: Call) => {
      calls.push(call);
      return { id: "result" };
    },
  } as unknown as Transport;
  const v = volumes(t);
  const signal = new AbortController().signal;
  await v.resize("v/id", { sizeMiB: 128 }, { wait: 0, idempotencyKey: "resize", signal });
  await v.attach("v/id", { sandboxId: "guest", path: "/data" });
  await v.detach("v/id", "a/id", { wait: 12, idempotencyKey: "detach" });
  await v.getAttachment("v/id", "a/id", { signal });
  await v.create({ sizeMiB: 64, shared: true });
  expect(calls.map((c) => [c.method, c.path, c.body, c.wait])).toEqual([
    ["POST", "/v1/volumes/v%2Fid:resize", { sizeMiB: 128 }, 0],
    ["POST", "/v1/volumes/v%2Fid:attach", { sandboxId: "guest", path: "/data" }, 10],
    ["POST", "/v1/volumes/v%2Fid/attachments/a%2Fid:detach", {}, 12],
    ["GET", "/v1/volumes/v%2Fid/attachments/a%2Fid", undefined, undefined],
    ["POST", "/v1/volumes", { sizeMiB: 64, shared: true }, 10],
  ]);
  expect(calls[0]!.idempotencyKey).toBe("resize");
  expect(calls[0]!.signal).toBe(signal);
  expect(calls[2]!.idempotencyKey).toBe("detach");
  expect(calls[3]!.signal).toBe(signal);
});
