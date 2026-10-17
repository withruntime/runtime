/** morphcloud 0.0.20's client on Runtime, against a simulated native client:
 * what each Morph call asks Runtime for, and what it refuses. The same calls
 * against the real API: scripts/compatibility-morph-live.ts. */
import { describe, expect, test } from "bun:test";
import type { Runtime } from "../../src/client.js";
import { RuntimeError } from "../../src/errors.js";
import {
  CompatibilityError,
  InstanceStatus,
  MorphCloudClient,
  Snapshot,
} from "../../src/morph/index.js";

const SANDBOX = "00000000-0000-4000-8000-000000000001";
const SNAP = "00000000-0000-4000-8000-0000000000aa";

function snapshotInfo(id: string, labels: Record<string, string> = {}, name: string | null = null) {
  return {
    id,
    kind: "snapshot",
    state: "ready",
    name,
    labels,
    shape: { vcpu: 2, memoryMiB: 4096, diskMiB: 4096 },
    createdAt: "2026-10-15T00:00:00.000Z",
  };
}

/** A native client whose calls are recorded. */
function world() {
  const calls: { call: string; args: unknown[] }[] = [];
  const snapshots: ReturnType<typeof snapshotInfo>[] = [snapshotInfo(SNAP)];
  let exec = { exitCode: 0, stdout: "out", stderr: "", timedOut: false };
  const sandbox = (overrides: Record<string, unknown> = {}) => {
    const info = {
      id: SANDBOX,
      state: "running",
      labels: {} as Record<string, string>,
      vcpu: 2,
      memoryMiB: 4096,
      diskMiB: 4096,
      timeoutSeconds: 0,
      autoWake: true,
      onLeaseEnd: "pause",
      createdAt: "2026-10-15T00:00:00.000Z",
      ...overrides,
    };
    const self = {
      id: info.id,
      info,
      get state() {
        return info.state;
      },
      async exec(command: unknown, options: unknown) {
        calls.push({ call: "exec", args: [command, options] });
        return exec;
      },
      async pause() {
        calls.push({ call: "pause", args: [] });
        info.state = "paused";
        return self;
      },
      async wake() {
        calls.push({ call: "wake", args: [] });
        info.state = "running";
        return self;
      },
      async update(settings: Record<string, unknown>) {
        calls.push({ call: "update", args: [settings] });
        Object.assign(info, settings);
        return self;
      },
      async snapshot(options: { name?: string; labels?: Record<string, string> }) {
        calls.push({ call: "snapshot", args: [options] });
        const made = snapshotInfo(`snap-${snapshots.length}`, options.labels, options.name ?? null);
        snapshots.push(made);
        return made;
      },
      async delete() {
        calls.push({ call: "delete", args: [info.id] });
      },
      previews: {
        create: async (port: number, input: unknown) => {
          calls.push({ call: "previews.create", args: [port, input] });
          return { port, url: `https://${port}-sbx.example/` };
        },
        list: async () => [{ port: 8000, url: "https://8000-sbx.example/" }],
        delete: async (port: number) => calls.push({ call: "previews.delete", args: [port] }),
      },
    };
    return self;
  };
  let current = sandbox();
  const runtime = {
    transport: {
      baseUrl: "https://api.withruntime.com",
      json: async (call: { path: string; body: unknown }) => {
        calls.push({ call: "transport", args: [call.path, call.body] });
        return {
          sandboxes: [current.info, { ...current.info, id: "copy-2" }],
          snapshot: snapshotInfo("fork-snap"),
        };
      },
    },
    sandboxes: {
      create: async (input: unknown, options: unknown) => {
        calls.push({ call: "sandboxes.create", args: [input, options] });
        const labels = (input as { labels?: Record<string, string> }).labels ?? {};
        current = sandbox({ labels: { ...labels } });
        return current;
      },
      get: async () => current,
      delete: async (id: string) => calls.push({ call: "sandboxes.delete", args: [id] }),
      list: async (filter: unknown) => {
        calls.push({ call: "sandboxes.list", args: [filter] });
        return [current];
      },
    },
    snapshots: {
      get: async (id: string) => snapshots.find((s) => s.id === id) ?? snapshotInfo(id),
      list: async (filter: { name?: string }) => {
        calls.push({ call: "snapshots.list", args: [filter] });
        return snapshots.filter((s) => !filter.name || s.name === filter.name);
      },
      update: async (id: string, input: { labels: Record<string, string> }) => {
        calls.push({ call: "snapshots.update", args: [id, input] });
        return snapshotInfo(id, input.labels);
      },
      delete: async (id: string) => calls.push({ call: "snapshots.delete", args: [id] }),
    },
  };
  const morph = new MorphCloudClient({ client: runtime as unknown as Runtime });
  return {
    morph,
    calls,
    named: (name: string) => calls.filter((c) => c.call === name).map((c) => c.args),
    setExec: (value: typeof exec) => (exec = value),
  };
}

