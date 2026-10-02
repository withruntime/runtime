/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- fakes reject with the abort signal's reason, exactly as fetch does. */
import { expect, test } from "bun:test";
import { Files } from "../src/sandbox";
import { Transport, type Call } from "../src/transport";

const CHUNK = 1_048_576;
function fixture(chunkBytes: unknown = CHUNK, failure?: Error) {
  const calls: Call[] = [];
  const files = new Files(
    {
      json: async (call: Call) => {
        calls.push(call);
        if (call.path.endsWith("/uploads")) return { uploadId: "owned", chunkBytes };
        if (call.method === "PUT") {
          if (failure) throw failure;
          return { received: CHUNK + 1 };
        }
        return {};
      },
      bytes: async (call: Call) => {
        calls.push(call);
        return new Uint8Array();
      },
    } as unknown as Transport,
    "sandbox",
  );
  return { files, calls };
}

test("a cancelled file write refuses before beginning any transfer", async () => {
  const { files, calls } = fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(
    files.write("/workspace/file", new Uint8Array(CHUNK + 1), { signal: abort.signal }),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(calls).toEqual([]);
});

test("invalid negotiated chunks abort the owned transfer without chunk requests", async () => {
  for (const chunkBytes of [0, -1, 1.5, NaN, Infinity, CHUNK + 1]) {
    const { files, calls } = fixture(chunkBytes);
    await expect(files.write("/workspace/file", new Uint8Array(CHUNK + 1))).rejects.toMatchObject({
      code: "connection_error",
    });
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
    expect(calls.at(-1)?.path).toEndWith(":abort");
    expect(calls.at(-1)?.timeoutMs).toBe(5000);
    expect(calls.at(-1)?.signal).toBeUndefined();
  }
});

test("file chunks share the caller deadline and preserve unlimited zero", async () => {
  for (const timeoutMs of [0, 1000]) {
    const { files, calls } = fixture();
    const abort = new AbortController();
    await files.write("/workspace/file", new Uint8Array(CHUNK + 1), {
      timeoutMs,
      signal: abort.signal,
    });
    const chunks = calls.filter((call) => call.method === "PUT");
    expect(chunks).toHaveLength(2);
    expect(chunks.map((call) => call.timeoutMs)).toEqual([0, 0]);
    expect(chunks.every((call) => call.signal !== undefined)).toBe(true);
    expect(chunks[0]?.signal).toBe(chunks[1]?.signal);
    expect(chunks.map((call) => call.query?.offset)).toEqual([0, CHUNK]);
    expect(chunks.map((call) => call.bytes?.length)).toEqual([CHUNK, 1]);
  }
});

test("a rejected chunk drains siblings before independent cleanup, preserving the first error", async () => {
  const calls: Call[] = [];
  const primary = new Error("first chunk failed");
  const cleanup = new Error("cleanup failed");
  let pending = 0;
  const files = new Files(
    {
      json: async (call: Call) => {
        calls.push(call);
        if (call.path.endsWith("/uploads")) return { uploadId: "owned", chunkBytes: CHUNK };
        if (call.path.endsWith(":abort")) {
          expect(pending).toBe(0);
          throw cleanup;
        }
        if (call.method === "PUT") {
          if (call.query?.offset === 0) throw primary;
          pending++;
          try {
            await new Promise<void>((_resolve, reject) => {
              const cancelled = () => reject(call.signal?.reason);
              if (call.signal?.aborted) cancelled();
              else call.signal?.addEventListener("abort", cancelled, { once: true });
            });
          } finally {
            pending--;
          }
        }
        return {};
      },
    } as unknown as Transport,
    "sandbox",
  );
  await expect(files.write("/workspace/file", new Uint8Array(CHUNK * 3))).rejects.toBe(primary);
  expect(primary.cause).toBe(cleanup);
  expect(calls.at(-1)?.signal).toBeUndefined();
});

test("invalid cumulative progress cannot commit a file", async () => {
  for (const received of [0, -1, NaN, CHUNK + 2]) {
    const calls: Call[] = [];
    const files = new Files(
      {
        json: async (call: Call) => {
          calls.push(call);
          if (call.path.endsWith("/uploads")) return { uploadId: "owned", chunkBytes: CHUNK };
          if (call.method === "PUT") return { received };
          return {};
        },
      } as unknown as Transport,
      "sandbox",
    );
    await expect(files.write("/workspace/file", new Uint8Array(CHUNK + 1))).rejects.toMatchObject({
      code: "connection_error",
    });
    expect(calls.some((call) => call.path.endsWith(":commit"))).toBe(false);
    expect(calls.at(-1)?.path).toEndWith(":abort");
  }
});

test("the explicit file deadline includes begin and chunk requests together", async () => {
  const calls: string[] = [];
  const files = new Files(
    new Transport({
      apiKey: "fixture",
      baseUrl: "http://localhost",
      maxRetries: 0,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        calls.push(path);
        if (path.endsWith(":abort")) return Response.json({});
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, path.endsWith("/uploads") ? 25 : 70);
          const abort = () => {
            clearTimeout(timer);
            reject(request.signal.reason);
          };
          if (request.signal.aborted) abort();
          else request.signal.addEventListener("abort", abort, { once: true });
        });
        return Response.json(
          path.endsWith("/uploads")
            ? { uploadId: "owned", chunkBytes: CHUNK }
            : { received: CHUNK + 1 },
        );
      }) as unknown as typeof fetch,
    }),
    "sandbox",
  );
  await expect(
    files.write("/workspace/file", new Uint8Array(CHUNK + 1), { timeoutMs: 80 }),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(calls.some((path) => path.endsWith(":commit"))).toBe(false);
  expect(calls.at(-1)).toEndWith(":abort");
});

// No arbitrary upload identifier may be used as a cleanup target.
test("a malformed upload identity refuses without aborting an unowned transfer", async () => {
  const calls: Call[] = [];
  const files = new Files(
    {
      json: async (call: Call) => {
        calls.push(call);
        return { chunkBytes: CHUNK };
      },
    } as unknown as Transport,
    "sandbox",
  );
  await expect(files.write("/workspace/file", new Uint8Array(CHUNK + 1))).rejects.toMatchObject({
    code: "connection_error",
  });
  expect(calls).toHaveLength(1);
});
