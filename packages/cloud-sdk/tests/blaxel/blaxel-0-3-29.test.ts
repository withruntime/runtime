import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  getBlaxelErrorCode,
  getBlaxelErrorMessage,
  getBlaxelErrorRequestId,
  getBlaxelErrorStatus,
  initialize,
  isBlaxelError,
  NotSupportedError,
  ResponseError,
  SandboxCreationTimeoutError,
  SandboxInstance,
  SandboxPreview,
  settings,
} from "../../src/blaxel/index";
import { resetClients } from "../../src/blaxel/client";
import { translate } from "../../src/blaxel/errors";
import { RuntimeError } from "../../src/errors";
import { Runtime } from "../../src/index";
import { BlaxelWorld } from "./fake";

/* What @blaxel/core 0.3.29 added over 0.3.25, on Runtime: the error helpers,
   the preview shorthand, preview.url and token.name, tokens.createIfExpired,
   and settings.integration. Each test fails on the drop-in before it. */

let world: BlaxelWorld;
const withruntime = () => ({ client: world.client() });
const create = (name: string) => SandboxInstance.create({ name, withruntime: withruntime() });
const fake = (sandbox: SandboxInstance) => world.sandboxes.get(sandbox.withruntime.id)!;

beforeEach(() => {
  world = new BlaxelWorld();
});
afterEach(() => {
  resetClients();
  delete process.env.BL_INTEGRATION;
});

describe("error helpers", () => {
  test("read the errors the drop-in throws, as Blaxel's read its own", () => {
    const answer = translate(
      new RuntimeError({
        message: "Sandbox not found.",
        code: "not_found",
        status: 404,
        requestId: "req_1",
      }),
    ) as ResponseError;
    expect(isBlaxelError(answer)).toBe(true);
    expect(getBlaxelErrorStatus(answer)).toBe(404);
    expect(getBlaxelErrorCode(answer)).toBe(404);
    expect(getBlaxelErrorMessage(answer)).toStartWith("Sandbox request failed with status 404");
    expect(getBlaxelErrorRequestId(answer)).toBe("req_1");

    const timeout = new SandboxCreationTimeoutError("box", 5, { message: "still starting" });
    expect(isBlaxelError(timeout)).toBe(true);
    expect(getBlaxelErrorCode(timeout)).toBe("CREATION_TIMEOUT");
    expect(getBlaxelErrorStatus(timeout)).toBe(408);
    expect(getBlaxelErrorRequestId(timeout)).toBeUndefined();

    // Raw bodies, in Blaxel's three shapes.
    expect(isBlaxelError({ error: "nope", code: 403 })).toBe(true);
    expect(isBlaxelError({ code: "QUOTA_EXCEEDED", message: "m", status_code: 429 })).toBe(true);
    const gateway = { error: { code: "UPSTREAM_TIMEOUT", message: "late", status: 504 } };
    expect(isBlaxelError(gateway)).toBe(true);
    expect(getBlaxelErrorCode(gateway)).toBe("UPSTREAM_TIMEOUT");
    expect(getBlaxelErrorStatus(gateway)).toBe(504);
    expect(getBlaxelErrorMessage(gateway)).toBe("late");

    // Not API failures.
    for (const other of [
      new Error("x"),
      Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      new NotSupportedError("a thing", "Use another."),
      "text",
      { error: "no status" },
      null,
    ])
      expect(isBlaxelError(other)).toBe(false);
    expect(getBlaxelErrorStatus("text")).toBeUndefined();
  });

  test("Blaxel's request id and code headers win when a response carries them", () => {
    const response = new Response("{}", {
      status: 502,
      headers: { "cf-ray": "ray-1", "x-blaxel-error-code": "UPSTREAM_ERROR" },
    });
    const error = new ResponseError(response, {}, {});
    error.requestId = "req_2";
    expect(getBlaxelErrorRequestId(error)).toBe("ray-1");
    expect(getBlaxelErrorCode({ response })).toBe("UPSTREAM_ERROR");
  });
});

describe("previews", () => {
  test("the shorthand makes a private preview-<port>, or as it says", async () => {
    const sandbox = await create("short-1");
    const plain = await sandbox.previews.create({ port: 3000 });
    expect(plain.name).toBe("preview-3000");
    expect(plain.spec).toMatchObject({ port: 3000, public: false });
    expect(plain.url).toBe(
      `https://3000-${sandbox.withruntime.id.replaceAll("-", "")}.runtimehost.com`,
    );
    const named = await sandbox.previews.create({ port: 8080, name: "web", public: true });
    expect(named.name).toBe("web");
    expect(world.called("previews.create")).toEqual([
      [3000, { visibility: "private" }],
      [8080, { visibility: "public" }],
    ]);
    expect(fake(sandbox).info.labels["blaxel/preview.web"]).toBe("8080");
  });

  test("a bad shorthand is refused with Blaxel's RangeError before anything is shared", async () => {
    const sandbox = await create("short-2");
    const from = world.calls.length;
    for (const bad of [
      { port: 0 },
      { port: 70_000 },
      { port: 3000.5 },
      { port: 3000, name: "" },
      { port: 3000, public: "yes" as unknown as boolean },
    ]) {
      expect(await sandbox.previews.create(bad).catch((e: unknown) => e)).toBeInstanceOf(
        RangeError,
      );
      expect(await sandbox.previews.createIfNotExists(bad).catch((e: unknown) => e)).toBeInstanceOf(
        RangeError,
      );
    }
    expect(world.calls).toHaveLength(from);
  });

  test("createIfNotExists with the shorthand answers an existing preview as it is", async () => {
    const sandbox = await create("short-3");
    await sandbox.previews.create({
      metadata: { name: "preview-3000" },
      spec: { port: 3000, public: true },
    });
    const found = await sandbox.previews.createIfNotExists({ port: 3000 });
    expect(found.spec.public).toBe(true);
    expect(world.called("previews.create")).toHaveLength(1);
    const made = await sandbox.previews.createIfNotExists({ port: 4000 });
    expect(made.spec).toMatchObject({ port: 4000, public: false });
    expect(world.called("previews.create")).toHaveLength(2);
  });
});

