import { expect, test } from "bun:test";
import { run } from "../src/cli";

/* Rough edges the user lane found driving CLI 0.6.1 on 25 September 2026,
   and three gaps the docs lane found in the CLI's words, each against a stub
   API: what the CLI sends and what it prints. */

const SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };

async function cli(
  argv: string[],
  routes: (method: string, url: URL, body: unknown) => unknown = () => undefined,
) {
  const original = globalThis.fetch;
  const sent: Array<{ method: string; path: string; body: { build?: unknown } | undefined }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    const body = text ? (JSON.parse(text) as { build?: unknown }) : undefined;
    sent.push({ method: request.method, path: url.pathname, body });
    const answer = await routes(request.method, url, body);
    if (answer instanceof Response) return answer;
    if (answer === undefined)
      return Response.json(
        { error: { code: "route_not_found", message: url.pathname } },
        { status: 404 },
      );
    return Response.json(answer);
  }) as typeof fetch;
  const lines: string[] = [];
  try {
    const code = await run(argv, env, {
      json: false,
      write: (t) => lines.push(t),
      error: (t) => lines.push(`ERR ${t}`),
    });
    return { code, text: lines.join("\n"), sent };
  } finally {
    globalThis.fetch = original;
  }
}

test("`snapshot get` reads as a table, as `sandbox get` does", async () => {
  const snapshot = {
    id: "3f7c2d10-5a6b-4c8d-9e0f-1a2b3c4d5e6f",
    kind: "snapshot",
    status: "active",
    state: "ready",
    name: null,
    sourceSandboxId: SANDBOX,
    shape: { vcpu: 2, memoryMiB: 2048, diskMiB: 10240, memoryGuarantee: "flexible" },
    retentionDays: 7,
    storedBytes: 314_572_800,
    meteredBytes: 104_857_600,
    backedUp: false,
    durability: { state: "pending", durableAt: null, storedBytes: null },
    labels: { lane: "user" },
    error: null,
    createdAt: "2026-09-25T18:30:00Z",
    readyAt: "2026-09-25T18:30:11Z",
    expiresAt: "2026-10-02T18:30:00Z",
  };
  const { code, text } = await cli(["snapshot", "get", snapshot.id], (_m, url) =>
    url.pathname === `/v1/snapshots/${snapshot.id}` ? snapshot : undefined,
  );
  expect(code).toBe(0);
  expect(text).not.toContain("{");
  expect(text).toMatch(/^id\s+3f7c2d10/m);
  expect(text).toMatch(/^stored\s+300 MiB$/m);
  expect(text).toMatch(/^kept until\s+2026-10-02T18:30:00Z \(7 days\)$/m);
  expect(text).toMatch(/^labels\s+lane=user$/m);
});

test("`sandbox preview` prints the link and how to use it, without a referral pitch", async () => {
  const { text } = await cli(["sandbox", "preview", SANDBOX, "3000"], (_m, url) => {
    if (url.pathname === `/v1/sandboxes/${SANDBOX}`)
      return { id: SANDBOX, kind: "sandbox", state: "running", status: "active", labels: {} };
    if (url.pathname.endsWith("/previews"))
      return {
        port: 3000,
        visibility: "private",
        url: "https://3000-x.runtimehost.com/",
        urlWithToken: "https://3000-x.runtimehost.com/?runtime_preview_token=t",
        token: "t",
        tokenExpiresAt: "2026-09-26T00:00:00Z",
        hint: "Share urlWithToken with whoever should see it. If they sign up with your referral link (`runtime referrals`), you both get credit on their first top-up.",
      };
    return undefined;
  });
  expect(text).toContain("runtime_preview_token=t");
  expect(text).not.toMatch(/referral/i);
});

test("`compare` help and its usage name every rival the API prices, new ones included", async () => {
  const help = await cli(["help"]);
  for (const rival of ["lambda-microvms", "freestyle", "prime"]) expect(help.text).toContain(rival);
  const refused = await cli(["compare"]).catch((e: unknown) => ({ text: String(e) }));
  for (const rival of ["lambda-microvms", "freestyle", "prime"])
    expect(refused.text).toContain(rival);
});

test("`image build --disk-mib` sizes the build's scratch disk", async () => {
  const image = {
    id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
    kind: "image",
    state: "ready",
    name: null,
    tags: [],
    build: { diskMiB: 16384 },
  };
  const { sent } = await cli(
    ["image", "build", "--pip", "requests", "--disk-mib", "16384"],
    (m, url) => {
      if (m === "POST" && url.pathname === "/v1/images") return image;
      if (url.pathname.startsWith(`/v1/images/${image.id}`))
        return url.pathname.endsWith("/logs")
          ? { lines: [], nextAfter: 0, state: "ready", truncated: false, done: true }
          : image;
      return undefined;
    },
  );
  const create = sent.find((s) => s.method === "POST" && s.path === "/v1/images");
  expect(create?.body?.build).toEqual({ diskMiB: 16384 });
});
