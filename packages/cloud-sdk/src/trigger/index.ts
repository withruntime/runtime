/* Trigger.dev's task SDK, run on Runtime Jobs: change `@trigger.dev/sdk` (or
   `@trigger.dev/sdk/v3`) to `withruntime/trigger`, then `npx withruntime jobs
   deploy`. Each `schedules.task` becomes a Runtime job on its cron; each
   `task` becomes a job that `tasks.trigger(id, payload)` (or the task's own
   `trigger`) runs once in a fresh sandbox with that payload. A run is a
   sandbox of the task's machine for up to its maxDuration, retried up to its
   retry.maxAttempts.

   What has no equivalent is refused by name when called, never ignored:
   triggerAndWait and batches (a run cannot wait on another here), queues'
   concurrency keys, imperative schedules (use runtime.jobs.reschedule), and
   waitpoint tokens. */

import { cronTimes } from "../jobs-code/cron.js";
import { jobNameOf, registerTask, type CodeTask } from "../jobs-code/registry.js";

export class AbortTaskRunError extends Error {}
export class CompatibilityError extends Error {
  readonly code = "not_supported";
}
const refuse = (what: string, instead: string) => {
  throw new CompatibilityError(`${what} has no equivalent on Runtime Jobs: ${instead}`);
};

/** Trigger.dev's machine presets as vCPU and MiB: a job's sandbox is at
 * least 1 vCPU and 128 MiB, so the smaller ones round up to it. */
export const MACHINES: Record<string, { vcpu: number; memoryMiB: number }> = {
  micro: { vcpu: 1, memoryMiB: 256 },
  "small-1x": { vcpu: 1, memoryMiB: 512 },
  "small-2x": { vcpu: 1, memoryMiB: 1024 },
  "medium-1x": { vcpu: 1, memoryMiB: 2048 },
  "medium-2x": { vcpu: 2, memoryMiB: 4096 },
  "large-1x": { vcpu: 4, memoryMiB: 8192 },
  "large-2x": { vcpu: 8, memoryMiB: 16_384 },
};

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/** Month and day names as the numbers Runtime's cron takes. */
export function numericCron(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`"${cron}" is not five cron fields`);
  const names = (field: string, list: string[], first: number) =>
    field.toUpperCase().replace(/[A-Z]{3}/g, (n) => {
      const i = list.indexOf(n);
      if (i < 0) throw new Error(`"${cron}" uses ${n}, which is not a name cron knows`);
      return String(i + first);
    });
  f[3] = names(f[3]!, MONTHS, 1);
  f[4] = names(f[4]!, DAYS, 0);
  return f.join(" ");
}

type Machine = keyof typeof MACHINES | { preset?: keyof typeof MACHINES };
type Retry = { maxAttempts?: number; [key: string]: unknown };
export type Context = {
  task: { id: string; filePath: string };
  run: { id: string; tags: string[]; isTest: boolean; createdAt: Date; startedAt: Date };
  attempt: { number: number; startedAt: Date };
  environment: { type: "PRODUCTION"; slug: "prod" };
  machine: { name: string; cpu: number; memory: number };
  project: { ref: string };
};
type RunParams = { ctx: Context; signal: AbortSignal; init?: unknown };
type TaskOptions<P, O> = {
  id: string;
  run: (payload: P, params: RunParams) => Promise<O> | O;
  machine?: Machine;
  maxDuration?: number;
  retry?: Retry;
  queue?: { name?: string; concurrencyLimit?: number };
  description?: string;
  init?: (payload: P, params: RunParams) => unknown;
  cleanup?: (payload: P, params: RunParams) => unknown;
  onStart?: (payload: P, params: RunParams) => unknown;
  onSuccess?: (payload: P, output: O, params: RunParams) => unknown;
  onFailure?: (payload: P, error: unknown, params: RunParams) => unknown;
  onComplete?: (payload: P, result: unknown, params: RunParams) => unknown;
  [hook: string]: unknown;
};
export type ScheduledTaskPayload = {
  timestamp: Date;
  lastTimestamp: Date | undefined;
  timezone: string;
  scheduleId: string;
  externalId: string | undefined;
  upcoming: Date[];
};
type Cron = string | { pattern: string; timezone?: string; environments?: string[] };

const machineOf = (machine: Machine | undefined) => {
  const name = typeof machine === "string" ? machine : (machine?.preset ?? "small-1x");
  const found = MACHINES[name];
  if (!found)
    throw new Error(`machine "${name}" is not one of ${Object.keys(MACHINES).join(", ")}`);
  return { name, ...found };
};

/** The project's name, set by `defineConfig` or the deploy. */
const project = () =>
  process.env.RUNTIME_JOBS_PROJECT ??
  ((globalThis as Record<symbol, unknown>)[Symbol.for("withruntime.trigger.project")] as
    string | undefined) ??
  "trigger";

export type Task<P = unknown, O = unknown> = {
  id: string;
  trigger(payload?: P): Promise<{ id: string }>;
  triggerAndWait(payload?: P): never;
  batchTrigger(items: unknown[]): never;
  batchTriggerAndWait(items: unknown[]): never;
  /** For tests: the task's run function. */
  run(payload: P, params: RunParams): Promise<O> | O;
};

