import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* CommonJS hosts (ComputeSDK's and Mastra's builds, any `require`) load the
   package through Node's require(esm), which needs a `default` condition in
   every export: with only `import`, require("withruntime") failed with
   ERR_PACKAGE_PATH_NOT_EXPORTED. This builds the package as published (the
   package.json and a fresh dist, nothing else), installs it by name in an
   empty directory, and requires every export with the `node` on PATH. The
   build sits under this package's node_modules so the peer dependencies
   resolve as they would for a customer who installed them. */

const here = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
  engines: { node: string };
};
const subpaths = Object.keys(manifest.exports).map((key) => `withruntime${key.slice(1)}`);

/** What each export must hand a CommonJS caller. */
const expected: Record<string, string> = {
  withruntime: "Sandbox",
  "withruntime/tools": "sandboxTools",
  "withruntime/ai": "runtimeTools",
  "withruntime/ai-harness": "createRuntimeSandbox",
  "withruntime/openai-agents": "RuntimeCloudSandboxClient",
  "withruntime/claude-agent-sdk": "runtimeMcpServer",
  "withruntime/e2b": "Sandbox",
  "withruntime/e2b/code-interpreter": "Sandbox",
  "withruntime/daytona": "Daytona",
  "withruntime/vercel": "Sandbox",
  "withruntime/blaxel": "SandboxInstance",
  "withruntime/runloop": "Runloop",
  "withruntime/codesandbox": "CodeSandbox",
  "withruntime/sprites": "SpritesClient",
  "withruntime/freestyle": "Freestyle",
  "withruntime/modal": "ModalClient",
  "withruntime/cloudflare": "getSandbox",
};

test("engines asks for the Node that require(esm) needs", () => {
  // A CommonJS caller on 22.0 to 22.11 gets ERR_REQUIRE_ESM; npm warns
  // before that happens only if engines says so.
  expect(manifest.engines.node).toBe(">=22.12");
});

test(
  "require() loads every export by name on the node in PATH",
  () => {
    const version = spawnSync("node", ["--version"], { encoding: "utf8" });
    expect(version.status).toBe(0);
    // require(esm) is on by default from Node 22.12.
    const [major, minor] = version.stdout.trim().slice(1).split(".").map(Number) as [
      number,
      number,
    ];
    expect(major > 22 || (major === 22 && minor >= 12)).toBe(true);

    mkdirSync(join(here, "node_modules", ".cache"), { recursive: true });
    const built = mkdtempSync(join(here, "node_modules", ".cache", "cjs-require-"));
    const consumer = mkdtempSync(join(tmpdir(), "withruntime-cjs-"));
    try {
      const tsc = spawnSync(
        "bun",
        ["x", "tsc", "-p", "tsconfig.build.json", "--outDir", join(built, "dist")],
        { cwd: here, encoding: "utf8" },
      );
      expect(tsc.stderr + tsc.stdout).toBe("");
      cpSync(join(here, "package.json"), join(built, "package.json"));
      mkdirSync(join(consumer, "node_modules"));
      symlinkSync(built, join(consumer, "node_modules", "withruntime"), "dir");

      const script = `
        const results = {};
        for (const name of ${JSON.stringify(subpaths)}) {
          try { results[name] = Object.keys(require(name)); }
          catch (error) { results[name] = error.code + ": " + String(error.message).split("\\n")[0]; }
        }
        console.log(JSON.stringify(results));`;
      const run = spawnSync("node", ["--no-warnings", "-e", script], {
        cwd: consumer,
        encoding: "utf8",
      });
      expect(run.stderr).toBe("");
      const results = JSON.parse(run.stdout) as Record<string, string[] | string>;
      for (const name of subpaths) {
        expect({ name, exports: results[name] }).toEqual({
          name,
          exports: expect.arrayContaining([expected[name] ?? "__missing_expectation__"]),
        });
      }
      // Compile unchanged provider consumers through actual package exports and
      // built declarations, with no source-path aliases.
      writeFileSync(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(
        join(consumer, "workflows.ts"),
        readFileSync(join(here, "tests/compat/consumers/workflows.ts.txt"), "utf8")
          .replaceAll('"@compat/e2b-interpreter"', '"withruntime/e2b/code-interpreter"')
          .replaceAll('"@compat/', '"withruntime/'),
      );
      const declarations = spawnSync(
        "bun",
        [
          "x",
          "tsc",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--target",
          "es2022",
          "--module",
          "nodenext",
          "--moduleResolution",
          "nodenext",
          "--types",
          "node",
          "--typeRoots",
          join(here, "node_modules/@types"),
          join(consumer, "workflows.ts"),
        ],
        { cwd: here, encoding: "utf8" },
      );
      expect(declarations.status).toBe(0);
      expect(declarations.stderr + declarations.stdout).toBe("");
      // import() of the same install still works.
      const esm = spawnSync(
        "node",
        [
          "--input-type=module",
          "-e",
          'const m = await import("withruntime"); console.log(typeof m.Sandbox);',
        ],
        { cwd: consumer, encoding: "utf8" },
      );
      expect(esm.stdout.trim()).toBe("function");
    } finally {
      rmSync(built, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  },
  { timeout: 180_000 },
);
