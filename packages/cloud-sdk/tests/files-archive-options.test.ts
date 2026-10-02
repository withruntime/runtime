import { expect, test } from "bun:test";
import { Files } from "../src/sandbox";
import { Transport, type Call } from "../src/transport";

test("byte archives preserve root/gzip options and repeated relative exclusions on the wire", async () => {
  const urls: URL[] = [];
  const bytes = new Uint8Array([0, 255, 128, 10]);
  const files = new Files(
    new Transport({
      baseUrl: "http://localhost",
      apiKey: "fixture",
      maxRetries: 0,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(new URL(new Request(input, init).url));
        return new Response(bytes);
      }) as unknown as typeof fetch,
    }),
    "sandbox",
  );
  expect(
    await files.archive("/workspace", {
      gzip: false,
      user: "root",
      exclude: [".openai-agents-staging", "cache"],
    }),
  ).toEqual(bytes);
  expect(urls[0]!.searchParams.get("user")).toBe("root");
  expect(urls[0]!.searchParams.get("gzip")).toBe("false");
  expect(urls[0]!.searchParams.getAll("exclude")).toEqual([".openai-agents-staging", "cache"]);
});

test("large byte extraction autodetects gzip and gives every mutation its own key", async () => {
  for (const gzip of [false, true]) {
    const calls: Call[] = [];
    const files = new Files(
      {
        json: async (call: Call) => {
          calls.push(call);
          return { uploadId: "upload", chunkBytes: 600000 };
        },
        bytes: async (call: Call) => {
          calls.push(call);
          return new Uint8Array();
        },
      } as unknown as Transport,
      "sandbox",
    );
    const data = new Uint8Array(1_100_000);
    if (gzip) {
      data[0] = 0x1f;
      data[1] = 0x8b;
    }
    await files.unarchive("/", data, { user: "root", idempotencyKey: "logical", timeoutMs: 5000 });
    expect(calls[0]!.body).toEqual({ path: "/", gzip, user: "root" });
    expect(calls.filter((call) => call.method === "PUT").map((call) => call.bytes!.length)).toEqual(
      [600000, 500000],
    );
    expect(new Set(calls.map((call) => call.idempotencyKey)).size).toBe(calls.length);
    expect(new Set(calls.map((call) => call.signal)).size).toBe(1);
  }
});

test("archive cancellation aborts its upload without reusing the expired caller signal", async () => {
  const abort = new AbortController();
  const calls: Call[] = [];
  const failure = new Error("cancelled upload");
  const files = new Files(
    {
      json: async (call: Call) => {
        calls.push(call);
        return { uploadId: "upload", chunkBytes: 600000 };
      },
      bytes: async (call: Call) => {
        calls.push(call);
        abort.abort();
        throw failure;
      },
    } as unknown as Transport,
    "sandbox",
  );
  await expect(
    files.unarchive("/workspace", new Uint8Array(1_100_000), { signal: abort.signal }),
  ).rejects.toBe(failure);
  expect(calls.at(-1)!.path).toEndWith(":abort");
  expect(calls.at(-1)!.signal).toBeUndefined();
});
