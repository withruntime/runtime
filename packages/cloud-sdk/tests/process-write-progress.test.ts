import { expect, test } from "bun:test";
import { Process } from "../src/sandbox";
import { Transport } from "../src/transport";
import type { ProcessInfo } from "../src/types";
import { onFakeClockFor } from "./fixtures/fake-clock";

/** `length` bytes, byte i being `at(i)`: a plain loop, where Uint8Array.from
 * with a callback took 15 times as long for megabytes. */
function bytesOf(length: number, at: (i: number) => number) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = at(i);
  return out;
}

async function partialPipe(input: Uint8Array, zeroFirst = false) {
  const accepted: Buffer[] = [];
  const payloads: number[] = [];
  let offset = 0;
  let wireBytes = 0;
  let closed = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const text = await request.text();
      wireBytes += Buffer.byteLength(text);
      const body = JSON.parse(text) as { offset: number; base64: string; eof?: boolean };
      expect(body.offset).toBe(offset);
      expect(closed).toBe(false);
      const bytes = Buffer.from(body.base64, "base64");
      payloads.push(bytes.length);
      const count = zeroFirst && payloads.length === 1 ? 0 : Math.min(65_536, bytes.length);
      accepted.push(Buffer.from(bytes.subarray(0, count)));
      offset += count;
      closed = body.eof === true && count === bytes.length;
      return Response.json({ offset });
    },
  });
  try {
    const transport = new Transport({
      baseUrl: server.url.origin,
      apiKey: "fixture-process-write",
      maxRetries: 0,
    });
    const process = new Process(transport, "sandbox", { id: "process" } as ProcessInfo);
    await process.write(input, { eof: true });
    expect(Buffer.concat(accepted)).toEqual(Buffer.from(input));
    expect(offset).toBe(input.length);
    expect(closed).toBe(true);
    return { payloads, wireBytes };
  } finally {
    await server.stop(true);
  }
}

// Two MiB, not eight: 32 calls show the payload shrinks as well as 128 did.
test("partial pipe acceptance adapts payload size instead of amplifying a two MiB upload", async () => {
  const input = bytesOf(2 * 1_048_576, (i) => i % 256);
  const { payloads, wireBytes } = await partialPipe(input);
  expect(payloads[0]).toBe(1_048_576);
  expect(payloads.slice(1).every((size) => size === 65_536)).toBe(true);
  expect(payloads).toHaveLength(32);
  expect(payloads.reduce((sum, size) => sum + size, 0)).toBe(3_080_192);
  // Base64 adds a third; the small JSON envelope must stay within this budget.
  expect(wireBytes).toBeLessThan(4_111_000);
});

// The pause after a write that took nothing, on the fake clock.
test("zero-progress backpressure retains every byte and resumes with a bounded payload", () =>
  onFakeClockFor(async () => {
    const input = bytesOf(2 * 1_048_576, (i) => (i * 19) % 256);
    const { payloads } = await partialPipe(input, true);
    expect(payloads[0]).toBe(1_048_576);
    expect(payloads.slice(1).every((size) => size === 65_536)).toBe(true);
    expect(payloads).toHaveLength(33);
    expect(payloads.reduce((sum, size) => sum + size, 0)).toBe(input.length + 1_048_576);
  }));
