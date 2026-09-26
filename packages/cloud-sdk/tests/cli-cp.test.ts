import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";

/* `cp` as cp behaves (user lane, 25 September 2026): a destination ending in
   / takes the source's name inside it, where it failed with "Guest path must
   be a canonical absolute path", and a file copied into a directory that does
   not exist yet makes it, where it failed with file_not_found. */

const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const env = { RUNTIME_API_KEY: "rk", RUNTIME_API_URL: "https://api.example.test" };
const dir = mkdtempSync(join(tmpdir(), "cli-cp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function cp(from: string, to: string, missing = new Set<string>()) {
  const original = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const target = url.searchParams.get("path") ?? "";
    sent.push(`${request.method} ${url.pathname.replace(`/v1/sandboxes/${ID}`, "")} ${target}`);
    if (request.method === "PUT" && missing.has(target.slice(0, target.lastIndexOf("/")))) {
      return Response.json(
        { error: { code: "file_not_found", message: "No such file or directory." } },
        { status: 404 },
      );
    }
    if (request.method === "POST" && url.pathname.endsWith("files:mkdir")) {
      missing.clear();
      return Response.json({ ok: true });
    }
    return Response.json({ path: target, size: 2 });
  }) as typeof fetch;
  try {
    const code = await run(["sandbox", "cp", from, to], env, {
      json: false,
      write: () => {},
      error: () => {},
    });
    return { code, sent };
  } finally {
    globalThis.fetch = original;
  }
}

test("a destination ending in / takes the source's name", async () => {
  const file = join(dir, "notes.txt");
  writeFileSync(file, "hi");
  const { code, sent } = await cp(file, `${ID}:/workspace/`);
  expect(code).toBe(0);
  expect(sent).toEqual(["PUT /files/content /workspace/notes.txt"]);
});

test("a file copied into a directory that does not exist makes it", async () => {
  const file = join(dir, "main.py");
  writeFileSync(file, "print(1)");
  const { code, sent } = await cp(
    file,
    `${ID}:/workspace/new/app/main.py`,
    new Set(["/workspace/new/app"]),
  );
  expect(code).toBe(0);
  expect(sent).toEqual([
    "PUT /files/content /workspace/new/app/main.py",
    "POST /files:mkdir ",
    "PUT /files/content /workspace/new/app/main.py",
  ]);
});