function declare<P, O>(
  options: TaskOptions<P, O>,
  schedule: { cron: string; timezone: string } | null,
  payloadOf: (given: unknown) => P,
): Task<P, O> {
  const machine = machineOf(options.machine);
  const explicit = options.machine !== undefined;
  const invoke: CodeTask["invoke"] = async ({ payload, attempt, runId }) => {
    const now = new Date();
    const ctx: Context = {
      task: { id: options.id, filePath: process.argv[3] ?? "" },
      run: { id: runId, tags: [], isTest: false, createdAt: now, startedAt: now },
      attempt: { number: attempt, startedAt: now },
      environment: { type: "PRODUCTION", slug: "prod" },
      machine: { name: machine.name, cpu: machine.vcpu, memory: machine.memoryMiB / 1024 },
      project: { ref: project() },
    };
    const controller = new AbortController();
    const params: RunParams = { ctx, signal: controller.signal };
    const input = payloadOf(payload);
    params.init = await options.init?.(input, params);
    await options.onStart?.(input, params);
    try {
      const output = await options.run(input, params);
      await options.onSuccess?.(input, output, params);
      await options.onComplete?.(input, { ok: true, data: output }, params);
      return output;
    } catch (error) {
      await options.onFailure?.(input, error, params);
      await options.onComplete?.(input, { ok: false, error }, params);
      throw error;
    } finally {
      await options.cleanup?.(input, params);
    }
  };
  registerTask({
    kind: "trigger",
    id: options.id,
    schedule,
    ...(explicit ? { compute: { vcpu: machine.vcpu, memoryMiB: machine.memoryMiB } } : {}),
    ...(options.maxDuration ? { maxDuration: options.maxDuration } : {}),
    ...(options.retry?.maxAttempts ? { retry: { maxAttempts: options.retry.maxAttempts } } : {}),
    invoke,
  });
  return {
    id: options.id,
    trigger: (payload?: P) => tasks.trigger(options.id, payload),
    triggerAndWait: () =>
      refuse("triggerAndWait", "a run cannot wait for another; trigger it and read its run later"),
    batchTrigger: () => refuse("batchTrigger", "call trigger once per payload"),
    batchTriggerAndWait: () => refuse("batchTriggerAndWait", "call trigger once per payload"),
    run: options.run,
  };
}

/** A task run on demand: `tasks.trigger(id, payload)` runs it once. */
export function task<P = unknown, O = unknown>(options: TaskOptions<P, O>): Task<P, O> {
  return declare(options, null, (given) => given as P);
}
export const schemaTask = <P = unknown, O = unknown>(
  options: TaskOptions<P, O> & { schema?: { parse?: (v: unknown) => P } },
) =>
  declare(options, null, (given) =>
    options.schema?.parse ? options.schema.parse(given) : (given as P),
  );

export const schedules = {
  /** A task on a cron: a Runtime job with that schedule. */
  task<O = unknown>(options: TaskOptions<ScheduledTaskPayload, O> & { cron?: Cron }) {
    if (!options.cron)
      refuse(
        `schedules.task "${options.id}" without a cron (schedules attached later with schedules.create)`,
        "give it a cron, or change a job's schedule with `runtime jobs reschedule`",
      );
    const cron = typeof options.cron === "string" ? { pattern: options.cron } : options.cron!;
    const timezone = cron.timezone ?? "UTC";
    const expression = numericCron(cron.pattern);
    return declare<ScheduledTaskPayload, O>(options, { cron: expression, timezone }, () => {
      const now = Date.now();
      const [timestamp, lastTimestamp] = cronTimes(expression, timezone, now, -1, 2);
      return {
        timestamp: timestamp ?? new Date(now),
        lastTimestamp,
        timezone,
        scheduleId: jobNameOf(project(), options.id),
        externalId: undefined,
        upcoming: cronTimes(expression, timezone, now + 60_000, 1, 10),
      };
    });
  },
  create: () =>
    refuse(
      "schedules.create",
      "a task's schedule is its cron; change it with runtime.jobs.reschedule",
    ),
  update: () => refuse("schedules.update", "use runtime.jobs.reschedule"),
  del: () => refuse("schedules.del", "use runtime.jobs.cancel"),
  deactivate: () => refuse("schedules.deactivate", "use runtime.jobs.pause"),
  activate: () => refuse("schedules.activate", "use runtime.jobs.resume"),
  list: () => refuse("schedules.list", "use runtime.jobs.list"),
  retrieve: () => refuse("schedules.retrieve", "use runtime.jobs.get"),
};

/** The job `runtime jobs deploy` made for task `id`. A backend calling
 * tasks.trigger, or a task triggering another in its run, has usually not
 * loaded trigger.config.ts, so it may not know the project's name: the job
 * is found by what it runs (`run <file> trigger <id>`, the deploy's
 * command), and the project's name only picks between projects that both
 * have a task with this id. */
