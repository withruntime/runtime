/* The runner in a code job's image (`runtime jobs deploy` copies this file,
   built, to .runtime/jobs-runner.ts). It imports nothing of the SDK: the
   project's own files import withruntime/trigger or withruntime/inngest,
   which register their tasks on globalThis (registry.ts), and this reads
   them there.

     bun .runtime/jobs-runner.ts discover <file>...
       prints one line, JOBS-DISCOVERED <json>: every task the files declare,
       and trigger.config's defaults when a file defines them
     bun .runtime/jobs-runner.ts run <file> <kind> <id> [<payload as base64 JSON>]
       runs one task; exits 0 when it returns, 1 when it throws */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Task = {
  kind: string;
  id: string;
  schedule: unknown;
  events?: string[];
  compute?: unknown;
  maxDuration?: number;
  retry?: unknown;
  invoke(input: { payload: unknown; attempt: number; runId: string }): Promise<unknown>;
};

const registry = () =>
  (globalThis as unknown as Record<symbol, Map<string, Task> | undefined>)[
    Symbol.for("withruntime.jobs.tasks")
  ] ?? new Map<string, Task>();

async function load(file: string): Promise<void> {
  await import(pathToFileURL(resolve(file)).href);
}

export async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === "discover") {
    const found: unknown[] = [];
    for (const file of rest) {
      const before = new Set(registry().keys());
      try {
        await load(file);
      } catch (error) {
        console.error(
          `JOBS-FILE-FAILED ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      for (const [key, task] of registry()) {
        if (before.has(key)) continue;
        const described = Object.fromEntries(
          Object.entries(task).filter(([field]) => field !== "invoke"),
        ) as Omit<typeof task, "invoke">;
        found.push({ ...described, file });
      }
    }
    const config = (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("withruntime.trigger.config")
    ];
    console.log(
      `JOBS-DISCOVERED ${JSON.stringify({ tasks: found, triggerConfig: config ?? null })}`,
    );
    return 0;
  }
  if (verb === "run") {
    const [file, kind, id, payload] = rest;
    if (!file || !kind || !id) {
      console.error("usage: run <file> <kind> <id> [<payload>]");
      return 2;
    }
    await load(file);
    const task = registry().get(`${kind}:${id}`);
    if (!task) {
      console.error(
        `${file} declares no ${kind} task "${id}": was it renamed? Run \`runtime jobs deploy\` again.`,
      );
      return 2;
    }
    const input = payload
      ? (JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as unknown)
      : undefined;
    try {
      await task.invoke({
        payload: input,
        attempt: 1,
        runId: process.env.RUNTIME_SANDBOX_ID ?? "",
      });
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      return 1;
    }
  }
  console.error("usage: discover <file>... | run <file> <kind> <id> [<payload>]");
  return 2;
}

if (/(^|[/\\])(jobs-)?runner\.[jt]s$/.test(process.argv[1] ?? ""))
  process.exit(await main(process.argv.slice(2)));
