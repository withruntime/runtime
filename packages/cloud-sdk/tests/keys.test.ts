import { expect, test } from "bun:test";
import { publicEncrypt, randomBytes, randomUUID } from "node:crypto";
import { run } from "../src/cli";
import { createKey, dailyLimitMicros, type KeyRequest } from "../src/keys";

/* `runtime keys create`: ARCHITECTURE.md section 10, "Keys from the
   terminal". The website half is proven in packages/db/tests/
   cloud-key-requests.test.ts; these hold the terminal half to what it
   promises: the key is asked for with exactly the terms given, arrives sealed,
   is handed back once and confirmed, and a refusal, an expiry or an
   interruption leaves nothing behind. */

const keyId = randomUUID();
const key = `rtcloud_${keyId}_${randomBytes(32).toString("base64url")}`;
type Answer = "connected" | "pending" | "denied" | "expired" | "canceled";
function website(answers: Answer[], options: { origin?: string } = {}) {
  const calls: { path: string; body: Record<string, unknown>; auth: string | null }[] = [];
  let publicKey = "";
  let canceled = false;
  const fetcher = (async (url, init) => {
    const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    expect(init?.redirect).toBe("error");
    const path = address.replace("http://localhost:3000/api/connect/", "");
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
      string,
      unknown
    >;
    calls.push({ path, body, auth: new Headers(init?.headers).get("authorization") });
    if (path === "start") {
      publicKey = String(body.publicKey);
      return Response.json({
        deviceCode: "d".repeat(43),
        userCode: "ABCD-EF01-2345",
        expiresAt: Date.now() + 15 * 60_000,
        interval: 5,
        verificationUri: `${options.origin ?? "http://localhost:3000"}/connect?code=ABCD-EF01-2345`,
      });
    }
    if (path === "token" && body.action === "cancel") {
      canceled = true;
      return Response.json({ status: "canceled" });
    }
    if (path === "token") {
      const answer = canceled ? "canceled" : (answers.shift() ?? "pending");
      if (answer !== "connected") return Response.json({ status: answer });
      return Response.json({
        status: "connected",
        encryptedKey: publicEncrypt(
          { key: publicKey, oaepHash: "sha256" },
          Buffer.from(key),
        ).toString("base64"),
        connectionId: randomUUID(),
        agentId: "agent-1",
        orgId: "org-1",
      });
    }
    if (path === "confirm") return Response.json({ connected: true });
    throw new Error(`Unexpected request to ${address}`);
  }) as typeof fetch;
  return { fetcher, calls };
}
const env = { RUNTIME_AUTH_URL: "http://localhost:3000", RUNTIME_API_URL: "http://localhost:8787" };
function options(
  fetcher: typeof fetch,
  extra: { onInterrupt?: (c: () => Promise<void>) => () => void } = {},
) {
  const notes: string[] = [];
  return {
    notes,
    options: {
      fetch: fetcher,
      sleep: async () => undefined,
      notify: (message: string) => notes.push(message),
      interactive: false,
      machine: "ci-setup-laptop",
      onInterrupt: extra.onInterrupt ?? (() => () => undefined),
    },
  };
}
const full: KeyRequest = { name: "CI", access: "full", dailyLimitMicros: 25_000_000 };

test("a key is asked for with exactly its terms, arrives sealed, and is confirmed only when asked", async () => {
  const site = website(["pending", "connected"]);
  const { notes, options: opts } = options(site.fetcher);
  const created = await createKey(full, env, opts);
  expect(created).toMatchObject({
    key,
    keyId,
    agentId: "agent-1",
    orgId: "org-1",
    name: "CI",
    access: "full",
    dailyLimitMicros: 25_000_000,
    expires: null,
  });
  const start = site.calls[0]!;
  expect(start.path).toBe("start");
  expect(start.body).toMatchObject({
    purpose: "key",
    agentName: "CI",
    access: "full",
    dailyLimitMicros: 25_000_000,
    machine: "ci-setup-laptop",
  });
  expect(String(start.body.publicKey)).toContain("BEGIN PUBLIC KEY");
  // The link and the code go to standard error, through notify, never the key.
  expect(notes.join("\n")).toContain("http://localhost:3000/connect?code=ABCD-EF01-2345");
  expect(notes.join("\n")).toContain("ABCD-EF01-2345");
  expect(notes.join("\n")).not.toContain(key);
  expect(site.calls.some((call) => call.path === "confirm")).toBe(false);
  await created.confirm();
  expect(site.calls.at(-1)).toMatchObject({ path: "confirm", auth: `Bearer ${key}` });
  // The request body never carried a private key.
  expect(JSON.stringify(site.calls)).not.toContain("PRIVATE KEY");
});

