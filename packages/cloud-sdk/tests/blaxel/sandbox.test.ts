import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RuntimeError } from "../../src/errors";
import {
  NotSupportedError,
  ResponseError,
  SandboxInstance,
  imageRef,
  lifetimeOf,
  type SandboxCreateConfiguration,
} from "../../src/blaxel/index";
import { BlaxelWorld, requests } from "./fake";

let world: BlaxelWorld;
const withruntime = () => ({ client: world.client() });
const create = (config: SandboxCreateConfiguration = {}) =>
  SandboxInstance.create({ ...config, withruntime: { ...withruntime(), ...config.withruntime } });
const lastCreate = () => world.called("sandboxes.create").at(-1)![0] as Record<string, unknown>;
const fake = (sandbox: SandboxInstance) => world.sandboxes.get(sandbox.withruntime.id)!;
const DAY = 86_400_000;

beforeEach(() => {
  world = new BlaxelWorld();
});

describe("SandboxInstance.create", () => {
  test("Blaxel's defaults in one request: 4096 MB, 2 vCPUs, standby after a minute idle", async () => {
    const sandbox = await create();
    expect(lastCreate()).toEqual({
      vcpu: 2,
      memoryMiB: 4096,
      idlePauseSeconds: 60,
      autoWake: true,
      // No time limit: it runs while it works and pauses when idle (0300).
      onLeaseEnd: "pause",
      labels: { "blaxel/image": "blaxel/base-image:latest", "blaxel/memory": "4096" },
    });
    expect(requests(world, 0)).toEqual(["sandboxes.create"]);
    expect(sandbox.status).toBe("DEPLOYED");
    expect(sandbox.state).toBe("RUNNING");
    expect(sandbox.spec.runtime).toMatchObject({ image: "blaxel/base-image:latest", memory: 4096 });
    expect(sandbox.spec.region).toBe("us-was-1");
  });

  test("maps name, memory (one vCPU per 2048 MB), labels, externalId, network and region", async () => {
    const sandbox = await create({
      name: "my-sandbox",
      image: "blaxel/base-image:latest",
      memory: 8192,
      ports: [{ target: 3000, protocol: "HTTP" }],
      labels: { env: "dev", project: "my-project" },
      externalId: "session-abc-123",
      region: "us-pdx-1",
      network: { allowedDomains: ["pypi.org"], forbiddenDomains: ["evil.example"] },
    });
    expect(lastCreate()).toMatchObject({
      vcpu: 4,
      memoryMiB: 8192,
      name: "my-sandbox",
      labels: { env: "dev", project: "my-project", "blaxel/externalId": "session-abc-123" },
      network: { internet: true, allow: ["pypi.org"], deny: ["evil.example"] },
    });
    expect(world.called("images.list")).toEqual([]);
    expect(sandbox.metadata).toMatchObject({
      name: "my-sandbox",
      labels: { env: "dev", project: "my-project" },
      externalId: "session-abc-123",
    });
    expect(sandbox.spec.region).toBe("us-pdx-1");
    expect(sandbox.spec.runtime?.ports).toEqual([{ target: 3000, protocol: "HTTP" }]);
    await create({ memory: 1024 });
    expect(lastCreate()).toMatchObject({ vcpu: 1, memoryMiB: 1024 });
  });

  test("a fresh client reads what Blaxel keeps from the sandbox's labels, as the Python adapter writes them", async () => {
    await create({
      name: "labelled",
      image: "blaxel/py-app:latest",
      memory: 2048,
      ports: [{ target: 3000 }, { target: 8080, protocol: "HTTP" }],
      region: "us-pdx-1",
      ttl: "2d",
      lifecycle: { expirationPolicies: [{ type: "ttl-idle", value: "30m", action: "delete" }] },
    });
    expect(lastCreate().labels).toEqual({
      "blaxel/image": "blaxel/py-app:latest",
      "blaxel/memory": "2048",
      "blaxel/ports": "3000,8080",
      "blaxel/region": "us-pdx-1",
      "blaxel/ttl": "2d",
      "blaxel/lifecycle":
        '{"expirationPolicies":[{"type":"ttl-idle","value":"30m","action":"delete"}]}',
    });
    const fresh = await SandboxInstance.get("labelled", { withruntime: withruntime() });
    expect(fresh.metadata.labels).toEqual({});
    expect(fresh.spec).toMatchObject({
      region: "us-pdx-1",
      runtime: {
        image: "blaxel/py-app:latest",
        ports: [
          { target: 3000, protocol: "HTTP" },
          { target: 8080, protocol: "HTTP" },
        ],
        ttl: "2d",
      },
      lifecycle: { expirationPolicies: [{ type: "ttl-idle", value: "30m", action: "delete" }] },
    });
    await fresh.archive();
    const again = await SandboxInstance.get("labelled", { withruntime: withruntime() });
    expect([again.status, again.state]).toEqual(["ARCHIVED", "STANDBY"]);
    await again.unarchive();
    expect(again.status).toBe("DEPLOYED");
  });

  test("the network's proxy may carry allowed and forbidden domains; anything else of it is refused", async () => {
    await create({
      network: {
        allowedDomains: ["pypi.org"],
        proxy: { allowedDomains: ["github.com"], forbiddenDomains: ["evil.example"] },
      },
    });
    expect(lastCreate().network).toEqual({
      internet: true,
      allow: ["pypi.org", "github.com"],
      deny: ["evil.example"],
    });
    const error = await create({ network: { proxy: { routes: [] } } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotSupportedError);
    expect((error as Error).message).toContain("routes");
  });

  test("an image ns/name:tag is the ready Runtime image ns-name at that tag", async () => {
    expect(imageRef("blaxel/nextjs:latest")).toEqual({ name: "blaxel-nextjs", tag: "latest" });
    expect(imageRef("acme/tools/agent")).toEqual({ name: "acme-tools-agent", tag: "latest" });
    expect(imageRef("my-agent:v2")).toEqual({ name: "my-agent", tag: "v2" });
    expect(imageRef("localhost:5000/app")).toEqual({ name: "localhost:5000-app", tag: "latest" });
    world.images.push({ id: "img-9", name: "acme-agent", state: "ready", tags: ["v2"] } as never);
    await create({ image: "acme/agent:v2" });
    expect(world.called("images.resolve").at(-1)).toEqual(["acme-agent:v2"]);
    expect(lastCreate()).toMatchObject({
      image: "img-9",
      labels: { "blaxel/image": "acme/agent:v2" },
    });
    world.images.push({ id: "img-b", name: "acme-slow", state: "building" });
    const building = await create({ image: "acme/slow" }).catch((e: unknown) => e);
    expect(building).toBeInstanceOf(NotSupportedError);
  });

  test("a missing image says how to build it, under a name Runtime can hold", async () => {
    const missing = (await create({ image: "blaxel/nextjs:latest" }).catch(
      (e: unknown) => e,
    )) as NotSupportedError;
    expect(missing).toBeInstanceOf(NotSupportedError);
    expect(missing.feature).toBe("The image blaxel/nextjs:latest, which is not a Runtime image");
    expect(missing.alternative).toBe(
      'Build it as a Runtime image named blaxel-nextjs: `npx withruntime image build --dockerfile Dockerfile --name blaxel-nextjs -t blaxel-nextjs:latest`. The code can keep "blaxel/nextjs:latest": the adapter starts from blaxel-nextjs:latest.',
    );
    expect(missing.message).toStartWith(
      "The image blaxel/nextjs:latest, which is not a Runtime image, is not supported on Runtime. Build",
    );
    // A name Runtime could not hold is the same answer, never its name-rule error.
    expect(await create({ image: "localhost:5000/app" }).catch((e: unknown) => e)).toBeInstanceOf(
      NotSupportedError,
    );
    expect(world.called("sandboxes.create")).toEqual([]);
  });

  test("a Sandbox model (metadata and spec) creates the same sandbox", async () => {
    await SandboxInstance.create({
      metadata: { name: "model", labels: { a: "b" } },
      spec: { region: "us-was-1", runtime: { image: "blaxel/py-app:latest", memory: 2048 } },
      withruntime: withruntime(),
    });
    expect(lastCreate()).toMatchObject({
      name: "model",
      labels: { a: "b" },
      vcpu: 1,
      memoryMiB: 2048,
    });
  });

  test("envs are written once, root-owned, in the same round as nothing else", async () => {
    const sandbox = await create({
      envs: [
        { name: "NODE_ENV", value: "production" },
        { name: "QUOTE", value: "it's $HOME" },
      ],
    });
    expect(requests(world, 0)).toEqual(["sandboxes.create", "sandbox.exec"]);
    const [argv, options] = world.called("sandbox.exec")[0]!;
    expect(argv).toEqual([
      "bash",
      "-c",
      'sudo install -D -m 0640 -g "$(id -g)" /dev/stdin /etc/runtime-blaxel/env',
    ]);
    expect((options as { stdin: string }).stdin).toContain("export QUOTE='it'\\''s $HOME'");
    expect(JSON.stringify(argv)).not.toContain("production");
    expect(sandbox.spec.runtime?.envs).toEqual([
      { name: "NODE_ENV", value: "production" },
      { name: "QUOTE", value: "it's $HOME" },
    ]);
  });

  test("a paid sandbox is kept 365 days paused, or as long as its TTL says, never less", async () => {
    await create({ withruntime: { create: { funding: "paid" } } });
    expect(world.called("sandbox.retention").at(-1)![1]).toBe(365);
    await create({ ttl: "36h", withruntime: { create: { funding: "paid" } } });
    expect(world.called("sandbox.retention").at(-1)![1]).toBe(2);
    await create({
      lifecycle: { expirationPolicies: [{ type: "ttl-idle", value: "30m", action: "delete" }] },
      withruntime: { create: { funding: "paid" } },
    });
    expect(world.called("sandbox.retention").at(-1)![1]).toBe(1);
    expect(lastCreate()).toMatchObject({ onLeaseEnd: "pause" });
    expect(lastCreate()).not.toHaveProperty("timeoutSeconds");
  });

  test("the trial keeps its own retention: no call is made for it", async () => {
    await create({ ttl: "3d" });
    expect(world.called("sandbox.retention")).toEqual([]);
  });

  test("a TTL within the hour is a lease that ends the sandbox, never sooner", async () => {
    await create({ ttl: "30m" });
    expect(lastCreate()).toMatchObject({ timeoutSeconds: 1800, onLeaseEnd: "stop" });
    await create({ ttl: "10s" });
    expect(lastCreate()).toMatchObject({ timeoutSeconds: 60, onLeaseEnd: "stop" });
  });

  test("lifetimes: the soonest deadline wins and each rounds up to whole days", () => {
    expect(lifetimeOf({})).toEqual({ onLeaseEnd: "pause", days: 365 });
    expect(lifetimeOf({ ttl: "1w" }).days).toBe(7);
    expect(lifetimeOf({ ttl: "1h30m" })).toEqual({
      onLeaseEnd: "pause",
      days: 1,
    });
    expect(lifetimeOf({ expires: new Date(Date.now() + 2.5 * DAY) }).days).toBe(3);
    expect(
      lifetimeOf({
        ttl: "10d",
        lifecycle: {
          expirationPolicies: [
            { type: "ttl-max-age", value: "4d" },
            { type: "date", value: new Date(Date.now() + 20 * DAY).toISOString() },
          ],
        },
      }).days,
    ).toBe(4);
    expect(lifetimeOf({ ttl: "900d" }).days).toBe(365);
    expect(() => lifetimeOf({ ttl: "soon" })).toThrow(ResponseError);
    expect(() => lifetimeOf({ expires: new Date(Date.now() - 1000) })).toThrow(/past/);
  });

  test("images: Blaxel's stock ones are Runtime's stock image; others must be Runtime images", async () => {
    for (const image of [
      "blaxel/base-image",
      "blaxel/py-app:latest",
      "blaxel/ts-app",
      "blaxel/node",
      "blaxel/jupyter-server",
    ])
      await create({ image });
    expect(world.called("images.resolve")).toEqual([]);
    world.images.push({ id: "img-1", name: "my-agent-image", state: "ready" });
    await create({ image: "my-agent-image" });
    expect(lastCreate()).toMatchObject({ image: "img-1" });
  });

  test("refuses what it cannot honour, before creating anything", async () => {
    const saved = process.env.BL_REGION;
    const cases: Array<[SandboxCreateConfiguration, RegExp]> = [
      [{ region: "eu-lon-1" }, /eu-lon-1/],
      [{ extraArgs: { gpu: "yes" } }, /extra argument gpu/],
      [{ network: { proxy: { url: "http://p" } } }, /proxy's url/],
      [{ network: { subnet: "10.0.0.0/24" } }, /subnet/],
      [{ volumes: [{ name: "v", mountPath: "/data", readOnly: true }] }, /Read-only/],
      [
        { volumes: [{ name: "v", mountPath: "/data", type: "ephemeral", sizeMb: 10 }] },
        /Ephemeral/,
      ],
      [{ volumes: [{ name: "missing", mountPath: "/data" }] }, /volume create --name missing/],
      [{ envs: [{ name: "BAD-NAME", value: "x" }] }, /BAD-NAME/],
      [
        {
          lifecycle: {
            expirationPolicies: [{ type: "ttl-idle", value: "1h", action: "archive" as never }],
          },
        },
        /archive/,
      ],
    ];
    for (const [config, message] of cases) {
      const error = await create(config).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotSupportedError);
      expect((error as Error).message).toMatch(message);
      expect((error as NotSupportedError).alternative.length).toBeGreaterThan(0);
    }
    process.env.BL_REGION = "eu-fra-1";
    try {
      expect(await create().catch((e: unknown) => e)).toBeInstanceOf(NotSupportedError);
    } finally {
      if (saved === undefined) delete process.env.BL_REGION;
      else process.env.BL_REGION = saved;
    }
    expect(world.called("sandboxes.create")).toEqual([]);
  });

  test("a Runtime volume of that name is mounted at the mount path", async () => {
    world.volumes.push({ id: "vol-1", name: "data", state: "ready" });
    await create({ volumes: [{ name: "data", mountPath: "/blaxel/data" }] });
    expect(lastCreate()).toMatchObject({
      volumes: [{ volumeId: "vol-1", path: "/workspace/data" }],
    });
  });

  test("a name another live sandbox holds is refused with Blaxel's 409", async () => {
    await create({ name: "taken" });
    const error = (await create({ name: "taken" }).catch((e: unknown) => e)) as ResponseError;
    expect(error).toBeInstanceOf(ResponseError);
    expect([error.status, error.code, error.runtimeCode]).toEqual([409, 409, "name_taken"]);
  });

  test("a name held by a sandbox still stopping is waited for, then taken", async () => {
    const old = await create({ name: "reused" });
    fake(old).info.state = "stopping";
    const made = await create({ name: "reused" });
    expect(made.withruntime.id).not.toBe(old.withruntime.id);
    expect(world.called("sandbox.waitFor")).toEqual([[old.withruntime.id, "stopped"]]);
  });

  test("a failed setup ends the sandbox and throws", async () => {
    world.exec = () => ({ exitCode: 1, stderr: "sudo: no" });
    const error = await create({ envs: [{ name: "A", value: "1" }] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponseError);
    expect(world.called("sandbox.stop")).toHaveLength(1);
  });

  test("withruntime.create fields go over the adapter's", async () => {
    await create({ withruntime: { create: { vcpu: 8, funding: "trial" } } });
    expect(lastCreate()).toMatchObject({ vcpu: 8, funding: "trial", memoryMiB: 4096 });
  });
});

describe("createIfNotExists", () => {
  test("asks Runtime for the name with getOrCreate, and sets a new one up only once", async () => {
    const config = {
      name: "shared",
      envs: [{ name: "A", value: "1" }],
      withruntime: withruntime(),
    };
    const first = await SandboxInstance.createIfNotExists(config);
    const second = await SandboxInstance.createIfNotExists(config);
    expect(second.withruntime.id).toBe(first.withruntime.id);
    expect(
      world
        .called("sandboxes.create")
        .map(([input]) => (input as { getOrCreate?: boolean }).getOrCreate),
    ).toEqual([true, true]);
    expect(world.called("sandbox.exec")).toHaveLength(1);
  });

  test("two callers racing for one name both get the one sandbox", async () => {
    const config = { name: "race", withruntime: withruntime() };
    const [a, b] = await Promise.all([
      SandboxInstance.createIfNotExists(config),
      SandboxInstance.createIfNotExists(config),
    ]);
    expect(a.withruntime.id).toBe(b.withruntime.id);
    expect([...world.sandboxes.values()].filter((one) => one.info.name === "race")).toHaveLength(1);
  });

  test("without a name it simply creates", async () => {
    await SandboxInstance.createIfNotExists({ withruntime: withruntime() });
    expect(lastCreate().getOrCreate).toBeUndefined();
  });
});

describe("get, list, delete", () => {
  test("get finds a live sandbox by name in one request; a missing one is a 404", async () => {
    const made = await create({ name: "my-sandbox" });
    const from = world.calls.length;
    const found = await SandboxInstance.get("my-sandbox", { withruntime: withruntime() });
    expect(found.withruntime.id).toBe(made.withruntime.id);
    expect(requests(world, from)).toEqual(["sandboxes.list"]);
    const missing = (await SandboxInstance.get("nope", { withruntime: withruntime() }).catch(
      (e: unknown) => e,
    )) as ResponseError;
    expect(missing).toBeInstanceOf(ResponseError);
    expect([missing.status, missing.code]).toEqual([404, 404]);
  });

  test("getByExternalId and list({ externalId }) use the label", async () => {
    const made = await create({ externalId: "session-1" });
    await create({ externalId: "session-2" });
    const found = await SandboxInstance.getByExternalId("session-1", {
      withruntime: withruntime(),
    });
    expect(found.withruntime.id).toBe(made.withruntime.id);
    const page = await SandboxInstance.list(
      { externalId: "session-2" },
      { withruntime: withruntime() },
    );
    expect(page.data).toHaveLength(1);
    expect(world.called("sandboxes.list").at(-1)![0]).toEqual({
      labels: { "blaxel/externalId": "session-2" },
    });
  });

  test("list is Blaxel's paginated list: data, nextPage, for await, autoPagingToArray", async () => {
    for (let i = 0; i < 3; i++) await create({ name: `s${i}` });
    const page = await SandboxInstance.list({ limit: 2 }, { withruntime: withruntime() });
    expect(page.data.map((one) => one.metadata.name)).toEqual(["s0", "s1"]);
    expect(page.hasMore).toBe(true);
    const next = await page.nextPage();
    expect(next!.data.map((one) => one.metadata.name)).toEqual(["s2"]);
    expect(await next!.nextPage()).toBeNull();
    const names: string[] = [];
    for await (const one of page) names.push(one.metadata.name);
    expect(names).toEqual(["s0", "s1", "s2"]);
    expect((await page.autoPagingToArray({ limit: 2 })).length).toBe(2);
    for (const query of [
      { cursor: "x" },
      { sort: "name:asc" as const },
      { q: "s" },
      { status: "FAILED" },
    ])
      expect(
        await SandboxInstance.list(query, { withruntime: withruntime() }).catch((e: unknown) => e),
      ).toBeInstanceOf(NotSupportedError);
  });

  test("delete ends it at once; using it afterwards is a 404 without a request", async () => {
    const sandbox = await create({ name: "gone" });
    const model = await sandbox.delete();
    expect(model.status).toBe("DELETING");
    expect(world.called("sandbox.stop")).toEqual([[sandbox.withruntime.id, { wait: false }]]);
    const from = world.calls.length;
    const error = (await sandbox.process
      .exec({ command: "ls" })
      .catch((e: unknown) => e)) as ResponseError;
    expect(error.status).toBe(404);
    expect(await sandbox.fs.read("/x").catch((e: unknown) => (e as ResponseError).status)).toBe(
      404,
    );
    expect(requests(world, from)).toEqual([]);
    await create({ name: "gone2" });
    await SandboxInstance.delete("gone2", { withruntime: withruntime() });
    expect(world.called("sandbox.stop")).toHaveLength(2);
  });

  test("status and state: a paused sandbox is on standby", async () => {
    const sandbox = await create();
    fake(sandbox).info.state = "paused";
    expect([sandbox.status, sandbox.state]).toEqual(["DEPLOYED", "STANDBY"]);
    fake(sandbox).info.state = "stopped";
    expect(sandbox.status).toBe("TERMINATED");
  });

  test("archive pauses (keeping more than Blaxel's archive) and unarchive wakes", async () => {
    const sandbox = await create({ name: "arch" });
    await sandbox.archive();
    expect(sandbox.status).toBe("ARCHIVED");
    expect(world.called("sandbox.pause")).toHaveLength(1);
    await sandbox.unarchive();
    expect(sandbox.status).toBe("DEPLOYED");
    expect(world.called("sandbox.wake")).toHaveLength(1);
  });
});

describe("updates", () => {
  test("updateMetadata replaces the caller's labels and keeps the adapter's", async () => {
    const sandbox = await create({ name: "meta", externalId: "e1", labels: { a: "1" } });
    fake(sandbox).info.labels["blaxel/preview.app"] = "3000";
    const updated = await SandboxInstance.updateMetadata(
      "meta",
      { labels: { b: "2" }, displayName: "Nice" },
      { withruntime: withruntime() },
    );
    expect(world.called("sandbox.update").at(-1)![1]).toEqual({
      labels: {
        b: "2",
        "blaxel/image": "blaxel/base-image:latest",
        "blaxel/memory": "4096",
        "blaxel/externalId": "e1",
        "blaxel/preview.app": "3000",
        "blaxel/displayName": "Nice",
      },
    });
    expect(updated.metadata).toMatchObject({
      labels: { b: "2" },
      displayName: "Nice",
      externalId: "e1",
    });
  });

  test("updateTtl and updateLifecycle set a paid sandbox's retention; updateNetwork its rules", async () => {
    await create({ name: "ttl", withruntime: { create: { funding: "paid" } } });
    await SandboxInstance.updateTtl("ttl", "3d", { withruntime: withruntime() });
    expect(world.called("sandbox.retention").at(-1)![1]).toBe(3);
    await SandboxInstance.updateTtl("ttl", null, { withruntime: withruntime() });
    expect(world.called("sandbox.retention").at(-1)![1]).toBe(365);
    await SandboxInstance.updateLifecycle(
      "ttl",
      { expirationPolicies: [{ type: "ttl-idle", value: "2d" }] },
      { withruntime: withruntime() },
    );
    expect(world.called("sandbox.retention").at(-1)![1]).toBe(2);
    await SandboxInstance.updateNetwork(
      "ttl",
      { network: { allowedDomains: ["github.com"] } },
      { withruntime: withruntime() },
    );
    expect(world.called("network.set").at(-1)![1]).toEqual({
      internet: true,
      allow: ["github.com"],
    });
  });
});

describe("the live sandbox", () => {
  test("a time limit near its end (an older sandbox's hour) is renewed once, in the background", async () => {
    const sandbox = await create({ withruntime: { create: { timeoutSeconds: 3600 } } });
    fake(sandbox).info.expiresAt = new Date(Date.now() + 60_000).toISOString();
    fake(sandbox).fileMap.set("/workspace/a", new TextEncoder().encode("a"));
    await Promise.all([sandbox.fs.read("a"), sandbox.fs.read("a")]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(world.called("sandbox.extend")).toEqual([[sandbox.withruntime.id, 3600]]);
  });

  test("one with no time limit is never extended: it renews itself", async () => {
    const sandbox = await create();
    fake(sandbox).info.expiresAt = new Date(Date.now() + 60_000).toISOString();
    fake(sandbox).fileMap.set("/workspace/a", new TextEncoder().encode("a"));
    await sandbox.fs.read("a");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(world.called("sandbox.extend")).toEqual([]);
  });

  test("a sandbox paused with autoWake off is woken before the call", async () => {
    const sandbox = await create();
    Object.assign(fake(sandbox).info, { state: "paused", autoWake: false });
    fake(sandbox).fileMap.set("/workspace/a", new TextEncoder().encode("a"));
    expect(await sandbox.fs.read("/blaxel/a")).toBe("a");
    expect(world.called("sandbox.wake")).toHaveLength(1);
  });

  test("a call refused because the sandbox paused under it is made once more after a wake", async () => {
    const sandbox = await create();
    const runtime = fake(sandbox);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its sandbox below
    const files = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(runtime), "files")!.get!;
    let first = true;
    Object.defineProperty(runtime, "files", {
      get() {
        const base = files.call(runtime) as Record<string, unknown>;
        return {
          ...base,
          read: async (path: string) => {
            if (first) {
              first = false;
              runtime.info.state = "paused";
              throw new RuntimeError({ message: "paused", code: "sandbox_paused", status: 409 });
            }
            return (base.read as (p: string) => Promise<Uint8Array>)(path);
          },
        };
      },
    });
    runtime.fileMap.set("/workspace/b", new TextEncoder().encode("b"));
    expect(await sandbox.fs.read("b")).toBe("b");
    expect(world.called("sandbox.wake")).toHaveLength(1);
  });
});

afterEach(() => {
  world.readOnly = [];
});
