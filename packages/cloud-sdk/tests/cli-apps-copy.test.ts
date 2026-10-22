import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";

/* `runtime apps exec` and `runtime apps cp`: what an operator did with
   `runtime sandboxes cp <file> agents-hub:/workspace/hub/support-key` and
   `sandboxes exec agents-hub -- chmod 600 ...` (agents/expiry.ts), done to an
   App by its name: its live copy is found from its own list, then reached by
   the sandbox routes. */

const APP = "5b0c7e1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b";
const LIVE = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const OLD = "1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a";
const env = { RUNTIME_API_KEY: "rk", RUNTIME_API_URL: "https://api.example.test" };
const dir = mkdtempSync(join(tmpdir(), "cli-apps-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = {
  id: APP,
  name: "agents-hub",
  labels: {},
  state: "live",
  minCopies: 1,
  maxCopies: 1,
  concurrency: 100,
  spares: 0,
  vcpu: 2,
  memoryMiB: 2048,
  port: 8080,
  liveVersion: 4,
  previousVersion: 3,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  error: null,
};
const copies = [
  { id: OLD, version: 3, region: "us-east", state: "draining", since: 1 },
  { id: LIVE, version: 4, region: "us-east", state: "serving", since: 2 },
];

async function cli(argv: string[]) {
  const original = globalThis.fetch;
  const sent: string[] = [];
  const written: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    sent.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/v1/apps")
      return Response.json({
        data: [app].filter((a) => a.name === url.searchParams.get("name")),
        nextCursor: null,
      });
    if (url.pathname === `/v1/apps/${APP}`) return Response.json(app);
    if (url.pathname === `/v1/apps/${APP}/copies`) return Response.json(copies);
    if (url.pathname.endsWith(":exec")) {
      const body = (await request.json()) as { argv?: string[]; command?: string };
      return Response.json({ exitCode: 0, stdout: `ran ${JSON.stringify(body)}\n`, stderr: "" });
    }
    return Response.json({ path: url.searchParams.get("path"), size: 3, sha256: "x" });
  }) as typeof fetch;
  try {
    const code = await run(argv, env, {
      json: argv.includes("--json"),
      write: (text: string) => void written.push(text),
      error: () => {},
    });
    return { code, sent, written };
  } finally {
    globalThis.fetch = original;
  }
}

test("apps cp puts a file on the live copy, by the App's name", async () => {
  const file = join(dir, "support-key");
  writeFileSync(file, "key");
  const { code, sent } = await cli(["apps", "cp", file, "agents-hub:/data/support-key"]);
  expect(code).toBe(0);
  expect(sent).toEqual([
    "GET /v1/apps?name=agents-hub&state=waiting&state=live&state=failed",
    `GET /v1/apps/${APP}`,
    `GET /v1/apps/${APP}/copies`,
    `PUT /v1/sandboxes/${LIVE}/files/content?path=%2Fdata%2Fsupport-key&mode=644`,
  ]);
});

test("apps exec runs in the live copy, or the copy named", async () => {
  const live = await cli([
    "apps",
    "exec",
    APP,
    "--json",
    "--",
    "chmod",
    "600",
    "/data/support-key",
  ]);
  expect(live.code).toBe(0);
  expect(live.sent.at(-1)).toBe(`POST /v1/sandboxes/${LIVE}:exec`);
  expect(live.written.join("")).toContain("chmod");
  const named = await cli(["apps", "exec", APP, "--copy", OLD, "--json", "--", "ls", "/data"]);
  expect(named.sent.at(-1)).toBe(`POST /v1/sandboxes/${OLD}:exec`);
});

test("apps copies lists them; an unknown App name says how to find one", async () => {
  const { written } = await cli(["apps", "copies", APP]);
  expect(written.join("")).toContain(LIVE);
  const missing = await cli(["apps", "exec", "nope", "--", "ls"]).catch((e: Error) => e);
  expect(String((missing as Error).message ?? missing)).toContain("No App is named nope");
});