describe("client", () => {
  test("a Morph key and endpoint never reach Runtime", () => {
    expect(() => new MorphCloudClient({ baseUrl: "https://cloud.morph.so/api" })).toThrow(
      CompatibilityError,
    );
    const morph = new MorphCloudClient({ apiKey: "morph_secret", baseUrl: "http://localhost:1" });
    expect(morph.apiKey).toBe("");
    expect(morph.runtime.transport.baseUrl).not.toContain("morph");
  });
  test("raw HTTP verbs refuse, naming Runtime's client", async () => {
    const { morph } = world();
    await expect(morph.GET("/instance")).rejects.toThrow(/new Runtime\(\)/);
  });
  test("images.list answers Morph's base image", async () => {
    const { morph } = world();
    expect((await morph.images.list()).map((i) => i.id)).toEqual(["morphvm-minimal"]);
  });
});

describe("instances", () => {
  test("start passes metadata as labels and a TTL as the time limit, deleting at its end", async () => {
    const { morph, named } = world();
    const instance = await morph.instances.start({
      snapshotId: SNAP,
      metadata: { team: "a" },
      ttlSeconds: 600,
      timeout: 30,
    });
    const [input, options] = named("sandboxes.create")[0]!;
    expect(input).toEqual({
      snapshot: SNAP,
      timeoutSeconds: 600,
      onLeaseEnd: "delete",
      labels: { team: "a", "compat.provider": "morph" },
    });
    expect(options).toEqual({ timeoutMs: 30_000 });
    expect(instance.status).toBe(InstanceStatus.READY);
    expect(instance.metadata).toEqual({ team: "a" });
    expect(instance.refs.snapshotId).toBe(SNAP);
  });
  test("a TTL Runtime cannot keep refuses before anything starts", async () => {
    const { morph, named } = world();
    await expect(morph.instances.start({ snapshotId: SNAP, ttlSeconds: 30 })).rejects.toThrow(
      CompatibilityError,
    );
    expect(named("sandboxes.create")).toEqual([]);
  });
  test("exec: a string or one item runs in a shell, more items as arguments, 24 hours by default", async () => {
    const { morph, named } = world();
    const instance = await morph.instances.start({ snapshotId: SNAP });
    expect(await instance.exec("echo hi")).toEqual({ exit_code: 0, stdout: "out", stderr: "" });
    await instance.exec(["echo hi"]);
    await instance.exec(["python3", "-c", "print(1)"], { timeout: 5 });
    expect(
      named("exec").map(([command, options]) => [
        command,
        (options as { timeoutMs: number }).timeoutMs,
      ]),
    ).toEqual([
      ["echo hi", 86_400_000],
      ["echo hi", 86_400_000],
      [["python3", "-c", "print(1)"], 5_000],
    ]);
  });
  test("a command past its timeout throws as Morph's does", async () => {
    const { morph, setExec } = world();
    const instance = await morph.instances.start({ snapshotId: SNAP });
    setExec({ exitCode: null as unknown as number, stdout: "", stderr: "", timedOut: true });
    await expect(instance.exec("sleep 9", { timeout: 1 })).rejects.toThrow(
      "Command execution timed out after 1 second",
    );
  });
  test("pause and resume are Runtime's pause and wake", async () => {
    const { morph, named } = world();
    const instance = await morph.instances.start({ snapshotId: SNAP });
    await instance.pause();
    expect(instance.status).toBe(InstanceStatus.PAUSED);
    await instance.resume();
    expect(instance.status).toBe(InstanceStatus.READY);
    expect(named("pause").length + named("wake").length).toBe(2);
  });
  test("setWakeOn sets autoWake, and refuses SSH and HTTP set apart", async () => {
    const { morph, named } = world();
    const instance = await morph.instances.start({ snapshotId: SNAP });
    await instance.setWakeOn(false, false);
    expect(named("update")).toEqual([[{ autoWake: false }]]);
    expect(instance.wakeOn).toEqual({ wakeOnSsh: false, wakeOnHttp: false });
    await expect(instance.setWakeOn(true, false)).rejects.toThrow(CompatibilityError);
  });
  test("branch forks with the snapshot kept and answers both", async () => {
    const { morph, named } = world();
    const instance = await morph.instances.start({ snapshotId: SNAP });
    const { snapshot, instances } = await instance.branch(2);
    expect(named("transport")).toEqual([
      [`/v1/sandboxes/${SANDBOX}:fork`, { count: 2, keepSnapshot: true }],
    ]);
    expect(snapshot.id).toBe("fork-snap");
    expect(instances.map((i) => i.id)).toEqual([SANDBOX, "copy-2"]);
  });
  test("an HTTP service is a preview: public, or private with auth_mode api_key", async () => {
    const { morph, named } = world();
    const instance = await morph.instances.start({ snapshotId: SNAP });
    const service = await instance.exposeHttpService("web", 8000, "api_key");
    expect(service).toEqual({ name: "web", port: 8000, url: "https://8000-sbx.example/" });
    expect(named("previews.create")).toEqual([[8000, { visibility: "private" }]]);
    expect(instance.networking.httpServices).toEqual([service]);
    expect(instance.metadata).toEqual({});
    await instance.hideHttpService("web");
    expect(named("previews.delete")).toEqual([[8000]]);
    await expect(instance.exposeHttpService("web", 8000, "oauth")).rejects.toThrow(
      CompatibilityError,
    );
  });
  test("stop deletes the sandbox, as Morph's stop does", async () => {
    const { morph, named } = world();
    const instance = await morph.instances.start({ snapshotId: SNAP });
    await instance.stop();
    expect(named("sandboxes.delete")).toEqual([[SANDBOX]]);
  });
  test("metadata cannot write the adapter's own labels", async () => {
    const { morph } = world();
    const instance = await morph.instances.start({ snapshotId: SNAP });
    await expect(instance.setMetadata({ "compat.provider": "x" })).rejects.toThrow(
      CompatibilityError,
    );
  });
  test("SSH, reboot and a later TTL refuse, naming Runtime's alternative", async () => {
    const { morph } = world();
    const instance = await morph.instances.start({ snapshotId: SNAP });
    await expect(instance.ssh()).rejects.toThrow(/runtime sandboxes ssh/);
    await expect(instance.reboot()).rejects.toThrow(CompatibilityError);
    await expect(instance.setTTL(60)).rejects.toThrow(/ttlSeconds/);
    await expect(instance.sync("a", `${SANDBOX}:/b`, { delete: true })).rejects.toThrow(
      CompatibilityError,
    );
  });
  test("a Runtime error becomes Morph's HTTP error, keeping its cause", async () => {
    const { morph } = world();
    const native = new RuntimeError({ code: "sandbox_not_found", status: 404, message: "gone" });
    (morph.runtime.sandboxes as { get: unknown }).get = async () => {
      throw native;
    };
    const error = (await morph.instances.get({ instanceId: "x" }).catch((e: Error) => e)) as Error;
    expect(error.message).toStartWith("HTTP 404 sandbox_not_found");
    expect((error as Error & { status: number }).status).toBe(404);
    expect(error.cause).toBe(native);
  });
});

