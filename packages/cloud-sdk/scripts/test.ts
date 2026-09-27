import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/* Every SDK's tests at once. Each part starts its own fixture server, so none
   waits on another; one after another they took two minutes, and the Python
   suite alone waited a minute for the TypeScript tests to finish
   (26 September 2026). A part's output is printed whole when it ends, so the
   parts do not interleave, and the run fails if any part does. */
const sdk = fileURLToPath(new URL("..", import.meta.url));
const parts: [string, string[]][] = [
  ["typescript", ["test", "--parallel", "--timings=.test-timings.json", "--update-timings"]],
  ["python", ["scripts/test-python.ts"]],
  ["go", ["scripts/test-go.ts"]],
  ["java", ["../../sdks/java/scripts/check.ts"]],
  ["ruby", ["../../sdks/ruby/scripts/check.ts"]],
];

const results = await Promise.all(
  parts.map(
    ([name, args]) =>
      new Promise<{ name: string; code: number; seconds: number }>((resolve) => {
        const started = performance.now();
        const child = spawn(process.execPath, args, { cwd: sdk, env: process.env });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.on("close", (code) => {
          const seconds = (performance.now() - started) / 1000;
          process.stdout.write(`\n── ${name} (${seconds.toFixed(1)}s) ──\n${output}`);
          resolve({ name, code: code ?? 1, seconds });
        });
      }),
  ),
);

const failed = results.filter((r) => r.code !== 0).map((r) => r.name);
if (failed.length) {
  console.error(`\nFailed: ${failed.join(", ")}`);
  process.exitCode = 1;
}
