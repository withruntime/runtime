import { describe, expect, test } from "bun:test";
import type { Runtime } from "../../src/client.js";
import {
  ConflictError as NativeConflictError,
  NotFoundError as NativeNotFoundError,
  RuntimeError,
} from "../../src/errors.js";
import type { FileEvent, WatchOptions } from "../../src/products/watch.js";
import type { Sandbox as NativeSandbox } from "../../src/sandbox.js";
import type { CreateSandbox } from "../../src/types.js";
import {
  AlreadyExistsError,
  App,
  ClientClosedError,
  CloudBucketMount,
  CompatibilityError,
  ExperimentalOutboundPolicy,
  Image,
  InvalidError,
  ModalClient,
  NotFoundError,
  Probe,
  Proxy,
  Sandbox,
  SandboxFilesystemIsADirectoryError,
  SandboxFilesystemNotFoundError,
  SandboxFilesystemPermissionError,
  SandboxLogsManager,
  SandboxSnapshot,
  SidecarContainer,
  SidecarService,
  SnapshotCreationError,
  TimeoutError,
  Tunnel,
  type Volume,
} from "../../src/modal/index.js";

/** A native sandbox that records what the adapter asks of it. */
function fakeSandbox(labels: Record<string, string> = {}) {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const processes = new Map<string, unknown>();
  let exits: number[] = [];
  const process = (id: string) => ({
    id,
    wait: () => new Promise(() => undefined),
    refresh: async () => ({ state: "running", exitCode: null }),
    write: async () => undefined,
    output: async function* () {},
    outputBytes: async function* () {},
  });
  const sandbox = {
    id: "sbx-1",
    state: "running",
    info: { labels: { ...labels }, name: null as string | null, persistent: false },
    calls,
    files: {
      write: async (path: string, content: string) => {
        files.set(path, content);
      },
      readText: async (path: string) => {
        const text = files.get(path);
        if (text === undefined)
          throw new NativeNotFoundError({
            message: "missing",
            code: "file_not_found",
            status: 404,
          });
        return text;
      },
      watch: undefined as unknown,
    },
    processes: {
      get: async (id: string) => {
        calls.push(`process ${id}`);
        if (!processes.has(id) && id !== "proc-1")
          throw new NativeNotFoundError({ message: "no process", code: "not_found", status: 404 });
        return process(id);
      },
    },
    spawn: async (argv: string[]) => {
      calls.push(`spawn ${argv.join(" ")}`);
      return process("proc-1");
    },
    update: async (settings: { name?: string; labels?: Record<string, string> }) => {
      calls.push(`update ${JSON.stringify(settings)}`);
      if (settings.labels) sandbox.info.labels = { ...settings.labels };
      if (settings.name) sandbox.info.name = settings.name;
      return sandbox;
    },
    refresh: async () => sandbox,
    stop: async () => {
      calls.push("stop");
      return sandbox;
    },
    exec: async (argv: string[]) => {
      calls.push(`exec ${argv.join(" ")}`);
      return {
        exitCode: exits.length ? exits.shift()! : 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      };
    },
    snapshot: async (options: Record<string, unknown>) => {
      calls.push(`snapshot ${JSON.stringify(options)}`);
      return { id: "snap-1" };
    },
    previews: {
      create: async (port: number) => calls.push(`preview ${port}`),
      list: async () => [{ port: 8000, url: "https://8000-sbx-1.runtimehost.com/" }],
    },
    mounts: {
      add: async (mount: unknown) => {
        calls.push(`mount ${JSON.stringify(mount)}`);
      },
    },
    network: { set: async (input: unknown) => calls.push(`network ${JSON.stringify(input)}`) },
    exitCodes(codes: number[]) {
      exits = codes;
    },
  };
  return sandbox;
}
type Fake = ReturnType<typeof fakeSandbox>;

