import { expect, test } from "bun:test";
import { Process } from "../src/sandbox";
import type { ProcessInfo } from "../src/types";
import type { Transport } from "../src/transport";

function pipe(partial = false) {
  const bytes: Buffer[] = [];
  const calls: Array<{ offset: number; base64: string; eof?: boolean }> = [];
  let offset = 0;
  let closed = false;
  const process = new Process(
    {
      json: async ({ body }: { body: (typeof calls)[number] }) => {
        await Promise.resolve();
        expect(closed).toBe(false);
        expect(body.offset).toBe(offset);
        const incoming = Buffer.from(body.base64, "base64");
        expect(incoming.length).toBeLessThanOrEqual(1_048_576);
        calls.push(body);
        // A quarter of a chunk: still partial, without re-encoding a full
        // megabyte thirty-eight times on a loaded machine.
        const accepted = incoming.subarray(0, partial ? 262_144 : incoming.length);
        bytes.push(accepted);
        offset += accepted.length;
        closed = body.eof === true && accepted.length === incoming.length;
        return { offset };
      },
    } as unknown as Transport,
    "sandbox",
    { id: "process" } as ProcessInfo,
  );
  return { process, bytes, calls, closed: () => closed };
}
test("large stdin is chunked; partial acceptance retains bytes and EOF waits for the last chunk", async () => {
  const f = pipe(true);
  const input = Buffer.alloc(2_500_000, 255);
  await f.process.write(input, { eof: true });
  expect(Buffer.concat(f.bytes)).toEqual(input);
  expect(f.calls[0]!.eof).toBeUndefined();
  expect(f.closed()).toBe(true);
});
test("overlapping callers serialize their offsets and snapshot input buffers", async () => {
  const f = pipe();
  const bytes = Buffer.from("second");
  const first = f.process.write("first");
  const second = f.process.write(bytes);
  bytes.fill(0);
  await Promise.all([first, second, f.process.write("", { eof: true })]);
  expect(Buffer.concat(f.bytes).toString()).toBe("firstsecond");
  expect(f.closed()).toBe(true);
});
test("malformed input acknowledgments fail instead of skipping data or looping", async () => {
  for (const offset of [-1, 100, NaN, 0.5]) {
    const process = new Process({ json: async () => ({ offset }) } as unknown as Transport, "s", {
      id: "p",
    } as ProcessInfo);
    await expect(process.write("x")).rejects.toThrow("invalid input offset");
  }
});
