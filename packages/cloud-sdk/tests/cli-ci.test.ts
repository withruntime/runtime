import { expect, test } from "bun:test";
import { run } from "../src/cli";

/* `runtime ci` against a stub API: what each command sends, and what a
   person reads: checks newest first with their jobs by state, a check's
   jobs in plan order, a job's log with where its failure's sandbox is kept,
   and refusals of a bad commit or state before anything is sent; and the
   repositories with the Apps each trusts. 20 October 2026: no command listed
   CI/CD's repositories or their trusted Apps, and the hub's App went
   untrusted on our own repository with no way to see it short of curl. */

const REPO = "11111111-1111-4111-8111-111111111111";
const CHECK = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const SANDBOX = "44444444-4444-4444-8444-444444444444";
const SHA = "a".repeat(40);
const check = {
  id: CHECK,
  repositoryId: REPO,
  repository: "acme/web",
  commit: SHA,
  branch: "feature",
  event: "pull_request",
  pullRequest: 7,
  baseCommit: null,
  actor: "octocat",
  trusted: true,
  waiting: false,
  approvedBy: null,
  approvedAt: null,
  landed: false,
  state: "failed",
  reason: "test failed",
  counts: { passed: 1, failed: 1 },
  machines: {
    reused: 2,
    pooled: 0,
    forked: 5,
    forks: 1,
    created: 0,
    kept: 7,
    firstMs: 120,
    readyMs: 900,
    firstTestMs: 4100,
    lineMs: 0,
  },
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_012_000,
  startedAt: 1_760_000_000_000,
  endedAt: 1_760_000_012_500,
};
const job = {
  id: JOB,
  checkId: CHECK,
  repositoryId: REPO,
  name: "test",
  part: 2,
  parts: 2,
  needs: ["lint"],
  command: "bun test",
  cacheKey: null,
  state: "failed",
  cachedFrom: null,
  exitCode: 1,
  reason: null,
  sandboxIds: [SANDBOX],
  githubCheckRun: null,
  review: null,
  ms: 4100,
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1,
  endedAt: 2,
};

type Sent = { method: string; path: string; query: URLSearchParams; body: unknown };
async function withStub(
  routes: (sent: Sent) => unknown,
  work: (lines: string[], sent: Sent[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    const call = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      body: text ? JSON.parse(text) : undefined,
    };
    sent.push(call);
    const answer = await routes(call);
    if (answer === undefined)
      return Response.json(
        { error: { code: "route_not_found", message: url.pathname } },
        { status: 404 },
      );
    return Response.json(answer);
  }) as typeof fetch;
  const lines: string[] = [];
  try {
    await work(lines, sent);
  } finally {
    globalThis.fetch = original;
  }
}
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
const out = (lines: string[], json = false) => ({
  json,
  write: (t: string) => lines.push(t),
  error: (t: string) => lines.push(`ERR ${t}`),
});

test("the help lists CI/CD, and it has its own", async () => {
  const lines: string[] = [];
  expect(await run(["help"], env, out(lines))).toBe(0);
  expect(lines.join("\n")).toMatch(/^ {2}ci {9}CI\/CD/m);
  const own: string[] = [];
  expect(await run(["ci", "help"], env, out(own))).toBe(0);
  expect(own[0]).toStartWith("runtime ci <command>");
});

test("connect sends the repository and its settings, and prints its id", async () => {
  await withStub(
    ({ method, path, body }) =>
      method === "POST" && path === "/v1/ci/repositories"
        ? {
            id: REPO,
            repository: "acme/web",
            productionBranch: "trunk",
            configPath: ".runtime/ci.yml",
            state: "connected",
            ...(body as object),
          }
        : undefined,
    async (lines, sent) => {
      const code = await run(
        ["ci", "connect", "acme/web", "--branch", "trunk", "--config", ".runtime/ci.yml"],
        env,
        out(lines),
      );
      expect(code).toBe(0);
      expect(sent[0]!.body).toEqual({
        repository: "acme/web",
        productionBranch: "trunk",
        configPath: ".runtime/ci.yml",
      });
      expect(lines.at(-1)).toBe(REPO);
    },
  );
});