export function taskJob<
  J extends { name: string; state: string; definition: { command: { argv: string[] } } },
>(id: string, jobs: J[]): J {
  const deployed = jobs.filter((job) => {
    const argv = job.definition.command.argv;
    return (
      (job.state === "active" || job.state === "paused") &&
      argv.length === 6 &&
      argv[1] === ".runtime/jobs-runner.ts" &&
      argv[2] === "run" &&
      argv[4] === "trigger" &&
      argv[5] === id
    );
  });
  if (deployed.length === 1) return deployed[0]!;
  const named = deployed.find((job) => job.name === jobNameOf(project(), id));
  if (named) return named;
  if (!deployed.length)
    throw new Error(
      `No job runs task "${id}": deploy it first with \`npx withruntime jobs deploy\`.`,
    );
  throw new Error(
    `Jobs ${deployed.map((job) => job.name).join(", ")} all run a task "${id}", one per project: set RUNTIME_JOBS_PROJECT to the project's name (trigger.config.ts's \`project\`) where tasks.trigger is called.`,
  );
}

export const tasks = {
  /** Runs the task once now, in a fresh sandbox of its image, with this
   * payload (at most 64 KiB as JSON). Needs RUNTIME_API_KEY where it is
   * called, and the task deployed with `runtime jobs deploy`. */
  async trigger(id: string, payload?: unknown): Promise<{ id: string }> {
    const { Runtime } = await import("../client.js");
    const runtime = new Runtime();
    const template = taskJob(id, await Array.fromAsync(await runtime.jobs.list({ limit: 100 })));
    const name = template.name;
    const body = Buffer.from(JSON.stringify(payload ?? null)).toString("base64");
    if (body.length > 65_536) throw new Error(`The payload is over 64 KiB as JSON.`);
    const definition = template.definition;
    const argv = [...definition.command.argv.slice(0, 6), body];
    const run = await runtime.jobs.create({
      name: `${name.slice(0, 60)}-${Date.now().toString(36)}`,
      schedule: { at: Date.now() },
      command: argv,
      ...(definition.image ? { image: definition.image } : {}),
      compute: definition.compute,
      timeoutSeconds: definition.timeoutSeconds,
      retry: definition.retry,
      ...(definition.secrets?.length ? { secrets: definition.secrets } : {}),
    });
    return { id: run.id };
  },
  triggerAndWait: () =>
    refuse(
      "tasks.triggerAndWait",
      "a run cannot wait for another; trigger it and read its run later",
    ),
  batchTrigger: () => refuse("tasks.batchTrigger", "call tasks.trigger once per payload"),
};

type Attributes = Record<string, unknown>;
const line = (level: string) => (message: string, attributes?: Attributes) =>
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    attributes ? `${message} ${JSON.stringify(attributes)}` : message,
  );
export const logger = {
  debug: line("debug"),
  log: line("log"),
  info: line("info"),
  warn: line("warn"),
  error: line("error"),
  trace: async <T>(_name: string, fn: (span: unknown) => Promise<T>) => fn({}),
};

type Duration = { seconds?: number; minutes?: number; hours?: number; days?: number };
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, Math.max(0, ms)));
/** Waits in the run, which counts toward its maxDuration. */
export const wait = {
  for: (d: Duration) =>
    sleep(
      ((d.seconds ?? 0) + (d.minutes ?? 0) * 60 + (d.hours ?? 0) * 3600 + (d.days ?? 0) * 86_400) *
        1000,
    ),
  until: ({ date }: { date: Date }) => sleep(date.getTime() - Date.now()),
  forToken: () => refuse("wait.forToken", "waitpoint tokens are not supported"),
  createToken: () => refuse("wait.createToken", "waitpoint tokens are not supported"),
};

/** trigger.config.ts's defineConfig: its `project` names the jobs. */
export function defineConfig<
  T extends {
    project?: string;
    dirs?: string[];
    maxDuration?: number;
    machine?: string;
    retries?: { default?: { maxAttempts?: number } };
  },
>(config: T): T {
  (globalThis as Record<symbol, unknown>)[Symbol.for("withruntime.trigger.config")] = {
    maxDuration: config.maxDuration,
    machine: config.machine,
    maxAttempts: config.retries?.default?.maxAttempts,
  };
  if (config.project)
    (globalThis as Record<symbol, unknown>)[Symbol.for("withruntime.trigger.project")] =
      config.project;
  return config;
}

export const configure = () => undefined;
export const auth = { configure: () => undefined, withAuth: <T>(_a: unknown, fn: () => T) => fn() };
export const metadata = {
  set: () => metadata,
  get: () => undefined,
  current: () => ({}),
  flush: async () => undefined,
};
export const runs = {
  retrieve: () => refuse("runs.retrieve", "read a run with runtime.jobs.run(id)"),
  list: () => refuse("runs.list", "list a job's runs with runtime.jobs.runs(id)"),
  cancel: () => refuse("runs.cancel", "use runtime.jobs.cancel"),
};
export const queue = (options: { name: string; concurrencyLimit?: number }) => options;
