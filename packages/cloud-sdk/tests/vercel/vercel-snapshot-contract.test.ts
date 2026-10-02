import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Runtime } from "../../src/client.js";
import type { Snapshot as NativeSnapshot } from "../../src/snapshots.js";
import { Sandbox, Snapshot } from "../../src/vercel/index.js";
import { prepare } from "../../scripts/prepare-compatibility.js";
import type { CompatibilityLock } from "../../scripts/check-upstream.js";

const ID = "11111111-2222-4333-8444-555555555555";
const NOW = "2026-09-30T00:00:00.123Z";
const EXPIRES = "2026-10-07T00:00:00.000Z";
type ConsumerSandbox = {
  status: string;
  snapshot(opts?: { expiration?: number; signal?: AbortSignal }): Promise<{
    snapshotId: string;
    sourceSessionId: string;
    status: string;
    sizeBytes: number;
    regions: string[];
    createdAt: Date;
    updatedAt: Date;
    expiresAt?: Date;
  }>;
};

/** The exact consumer body is run against both implementations below. */
async function consumer(
  box: ConsumerSandbox,
  opts?: { expiration?: number; signal?: AbortSignal },
) {
  const taken = await box.snapshot(opts);
  return {
    id: taken.snapshotId,
    source: taken.sourceSessionId,
    status: taken.status,
    bytes: taken.sizeBytes,
    regions: taken.regions,
    created: taken.createdAt.valueOf(),
    updated: taken.updatedAt.valueOf(),
    expires: taken.expiresAt?.valueOf(),
    stopped: box.status === "stopped",
  };
}

async function deleteConsumer(taken: {
  snapshotId: string;
  status: string;
  delete(): Promise<unknown>;
}) {
  const result = await taken.delete();
  return { id: taken.snapshotId, status: taken.status, returnedVoid: result === undefined };
}

/** Actual native SDK, controlled HTTP. This does not run a Linux host or
 * establish crash consistency, cold-boot restoration or hosted vendor behavior. */
async function fixture(
  options: {
    returnedMode?: "memory" | "disk";
    fail?: boolean;
    stopFail?: boolean;
    pendingStop?: boolean;
    stopWaitFail?: boolean;
    stopWaitStaysPending?: boolean;
  } = {},
) {
  let info = {
    id: ID,
    name: "snapshot-contract",
    state: "running",
    labels: {},
    onLeaseEnd: "pause",
    vcpu: 2,
    memoryMiB: 4096,
    diskMiB: 4096,
    timeoutSeconds: 300,
    createdAt: NOW,
  };
  const snapshots = new Map<string, NativeSnapshot>();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let captureHook: ((signal: AbortSignal) => Promise<void>) | undefined;
  let wakeHook: (() => void) | undefined;
  let stopHook: ((signal: AbortSignal) => Promise<void>) | undefined;
  let holdWake: ((signal: AbortSignal) => Promise<void>) | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.hostname).toBe("vercel-snapshot.invalid");
    request.signal.throwIfAborted();
    const body = request.body ? ((await request.json()) as Record<string, unknown>) : {};
    calls.push({ path: url.pathname, body });
    if (url.pathname === `/v1/sandboxes/${ID}:pause`) info = { ...info, state: "paused" };
    else if (url.pathname === `/v1/sandboxes/${ID}:wake`) {
      await holdWake?.(request.signal);
      info = { ...info, state: "running" };
      wakeHook?.();
    } else if (url.pathname === `/v1/sandboxes/${ID}:stop`) {
      await stopHook?.(request.signal);
      if (options.stopFail)
        return Response.json(
          { error: { code: "stop_failed", message: "Stop failed" } },
          { status: 409 },
        );
      info = { ...info, state: options.pendingStop ? "stopping" : "stopped" };
    } else if (url.pathname === `/v1/sandboxes/${ID}:snapshot`) {
      expect(info.state).toBe("paused");
      await captureHook?.(request.signal);
      const snapshot: NativeSnapshot = {
        id: `snapshot-${snapshots.size}`,
        kind: "snapshot",
        mode: options.returnedMode ?? (body.mode === "disk" ? "disk" : "memory"),
        state: options.fail ? "failed" : "ready",
        status: options.fail ? "failed" : "ready",
        name: null,
        sourceSandboxId: ID,
        shape: { vcpu: 2, memoryMiB: 4096, diskMiB: 4096, memoryGuarantee: "fixed" },
        retentionDays: Number(body.retentionDays ?? 7),
        storedBytes: 1234,
        meteredBytes: 1234,
        backedUp: false,
        durability: { state: "none", durableAt: null, storedBytes: null },
        error: options.fail ? "Capture failed" : null,
        createdAt: NOW,
        readyAt: NOW,
        expiresAt: EXPIRES,
      };
      snapshots.set(snapshot.id, snapshot);
      return Response.json(snapshot);
    } else if (url.pathname.startsWith("/v1/snapshots/")) {
      const snapshot = snapshots.get(url.pathname.split("/").at(-1)!.split(":")[0]!);
      expect(snapshot).toBeDefined();
      if (url.pathname.endsWith(":delete")) snapshot!.state = "deleted";
      return Response.json(snapshot);
    } else if (
      url.pathname === `/v1/sandboxes/${ID}` &&
      url.searchParams.get("waitFor") === "stopped"
    ) {
      if (options.stopWaitFail)
        return Response.json(
          { error: { code: "wait_timeout", message: "Stop still pending" } },
          { status: 409 },
        );
      if (options.stopWaitStaysPending) return Response.json(info);
      info = { ...info, state: "stopped" };
    } else if (url.pathname !== `/v1/sandboxes/${ID}`)
      throw new Error(`Unexpected fixture request ${request.method} ${url.pathname}`);
    return Response.json(info);
  }) as typeof fetch;
  const client = () =>
    new Runtime({
      apiKey: "rtcloud_fixture",
      baseUrl: "https://vercel-snapshot.invalid",
      fetch: fetcher,
      maxRetries: 0,
    });
  const box = await Sandbox.get({ name: ID, withruntime: { client: client() } });
  calls.length = 0;
  return {
    box,
    client,
    snapshots,
    calls,
    state: () => info.state,
    hold: (hook: typeof captureHook) => {
      captureHook = hook;
    },
    onWake: (hook: typeof wakeHook) => {
      wakeHook = hook;
    },
    holdStop: (hook: typeof stopHook) => {
      stopHook = hook;
    },
    holdWake: (hook: typeof holdWake) => {
      holdWake = hook;
    },
  };
}