test("ls lists checks newest first with their filters, and refuses a short commit or unknown state", async () => {
  await withStub(
    ({ method, path }) =>
      method === "GET" && path === "/v1/ci/checks"
        ? { data: [check], nextCursor: null }
        : undefined,
    async (lines, sent) => {
      expect(
        await run(
          ["ci", "ls", "--repository", REPO, "--pr", "7", "--state", "failed", "--commit", SHA],
          env,
          out(lines),
        ),
      ).toBe(0);
      const q = sent[0]!.query;
      expect([
        q.get("repositoryId"),
        q.get("pullRequest"),
        q.getAll("state"),
        q.get("commit"),
      ]).toEqual([REPO, "7", ["failed"], SHA]);
      expect(q.get("limit")).toBe("20");
      const text = lines.join("\n");
      expect(text).toContain("#7");
      expect(text).toContain("1 passed, 1 failed");
      expect(text).toContain("12.5s");
    },
  );
  await expect(run(["ci", "ls", "--commit", "abc"], env, out([]))).rejects.toThrow("full sha");
  await expect(run(["ci", "ls", "--state", "faild"], env, out([]))).rejects.toThrow("failed");
});

test("get shows a check's jobs in plan order; logs prints a job's log and where its sandbox is kept", async () => {
  await withStub(
    ({ method, path }) =>
      method !== "GET"
        ? undefined
        : path === `/v1/ci/checks/${CHECK}`
          ? { ...check, jobs: [job] }
          : path === `/v1/ci/jobs/${JOB}`
            ? { ...job, log: "1 failed: tests/a.test.ts" }
            : undefined,
    async (lines) => {
      expect(await run(["ci", "get", CHECK], env, out(lines))).toBe(0);
      expect(lines.join("\n")).toContain("test (2/2)");
      expect(lines.join("\n")).toContain("failed (test failed)");
      expect(lines.join("\n")).toContain(
        "machines: 2 its pull request's own, 5 forked in 1; first in 0.12s, first test at 4.10s; 7 kept for the next push",
      );
      lines.length = 0;
      expect(await run(["ci", "logs", JOB], env, out(lines))).toBe(0);
      expect(lines[0]).toBe("1 failed: tests/a.test.ts\n");
      expect(lines[1]).toBe("ERR [test 2/2 failed, exit code 1]");
      expect(lines[2]).toContain(`sandboxes wake ${SANDBOX}`);
    },
  );
});

test("checks, check and cancel: the words the CI/CD tool says, sent as ls, get and the check's cancel", async () => {
  await withStub(
    ({ method, path }) =>
      method === "GET" && path === "/v1/ci/checks"
        ? { data: [check], nextCursor: null }
        : method === "GET" && path === `/v1/ci/checks/${CHECK}`
          ? { ...check, jobs: [job] }
          : method === "POST" && path === `/v1/ci/checks/${CHECK}:cancel`
            ? { ...check, state: "cancelled", reason: "asked through Runtime's API", jobs: [] }
            : undefined,
    async (lines, sent) => {
      expect(await run(["ci", "checks", "--state", "running"], env, out(lines))).toBe(0);
      expect([sent[0]!.path, sent[0]!.query.getAll("state")]).toEqual([
        "/v1/ci/checks",
        ["running"],
      ]);
      expect(lines.join("\n")).toContain("1 passed, 1 failed");
      lines.length = 0;
      expect(await run(["ci", "check", CHECK], env, out(lines))).toBe(0);
      expect(lines.join("\n")).toContain("test (2/2)");
      lines.length = 0;
      expect(await run(["ci", "cancel", CHECK], env, out(lines))).toBe(0);
      expect([sent.at(-1)!.method, sent.at(-1)!.path]).toEqual([
        "POST",
        `/v1/ci/checks/${CHECK}:cancel`,
      ]);
      expect(lines.join("\n")).toContain("cancelled (asked through Runtime's API)");
    },
  );
  const help: string[] = [];
  expect(await run(["ci", "help"], env, out(help))).toBe(0);
  expect(help.join("\n")).toContain("checks [--repository <repoId>]");
  expect(help.join("\n")).toContain("check <checkId>");
});