describe("snapshots", () => {
  test("Morph's chain hash", () => {
    expect(Snapshot.computeChainHash("parent", "effect")).toBe(
      new Bun.CryptoHasher("sha256").update("parent\neffect").digest("hex"),
    );
  });
  test("setup runs once per command and snapshot, then answers the cache", async () => {
    const { morph, named } = world();
    const base = await morph.snapshots.get({ snapshotId: SNAP });
    const first = await base.setup("apt-get install -y jq");
    expect(named("sandboxes.create").length).toBe(1);
    expect(named("sandboxes.delete")).toEqual([[SANDBOX]]);
    const digest = Snapshot.computeChainHash(
      SNAP,
      JSON.stringify(["apt-get install -y jq", false, true]),
    );
    expect(first.digest).toBe(digest);
    const second = await base.setup("apt-get install -y jq");
    expect(second.id).toBe(first.id);
    expect(named("sandboxes.create").length).toBe(1);
  });
  test("a failing setup command throws and still deletes its sandbox", async () => {
    const { morph, named, setExec } = world();
    setExec({ exitCode: 2, stdout: "", stderr: "", timedOut: false });
    const base = await morph.snapshots.get({ snapshotId: SNAP });
    await expect(base.setup("false")).rejects.toThrow("Command exited with code 2");
    expect(named("snapshot")).toEqual([]);
    expect(named("sandboxes.delete")).toEqual([[SANDBOX]]);
  });
  test("create boots the image at its size, keeps its disk and deletes the sandbox", async () => {
    const { morph, named } = world();
    const snapshot = await morph.snapshots.create({
      vcpus: 1,
      memory: 2048,
      diskSize: 8192,
      metadata: { a: "1" },
    });
    expect(named("sandboxes.create")[0]![0]).toEqual({
      vcpu: 1,
      memoryMiB: 2048,
      diskMiB: 8192,
      labels: { "compat.provider": "morph" },
    });
    expect((named("snapshot")[0]![0] as { mode: string }).mode).toBe("disk");
    expect(named("delete")).toEqual([[SANDBOX]]);
    expect(snapshot.metadata).toEqual({ a: "1" });
    expect(snapshot.refs.imageId).toBe("morphvm-minimal");
  });
  test("another Morph image refuses, naming Runtime images", async () => {
    const { morph, named } = world();
    await expect(morph.snapshots.create({ imageId: "morphvm-ubuntu" })).rejects.toThrow(
      /runtime\.images/,
    );
    expect(named("sandboxes.create")).toEqual([]);
  });
  test("setMetadata merges into the labels", async () => {
    const { morph, named } = world();
    const snapshot = await morph.snapshots.get({ snapshotId: SNAP });
    await snapshot.setMetadata({ b: "2" });
    expect(named("snapshots.update")).toEqual([[SNAP, { labels: { b: "2" } }]]);
    expect(snapshot.metadata).toEqual({ b: "2" });
  });
});
