/* Runs in each test worker before its first file. */
import { setDefaultTimeout } from "bun:test";

/* A test or hook has thirty seconds, not bun's five, as in packages/db and
   packages/cloud. CI runs the TypeScript tests beside every other SDK's suite
   on a 4-vCPU sandbox, and of the 132 files the old FLAKY.md listed, 62
   failed only for passing their time limit and passed when run alone
   (13 October 2026). How fast something is belongs in a *.speed.test.ts
   file; a test that needs more than thirty seconds says so with its own
   timeout. */
setDefaultTimeout(30_000);
