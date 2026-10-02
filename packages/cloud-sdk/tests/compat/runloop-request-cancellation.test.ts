/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- fakes reject with the abort signal's reason, exactly as fetch does. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Runtime } from "../../src/client.js";
import { Runloop } from "../../src/runloop/index.js";
import type { ProcessInfo, SandboxInfo } from "../../src/types.js";
import { create as createCompat, destroy } from "../../src/compat/core.js";
import { prepare } from "../../scripts/prepare-compatibility.js";
import type { CompatibilityLock } from "../../scripts/check-upstream.js";

const ID = "11111111-2222-4333-8444-555555555555";
const NOW = "2026-09-30T00:00:00.000Z";
function fixture(ownership: Pick<SandboxInfo, "replayed" | "reused" | "persistent"> = {}) {
  let info: SandboxInfo = {
    id: ID,
    kind: "sandbox",
    name: "cancel",
    labels: {},
    status: "active",
    state: "running",
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
    ...ownership,
  };
  const calls: Request[] = [];
  let hook: ((request: Request) => Promise<Response | undefined>) | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    expect(url.hostname).toBe("runloop-cancellation.invalid");
    request.signal.throwIfAborted();
    calls.push(request);
    const intercepted = await hook?.(request);
    if (intercepted) return intercepted;
    if (request.method === "POST" && url.pathname === "/v1/sandboxes") return Response.json(info);
    if (request.method === "GET" && url.pathname === `/v1/sandboxes/${ID}`)
      return Response.json(info);
    if (request.method === "PUT" && url.pathname.endsWith("/files/content"))
      return new Response(null, { status: 204 });
    if (url.pathname === `/v1/sandboxes/${ID}:stop`) {
      info = { ...info, state: "stopped", status: "stopped" };
      return Response.json(info);
    }
    if (url.pathname === `/v1/sandboxes/${ID}:update`) {
      const body = (await request.json()) as Partial<Pick<SandboxInfo, "persistent" | "labels">>;
      info = { ...info, ...body };
      return Response.json(info);
    }
    throw new Error(`Unexpected fixture request ${request.method} ${url.pathname}`);
  }) as typeof fetch;
  const runtime = new Runtime({
    apiKey: "rtcloud_fixture",
    baseUrl: "https://runloop-cancellation.invalid",
    fetch: fetcher,
    maxRetries: 0,
  });
  return {
    client: new Runloop({ client: runtime }),
    runtime,
    get info() {
      return info;
    },
    calls,
    intercept: (value: typeof hook) => {
      hook = value;
    },
  };
}

test("pre-aborted Runloop create allocates nothing and preserves the caller reason", async () => {
  const f = fixture(),
    reason = new Error("no allocation"),
    signal = AbortSignal.abort(reason);
  await expect(
    f.client.devboxes.create(
      { name: "cancel", file_mounts: { "/workspace/example": "never" } },
      { signal },
    ),
  ).rejects.toBe(reason);
  expect(f.calls).toHaveLength(0);
});

test("pre-aborted Runloop retrieve and execution requests perform no reads or mutations", async () => {
  const f = fixture(),
    reason = new Error("no execution"),
    signal = AbortSignal.abort(reason);
  for (const operation of [
    () => f.client.devboxes.retrieve(ID, { signal }),
    () =>
      f.client.devboxes.executions.executeSync(
        ID,
        { command: "touch /workspace/side-effect" },
        { signal },
      ),
    () =>
      f.client.devboxes.executions.executeAsync(
        ID,
        { command: "touch /workspace/side-effect" },
        { signal },
      ),
    () => f.client.devboxes.executions.awaitCompleted(ID, "execution", { signal }),
  ]) {
    await expect(operation()).rejects.toBe(reason);
    expect(f.calls).toHaveLength(0);
  }
});

test("in-flight Runloop allocation forwards cancellation without starting initialization", async () => {
  const f = fixture(),
    controller = new AbortController();
  f.intercept(async (request) => {
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/v1/sandboxes");
    const aborted = new Promise<never>((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
    );
    controller.abort(new Error("cancel allocation"));
    return aborted;
  });
  await expect(f.client.devboxes.create({}, { signal: controller.signal })).rejects.toBeDefined();
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.signal.aborted).toBe(true);
});

