import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

/* The published package is dist, built from what tsconfig.build.json takes in.
 * withruntime@0.12.0 shipped dist/cli/logs.test.js and
 * dist/products/logs.test.js, because the build took every file of src, tests
 * beside the code included (orchestrator, 11 October 2026). */

const ROOT = resolve(import.meta.dir, "..");

test("the published build takes in no test file", () => {
  /* The build's files as TypeScript reads tsconfig.build.json (its include
     and exclude, 30 ms; a compiler listing every file it would build took
     0.7 s), and none of them imports a test file, so no test comes in
     behind one. src/cli/logs.ts sits beside its test and must still be in. */
  const config = ts.getParsedCommandLineOfConfigFile(
    resolve(ROOT, "tsconfig.build.json"),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => expect(d).toBeUndefined() },
  )!;
  expect(config.errors).toEqual([]);
  const built = config.fileNames.map((file) => relative(ROOT, file));
  expect(built).toContain("src/cli/logs.ts");
  expect(built.filter((path) => /\.test\.[cm]?tsx?$/.test(path))).toEqual([]);
  const importsATest = built.filter((path) =>
    /from\s+["'][^"']*\.test(\.[cm]?[jt]sx?)?["']|import\(\s*["'][^"']*\.test\b/.test(
      readFileSync(resolve(ROOT, path), "utf8"),
    ),
  );
  expect(importsATest).toEqual([]);
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
