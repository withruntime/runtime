import { expect, test } from "bun:test";
import type { Runtime } from "../../src/client.js";
import type { Sandbox } from "../../src/sandbox.js";
import { RuntimeError } from "../../src/errors.js";
import {
  CompatibilityError,
  FilesystemError,
  SpriteFilesystem,
  SpritesClient,
} from "../../src/sprites/index.js";

const ID = "00000000-0000-0000-0000-000000000001";
function fixture() {
  const calls: string[] = [];
  const sandbox = {
    id: ID,
    state: "running",
    info: { labels: {}, diskMiB: 4096, createdAt: "2026-09-30T00:00:00Z" },
    async update() {
      calls.push("update");
    },
  } as unknown as Sandbox;
  const runtime = {
    sandboxes: {
      async get() {
        calls.push("get");
        return sandbox;
      },
      async create() {
        calls.push("create");
        throw new Error("Allocation must not happen");
      },
    },
  } as unknown as Runtime;
  return { calls, client: new SpritesClient(undefined, { client: runtime }) };
}

test("Sprites unsupported URL settings fail before creation or label mutation", async () => {
  for (const urlSettings of [
    { auth: "public", privateAccess: "restricted" },
    { auth: "public", unknown: true },
  ]) {
    const { client, calls } = fixture();
    await expect(client.createSprite("one", { urlSettings })).rejects.toBeInstanceOf(
      CompatibilityError,
    );
    await expect(
      client.sprite(ID).update({ labels: ["changed"], urlSettings }),
    ).rejects.toBeInstanceOf(CompatibilityError);
    expect(calls).toEqual([]);
  }
});

test("Sprites invalid URL auth fails before creation or label mutation", async () => {
  for (const auth of ["", "invalid", undefined]) {
    const { client, calls } = fixture();
    await expect(client.createSprite("one", { urlSettings: { auth } })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      client.sprite(ID).update({ labels: ["changed"], urlSettings: { auth } }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  }
});

test("Sprites empty updates and malformed labels fail before looking up a guest", async () => {
  const { client, calls } = fixture();
  await expect(client.sprite(ID).update({})).rejects.toThrow("urlSettings or labels is required");
  for (const labels of ["not-an-array", [1], null, new Array<string>(1)]) {
    await expect(
      client.createSprite("one", { labels: labels as unknown as string[] }),
    ).rejects.toThrow("labels must be an array of strings");
    await expect(
      client.sprite(ID).update({ labels: labels as unknown as string[] }),
    ).rejects.toThrow("labels must be an array of strings");
  }
  expect(calls).toEqual([]);
});

test.each([undefined, false, true])(
  "Sprites createSession forces the pinned terminal default (tty=%s)",
  async (tty) => {
    const spawned: unknown[] = [];
    const sandbox = {
      id: ID,
      state: "running",
      info: { labels: {}, diskMiB: 4096, createdAt: "2026-09-30T00:00:00Z" },
      files: {
        async readText() {
          return "{}";
        },
      },
      async spawn(_command: string[], options: unknown) {
        spawned.push(options);
        return {
          id: "session",
          async *outputBytes() {
            yield { type: "exit", exitCode: 0 };
          },
        };
      },
    } as unknown as Sandbox;
    const runtime = {
      sandboxes: {
        async get() {
          return sandbox;
        },
      },
    } as unknown as Runtime;
    const client = new SpritesClient(undefined, { client: runtime });
    // @fly/sprites 0.2.3 createSession spreads caller options BEFORE tty:true.
    await client.sprite(ID).createSession("sh", [], { tty, rows: 40, cols: 100 }).wait();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ pty: { rows: 40, cols: 100 } });
  },
);

test.each([false, true])(
  "Sprites readdir maps native refusals to its published filesystem error (recursive=%s)",
  async (recursive) => {
    let calls = 0;
    const sandbox = {
      files: {
        async list() {
          if (recursive && calls++ === 0)
            return [{ name: "nested", path: "/missing/nested", type: "directory" }];
          throw new RuntimeError({
            code: "file_not_found",
            status: 404,
            message: "Missing directory",
          });
        },
      },
    } as unknown as Sandbox;
    const filesystem = new SpriteFilesystem(async () => sandbox, "/");
    try {
      await filesystem.readdir("/missing", { recursive });
      throw new Error("Missing directory unexpectedly listed");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesystemError);
      expect(error).toMatchObject({ code: "ENOENT", path: "/missing", syscall: "readdir" });
    }
  },
);
