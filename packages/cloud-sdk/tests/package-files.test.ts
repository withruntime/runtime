import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import ts from "typescript";

/* The published package is dist, built from what tsconfig.build.json takes in.
 * withruntime@0.12.0 shipped dist/cli/logs.test.js and
 * dist/products/logs.test.js, because the build took every file of src, tests
 * beside the code included (orchestrator, 11 October 2026). */

const ROOT = resolve(import.meta.dir, "..");

test("the published build takes in no test file", () => {
  /* The program tsc would build, asked of TypeScript in this process: the
     same files `tsc --listFilesOnly` prints. That list came from tsc run
     under bun in a child process: through a pipe, on a busy 4-vCPU CI
     sandbox, its 766-line list lost its end on exit, src/cli/logs.ts
     included, with tsc still answering 0 (9 CI runs, 13 October 2026). Into
     a file it held, as long as bun flushed it before exiting. No child, no
     output to lose. */
  const config = ts.getParsedCommandLineOfConfigFile(
    resolve(ROOT, "tsconfig.build.json"),
    undefined,
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  expect(config?.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n"))).toEqual(
    [],
  );
  const program = ts.createProgram({ rootNames: config!.fileNames, options: config!.options });
  const built = program
    .getSourceFiles()
    .map((file) => relative(ROOT, file.fileName))
    .filter((path) => path.startsWith("src/"));
  expect(built).toContain("src/cli/logs.ts");
  expect(built.filter((path) => /\.test\.[cm]?tsx?$/.test(path))).toEqual([]);
  // TypeScript reads the whole package: past bun's 5 s on a busy CI part.
}, 60_000);
