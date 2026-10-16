import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginDeviceLogin } from "../src/login";
import { sandboxMarker } from "../src/transport";

/* Inside a sandbox, a login's calls to the website carry the sandbox's
   identity token, so the website counts its per-network limit against this
   sandbox and not the address every sandbox on the host shares
   (apps/cloud-web/src/lib/limit-key.ts, which tests the website's side). */

const original = globalThis.fetch;
const marker = sandboxMarker.path;
const names = ["RUNTIME_ID_TOKEN_REQUEST_URL", "RUNTIME_ID_TOKEN_REQUEST_TOKEN"] as const;
const saved = names.map((name) => process.env[name]);
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "runtime-login-identity-"));
  sandboxMarker.path = join(directory, "environment.json");
  for (const name of names) delete process.env[name];
});
afterEach(async () => {
  globalThis.fetch = original;
  sandboxMarker.path = marker;
  names.forEach((name, i) =>
    saved[i] === undefined ? delete process.env[name] : (process.env[name] = saved[i]),
  );
  await rm(directory, { recursive: true, force: true });
});

/** One login's first call, from a fresh config folder so nothing is resumed. */
async function start(): Promise<Headers> {
  let headers: Headers | undefined;
  const config = await mkdtemp(join(directory, "config-"));
  await beginDeviceLogin({ XDG_CONFIG_HOME: config }, "agent", {
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return Response.json({
        deviceCode: "a".repeat(43),
        userCode: "ABCD-EF01-2345",
        expiresAt: Date.now() + 60_000,
        verificationUri: "https://withruntime.com/connect?code=ABCD-EF01-2345",
      });
    }) as typeof fetch,
  });
  return headers!;
}

test("outside a sandbox a login sends no identity and asks for none", async () => {
  let asked = 0;
  globalThis.fetch = (async () => (
    asked++,
    new Response(null, { status: 500 })
  )) as unknown as typeof fetch;
  expect((await start()).get("x-runtime-sandbox-identity")).toBeNull();
  expect(asked).toBe(0);
});

test("inside a sandbox whose identity cannot be had, the login still goes, without one", async () => {
  process.env.RUNTIME_ID_TOKEN_REQUEST_URL = "http://runtime.internal/v1/identity/token";
  process.env.RUNTIME_ID_TOKEN_REQUEST_TOKEN = "rtid1.statement.signature";
  globalThis.fetch = (async () => new Response(null, { status: 502 })) as unknown as typeof fetch;
  expect((await start()).get("x-runtime-sandbox-identity")).toBeNull();
});

test("inside a sandbox the login carries a token for the limits audience, asked once", async () => {
  process.env.RUNTIME_ID_TOKEN_REQUEST_URL = "http://runtime.internal/v1/identity/token";
  process.env.RUNTIME_ID_TOKEN_REQUEST_TOKEN = "rtid1.statement.signature";
  const asked: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(new URL(input instanceof Request ? input.url : String(input)));
    return Response.json({
      token: "h.p.s",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      issuer: "https://withruntime.com/oidc",
      subject: "org:o:image:base:sandbox:s",
      audience: "https://withruntime.com/limits",
    });
  }) as typeof fetch;
  expect((await start()).get("x-runtime-sandbox-identity")).toBe("h.p.s");
  expect((await start()).get("x-runtime-sandbox-identity")).toBe("h.p.s");
  expect(asked.map((url) => url.searchParams.get("audience"))).toEqual([
    "https://withruntime.com/limits",
  ]);
});
