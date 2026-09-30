/** Compile the identical consumers against Runtime, or an extracted set of the exact
 * upstream packages. This is declaration compatibility, not behavioral equivalence. */
import ts from "typescript";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../..", import.meta.url));
const providers = {
  runloop: ["runloop_api-client", "sdk.d.ts"],
  codesandbox: ["codesandbox_sdk", "dist/esm/index.d.ts"],
  sprites: ["fly_sprites", "dist/index.d.ts"],
  freestyle: ["freestyle", "dist/index.d.ts"],
  modal: ["modal", "dist/index.d.ts"],
  cloudflare: ["cloudflare_sandbox", "dist/index.d.ts"],
} as const;
const established = {
  e2b: ["e2b", "dist/index.d.ts", "src/e2b/index.ts"],
  "e2b-interpreter": ["@e2b-code-interpreter", "dist/index.d.ts", "src/e2b/code-interpreter.ts"],
  daytona: ["@daytona-sdk", "esm/index.d.ts", "src/daytona/index.ts"],
  vercel: ["@vercel-sandbox", "dist/index.d.ts", "src/vercel/index.ts"],
  blaxel: ["@blaxel-core", "dist/cjs/types/index.d.ts", "src/blaxel/index.ts"],
} as const;
export async function checkConsumers(
  upstreamRoot?: string,
  establishedRoot?: string,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "runtime-consumer-types-"));
  try {
    const fixture = join(dir, "workflows.ts");
    await writeFile(
      fixture,
      await readFile(new URL("./consumers/workflows.ts.txt", import.meta.url), "utf8"),
    );
    const paths: Record<string, string[]> = {};
    const lock = JSON.parse(await readFile(resolve(root, "compatibility-lock.json"), "utf8")) as {
      providers: { id: string; upstreams: { registry: string; name: string; version: string }[] }[];
    };
    for (const [provider, [folder, entry]] of Object.entries(providers)) {
      if (upstreamRoot) {
        const pinned = lock.providers
          .find((p) => p.id === provider)
          ?.upstreams.find((p) => p.registry === "npm");
        if (!pinned) throw new Error(`No npm pin for ${provider}`);
        const packageRoot = establishedRoot
          ? resolve(upstreamRoot, folder, "package")
          : resolve(
              upstreamRoot,
              "npm",
              `${encodeURIComponent(pinned.name)}@${pinned.version}`,
              "package",
            );
        const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
          name: string;
          version: string;
        };
        if (!pinned || pkg.name !== pinned.name || pkg.version !== pinned.version)
          throw new Error(`${provider}: extracted package does not match compatibility-lock.json`);
        paths[`@compat/${provider}`] = [join(packageRoot, entry)];
      } else paths[`@compat/${provider}`] = [resolve(root, `src/${provider}/index.ts`)];
    }
    for (const [provider, [folder, entry, source]] of Object.entries(established)) {
      if (upstreamRoot) {
        const pinned =
          provider === "e2b-interpreter"
            ? lock.providers
                .flatMap((p) => p.upstreams)
                .find((p) => p.registry === "npm" && p.name === "@e2b/code-interpreter")
            : lock.providers
                .find((p) => p.id === provider)
                ?.upstreams.find((p) => p.registry === "npm");
        if (!pinned) throw new Error(`No npm pin for ${provider}`);
        const packageRoot = establishedRoot
          ? resolve(establishedRoot, folder, "package")
          : resolve(
              upstreamRoot,
              "npm",
              `${encodeURIComponent(pinned.name)}@${pinned.version}`,
              "package",
            );
        const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
          name: string;
          version: string;
        };
        if (!pinned || pkg.version !== pinned.version)
          throw new Error(`${provider}: extracted package does not match compatibility-lock.json`);
        paths[`@compat/${provider}`] = [join(packageRoot, entry)];
      } else paths[`@compat/${provider}`] = [resolve(root, source)];
    }
    // The official interpreter inherits Sandbox from its real e2b dependency.
    paths.e2b = paths["@compat/e2b"]!;
    if (upstreamRoot) {
      // Daytona's session responses inherit fields from the generated clients.
      // Resolve their exact dependencies rather than treating unresolved types as any.
      const daytona = JSON.parse(
        await readFile(resolve(paths["@compat/daytona"]![0]!, "../../package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      for (const name of [
        "@daytona/api-client",
        "@daytona/toolbox-api-client",
        "@daytona/analytics-api-client",
      ]) {
        const dir = establishedRoot
          ? resolve(establishedRoot, name.replace("/", "-"), "package")
          : resolve(
              upstreamRoot,
              "npm",
              `${encodeURIComponent(name)}@${daytona.dependencies[name]}`,
              "package",
            );
        const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
          name: string;
          version: string;
          types: string;
        };
        if (pkg.name !== name || pkg.version !== daytona.dependencies[name])
          throw new Error(`${name}: extracted declaration dependency differs from the pinned SDK`);
        paths[name] = [resolve(dir, pkg.types)];
      }
    }
    const program = ts.createProgram([fixture], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      paths,
      types: ["node"],
      typeRoots: [resolve(root, "node_modules/@types")],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length)
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCanonicalFileName: (n) => n,
          getCurrentDirectory: () => dir,
          getNewLine: () => "\n",
        }),
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  await checkConsumers(process.argv[2], process.argv[3]);
  console.log(
    process.argv[2]
      ? "Pinned upstream consumer declarations passed"
      : "Runtime consumer declarations passed",
  );
}
