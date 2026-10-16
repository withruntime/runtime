import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Transport, timeoutSignal } from "../src/transport";

/* Node's AbortSignal.timeout throws ERR_OUT_OF_RANGE on a fraction, where
   Bun's accepts one, so a customer on Node passing timeoutMs: 1500.5 got a
   RangeError instead of a request. The live promise probe broke this way on
   9 October 2026 (d3cd4bfbd). */

/** Bun's AbortSignal.timeout made to refuse a fraction, as Node's does. */
async function onNode(work: () => Promise<void>) {
  const bunTimeout = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = (delay: number) => {
    if (!Number.isInteger(delay)) throw new RangeError(`delay ${delay} is not an integer`);
    return bunTimeout(delay);
  };
  try {
    await work();
  } finally {
    AbortSignal.timeout = bunTimeout;
  }
}

test("a fractional timeout is a request on Node, with its deadline rounded up to whole milliseconds", async () => {
  await onNode(async () => {
    const t = new Transport({
      apiKey: "rk_test",
      fetch: (async () => Response.json({ ok: true })) as unknown as typeof fetch,
    });
    expect(
      await t.json<{ ok: boolean }>({
        method: "GET",
        path: "/v1/me",
        timeoutMs: 1500.5,
        waitForCapacityMs: 0.25,
      }),
    ).toEqual({ ok: true });
    expect(timeoutSignal(0.2).aborted).toBe(false);
  });
});

test("every deadline the SDK makes from a value goes through timeoutSignal", () => {
  // A literal (10_000) or an explicit Math.ceil is whole already.
  const whole = /AbortSignal\.timeout\(([0-9][0-9_]*\)|Math\.)/;
  const src = join(import.meta.dir, "..", "src");
  const raw: string[] = [];
  for (const file of readdirSync(src, { recursive: true }) as string[]) {
    if (!file.endsWith(".ts")) continue;
    readFileSync(join(src, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("AbortSignal.timeout(") && !whole.test(line))
          raw.push(`${file}:${i + 1}`);
      });
  }
  expect(raw).toEqual([]);
});