describe("Vercel filesystem snapshot contract", () => {
  test("captures disk only, awaits native mode validation, stops source and reconnects metadata", async () => {
    const f = await fixture();
    expect(await consumer(f.box, { expiration: 7 * 86_400_000 })).toEqual({
      id: "snapshot-0",
      source: ID,
      status: "created",
      bytes: 1234,
      regions: ["iad1"],
      created: Date.parse(NOW),
      updated: Date.parse(NOW),
      expires: Date.parse(EXPIRES),
      stopped: true,
    });
    const captured = f.calls.find((one) => one.path.endsWith(":snapshot"));
    expect(captured?.body).toEqual({ mode: "disk", retentionDays: 7 });
    expect(f.snapshots.get("snapshot-0")?.mode).toBe("disk");
    const reconnected = await Snapshot.get({
      snapshotId: "snapshot-0",
      withruntime: { client: f.client() },
    });
    expect([reconnected.snapshotId, reconnected.sourceSessionId, reconnected.sizeBytes]).toEqual([
      "snapshot-0",
      ID,
      1234,
    ]);
    expect(f.state()).toBe("stopped");
  });

  test("a server answering a memory capture cannot stop the source or return success", async () => {
    const f = await fixture({ returnedMode: "memory" });
    await expect(consumer(f.box)).rejects.toMatchObject({ code: "snapshot_mode_mismatch" });
    expect(f.calls.some((one) => one.path.endsWith(":stop"))).toBe(false);
    expect(f.state()).toBe("running");
  });

  test("failed capture restores the source and never stops it", async () => {
    const f = await fixture({ fail: true });
    await expect(consumer(f.box)).rejects.toMatchObject({ code: "snapshot_failed" });
    expect(f.calls.some((one) => one.path.endsWith(":stop"))).toBe(false);
    expect(f.state()).toBe("running");
  });

  test("pre-abort makes no capture, pause, wake or stop request", async () => {
    const f = await fixture();
    await expect(
      consumer(f.box, { signal: AbortSignal.abort(new Error("cancel before capture")) }),
    ).rejects.toThrow("cancel before capture");
    expect(f.calls).toEqual([]);
    expect(f.state()).toBe("running");
  });

  test("pre-abort never wakes a paused source", async () => {
    const f = await fixture();
    await f.box.withruntime.pause();
    f.calls.length = 0;
    await expect(
      consumer(f.box, { signal: AbortSignal.abort(new Error("cancel while paused")) }),
    ).rejects.toThrow("cancel while paused");
    expect(f.calls).toEqual([]);
    expect(f.state()).toBe("paused");
  });

  test("a deleted handle refuses capture without touching any resource", async () => {
    const f = await fixture();
    await f.box.delete();
    f.calls.length = 0;
    await expect(consumer(f.box)).rejects.toMatchObject({ response: { status: 410 } });
    expect(f.calls).toEqual([]);
  });

  test("cancellation while waking a paused source prevents capture", async () => {
    const f = await fixture();
    await f.box.withruntime.pause();
    f.calls.length = 0;
    const controller = new AbortController();
    let aborted = false;
    f.holdWake(async (signal) => {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, 100);
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            clearTimeout(timeout);
            reject(
              signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)),
            );
          },
          { once: true },
        );
        controller.abort(new Error("cancel during wake"));
      });
    });
    await expect(consumer(f.box, { signal: controller.signal })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(aborted).toBe(true);
    expect(
      f.calls.some((one) => one.path.endsWith(":snapshot") || one.path.endsWith(":stop")),
    ).toBe(false);
    expect(f.state()).toBe("paused");
  });

  test("does not report success while the captured source is still stopping", async () => {
    const f = await fixture({ pendingStop: true });
    expect(await consumer(f.box)).toMatchObject({ stopped: true });
    expect(f.state()).toBe("stopped");
    const stop = f.calls.findIndex((one) => one.path.endsWith(":stop"));
    expect(f.calls.slice(stop + 1).some((one) => one.path === `/v1/sandboxes/${ID}`)).toBe(true);
  });

  test("a source stop timeout preserves the captured disk without reporting success", async () => {
    const f = await fixture({ pendingStop: true, stopWaitFail: true });
    await expect(consumer(f.box)).rejects.toMatchObject({
      code: "wait_timeout",
      json: { error: { details: { snapshotId: "snapshot-0", sourceSandboxId: ID } } },
    });
    expect(f.snapshots.get("snapshot-0")?.mode).toBe("disk");
    expect(f.state()).toBe("stopping");
  });

  test("a terminal wait returning HTTP 200 while still stopping cannot claim success", async () => {
    const f = await fixture({ pendingStop: true, stopWaitStaysPending: true });
    await expect(consumer(f.box)).rejects.toMatchObject({
      code: "snapshot_source_stop_timeout",
      json: { error: { details: { snapshotId: "snapshot-0", sourceSandboxId: ID } } },
    });
    expect(f.snapshots.get("snapshot-0")?.mode).toBe("disk");
    expect(f.state()).toBe("stopping");
  });

  test("abort reaches an in-flight capture; cleanup restores source without stopping it", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let aborted = false;
    f.hold(async (signal) => {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, 100);
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            clearTimeout(timeout);
            reject(
              signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)),
            );
          },
          { once: true },
        );
        controller.abort(new Error("cancel during capture"));
      });
    });
    await expect(consumer(f.box, { signal: controller.signal })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(aborted).toBe(true);
    expect(f.calls.some((one) => one.path.endsWith(":stop"))).toBe(false);
    expect(f.state()).toBe("running");
  });

  test("abort after capture prevents the follow-up stop and preserves the disk snapshot", async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.onWake(() => controller.abort(new Error("cancel before stop")));
    await expect(consumer(f.box, { signal: controller.signal })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(f.calls.some((one) => one.path.endsWith(":stop"))).toBe(false);
    expect(f.snapshots.get("snapshot-0")?.mode).toBe("disk");
    expect(f.state()).toBe("running");
  });

  test("the follow-up stop receives the cancellation signal", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let aborted = false;
    f.holdStop(async (signal) => {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, 100);
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            clearTimeout(timeout);
            reject(
              signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)),
            );
          },
          { once: true },
        );
        controller.abort(new Error("cancel during stop"));
      });
    });
    await expect(consumer(f.box, { signal: controller.signal })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(aborted).toBe(true);
    expect(f.snapshots.get("snapshot-0")?.mode).toBe("disk");
  });

  test("stop failure preserves a completed disk snapshot without reporting success", async () => {
    const f = await fixture({ stopFail: true });
    await expect(consumer(f.box)).rejects.toMatchObject({
      code: "stop_failed",
      json: { error: { details: { snapshotId: "snapshot-0", sourceSandboxId: ID } } },
    });
    expect(f.snapshots.get("snapshot-0")?.mode).toBe("disk");
    expect(f.state()).toBe("running");
  });

  test("deleting a snapshot updates its existing handle from native metadata", async () => {
    const f = await fixture();
    const taken = await f.box.snapshot();
    await taken.delete();
    expect(taken.status).toBe("deleted");
    expect(taken.snapshotId).toBe("snapshot-0");
    expect(f.snapshots.get("snapshot-0")?.state).toBe("deleted");
  });
});

