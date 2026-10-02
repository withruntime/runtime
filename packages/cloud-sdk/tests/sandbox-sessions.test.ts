import { afterEach, expect, test } from "bun:test";
import { Runtime, Sandbox } from "../src/index";

/* Sandbox sessions in the SDK (ARCHITECTURE.md section 3.12): the backend
 * makes one with sbx.sessions, and a page drives the sandbox with only the
 * token and the sandbox id. The page half uses Web APIs alone, so it is run
 * here with Buffer taken away, as a browser has none. */

const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const SESSION = "5b2e1c3d-4a5f-4e6d-8c7b-9a0f1e2d3c4b";
const TOKEN = `rtsess_${SESSION}_${"x".repeat(43)}`;
const view = {
  id: SESSION,
  sandboxId: ID,
  name: null,
  origins: ["https://app.example.com"],
  createdBy: "agent",
  createdAt: "2026-09-28T10:00:00Z",
  expiresAt: "2026-09-28T11:00:00Z",
  revokedAt: null,
  state: "active",
};
type Seen = { method: string; path: string; auth: string | null; body: unknown };

function server(answer: (method: string, url: URL, body: unknown) => Response | undefined) {
  const seen: Seen[] = [];
  const fetcher = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const text = typeof init.body === "string" ? init.body : undefined;
    const body = text ? JSON.parse(text) : init.body;
    const method = init.method ?? "GET";
    seen.push({
      method,
      path: `${url.pathname}${url.search}`,
      auth: new Headers(init.headers).get("authorization"),
      body,
    });
    return answer(method, url, body) ?? Response.json({ id: ID, state: "running" });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

const saved = globalThis.Buffer;
afterEach(() => {
  globalThis.Buffer = saved;
});

test("a backend makes, lists and revokes a sandbox's sessions", async () => {
  const { fetcher, seen } = server((method, url) => {
    if (method === "POST" && url.pathname.endsWith("/sessions"))
      return Response.json({ ...view, token: TOKEN, apiUrl: "https://api.example.test" });
    if (method === "GET" && url.pathname.endsWith("/sessions"))
      return Response.json({ data: [view], nextCursor: null });
    if (url.pathname.endsWith(":revoke")) return Response.json({ ...view, state: "revoked" });
    return undefined;
  });
  const runtime = new Runtime({
    apiKey: "rk",
    baseUrl: "https://api.example.test",
    fetch: fetcher,
  });
  const sbx = await runtime.sandboxes.get(ID);
  const made = await sbx.sessions.create({ ttlSeconds: 900, origins: ["https://app.example.com"] });
  expect(made.token).toBe(TOKEN);
  expect(seen.at(-1)).toMatchObject({
    method: "POST",
    path: `/v1/sandboxes/${ID}/sessions`,
    auth: "Bearer rk",
    body: { ttlSeconds: 900, origins: ["https://app.example.com"] },
  });
  expect((await sbx.sessions.list()).map((s) => s.id)).toEqual([SESSION]);
  expect((await sbx.sessions.revoke(SESSION)).state).toBe("revoked");
  expect(seen.at(-1)?.path).toBe(`/v1/sandboxes/${ID}/sessions/${SESSION}:revoke`);
});

test("a create whose token was lost in a replay is revoked and made again", async () => {
  let creates = 0;
  const { fetcher, seen } = server((method, url) => {
    if (method === "POST" && url.pathname.endsWith("/sessions"))
      return Response.json(
        ++creates === 1
          ? { ...view, token: null, apiUrl: "https://api.example.test" }
          : { ...view, id: "fresh", token: TOKEN, apiUrl: "https://api.example.test" },
      );
    if (url.pathname.endsWith(":revoke")) return Response.json({ ...view, state: "revoked" });
    return undefined;
  });
  const runtime = new Runtime({
    apiKey: "rk",
    baseUrl: "https://api.example.test",
    fetch: fetcher,
  });
  const made = await (await runtime.sandboxes.get(ID)).sessions.create();
  expect(made.id).toBe("fresh");
  expect(seen.map((s) => `${s.method} ${s.path}`)).toContain(
    `POST /v1/sandboxes/${ID}/sessions/${SESSION}:revoke`,
  );
});

test("a page drives the sandbox with the token alone, with no Buffer", async () => {
  // @ts-expect-error -- a browser has no Buffer
  globalThis.Buffer = undefined;
  const { fetcher, seen } = server((method, url, body) => {
    if (url.pathname.endsWith(":exec") && (body as { stream?: boolean }).stream)
      return new Response(
        [
          { type: "start", processId: "p1" },
          { type: "stdout", data: "héllo\n", offset: 0 },
          { type: "stdout", data: "b\n", offset: 7 },
          { type: "exit", exitCode: 0, state: "exited", timedOut: false },
        ]
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(""),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    if (url.pathname.endsWith(":exec"))
      return Response.json({ exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false });
    if (url.pathname.endsWith(":write")) return Response.json({ offset: 3 });
    if (url.pathname.endsWith("/processes"))
      return Response.json({ id: "p2", state: "running", stdinOffset: 0 });
    if (url.pathname.endsWith("/files/content") && method === "PUT") return Response.json({});
    if (url.pathname.endsWith("/uploads"))
      return Response.json({ uploadId: "u1", chunkBytes: 1_048_576 });
    if (url.pathname.includes("/uploads/")) return Response.json({ received: 1_048_577 });
    return undefined;
  });
  const sbx = Sandbox.fromSession({
    token: TOKEN,
    sandboxId: ID,
    apiUrl: "https://api.example.test",
    fetch: fetcher,
  });
  expect(seen).toEqual([]); // no call until asked
  expect(sbx.id).toBe(ID);

  expect((await sbx.exec("echo ok", { stdin: "in" })).stdout).toBe("ok\n");
  expect(seen[0]!.body).toMatchObject({ command: "echo ok", stdin: "in" });
  const streamed: string[] = [];
  const result = await sbx.exec("echo", { onStdout: (data) => streamed.push(data) });
  // "héllo\n" is 7 bytes, so the next chunk at offset 7 lost nothing.
  expect(result).toMatchObject({ stdout: "héllo\nb\n", stdoutTruncated: false });
  const process = await sbx.spawn("cat", { stdin: "pipe" });
  await process.write("hi\n");
  expect(seen.at(-1)!.body).toMatchObject({ base64: btoa("hi\n") });
  await sbx.files.write("/workspace/a.txt", "small");
  // A write over 1 MiB goes in checked chunks, hashed with Web Crypto.
  await sbx.files.write("/workspace/big.bin", new Uint8Array(1_048_577));
  const begin = seen.find((s) => s.path.endsWith("/uploads"))!;
  expect((begin.body as { sha256: string }).sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
});

test("fromSession refuses a key where a session belongs", () => {
  expect(() => Sandbox.fromSession({ token: "rtcloud_x", sandboxId: ID })).toThrow(/rtsess_/);
});

test("`runtime sandbox session` makes, lists and revokes, and prints the token once", async () => {
  const { run } = await import("../src/cli");
  const original = globalThis.fetch;
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    sent.push({
      method: request.method,
      path: url.pathname,
      body: text ? JSON.parse(text) : undefined,
    });
    if (url.pathname === `/v1/sandboxes/${ID}`) return Response.json({ id: ID, state: "running" });
    if (url.pathname.endsWith("/sessions") && request.method === "POST")
      return Response.json({ ...view, token: TOKEN, apiUrl: "https://api.example.test" });
    if (url.pathname.endsWith("/sessions"))
      return Response.json({ data: [view], nextCursor: null });
    return Response.json({ ...view, state: "revoked" });
  }) as typeof fetch;
  const lines: string[] = [];
  const out = {
    json: false,
    write: (t: string) => lines.push(t),
    error: (t: string) => lines.push(`ERR ${t}`),
  };
  const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
  try {
    expect(
      await run(
        [
          "sandbox",
          "session",
          "create",
          ID,
          "--origin",
          "https://app.example.com",
          "--origin",
          "http://localhost:5173",
          "--ttl",
          "900",
        ],
        env,
        out,
      ),
    ).toBe(0);
    expect(lines.join("\n")).toContain(TOKEN);
    expect(sent.find((s) => s.method === "POST")!.body).toEqual({
      ttlSeconds: 900,
      origins: ["https://app.example.com", "http://localhost:5173"],
    });
    lines.length = 0;
    expect(await run(["sandbox", "session", "ls", ID], env, out)).toBe(0);
    expect(lines.join("\n")).toContain(SESSION);
    expect(lines.join("\n")).not.toContain("rtsess_");
    expect(await run(["sandbox", "session", "revoke", ID, SESSION], env, out)).toBe(0);
    expect(sent.at(-1)!.path).toBe(`/v1/sandboxes/${ID}/sessions/${SESSION}:revoke`);
    await expect(run(["sandbox", "session", "open", ID], env, out)).rejects.toThrow(
      /session create/,
    );
    await expect(
      run(["sandbox", "session", "create", ID, "--ttl", "soon"], env, out),
    ).rejects.toThrow(/whole number/);
  } finally {
    globalThis.fetch = original;
  }
});
