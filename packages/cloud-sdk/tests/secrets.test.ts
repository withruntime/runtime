import { expect, test } from "bun:test";
import { parseSecretRules, run, secretsCommand } from "../src/cli";
import { Runtime } from "../src/client";

/* runtime.secrets and `runtime secrets` against a stub API. The routes are
   tested over Postgres, with the host proxy opening what the API sealed, in
   packages/cloud (secrets-open-ports-postgres.test.ts). */

const SECRET = {
  name: "OPENAI_API_KEY",
  hosts: ["api.openai.com"],
  placeholder: "rtsec_0123456789abcdef0123456789abcdef",
  valueBytes: 12,
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
};

async function withStub(
  answer: (request: Request) => unknown,
  work: (seen: Array<{ line: string; body: string }>) => Promise<void>,
) {
  const original = globalThis.fetch;
  const seen: Array<{ line: string; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({
      line: `${request.method} ${new URL(request.url).pathname}`,
      body: await request.clone().text(),
    });
    // The jobs copies: none, unless a test answers for them.
    if (new URL(request.url).pathname === "/v1/secrets" && request.method === "GET") {
      const own = answer(request);
      return Response.json(Array.isArray(own) ? own : []);
    }
    return Response.json(answer(request));
  }) as typeof fetch;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = original;
  }
}
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
function output() {
  const lines: string[] = [];
  return {
    lines,
    out: { json: false, write: (t: string) => lines.push(t), error: (t: string) => lines.push(t) },
  };
}

test("secrets.set, list and delete call the routes, and set sends the value once", async () => {
  await withStub(
    (request) =>
      request.method === "GET"
        ? { secrets: [SECRET] }
        : request.method === "DELETE"
          ? { name: SECRET.name, deleted: true, enforced: true }
          : { ...SECRET, enforced: true },
    async (seen) => {
      const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
      const saved = await runtime.secrets.set("OPENAI_API_KEY", {
        value: "sk-live",
        hosts: ["api.openai.com"],
      });
      expect(saved.placeholder).toBe(SECRET.placeholder);
      expect(await runtime.secrets.list()).toEqual([SECRET]);
      expect((await runtime.secrets.delete("OPENAI_API_KEY")).deleted).toBe(true);
      expect(seen.map((s) => s.line)).toEqual([
        "PUT /v1/egress-secrets/OPENAI_API_KEY",
        "GET /v1/egress-secrets",
        "GET /v1/secrets",
        "DELETE /v1/egress-secrets/OPENAI_API_KEY",
      ]);
      expect(JSON.parse(seen[0]!.body)).toEqual({ value: "sk-live", hosts: ["api.openai.com"] });
    },
  );
});

test("`runtime secrets set` reads the value from standard input and never takes it as an argument", async () => {
  await withStub(
    () => ({ ...SECRET, header: "Authorization", format: "Bearer {value}", enforced: true }),
    async (seen) => {
      const { lines, out } = output();
      expect(
        await secretsCommand(
          [
            "set",
            "OPENAI_API_KEY",
            "--host",
            "api.openai.com",
            "--header",
            "Authorization",
            "--format",
            "Bearer {value}",
          ],
          env,
          out,
          async () => "sk-from-stdin",
        ),
      ).toBe(0);
      expect(JSON.parse(seen[0]!.body)).toEqual({
        value: "sk-from-stdin",
        hosts: ["api.openai.com"],
        header: "Authorization",
        format: "Bearer {value}",
      });
      expect(lines.join("\n")).toContain(`OPENAI_API_KEY=${SECRET.placeholder}`);
      expect(lines.join("\n")).not.toContain("sk-from-stdin");
    },
  );
  const { out } = output();
  await expect(
    secretsCommand(
      ["set", "K", "--host", "a.example.com", "--value", "x"],
      env,
      out,
      async () => "x",
    ),
  ).rejects.toThrow(/standard input/);
  await expect(secretsCommand(["set", "K"], env, out, async () => "x")).rejects.toThrow(/--host/);
  await expect(
    secretsCommand(["set", "K", "--host", "a.example.com"], env, out, async () => ""),
  ).rejects.toThrow(/empty/);
});

test("`runtime secrets ls` prints names, hosts and placeholders; --json the list", async () => {
  await withStub(
    () => ({ secrets: [SECRET] }),
    async () => {
      const { lines, out } = output();
      expect(await run(["secrets", "ls"], env, out)).toBe(0);
      expect(lines.join("\n")).toMatch(/OPENAI_API_KEY\s+api\.openai\.com\s+-\s+rtsec_/);
      const json: string[] = [];
      await run(["secrets", "ls", "--json"], env, {
        ...out,
        json: true,
        write: (t) => json.push(t),
      });
      expect(JSON.parse(json[0]!)).toEqual([SECRET]);
    },
  );
});

test("`runtime secrets set --allow` sends rules, grouping paths that name the same methods", async () => {
  const rules = [
    { methods: ["GET", "HEAD"], paths: ["/repos/acme/*", "/user"] },
    { paths: ["/v1/chat/completions"] },
  ];
  await withStub(
    () => ({ ...SECRET, rules, enforced: true }),
    async (seen) => {
      const { lines, out } = output();
      expect(
        await secretsCommand(
          [
            "set",
            "GITHUB_TOKEN",
            "--host",
            "api.github.com",
            "--allow",
            "GET,HEAD /repos/acme/*",
            "--allow",
            "/v1/chat/completions",
            "--allow",
            "head,get /user",
          ],
          env,
          out,
          async () => "ghp_x",
        ),
      ).toBe(0);
      expect(JSON.parse(seen[0]!.body)).toEqual({
        value: "ghp_x",
        hosts: ["api.github.com"],
        rules,
      });
      expect(lines.join("\n")).toContain(
        "Only these requests get it: GET,HEAD /repos/acme/* /user; /v1/chat/completions.",
      );
    },
  );
  expect(parseSecretRules(["/a", "/a", "GET /b"])).toEqual([
    { paths: ["/a"] },
    { methods: ["GET"], paths: ["/b"] },
  ]);
  for (const bad of ["", "GET", "GET /a /b", "a/b", "GET a"])
    expect(() => parseSecretRules([bad])).toThrow(/--allow takes optional methods and one path/);
});

test("`runtime secrets ls` shows each secret's rules", async () => {
  await withStub(
    () => ({ secrets: [{ ...SECRET, rules: [{ methods: ["POST"], paths: ["/v1/*"] }] }] }),
    async () => {
      const { lines, out } = output();
      expect(await run(["secrets", "ls"], env, out)).toBe(0);
      expect(lines.join("\n")).toMatch(/rtsec_\w+\s+POST \/v1\/\*/);
    },
  );
});
