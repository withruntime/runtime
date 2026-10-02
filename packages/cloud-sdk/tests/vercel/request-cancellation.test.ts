/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- fakes reject with the abort signal's reason, exactly as fetch does. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Runtime } from "../../src/client.js";
import type { SandboxInfo } from "../../src/types.js";
import { Sandbox, Snapshot } from "../../src/vercel/index.js";
import { prepare } from "../../scripts/prepare-compatibility.js";
import type { CompatibilityLock } from "../../scripts/check-upstream.js";

const ID = "11111111-2222-4333-8444-555555555555";
const NOW = "2026-09-30T00:00:00.000Z";
function fixture(state: SandboxInfo["state"] = "running") {
  const info: SandboxInfo = {
    id: ID,
    kind: "sandbox",
    name: "cancellation",
    labels: {},
    status: "active",
    state,
    region: "us-east",
    funding: "trial",
    vcpu: 2,
    memoryMiB: 4096,
    diskMiB: 4096,
    cpu: "shared",
    cpuFloorMillis: 50,
    pausable: true,
    timeoutSeconds: 300,
    onLeaseEnd: "pause",
    createdAt: NOW,
    readyAt: NOW,
    expiresAt: "2026-09-30T00:05:00.000Z",
    endedAt: null,
    stopReason: null,
    pausedAt: null,
    pausedExpiresAt: null,
    chargedMicros: 0,
    heldMicros: 0,
  };
  const calls: Request[] = [];
  let hold: ((request: Request) => Promise<Response>) | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(new URL(request.url).hostname).toBe("vercel-cancellation.invalid");
    request.signal.throwIfAborted();
    calls.push(request);
    if (hold) return hold(request);
    const url = new URL(request.url);
    if (url.pathname === "/v1/sandboxes")
      return Response.json({ data: [info], nextCursor: "second" });
    if (url.pathname === "/v1/snapshots") return Response.json({ data: [], nextCursor: null });
    if (request.method === "GET" && url.pathname === `/v1/sandboxes/${ID}`)
      return Response.json(info);
    if (request.method === "GET" && url.pathname === `/v1/sandboxes/${ID}/processes/proc`)
      return Response.json({
        id: "proc",
        kind: "process",
        state: "running",
        command: "sleep infinity",
        cwd: "/workspace",
        startedAt: NOW,
        exitCode: null,
        endedAt: null,
        pty: false,
        stdinOpen: false,
        stdinOffset: 0,
        timeoutMs: null,
        outputBytes: 0,
        firstOffset: 0,
      });
    throw new Error(`Unexpected unheld fixture route ${request.method} ${url.pathname}`);
  }) as typeof fetch;
  const client = new Runtime({
    apiKey: "rtcloud_fixture",
    baseUrl: "https://vercel-cancellation.invalid",
    fetch: fetcher,
    maxRetries: 0,
  });
  return {
    client,
    calls,
    hold: (value: typeof hold) => {
      hold = value;
    },
  };
}

const cancellableOperations: {
  name: string;
  run: (box: Sandbox, signal: AbortSignal) => Promise<unknown>;
}[] = [
  { name: "attached command", run: (box, signal) => box.runCommand({ cmd: "true", signal }) },
  {
    name: "detached command",
    run: (box, signal) => box.runCommand({ cmd: "true", detached: true, signal }),
  },
  {
    name: "home link command",
    run: (box, signal) => box.runCommand({ cmd: "ls", args: ["/vercel/sandbox"], signal }),
  },
  { name: "command lookup", run: (box, signal) => box.getCommand("proc", { signal }) },
  { name: "directory creation", run: (box, signal) => box.mkDir("cancelled", { signal }) },
  {
    name: "file write",
    run: (box, signal) =>
      box.writeFiles(
        [
          { path: "first", content: "first", mode: 0o600 },
          { path: "second", content: "second" },
        ],
        { signal },
      ),
  },
  {
    name: "file read",
    run: (box, signal) => box.readFileToBuffer({ path: "cancelled" }, { signal }),
  },
];

