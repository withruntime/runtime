import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

/* The published package is dist, built from what tsconfig.build.json takes in.
 * withruntime@0.12.0 shipped dist/cli/logs.test.js and
 * dist/products/logs.test.js, because the build took every file of src, tests
 * beside the code included (orchestrator, 11 October 2026). */

const ROOT = resolve(import.meta.dir, "..");
const TSGO = resolve(ROOT, "../../node_modules/.bin/tsgo");

test("the published build takes in no test file", () => {
  /* The files tsc would build, as TypeScript 7 lists them (`tsgo
     --listFilesOnly`, the same inclusion as the build's tsc 5, 0.45 s where
     tsc 5's program in this process took 1.9 s), written straight to a file.
     Through a pipe from tsc run under bun, on a busy 4-vCPU CI sandbox, the
     766-line list lost its end on exit, src/cli/logs.ts included, with tsc
     still answering 0 (9 CI runs, 13 October 2026); a native compiler's
     writes to a file are whole when it exits, and the list must still hold
     src/cli/logs.ts. */
  const dir = mkdtempSync(join(tmpdir(), "package-files-"));
  try {
    const list = join(dir, "files.txt");
    const out = openSync(list, "w");
    const run = spawnSync(TSGO, ["-p", "tsconfig.build.json", "--listFilesOnly"], {
      cwd: ROOT,
      stdio: ["ignore", out, "pipe"],
      encoding: "utf8",
    });
    closeSync(out);
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
    const built = readFileSync(list, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((file) => relative(ROOT, file))
      .filter((path) => path.startsWith("src/"));
    expect(built).toContain("src/cli/logs.ts");
    expect(built.filter((path) => /\.test\.[cm]?tsx?$/.test(path))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("engines asks for the Node that require(esm) needs", () => {
  // A CommonJS caller on 22.0 to 22.11 gets ERR_REQUIRE_ESM (CommonJS hosts
  // load the package through require(esm): cjs-require.e2e.test.ts); npm
  // warns before that happens only if engines says so.
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    engines: { node: string };
  };
  expect(manifest.engines.node).toBe(">=22.12");
});