// Opt-in package comparison: no registry or vendor service is contacted. The
// cache is content-verified; installed runtime dependencies must match its pin.
const officialRoot = process.env.RUNTIME_VERCEL_SNAPSHOT_UPSTREAM;
const cacheRoot = process.env.RUNTIME_VERCEL_SNAPSHOT_CACHE;
test.skipIf(!officialRoot || !cacheRoot)(
  "unchanged snapshot consumer matches pinned Vercel package",
  async () => {
    const lock = JSON.parse(
      await readFile(new URL("../../compatibility-lock.json", import.meta.url), "utf8"),
    ) as CompatibilityLock;
    const pin = lock.providers
      .find((one) => one.id === "vercel")!
      .upstreams.find((one) => one.registry === "npm")!;
    // Refuse an absent cache before prepare can attempt a registry lookup.
    await readFile(
      join(
        cacheRoot!,
        "npm",
        `${encodeURIComponent(pin.name)}@${pin.version}`,
        ".runtime-contract-pin.json",
      ),
      "utf8",
    );
    const cache = await prepare(pin, cacheRoot!);
    const installed = resolve(officialRoot!, "node_modules", pin.name);
    const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    expect([pkg.name, pkg.version]).toEqual([pin.name, pin.version]);
    for (const file of ["dist/sandbox.js", "dist/session.js", "dist/snapshot.js"])
      expect(await readFile(join(installed, file), "utf8")).toBe(
        await readFile(join(cache, "package", file), "utf8"),
      );
    const { Sandbox: Official } = await import(
      pathToFileURL(join(installed, "dist/sandbox.js")).href
    );
    const { Snapshot: OfficialSnapshot } = await import(
      pathToFileURL(join(installed, "dist/snapshot.js")).href
    );
    const f = await fixture();
    let requested: { sessionId: string; expiration?: number } | undefined;
    const official = new Official({
      client: {
        createSnapshot: async (input: typeof requested) => {
          requested = input;
          return {
            json: {
              session: {
                id: ID,
                status: "stopped",
                createdAt: Date.parse(NOW),
                cwd: "/vercel/sandbox",
              },
              snapshot: {
                id: "snapshot-0",
                sourceSessionId: ID,
                status: "created",
                region: "iad1",
                regions: ["iad1"],
                sizeBytes: 1234,
                createdAt: Date.parse(NOW),
                updatedAt: Date.parse(NOW),
                expiresAt: Date.parse("2026-10-07T00:00:00.000Z"),
              },
            },
          };
        },
      },
      routes: [],
      session: { id: ID, status: "running", createdAt: Date.parse(NOW), cwd: "/vercel/sandbox" },
      sandbox: { name: "snapshot-contract", persistent: true },
    }) as ConsumerSandbox;
    const opts = { expiration: 7 * 86_400_000 };
    expect(await consumer(f.box, opts)).toEqual(await consumer(official, opts));
    expect<unknown>(requested).toEqual({
      sessionId: ID,
      expiration: opts.expiration,
      signal: undefined,
    });
    expect(f.calls.find((one) => one.path.endsWith(":snapshot"))?.body.mode).toBe("disk");
    const originalSnapshot = new OfficialSnapshot({
      snapshot: { id: "snapshot-0", status: "created" },
      client: {
        deleteSnapshot: async ({ snapshotId }: { snapshotId: string }) => {
          expect(snapshotId).toBe("snapshot-0");
          return { json: { snapshot: { id: snapshotId, status: "deleted" } } };
        },
      },
    });
    const nativeSnapshot = await Snapshot.get({
      snapshotId: "snapshot-0",
      withruntime: { client: f.client() },
    });
    expect(await deleteConsumer(nativeSnapshot)).toEqual(await deleteConsumer(originalSnapshot));
  },
);