for (const operation of cancellableOperations) {
  test(`pre-aborted ${operation.name} cannot wake or change a paused sandbox`, async () => {
    const f = fixture("paused");
    const box = await Sandbox.get({ name: ID, resume: false, withruntime: { client: f.client } });
    f.calls.length = 0;
    const reason = new Error("do not wake this guest");
    await expect(operation.run(box, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(f.calls).toHaveLength(0);
  });

  test(`in-flight ${operation.name} forwards cancellation before later effects`, async () => {
    const f = fixture();
    const box = await Sandbox.get({ name: ID, withruntime: { client: f.client } });
    f.calls.length = 0;
    const controller = new AbortController();
    f.hold(async (request) => {
      const aborted = new Promise<never>((_resolve, reject) =>
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        }),
      );
      controller.abort(new Error("cancel this request"));
      return aborted;
    });
    await expect(operation.run(box, controller.signal)).rejects.toBeDefined();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.signal.aborted).toBe(true);
  });
}

test("cancelled command kill does not signal the process and forwards in-flight cancellation", async () => {
  const f = fixture();
  const box = await Sandbox.get({ name: ID, withruntime: { client: f.client } });
  const command = await box.getCommand("proc");
  f.calls.length = 0;
  const reason = new Error("keep the process running");
  await expect(command.kill("SIGTERM", { abortSignal: AbortSignal.abort(reason) })).rejects.toBe(
    reason,
  );
  expect(f.calls).toHaveLength(0);
  const controller = new AbortController();
  f.hold(async (request) => {
    const aborted = new Promise<never>((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
    );
    controller.abort(reason);
    return aborted;
  });
  await expect(command.kill("SIGTERM", { abortSignal: controller.signal })).rejects.toBeDefined();
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.signal.aborted).toBe(true);
});

test("pre-aborted Vercel get/list and Snapshot.list perform no request", async () => {
  const f = fixture(),
    reason = new Error("caller cancelled"),
    signal = AbortSignal.abort(reason);
  for (const request of [
    () => Sandbox.get({ name: ID, signal, withruntime: { client: f.client } }),
    () => Sandbox.list({ signal, withruntime: { client: f.client } }),
    () => Snapshot.list({ name: "cancellation", signal, withruntime: { client: f.client } }),
  ]) {
    await expect(request()).rejects.toBe(reason);
    expect(f.calls).toHaveLength(0);
  }
});

test("pre-aborted update refuses all supported mutation fields before effects", async () => {
  const f = fixture(),
    box = await Sandbox.get({ name: ID, withruntime: { client: f.client } });
  f.calls.length = 0;
  const reason = new Error("do not change this guest"),
    signal = AbortSignal.abort(reason);
  await expect(
    box.update(
      {
        timeout: 600_000,
        ports: [8080],
        networkPolicy: "deny-all",
        snapshotExpiration: 86_400_000,
      },
      { signal },
    ),
  ).rejects.toBe(reason);
  expect(f.calls).toHaveLength(0);
});

test("in-flight update forwards cancellation and prevents later mutation steps", async () => {
  const f = fixture(),
    box = await Sandbox.get({ name: ID, withruntime: { client: f.client } });
  f.calls.length = 0;
  const controller = new AbortController(),
    reason = new Error("cancel update");
  f.hold(async (request) => {
    expect(request.signal.aborted).toBe(false);
    const aborted = new Promise<never>((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
    );
    controller.abort(reason);
    return aborted;
  });
  await expect(
    box.update(
      { networkPolicy: "deny-all", snapshotExpiration: 86_400_000, ports: [8080] },
      { signal: controller.signal },
    ),
  ).rejects.toBeDefined();
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.signal.aborted).toBe(true);
});

