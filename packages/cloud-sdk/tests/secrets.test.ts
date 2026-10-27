import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecretRules, run, scopeText, secretsCommand } from "../src/cli";
import { Runtime } from "../src/client";
import { errorFor } from "../src/errors";

/* runtime.secrets and `runtime secrets` against a stub API. The routes are
   tested over Postgres, with the host proxy opening what the API sealed, in
   packages/cloud (secrets-open-ports-postgres.test.ts). */

const SECRET = {
  name: "OPENAI_API_KEY",
  hosts: ["api.openai.com"],
  placeholder: "rtsec_0123456789abcdef0123456789abcdef",
  valueBytes: 12,
  exposed: false,
  version: 1,
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
    // A test that answers with a Response (a refusal) is answered so.
    const answered = answer(request);
    return answered instanceof Response ? answered : Response.json(answered);
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

test("`runtime secrets set --only-label/--only-sandbox` scopes a secret, --all-sandboxes widens it, and ls says who gets it", async () => {
  const HUB = "ef01c6ef-6648-450b-acd2-6fe82ac31960";
  const only = { labels: [{ role: "hub" }, { purpose: "agent", tier: "x" }], sandboxes: [HUB] };
  await withStub(
    () => ({ ...SECRET, only, enforced: true }),
    async (seen) => {
      const { lines, out } = output();
      expect(
        await secretsCommand(
          [
            "set",
            "SLACK_APP_TOKEN",
            "--host",
            "slack.com",
            "--only-label",
            "role=hub",
            "--only-label",
            "purpose=agent,tier=x",
            "--only-sandbox",
            HUB.toUpperCase(),
          ],
          env,
          out,
          async () => "xapp_x",
        ),
      ).toBe(0);
      expect(JSON.parse(seen[0]!.body)).toEqual({ value: "xapp_x", hosts: ["slack.com"], only });
      expect(lines.join("\n")).toContain(
        `Only these sandboxes get it and see OPENAI_API_KEY=${SECRET.placeholder}: role=hub | purpose=agent,tier=x | ${HUB}.`,
      );
    },
  );
  // No flag: nothing sent, so the scope the secret has stays.
  await withStub(
    () => ({ ...SECRET, enforced: true }),
    async (seen) => {
      const { out } = output();
      await secretsCommand(["set", "K", "--host", "a.example.com"], env, out, async () => "v");
      expect(JSON.parse(seen[0]!.body)).not.toHaveProperty("only");
      await secretsCommand(
        ["set", "K", "--host", "a.example.com", "--all-sandboxes"],
        env,
        out,
        async () => "v",
      );
      expect(JSON.parse(seen[1]!.body).only).toEqual({});
    },
  );
  const { out } = output();
  for (const bad of [
    ["--only-label", "role"],
    ["--only-label", "=hub"],
    ["--only-sandbox", "agents-hub"],
    ["--only-label", "role=hub", "--all-sandboxes"],
  ])
    await expect(
      secretsCommand(["set", "K", "--host", "a.example.com", ...bad], env, out, async () => "v"),
    ).rejects.toThrow(/--only-label|--only-sandbox|--all-sandboxes/);
  expect(scopeText(undefined)).toBe("all");
  await withStub(
    () => ({ secrets: [{ ...SECRET, only: { labels: [{ role: "hub" }] } }] }),
    async () => {
      const { lines, out: listed } = output();
      expect(await run(["secrets", "ls"], env, listed)).toBe(0);
      expect(lines.join("\n")).toMatch(/rtsec_\w+\s+-\s+role=hub/);
    },
  );
});

test("`runtime secrets set --env` puts a secret in another variable, which ls shows; it needs --host", async () => {
  const only = { labels: [{ repo: "a" }] };
  await withStub(
    () => ({ ...SECRET, name: "GITHUB_TOKEN_A", env: "GITHUB_TOKEN", only, enforced: true }),
    async (seen) => {
      const { lines, out } = output();
      expect(
        await secretsCommand(
          [
            "set",
            "GITHUB_TOKEN_A",
            "--host",
            "api.github.com",
            "--only-label",
            "repo=a",
            "--env",
            "GITHUB_TOKEN",
          ],
          env,
          out,
          async () => "ghp_a",
        ),
      ).toBe(0);
      expect(JSON.parse(seen[0]!.body)).toEqual({
        value: "ghp_a",
        hosts: ["api.github.com"],
        only,
        env: "GITHUB_TOKEN",
      });
      expect(lines.join("\n")).toContain(
        `Only these sandboxes get it and see GITHUB_TOKEN=${SECRET.placeholder}: repo=a.`,
      );
    },
  );
  await withStub(
    () => ({ secrets: [{ ...SECRET, name: "GITHUB_TOKEN_A", env: "GITHUB_TOKEN" }] }),
    async () => {
      const { lines, out } = output();
      expect(await run(["secrets", "ls"], env, out)).toBe(0);
      expect(lines.join("\n")).toContain("GITHUB_TOKEN_A (as GITHUB_TOKEN)");
    },
  );
  const { out } = output();
  await expect(
    secretsCommand(["set", "K", "--jobs", "--env", "OTHER"], env, out, async () => "v"),
  ).rejects.toThrow("--env names the variable sandboxes see");
  await expect(
    secretsCommand(
      ["set", "K", "--keep-value", "--host", "a.example.com", "--env", "OTHER"],
      env,
      out,
      async () => "v",
    ),
  ).rejects.toThrow("--keep-value changes only");
});

test("`runtime secrets scope` changes who gets a secret without reading a value", async () => {
  await withStub(
    () => ({ ...SECRET, only: { labels: [{ role: "hub" }] }, enforced: true }),
    async (seen) => {
      const { lines, out } = output();
      expect(
        await secretsCommand(
          ["scope", "SLACK_APP_TOKEN", "--only-label", "role=hub"],
          env,
          out,
          () => {
            throw new Error("scope reads no value");
          },
        ),
      ).toBe(0);
      expect(seen[0]!.line).toBe("PUT /v1/egress-secrets/SLACK_APP_TOKEN/sandboxes");
      expect(JSON.parse(seen[0]!.body)).toEqual({ labels: [{ role: "hub" }] });
      expect(lines.join("\n")).toContain("OPENAI_API_KEY: only role=hub.");
      await secretsCommand(["scope", "K", "--all-sandboxes"], env, out);
      expect(JSON.parse(seen[1]!.body)).toEqual({});
    },
  );
  const { out } = output();
  await expect(secretsCommand(["scope", "K"], env, out)).rejects.toThrow(/Say who gets it/);
});

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBAQAB\n-----END RSA PRIVATE KEY-----";

test("secrets.set sends githubApp, git and api as given, and list returns them", async () => {
  const githubApp = {
    id: 12345,
    installation: 67890,
    repositories: ["runtime-cloud"],
    permissions: { contents: "write", checks: "read" } as const,
    api: "https://github.example.com/api/v3",
  };
  const git = { push: ["refs/heads/task/{label.task}", "refs/heads/task/{label.task}--*"] };
  const api = {
    callsPerHour: 500,
    writesPerHour: 0,
    keep: 100,
    copies: true,
    graphql: { path: "/api/graphql", mutations: ["createPullRequest"] },
  };
  await withStub(
    (request) =>
      request.method === "GET"
        ? { secrets: [{ ...SECRET, githubApp, git, api }] }
        : { ...SECRET, githubApp, git, api, enforced: true },
    async (seen) => {
      const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
      const saved = await runtime.secrets.set("GITHUB_APP", {
        value: PEM,
        hosts: ["api.github.com", "github.com"],
        githubApp,
        git,
        api,
      });
      expect(saved.githubApp).toEqual(githubApp);
      expect(saved.git?.push).toHaveLength(2);
      expect(saved.api?.graphql?.mutations).toEqual(["createPullRequest"]);
      expect(JSON.parse(seen[0]!.body)).toEqual({
        value: PEM,
        hosts: ["api.github.com", "github.com"],
        githubApp,
        git,
        api,
      });
      const [listed] = await runtime.secrets.list();
      expect(listed?.githubApp?.installation).toBe(67890);
      expect(listed?.git).toEqual(git);
      expect(listed?.api?.copies).toBe(true);
    },
  );
});

const COPY = {
  id: "sec_1",
  name: "HUB_KEY",
  ownerId: "p",
  createdBy: "agent_a",
  usableBy: [] as string[] | "all",
  version: 1,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
};

test("secrets.share finds the live jobs copy and replaces who may use it", async () => {
  await withStub(
    (request) =>
      request.method === "GET" ? [COPY] : { ...COPY, usableBy: ["agent_b", "agent_c"] },
    async (seen) => {
      const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
      const shared = await runtime.secrets.share("HUB_KEY", ["agent_b", "agent_c"]);
      expect(shared.usableBy).toEqual(["agent_b", "agent_c"]);
      expect(seen.map((s) => s.line)).toEqual(["GET /v1/secrets", "POST /v1/secrets/sec_1:share"]);
      expect(JSON.parse(seen[1]!.body)).toEqual({ agents: ["agent_b", "agent_c"] });
      await runtime.secrets.share("HUB_KEY", "all");
      expect(JSON.parse(seen[3]!.body)).toEqual({ agents: "all" });
    },
  );
  await withStub(
    () => [],
    async () => {
      const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
      await expect(runtime.secrets.share("NOPE", [])).rejects.toThrow(/no copy for jobs/);
    },
  );
});

test("`runtime secrets share` takes --agent, --all or --none, and says who may use it", async () => {
  const answers: Array<string[] | "all"> = [[], ["a1", "a2"], "all"];
  await withStub(
    (request) => (request.method === "GET" ? [COPY] : { ...COPY, usableBy: answers.shift()! }),
    async (seen) => {
      const { lines, out } = output();
      expect(await secretsCommand(["share", "HUB_KEY", "--none"], env, out)).toBe(0);
      expect(JSON.parse(seen[1]!.body)).toEqual({ agents: [] });
      expect(lines.at(-1)).toBe("HUB_KEY: only the key that stored it.");
      expect(
        await secretsCommand(["share", "HUB_KEY", "--agent", "a1", "--agent", "a2"], env, out),
      ).toBe(0);
      expect(JSON.parse(seen[3]!.body)).toEqual({ agents: ["a1", "a2"] });
      expect(lines.at(-1)).toBe("HUB_KEY: only the key that stored it, and 2 named agents.");
      expect(await secretsCommand(["share", "HUB_KEY", "--all"], env, out)).toBe(0);
      expect(JSON.parse(seen[5]!.body)).toEqual({ agents: "all" });
      expect(lines.at(-1)).toBe("HUB_KEY: every key of yours.");
    },
  );
  const { out } = output();
  await expect(secretsCommand(["share", "K"], env, out)).rejects.toThrow(/Say who may use it/);
  await expect(secretsCommand(["share", "K", "--all", "--none"], env, out)).rejects.toThrow(
    /Say who may use it/,
  );
});

test("`runtime secrets set --keep-value` narrows hosts and rules without reading a value", async () => {
  const rules = [
    { methods: ["GET"], paths: ["/acme/repo.git/info/refs"] },
    { methods: ["POST"], paths: ["/acme/repo.git/git-upload-pack"] },
  ];
  await withStub(
    () => ({ ...SECRET, hosts: ["github.com"], rules, enforced: true }),
    async (seen) => {
      const { lines, out } = output();
      expect(
        await secretsCommand(
          [
            "set",
            "GIT_BASIC",
            "--keep-value",
            "--allow",
            "GET /acme/repo.git/info/refs",
            "--allow",
            "POST /acme/repo.git/git-upload-pack",
          ],
          env,
          out,
          () => {
            throw new Error("narrowing reads no value");
          },
        ),
      ).toBe(0);
      expect(seen[0]!.line).toBe("PUT /v1/egress-secrets/GIT_BASIC/rules");
      expect(JSON.parse(seen[0]!.body)).toEqual({ rules });
      expect(lines.join("\n")).toContain("its value is unchanged. It goes only to github.com");
      await secretsCommand(["set", "K", "--keep-value", "--host", "github.com"], env, out);
      expect(JSON.parse(seen[1]!.body)).toEqual({ hosts: ["github.com"] });
    },
  );
  const { out } = output();
  await expect(secretsCommand(["set", "K", "--keep-value"], env, out)).rejects.toThrow(
    /give the narrower --host and\/or --allow/,
  );
  await expect(
    secretsCommand(["set", "K", "--keep-value", "--host", "a.io", "--header", "x"], env, out),
  ).rejects.toThrow(/only --host and --allow/);
  await expect(
    secretsCommand(["set", "K", "--host", "a.io"], env, out, async () => ""),
  ).rejects.toThrow(/add --keep-value/);
});

test("`runtime secrets scope --only-app` gives a secret to every copy of an App, and ls names the App", async () => {
  const APP = "0b6f3c1e-2d4a-4e5f-9a7b-8c9d0e1f2a3b";
  await withStub(
    () => ({ ...SECRET, only: { apps: [APP] }, enforced: true }),
    async (seen) => {
      const { lines, out } = output();
      expect(
        await secretsCommand(
          ["scope", "OPENAI_API_KEY", "--only-app", APP.toUpperCase()],
          env,
          out,
        ),
      ).toBe(0);
      expect(seen[0]!.line).toBe("PUT /v1/egress-secrets/OPENAI_API_KEY/sandboxes");
      expect(JSON.parse(seen[0]!.body)).toEqual({ apps: [APP] });
      expect(lines.join("\n")).toContain(`OPENAI_API_KEY: only app ${APP}.`);
      await secretsCommand(
        ["set", "K", "--host", "a.example.com", "--only-app", APP, "--only-label", "role=hub"],
        env,
        out,
        async () => "v",
      );
      expect(JSON.parse(seen[1]!.body).only).toEqual({ labels: [{ role: "hub" }], apps: [APP] });
    },
  );
  const { out } = output();
  for (const bad of [
    ["--only-app", "agents-hub"],
    ["--only-app", APP, "--all-sandboxes"],
  ])
    await expect(secretsCommand(["scope", "K", ...bad], env, out)).rejects.toThrow(
      /--only-app|--all-sandboxes/,
    );
  expect(scopeText({ apps: [APP], sandboxes: ["s1"] })).toBe(`s1 | app ${APP}`);
});

test("secrets.list pages by limit and after, and reads every page without them", async () => {
  // 24 October 2026: the MCP tool listed limit and its list refused it.
  const named = (name: string) => ({ ...SECRET, name });
  const pages: Record<string, unknown> = {
    "": { secrets: [named("A")], next: "A" },
    after_A: { secrets: [named("B")], next: null },
    limit_1: { secrets: [named("A")], next: "A" },
  };
  await withStub(
    (request) => {
      const query = new URL(request.url).searchParams;
      const key = [...query].map(([k, v]) => `${k}_${v}`).join("&");
      return pages[key] ?? { secrets: [], next: null };
    },
    async (seen) => {
      const runtime = new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });
      expect((await runtime.secrets.list()).map((s) => s.name)).toEqual(["A", "B"]);
      expect((await runtime.secrets.list({ limit: 1 })).map((s) => s.name)).toEqual(["A"]);
      expect((await runtime.secrets.list({ after: "A" })).map((s) => s.name)).toEqual(["B"]);
      expect(seen.length).toBe(4);
    },
  );
});

