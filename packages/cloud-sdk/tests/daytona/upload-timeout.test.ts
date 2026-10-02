/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- fakes reject with the abort signal's reason, exactly as fetch does. */
import { expect, test } from "bun:test";
import { FileSystem } from "../../src/daytona/filesystem";
import type { SandboxContext } from "../../src/daytona/context";
import { Files } from "../../src/sandbox";
import { Transport } from "../../src/transport";
import type { RequestOptions } from "../../src/transport";

function fixture(stalled = true) {
  const calls: Request[] = [];
  let closed = false;
  const transport = new Transport({
    apiKey: "rtcloud_fixture",
    baseUrl: "https://fixture.invalid",
    maxRetries: 0,
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      calls.push(req);
      if (!stalled) return new Response();
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response()), 150);
        req.signal.addEventListener(
          "abort",
          () => {
            closed = true;
            clearTimeout(timer);
            reject(req.signal.reason);
          },
          { once: true },
        );
      });
    }) as typeof fetch,
  });
  const fs = new FileSystem({
    ensureHome: async () => {},
    live: async () => ({ files: new Files(transport, "sandbox") }),
  } as unknown as SandboxContext);
  return { fs, calls, closed: () => closed };
}

test("Daytona buffer upload honors its seconds deadline and cancels native HTTP", async () => {
  const { fs, calls, closed } = fixture();
  await expect(fs.uploadFile(Buffer.from("data"), "data", 0.01)).rejects.toBeInstanceOf(Error);
  expect(closed()).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.signal.aborted).toBe(true);
});

test("a batch upload deadline prevents all later file writes", async () => {
  const { fs, calls, closed } = fixture();
  await expect(
    fs.uploadFiles(
      [
        { source: Buffer.from("one"), destination: "one" },
        { source: Buffer.from("two"), destination: "two" },
      ],
      0.01,
    ),
  ).rejects.toBeInstanceOf(Error);
  expect(closed()).toBe(true);
  expect(calls).toHaveLength(1);
});

test("malformed upload deadlines fail before local reads, home setup or native operations", async () => {
  let homes = 0;
  let live = 0;
  const fs = new FileSystem({
    ensureHome: async () => {
      homes++;
    },
    live: async () => {
      live++;
      throw new Error("unexpected live request");
    },
  } as unknown as SandboxContext);
  for (const timeout of [-1, NaN, Infinity]) {
    await expect(fs.uploadFile("/missing-local-path", "data", timeout)).rejects.toThrow(
      "nonnegative finite",
    );
    await expect(
      fs.uploadFiles([{ source: "/missing-local-path", destination: "data" }], timeout),
    ).rejects.toThrow("nonnegative finite");
  }
  expect(homes).toBe(0);
  expect(live).toBe(0);
});

test("upload defaults use a deadline while explicit zero disables it for every batch member", async () => {
  const options: RequestOptions[] = [];
  const payloads: Uint8Array[] = [];
  const fs = new FileSystem({
    ensureHome: async () => {},
    live: async () => ({
      files: {
        write: async (_path: string, bytes: Uint8Array, request: RequestOptions) => {
          payloads.push(bytes);
          options.push(request);
        },
      },
    }),
  } as unknown as SandboxContext);
  await fs.uploadFile(Buffer.from([0, 255]), "default");
  await fs.uploadFiles(
    [
      { source: Buffer.from([1, 254]), destination: "one" },
      { source: Buffer.from([2, 253]), destination: "two" },
    ],
    0,
  );
  expect(options[0]!.timeoutMs).toBe(0);
  expect(options[0]!.signal).toBeInstanceOf(AbortSignal);
  expect(options[0]!.signal!.aborted).toBe(false);
  expect(options.slice(1)).toEqual([{ timeoutMs: 0 }, { timeoutMs: 0 }]);
  expect(options[1]).toBe(options[2]);
  expect(payloads.map((bytes) => [...bytes])).toEqual([
    [0, 255],
    [1, 254],
    [2, 253],
  ]);
});
