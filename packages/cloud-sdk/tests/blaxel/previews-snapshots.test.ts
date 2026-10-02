import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ResponseError, SandboxForkOptions } from "../../src/blaxel/index";
import {
  NotSupportedError,
  SandboxInstance,
  SandboxPreview,
  Snapshot,
} from "../../src/blaxel/index";
import { BlaxelWorld, requests } from "./fake";
import { Runtime } from "../../src/index";
import type { CreatePreview } from "../../src/products/previews";

let world: BlaxelWorld;
const withruntime = () => ({ client: world.client() });
const create = (name = "my-sandbox") =>
  SandboxInstance.create({ name, withruntime: withruntime() });
const fake = (sandbox: SandboxInstance) => world.sandboxes.get(sandbox.withruntime.id)!;
const realFetch = globalThis.fetch;

async function previewWithNativeReply(sandbox: SandboxInstance, reply: (url: URL) => Response) {
  const seen: URL[] = [];
  const client = new Runtime({
    apiKey: "rtcloud_key",
    baseUrl: "https://api.example.test",
    fetch: (async (input: string) => {
      const url = new URL(input);
      if (!url.pathname.endsWith("/previews/3000")) return Response.json(fake(sandbox).info);
      seen.push(url);
      return reply(url);
    }) as typeof fetch,
  });
  const runtime = await client.sandboxes.get(sandbox.withruntime.id);
  const preview = new SandboxPreview(
    { metadata: { name: "p" }, spec: { port: 3000 } },
    {
      sandboxName: sandbox.name,
      run: (work) => work(runtime),
      labels: () => ({}),
      setLabels: () => Promise.resolve(),
    },
  );
  return { preview, seen };
}

