import { test } from "bun:test";
import { checkCodeSandboxConsumers } from "./codesandbox-consumers.js";

test("CodeSandbox commands, tasks and setup preserve published consumer types", async () => {
  await checkCodeSandboxConsumers();
  // A whole-program type check: over 5 s alone, 28 s under a loaded full run.
}, 60_000);
