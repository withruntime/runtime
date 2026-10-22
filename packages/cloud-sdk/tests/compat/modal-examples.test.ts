import { describe, expect, test } from "bun:test";
import type { Runtime } from "../../src/client.js";
import { ConflictError as NativeConflictError } from "../../src/errors.js";
import type { CreateSandbox } from "../../src/types.js";
import {
  App,
  CompatibilityError,
  InvalidError,
  ModalClient,
  Probe,
} from "../../src/modal/index.js";

/* What running Modal's own examples (modal-client js/examples at js/v0.11.1)
   against real Runtime sandboxes found, 18 October 2026: each test here
   failed on the adapter before. scripts/compatibility-modal-examples-live.ts
   runs the examples themselves. */

type Spawned = { argv: string[]; options: Record<string, unknown> };
function world() {
  const created: CreateSandbox[] = [];
  const builds: Record<string, unknown>[] = [];
  const spawned: Spawned[] = [];
  const execs: Spawned[] = [];
  const calls: string[] = [];
  let stopped = false;
  let finish: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => (finish = resolve));
  const process = (id: string) => ({
    id,
    wait: async () => ({ exitCode: await exited, timedOut: false }),
    refresh: async () => {
      if (stopped)
        throw new NativeConflictError({
          message: "Sandbox is stopped",
          code: "sandbox_stopped",
          status: 409,
        });
      return { state: "running", exitCode: null };
    },
    write: async () => undefined,
    output: async function* () {},
    outputBytes: async function* () {},
  });
  const sandbox = {
    id: "sbx-1",
    state: "running",
    info: { labels: {} as Record<string, string>, name: null, persistent: false },
    files: {
      write: async () => undefined,
      readText: async () => "{}",
    },
    spawn: async (argv: string[], options: Record<string, unknown>) => {
      spawned.push({ argv, options });
      return process(`proc-${spawned.length}`);
    },
    exec: async (argv: string[], options: Record<string, unknown>) => {
      execs.push({ argv, options });
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
    update: async (settings: { labels?: Record<string, string> }) => {
      if (settings.labels) sandbox.info.labels = { ...settings.labels };
      return sandbox;
    },
    refresh: async () => sandbox,
    stop: async () => {
      calls.push("stop");
      stopped = true;
      return sandbox;
    },
    previews: { create: async () => undefined, list: async () => [] },
  };
  const runtime = {
    sandboxes: {
      create: async (input: CreateSandbox) => {
        created.push(input);
        Object.assign(sandbox.info.labels, input.labels);
        return sandbox;
      },
    },
    images: {
      build: async (input: Record<string, unknown>) => {
        builds.push(input);
        return { id: "img-1" };
      },
    },
  };
  const modal = new ModalClient({ client: runtime as unknown as Runtime });
  return {
    modal,
    created,
    builds,
    spawned,
    execs,
    calls,
    exit: (code: number) => finish(code),
  };
}
const app = new App("libmodal-example", "libmodal-example");

