/** Identical typed statements against Runtime and the pinned published SDK. */
import ts from "typescript";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/* The consumer's statements, typed against Runtime's adapter by the
   package's own type check (consumers/tsconfig.json, `bun run check-types`);
   here against the pinned published SDK. */
const source = await readFile(new URL("./consumers/codesandbox.ts", import.meta.url), "utf8");
export async function checkCodeSandboxConsumers(reference?: string) {
  if (reference) {
    const pkg = JSON.parse(
      await readFile(resolve(reference, "node_modules/@codesandbox/sdk/package.json"), "utf8"),
    ) as { name: string; version: string };
    if (pkg.name !== "@codesandbox/sdk" || pkg.version !== "2.4.2")
      throw new Error("Expected pinned @codesandbox/sdk 2.4.2");
  }
  const directory = await mkdtemp(join(tmpdir(), "runtime-codesandbox-consumer-"));
  try {
    const fixture = join(directory, "consumer.ts");
    await writeFile(fixture, source);
    const entry = reference
      ? resolve(reference, "node_modules/@codesandbox/sdk/dist/esm/index.d.ts")
      : fileURLToPath(new URL("../../src/codesandbox/index.ts", import.meta.url));
    const program = ts.createProgram([fixture], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      paths: { "@sandbox": [entry] },
      types: [],
    });
    const errors = ts.getPreEmitDiagnostics(program);
    if (errors.length)
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(errors, {
          getCanonicalFileName: (path) => path,
          getCurrentDirectory: () => directory,
          getNewLine: () => "\n",
        }),
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  await checkCodeSandboxConsumers(process.argv[2]);
  console.log("CodeSandbox task/setup/command consumer declarations match.");
}
