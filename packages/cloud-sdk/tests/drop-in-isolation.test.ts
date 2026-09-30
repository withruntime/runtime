import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/* Each drop-in is its own entry point: importing `withruntime` loads none of
   them, and no drop-in loads another's code. */
const src = resolve(import.meta.dir, "../src");
function reach(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const [, spec] of text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g))
      walk(join(dirname(file), spec!.replace(/\.js$/, ".ts")));
  };
  walk(join(src, entry));
  return [...seen];
}
const inside = (files: string[], dir: string) =>
  files.filter((file) => file.startsWith(join(src, dir)));

const adapters = [
  "e2b",
  "daytona",
  "vercel",
  "blaxel",
  "runloop",
  "codesandbox",
  "sprites",
  "freestyle",
  "modal",
  "cloudflare",
];

test("importing withruntime alone loads none of the compatibility adapters", () => {
  const files = reach("index.ts");
  for (const adapter of adapters) expect(inside(files, adapter)).toEqual([]);
});

for (const adapter of adapters) {
  test(`${adapter} loads no other compatibility adapter`, () => {
    const files = reach(`${adapter}/index.ts`);
    for (const other of adapters) {
      if (adapter !== other) expect(inside(files, other)).toEqual([]);
    }
  });
}