async function nativePreview(name: string, isPublic = false) {
  const seen: URL[] = [];
  const sandbox = await create(name);
  const client = new Runtime({
    apiKey: "rtcloud_key",
    baseUrl: "https://api.example.test",
    fetch: (async (input: string) => {
      const url = new URL(input);
      if (!url.pathname.endsWith("/previews/3000")) return Response.json(fake(sandbox).info);
      seen.push(url);
      const at = url.searchParams.get("expiresAt")!;
      return Response.json({
        port: 3000,
        visibility: "private",
        url: "https://3000-x.runtimehost.com/",
        token: `tok-${seen.length}`,
        tokenExpiresAt: new Date(Math.floor(Date.parse(at) / 1000) * 1000).toISOString(),
      });
    }) as typeof fetch,
  });
  const runtime = await client.sandboxes.get(sandbox.withruntime.id);
  const preview = new SandboxPreview(
    { metadata: { name: "p" }, spec: { port: 3000, public: isPublic } },
    {
      sandboxName: name,
      sandboxId: `${name}-id`,
      run: (work) => work(runtime),
      labels: () => ({}),
      setLabels: () => Promise.resolve(),
    },
  );
  return { preview, seen };
}

describe("tokens.createIfExpired", () => {
  test("reuses the token it made while it lasts long enough and stays under the ceiling", async () => {
    const { preview, seen } = await nativePreview("tok-1");
    const ceiling = new Date(Date.now() + 2 * 3_600_000);
    const first = await preview.tokens.createIfExpired(ceiling);
    expect(first.value).toBe("tok-1");
    expect(first.name).toStartWith("token-");
    expect(await preview.tokens.createIfExpired(ceiling)).toBe(first);
    expect(seen).toHaveLength(1);
    // A lower ceiling than the kept token's end: a new token.
    const lower = await preview.tokens.createIfExpired(new Date(Date.now() + 90 * 60_000));
    expect(lower.value).toBe("tok-2");
    // More validity than the kept token has left: a new token.
    const longer = await preview.tokens.createIfExpired(
      new Date(Date.now() + 3 * 3_600_000),
      100 * 60_000,
    );
    expect(longer.value).toBe("tok-3");
    // Revoking forgets it.
    await preview.tokens.delete("any").catch(() => undefined);
    expect((await preview.tokens.createIfExpired(new Date(Date.now() + 3 * 3_600_000))).value).toBe(
      "tok-4",
    );
  });

  test("checks its arguments as Blaxel does, and refuses a public preview, before any request", async () => {
    const { preview, seen } = await nativePreview("tok-2");
    for (const [at, min] of [
      [new Date(Number.NaN), undefined],
      [new Date(Date.now() - 1000), undefined],
      [new Date(Date.now() + 30 * 60_000), undefined],
      [new Date(Date.now() + 2 * 3_600_000), -1],
      [new Date(Date.now() + 2 * 3_600_000), Number.POSITIVE_INFINITY],
    ] as const)
      expect(await preview.tokens.createIfExpired(at, min).catch((e: unknown) => e)).toBeInstanceOf(
        RangeError,
      );
    const open = (await nativePreview("tok-3", true)).preview;
    expect(((await open.tokens.createIfExpired().catch((e: unknown) => e)) as Error).message).toBe(
      "Cannot create or reuse a token for a public preview",
    );
    expect(seen).toHaveLength(0);
  });

  test("with no expiry asks for a day", async () => {
    const { preview, seen } = await nativePreview("tok-4");
    const before = Date.now();
    await preview.tokens.createIfExpired();
    const asked = Date.parse(seen[0]!.searchParams.get("expiresAt")!);
    expect(asked - before).toBeGreaterThanOrEqual(86_400_000 - 1000);
    expect(asked - before).toBeLessThanOrEqual(86_400_000 + 1000);
  });
});

describe("settings.integration", () => {
  test("is kept and checked as Blaxel does, from settings, initialize or BL_INTEGRATION", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(settings.integration).toBe("");
      process.env.BL_INTEGRATION = "my-harness/1.2.3";
      expect(settings.integration).toBe("my-harness/1.2.3");
      settings.integration = "other/0.1.0-beta.1";
      expect(settings.integration).toBe("other/0.1.0-beta.1");
      initialize({ integration: "third/2.0.0" });
      expect(settings.integration).toBe("third/2.0.0");
      settings.integration = "Not Valid";
      expect(settings.integration).toBe("");
      expect(settings.integration).toBe("");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
