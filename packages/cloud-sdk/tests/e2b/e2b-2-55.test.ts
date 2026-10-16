import { beforeEach, describe, expect, test } from "bun:test";
import * as codeInterpreter from "../../src/e2b/code-interpreter";
import {
  DockerfileSyntaxError,
  InvalidArgumentError,
  NotSupportedError,
  Sandbox,
  SandboxError,
  type SandboxOpts,
} from "../../src/e2b/index";
import { FakeWorld } from "./fake";

/* What e2b 2.55.0 changed in the calls withruntime/e2b implements, read from
   its published package on 9 October 2026 (E2B.md, "e2b 2.55.0"): pause,
   createSnapshot and onTimeout take `mode: "full" | "filesystem"`, keepMemory
   is deprecated, and DockerfileSyntaxError is exported. */

let world: FakeWorld;
const runtime = () => ({ runtime: { client: world.client() } });
const create = (opts: SandboxOpts = {}) =>
  Sandbox.create({ ...opts, runtime: { client: world.client(), ...opts.runtime } });
const caught = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

beforeEach(() => {
  world = new FakeWorld();
});

describe("e2b 2.55 snapshot mode", () => {
  test("createSnapshot({ mode: 'filesystem' }) takes a disk snapshot; 'full' the whole machine", async () => {
    const sbx = await create();
    await sbx.createSnapshot({ name: "files", mode: "filesystem" });
    await sbx.createSnapshot({ mode: "full" });
    await Sandbox.createSnapshot(sbx.sandboxId, { ...runtime(), mode: "filesystem" });
    await sbx.createSnapshot();
    const modes = world
      .called("sandbox.snapshot")
      .map((call) => (call[1] as { mode?: string; name?: string }).mode);
    expect(modes).toEqual(["disk", "memory", "disk", undefined]);
    expect((world.called("sandbox.snapshot")[0]![1] as { name?: string }).name).toBe("files");
  });

  test("an unknown mode is E2B's InvalidArgumentError, before anything is taken", async () => {
    const sbx = await create();
    const error = await caught(sbx.createSnapshot({ mode: "memory" as never }));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect((error as Error).message).toBe('mode must be one of: full, filesystem (got "memory").');
    expect(world.called("sandbox.snapshot")).toEqual([]);
  });

  test("pause({ mode: 'filesystem' }) is refused, naming the files-only snapshot", async () => {
    const sbx = await create();
    for (const opts of [{ mode: "filesystem" as const }, { keepMemory: false }]) {
      const error = await caught(sbx.pause(opts));
      expect(error).toBeInstanceOf(NotSupportedError);
      expect((error as Error).message).toContain("createSnapshot({ mode: 'filesystem' })");
      expect(await caught(Sandbox.pause(sbx.sandboxId, { ...runtime(), ...opts }))).toBeInstanceOf(
        NotSupportedError,
      );
    }
    expect(world.called("sandbox.pause")).toEqual([]);
  });

  test("pause({ mode: 'full' }) pauses; mode beside keepMemory, or an unknown mode, is refused", async () => {
    const both = await caught((await create()).pause({ mode: "full", keepMemory: true } as never));
    expect(both).toBeInstanceOf(InvalidArgumentError);
    expect((both as Error).message).toBe(
      "Pass either mode or the deprecated keepMemory, not both.",
    );
    expect(await caught((await create()).pause({ mode: "warm" as never }))).toBeInstanceOf(
      InvalidArgumentError,
    );
    expect(world.called("sandbox.pause")).toEqual([]);
    expect(await (await create()).pause({ mode: "full" })).toBe(true);
    expect(world.called("sandbox.pause")).toHaveLength(1);
  });

  test("onTimeout's mode: 'filesystem' is refused, 'full' pauses, and mode on a kill is invalid", async () => {
    const refused = await caught(
      create({ lifecycle: { onTimeout: { action: "pause", mode: "filesystem" } } }),
    );
    expect(refused).toBeInstanceOf(NotSupportedError);
    const onKill = await caught(
      create({ lifecycle: { onTimeout: { action: "kill", mode: "full" } as never } }),
    );
    expect(onKill).toBeInstanceOf(InvalidArgumentError);
    expect((onKill as Error).message).toBe(
      "onTimeout.mode is only allowed when action is 'pause'.",
    );
    expect(world.called("sandboxes.create")).toEqual([]);
    await create({ lifecycle: { onTimeout: { action: "pause", mode: "full" } } });
    expect(world.called("sandboxes.create").at(-1)![0]).toMatchObject({ onLeaseEnd: "pause" });
  });
});

describe("e2b 2.55 exports", () => {
  test("DockerfileSyntaxError is E2B's: a plain Error with the line, from both imports", () => {
    expect(codeInterpreter.DockerfileSyntaxError).toBe(DockerfileSyntaxError);
    const error = new DockerfileSyntaxError("bad substitution", 3);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SandboxError);
    expect(error.name).toBe("DockerfileSyntaxError");
    expect(error.line).toBe(3);
    expect(error.message).toBe("Dockerfile parse error on line 3: bad substitution");
    expect(new DockerfileSyntaxError("x").message).toBe("Dockerfile parse error: x");
  });
});
