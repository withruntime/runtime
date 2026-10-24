/* Runs in each test worker before its first file. */
import { afterEach, setDefaultTimeout } from "bun:test";
import { sandboxMarker } from "../src/transport";

/* A test or hook has thirty seconds, not bun's five, as in packages/db and
   packages/cloud. CI runs the TypeScript tests beside every other SDK's suite
   on a 4-vCPU sandbox, and of the 132 files the old FLAKY.md listed, 62
   failed only for passing their time limit and passed when run alone
   (13 October 2026). How fast something is belongs in a *.speed.test.ts
   file; a test that needs more than thirty seconds says so with its own
   timeout. */
setDefaultTimeout(30_000);

/* No test reaches the sandbox it runs in. Run inside a Runtime sandbox (as
   CI/CD and agents do), a login asked the real host for an identity token
   and kept it for ten minutes, so with one worker running many files a later
   file's "outside a sandbox" login carried it (23 October 2026). A test that
   wants a sandbox points sandboxMarker.path at a file of its own. */
const outside = "/nonexistent/runtime-test/environment.json";
sandboxMarker.path = outside;
delete process.env.RUNTIME_ID_TOKEN_REQUEST_URL;
delete process.env.RUNTIME_ID_TOKEN_REQUEST_TOKEN;

/* A worker keeps one global across the files it runs (bun test
   --no-isolate, scripts/test.ts), so what a test swaps in goes back after
   it, whether or not its own file remembered: a fetch stub left by one file
   was the "real" fetch tests/fixtures/fake-clock.ts kept for the next. */
const pristine = { fetch: globalThis.fetch };
afterEach(() => {
  globalThis.fetch = pristine.fetch;
  delete (crypto.subtle as Partial<SubtleCrypto>).digest;
  sandboxMarker.path = outside;
});