beforeEach(() => {
  world = new BlaxelWorld();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("previews", () => {
  test("a typed native create forwards its absolute deadline and optional relative TTL", async () => {
    const sandbox = await create();
    const expiresAt = new Date(Date.now() + 600_999).toISOString();
    const bodies: unknown[] = [];
    const client = new Runtime({
      apiKey: "rtcloud_key",
      baseUrl: "https://api.example.test",
      fetch: (async (input: string, init: RequestInit = {}) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/previews") && init.method === "POST") {
          bodies.push(JSON.parse(init.body as string));
          return Response.json({ token: "deadline-token", tokenExpiresAt: expiresAt });
        }
        return Response.json(fake(sandbox).info);
      }) as typeof fetch,
    });
    const runtime = await client.sandboxes.get(sandbox.withruntime.id);
    const exact = { visibility: "private", expiresAt } satisfies CreatePreview;
    await runtime.previews.create(3000, exact);
    const bounded = { ...exact, ttlSeconds: 300 } satisfies CreatePreview;
    await runtime.previews.create(3000, bounded);
    expect(bodies).toEqual([
      { port: 3000, visibility: "private", expiresAt },
      { port: 3000, visibility: "private", expiresAt, ttlSeconds: 300 },
    ]);
  });

  test("a private preview: shared by port, named in a label, its address without a trailing slash", async () => {
    const sandbox = await create();
    const from = world.calls.length;
    const preview = await sandbox.previews.createIfNotExists({
      metadata: { name: "private-preview" },
      spec: { port: 3000, public: false },
    });
    expect(requests(world, from).sort()).toEqual(["previews.create", "sandbox.update"]);
    expect(world.called("previews.create")[0]).toEqual([3000, { visibility: "private" }]);
    expect(fake(sandbox).info.labels["blaxel/preview.private-preview"]).toBe("3000");
    expect(preview).toBeInstanceOf(SandboxPreview);
    expect(preview.name).toBe("private-preview");
    expect(preview.spec).toEqual({
      port: 3000,
      public: false,
      url: `https://3000-${sandbox.withruntime.id.replaceAll("-", "")}.runtimehost.com`,
    });
    expect(sandbox.metadata.labels).toEqual({});
  });

  test("unsafe token expirations refuse before any native token request", async () => {
    const sandbox = await create();
    const preview = await sandbox.previews.create({
      metadata: { name: "p" },
      spec: { port: 3000 },
    });
    const now = Date.now();
    const from = world.calls.length;
    for (const delta of [-1000, 0, 5000, 59_999, 8 * 86_400_000]) {
      await expect(preview.tokens.create(new Date(now + delta))).rejects.toMatchObject({
        code: "not_supported",
        feature: "A preview token lasting less than a minute or more than a week",
      });
      expect(world.calls).toHaveLength(from);
    }
    await expect(preview.tokens.create(new Date(Number.NaN))).rejects.toMatchObject({
      status: 400,
    });
    expect(world.calls).toHaveLength(from);
    expect(await preview.tokens.list().catch((e: unknown) => e)).toBeInstanceOf(NotSupportedError);
    await preview.tokens.delete("token-1");
    expect(world.called("previews.rotate")).toEqual([[3000]]);
  });

  test("absolute token deadlines use the native query and preserve earlier session caps", async () => {
    const sandbox = await create();
    const requested = new Date(Date.now() + 600_999);
    let issued = Math.floor(requested.getTime() / 1000) * 1000;
    const { preview, seen } = await previewWithNativeReply(sandbox, () =>
      Response.json({ token: "deadline-token", tokenExpiresAt: new Date(issued).toISOString() }),
    );
    const token = await preview.tokens.create(requested);
    expect(token.value).toBe("deadline-token");
    expect(token.expiresAt).toBe(new Date(issued).toISOString());
    expect(seen[0]!.searchParams.get("expiresAt")).toBe(requested.toISOString());
    expect(seen[0]!.searchParams.has("ttlSeconds")).toBe(false);
    issued -= 60_000;
    expect((await preview.tokens.create(requested)).expiresAt).toBe(new Date(issued).toISOString());
  });

  test("old-server rejection and unsafe native expiry never trigger a duration fallback", async () => {
    const sandbox = await create();
    const requested = new Date(Date.now() + 600_999);
    for (const mode of ["old-server", "extended", "invalid", "no-token"] as const) {
      const { preview, seen } = await previewWithNativeReply(sandbox, () => {
        if (mode === "old-server")
          return Response.json(
            { error: { code: "invalid_request", message: "Unknown query field: expiresAt" } },
            { status: 400 },
          );
        return Response.json({
          token: mode === "no-token" ? null : "must-not-be-returned",
          tokenExpiresAt:
            mode === "invalid" ? "bad-date" : new Date(requested.getTime() + 1000).toISOString(),
        });
      });
      await expect(preview.tokens.create(requested)).rejects.toMatchObject(
        mode === "old-server" ? { status: 400 } : { code: "not_supported" },
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]!.searchParams.get("expiresAt")).toBe(requested.toISOString());
      expect(seen[0]!.searchParams.has("ttlSeconds")).toBe(false);
    }
  });

  test("get, list and delete by name, from a fresh client too", async () => {
    const sandbox = await create();
    await sandbox.previews.create({
      metadata: { name: "app-preview" },
      spec: { port: 3000, public: true },
    });
    await sandbox.withruntime.previews.create(8080, { visibility: "private" });
    const fresh = await SandboxInstance.get("my-sandbox", { withruntime: withruntime() });
    expect((await fresh.previews.get("app-preview")).spec.public).toBe(true);
    expect((await fresh.previews.list()).map((one) => one.name).sort()).toEqual([
      "app-preview",
      "preview-8080",
    ]);
    const deleted = await fresh.previews.delete("app-preview");
    expect(deleted).toMatchObject({
      metadata: { name: "app-preview" },
      spec: { port: 3000 },
      status: "DELETING",
    });
    expect(world.called("previews.delete")).toEqual([[3000]]);
    expect("blaxel/preview.app-preview" in fake(sandbox).info.labels).toBe(false);
    const missing = (await fresh.previews
      .get("app-preview")
      .catch((e: unknown) => e)) as ResponseError;
    expect(missing.status).toBe(404);
  });

  test("createIfNotExists answers the existing preview without making another", async () => {
    const sandbox = await create();
    const spec = { metadata: { name: "same" }, spec: { port: 3000 } };
    await sandbox.previews.createIfNotExists(spec);
    await sandbox.previews.createIfNotExists(spec);
    expect(world.called("previews.create")).toHaveLength(1);
  });

  test("what a Runtime preview cannot do is refused before anything is shared", async () => {
    const sandbox = await create();
    for (const spec of [
      { port: 3000, prefixUrl: "my-prefix" },
      { port: 443, customDomain: "your.custom.domain.dev" },
      { port: 3000, responseHeaders: { "Access-Control-Allow-Origin": "*" } },
      { port: 3000, requestHeaders: { a: "b" } },
      { port: 3000, ttl: "1h" },
    ]) {
      const error = await sandbox.previews
        .create({ metadata: { name: "x" }, spec })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotSupportedError);
    }
    expect(
      (
        (await sandbox.previews
          .create({ metadata: { name: "x" }, spec: {} })
          .catch((e: unknown) => e)) as ResponseError
      ).status,
    ).toBe(400);
    expect(world.called("previews.create")).toEqual([]);
  });

  test("sandbox.fetch reaches the port through a private preview, made once and reused", async () => {
    const sandbox = await create();
    const seen: Array<[string, string | null]> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push([url, new Headers(init?.headers).get("x-runtime-preview-token")]);
      return new Response('{"ok":true}');
    }) as typeof fetch;
    const response = await sandbox.fetch(3000);
    expect(await response.text()).toBe('{"ok":true}');
    await sandbox.fetch(3000, "api/health", { headers: { accept: "application/json" } });
    expect(world.called("previews.get")).toHaveLength(1);
    expect(world.called("previews.create")).toEqual([[3000, { ttlSeconds: 3600 }]]);
    const base = `https://3000-${sandbox.withruntime.id.replaceAll("-", "")}.runtimehost.com`;
    expect(seen).toEqual([
      [`${base}/`, "tok-3000-3600"],
      [`${base}/api/health`, "tok-3000-3600"],
    ]);
  });
});

