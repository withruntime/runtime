import { expect, test } from "bun:test";
import { Process } from "../src/sandbox";
import { Transport } from "../src/transport";
import type { ProcessInfo } from "../src/types";

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

test("partial pipe acceptance adapts payload size instead of amplifying an eight MiB upload", async () => {
  const input = Uint8Array.from({ length: 8 * 1_048_576 }, (_, i) => i % 256);
  const { payloads, wireBytes } = await partialPipe(input);
  expect(payloads[0]).toBe(1_048_576);
  expect(payloads.slice(1).every((size) => size === 65_536)).toBe(true);
  expect(payloads).toHaveLength(128);
  expect(payloads.reduce((sum, size) => sum + size, 0)).toBe(9_371_648);
  // Base64 adds a third; the small JSON envelope must stay within this budget.
  expect(wireBytes).toBeLessThan(12_510_000);
});

test("zero-progress backpressure retains every byte and resumes with a bounded payload", async () => {
  const input = Uint8Array.from({ length: 2 * 1_048_576 }, (_, i) => (i * 19) % 256);
  const { payloads } = await partialPipe(input, true);
  expect(payloads[0]).toBe(1_048_576);
  expect(payloads.slice(1).every((size) => size === 65_536)).toBe(true);
  expect(payloads).toHaveLength(33);
  expect(payloads.reduce((sum, size) => sum + size, 0)).toBe(input.length + 1_048_576);
});