describe("Modal's examples on Runtime", () => {
  test("a layer's secrets refuse, and their value reaches no build (image-building.ts)", async () => {
    // A build argument is kept in the image's build plan, history and cache
    // key: a secret's value must never be one (security review, 18 October 2026).
    const { modal, builds } = world();
    const curl = await modal.secrets.fromObject({ CURL_VERSION: "secret-8.12.1-r1" });
    const layer = () =>
      modal.images
        .fromRegistry("alpine:3.21")
        .dockerfileCommands(["RUN apk add --no-cache curl=$CURL_VERSION"], { secrets: [curl] });
    expect(layer).toThrow(CompatibilityError);
    expect(layer).toThrow(/at run time/);
    await expect(
      modal.sandboxes.create(app, modal.images.fromRegistry("alpine:3.21"), { secrets: [curl] }),
    ).resolves.toBeDefined();
    expect(JSON.stringify(builds)).not.toContain("secret-8.12.1-r1");
    expect(JSON.stringify(builds)).not.toContain("buildArgs");
    expect(() =>
      modal.images.fromRegistry("alpine:3.21").dockerfileCommands(["RUN x"], { gpu: "A10G" }),
    ).toThrow(CompatibilityError);
  });

  test("idleTimeoutMs pauses the idle sandbox, and is checked as Modal checks it (sandbox-tunnels.ts)", async () => {
    const { modal, created } = world();
    const image = modal.images.fromRegistry("python:3.12-alpine");
    await modal.sandboxes.create(app, image, { timeoutMs: 60_000, idleTimeoutMs: 30_000 });
    expect(created[0]).toMatchObject({ timeoutSeconds: 60, idlePauseSeconds: 30 });
    await modal.sandboxes.create(app, image, { idleTimeoutMs: 5_000 });
    expect(created[1]).toMatchObject({ idlePauseSeconds: 10 });
    expect(created[1]!.timeoutSeconds).toBeUndefined();
    for (const idleTimeoutMs of [0, 1500])
      await expect(modal.sandboxes.create(app, image, { idleTimeoutMs })).rejects.toBeInstanceOf(
        InvalidError,
      );
  });

  test("a timeout under a minute ends the sandbox on time; Runtime's minute is the bound", async () => {
    const { modal, created, calls } = world();
    await modal.sandboxes.create(app, modal.images.fromRegistry("alpine:3.21"), {
      timeoutMs: 20,
    });
    expect(created[0]).toMatchObject({ timeoutSeconds: 60, idlePauseSeconds: 0 });
    expect(calls).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toEqual(["stop"]);
  });

  test("processes run as root, as in a Modal container (sandbox-filesystem-snapshot.ts)", async () => {
    const { modal, spawned, execs } = world();
    const sb = await modal.sandboxes.create(app, modal.images.fromRegistry("alpine:3.21"), {
      readinessProbe: Probe.withExec(["true"]),
    });
    await sb.exec(["mkdir", "-p", "/app/data"]);
    await sb.waitUntilReady(1_000);
    expect(spawned.map((s) => s.options.user)).toEqual(["root", "root"]);
    expect(execs.map((s) => s.options.user)).toEqual(["root"]);
  });

  test("poll answers the exit code after the sandbox has ended (sandbox-poll.ts)", async () => {
    const { modal, exit } = world();
    const sb = await modal.sandboxes.create(app, modal.images.fromRegistry("alpine:3.21"), {
      command: ["sh", "-c", "read line; exit 42"],
    });
    expect(await sb.poll()).toBeNull();
    exit(42);
    expect(await sb.wait()).toBe(42);
    expect(await sb.poll()).toBe(42);
  });

  test("a process its sandbox ended before its exit was seen polls 137, as Modal's", async () => {
    const { modal } = world();
    const sb = await modal.sandboxes.create(app, modal.images.fromRegistry("alpine:3.21"));
    const p = await sb.exec(["sleep", "100"]);
    await sb.terminate();
    expect(await p._poll()).toBe(137);
  });

  test("exit snapshots refuse, naming snapshotFilesystem (sandbox-exit-snapshot.ts)", async () => {
    const { modal, created } = world();
    const image = modal.images.fromRegistry("alpine:3.21");
    const refused = modal.sandboxes.create(app, image, {
      experimentalOptions: { enable_exit_snapshot: true },
    });
    await expect(refused).rejects.toBeInstanceOf(CompatibilityError);
    await expect(refused).rejects.toThrow(/snapshotFilesystem\(\) before terminate\(\)/);
    await expect(
      modal.sandboxes.create(app, image, { experimentalOptions: { other: "x" } }),
    ).rejects.toThrow(/experimental option other/);
    expect(created).toEqual([]);
  });

  test("Functions, classes and queues refuse by name, naming Runtime's alternative (function-call.ts, cls-call.ts)", async () => {
    // They were undefined: `modal.functions.fromName(...)` was a TypeError
    // naming nothing to do instead.
    const { modal } = world();
    const calls = [
      () => modal.functions.fromName("libmodal-test-support", "echo_string"),
      () => modal.functions.fromId("fu-1"),
      () => modal.functionCalls.fromId("fc-1"),
      () => modal.cls.fromName("libmodal-test-support", "EchoCls"),
      () => modal.queues.fromName("q", { createIfMissing: true }),
      () => modal.queues.ephemeral(),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(CompatibilityError);
      await expect(call()).rejects.toThrow(/Runtime/);
    }
  });
});