describe("snapshots and forks", () => {
  test("sandbox.snapshots: create keeps it a year and carries only the caller's labels", async () => {
    const sandbox = await SandboxInstance.create({
      name: "my-sandbox",
      labels: { team: "a" },
      externalId: "e1",
      withruntime: withruntime(),
    });
    const snapshot = await sandbox.snapshots.create("my-snapshot");
    expect(world.called("sandbox.snapshot").at(-1)![1]).toEqual({
      name: "my-snapshot",
      labels: { team: "a" },
      retentionDays: 365,
    });
    expect(snapshot).toBeInstanceOf(Snapshot);
    expect([snapshot.name, snapshot.status, snapshot.source?.name]).toEqual([
      "my-snapshot",
      "READY",
      "my-sandbox",
    ]);
    expect((await sandbox.snapshots.list()).map((one) => one.name)).toEqual(["my-snapshot"]);
    expect((await sandbox.snapshots.get("my-snapshot")).id).toBe(snapshot.id);
    expect(await sandbox.snapshots.restore("my-snapshot").catch((e: unknown) => e)).toBeInstanceOf(
      NotSupportedError,
    );
    await sandbox.snapshots.delete("my-snapshot");
    expect(world.called("snapshots.delete")).toEqual([[snapshot.id]]);
    expect(
      ((await sandbox.snapshots.get("my-snapshot").catch((e: unknown) => e)) as ResponseError)
        .status,
    ).toBe(404);
  });

  test("fork copies the sandbox live; envs are added over the source's; labels are the caller's", async () => {
    const sandbox = await SandboxInstance.create({
      name: "my-sandbox",
      labels: { team: "a" },
      externalId: "e1",
      withruntime: withruntime(),
    });
    const result = await sandbox.fork("my-sandbox-copy", {
      envs: [{ name: "NODE_ENV", value: "staging" }],
    });
    expect(result).toEqual({ name: "my-sandbox-copy", snapshotId: "", type: "sandbox" });
    expect(world.called("sandbox.fork").at(-1)![1]).toEqual({
      name: "my-sandbox-copy",
      labels: { team: "a" },
    });
    const [argv, options] = world.called("sandbox.exec").at(-1)!;
    expect((argv as string[])[2]).toContain("cat >> /etc/runtime-blaxel/env");
    expect((options as { stdin: string }).stdin).toContain("export NODE_ENV='staging'");
  });

  test("fork from a snapshot by name starts a new sandbox from it", async () => {
    const sandbox = await create();
    const snapshot = await sandbox.snapshots.create("my-snapshot");
    const result = await sandbox.fork("my-sandbox-copy", {
      targetType: "sandbox",
      snapshotId: "my-snapshot",
    });
    expect(result).toEqual({ name: "my-sandbox-copy", snapshotId: snapshot.id, type: "sandbox" });
    expect(world.called("sandboxes.create").at(-1)![0]).toMatchObject({
      snapshot: snapshot.id,
      name: "my-sandbox-copy",
      idlePauseSeconds: 60,
      autoWake: true,
      onLeaseEnd: "pause",
    });
    expect(
      await sandbox.fork("app", { targetType: "application" }).catch((e: unknown) => e),
    ).toBeInstanceOf(NotSupportedError);
  });

  test("sandbox and snapshot forks preserve environment names matching object properties", async () => {
    const sandbox = await create();
    const snapshot = await sandbox.snapshots.create("environment-snapshot");
    const envs = [
      { name: "__proto__", value: "literal-prototype-name" },
      { name: "constructor", value: "literal-constructor-name" },
      { name: "NORMAL", value: "first" },
      { name: "NORMAL", value: "last" },
    ];
    const forks = [
      () => sandbox.fork("environment-copy", { envs }),
      () => sandbox.fork("environment-snapshot-copy", { envs, snapshotId: snapshot.id }),
      () => snapshot.fork("environment-direct-copy", { envs }),
    ];
    for (const fork of forks) {
      const from = world.called("sandbox.exec").length;
      await fork();
      expect(world.called("sandbox.exec")).toHaveLength(from + 1);
      const [, options] = world.called("sandbox.exec").at(-1)!;
      const stdin = (options as { stdin: string }).stdin;
      expect(stdin).toContain("export __proto__='literal-prototype-name'");
      expect(stdin).toContain("export constructor='literal-constructor-name'");
      expect(stdin).toContain("export NORMAL='last'");
      expect(stdin).not.toContain("export NORMAL='first'");
    }
  });

  test("fork lifecycle overrides refuse before any lookup, clone or snapshot creation", async () => {
    const sandbox = await create();
    const from = world.calls.length;
    for (const options of [
      { lifecycle: {} },
      { lifecycle: { expirationPolicies: [{ type: "ttl-max-age", value: "1d" }] } },
      { lifecycle: {}, snapshotId: "must-not-be-looked-up" },
    ] satisfies SandboxForkOptions[]) {
      const error: unknown = await sandbox
        .fork("must-not-be-created", options)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(NotSupportedError);
      expect(error).toMatchObject({
        alternative: "Omit lifecycle to use the existing Runtime fork behavior.",
      });
      expect(world.calls).toHaveLength(from);
    }
  });

  test("an omitted fork lifecycle keeps the existing native fork behavior", async () => {
    const sandbox = await create();
    const result = await sandbox.fork("inherited-copy", { lifecycle: undefined });
    expect(result).toEqual({ name: "inherited-copy", snapshotId: "", type: "sandbox" });
    expect(world.called("sandbox.fork").at(-1)![1]).toEqual({
      name: "inherited-copy",
      labels: {},
    });
  });

  test("Snapshot.create, get, list, fork and delete", async () => {
    await create();
    const snapshot = await Snapshot.create(
      { name: "my-snapshot", source: { name: "my-sandbox" } },
      { withruntime: withruntime() },
    );
    expect((await Snapshot.get(snapshot.id, { withruntime: withruntime() })).name).toBe(
      "my-snapshot",
    );
    const names: string[] = [];
    for await (const one of await Snapshot.list({ limit: 50 }, { withruntime: withruntime() }))
      names.push(one.name);
    expect(names).toEqual(["my-snapshot"]);
    expect(await snapshot.fork("my-new-sandbox")).toEqual({
      name: "my-new-sandbox",
      snapshotId: snapshot.id,
      type: "sandbox",
    });
    await Snapshot.delete(snapshot.id, { withruntime: withruntime() });
    expect(world.snapshotList).toEqual([]);
  });

  test("the deprecated snapshot methods answer Blaxel's SandboxSnapshot", async () => {
    const sandbox = await create();
    const taken = await sandbox.snapshot("old-style");
    expect(taken).toMatchObject({ name: "old-style", status: "READY", sandboxName: "my-sandbox" });
    expect((await sandbox.listSnapshots()).map((one) => one.name)).toEqual(["old-style"]);
    await sandbox.deleteSnapshot("old-style");
    expect(world.snapshotList).toEqual([]);
  });
});
