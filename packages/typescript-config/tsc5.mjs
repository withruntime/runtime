#!/usr/bin/env node
// TypeScript 5, the compiler the SDK is built and published with, by name.
// The root installs both `typescript` (^5) and `typescript7`
// (npm:typescript@7.0.2), and each ships a `tsc` bin, so which one
// node_modules/.bin/tsc (and `bunx tsc`) runs is the installer's choice.
// This runs the `typescript` package's own command, refuses any version but
// 5, hands it the arguments unchanged and exits as it did
// (scripts/tsgo.test.ts). Type checks run TypeScript 7 as `tsgo` (tsgo.mjs).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const manifest = createRequire(import.meta.url).resolve("typescript/package.json");
const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
if (name !== "typescript" || !String(version).startsWith("5.")) {
  console.error(`tsc5: typescript is ${name}@${version}, not TypeScript 5`);
  process.exit(2);
}
const ran = spawnSync(
  process.execPath,
  [join(dirname(manifest), "bin", "tsc"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (ran.error) {
  console.error(`tsc5: ${ran.error.message}`);
  process.exit(2);
}
process.exit(ran.status ?? 1);
