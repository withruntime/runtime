import { expect, test } from "bun:test";
import { Command } from "../../src/vercel/command";
import type { Process } from "../../src/sandbox";

function command(output: Process["output"]) {
  return new Command({
    id: "p",
    cwd: "/workspace",
    startedAt: 0,
    sandboxName: "test",
    process: { id: "p", output } as Process,
  });
}
test("Vercel wait and logs cannot report success after losing process output", async () => {
  const output: Process["output"] = async function* () {
    yield { type: "truncated", droppedBytes: 20, resumeAt: 20 };
    yield { type: "stdout", data: "tail", offset: 20 };
    yield { type: "exit", exitCode: 0, state: "exited", timedOut: false };
  };
  await expect(command(output).wait()).rejects.toMatchObject({
    name: "StreamError",
    code: "output_truncated",
  });
  await expect(Array.fromAsync(command(output).logs())).rejects.toMatchObject({
    name: "StreamError",
    code: "output_truncated",
  });
});
test("already cancelled Vercel logs never start an output request", async () => {
  let reads = 0;
  const output: Process["output"] = async function* () {
    reads++;
    yield { type: "stdout", data: "bad", offset: 0 };
  };
  expect(await Array.fromAsync(command(output).logs({ signal: AbortSignal.abort() }))).toEqual([]);
  expect(reads).toBe(0);
  const cached = new Command({
    id: "p",
    cwd: "/workspace",
    startedAt: 0,
    sandboxName: "test",
    lines: [{ stream: "stdout", data: "cached" }],
  });
  expect(await Array.fromAsync(cached.logs({ signal: AbortSignal.abort() }))).toEqual([]);
});
