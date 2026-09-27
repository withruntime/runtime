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

test("importing withruntime alone loads none of the Daytona, Vercel or Blaxel layers", () => {
  const files = reach("index.ts");
  expect(inside(files, "daytona")).toEqual([]);
  expect(inside(files, "vercel")).toEqual([]);
  expect(inside(files, "blaxel")).toEqual([]);
});

test("the Daytona, Vercel and Blaxel layers load no other drop-in", () => {
  const daytona = reach("daytona/index.ts");
  const vercel = reach("vercel/index.ts");
  const blaxel = reach("blaxel/index.ts");
  expect([
    ...inside(daytona, "vercel"),
    ...inside(daytona, "e2b"),
    ...inside(daytona, "blaxel"),
  ]).toEqual([]);
  expect([
    ...inside(vercel, "daytona"),
    ...inside(vercel, "e2b"),
    ...inside(vercel, "blaxel"),
  ]).toEqual([]);
  expect([
    ...inside(blaxel, "daytona"),
    ...inside(blaxel, "e2b"),
    ...inside(blaxel, "vercel"),
  ]).toEqual([]);
});
