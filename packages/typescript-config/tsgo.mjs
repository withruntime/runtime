#!/usr/bin/env node
// TypeScript 7, the compiler in native code, as `tsgo`: each package's
// check-types (and agents' and scripts' types) runs it. 47 s for
// packages/cloud on TypeScript 5.9 (with 4 GB for node), 6 s on this, cold,
// on 4 vCPU (20 October 2026). TypeScript 5.9 stays as `tsc` for what reads
// its JavaScript API: Next.js's build and the website's eslint parser.
//
// It runs only the pinned package's own command (root package.json's
// "typescript7": "npm:typescript@7.0.2"), refuses any other version, hands
// it the arguments unchanged and exits as it did: a type error fails the
// check (scripts/tsgo.test.ts).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const PINNED = "7.0.2";
const manifest = createRequire(import.meta.url).resolve("typescript7/package.json");
const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
if (name !== "typescript" || version !== PINNED) {
  console.error(`tsgo: typescript7 is ${name}@${version}, not typescript@${PINNED}`);
  process.exit(2);
}
const ran = spawnSync(
  process.execPath,
  [join(dirname(manifest), "bin", "tsc"), ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);
if (ran.error) {
  console.error(`tsgo: ${ran.error.message}`);
  process.exit(2);
}
process.exit(ran.status ?? 1);