/** A native client whose sandboxes are `fake`, recording each create input. */
function fakeRuntime(fake: Fake = fakeSandbox()) {
  const created: CreateSandbox[] = [];
  const runtime = {
    created,
    sandboxes: {
      create: async (input: CreateSandbox) => {
        created.push(input);
        Object.assign(fake.info.labels, input.labels);
        return fake;
      },
      get: async (id: string) => {
        if (id !== fake.id)
          throw new NativeNotFoundError({ message: "gone", code: "not_found", status: 404 });
        return fake;
      },
      list: async () => [fake],
    },
    images: {
      build: async () => ({ id: "img-1" }),
      get: async (id: string) => ({ id }),
      resolve: async (name: string) => {
        if (name === "missing")
          throw new NativeNotFoundError({ message: "no image", code: "not_found", status: 404 });
        return { id: `img-${name}` };
      },
      delete: async () => undefined,
    },
    volumes: {
      list: async ({ name }: { name: string }) => ({
        data: name === "data" ? [{ id: "vol-1", name: "data", state: "ready" }] : [],
      }),
      delete: async (id: string) => fake.calls.push(`delete volume ${id}`),
    },
    snapshots: {
      get: async (id: string) => {
        if (id === "gone")
          throw new NativeNotFoundError({ message: "gone", code: "not_found", status: 404 });
        if (id === "disk") return { id, mode: "disk", state: "ready", labels: {} };
        return {
          id,
          mode: "memory",
          state: "ready",
          labels: { "modal.app": "app", "modal.entrypoint": "proc-1", "modal.tags": "{}" },
        };
      },
    },
  };
  return { runtime: runtime as unknown as Runtime, created, fake };
}
const modalOf = (runtime: Runtime) => new ModalClient({ client: runtime });
const app = new App("app", "app");

describe("Modal client", () => {
  test("refuses Modal's own endpoints and environments, before any request", () => {
    for (const options of [
      { endpoint: "https://api.modal.com" },
      { oauthJwtKey: "k" },
      { logLevel: "DEBUG" },
      { grpcMiddleware: [] },
      { maxThrottleWaitSecs: 5 },
      { environment: "dev" },
    ])
      expect(() => new ModalClient({ client: {} as Runtime, ...options })).toThrow(
        CompatibilityError,
      );
  });
  test("reports its version, the default environment, and fails after close", async () => {
    const { runtime } = fakeRuntime();
    const modal = modalOf(runtime);
    expect(modal.version()).toBe("0.11.1");
    expect(modal.environmentName()).toBe("");
    expect(() => modal.environmentName("prod")).toThrow(CompatibilityError);
    modal.close();
    await expect(modal.apps.fromName("app", { createIfMissing: true })).rejects.toBeInstanceOf(
      ClientClosedError,
    );
    expect(() => modal.images.fromRegistry("python:3.13")).toThrow(ClientClosedError);
  });
  test("refused members name Runtime's alternative", async () => {
    const modal = modalOf(fakeRuntime().runtime);
    for (const call of [
      () => modal.cpClient(),
      () => modal.ipClient(),
      () => modal.profile(),
      () => modal.logger(),
      () => modal.images.fromAwsEcr("x", undefined),
      () => modal.images.fromGcpArtifactRegistry("x", undefined),
      () => new ExperimentalOutboundPolicy().withHeaderReplacement({}),
      () => new Proxy().proxyId(),
      () => Probe.withTcp(80).toProto(),
      () => new SandboxLogsManager().tail(),
      () => new SidecarService().list(),
      () => new SidecarContainer().containerId(),
      () => new CloudBucketMount("b").toProto(),
    ])
      expect(call).toThrow(CompatibilityError);
    for (const call of [
      () => modal.getImageBuilderVersion(),
      () => modal.proxies.fromName("ip"),
      () => modal.secrets.fromName("openai"),
      () => modal.secrets.delete("openai"),
      () => modal.volumes.ephemeral(),
      () => new SidecarService().create(),
      () => new SidecarContainer().exec(),
      () => new Image(undefined, "python:3.13").publish("name"),
    ])
      await expect(call()).rejects.toThrow(/Runtime|runtime|sandbox/);
  });
});

describe("Modal images", () => {
  test("look up by id and name, delete, and map a missing name to NotFoundError", async () => {
    const { runtime } = fakeRuntime();
    const modal = modalOf(runtime);
    expect((await modal.images.fromId("img-9")).imageId).toBe("img-9");
    expect((await modal.images.fromName("base")).imageId).toBe("img-base");
    await expect(modal.images.fromName("missing")).rejects.toBeInstanceOf(NotFoundError);
    await expect(modal.images.fromName("base", { environment: "dev" })).rejects.toBeInstanceOf(
      CompatibilityError,
    );
    await expect(modal.images.delete("img-9")).resolves.toBeUndefined();
    expect(() => modal.images.fromRegistry("private:1", modal.secrets as never)).toThrow(
      CompatibilityError,
    );
  });
});