test("logs prints a review's verdict: each finding at its line with its fix, then its notes", async () => {
  const reviewed = {
    ...job,
    name: "review",
    parts: 1,
    part: 1,
    exitCode: null,
    sandboxIds: [],
    log: "Read the change: 3 files, 2 kB.\n",
    review: {
      verdict: "block",
      summary: "Adds a refund route.",
      findings: [
        {
          kind: "money-at-risk",
          file: "billing.ts",
          line: 12,
          what: "Refunds twice.",
          fix: "Key it.",
        },
      ],
      notes: [{ file: "README.md", line: 0, what: "Say the limit." }],
      agent: "ci-review",
      account: "CLAUDE_TOKEN_2",
      model: "opus",
      session: "s-1",
      cut: false,
    },
  };
  await withStub(
    ({ method, path }) =>
      method === "GET" && path === `/v1/ci/jobs/${JOB}` ? reviewed : undefined,
    async (lines) => {
      expect(await run(["ci", "logs", JOB], env, out(lines))).toBe(0);
      const said = lines.join("\n");
      expect(said).toContain("Blocked: 1 finding(s). Adds a refund route.");
      expect(said).toContain("money-at-risk at billing.ts:12: Refunds twice.\n    Fix: Key it.");
      expect(said).toContain("note at README.md: Say the limit.");
      expect(said).toContain("agent ci-review (opus) on CLAUDE_TOKEN_2");
      expect(said).not.toContain("sandboxes wake");
    },
  );
});

const REPOS = "/v1/ci/repositories";
const OURS = "55555555-5555-4555-8555-555555555555";
const repo = (trustedApps: string[] = [], state = "connected") => ({
  id: OURS,
  name: "runtime-cloud",
  labels: {},
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_000_000,
  deletedAt: null,
  error: null,
  repository: "withruntime/runtime-cloud",
  productionBranch: "main",
  configPath: ".runtime/checks.yml",
  installation: 9100,
  githubRepositoryId: 42,
  trustedApps,
  undoCulprits: false,
  state,
});

test("ci repos ls shows each repository with the Apps it trusts", async () => {
  await withStub(
    ({ method, path }) =>
      method === "GET" && path === REPOS
        ? { data: [repo(["runtime-hub-app[bot]"])], nextCursor: null }
        : undefined,
    async (lines, sent) => {
      expect(await run(["ci", "repos", "ls"], env, out(lines))).toBe(0);
      expect(sent[0]!.query.getAll("state")).toEqual(["connected"]);
      expect(lines.join("\n")).toContain("withruntime/runtime-cloud");
      expect(lines.join("\n")).toContain("runtime-hub-app[bot]");
    },
  );
});

test("ci repos trust adds an App by the repository's name, keeping those it trusts", async () => {
  await withStub(
    ({ method, path, body }) => {
      if (method === "GET" && path === REPOS)
        return { data: [repo(["other-app[bot]"])], nextCursor: null };
      if (method === "POST" && path === `${REPOS}/${OURS}:update`)
        return repo((body as { trustedApps: string[] }).trustedApps);
      return undefined;
    },
    async (lines, sent) => {
      expect(
        await run(
          ["ci", "repos", "trust", "WithRuntime/Runtime-Cloud", "Runtime-Hub-App[bot]"],
          env,
          out(lines),
        ),
      ).toBe(0);
      expect(sent.at(-1)!.body).toEqual({
        trustedApps: ["other-app[bot]", "runtime-hub-app[bot]"],
      });
      expect(lines.at(-1)).toBe(
        "withruntime/runtime-cloud trusts other-app[bot], runtime-hub-app[bot].",
      );
    },
  );
});

