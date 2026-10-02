import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { FileSystem, type UploadProgress, type UploadStreamOptions } from "../../src/daytona/index";
import type { SandboxContext } from "../../src/daytona/context";
import { Files } from "../../src/sandbox";
import { Transport } from "../../src/transport";

function fixture() {
  const calls: Request[] = [];
  const chunks = new Map<number, Uint8Array>();
  let received = 0;
  let declaration: { size: number; sha256: string } | undefined;
  let committed: Uint8Array | undefined;
  const transport = new Transport({
    apiKey: "rtcloud_fixture",
    baseUrl: "https://fixture.invalid",
    maxRetries: 0,
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      calls.push(req);
      const url = new URL(req.url);
      if (url.pathname.endsWith("/files/content")) {
        committed = new Uint8Array(await req.arrayBuffer());
        return new Response();
      }
      if (url.pathname.endsWith("/uploads")) {
        declaration = (await req.json()) as typeof declaration;
        return Response.json({ uploadId: "stream", chunkBytes: 1_048_576 });
      }
      if (url.pathname.endsWith("/uploads/stream") && req.method === "PUT") {
        const bytes = new Uint8Array(await req.arrayBuffer());
        chunks.set(Number(url.searchParams.get("offset")), bytes);
        received += bytes.length;
        return Response.json({ received });
      }
      if (url.pathname.endsWith(":commit")) {
        const bytes = Buffer.concat(
          [...chunks].sort(([a], [b]) => a - b).map(([, value]) => value),
        );
        expect(bytes.length).toBe(declaration!.size);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(declaration!.sha256);
        committed = bytes;
        return Response.json({});
      }
      if (url.pathname.endsWith(":abort")) return Response.json({});
      throw new Error(`Unexpected upload route ${url.pathname}`);
    }) as typeof fetch,
  });
  const fs = new FileSystem({
    ensureHome: async () => {},
    live: async () => ({ files: new Files(transport, "sandbox") }),
  } as unknown as SandboxContext);
  return { fs, calls, committed: () => committed };
}