test("`runtime secrets ls --limit 1 --after` pages by name and says how to go on", async () => {
  const named = (name: string) => ({ ...SECRET, name });
  await withStub(
    () => ({ secrets: [named("C_KEY"), named("A_KEY"), named("B_KEY")], next: null }),
    async () => {
      const { lines, out } = output();
      expect(await run(["secrets", "ls", "--limit", "1", "--after", "A_KEY"], env, out)).toBe(0);
      const text = lines.join("\n");
      expect(text).toContain("B_KEY");
      expect(text).not.toContain("A_KEY api");
      expect(text).not.toMatch(/^C_KEY/m);
      expect(text).toContain("secrets ls --limit 1 --after B_KEY");
      await expect(run(["secrets", "ls", "--limit", "101"], env, output().out)).rejects.toThrow(
        "--limit takes 1 to 100 secrets a page.",
      );
    },
  );
});

/* The real-value kind (25 October 2026): `exposed` gives the machines the
   value itself, with no hosts, and only to the sandboxes and Apps it names
   by id; every secret has a version, and a write may name the one it
   replaces. */
const WORKER = "5d2c8a1e-7b3f-4c6d-9e0a-1f2b3c4d5e6f";
const EXPOSED = {
  ...SECRET,
  name: "DB_PASSWORD",
  env: "PGPASSWORD",
  hosts: [],
  only: { sandboxes: [WORKER] },
  exposed: true,
  version: 3,
  valueBytes: 16,
};
const FAKE_KEY = "-----BEGIN FAKE KEY-----\nAAAA\nBBBB\n-----END FAKE KEY-----\n";
const sdk = () => new Runtime({ apiKey: "rk_x", baseUrl: "https://api.example.test" });