test("ci repos untrust keeps the rest; a repository this key does not list changes nothing", async () => {
  await withStub(
    ({ method, path, body }) => {
      if (method === "GET" && path === REPOS)
        return { data: [repo(["other-app[bot]", "runtime-hub-app[bot]"])], nextCursor: null };
      if (method === "POST" && path === `${REPOS}/${OURS}:update`)
        return repo((body as { trustedApps: string[] }).trustedApps);
      return undefined;
    },
    async (lines, sent) => {
      expect(await run(["ci", "repos", "untrust", OURS, "other-app[bot]"], env, out(lines))).toBe(
        0,
      );
      expect(sent.at(-1)!.body).toEqual({ trustedApps: ["runtime-hub-app[bot]"] });
      const before = sent.length;
      await expect(
        run(["ci", "repos", "untrust", "acme/other", "runtime-hub-app[bot]"], env, out(lines)),
      ).rejects.toThrow("No connected CI/CD repository acme/other that this key lists");
      // Only the list was read: no update cleared anything.
      expect(sent.slice(before).map((s) => s.method)).toEqual(["GET"]);
    },
  );
});

test("ci repos undo turns a repository's undo on and off by its name, and shows it", async () => {
  await withStub(
    ({ method, path, body }) => {
      if (method === "GET" && path === REPOS) return { data: [repo([])], nextCursor: null };
      if (method === "POST" && path === `${REPOS}/${OURS}:update`)
        return { ...repo([]), undoCulprits: (body as { undoCulprits: boolean }).undoCulprits };
      return undefined;
    },
    async (lines, sent) => {
      expect(
        await run(["ci", "repos", "undo", "withruntime/runtime-cloud", "on"], env, out(lines)),
      ).toBe(0);
      expect(sent.at(-1)!.body).toEqual({ undoCulprits: true });
      expect(lines.at(-1)).toContain("its culprit is found and a pull request reverting it opens");
      expect(await run(["ci", "repos", "undo", OURS, "off"], env, out(lines))).toBe(0);
      expect(sent.at(-1)!.body).toEqual({ undoCulprits: false });
      await expect(run(["ci", "repos", "undo", OURS, "maybe"], env, out(lines))).rejects.toThrow(
        "neither on nor off",
      );
      expect(await run(["ci", "repos", "ls"], env, out(lines))).toBe(0);
      expect(lines.join("\n")).toContain("UNDO");
    },
  );
});

test("ci repos connect sends the settings and the Apps it trusts from the start", async () => {
  await withStub(
    ({ method, path }) =>
      method === "POST" && path === REPOS ? repo(["runtime-hub-app[bot]"]) : undefined,
    async (lines, sent) => {
      expect(
        await run(
          [
            "ci",
            "repos",
            "connect",
            "withruntime/runtime-cloud",
            "--config",
            ".runtime/checks.yml",
            "--trust",
            "runtime-hub-app[bot]",
          ],
          env,
          out(lines),
        ),
      ).toBe(0);
      expect(sent[0]!.body).toEqual({
        repository: "withruntime/runtime-cloud",
        configPath: ".runtime/checks.yml",
        trustedApps: ["runtime-hub-app[bot]"],
      });
      expect(lines.at(-1)).toBe(OURS);
    },
  );
  const lines: string[] = [];
  await expect(
    run(["ci", "repos", "connect", "acme/web", "--trust", "octocat"], env, out(lines)),
  ).rejects.toThrow("octocat is not an App's login");
});

