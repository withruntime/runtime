import { beforeEach, describe, expect, test } from "bun:test";
import { RuntimeError } from "../../src/errors";
import { Daytona, type Sandbox } from "../../src/daytona/index";
import { DropInWorld } from "../drop-in-fake";
import type { FakeSandbox } from "../e2b/fake";

/* What @daytona/sdk 0.223.1 changed in the calls withruntime/daytona
   implements, read from its published package on 9 October 2026 (DAYTONA.md):
   sandbox.setPublic(isPublic) makes the sandbox's preview URLs public or
   private, those already shared included. The rest of the release is
   documentation. */

let world: DropInWorld;
let daytona: Daytona;

beforeEach(() => {
  world = new DropInWorld();
  daytona = new Daytona({ withruntime: { client: world.client() } });
});

/** The ports Runtime already shares for `sandbox`, as previews.list answers. */
function shared(sandbox: Sandbox, ports: Array<{ port: number; visibility: string }>) {
  const runtime = world.sandboxes.get(sandbox.id)! as FakeSandbox & { previews: object };
  const previews = runtime.previews as Record<string, unknown>;
  Object.defineProperty(runtime, "previews", {
    configurable: true,
    value: {
      ...previews,
      list: async () => {
        world.record("previews.list");
        return ports;
      },
    },
  });
  return runtime;
}

describe("@daytona/sdk 0.223.1 setPublic", () => {
  test("setPublic(true) makes shared ports public and later links public", async () => {
    const sandbox = await daytona.create();
    shared(sandbox, [
      { port: 3000, visibility: "private" },
      { port: 8080, visibility: "public" },
    ]);
    expect(sandbox.public).toBe(false);
    await sandbox.setPublic(true);
    // Only the port that was private changes; the public one is left alone.
    expect(world.called("previews.create")).toEqual([[3000, { visibility: "public" }]]);
    expect(sandbox.public).toBe(true);
    await sandbox.getPreviewLink(5000);
    expect(world.called("previews.create").at(-1)).toEqual([5000, { visibility: "public" }]);
  });

  test("setPublic(false) makes shared ports private again", async () => {
    const sandbox = await daytona.create({ public: true });
    shared(sandbox, [
      { port: 3000, visibility: "public" },
      { port: 4000, visibility: "public" },
    ]);
    await sandbox.setPublic(false);
    expect(world.called("previews.create")).toEqual([
      [3000, { visibility: "private" }],
      [4000, { visibility: "private" }],
    ]);
    expect(sandbox.public).toBe(false);
    await sandbox.getPreviewLink(3000);
    expect(world.called("previews.create").at(-1)).toEqual([3000, { visibility: "private" }]);
  });

  test("a refused public share leaves the sandbox private", async () => {
    const sandbox = await daytona.create();
    shared(sandbox, [{ port: 3000, visibility: "private" }]).refusePublic = true;
    const error = await sandbox.setPublic(true).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(RuntimeError);
    expect((error as { cause: RuntimeError }).cause.code).toBe("public_preview_not_allowed");
    expect(sandbox.public).toBe(false);
  });
});