test("refusal, cancelation and expiry each fail with no key, and the page's rules are checked first", async () => {
  for (const [answer, code] of [
    ["denied", "key_request_declined"],
    ["canceled", "key_request_canceled"],
    ["expired", "key_request_expired"],
  ] as const) {
    const site = website([answer]);
    await expect(createKey(full, env, options(site.fetcher).options)).rejects.toMatchObject({
      code,
    });
    expect(site.calls.some((call) => call.path === "confirm")).toBe(false);
  }
  const site = website([]);
  for (const request of [
    { name: "Reader", access: "read", dailyLimitMicros: 1_000_000 },
    { name: " ", access: "full", dailyLimitMicros: null },
    { name: "x".repeat(81), access: "full", dailyLimitMicros: null },
    { name: "bell\u0007", access: "full", dailyLimitMicros: null },
  ] as KeyRequest[])
    await expect(createKey(request, env, options(site.fetcher).options)).rejects.toMatchObject({
      code: "usage",
    });
  expect(site.calls).toEqual([]);
});

test("an interruption before the key arrives cancels the request; after it arrives it does not", async () => {
  let cancel: (() => Promise<void>) | undefined;
  let listening = false;
  let release = () => undefined as void;
  const site = website(["pending"]);
  const waiting = createKey(full, env, {
    ...options(site.fetcher, {
      onInterrupt: (fn) => {
        cancel = fn;
        listening = true;
        return () => {
          listening = false;
        };
      },
    }).options,
    // The second wait holds until the interruption has been handled.
    sleep: (() => {
      let waits = 0;
      return () =>
        waits++ === 0 ? Promise.resolve() : new Promise<void>((resolve) => (release = resolve));
    })(),
  }).catch((error: unknown) => error);
  for (let i = 0; i < 200 && site.calls.filter((c) => c.path === "token").length < 1; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(listening).toBe(true);
  await cancel!();
  expect(site.calls.at(-1)?.body).toEqual({ action: "cancel", deviceCode: "d".repeat(43) });
  release();
  expect(await waiting).toMatchObject({ code: "key_request_canceled" });
  expect(listening).toBe(false);

  const received = website(["connected"]);
  await createKey(
    full,
    env,
    options(received.fetcher, {
      onInterrupt: () => {
        listening = true;
        return () => {
          listening = false;
        };
      },
    }).options,
  );
  expect(listening).toBe(false);
});

test("a key is only ever approved on Runtime's website or a local one", async () => {
  const site = website(["connected"], { origin: "https://evil.example" });
  await expect(createKey(full, env, options(site.fetcher).options)).rejects.toMatchObject({
    code: "key_request_failed",
  });
  await expect(
    createKey(
      full,
      { RUNTIME_AUTH_URL: "https://evil.example" },
      options(website([]).fetcher).options,
    ),
  ).rejects.toMatchObject({ code: "usage" });
});

test("a daily limit is read in dollars as whole cents, within the keys page's bounds", () => {
  expect(dailyLimitMicros("25")).toBe(25_000_000);
  expect(dailyLimitMicros("$1,000.10")).toBe(1_000_100_000);
  expect(dailyLimitMicros("0.01")).toBe(10_000);
  for (const bad of ["0", "0.001", "-5", "1000000.01", "ten", ""])
    expect(() => dailyLimitMicros(bad)).toThrow(/--daily-limit/);
});

test("the command refuses what the keys page does not offer before asking anything", async () => {
  const out = { json: false, write: () => undefined, error: () => undefined };
  for (const argv of [
    ["keys", "create", "--read-only", "--daily-limit", "5"],
    ["keys", "create", "--expires", "30d"],
    ["keys", "create", "extra"],
    ["keys", "create", "--daily-limit", "free"],
    ["keys", "ls", "extra"],
    ["keys", "revoke"],
    ["keys", "usage"],
    ["keys", "craete"],
  ])
    await expect(run(argv, env, out)).rejects.toMatchObject({ code: "usage" });
  const written: string[] = [];
  expect(await run(["keys", "help"], env, { ...out, write: (text) => written.push(text) })).toBe(0);
  expect(written.join("")).toContain("create [--name <name>] [--read-only] [--daily-limit <usd>]");
  const help: string[] = [];
  await run(["help"], env, { ...out, write: (text) => help.push(text) });
  expect(help.join("")).toContain("keys create");
});

test("--account-wide asks for a key that sees the whole account, and says so when it arrives", async () => {
  const site = website(["connected"]);
  const { options: opts } = options(site.fetcher);
  const created = await createKey({ ...full, reach: "account" }, env, opts);
  expect(created.reach).toBe("account");
  expect(site.calls[0]!.body).toMatchObject({ purpose: "key", access: "full", reach: "account" });
  // Without it the request carries no reach, which the website reads as the
  // ordinary key.
  const plain = website(["connected"]);
  const { options: plainOpts } = options(plain.fetcher);
  expect((await createKey(full, env, plainOpts)).reach).toBe("agent");
  expect(plain.calls[0]!.body.reach).toBeUndefined();
  const written: string[] = [];
  await run(["keys", "help"], env, {
    json: false,
    write: (text) => written.push(text),
    error: () => undefined,
  });
  expect(written.join("")).toContain("--account-wide");
});

test("with a key on this machine, `keys create` makes the key over the API with no browser, and ls, usage and revoke work", async () => {
  const calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  const worker = `rtcloud_${randomUUID()}_${randomBytes(32).toString("base64url")}`;
  const workerId = randomUUID();
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        auth: request.headers.get("authorization"),
        body: request.method === "POST" ? await request.json() : undefined,
      });
      if (request.method === "POST")
        return Response.json({
          key: worker,
          keyId: workerId,
          agentId: randomUUID(),
          orgId: randomUUID(),
          name: "worker-1",
          access: "full",
          reach: "agent",
          dailyLimitMicros: 5_000_000,
          expires: null,
          madeBy: keyId,
        });
      if (url.pathname === "/v1/keys")
        return Response.json({
          keys: [
            {
              keyId: workerId,
              agentId: randomUUID(),
              name: "worker-1",
              access: "full",
              reach: "agent",
              dailyLimitMicros: 5_000_000,
              dailyUsedMicros: 1_250_000,
              madeBy: keyId,
              createdAt: new Date().toISOString(),
              expiresAt: null,
              revokedAt: null,
            },
          ],
        });
      if (url.pathname === "/v1/usage")
        return Response.json({
          unit: "microdollars",
          key: {
            keyId: workerId,
            agentId: randomUUID(),
            name: "worker-1",
            madeBy: keyId,
            revokedAt: null,
            dailyLimitMicros: "5000000",
            dailyUsedMicros: "1250000",
            spentMicros: "1000000",
            heldMicros: "250000",
            runningSandboxes: 1,
            resources: 2,
          },
        });
      return Response.json({ keyId: workerId, revokedAt: new Date().toISOString() });
    },
  });
  try {
    const local = { RUNTIME_API_KEY: key, RUNTIME_API_URL: `http://127.0.0.1:${api.port}` };
    const written: string[] = [];
    const notes: string[] = [];
    const out = {
      json: false,
      write: (t: string) => written.push(t),
      error: (t: string) => notes.push(t),
    };
    expect(
      await run(["keys", "create", "--name", "worker-1", "--daily-limit", "5"], local, out),
    ).toBe(0);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/v1/keys",
      auth: `Bearer ${key}`,
      body: { name: "worker-1", access: "full", reach: "agent", dailyLimitMicros: 5_000_000 },
    });
    // The key alone on stdout, as the browser path prints it.
    expect(written).toEqual([worker]);
    expect(notes.join("")).toContain("made by this machine's key");
    expect(notes.join("")).toContain("daily limit $5.00");
    written.length = 0;
    expect(await run(["keys", "ls"], local, out)).toBe(0);
    expect(written.join("")).toContain("worker-1");
    expect(written.join("")).toContain("$1.25");
    written.length = 0;
    expect(await run(["keys", "usage", workerId], local, out)).toBe(0);
    expect(calls.at(-1)!.path).toBe(`/v1/usage?key=${workerId}`);
    expect(written.join("")).toContain("$1.25 of $5.00");
    expect(await run(["keys", "revoke", workerId], local, out)).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: `/v1/keys/${workerId}` });
  } finally {
    await api.stop(true);
  }
});

