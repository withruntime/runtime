import { expect, test } from "bun:test";
import type { Runtime } from "../../src/client.js";
import type { BinaryOutputEvent } from "../../src/types.js";
import { SpritesClient } from "../../src/sprites/index.js";

const ID = "00000000-0000-0000-0000-000000000001";
function fixture(events: BinaryOutputEvent[] = []) {
  const calls: { method: string; options?: unknown }[] = [];
  const sandbox = {
    id: ID,
    state: "running",
    info: { labels: {}, createdAt: "2026-09-30T00:00:00Z", diskMiB: 4096 },
    files: {
      async readText() {
        return "{}";
      },
      async write() {
        calls.push({ method: "environment write" });
      },
    },
    async spawn() {
      calls.push({ method: "spawn" });
      return {
        id: "process",
        async kill(signal: string) {
          calls.push({ method: `kill ${signal}` });
        },
        async *outputBytes() {
          yield* events;
          yield { type: "exit", exitCode: 0, state: "exited", timedOut: false };
        },
      };
    },
  };
  const runtime = {
    sandboxes: {
      async get() {
        calls.push({ method: "get" });
        return sandbox;
      },
      async create(_input: unknown, options: unknown) {
        calls.push({ method: "create", options });
        return sandbox;
      },
    },
  } as unknown as Runtime;
  return { calls, client: new SpritesClient(undefined, { client: runtime }) };
}

test("Sprites waitForCapacity false forwards fail-fast while omitted/true preserve the native budget", async () => {
  for (const waitForCapacity of [undefined, false, true]) {
    const f = fixture();
    await f.client.createSprite("one", { waitForCapacity });
    expect(f.calls.find(({ method }) => method === "create")?.options).toEqual(
      waitForCapacity === false ? { waitForCapacityMs: 0 } : {},
    );
  }
});

test("Sprites invalid execution timeout refuses before any native calls", async () => {
  for (const timeout of [-1, NaN, Infinity, -Infinity]) {
    const f = fixture();
    await expect(f.client.sprite(ID).execFile("true", [], { timeout })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(f.calls).toEqual([]);
  }
});

test("Sprites maxBuffer bounds each output stream separately", async () => {
  const f = fixture([
    { type: "stdout", data: new TextEncoder().encode("four"), offset: 0 },
    { type: "stderr", data: new TextEncoder().encode("also"), offset: 4 },
  ]);
  expect(await f.client.sprite(ID).execFile("both", [], { maxBuffer: 5 })).toEqual({
    stdout: "four",
    stderr: "also",
    exitCode: 0,
  });
  expect(f.calls.some(({ method }) => method.startsWith("kill"))).toBe(false);
});

test("Sprites maxBuffer zero and timeout zero retain published defaults", async () => {
  const f = fixture([{ type: "stdout", data: new TextEncoder().encode("content"), offset: 0 }]);
  expect(await f.client.sprite(ID).execFile("zero", [], { maxBuffer: 0, timeout: 0 })).toEqual({
    stdout: "content",
    stderr: "",
    exitCode: 0,
  });
});

for (const channel of ["stdout", "stderr"] as const)
  test(`Sprites ${channel} overflow rejects with its stream name and signals once`, async () => {
    const f = fixture([{ type: channel, data: new TextEncoder().encode("overflow"), offset: 0 }]);
    await expect(f.client.sprite(ID).execFile("large", [], { maxBuffer: 5 })).rejects.toThrow(
      `${channel} maxBuffer exceeded`,
    );
    expect(f.calls.filter(({ method }) => method.startsWith("kill"))).toEqual([
      { method: "kill SIGTERM" },
    ]);
  });
