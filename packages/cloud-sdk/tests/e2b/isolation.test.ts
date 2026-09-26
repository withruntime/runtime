import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/* `withruntime` and `withruntime/e2b` are one package, but importing the SDK
   must not load the E2B layer: every module reachable from src/index.ts, by a
   static or a dynamic import, stays outside src/e2b. */
test("importing withruntime alone does not load the E2B layer", () => {
  const src = resolve(import.meta.dir, "../../src");
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const [, spec] of text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g))
      walk(join(dirname(file), spec!.replace(/\.js$/, ".ts")));
  };
  walk(join(src, "index.ts"));
  expect(seen.size).toBeGreaterThan(10);
  expect([...seen].filter((file) => file.startsWith(join(src, "e2b")))).toEqual([]);
});