test("`keys create --sandbox --actions` makes a key limited to those sandboxes over the API, and refuses what such a key does not take", async () => {
  const calls: unknown[] = [];
  const limited = `rtcloud_${randomUUID()}_${randomBytes(32).toString("base64url")}`;
  const sandbox = randomUUID();
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push(await request.json());
      return Response.json({
        key: limited,
        keyId: randomUUID(),
        agentId: randomUUID(),
        orgId: randomUUID(),
        name: "watcher",
        access: "selected",
        reach: "sandboxes",
        dailyLimitMicros: 2_000_000,
        sandboxes: [sandbox],
        actions: ["get", "create"],
        expires: null,
        madeBy: keyId,
      });
    },
  });
  try {
    const local = { RUNTIME_API_KEY: key, RUNTIME_API_URL: `http://127.0.0.1:${api.port}` };
    const written: string[] = [];
    const notes: string[] = [];
    const out = {
      json: false,
      write: (t: string) => written.push(t),
      error: (t: string) => notes.push(t),
    };
    expect(
      await run(
        [
          "keys",
          "create",
          "--name",
          "watcher",
          "--sandbox",
          sandbox,
          "--actions",
          "get,create",
          "--daily-limit",
          "2",
        ],
        local,
        out,
      ),
    ).toBe(0);
    expect(calls).toEqual([
      {
        name: "watcher",
        sandboxes: [sandbox],
        actions: ["get", "create"],
        dailyLimitMicros: 2_000_000,
      },
    ]);
    expect(written).toEqual([limited]);
    expect(notes.join("")).toContain(`limited to sandbox ${sandbox} for get, create`);
    const quiet = { json: false, write: () => undefined, error: () => undefined };
    for (const extra of ["--account-wide", "--read-only", "--browser"])
      await expect(
        run(["keys", "create", "--sandbox", sandbox, "--actions", "get", extra], local, quiet),
        extra,
      ).rejects.toThrow(`limited to sandboxes reaches only them`);
    await expect(run(["keys", "create", "--sandbox", sandbox], local, quiet)).rejects.toThrow(
      "--actions",
    );
    expect(calls).toHaveLength(1);
  } finally {
    await api.stop(true);
  }
});
