/* The tasks a project's code declares through a drop-in (withruntime/trigger,
   withruntime/inngest), kept on globalThis under one symbol so the runner
   (runner.ts, copied into the job's image) finds them whatever copy of the
   SDK the project installed. `runtime jobs deploy` asks the runner to list
   them, then makes one Runtime job per task; each run imports the task's file
   and calls it. */

export type CodeTask = {
  /** "trigger" or "inngest": which drop-in declared it. */
  kind: "trigger" | "inngest";
  id: string;
  /** Five cron fields and a zone; null for a task run on demand. */
  schedule: { cron: string; timezone: string } | null;
  /** Inngest: the event names that run it. */
  events?: string[];
  compute?: { vcpu: number; memoryMiB: number };
  /** Seconds. */
  maxDuration?: number;
  retry?: { maxAttempts: number };
  /** Calls the task with what the runner hands it. */
  invoke(input: { payload: unknown; attempt: number; runId: string }): Promise<unknown>;
};

const KEY = Symbol.for("withruntime.jobs.tasks");

export function tasksRegistry(): Map<string, CodeTask> {
  const g = globalThis as unknown as Record<symbol, Map<string, CodeTask> | undefined>;
  let found = g[KEY];
  if (!found) {
    found = new Map();
    g[KEY] = found;
  }
  return found;
}

export function registerTask(task: CodeTask): void {
  const registry = tasksRegistry();
  const key = `${task.kind}:${task.id}`;
  if (registry.has(key))
    throw new Error(`Two ${task.kind} tasks have the id "${task.id}"; each id is one Runtime job.`);
  registry.set(key, task);
}

/** The name of the Runtime job that runs a task. */
export function jobNameOf(project: string, id: string): string {
  return `${project}-${id}`
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 80);
}
