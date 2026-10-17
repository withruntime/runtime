import { beforeEach, describe, expect, test } from "bun:test";
import { Daytona, NotSupportedError } from "../../src/daytona/index";
import { DropInWorld } from "../drop-in-fake";

/* What @daytona/sdk 0.224.1 changed in the calls withruntime/daytona
   implements, read from its published package on 15 October 2026
   (DAYTONA.md): create takes its own target (region), over the client's.
   Runtime runs in one US region, so "us" (or none) creates the sandbox and
   any other region is refused before anything is made, as the client's
   target already was. The rest of the release is documentation and Daytona's
   own output decoding. */

let world: DropInWorld;
let daytona: Daytona;
beforeEach(() => {
  world = new DropInWorld();
  daytona = new Daytona({ withruntime: { client: world.client() } });
});

describe("@daytona/sdk 0.224.1 create target", () => {
  test('target "us" or "" creates the sandbox in Runtime\'s region', async () => {
    const sandbox = await daytona.create({ target: "us" });
    expect(sandbox.target).toBe("us");
    await daytona.create({ target: "" });
    expect(world.called("sandboxes.create")).toHaveLength(2);
  });

  test("another region is refused before anything is made", async () => {
    const error = await daytona.create({ target: "eu" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotSupportedError);
    expect((error as Error).message).toContain('The Daytona target "eu"');
    expect((error as Error).message).toContain('use "us"');
    expect(world.called("sandboxes.create")).toEqual([]);
  });

  test("a create's target overrides the client's, as upstream", async () => {
    const pinned = new Daytona({ target: "us", withruntime: { client: world.client() } });
    await expect(pinned.create({ target: "eu", image: "python:3.12" })).rejects.toBeInstanceOf(
      NotSupportedError,
    );
    expect(world.calls).toEqual([]);
  });
});