const FLAKE = "66666666-6666-4666-8666-666666666666";
const flake = {
  id: FLAKE,
  repositoryId: REPO,
  file: "packages/cloud/tests/tenant-flood-postgres.test.ts",
  state: "quarantined",
  gates: null,
  proof: {
    key: "k".repeat(64),
    commit: SHA,
    checkId: CHECK,
    jobId: JOB,
    failedIn: [JOB],
    passedIn: [JOB],
  },
  again: 2,
  owner: {
    login: "runtimeteam",
    from: "last change",
    pullRequest: 2287,
    branch: "flood-refused-alone",
  },
  since: 1_760_000_000_000,
  dueAt: 1_760_172_800_000,
  overdue: true,
  tried: null,
  proveAskedAt: null,
  deleteReason: null,
  endedAt: null,
  endedCheckId: null,
  updatedAt: 1_760_000_000_000,
};

test("releases shows a release's steps oldest first, by commit", async () => {
  const step = (id: number, line: string) => ({
    id,
    repositoryId: REPO,
    commit: "a6049bf5a",
    source: "hostd",
    host: id === 2 ? "web-4" : null,
    line,
    at: 1_760_000_000_000 + id,
  });
  await withStub(
    ({ method, path }) =>
      method === "GET" && path === "/v1/ci/releases"
        ? {
            data: [step(2, "web-4: 562211980 -> a6049bf5a"), step(1, "ring 1 takes a6049bf5a")],
            nextCursor: null,
          }
        : undefined,
    async (lines, sent) => {
      expect(await run(["ci", "releases", "--commit", "a6049bf5a"], env, out(lines))).toBe(0);
      expect(sent[0]!.query.get("commit")).toBe("a6049bf5a");
      expect(sent[0]!.query.get("limit")).toBe("50");
      const text = lines.join("\n");
      expect(text.indexOf("ring 1 takes")).toBeLessThan(text.indexOf("web-4: 562211980"));
      expect(text).toContain("web-4");
    },
  );
});

test("flakes lists the open ones with their owners and deadlines; flake shows one and says an owner's say", async () => {
  await withStub(
    ({ method, path, body }) =>
      method === "GET" && path === "/v1/ci/flakes"
        ? { data: [flake], nextCursor: null }
        : method === "GET" && path === `/v1/ci/flakes/${FLAKE}`
          ? {
              ...flake,
              runs: [
                { passed: true, attempt: "again", commit: SHA, jobId: JOB },
                { passed: false, attempt: "first", commit: SHA, jobId: JOB },
              ],
              failures: [{ jobId: JOB, checkId: CHECK, commit: SHA, message: "timed out", at: 1 }],
            }
          : method === "POST" && path === `/v1/ci/flakes/${FLAKE}:update`
            ? { ...flake, ...(body as object), runs: [], failures: [] }
            : undefined,
    async (lines, sent) => {
      expect(await run(["ci", "flakes", "--repository", REPO], env, out(lines))).toBe(0);
      expect(sent[0]!.query.getAll("state")).toEqual(["quarantined", "gating"]);
      expect(sent[0]!.query.get("repositoryId")).toBe(REPO);
      const text = lines.join("\n");
      expect(text).toContain("tenant-flood-postgres.test.ts");
      expect(text).toContain("@runtimeteam (#2287)");
      expect(text).toContain("(overdue)");
      lines.length = 0;
      expect(await run(["ci", "flake", FLAKE], env, out(lines))).toBe(0);
      expect(lines.join("\n")).toContain("pass again, FAIL first");
      expect(lines.join("\n")).toContain(`ci logs ${JOB}`);
      lines.length = 0;
      expect(
        await run(["ci", "flake", "delete", FLAKE, "--reason", "timer test"], env, out(lines)),
      ).toBe(0);
      expect(sent.at(-1)!.body).toEqual({ deleteReason: "timer test" });
      expect(await run(["ci", "flake", "prove", FLAKE], env, out(lines))).toBe(0);
      expect(sent.at(-1)!.body).toEqual({ prove: true });
    },
  );
});
