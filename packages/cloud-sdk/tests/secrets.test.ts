import { expect, test } from "bun:test";
import { parseSecretRules, run, scopeText, secretsCommand } from "../src/cli";
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
