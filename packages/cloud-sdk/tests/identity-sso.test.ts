import { afterEach, expect, test } from "bun:test";
import { run } from "../src/cli";
import { Runtime } from "../src/client";
import { Sandbox, identityToken, RuntimeError } from "../src/index";
import { sandboxMarker } from "../src/transport";

/* Identity tokens from inside a sandbox (Sandbox.identityToken,
   `runtime sandbox identity-token`) and single sign-on status
   (runtime.sso.get, `runtime sso`) against stubs. The routes are tested over
   Postgres in packages/cloud (identity-tokens.test.ts, sso-api.test.ts). */

const original = globalThis.fetch;
const saved = {
  url: process.env.RUNTIME_ID_TOKEN_REQUEST_URL,
  token: process.env.RUNTIME_ID_TOKEN_REQUEST_TOKEN,
};
afterEach(() => {
  globalThis.fetch = original;
  for (const [name, value] of [
    ["RUNTIME_ID_TOKEN_REQUEST_URL", saved.url],
    ["RUNTIME_ID_TOKEN_REQUEST_TOKEN", saved.token],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

function stub(answer: (request: Request) => Response) {
  const seen: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(request);
    return answer(request);
  }) as typeof fetch;
  return seen;
}
function output() {
  const lines: string[] = [];
  return {
    lines,
    out: { json: false, write: (t: string) => lines.push(t), error: (t: string) => lines.push(t) },
  };
}
const TOKEN = {
  token: "h.p.s",
  expiresAt: "2026-09-24T00:10:00.000Z",
  issuer: "https://withruntime.com/oidc",
  subject: "org:o:image:base:sandbox:s",
  audience: "sts.amazonaws.com",
};

test("inside a sandbox, identityToken asks with the sandbox's request token and needs no API key", async () => {
  process.env.RUNTIME_ID_TOKEN_REQUEST_URL = "https://api.withruntime.com/v1/identity/token";
  process.env.RUNTIME_ID_TOKEN_REQUEST_TOKEN = "rtid1.statement.signature";
  const seen = stub(() => Response.json(TOKEN));
  const got = await Sandbox.identityToken({ audience: "sts.amazonaws.com", lifetimeSeconds: 900 });
  expect(got.token).toBe("h.p.s");
  const url = new URL(seen[0]!.url);
  expect(url.pathname).toBe("/v1/identity/token");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    audience: "sts.amazonaws.com",
    lifetimeSeconds: "900",
  });
  expect(seen[0]!.headers.get("authorization")).toBe("Bearer rtid1.statement.signature");
  // The CLI prints the token alone, so it drops into a shell variable.
  const { lines, out } = output();
  expect(await run(["sandbox", "identity-token", "--audience", "sts.amazonaws.com"], {}, out)).toBe(
    0,
  );
  expect(lines).toEqual(["h.p.s"]);
});

test("a refusal carries the API's code and message; outside a sandbox there is nothing to ask with", async () => {
  process.env.RUNTIME_ID_TOKEN_REQUEST_URL = "https://api.withruntime.com/v1/identity/token";
  process.env.RUNTIME_ID_TOKEN_REQUEST_TOKEN = "rtid1.x.y";
  stub(() =>
    Response.json(
      { error: { code: "forbidden", message: "The sandbox is not running." } },
      { status: 403 },
    ),
  );
  const refused = await identityToken({ audience: "x" }).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(RuntimeError);
  expect((refused as RuntimeError).code).toBe("forbidden");
  delete process.env.RUNTIME_ID_TOKEN_REQUEST_TOKEN;
  // Outside a sandbox, wherever the test runs: no guest environment file either.
  const marker = sandboxMarker.path;
  sandboxMarker.path = "/nonexistent/runtime/environment.json";
  try {
    const missing = await identityToken({ audience: "x" }).catch((e: unknown) => e);
    expect((missing as RuntimeError).code).toBe("identity_unavailable");
  } finally {
    sandboxMarker.path = marker;
  }
});

test("runtime.sso.get() and `runtime sso` read GET /v1/sso", async () => {
  const status = {
    connections: [
      {
        id: "c",
        providerId: "sso-0123456789ab",
        protocol: "saml",
        provider: "okta",
        domain: "acme.com",
        domainVerifiedAt: null,
        verification: {
          type: "TXT",
          name: "_runtime-verify.acme.com",
          value: "runtime-verify=abc",
        },
        defaultRole: "developer",
        requireSso: false,
        createdAt: "2026-09-23T00:00:00.000Z",
      },
    ],
    scim: { tokens: 1, users: 3, activeUsers: 2, groups: [] },
    manage: "https://withruntime.com/account/single-sign-on",
  };
  const seen = stub(() => Response.json(status));
  const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
  expect((await runtime.sso.get()).connections[0]!.domain).toBe("acme.com");
  expect(new URL(seen[0]!.url).pathname).toBe("/v1/sso");
  const { lines, out } = output();
  expect(
    await run(
      ["sso"],
      { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" },
      out,
    ),
  ).toBe(0);
  const text = lines.join("\n");
  expect(text).toContain("acme.com");
  expect(text).toContain("_runtime-verify.acme.com");
  expect(text).toContain("2 of 3 people active");
});
