import { afterEach, expect, test } from "bun:test";
import { Runtime } from "../../src/index";
import {
  NotSupportedError,
  SandboxInstance,
  SandboxSessions,
  type SessionCreateOptions,
} from "../../src/blaxel/index";

/* Blaxel's sandbox sessions over Runtime's (ARCHITECTURE.md section 3.12):
 * sandbox.sessions makes, lists and ends them on the backend, and
 * SandboxInstance.fromSession drives the sandbox with the token alone. */

const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const API = "https://api.example.test";
const info = {
  id: ID,
  kind: "sandbox",
  name: "web",
  state: "running",
  labels: {},
  autoWake: true,
  onLeaseEnd: "stop",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  createdAt: new Date().toISOString(),
  memoryMiB: 4096,
};
type Seen = { method: string; path: string; auth: string | null; body: unknown };

function world() {
  const seen: Seen[] = [];
  let next = 0;
  const sessions: Array<Record<string, unknown>> = [];
  const fetcher = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({
      method,
      path: `${url.pathname}${url.search}`,
      auth: new Headers(init.headers).get("authorization"),
      body,
    });
    if (url.pathname === `/v1/sandboxes/${ID}/sessions` && method === "POST") {
      const id = `00000000-0000-4000-8000-00000000000${++next}`;
      const made = {
        id,
        sandboxId: ID,
        name: null,
        origins: body.origins ?? [],
        createdBy: "agent",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + body.ttlSeconds * 1000).toISOString(),
        revokedAt: null,
        state: "active",
      };
      sessions.unshift(made);
      return Response.json({ ...made, token: `rtsess_${id}_${"t".repeat(43)}`, apiUrl: API });
    }
    if (url.pathname === `/v1/sandboxes/${ID}/sessions`)
      return Response.json({ data: sessions, nextCursor: null });
    const revoke = /\/sessions\/([^/:]+):revoke$/.exec(url.pathname);
    if (revoke) {
      const found = sessions.find((one) => one.id === revoke[1])!;
      Object.assign(found, { state: "revoked", revokedAt: new Date().toISOString() });
      return Response.json(found);
    }
    if (url.pathname.endsWith(":exec") && body?.stream)
      return new Response(
        [
          { type: "start", processId: "p1" },
          { type: "stdout", data: "hi\n", offset: 0 },
          { type: "exit", exitCode: 0, state: "exited", timedOut: false },
        ]
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(""),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    if (url.pathname.endsWith(":exec"))
      return Response.json({ exitCode: 0, stdout: "hi\n", stderr: "", timedOut: false });
    return Response.json(info);
  }) as unknown as typeof fetch;
  const client = new Runtime({ apiKey: "rtcloud_key", baseUrl: API, fetch: fetcher });
  return { seen, client, fetcher };
}

const saved = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = saved;
});

test("sandbox.sessions makes a session for a page, as Blaxel's does", async () => {
  const { seen, client } = world();
  const sandbox = new SandboxInstance({ runtime: await client.sandboxes.get(ID), client });
  const session = await sandbox.sessions.create({
    expiresAt: new Date(Date.now() + 15 * 60_000),
    responseHeaders: {
      "Access-Control-Allow-Origin": "https://app.example.com",
      "Access-Control-Allow-Methods": "GET, POST",
    },
  });
  expect(session.token).toMatch(/^rtsess_/);
  expect(session.url).toBe(`${API}/v1/sandboxes/${ID}`);
  expect(session.name).toMatch(/^session-/);
  const create = seen.find((s) => s.method === "POST" && s.path.endsWith("/sessions"))!;
  expect(create.body).toMatchObject({ origins: ["https://app.example.com"] });
  expect((create.body as { ttlSeconds: number }).ttlSeconds).toBeOneOf([899, 900]);

  // Blaxel's default is a day, Runtime's most.
  await sandbox.sessions.create();
  expect(seen.at(-1)!.body).toMatchObject({ ttlSeconds: 86_400, origins: [] });

  expect((await sandbox.sessions.list()).length).toBe(2);
  expect((await sandbox.sessions.get(session.name)).url).toBe(session.url);
  await sandbox.sessions.delete(session.name);
  expect((await sandbox.sessions.list()).map((one) => one.name)).not.toContain(session.name);
});

test("createIfExpired keeps the session this process made until it nears its end", async () => {
  const { client } = world();
  const sandbox = new SandboxInstance({ runtime: await client.sandboxes.get(ID), client });
  const first = await sandbox.sessions.createIfExpired({}, 60_000);
  const again = await sandbox.sessions.createIfExpired({}, 60_000);
  expect(again.token).toBe(first.token);
  // Nearer its end than delta: a new one, and the old one ends.
  const renewed = await sandbox.sessions.createIfExpired({}, 2 * 86_400_000);
  expect(renewed.token).not.toBe(first.token);
  expect((await sandbox.sessions.list()).map((one) => one.name)).toEqual([renewed.name]);
});

test("what a Runtime session cannot be is refused before anything is sent", async () => {
  const { seen, client } = world();
  const sandbox = new SandboxInstance({ runtime: await client.sandboxes.get(ID), client });
  const before = seen.length;
  const refused: SessionCreateOptions[] = [
    { responseHeaders: { "Access-Control-Allow-Origin": "*" } },
    { responseHeaders: { "X-Frame-Options": "DENY" } },
    { requestHeaders: { Authorization: "Bearer x" } },
    { expiresAt: new Date(Date.now() + 2 * 86_400_000) },
  ];
  for (const options of refused)
    expect(await sandbox.sessions.create(options).catch((e: unknown) => e)).toBeInstanceOf(
      NotSupportedError,
    );
  expect(seen.length).toBe(before);
  expect(SandboxSessions).toBeDefined();
});

test("fromSession drives the sandbox with the session's token alone", async () => {
  const { seen, client, fetcher } = world();
  const sandbox = new SandboxInstance({ runtime: await client.sandboxes.get(ID), client });
  const session = await sandbox.sessions.create();
  globalThis.fetch = fetcher;
  const page = await SandboxInstance.fromSession(session);
  expect(page.name).toBe("web");
  const result = await page.process.exec({ command: "echo hi", waitForCompletion: true });
  expect(result.logs ?? result.stdout).toContain("hi");
  const fromPage = seen.filter((s) => s.auth?.startsWith("Bearer rtsess_"));
  expect(fromPage.map((s) => `${s.method} ${s.path.split("?")[0]}`)).toContain(
    `POST /v1/sandboxes/${ID}:exec`,
  );
});
