import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/* A page imports `withruntime` to drive a sandbox with a session token
 * (Sandbox.fromSession, ARCHITECTURE.md section 3.12), so the SDK must bundle
 * for a browser. Its Node-only modules (tar and zlib for directory uploads,
 * image build contexts, the saved login key, undici for proxies) are mapped to
 * an empty stub by package.json's "browser" field, which webpack, Vite,
 * esbuild and Bun honour for the published dist. Here the same map is applied
 * to src, and a browser build of the entry must succeed with no Node built-in
 * imported at the top of the bundle. Without the map it fails. */

const ROOT = resolve(import.meta.dir, "..");
const map = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    browser: Record<string, string | false>;
  }
).browser;
const STUB = join(ROOT, "src/browser-stub.ts");

async function build(useMap: boolean) {
  return Bun.build({
    entrypoints: [join(ROOT, "src/index.ts")],
    target: "browser",
    format: "esm",
    throw: false,
    plugins: useMap
      ? [
          {
            name: "package-browser-field",
            setup(builder) {
              builder.onResolve({ filter: /.*/ }, (args) => {
                if (map[args.path] === false) return { path: STUB };
                if (!args.path.startsWith(".")) return undefined;
                const file = resolve(dirname(args.importer), args.path);
                const published = `./dist/${relative(join(ROOT, "src"), file)}`;
                return map[published] ? { path: STUB } : undefined;
              });
            },
          },
        ]
      : [],
  });
}

test("every module the browser field maps exists, and maps to the stub", () => {
  for (const [from, to] of Object.entries(map)) {
    if (to === false) continue;
    expect(
      existsSync(join(ROOT, from.replace("./dist/", "src/").replace(/\.js$/, ".ts"))),
      from,
    ).toBe(true);
    expect(to).toBe("./dist/browser-stub.js");
  }
});

test("the SDK bundles for a browser, with no Node built-in at the top of the bundle", async () => {
  const bundled = await build(true);
  expect(bundled.logs.filter((log) => log.level === "error").map(String)).toEqual([]);
  expect(bundled.success).toBe(true);
  const text = await bundled.outputs[0]!.text();
  expect(text.match(/^import .* from "node:[^"]+";$/gm) ?? []).toEqual([]);
  expect(text).toContain("fromSession");
});

test("without the browser field the same build fails", async () => {
  expect((await build(false)).success).toBe(false);
});