test("Daytona streaming accepts byte buffers, local files, Node and Web sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "daytona-stream-input-"));
  const localPath = join(directory, "binary");
  const bytes = Buffer.from([0, 255, 10, 128]);
  await writeFile(localPath, bytes);
  const options: UploadStreamOptions = { timeout: 0 };
  try {
    const sources = [
      bytes,
      Uint8Array.from(bytes),
      localPath,
      Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    ];
    for (const source of sources) {
      const f = fixture();
      await f.fs.uploadFileStream(source, "binary", options);
      expect([...f.committed()!]).toEqual([...bytes]);
    }
    expect(await readFile(localPath)).toEqual(bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("encoded Node streams keep their UTF-8 data", async () => {
  const f = fixture();
  await f.fs.uploadFileStream(Readable.from(["hé", "llo"]), "text", { timeout: 0 });
  expect(new TextDecoder().decode(f.committed())).toBe("héllo");
});

test("ordinary upload paths delegate unchanged while byte inputs retain the direct no-copy path", async () => {
  const calls: { method: string; source: unknown }[] = [];
  const fs = new FileSystem({
    ensureHome: async () => {},
    live: async () => ({
      files: {
        write: async (_path: string, source: Uint8Array) => {
          calls.push({ method: "write", source });
        },
        writeStream: async (_path: string, source: string) => {
          calls.push({ method: "writeStream", source });
        },
      },
    }),
  } as unknown as SandboxContext);
  const bytes = Buffer.from([0, 255]);
  // The adapter must not try reading this path before delegating it.
  const local = "/a-local-path-not-opened-by-the-adapter";
  await fs.uploadFile(local, "local", 0);
  await fs.uploadFile(bytes, "buffer", 0);
  await fs.uploadFiles([{ source: local, destination: "batch" }], 0);
  expect(calls).toEqual([
    { method: "writeStream", source: local },
    { method: "write", source: bytes },
    { method: "writeStream", source: local },
  ]);
  expect(calls[1]!.source).toBe(bytes);
});

test("large streamed uploads retain digest and cumulative progress without adapter buffering", async () => {
  const f = fixture();
  const part = new Uint8Array(65_536).fill(172);
  const source = Readable.from(
    (async function* () {
      for (let index = 0; index < 20; index++) yield part;
    })(),
  );
  const progress: UploadProgress[] = [];
  await f.fs.uploadFileStream(source, "large", {
    timeout: 0,
    onProgress: (value) => progress.push(value),
  });
  expect(f.committed()!.length).toBe(20 * part.length);
  expect(f.committed()!.every((byte) => byte === 172)).toBe(true);
  expect(progress.length).toBeGreaterThan(0);
  expect(progress.at(-1)).toEqual({ bytesSent: 20 * part.length });
  for (let index = 1; index < progress.length; index++)
    expect(progress[index]!.bytesSent).toBeGreaterThan(progress[index - 1]!.bytesSent);
});

test("pre-aborted streaming upload does not consume the input or enter native operations", async () => {
  let reads = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      pull() {
        reads++;
      },
    },
    { highWaterMark: 0 },
  );
  const f = fixture();
  await expect(
    f.fs.uploadFileStream(source, "cancelled", { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ name: "DaytonaError", message: "Upload cancelled: cancelled" });
  expect(reads).toBe(0);
  expect(source.locked).toBe(false);
  expect(f.calls).toEqual([]);
  await source.cancel();
});

test("the upload deadline bounds stalled home and live setup without permitting late uploads", async () => {
  for (const blocked of ["home", "live"] as const) {
    let release!: () => void;
    let writes = 0;
    let consumed = false;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fs = new FileSystem({
      ensureHome: async () => {
        if (blocked === "home") await stalled;
      },
      live: async () => {
        if (blocked === "live") await stalled;
        return {
          files: {
            writeStream: async () => {
              consumed = true;
              writes++;
            },
          },
        };
      },
    } as unknown as SandboxContext);
    await expect(
      fs.uploadFileStream("/not-read-before-setup", "target", { timeout: 0.01 }),
    ).rejects.toBeInstanceOf(Error);
    expect(consumed).toBe(false);
    expect(writes).toBe(0);
    release();
    // A previously started setup may finish after cancellation. Its waiter
    // must remain rejected and never resume the transfer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consumed).toBe(false);
    expect(writes).toBe(0);
  }
});

test("stream deadline cancels a stalled Web source before any remote upload begins", async () => {
  let closed = false;
  const source = new ReadableStream<Uint8Array>({
    pull: () => new Promise(() => {}),
    cancel: () => {
      closed = true;
    },
  });
  const f = fixture();
  await expect(f.fs.uploadFileStream(source, "stalled", { timeout: 0.01 })).rejects.toBeInstanceOf(
    Error,
  );
  expect(closed).toBe(true);
  expect(source.locked).toBe(false);
  expect(f.calls).toEqual([]);
});

test("caller cancellation destroys a stalled Node source and returns Daytona's cancellation error", async () => {
  const source = new Readable({ read() {} });
  const f = fixture();
  const controller = new AbortController();
  const upload = f.fs.uploadFileStream(source, "stalled", {
    timeout: 0,
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await expect(upload).rejects.toMatchObject({
      name: "DaytonaError",
      message: "Upload cancelled: stalled",
    });
    expect(source.destroyed).toBe(true);
    expect(f.calls).toEqual([]);
  } finally {
    clearTimeout(timer);
    source.destroy();
  }
});

test("a progress callback failure prevents commit and aborts the atomic transfer", async () => {
  const f = fixture();
  const failure = new Error("stop progress");
  await expect(
    f.fs.uploadFileStream(Readable.from([new Uint8Array(1_048_577)]), "large", {
      timeout: 0,
      onProgress: () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  expect(f.committed()).toBeUndefined();
  expect(f.calls.some((req) => new URL(req.url).pathname.endsWith(":commit"))).toBe(false);
  expect(f.calls.some((req) => new URL(req.url).pathname.endsWith(":abort"))).toBe(true);
});
