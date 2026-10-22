import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageCommand } from "../src/cli";

/* `runtime images build <folder> -f <Dockerfile>` finds the Dockerfile as
   `docker build` does: -f from where the command runs, then (as before)
   inside the folder. A monorepo's app builds from the repository's root:
   `images build . -f apps/web/Dockerfile`, or from above it (18 October
   2026: `images build ctx -f ctx/apps/cloud-web/Dockerfile` found nothing). */

const cwd = process.cwd();
afterEach(() => process.chdir(cwd));

function repo() {
  const root = mkdtempSync(join(tmpdir(), "cli-images-"));
  mkdirSync(join(root, "ctx/apps/web"), { recursive: true });
  writeFileSync(join(root, "ctx/apps/web/Dockerfile"), "FROM ubuntu:24.04\n");
  writeFileSync(join(root, "ctx/package.json"), "{}\n");
  return root;
}

/** Runs the build against an API that answers nothing, and says what the
 * command read before it reached the API, or why it stopped first. */
async function build(args: string[]) {
  const original = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(new URL(new Request(input).url).pathname);
    return Response.json({ error: { code: "route_not_found", message: "none" } }, { status: 404 });
  }) as typeof fetch;
  const lines: string[] = [];
  try {
    await imageCommand(
      ["build", ...args],
      { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" },
      { json: false, write: (t) => lines.push(t), error: (t) => lines.push(t) },
    ).catch((error: Error) => lines.push(`ERROR ${error.message}`));
  } finally {
    globalThis.fetch = original;
  }
  return { out: lines.join("\n"), asked };
}

test("-f is read from where the command runs, the folder is the context", async () => {
  const root = repo();
  process.chdir(root);
  const { out, asked } = await build(["ctx", "-f", "ctx/apps/web/Dockerfile"]);
  expect(out).toContain(`Using the Dockerfile ${join(root, "ctx/apps/web/Dockerfile")}`);
  expect(out).toContain(`Sending the build context from ${join(root, "ctx")}`);
  expect(asked.length).toBeGreaterThan(0);
});

test("-f inside the folder still works, as it always has", async () => {
  const root = repo();
  process.chdir(root);
  const { out, asked } = await build(["ctx", "-f", "apps/web/Dockerfile"]);
  expect(out).toContain(`Using the Dockerfile ${join(root, "ctx/apps/web/Dockerfile")}`);
  expect(asked.length).toBeGreaterThan(0);
});

test("-f alone makes its own folder the context, read once, not twice over", async () => {
  const root = repo();
  process.chdir(join(root, "ctx"));
  const { out } = await build(["-f", "apps/web/Dockerfile"]);
  expect(out).toContain(`Sending the build context from ${join(root, "ctx/apps/web")}`);
  expect(out).not.toContain("No Dockerfile");
});

test("a Dockerfile in neither place names both, and nothing is asked", async () => {
  const root = repo();
  process.chdir(root);
  const { out, asked } = await build(["ctx", "-f", "web/Dockerfile"]);
  expect(out).toContain(
    `No Dockerfile at ${join(root, "web/Dockerfile")} or ${join(root, "ctx/web/Dockerfile")}.`,
  );
  expect(asked).toEqual([]);
});
