import { afterEach, expect, test } from "bun:test";
import { publicEncrypt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginDeviceLogin } from "../src/login";
import { connectionStore } from "../src/credentials";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup(malformed = false) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-token-body-"));
  directories.push(directory);
  const env = { XDG_CONFIG_HOME: directory };
  const dummyKey = `rtcloud_11111111-2222-4333-8444-555555555555_${"A".repeat(43)}`;
  let encryptedKey = "";
  let tokens = 0;
  let starts = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path.endsWith("/start")) {
      starts++;
      const body = JSON.parse(init?.body as string) as { publicKey: string };
      encryptedKey = publicEncrypt(
        { key: body.publicKey, oaepHash: "sha256" },
        Buffer.from(dummyKey),
      ).toString("base64");
      return Response.json({
        verificationUri: "https://withruntime.com/connect?code=ABCD-EF01-2345",
        deviceCode: "a".repeat(43),
        userCode: "ABCD-EF01-2345",
        expiresAt: Date.now() + 60_000,
      });
    }
    if (path.endsWith("/token")) {
      tokens++;
      if (tokens === 1) {
        if (malformed)
          return new Response('{"status":', { headers: { "content-type": "application/json" } });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("fixture body stream interrupted"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return Response.json({
        status: "connected",
        encryptedKey,
        connectionId: "fixture-connection",
        orgId: "fixture-org",
      });
    }
    expect(path).toBe("/api/connect/confirm");
    expect(new Headers(init?.headers).get("authorization") === `Bearer ${dummyKey}`).toBe(true);
    return Response.json({ connected: true });
  }) as typeof fetch;
  return { env, fetcher, dummyKey, counts: () => ({ starts, tokens }) };
}

test("an interrupted token body preserves the RSA request and retrieves the same issued key", async () => {
  const kit = await setup();
  const store = connectionStore(kit.env);
  const pending = await beginDeviceLogin(kit.env, "fixture-agent", { fetch: kit.fetcher });
  const original = await store.readPending();
  expect(original).not.toBeNull();
  expect(await pending.check()).toBe("pending");
  const retained = await store.readPending();
  expect(retained?.privateKey === original?.privateKey).toBe(true);
  expect(retained?.deviceCode === original?.deviceCode).toBe(true);
  expect(await store.read()).toBeNull();
  const resumed = await beginDeviceLogin(kit.env, "fixture-agent", { fetch: kit.fetcher });
  expect(resumed.resumed).toBe(true);
  expect(await resumed.check()).toMatchObject({ connected: true, orgId: "fixture-org" });
  expect((await store.read())?.key === kit.dummyKey).toBe(true);
  expect(await store.readPending()).toBeNull();
  expect(kit.counts()).toEqual({ starts: 1, tokens: 2 });
});

test("complete malformed token JSON remains terminal and discards its pending request", async () => {
  const kit = await setup(true);
  const store = connectionStore(kit.env);
  const pending = await beginDeviceLogin(kit.env, "fixture-agent", { fetch: kit.fetcher });
  await expect(pending.check()).rejects.toBeInstanceOf(SyntaxError);
  expect(await store.readPending()).toBeNull();
  expect(await store.read()).toBeNull();
});