test("list cancellation survives a saved page and prevents its next request", async () => {
  const f = fixture(),
    controller = new AbortController();
  const page = await Sandbox.list({ signal: controller.signal, withruntime: { client: f.client } });
  expect(f.calls).toHaveLength(1);
  const pages = page.pages();
  await pages.next();
  controller.abort(new Error("finished listing"));
  await expect(pages.next()).rejects.toBeDefined();
  expect(f.calls).toHaveLength(1);
});

test("name lookup cancellation reaches every native cursor request", async () => {
  const f = fixture(),
    controller = new AbortController();
  let pages = 0;
  f.hold(async (request) => {
    const url = new URL(request.url);
    expect(url.pathname).toBe("/v1/sandboxes");
    pages++;
    if (pages === 1) return Response.json({ data: [], nextCursor: "second" });
    expect(url.searchParams.get("cursor")).toBe("second");
    const aborted = new Promise<never>((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
    );
    controller.abort(new Error("cancel second page"));
    return aborted;
  });
  await expect(
    Sandbox.get({
      name: "cancellation",
      signal: controller.signal,
      withruntime: { client: f.client },
    }),
  ).rejects.toBeDefined();
  expect(pages).toBe(2);
  expect(f.calls.every((request) => request.signal.aborted)).toBe(true);
});

// An installed, already verified official package is required. This opt-in
// oracle never downloads dependencies or contacts a vendor server.
const officialRoot = process.env.RUNTIME_VERCEL_SNAPSHOT_UPSTREAM;
const cacheRoot = process.env.RUNTIME_VERCEL_SNAPSHOT_CACHE;
test.skipIf(!officialRoot || !cacheRoot)(
  "unchanged update consumer forwards cancellation through pinned Vercel API",
  async () => {
    const lock = JSON.parse(
      await readFile(new URL("../../compatibility-lock.json", import.meta.url), "utf8"),
    ) as CompatibilityLock;
    const pin = lock.providers
      .find((provider) => provider.id === "vercel")
      ?.upstreams.find(
        (upstream) => upstream.registry === "npm" && upstream.name === "@vercel/sandbox",
      );
    if (!pin) throw new Error("Missing pinned Vercel oracle");
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
    const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect([pkg.name, pkg.version]).toEqual([pin.name, pin.version]);
    for (const file of ["dist/sandbox.js", "dist/session.js"])
      expect(await readFile(join(installed, file), "utf8")).toBe(
        await readFile(join(cache, "package", file), "utf8"),
      );
    type Consumer = {
      update(params: { ports: number[] }, options: { signal: AbortSignal }): Promise<void>;
    };
    const { Sandbox: Official } = (await import(
      pathToFileURL(join(installed, "dist/sandbox.js")).href
    )) as {
      Sandbox: new (params: {
        client: { updateSandbox(input: { signal?: AbortSignal }): Promise<never> };
        routes: [];
        session: { id: string; status: string; createdAt: number; cwd: string };
        sandbox: { name: string; persistent: boolean };
      }) => Consumer;
    };
    const reason = new Error("cancel unchanged consumer"),
      signal = AbortSignal.abort(reason);
    let propagated: AbortSignal | undefined;
    const official = new Official({
      client: {
        updateSandbox: async ({ signal }) => {
          propagated = signal;
          signal?.throwIfAborted();
          throw new Error("Oracle did not receive cancellation");
        },
      },
      routes: [],
      session: { id: ID, status: "running", createdAt: Date.parse(NOW), cwd: "/vercel/sandbox" },
      sandbox: { name: "cancel", persistent: true },
    });
    const f = fixture(),
      native = await Sandbox.get({ name: ID, withruntime: { client: f.client } });
    f.calls.length = 0;
    async function consumer(box: Consumer) {
      try {
        await box.update({ ports: [8080] }, { signal });
        return { refused: false, originalReason: false };
      } catch (error) {
        return { refused: true, originalReason: error === reason };
      }
    }
    expect(await consumer(native)).toEqual(await consumer(official));
    expect(propagated).toBe(signal);
    expect(f.calls).toHaveLength(0);
  },
);
