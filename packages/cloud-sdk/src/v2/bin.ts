#!/usr/bin/env node
/* The `runtime` and `withruntime` commands. This file only runs the CLI: npx starts it by a link named for the
   command (node_modules/.bin/withruntime), so cli.ts never guesses from its own name whether it was started
   (1.0.0's guard matched /runtime and /cli.js, and `npx withruntime ...` did nothing at all). */

import { main } from "./cli.js";

// exitCode, never exit(): a pipe's stdout on macOS is written after the call returns, and exit() cut --help at 64 KiB.
// A reader that closed its end (`runtime ... | head`) has all it wanted.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code !== "EPIPE") throw e;
  process.exit(process.exitCode ?? 0);
});
void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
