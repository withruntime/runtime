import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { prepareFileSource } from "../src/file-source";
import { Files } from "../src/sandbox";
import type { Call, Transport } from "../src/transport";

const CHUNK = 1_048_576;
const staging = async () =>
  (await readdir(tmpdir())).filter((name) => name.startsWith("runtime-upload-"));
const unlimited = { check() {}, wait: <T>(pending: Promise<T>) => pending };
function piece(offset: number, size: number) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (offset + i) % 251;
  return bytes;
}
async function* stream(size: number) {
  for (let offset = 0; offset < size; offset += 65_536)
    yield piece(offset, Math.min(65_536, size - offset));
}
function sink(hold = false) {
  const calls: Call[] = [];
  const chunks = new Map<number, Uint8Array>();
  let accepted = 0;
  let live = 0;
  let peak = 0;
  let completedSource = false;
  let started = 0;
  const release: (() => void)[] = [];
  let declared: { size: number; sha256: string } | undefined;
  const files = new Files(
    {
      json: async (call: Call) => {
        calls.push({ ...call, bytes: undefined });
        if (call.path.endsWith("/uploads")) {
          expect(completedSource).toBe(true);
          declared = call.body as typeof declared;
          return { uploadId: "owned", chunkBytes: CHUNK };
        }
        if (call.method === "PUT") {
          const bytes = call.bytes!;
          live += bytes.length;
          peak = Math.max(peak, live);
          try {
            if (hold)
              await new Promise<void>((resolve) => {
                release.push(resolve);
                started++;
                if (started % 8 === 0 || started === Math.ceil(declared!.size / CHUNK)) {
                  const batch = release.splice(0);
                  queueMicrotask(() => batch.forEach((resume) => resume()));
                }
              });
            else chunks.set(Number(call.query?.offset), bytes.slice());
            accepted += bytes.length;
            return { received: accepted };
          } finally {
            live -= bytes.length;
          }
        }
        return {};
      },
      bytes: async (call: Call) => {
        calls.push({ ...call, bytes: undefined });
        chunks.set(0, call.bytes!.slice());
        return new Uint8Array();
      },
    } as unknown as Transport,
    "sandbox",
  );
  return {
    files,
    calls,
    chunks,
    get peak() {
      return peak;
    },
    get declared() {
      return declared;
    },
    complete() {
      completedSource = true;
    },
  };
}

test("stream uploads establish the binary digest before begin and commit exact bytes", async () => {
  const before = await staging();
  const size = CHUNK * 2 + 333;
  const fixture = sink();
  let directory: string | undefined;
  const input = {
    async *[Symbol.asyncIterator]() {
      const current = (await staging()).filter((name) => !before.includes(name));
      expect(current).toHaveLength(1);
      directory = join(tmpdir(), current[0]!);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "source"))).mode & 0o777).toBe(0o600);
      yield* stream(size);
      fixture.complete();
    },
  };
  const progress: number[] = [];
  await expect(
    fixture.files.writeStream("/workspace/binary", input, {
      mode: 0o700,
      onProgress: ({ bytesSent }) => progress.push(bytesSent),
    }),
  ).resolves.toEqual({ path: "/workspace/binary", size });
  const actual = new Uint8Array(size);
  for (const [offset, bytes] of fixture.chunks) actual.set(bytes, offset);
  expect(actual).toEqual(piece(0, size));
  expect(fixture.declared).toMatchObject({
    size,
    sha256: createHash("sha256").update(actual).digest("hex"),
  });
  expect(progress.at(-1)).toBe(size);
  expect(progress.every((n, i) => i === 0 || n > progress[i - 1]!)).toBe(true);
  expect(fixture.calls.some((call) => call.path.endsWith(":commit"))).toBe(true);
  expect(await stat(directory!).catch(() => undefined)).toBeUndefined();
});

test("unknown-length payload growth does not increase resident chunk bytes", async () => {
  for (const size of [CHUNK * 9, CHUNK * 33]) {
    const fixture = sink(true);
    const input = {
      async *[Symbol.asyncIterator]() {
        yield* stream(size);
        fixture.complete();
      },
    };
    await fixture.files.writeStream("/workspace/large", input);
    expect(fixture.peak).toBeLessThanOrEqual(CHUNK * 8);
    expect(fixture.peak).toBe(CHUNK * 8);
  }
});

test("known local files and Blobs avoid an extra staging copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-known-source-"));
  try {
    const path = join(directory, "binary");
    const bytes = piece(0, CHUNK + 7);
    await writeFile(path, bytes);
    for (const input of [path, new Blob([bytes])]) {
      const before = await staging();
      const source = await prepareFileSource(input, unlimited);
      try {
        expect(await staging()).toEqual(before);
        expect(source.size).toBe(bytes.length);
        expect(source.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
        expect(await source.chunkAt(CHUNK, 7)).toEqual(bytes.subarray(CHUNK));
      } finally {
        await source.close();
      }
    }
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source failure preserves its error even when iterator return throws synchronously", async () => {
  const before = await staging();
  const primary = new Error("source failure");
  let closed = false;
  const input: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          throw primary;
        },
        return() {
          closed = true;
          throw new Error("cleanup failure");
        },
      };
    },
  };
  await expect(prepareFileSource(input, unlimited)).rejects.toBe(primary);
  expect(closed).toBe(true);
  expect(await staging()).toEqual(before);
});

test("invalid source chunks clean staging and never begin a remote upload", async () => {
  const before = await staging();
  const fixture = sink();
  async function* invalid() {
    yield "text" as unknown as Uint8Array;
  }
  await expect(fixture.files.writeStream("/workspace/file", invalid())).rejects.toMatchObject({
    code: "invalid_upload_source",
  });
  expect(fixture.calls).toEqual([]);
  expect(await staging()).toEqual(before);
});

test("cancelled web and Node sources close before any remote upload begins", async () => {
  for (const node of [false, true]) {
    const before = await staging();
    const fixture = sink();
    const abort = new AbortController();
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let closed = false;
    const input = node
      ? new Readable({
          read() {
            reading();
          },
          destroy(_error, done) {
            closed = true;
            done();
          },
        })
      : new ReadableStream<Uint8Array>(
          {
            pull() {
              reading();
            },
            cancel() {
              closed = true;
            },
          },
          { highWaterMark: 0 },
        );
    const upload = fixture.files.writeStream("/workspace/file", input, { signal: abort.signal });
    await started;
    abort.abort(new Error("fixture cancellation"));
    await expect(upload).rejects.toMatchObject({ code: "timeout" });
    expect(closed).toBe(true);
    expect(fixture.calls).toEqual([]);
    expect(await staging()).toEqual(before);
  }
});

test("a progress callback failure aborts the owned upload and removes staging", async () => {
  const before = await staging();
  const fixture = sink(true);
  const primary = new Error("progress observer failed");
  const input = {
    async *[Symbol.asyncIterator]() {
      yield* stream(CHUNK * 2);
      fixture.complete();
    },
  };
  await expect(
    fixture.files.writeStream("/workspace/file", input, {
      onProgress() {
        throw primary;
      },
    }),
  ).rejects.toBe(primary);
  expect(fixture.calls.at(-1)?.path).toEndWith(":abort");
  expect(fixture.calls.some((call) => call.path.endsWith(":commit"))).toBe(false);
  expect(await staging()).toEqual(before);
});