test("execution lookup cancellation settles before any process or environment request", async () => {
  for (const mode of ["sync", "async"] as const) {
    const f = fixture(),
      controller = new AbortController();
    f.intercept(async (request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe(`/v1/sandboxes/${ID}`);
      const aborted = new Promise<never>((_resolve, reject) =>
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        }),
      );
      controller.abort(new Error("cancel lookup"));
      return aborted;
    });
    const executions = f.client.devboxes.executions;
    await expect(
      mode === "sync"
        ? executions.executeSync(ID, { command: "echo never" }, { signal: controller.signal })
        : executions.executeAsync(ID, { command: "echo never" }, { signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(f.calls).toHaveLength(1);
  }
});

test("cancellation during file setup retains the remote sandbox without destructive rollback", async () => {
  const f = fixture(),
    controller = new AbortController();
  f.intercept(async (request) => {
    const url = new URL(request.url);
    if (url.searchParams.get("path") !== "/workspace/setup") return;
    const aborted = new Promise<never>((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
    );
    controller.abort(new Error("cancel setup"));
    return aborted;
  });
  await expect(
    f.client.devboxes.create(
      { file_mounts: { "/workspace/setup": "contents", "/workspace/later": "never" } },
      { signal: controller.signal },
    ),
  ).rejects.toBeDefined();
  expect(
    f.calls.filter(
      (request) => new URL(request.url).searchParams.get("path") === "/workspace/later",
    ),
  ).toHaveLength(0);
  const stopped = f.calls.filter((request) => new URL(request.url).pathname.endsWith(":stop"));
  expect(stopped).toHaveLength(0);
  expect(
    f.calls.filter((request) => new URL(request.url).pathname.endsWith(":update")),
  ).toHaveLength(0);
  expect(f.info.state).toBe("running");
});

test("cancellation observed immediately after allocation retains the returned remote sandbox", async () => {
  const f = fixture({ replayed: true, persistent: true }),
    controller = new AbortController(),
    reason = new Error("cancel after allocation");
  const allocate = f.runtime.sandboxes.create.bind(f.runtime.sandboxes);
  // This local SDK instance returns a real decoded response, then observes the
  // cancellation race before the compatibility helper receives that handle.
  f.runtime.sandboxes.create = async (input, options) => {
    const sandbox = await allocate(input, options);
    controller.abort(reason);
    return sandbox;
  };
  await expect(
    createCompat(f.runtime, "runloop", {}, undefined, undefined, { signal: controller.signal }),
  ).rejects.toBe(reason);
  expect(f.calls).toHaveLength(1);
  expect(f.info).toMatchObject({ state: "running", persistent: true });
});

test("held environment initialization forwards abort and never stops or releases the guest", async () => {
  const f = fixture({ persistent: true }),
    controller = new AbortController();
  f.intercept(async (request) => {
    if (
      new URL(request.url).searchParams.get("path") !==
      "/workspace/.runtime-compat/environment.json"
    )
      return;
    const aborted = new Promise<never>((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
    );
    controller.abort(new Error("cancel environment initialization"));
    return aborted;
  });
  await expect(f.client.devboxes.create({}, { signal: controller.signal })).rejects.toMatchObject({
    code: "timeout",
  });
  expect(f.calls).toHaveLength(2);
  expect(
    f.calls.filter((request) => /:(stop|update)$/.test(new URL(request.url).pathname)),
  ).toHaveLength(0);
  expect(f.info).toMatchObject({ state: "running", persistent: true });
});

test("legacy non-cancellation rollback requires a fresh ordinary create and independent cleanup", async () => {
  for (const ownership of [{}, { replayed: true }, { reused: true }] as const) {
    const f = fixture({ ...ownership, persistent: true });
    f.intercept(async (request) => {
      if (request.method !== "PUT") return;
      return Response.json(
        { error: { code: "init_failed", message: "Environment unavailable" } },
        { status: 409 },
      );
    });
    await expect(f.client.devboxes.create()).rejects.toMatchObject({ code: "init_failed" });
    const cleanup = f.calls.filter((request) =>
      /:(stop|update)$/.test(new URL(request.url).pathname),
    );
    if ("replayed" in ownership || "reused" in ownership) {
      expect(cleanup).toHaveLength(0);
      expect(f.info).toMatchObject({ state: "running", persistent: true });
    } else {
      expect(cleanup).toHaveLength(2);
      expect(cleanup.every((request) => request.signal.aborted === false)).toBe(true);
      expect(f.info).toMatchObject({ state: "stopped", persistent: false });
    }
  }
  const f = fixture();
  f.intercept(async (request) =>
    request.method === "PUT"
      ? Response.json(
          { error: { code: "init_failed", message: "Environment unavailable" } },
          { status: 409 },
        )
      : undefined,
  );
  await expect(
    f.client.devboxes.create({}, { idempotencyKey: "existing-create-attempt" }),
  ).rejects.toMatchObject({ code: "init_failed" });
  expect(
    f.calls.filter((request) => /:(stop|update)$/.test(new URL(request.url).pathname)),
  ).toHaveLength(0);
});

test("accepted lifecycle/file/execution options refuse pre-aborted work before any request", async () => {
  const f = fixture(),
    reason = new Error("no resource effects"),
    options = { signal: AbortSignal.abort(reason) };
  for (const operation of [
    () => f.client.devboxes.suspend(ID, options),
    () => f.client.devboxes.resume(ID, options),
    () => f.client.devboxes.shutdown(ID, options),
    () => f.client.devboxes.shutdown(ID, {}, options),
    () => f.client.devboxes.readFileContents(ID, { file_path: "/workspace/file" }, options),
    () =>
      f.client.devboxes.writeFileContents(
        ID,
        { file_path: "/workspace/file", contents: "never" },
        options,
      ),
    () => f.client.devboxes.executions.retrieve(ID, "execution", options),
    () => f.client.devboxes.executions.retrieve(ID, "execution", {}, options),
    () => f.client.devboxes.executions.kill(ID, "execution", options),
    () => f.client.devboxes.executions.kill(ID, "execution", {}, options),
    () => f.client.devboxes.executions.sendStdIn(ID, "execution", options),
    () => f.client.devboxes.executions.sendStdIn(ID, "execution", { text: "never" }, options),
  ]) {
    await expect(operation()).rejects.toBe(reason);
    expect(f.calls).toHaveLength(0);
  }
});

test("create file mounts own distinct mutation keys under the global journal contract", async () => {
  const f = fixture(),
    journal = new Map<string, string>();
  const mounts: { path: string; text: string; key: string }[] = [];
  f.intercept(async (request) => {
    if (request.method === "GET") return;
    const key = request.headers.get("idempotency-key");
    if (!key) throw new Error("Mutation omitted its journal key");
    const text = await request.clone().text();
    const digest = JSON.stringify([request.method, request.url, text]);
    const prior = journal.get(key);
    if (prior !== undefined && prior !== digest)
      return Response.json(
        { error: { code: "idempotency_key_reused", message: "Key belongs to another mutation" } },
        { status: 422 },
      );
    journal.set(key, digest);
    const path = new URL(request.url).searchParams.get("path");
    if (request.method === "PUT" && path?.startsWith("/workspace/mount-"))
      mounts.push({ path, text, key });
    return undefined;
  });
  await f.client.devboxes.create(
    {
      file_mounts: {
        "/workspace/mount-one": "first",
        "/workspace/mount-two": "second",
      },
    },
    { idempotencyKey: "allocation-only" },
  );
  expect(mounts.map(({ path, text }) => ({ path, text }))).toEqual([
    { path: "/workspace/mount-one", text: "first" },
    { path: "/workspace/mount-two", text: "second" },
  ]);
  expect(new Set(mounts.map(({ key }) => key)).size).toBe(2);
  expect(mounts.every(({ key }) => key !== "allocation-only")).toBe(true);
});

test("compound lifecycle caller keys refuse before any journal mutation", async () => {
  const f = fixture({ persistent: true }),
    options = { idempotencyKey: "compound-key" };
  for (const operation of [
    () => f.client.devboxes.suspend(ID, options),
    () => f.client.devboxes.resume(ID, options),
    () => f.client.devboxes.shutdown(ID, options),
    () => f.client.devboxes.shutdown(ID, {}, options),
  ]) {
    await expect(operation()).rejects.toMatchObject({ code: "unsupported_compatibility_option" });
    expect(f.calls).toHaveLength(0);
  }
  const sandbox = await f.runtime.sandboxes.get(ID);
  const before = f.calls.length;
  await expect(destroy(sandbox, options)).rejects.toMatchObject({
    code: "unsupported_compatibility_option",
  });
  expect(f.calls).toHaveLength(before);
  expect(f.info).toMatchObject({ state: "running", persistent: true });
});

test("held file reads and writes receive cancellation after lookup", async () => {
  for (const mode of ["read", "write"] as const) {
    const f = fixture(),
      controller = new AbortController();
    f.intercept(async (request) => {
      if (!new URL(request.url).pathname.endsWith("/files/content")) return;
      const aborted = new Promise<never>((_resolve, reject) =>
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        }),
      );
      controller.abort(new Error("cancel file transfer"));
      return aborted;
    });
    await expect(
      mode === "read"
        ? f.client.devboxes.readFileContents(
            ID,
            { file_path: "/workspace/file" },
            { signal: controller.signal },
          )
        : f.client.devboxes.writeFileContents(
            ID,
            { file_path: "/workspace/file", contents: "file" },
            { signal: controller.signal },
          ),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.signal.aborted).toBe(true);
  }
});

test("named-shell initialization propagates cancellation before broker or command writes", async () => {
  const f = fixture(),
    controller = new AbortController();
  f.intercept(async (request) => {
    if (!new URL(request.url).pathname.endsWith("/files:mkdir")) return;
    const aborted = new Promise<never>((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
    );
    controller.abort(new Error("cancel named shell"));
    return aborted;
  });
  await expect(
    f.client.devboxes.executions.executeAsync(
      ID,
      { command: "echo never", shell_name: "session" },
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(f.calls).toHaveLength(2);
  expect(
    f.calls.filter(
      (request) => request.method === "PUT" || new URL(request.url).pathname.endsWith("/processes"),
    ),
  ).toHaveLength(0);
});

test("a cancelled queued lifecycle waiter settles without cancelling the earlier operation", async () => {
  const f = fixture(),
    controller = new AbortController(),
    reason = new Error("cancel queued resume");
  let releaseGate: () => void = () => {
    throw new Error("Gate was not initialized");
  };
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let reachedUpdate: () => void = () => {
    throw new Error("Update signal was not initialized");
  };
  const updateStarted = new Promise<void>((resolve) => {
    reachedUpdate = resolve;
  });
  f.intercept(async (request) => {
    if (!new URL(request.url).pathname.endsWith(":update")) return;
    reachedUpdate();
    await gate;
    return undefined;
  });
  const first = f.client.devboxes.suspend(ID);
  await updateStarted;
  const queued = f.client.devboxes.resume(ID, { signal: controller.signal });
  controller.abort(reason);
  try {
    await expect(queued).rejects.toBe(reason);
    expect(f.calls).toHaveLength(2);
  } finally {
    releaseGate();
  }
  expect((await first).status).toBe("suspended");
  expect(f.calls).toHaveLength(3);
  expect(f.calls.every((request) => request.signal.aborted === false)).toBe(true);
});

test("forced shutdown and unsupported execution tails refuse before effects", async () => {
  const f = fixture();
  await expect(f.client.devboxes.shutdown(ID, { force: "true" })).rejects.toMatchObject({
    code: "unsupported_compatibility_option",
  });
  await expect(
    f.client.devboxes.executions.retrieve(ID, "execution", { last_n: "10" }),
  ).rejects.toMatchObject({ code: "unsupported_compatibility_option" });
  expect(f.calls).toHaveLength(0);
});

test("EOF and INTERRUPT bodies stay distinct from cancellation options", async () => {
  const f = fixture(),
    bodies: Record<string, unknown>[] = [];
  const process: ProcessInfo = {
    id: "execution",
    kind: "process",
    state: "running",
    exitCode: null,
    command: "cat",
    cwd: "/workspace",
    pty: false,
    stdinOpen: true,
    stdinOffset: 0,
    startedAt: NOW,
    endedAt: null,
    timeoutMs: null,
    outputBytes: 0,
    firstOffset: 0,
  };
  f.intercept(async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path.endsWith("/processes/execution"))
      return Response.json(process);
    if (
      path.endsWith("/processes/execution:write") ||
      path.endsWith("/processes/execution:signal")
    ) {
      bodies.push((await request.json()) as Record<string, unknown>);
      return Response.json(path.endsWith(":write") ? { offset: 0 } : { ok: true });
    }
    return undefined;
  });
  await expect(
    f.client.devboxes.executions.sendStdIn(ID, "execution", { signal: "EOF" }),
  ).resolves.toMatchObject({ success: true });
  await expect(
    f.client.devboxes.executions.sendStdIn(ID, "execution", { signal: "INTERRUPT" }),
  ).resolves.toMatchObject({ success: true });
  expect(bodies).toEqual([{ base64: "", offset: 0, eof: true }, { signal: "SIGINT" }]);
  const before = f.calls.length;
  await expect(
    f.client.devboxes.executions.sendStdIn(
      ID,
      "execution",
      { text: "do not duplicate" },
      { idempotencyKey: "duplicate-input" },
    ),
  ).rejects.toMatchObject({ code: "unsupported_compatibility_option" });
  expect(f.calls).toHaveLength(before);
});

test("Runloop async HTTP deadline never becomes a guest process kill deadline", async () => {
  const f = fixture();
  let body: Record<string, unknown> | undefined;
  f.intercept(async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/files/content"))
      return new Response("{}");
    if (!url.pathname.endsWith("/processes")) return;
    body = (await request.json()) as Record<string, unknown>;
    return new Promise<never>((_resolve, reject) => {
      if (request.signal.aborted) reject(request.signal.reason);
      else
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
    });
  });
  await expect(
    f.client.devboxes.executions.executeAsync(ID, { command: "sleep 30" }, { timeout: 250 }),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(body).toBeDefined();
  expect(body).not.toHaveProperty("timeoutMs");
});

test("Runloop inventory refuses a repeating native cursor before a third request", async () => {
  const f = fixture();
  let pages = 0;
  f.intercept(async (request) => {
    expect(new URL(request.url).pathname).toBe("/v1/sandboxes");
    pages++;
    if (pages > 2) throw new Error("Repetition reached a third request");
    return Response.json({ data: [], nextCursor: "repeated" });
  });
  await expect(f.client.devboxes.list()).rejects.toThrow("Pagination returned a repeated cursor");
  expect(pages).toBe(2);
});

const referenceRoot = process.env.RUNTIME_COMPAT_REFERENCE_RUNTIME;
const cacheRoot = process.env.RUNTIME_COMPAT_CACHE;
test.skipIf(!referenceRoot || !cacheRoot)(
  "unchanged creation consumer performs no allocation with the pinned Runloop client",
  async () => {
    const lock = JSON.parse(
      await readFile(new URL("../../compatibility-lock.json", import.meta.url), "utf8"),
    ) as CompatibilityLock;
    const pin = lock.providers
      .find((provider) => provider.id === "runloop")
      ?.upstreams.find(
        (upstream) => upstream.registry === "npm" && upstream.name === "@runloop/api-client",
      );
    if (!pin) throw new Error("Missing pinned Runloop oracle");
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
    const installed = resolve(referenceRoot!, "packages/runloop");
    const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    expect([pkg.name, pkg.version]).toEqual([pin.name, pin.version]);
    for (const file of ["index.mjs", "core.mjs", "resources/devboxes/devboxes.mjs"])
      expect(await readFile(join(installed, file), "utf8")).toBe(
        await readFile(join(cache, "package", file), "utf8"),
      );
    type Consumer = {
      devboxes: {
        create(body: { name: string }, options: { signal: AbortSignal }): Promise<unknown>;
      };
    };
    const { Runloop: Official } = (await import(
      pathToFileURL(join(installed, "index.mjs")).href
    )) as {
      Runloop: new (options: {
        bearerToken: string;
        baseURL: string;
        maxRetries: number;
        fetch: typeof fetch;
      }) => Consumer;
    };
    let officialRequests = 0;
    const neverFetch = (async () => {
      officialRequests++;
      throw new Error("Pre-aborted request reached fetch");
    }) as unknown as typeof fetch;
    const official = new Official({
      bearerToken: "fixture",
      baseURL: "https://runloop-official-cancellation.invalid",
      maxRetries: 0,
      fetch: neverFetch,
    });
    const f = fixture(),
      signal = AbortSignal.abort(new Error("cancel creation"));
    async function consumer(client: Consumer) {
      try {
        await client.devboxes.create({ name: "cancel" }, { signal });
        return false;
      } catch {
        return true;
      }
    }
    expect(await consumer(f.client)).toBe(await consumer(official));
    expect(officialRequests).toBe(0);
    expect(f.calls).toHaveLength(0);
  },
);
