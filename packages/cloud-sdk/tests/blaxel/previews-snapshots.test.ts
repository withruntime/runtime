import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ResponseError } from "../../src/blaxel/index";
import {
  NotSupportedError,
  SandboxInstance,
  SandboxPreview,
  Snapshot,
} from "../../src/blaxel/index";
import { BlaxelWorld, requests } from "./fake";

let world: BlaxelWorld;
const withruntime = () => ({ client: world.client() });
const create = (name = "my-sandbox") =>
  SandboxInstance.create({ name, withruntime: withruntime() });
const fake = (sandbox: SandboxInstance) => world.sandboxes.get(sandbox.withruntime.id)!;
const realFetch = globalThis.fetch;

beforeEach(() => {
  world = new BlaxelWorld();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("previews", () => {
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

  test("a token for the time asked, at least a minute; over a week is refused", async () => {
    const sandbox = await create();
    const preview = await sandbox.previews.create({
      metadata: { name: "p" },
      spec: { port: 3000 },
    });
    const token = await preview.tokens.create(new Date(Date.now() + 10 * 60 * 1000));
    expect(world.called("previews.get").at(-1)).toEqual([3000, 600]);
    expect(token.value).toBe("tok-3000-600");
    expect(token.expired).toBe(false);
    await preview.tokens.create(new Date(Date.now() + 5000));
    expect(world.called("previews.get").at(-1)).toEqual([3000, 60]);
    expect(
      await preview.tokens.create(new Date(Date.now() + 8 * 86_400_000)).catch((e: unknown) => e),
    ).toBeInstanceOf(NotSupportedError);
    expect(await preview.tokens.list().catch((e: unknown) => e)).toBeInstanceOf(NotSupportedError);
    await preview.tokens.delete("token-1");
    expect(world.called("previews.rotate")).toEqual([[3000]]);
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
