import { expect, test } from "bun:test";
import { Process, Processes } from "../src/sandbox";
import { Sandbox } from "../src/sandbox";
import type { SandboxInfo } from "../src/types";
import type { Transport, Call } from "../src/transport";
import type { ProcessInfo } from "../src/types";

test("aborting a queued input write rejects promptly and never sends its bytes", async () => {
  const blocked = Promise.withResolvers<void>();
  const calls: Call[] = [];
  const process = new Process(
    {
      json: async (call: Call) => {
        calls.push(call);
        if (calls.length === 1) await blocked.promise;
        const body = call.body as { offset: number; base64: string };
        return { offset: body.offset + Buffer.from(body.base64, "base64").length };
      },
    } as unknown as Transport,
    "sandbox",
    { id: "process" } as ProcessInfo,
  );
  const first = process.write("one");
  await Promise.resolve();
  const abort = new AbortController();
  const queued = process.write("cancelled", { signal: abort.signal });
  abort.abort();
  await expect(queued).rejects.toMatchObject({ code: "timeout" });
  expect(calls).toHaveLength(1);
  blocked.resolve();
  await first;
  await process.write("two", { eof: true });
  expect(
    calls.map((call) => Buffer.from((call.body as { base64: string }).base64, "base64").toString()),
  ).toEqual(["one", "two"]);
});

test("a logical input deadline also cancels zero-progress backpressure", async () => {
  const calls: Call[] = [];
  const process = new Process(
    {
      json: async (call: Call) => {
        calls.push(call);
        return { offset: 0 };
      },
    } as unknown as Transport,
    "sandbox",
    { id: "process" } as ProcessInfo,
  );
  await expect(process.write("blocked", { timeoutMs: 20 })).rejects.toMatchObject({
    code: "timeout",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.signal?.aborted).toBe(true);
  expect(calls[0]!.timeoutMs).toBe(0);
});

test("caller idempotency keys are refused before any input mutation", async () => {
  const calls: Call[] = [];
  const process = new Process(
    {
      json: async (call: Call) => {
        calls.push(call);
        return { offset: calls.length === 1 ? 0 : 1 };
      },
    } as unknown as Transport,
    "sandbox",
    { id: "process" } as ProcessInfo,
  );
  await expect(
    process.write("x", { idempotencyKey: "logical-write" } as never),
  ).rejects.toMatchObject({ code: "unsupported_process_write_option" });
  expect(calls).toHaveLength(0);
});

test("process list/get/signal/resize preserve request options", async () => {
  const calls: Call[] = [];
  const t = {
    json: async (call: Call) => {
      calls.push(call);
      return call.path.endsWith("/processes") ? { data: [] } : { id: "process" };
    },
  } as unknown as Transport;
  const opts = { signal: new AbortController().signal, timeoutMs: 123 };
  const processes = new Processes(t, "sandbox");
  await processes.list(opts);
  const process = await processes.get("process", opts);
  await process.kill("SIGINT", opts);
  await process.resize(80, 24, opts);
  expect(calls).toHaveLength(4);
  for (const call of calls) {
    expect(call.signal).toBe(opts.signal);
    expect(call.timeoutMs).toBe(123);
  }
});

test("spawn HTTP deadlines remain independent of the guest execution deadline", async () => {
  const calls: Call[] = [];
  const t = {
    json: async (call: Call) => {
      calls.push(call);
      return { id: "process" };
    },
  } as unknown as Transport;
  const sandbox = new Sandbox(t, { id: "sandbox" } as SandboxInfo);
  await sandbox.spawn("sleep 100", {
    timeoutMs: 100000,
    request: { timeoutMs: 0, idempotencyKey: "create-process" },
  });
  expect(calls[0]!.timeoutMs).toBe(0);
  expect((calls[0]!.body as { timeoutMs: number }).timeoutMs).toBe(100000);
  expect(calls[0]!.body).not.toHaveProperty("request");
  expect(calls[0]!.idempotencyKey).toBe("create-process");
});
