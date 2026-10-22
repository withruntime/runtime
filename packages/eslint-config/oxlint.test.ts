// oxlint.json, which lints every typed package, turns on every rule the
// typed eslint config (base.js `typed`) turns on for a source file, under
// oxlint's name for it. Two are left to TypeScript, which refuses the same
// code in every package (typescript-config/base.json): nothing is dropped
// unseen.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { typed } from "./base.js";

/** Each eslint rule oxlint does not run, and what refuses that code instead. */
const TYPESCRIPT_REFUSES: Record<string, string> = {
  "no-fallthrough": "noFallthroughCasesInSwitch (TS7029)",
  "no-octal": "octal literals in a module or strict code (TS1121)",
};

type Rules = Record<string, unknown>;
const on = (v: unknown) => {
  const level = Array.isArray(v) ? v[0] : v;
  return level !== "off" && level !== 0;
};

test("oxlint runs every rule the typed eslint config runs on a source file", async () => {
  const root = join(import.meta.dir, "..", "..");
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: typed,
    ignore: false,
  });
  const config = (await eslint.calculateConfigForFile(
    join(root, "packages/cloud/src/errors.ts"),
  )) as {
    rules: Rules;
  };
  const wanted = Object.entries(config.rules)
    .filter(([, v]) => on(v))
    .map(([name]) => name);
  expect(wanted.length).toBeGreaterThan(80);

  const ox = JSON.parse(readFileSync(join(import.meta.dir, "oxlint.json"), "utf8")) as {
    rules?: Rules;
    overrides?: { files: string[]; rules?: Rules }[];
  };
  // A source file's rules: the top level, then the override for every .ts file.
  const source = { ...ox.rules, ...ox.overrides?.find((o) => o.files.includes("**/*.ts"))?.rules };
  const runs = new Set(
    Object.entries(source)
      .filter(([, v]) => on(v))
      .map(([name]) => name),
  );
  const missing = wanted.filter(
    (name) =>
      !runs.has(name.replace(/^@typescript-eslint\//, "typescript/")) &&
      !runs.has(name.replace(/^@typescript-eslint\//, "")),
  );
  expect(missing.sort()).toEqual(Object.keys(TYPESCRIPT_REFUSES).sort());
  // And TypeScript does refuse them, in every package's base config.
  const base = readFileSync(join(root, "packages/typescript-config/base.json"), "utf8");
  expect(base).toContain('"noFallthroughCasesInSwitch": true');
  expect(base).toContain('"strict": true');
});
