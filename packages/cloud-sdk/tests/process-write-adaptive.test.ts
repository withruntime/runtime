import { expect, test } from "bun:test";
import { RuntimeError } from "../src/errors";
import { Process } from "../src/sandbox";
import type { Transport } from "../src/transport";
import type { ProcessInfo } from "../src/types";

const MAX_CHUNK = 1_048_576;
type Input = { offset: number; base64: string; eof?: boolean };

function reader(capacity: (call: number) => number, initialOffset = 0) {
  const calls: Array<Input & { size: number }> = [];
  const received: Buffer[] = [];
  let offset = initialOffset;
  let closed = false;
  const process = new Process(
    {
      json: async ({ body }: { body: Input }) => {
        // Yield so concurrent callers exercise the actual write queue.
        await Promise.resolve();
        if (calls.length > 1000) throw new Error("Input did not make progress.");
        expect(closed).toBe(false);
        expect(body.offset).toBe(offset);
        const bytes = Buffer.from(body.base64, "base64");
        calls.push({ ...body, size: bytes.length });
        const accepted = bytes.subarray(0, capacity(calls.length));
        received.push(accepted);
        offset += accepted.length;
        closed = body.eof === true && accepted.length === bytes.length;
        return { offset };
      },
    } as unknown as Transport,
    "sandbox",
    { id: "process", stdinOffset: initialOffset } as ProcessInfo,
  );
  return { process, calls, received, closed: () => closed };
}

test("partial stdin acceptance shrinks later requests without losing bytes or adding calls", async () => {
  const capacity = 65_536;
  const f = reader(() => capacity);
  const input = Uint8Array.from({ length: 2_500_000 }, (_, index) => index % 256);
  await f.process.write(input, { eof: true });
  expect(Buffer.concat(f.received)).toEqual(Buffer.from(input));
  expect(f.calls).toHaveLength(Math.ceil(input.length / capacity));
  expect(f.calls[0]!.size).toBe(MAX_CHUNK);
  expect(f.calls.slice(1).every((call) => call.size <= capacity)).toBe(true);
  expect(f.calls.reduce((sum, call) => sum + call.size, 0)).toBe(
    MAX_CHUNK + input.length - capacity,
  );
  expect(f.calls.slice(0, -1).every((call) => call.eof === undefined)).toBe(true);
  expect(f.closed()).toBe(true);
});

test("a healthy stdin reader keeps the full-size fast path", async () => {
  const f = reader(() => MAX_CHUNK, 73);
  const input = Buffer.alloc(2_500_000, 0xff);
  await f.process.write(input, { eof: true });
  expect(f.calls.map((call) => call.size)).toEqual([MAX_CHUNK, MAX_CHUNK, 402_848]);
  expect(f.calls.reduce((sum, call) => sum + call.size, 0)).toBe(input.length);
  expect(Buffer.concat(f.received)).toEqual(input);
  expect(f.closed()).toBe(true);
});

test("smaller partial writes and a temporary zero acknowledgment preserve input offsets", async () => {
  const f = reader((call) => (call === 1 ? 65_536 : call === 3 ? 0 : 4096), 19);
  const input = Buffer.alloc(100_000, 0x80);
  await f.process.write(input, { eof: true });
  expect(f.calls[1]!.size).toBe(34_464);
  expect(f.calls.slice(2).every((call) => call.size <= 4096)).toBe(true);
  expect(f.calls[3]!.offset).toBe(f.calls[2]!.offset);
  expect(Buffer.concat(f.received)).toEqual(input);
  expect(f.closed()).toBe(true);
});

test("later queued writes start at full capacity and snapshot caller buffers", async () => {
  const f = reader((call) => (call === 1 ? 65_536 : MAX_CHUNK));
  const first = Buffer.alloc(MAX_CHUNK + 7, 0xfe);
  const second = Buffer.alloc(MAX_CHUNK + 9, 0xfd);
  const expectedSecond = Buffer.from(second);
  const one = f.process.write(first);
  const two = f.process.write(second, { eof: true });
  second.fill(0);
  await Promise.all([one, two]);
  const secondStart = f.calls.find((call) => call.offset === first.length)!;
  expect(secondStart.size).toBe(MAX_CHUNK);
  expect(Buffer.concat(f.received)).toEqual(Buffer.concat([first, expectedSecond]));
  expect(f.closed()).toBe(true);
});

test("partial UTF-8 acceptance retains the original multibyte characters", async () => {
  const f = reader(() => 1);
  const input = "é🙂漢字";
  await f.process.write(input, { eof: true });
  expect(f.calls.slice(1).every((call) => call.size === 1)).toBe(true);
  expect(Buffer.concat(f.received)).toEqual(Buffer.from(input));
  expect(f.closed()).toBe(true);
});

test("a reconnected process can close input with an empty EOF write", async () => {
  const f = reader(() => 0, 321);
  await f.process.write("", { eof: true });
  expect(f.calls).toEqual([{ offset: 321, base64: "", eof: true, size: 0 }]);
  expect(f.closed()).toBe(true);
});

test("zero-byte acceptance yields before retrying and retains the final input and EOF", async () => {
  const pauses: number[] = [];
  const schedule = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    pauses.push(delay ?? 0);
    return schedule(callback, 0);
  }) as typeof globalThis.setTimeout;
  const f = reader((call) => (call <= 2 ? 0 : MAX_CHUNK));
  try {
    await f.process.write("input", { eof: true });
  } finally {
    globalThis.setTimeout = schedule;
  }
  expect(pauses).toHaveLength(2);
  expect(pauses.every((delay) => delay > 0)).toBe(true);
  expect(f.calls.map((call) => [call.offset, call.eof])).toEqual([
    [0, true],
    [0, true],
    [0, true],
  ]);
  expect(Buffer.concat(f.received).toString()).toBe("input");
  expect(f.closed()).toBe(true);
});

test("invalid acknowledgments reject and leave the next queued write's offset intact", async () => {
  for (const invalid of [-1, NaN, Infinity, 12.5, 100]) {
    let calls = 0;
    const process = new Process(
      {
        json: async ({ body }: { body: Input }) => {
          expect(body.offset).toBe(12);
          if (++calls === 1) return { offset: invalid };
          return { offset: body.offset + Buffer.from(body.base64, "base64").length };
        },
      } as unknown as Transport,
      "sandbox",
      { id: "process", stdinOffset: 12 } as ProcessInfo,
    );
    const invalidWrite = process.write("x");
    const nextWrite = process.write("é", { eof: true });
    await expect(invalidWrite).rejects.toThrow("invalid input offset");
    await nextWrite;
    expect(calls).toBe(2);
  }
});

test("closed stdin fails once per logical write without retrying or stranding its queue", async () => {
  let calls = 0;
  const process = new Process(
    {
      json: async () => {
        calls++;
        throw new RuntimeError({ code: "stdin_closed", message: "Input is closed.", status: 409 });
      },
    } as unknown as Transport,
    "sandbox",
    { id: "process" } as ProcessInfo,
  );
  await expect(process.write("first")).rejects.toMatchObject({ code: "stdin_closed" });
  await expect(process.write("second")).rejects.toMatchObject({ code: "stdin_closed" });
  expect(calls).toBe(2);
});