test("secrets.set with exposed sends the value, exposed and env with no hosts; expectedVersion goes too", async () => {
  await withStub(
    () => ({ ...EXPOSED, enforced: true }),
    async (seen) => {
      const runtime = sdk();
      const saved = await runtime.secrets.set("DB_PASSWORD", {
        value: "fake-db-password",
        exposed: true,
        only: { sandboxes: [WORKER] },
        env: "PGPASSWORD",
      });
      expect(saved.exposed).toBe(true);
      expect(saved.version).toBe(3);
      // A replacement may leave only out: it keeps the scope it has.
      await runtime.secrets.set("DB_PASSWORD", {
        value: "fake-db-password-2",
        exposed: true,
        expectedVersion: 3,
      });
      await runtime.secrets.set("OPENAI_API_KEY", {
        value: "fake-openai-key",
        hosts: ["api.openai.com"],
        expectedVersion: 0,
      });
      expect(seen.map((s) => s.line)).toEqual([
        "PUT /v1/egress-secrets/DB_PASSWORD",
        "PUT /v1/egress-secrets/DB_PASSWORD",
        "PUT /v1/egress-secrets/OPENAI_API_KEY",
      ]);
      expect(JSON.parse(seen[0]!.body)).toEqual({
        value: "fake-db-password",
        exposed: true,
        only: { sandboxes: [WORKER] },
        env: "PGPASSWORD",
      });
      expect(JSON.parse(seen[1]!.body)).toEqual({
        value: "fake-db-password-2",
        exposed: true,
        expectedVersion: 3,
      });
      expect(JSON.parse(seen[2]!.body)).toEqual({
        value: "fake-openai-key",
        hosts: ["api.openai.com"],
        expectedVersion: 0,
      });
      // Neither hosts nor exposed nor jobs: refused before anything is sent.
      await expect(runtime.secrets.set("K", { value: "v" } as never)).rejects.toThrow(
        /exposed: true/,
      );
      // A jobs-only write has no sandboxes' copy whose version to check.
      await expect(
        runtime.secrets.set("K", { value: "v", jobs: true, expectedVersion: 1 }),
      ).rejects.toThrow(/expectedVersion is the version of the sandboxes' copy/);
      expect(seen.length).toBe(3);
    },
  );
});

test("secrets.get reads GET /v1/egress-secrets/{name} and the jobs copy; a 404 there is no sandboxes' copy", async () => {
  await withStub(
    () => EXPOSED,
    async (seen) => {
      const found = await sdk().secrets.get("DB_PASSWORD");
      expect(found).toEqual({ name: "DB_PASSWORD", sandboxes: EXPOSED, jobs: null });
      expect(seen.map((s) => s.line).sort()).toEqual([
        "GET /v1/egress-secrets/DB_PASSWORD",
        "GET /v1/secrets",
      ]);
    },
  );
  const COPY = {
    id: "sec_1",
    name: "JOB_ONLY",
    ownerId: "u1",
    createdBy: "a1",
    usableBy: "all" as const,
    version: 2,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  };
  const missing = () =>
    Response.json(
      { error: { code: "not_found", message: "No secret named JOB_ONLY." } },
      { status: 404 },
    );
  await withStub(
    (request) => (new URL(request.url).pathname === "/v1/secrets" ? [COPY] : missing()),
    async () => {
      expect(await sdk().secrets.get("JOB_ONLY")).toEqual({
        name: "JOB_ONLY",
        sandboxes: null,
        jobs: COPY,
      });
    },
  );
  await withStub(missing, async () => {
    await expect(sdk().secrets.get("NOPE")).rejects.toThrow("No secret named NOPE.");
  });
});

test("`runtime secrets set --exposed` reads several lines verbatim and sends no hosts", async () => {
  await withStub(
    () => ({ ...EXPOSED, name: "DEPLOY_KEY", env: "SSH_KEY", enforced: true }),
    async (seen) => {
      const { lines, out } = output();
      const asked: boolean[] = [];
      expect(
        await secretsCommand(
          [
            "set",
            "DEPLOY_KEY",
            "--exposed",
            "--only-sandbox",
            WORKER,
            "--env",
            "SSH_KEY",
            "--expected-version",
            "3",
          ],
          env,
          out,
          async (verbatim) => {
            asked.push(verbatim);
            return `  ${FAKE_KEY}`;
          },
        ),
      ).toBe(0);
      expect(asked).toEqual([true]);
      expect(JSON.parse(seen[0]!.body)).toEqual({
        value: `  ${FAKE_KEY}`,
        exposed: true,
        only: { sandboxes: [WORKER] },
        env: "SSH_KEY",
        expectedVersion: 3,
      });
      const text = lines.join("\n");
      expect(text).toContain(
        `Stored DEPLOY_KEY, version 3. Only these get its value in SSH_KEY: ${WORKER}.`,
      );
      expect(text).not.toContain("AAAA");
    },
  );
  // The placeholder kind still reads one cleaned line.
  await withStub(
    () => ({ ...SECRET, version: 1, exposed: false, enforced: true }),
    async () => {
      const asked: boolean[] = [];
      await secretsCommand(
        ["set", "OPENAI_API_KEY", "--host", "api.openai.com"],
        env,
        output().out,
        async (verbatim) => {
          asked.push(verbatim);
          return "fake-openai-key";
        },
      );
      expect(asked).toEqual([false]);
    },
  );
});

test("`runtime secrets set --from-file` reads a real value byte for byte, a placeholder secret's cleaned", async () => {
  const folder = await mkdtemp(join(tmpdir(), "runtime-secret-"));
  try {
    const file = join(folder, "key.pem");
    await writeFile(file, FAKE_KEY);
    const never = async (): Promise<string> => {
      throw new Error("standard input was read");
    };
    await withStub(
      () => ({ ...EXPOSED, enforced: true }),
      async (seen) => {
        const APP = "0b6f3c1e-2d4a-4e5f-9a7b-8c9d0e1f2a3b";
        await secretsCommand(
          ["set", "DB_PASSWORD", "--exposed", "--only-app", APP, "--from-file", file],
          env,
          output().out,
          never,
        );
        expect(JSON.parse(seen[0]!.body)).toEqual({
          value: FAKE_KEY,
          exposed: true,
          only: { apps: [APP] },
        });
        await writeFile(file, "fake-token\n");
        await secretsCommand(
          ["set", "TOKEN", "--host", "api.example.com", "--from-file", file],
          env,
          output().out,
          never,
        );
        expect(JSON.parse(seen[1]!.body)).toEqual({
          value: "fake-token",
          hosts: ["api.example.com"],
        });
      },
    );
    await expect(
      secretsCommand(
        ["set", "K", "--exposed", "--from-file", join(folder, "missing.pem")],
        env,
        output().out,
        never,
      ),
    ).rejects.toThrow(/--from-file could not read/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("`runtime secrets set --exposed` refuses what only a proxy secret takes, and --jobs", async () => {
  const { out } = output();
  const read = async () => "fake-db-password";
  for (const extra of [
    ["--host", "a.com"],
    ["--header", "Authorization"],
    ["--allow", "/v1/*"],
  ])
    await expect(
      secretsCommand(["set", "K", "--exposed", ...extra], env, out, read),
    ).rejects.toThrow(
      `A real value (--exposed) is given to the machines as it is, so it takes none of ${extra[0]}`,
    );
  await expect(secretsCommand(["set", "K", "--exposed", "--jobs"], env, out, read)).rejects.toThrow(
    /two separate copies/,
  );
  await expect(
    secretsCommand(["set", "K", "--exposed", "--keep-value", "--host", "a.com"], env, out, read),
  ).rejects.toThrow("--keep-value changes only");
  await expect(
    secretsCommand(["set", "K", "--jobs", "--expected-version", "2"], env, out, read),
  ).rejects.toThrow(/--expected-version is the version of the sandboxes' copy/);
  await expect(
    secretsCommand(["rotate", "K", "--expected-version", "2"], env, out, read),
  ).rejects.toThrow(/rotate replaces the copy for jobs/);
  await expect(
    secretsCommand(["set", "K", "--exposed", "--expected-version", "two"], env, out, read),
  ).rejects.toThrow("--expected-version must be a whole number.");
});

test("`runtime secrets set --exposed` goes only to sandboxes and Apps named by id; scope alone is the API's to refuse", async () => {
  const { out } = output();
  const read = async () => "fake-db-password";
  // Every sandbox, or a label any key could give its own sandbox: refused
  // before the value is read or anything is sent.
  for (const extra of [
    ["--all-sandboxes"],
    ["--only-label", "role=db"],
    ["--only-sandbox", WORKER, "--only-label", "role=db"],
  ])
    await withStub(
      () => {
        throw new Error("nothing is sent");
      },
      async (seen) => {
        await expect(
          secretsCommand(["set", "K", "--exposed", ...extra], env, out, async () => {
            throw new Error("the value was read");
          }),
        ).rejects.toThrow(
          "A real value (--exposed) goes only to the sandboxes and Apps you name by id, with --only-sandbox and --only-app",
        );
        expect(seen).toEqual([]);
      },
    );
  // A replacement may name none (it keeps its scope); a new one without
  // any gets the API's answer, word for word.
  const refusal =
    "A secret given to machines as its real value needs only, naming the sandboxes or Apps that get it by id (only.sandboxes, only.apps), and no labels.";
  await withStub(
    () =>
      Response.json(
        { error: { code: "invalid_request", message: refusal, details: { field: "only" } } },
        { status: 400 },
      ),
    async (seen) => {
      await expect(secretsCommand(["set", "K", "--exposed"], env, out, read)).rejects.toThrow(
        refusal,
      );
      expect(JSON.parse(seen[0]!.body)).toEqual({ value: "fake-db-password", exposed: true });
      // Which machines get a real value changes only with the value: the
      // API refuses scope alone, and the CLI makes no other call first.
      await expect(
        secretsCommand(["scope", "DB_PASSWORD", "--only-sandbox", WORKER], env, out),
      ).rejects.toThrow(refusal);
      expect(seen.map((s) => s.line)).toEqual([
        "PUT /v1/egress-secrets/K",
        "PUT /v1/egress-secrets/DB_PASSWORD/sandboxes",
      ]);
    },
  );
});

test("`runtime secrets get` prints the kind and version; ls shows both", async () => {
  await withStub(
    (request) =>
      new URL(request.url).pathname === "/v1/egress-secrets"
        ? { secrets: [EXPOSED, { ...SECRET, exposed: false, version: 1 }] }
        : EXPOSED,
    async (seen) => {
      const { lines, out } = output();
      expect(await secretsCommand(["get", "DB_PASSWORD"], env, out)).toBe(0);
      expect(seen.map((s) => s.line)).toContain("GET /v1/egress-secrets/DB_PASSWORD");
      const text = lines.join("\n");
      expect(text).toMatch(/kind\s+real value/);
      expect(text).toMatch(/version\s+3/);
      expect(text).toMatch(/variable\s+PGPASSWORD/);
      expect(text).toMatch(/size\s+16 bytes/);
      const listed = output();
      expect(await run(["secrets", "ls"], env, listed.out)).toBe(0);
      const rows = listed.lines.join("\n");
      expect(rows).toMatch(
        new RegExp(
          `DB_PASSWORD \\(as PGPASSWORD\\)\\s+-\\s+-\\s+rtsec_\\w+\\s+-\\s+${WORKER}\\s+real value\\s+v3`,
        ),
      );
      expect(rows).toMatch(/OPENAI_API_KEY\s+api\.openai\.com.*added on the way out\s+v1/);
    },
  );
});

test("secret_withheld (a host that cannot give a machine its real value right now) is retryable", () => {
  const error = errorFor(503, {
    error: { code: "secret_withheld", message: "The value could not be given yet." },
  });
  expect(error.retryable).toBe(true);
});
