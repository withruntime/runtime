import { expect, test } from "bun:test";
import { Process, Sandbox } from "../src/sandbox";
import { Transport } from "../src/transport";
import { CommandHandle } from "../src/e2b/commands";
import type { ProcessInfo } from "../src/types";

const info = { id: "p", outputEncoding: "base64" } as ProcessInfo;
test("disconnect stops callbacks already buffered in a single HTTP chunk", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport = new Transport({
    apiKey: "fixture",
    baseUrl: "http://localhost",
    fetch: (async () => {
      await gate;
      return new Response(
        [
          { type: "stdout", data: "first", offset: 0 },
          { type: "stdout", data: "second", offset: 5 },
          { type: "exit", exitCode: 0, timedOut: false, state: "exited" },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
      );
    }) as unknown as typeof fetch,
  });
  const seen: string[] = [];
  const handle = new CommandHandle(new Process(transport, "fixture", { id: "p" } as ProcessInfo), {
    stdin: false,
    timeoutMs: 60_000,
    onStdout: async (data) => {
      seen.push(data);
      await handle.disconnect();
    },
  });
  release();
  await expect(handle.wait()).rejects.toMatchObject({ name: "SandboxError" });
  expect(seen).toEqual(["first"]);
  expect(handle.exitCode).toBeUndefined();
});
test("binary process events retain all byte values and resume at byte offsets", async () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const cursors: number[] = [];
  const process = new Process(
    {
      async *events({ query }: { query: { cursor: number } }) {
        cursors.push(query.cursor);
        if (query.cursor === 0) {
          yield {
            type: "stdout",
            data: "replacement",
            base64: Buffer.from(bytes).toString("base64"),
            offset: 0,
          };
          return;
        }
        yield { type: "stderr", data: "", base64: "/wA=", offset: 256 };
        yield { type: "exit", exitCode: 0, state: "exited", timedOut: false };
      },
    } as unknown as Transport,
    "s",
    info,
  );
  const events = await Array.fromAsync(process.outputBytes());
  expect(cursors).toEqual([0, 256]);
  expect(events[0]).toEqual({ type: "stdout", data: bytes, offset: 0 });
  expect(events[1]).toEqual({ type: "stderr", data: new Uint8Array([255, 0]), offset: 256 });
  expect(events.some((e) => e.type === "truncated")).toBe(false);
});
test("binary readers refuse older or malformed text-only streams", async () => {
  const t = {
    async *events() {
      yield { type: "stdout", data: "lost", offset: 0 };
    },
  } as unknown as Transport;
  await expect(
    Array.fromAsync(new Process(t, "s", { id: "p" } as ProcessInfo).outputBytes()),
  ).rejects.toMatchObject({ code: "binary_output_unavailable" });
  await expect(Array.fromAsync(new Process(t, "s", info).outputBytes())).rejects.toMatchObject({
    code: "binary_output_unavailable",
  });
});
test("malformed binary output fails once rather than reconnecting as a network fault", async () => {
  let requests = 0;
  const t = {
    async *events() {
      requests++;
      yield { type: "stdout", data: "", base64: "!invalid!", offset: 0 };
    },
  } as unknown as Transport;
  await expect(Array.fromAsync(new Process(t, "s", info).outputBytes())).rejects.toMatchObject({
    code: "invalid_process_output",
  });
  expect(requests).toBe(1);
});
test("exec awaits asynchronous output callbacks in event order", async () => {
  const seen: string[] = [];
  const t = {
    async *events() {
      yield { type: "start", processId: "p" };
      yield { type: "stdout", data: "a", offset: 0 };
      yield { type: "stderr", data: "b", offset: 1 };
      yield { type: "exit", exitCode: 0, state: "exited", timedOut: false };
    },
  } as unknown as Transport;
  const sandbox = new Sandbox(t, { id: "s" } as never);
  const result = await sandbox.exec("printf a", {
    onStdout: async (text) => {
      await Bun.sleep(5);
      seen.push(text);
    },
    onStderr: async (text) => {
      await Bun.sleep(5);
      seen.push(text);
    },
  });
  expect(seen).toEqual(["a", "b"]);
  expect(result.stdout).toBe("a");
});
