import { expect, test } from "bun:test";
import { ci, type CiCheck } from "../src/products/ci.js";
import type { Call, Transport } from "../src/transport.js";

/* runtime.ci against a fake transport: each method's route, method, query
   and body as packages/cloud/src/api/products/ci.ts serves them, and a list
   pages on with the cursor it was given. */

function fake(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const transport = {
    async json<T>(call: Call): Promise<T> {
      calls.push(call);
      return (await answer(call)) as T;
    },
  } as Transport;
  return { api: ci(transport), calls };
}
const check = (id: string): CiCheck => ({
  id,
  repositoryId: "r",
  repository: "acme/app",
  commit: "a".repeat(40),
  branch: "main",
  event: "push",
  pullRequest: null,
  baseCommit: null,
  actor: "octocat",
  trusted: true,
  waiting: false,
  approvedBy: null,
  approvedAt: null,
  landed: true,
  state: "failed",
  reason: "test failed",
  counts: { passed: 1, failed: 1 },
  machines: null,
  createdAt: 1,
  updatedAt: 2,
  startedAt: 1,
  endedAt: 2,
});

test("each method's route, method, query and body", async () => {
  const { api, calls } = fake((call) =>
    call.method === "GET" && !/\/(checks|jobs|flakes)\/./.test(call.path)
      ? { data: [], nextCursor: null }
      : { id: "x" },
  );
  await api.repositories.connect({ repository: "acme/app", configPath: ".runtime/ci.yml" });
  await api.repositories.list({ state: ["connected"] });
  await api.repositories.disconnect("r 1");
  await api.checks.list({ repositoryId: "r", state: ["failed", "running"], pullRequest: 7 });
  await api.checks.get("c 1");
  await api.jobs.get("j/1");
  await api.tests.list("r", { quarantined: true });
  await api.flakes.list({ repositoryId: "r", state: ["quarantined", "gating"] });
  await api.flakes.get("f 1");
  await api.flakes.update("f 1", { owner: "acme/testers", prove: true });
  expect(calls.map((c) => [c.method, c.path, c.query ?? null, c.body ?? null])).toEqual([
    [
      "POST",
      "/v1/ci/repositories",
      null,
      { repository: "acme/app", configPath: ".runtime/ci.yml" },
    ],
    ["GET", "/v1/ci/repositories", { state: ["connected"] }, null],
    ["DELETE", "/v1/ci/repositories/r%201", null, null],
    [
      "GET",
      "/v1/ci/checks",
      { repositoryId: "r", state: ["failed", "running"], pullRequest: 7 },
      null,
    ],
    ["GET", "/v1/ci/checks/c%201", null, null],
    ["GET", "/v1/ci/jobs/j%2F1", null, null],
    ["GET", "/v1/ci/tests", { quarantined: true, repositoryId: "r" }, null],
    ["GET", "/v1/ci/flakes", { repositoryId: "r", state: ["quarantined", "gating"] }, null],
    ["GET", "/v1/ci/flakes/f%201", null, null],
    ["POST", "/v1/ci/flakes/f%201:update", null, { owner: "acme/testers", prove: true }],
  ]);
});

test("a list of checks pages on with its cursor and keeps its filter", async () => {
  const { api, calls } = fake((call) =>
    (call.query as { cursor?: string }).cursor === "n1"
      ? { data: [check("b")], nextCursor: null }
      : { data: [check("a")], nextCursor: "n1" },
  );
  const page = await api.checks.list({ state: ["failed"], limit: 1 });
  expect((await page.toArray()).map((c) => c.id)).toEqual(["a", "b"]);
  expect(calls.map((c) => c.query)).toEqual([
    { state: ["failed"], limit: 1 },
    { state: ["failed"], limit: 1, cursor: "n1" },
  ]);
});