describe("Modal sandbox create", () => {
  test("secrets, volumes, read-only volumes and bucket mounts reach the native sandbox", async () => {
    const { runtime, created, fake } = fakeRuntime();
    const modal = modalOf(runtime);
    const secret = await modal.secrets.fromObject({ TOKEN: "t" });
    expect(secret.secretId).toMatch(/^st-/);
    const volume = await modal.volumes.fromName("data");
    const sandbox = await modal.sandboxes.create(app, modal.images.fromRegistry("python:3.13"), {
      secrets: [secret],
      env: { MODE: "x" },
      volumes: { "/data": volume, "/ro": volume.withMountOptions({ readOnly: true }) },
      cloudBucketMounts: {
        "/r2": modal.cloudBucketMounts.create("bucket", {
          bucketEndpointUrl: "https://abc123.r2.cloudflarestorage.com",
          keyPrefix: "p/",
          readOnly: true,
        }),
        "/gcs": modal.cloudBucketMounts.create("g", {
          bucketEndpointUrl: "https://storage.googleapis.com",
        }),
        "/s3": modal.cloudBucketMounts.create("s"),
      },
      readinessProbe: Probe.withTcp(8000),
      runtime: "vm",
    });
    expect(created[0]!.volumes).toEqual([
      { volumeId: "vol-1", path: "/data", mode: "rw" },
      { volumeId: "vol-1", path: "/ro", mode: "snapshot" },
    ]);
    expect(created[0]!.image).toBe("img-1");
    expect(JSON.parse(fake.info.labels["modal.probe"]!)).toEqual({
      tcpPort: 8000,
      intervalMs: 100,
    });
    expect(fake.calls.filter((c) => c.startsWith("mount"))).toEqual([
      `mount ${JSON.stringify({ provider: "r2", bucket: "bucket", path: "/r2", accountId: "abc123", prefix: "p/", readOnly: true })}`,
      `mount ${JSON.stringify({ provider: "gcs", bucket: "g", path: "/gcs", endpoint: "storage.googleapis.com", readOnly: false })}`,
      `mount ${JSON.stringify({ provider: "s3", bucket: "s", path: "/s3", readOnly: false })}`,
    ]);
    // The mounts are in place before the entrypoint starts.
    expect(fake.calls.findIndex((c) => c.startsWith("spawn"))).toBeGreaterThan(
      fake.calls.findIndex((c) => c.startsWith("mount")),
    );
    await expect(sandbox.reloadVolumes()).rejects.toBeInstanceOf(CompatibilityError);
  });
  test("refuses what Runtime does not do, before any allocation", async () => {
    const { runtime, created } = fakeRuntime();
    const modal = modalOf(runtime);
    const image = modal.images.fromRegistry("python:3.13");
    for (const params of [
      { runtime: "gvisor" as const },
      { unencryptedPorts: [22] },
      { h2Ports: [443] },
      { customDomain: "x.example.com" },
      { inboundCidrAllowlist: ["1.2.3.4/32"] },
      { includeOidcIdentityToken: true },
      { verbose: true },
      { proxy: new Proxy() },
    ]) {
      await expect(modal.sandboxes.create(app, image, params as never)).rejects.toBeInstanceOf(
        CompatibilityError,
      );
      await expect(
        modal.sandboxes.experimentalCreate(app, image, params as never),
      ).rejects.toBeInstanceOf(CompatibilityError);
    }
    expect(() => modal.cloudBucketMounts.create("b", { secret: {} as never })).toThrow(
      CompatibilityError,
    );
    expect(() => modal.cloudBucketMounts.create("b", { requesterPays: true })).toThrow(
      CompatibilityError,
    );
    expect(() => modal.cloudBucketMounts.create("b", { oidcAuthRoleArn: "arn" })).toThrow(
      CompatibilityError,
    );
    expect(() => modal.cloudBucketMounts.create("b", { bucketEndpointUrl: "not a url" })).toThrow(
      TypeError,
    );
    await expect(
      modal.sandboxes.create(app, image, { volumes: { "/d": {} as Volume } }),
    ).rejects.toBeInstanceOf(InvalidError);
    expect(created).toEqual([]);
  });
  test("network rules are never wider than Modal's", async () => {
    const network = async (params: Record<string, unknown>) => {
      const { runtime, created } = fakeRuntime();
      const modal = modalOf(runtime);
      await modal.sandboxes.create(app, modal.images.fromRegistry("python:3.13"), params);
      return created[0]!.network;
    };
    expect(await network({})).toEqual({ internet: true });
    expect(await network({ blockNetwork: true })).toEqual({ internet: false });
    // An empty list admits nothing; the native rules read an empty allow
    // list as the public web, so nothing listed is no internet.
    expect(await network({ outboundDomainAllowlist: [] })).toEqual({ internet: false });
    expect(await network({ outboundCidrAllowlist: [] })).toEqual({ internet: false });
    expect(await network({ outboundDomainAllowlist: [], outboundCidrAllowlist: [] })).toEqual({
      internet: false,
    });
    // Modal admits what either list admits (modal-client's own
    // sandbox-network-policy.ts: only modal.com, by name, with no addresses).
    expect(
      await network({ outboundDomainAllowlist: ["modal.com"], outboundCidrAllowlist: [] }),
    ).toEqual({ internet: true, allow: ["modal.com"] });
    expect(
      await network({
        outboundDomainAllowlist: ["pypi.org"],
        outboundCidrAllowlist: ["10.0.0.0/8"],
      }),
    ).toEqual({ internet: true, allow: ["pypi.org", "10.0.0.0/8"] });
    // Modal's *.example.com matches example.com too; Runtime's does not.
    expect(await network({ outboundDomainAllowlist: ["pypi.org", "*.pythonhosted.org"] })).toEqual({
      internet: true,
      allow: ["pypi.org", "*.pythonhosted.org", "pythonhosted.org"],
    });
    // Only both families' whole ranges are every address: ::/0 alone opened
    // IPv4 too, and 0.0.0.0/0 alone IPv6 (security review, 18 October 2026).
    expect(await network({ outboundCidrAllowlist: ["::/0"] })).toEqual({
      internet: true,
      allow: ["::/0"],
    });
    expect(await network({ outboundCidrAllowlist: ["0.0.0.0/0", "0.0.0.0/0"] })).toEqual({
      internet: true,
      allow: ["0.0.0.0/0"],
    });
    expect(await network({ outboundCidrAllowlist: ["0.0.0.0/0", "::/0"] })).toEqual({
      internet: true,
    });
    // Modal's examples pass "*" with 0.0.0.0/0: that range alone, never more.
    expect(
      await network({ outboundDomainAllowlist: ["*"], outboundCidrAllowlist: ["0.0.0.0/0"] }),
    ).toEqual({ internet: true, allow: ["0.0.0.0/0"] });
    expect(
      await network({
        outboundDomainAllowlist: ["*"],
        outboundCidrAllowlist: ["0.0.0.0/0", "::/0"],
      }),
    ).toEqual({ internet: true });
    // Every name but not every address has no Runtime rule.
    for (const params of [
      { outboundDomainAllowlist: ["*"] },
      { outboundCidrAllowlist: ["10.0.0.0/8"], outboundDomainAllowlist: ["*"] },
    ]) {
      const { runtime, created } = fakeRuntime();
      const modal = modalOf(runtime);
      await expect(
        modal.sandboxes.create(app, modal.images.fromRegistry("python:3.13"), params),
      ).rejects.toBeInstanceOf(CompatibilityError);
      expect(created).toEqual([]);
    }
  });
  test("a taken name is AlreadyExistsError", async () => {
    const { runtime } = fakeRuntime();
    (runtime.sandboxes as unknown as { create: () => Promise<never> }).create = async () => {
      throw new NativeConflictError({ message: "taken", code: "name_taken", status: 409 });
    };
    await expect(
      modalOf(runtime).sandboxes.create(app, new Image(runtime, "python:3.13"), { name: "one" }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
  });
});

describe("Modal volumes", () => {
  test("find, refuse to invent a size, and delete by name", async () => {
    const { runtime, fake } = fakeRuntime();
    const modal = modalOf(runtime);
    const volume = await modal.volumes.fromName("data");
    expect([volume.volumeId, volume.name]).toEqual(["vol-1", "data"]);
    await expect(modal.volumes.fromName("other")).rejects.toBeInstanceOf(NotFoundError);
    await expect(modal.volumes.fromName("other", { createIfMissing: true })).rejects.toBeInstanceOf(
      CompatibilityError,
    );
    await expect(modal.volumes.delete("other")).rejects.toBeInstanceOf(NotFoundError);
    await expect(modal.volumes.delete("other", { allowMissing: true })).resolves.toBeUndefined();
    await modal.volumes.delete("data");
    expect(fake.calls).toContain("delete volume vol-1");
    expect(() => volume.withMountOptions({ subPath: "a" })).toThrow(CompatibilityError);
    expect(() => volume.closeEphemeral()).toThrow(InvalidError);
  });
});

describe("Modal sandbox", () => {
  const started = async (labels: Record<string, string> = {}) => {
    const fake = fakeSandbox({ "modal.app": "app", ...labels });
    const { runtime } = fakeRuntime(fake);
    const modal = modalOf(runtime);
    const sandbox = await modal.sandboxes.fromId(fake.id);
    return { fake, runtime, modal, sandbox };
  };
  test("probes validate as Modal's do, and waitUntilReady retries until one passes", async () => {
    expect(() => Probe.withTcp(0)).toThrow(InvalidError);
    expect(() => Probe.withTcp(1.5)).toThrow(InvalidError);
    expect(() => Probe.withExec([])).toThrow(InvalidError);
    expect(() => Probe.withExec(["true"], { intervalMs: 0 })).toThrow(InvalidError);
    const { fake, sandbox } = await started({
      "modal.entrypoint": "proc-1",
      "modal.probe": JSON.stringify({ tcpPort: 8000, intervalMs: 1 }),
    });
    fake.exitCodes([1, 1, 0]);
    await sandbox.waitUntilReady(5_000);
    expect(fake.calls.filter((c) => c.startsWith("exec"))).toEqual(
      Array(3).fill("exec bash -c exec 3<>/dev/tcp/127.0.0.1/8000"),
    );
    fake.exitCodes(Array(1000).fill(1));
    await expect(sandbox.waitUntilReady(20)).rejects.toBeInstanceOf(TimeoutError);
    await expect(sandbox.waitUntilReady(0)).rejects.toBeInstanceOf(InvalidError);
    const exec = await started({
      "modal.entrypoint": "proc-1",
      "modal.probe": JSON.stringify(Probe.withExec(["test", "-f", "/ready"]).spec),
    });
    await exec.sandbox.waitUntilReady();
    expect(exec.fake.calls).toContain("exec test -f /ready");
    const none = await started({ "modal.entrypoint": "proc-1" });
    await expect(none.sandbox.waitUntilReady()).rejects.toBeInstanceOf(InvalidError);
  });
  test("updateNetworkPolicy replaces the rules with what either list admits", async () => {
    const { fake, sandbox } = await started({ "modal.entrypoint": "proc-1" });
    await expect(
      sandbox.updateNetworkPolicy({ outboundDomainAllowlist: ["pypi.org"] }),
    ).rejects.toBeInstanceOf(InvalidError);
    await sandbox.updateNetworkPolicy({ outboundCidrAllowlist: [], outboundDomainAllowlist: [] });
    await sandbox.updateNetworkPolicy({
      outboundCidrAllowlist: ["0.0.0.0/0"],
      outboundDomainAllowlist: ["pypi.org"],
    });
    await sandbox.updateNetworkPolicy({
      outboundCidrAllowlist: ["10.0.0.0/8"],
      outboundDomainAllowlist: ["pypi.org"],
    });
    await expect(
      sandbox.updateNetworkPolicy({
        outboundCidrAllowlist: ["10.0.0.0/8"],
        outboundDomainAllowlist: ["*"],
      }),
    ).rejects.toBeInstanceOf(CompatibilityError);
    expect(fake.calls.filter((c) => c.startsWith("network"))).toEqual([
      `network ${JSON.stringify({ internet: false })}`,
      `network ${JSON.stringify({ internet: true, allow: ["pypi.org", "0.0.0.0/0"] })}`,
      `network ${JSON.stringify({ internet: true, allow: ["pypi.org", "10.0.0.0/8"] })}`,
    ]);
  });
  test("tunnels are HTTPS previews; there is no unencrypted socket", async () => {
    const { sandbox } = await started({ "modal.entrypoint": "proc-1" });
    const tunnel = (await sandbox.tunnels())[8000]!;
    expect(tunnel).toBeInstanceOf(Tunnel);
    expect(tunnel.url).toBe("https://8000-sbx-1.runtimehost.com");
    expect(tunnel.tlsSocket).toEqual(["8000-sbx-1.runtimehost.com", 443]);
    expect(tunnel.unencryptedHost).toBeUndefined();
    expect(() => tunnel.tcpSocket).toThrow(InvalidError);
  });
  test("names, reloads read-write volumes and refuses image mounts and connect tokens", async () => {
    const { fake, sandbox, modal } = await started({ "modal.entrypoint": "proc-1" });
    await sandbox.experimentalSetName("worker");
    expect(fake.info.name).toBe("app-worker");
    expect(fake.info.labels["modal.name"]).toBe("worker");
    await expect(sandbox.experimentalSetName("")).rejects.toBeInstanceOf(InvalidError);
    await expect(sandbox.reloadVolumes()).resolves.toBeUndefined();
    for (const call of [
      () => sandbox.createConnectToken(),
      () => sandbox.mountImage("/m"),
      () => sandbox.unmountImage("/m"),
      () => sandbox.snapshotDirectory("/d"),
      () => sandbox.experimentalGetExitSnapshot(),
      () => sandbox.experimentalUpdateOutboundPolicy(new ExperimentalOutboundPolicy()),
      () => sandbox.experimentalSidecars.create(),
    ])
      await expect(call()).rejects.toBeInstanceOf(CompatibilityError);
    expect(() => sandbox.logs.fetch({ since: new Date() })).toThrow(CompatibilityError);
    sandbox.detach();
    await expect(sandbox.exec(["true"])).rejects.toBeInstanceOf(ClientClosedError);
    modal.close();
  });
  test("filesystem snapshots become images that start new sandboxes", async () => {
    const { fake, sandbox, runtime, modal } = await started({ "modal.entrypoint": "proc-1" });
    const image = await sandbox.snapshotFilesystem({ ttlMs: 2 * 86_400_000 });
    expect(fake.calls.at(-1)).toBe(
      `snapshot ${JSON.stringify({ mode: "disk", retentionDays: 2 })}`,
    );
    await expect(sandbox.snapshotFilesystem({ ttlMs: null })).rejects.toBeInstanceOf(
      CompatibilityError,
    );
    await expect(sandbox.snapshotFilesystem({ ttlMs: 3_600_000 })).rejects.toBeInstanceOf(
      CompatibilityError,
    );
    await expect(modal.sandboxes.create(app, image, { cpu: 2 })).rejects.toBeInstanceOf(
      CompatibilityError,
    );
    await modal.sandboxes.create(app, image);
    const input = (runtime as unknown as { created: CreateSandbox[] }).created.at(-1)!;
    expect(input.snapshot).toBe("snap-1");
    expect(input.image).toBeUndefined();
    fake.snapshot = async () => {
      throw new RuntimeError({ message: "disk full", code: "snapshot_failed", status: 500 });
    };
    await expect(sandbox.snapshotFilesystem()).rejects.toBeInstanceOf(SnapshotCreationError);
  });
  test("memory snapshots restore the entrypoint under the same app", async () => {
    const { fake, sandbox, runtime, modal } = await started({
      "modal.entrypoint": "proc-1",
      "modal.tags": '{"a":"b"}',
    });
    const snapshot = await sandbox.experimentalSnapshot();
    expect(snapshot).toBeInstanceOf(SandboxSnapshot);
    expect(fake.calls.at(-1)).toContain('"modal.tags":"{\\"a\\":\\"b\\"}"');
    expect((await modal.sandboxSnapshots.fromId("snap-1")).snapshotId).toBe("snap-1");
    await expect(modal.sandboxSnapshots.fromId("gone")).rejects.toBeInstanceOf(NotFoundError);
    const restored = await modal.sandboxes.experimentalFromSnapshot(snapshot, { name: "copy" });
    expect(restored).toBeInstanceOf(Sandbox);
    const input = (runtime as unknown as { created: CreateSandbox[] }).created.at(-1)!;
    expect(input.snapshot).toBe("snap-1");
    expect(input.name).toBe("app-copy");
    await expect(
      modal.sandboxes.experimentalFromSnapshot(new SandboxSnapshot("disk")),
    ).rejects.toBeInstanceOf(InvalidError);
  });
  test("a restored snapshot without its entrypoint is stopped, not left running", async () => {
    const { fake, modal } = await started({ "modal.entrypoint": "proc-1" });
    fake.processes.get = async () => {
      throw new NativeNotFoundError({ message: "no process", code: "not_found", status: 404 });
    };
    await expect(
      modal.sandboxes.experimentalFromSnapshot(new SandboxSnapshot("snap-1")),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fake.calls.at(-1)).toBe("stop");
  });
  test("unknown sandboxes are NotFoundError; environments are refused", async () => {
    const { modal } = await started({ "modal.entrypoint": "proc-1" });
    await expect(modal.sandboxes.fromId("nope")).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      modal.sandboxes.fromName("app", "x", { environment: "dev" }),
    ).rejects.toBeInstanceOf(CompatibilityError);
    await expect(
      modal.sandboxes.experimentalList({ environment: "dev" }).next(),
    ).rejects.toBeInstanceOf(CompatibilityError);
  });
  test("file errors are Modal's filesystem errors", async () => {
    const { fake, sandbox } = await started({ "modal.entrypoint": "proc-1" });
    const fail = (code: string, status: number) => async () => {
      throw new RuntimeError({ message: code, code, status });
    };
    (fake.files as Record<string, unknown>).read = fail("is_a_directory", 400);
    await expect(sandbox.filesystem.readBytes("/etc")).rejects.toBeInstanceOf(
      SandboxFilesystemIsADirectoryError,
    );
    fake.files.readText = fail("file_not_found", 404);
    await expect(sandbox.filesystem.readText("/nope")).rejects.toBeInstanceOf(
      SandboxFilesystemNotFoundError,
    );
    fake.files.write = fail("permission_denied", 403);
    await expect(sandbox.filesystem.writeText("x", "/root/x")).rejects.toBeInstanceOf(
      SandboxFilesystemPermissionError,
    );
    fake.files.write = fail("service_unavailable", 503);
    await expect(sandbox.filesystem.writeText("x", "/x")).rejects.toBeInstanceOf(RuntimeError);
  });
  test("watch maps native events, honours its filter and stops the native watch", async () => {
    const { fake, sandbox } = await started({ "modal.entrypoint": "proc-1" });
    let seen: WatchOptions | undefined;
    let stopped = 0;
    fake.files.watch = async (_path: string, _cb: unknown, options: WatchOptions) => {
      seen = options;
      queueMicrotask(() => {
        const events: FileEvent[] = [
          { type: "create", path: "/w/a", isDir: false },
          { type: "write", path: "/w/a", isDir: false },
          { type: "rename", path: "/w/b", oldPath: "/w/a", isDir: false },
          { type: "remove", path: "/w/b", isDir: false },
        ];
        void options.onBatch!(events);
      });
      return { stop: async () => void stopped++ };
    };
    const got: unknown[] = [];
    for await (const event of sandbox.filesystem.watch("/w", {
      filter: ["Create", "Modify", "Remove"],
      recursive: true,
    })) {
      got.push(event);
      if (got.length === 4) break;
    }
    expect(got).toEqual([
      { eventType: "Create", paths: ["/w/a"] },
      { eventType: "Modify", paths: ["/w/a"] },
      { eventType: "Modify", paths: ["/w/a", "/w/b"] },
      { eventType: "Remove", paths: ["/w/b"] },
    ]);
    expect(seen!.recursive).toBe(true);
    expect(seen!.timeoutMs).toBe(0);
    expect(seen!.events).toEqual(["create", "write", "chmod", "rename", "remove"]);
    expect(stopped).toBe(1);
    const relative = sandbox.filesystem.watch("w")[Symbol.asyncIterator]();
    await expect(relative.next()).rejects.toBeInstanceOf(InvalidError);
  });
  test("watch ends when the native watch exits", async () => {
    const { fake, sandbox } = await started({ "modal.entrypoint": "proc-1" });
    fake.files.watch = async (_path: string, _cb: unknown, options: WatchOptions) => {
      queueMicrotask(() => {
        void options.onBatch!([{ type: "access", path: "/w/a", isDir: false }]);
        options.onExit!("timeout");
      });
      return { stop: async () => undefined };
    };
    const got: unknown[] = [];
    for await (const event of sandbox.filesystem.watch("/w", { timeoutMs: 10 })) got.push(event);
    expect(got).toEqual([{ eventType: "Access", paths: ["/w/a"] }]);
  });
});

test("an unused native sandbox type stays assignable", () => {
  // The fake covers what the adapter calls; this keeps the cast honest.
  const fake: unknown = fakeSandbox();
  expect((fake as NativeSandbox).id).toBe("sbx-1");
});
