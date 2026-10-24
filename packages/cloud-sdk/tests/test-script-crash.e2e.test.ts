import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crashed } from "../scripts/test";

/* Bun's real output, not a copy of it: a worker that crashes in a parallel
   run, the files it aborts, and a run where a test also fails on its own.
   Three runs of bun test with waits, 0.5 s, and Bun's output changes only
   with Bun: on main's check (.runtime/e2e-files.sh). */
function bunTest(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "sdk-crash-"));
  try {
    for (const [name, body] of Object.entries(files))
      writeFileSync(join(dir, name), `import { expect, test } from "bun:test";\n${body}\n`);
    const run = Bun.spawnSync([process.execPath, "test", "--parallel=2", "--no-isolate"], {
      cwd: dir,
    });
    return run.stdout.toString() + run.stderr.toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const waits = Object.fromEntries(
  [1, 2, 3, 4].map((i) => [
    `wait${i}.test.ts`,
    `test("waits", async () => { await Bun.sleep(300); expect(1).toBe(1); });`,
  ]),
);
const crash = `test("crashes", () => { process.kill(process.pid, "SIGSEGV"); });`;

test("a crashed worker's file and the files it aborted run again, with Bun's line", () => {
  const output = bunTest({ ...waits, "crash.test.ts": crash });
  const again = crashed(output);
  expect(again?.lines).toEqual([
    expect.stringContaining("crashed with SIGSEGV while running crash.test.ts"),
  ]);
  expect(again?.files).toContain("./crash.test.ts");
  expect(again!.files.length).toBeGreaterThan(1);
  for (const file of again!.files) expect(file).toMatch(/^\.\/(crash|wait\d)\.test\.ts$/);
});

test("a test that failed on its own is never hidden by a rerun", () => {
  const output = bunTest({
    "fails.test.ts": `test("fails", () => { expect(1).toBe(2); });`,
    "crash.test.ts": `test("crashes", async () => { await Bun.sleep(500); process.kill(process.pid, "SIGSEGV"); });`,
  });
  expect(output).toContain("(fail) fails");
  expect(crashed(output)).toBeUndefined();
});

test("a run that did not crash runs nothing again", () => {
  expect(
    crashed(bunTest({ "fails.test.ts": `test("fails", () => { expect(1).toBe(2); });` })),
  ).toBeUndefined();
});
