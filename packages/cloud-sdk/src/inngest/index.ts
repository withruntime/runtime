/* Inngest's SDK, run on Runtime Jobs: change `inngest` (and `inngest/next`,
   `inngest/express` and the other serve adapters) to `withruntime/inngest`,
   then `npx withruntime jobs deploy`. Each function with a cron trigger
   becomes a Runtime job on that schedule; each function with an event
   trigger becomes a job that `inngest.send` runs once, in a fresh sandbox,
   per matching event. `step.run` runs its code in the run and returns its
   result; `step.sleep` and `step.sleepUntil` wait in the run, which counts
   toward its timeout. A function's `retries` become the job's attempts.

   What has no equivalent is refused by name when called, never ignored:
   step.waitForEvent, step.invoke, concurrency keys, throttling, debounce and
   batching. Its serve() answers an Inngest server's calls with 410, since
   nothing calls the app any more. */

import { numericCron } from "../trigger/index.js";
import { jobNameOf, registerTask, tasksRegistry } from "../jobs-code/registry.js";

export class NonRetriableError extends Error {}
export class RetryAfterError extends Error {}
export class CompatibilityError extends Error {
  readonly code = "not_supported";
}
const refuse = (what: string, instead: string): never => {
  throw new CompatibilityError(`${what} has no equivalent on Runtime Jobs: ${instead}`);
};

export type EventPayload = {
  name: string;
  data?: unknown;
  id?: string;
  ts?: number;
  user?: unknown;
};
type Trigger = { cron: string } | { event: string; if?: string };
type FunctionOptions = {
  id: string;
  name?: string;
  retries?: number;
  timeouts?: { start?: string; finish?: string };
  [option: string]: unknown;
};

/** "30s", "5m", "2h", "1d", "1w", or milliseconds. */
export function durationMs(value: string | number): number {
  if (typeof value === "number") return value;
  let total = 0;
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/g;
  let matched = "";
  for (const m of value.matchAll(re)) {
    matched += m[0];
    total +=
      Number(m[1]) *
      { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]!]!;
  }
  if (!matched || matched.replace(/\s/g, "") !== value.replace(/\s/g, ""))
    throw new Error(`"${value}" is not a duration such as 30s, 5m, 2h or 1d`);
  return total;
}

/** Inngest's `TZ=Europe/Paris 0 12 * * 5`, as an expression and a zone. */
export function cronOf(text: string): { cron: string; timezone: string } {
  const found = /^\s*(?:(?:TZ|CRON_TZ)=(\S+)\s+)?(.+)$/.exec(text)!;
  return { cron: numericCron(found[2]!), timezone: found[1] ?? "UTC" };
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, Math.max(0, ms)));

function stepTools(client: Inngest) {
  return {
    run: async <T>(_id: string, fn: () => Promise<T> | T): Promise<T> => fn(),
    sleep: (_id: string, duration: string | number) => sleep(durationMs(duration)),
    sleepUntil: (_id: string, until: Date | string) =>
      sleep(new Date(until).getTime() - Date.now()),
    sendEvent: (_id: string, events: EventPayload | EventPayload[]) => client.send(events),
    waitForEvent: (): never =>
      refuse(
        "step.waitForEvent",
        "a run cannot pause for an event; send the event to start a function instead",
      ),
    invoke: (): never =>
      refuse(
        "step.invoke",
        "call the function's code directly, or send an event it is triggered by",
      ),
    ai: {
      infer: (): never => refuse("step.ai.infer", "call the model's API in step.run"),
      wrap: async <T>(_id: string, fn: (...a: unknown[]) => T, ...args: unknown[]) => fn(...args),
    },
  };
}

type Handler = (context: {
  event: EventPayload;
  events: EventPayload[];
  step: ReturnType<typeof stepTools>;
  logger: Pick<Console, "info" | "warn" | "error" | "debug">;
  runId: string;
  attempt: number;
}) => unknown;

export type InngestFunction = {
  id: (prefix?: string) => string;
  name: string;
  triggers: Trigger[];
};

export class Inngest {
  readonly id: string;
  constructor(options: { id: string; [option: string]: unknown }) {
    if (!options?.id) throw new Error("new Inngest({ id }) needs the app's id.");
    this.id = options.id;
  }

  /** `createFunction(options, trigger, handler)`, or, as Inngest's newer
   * SDKs write it, `createFunction({ ...options, triggers }, handler)`. */
  createFunction(
    options: FunctionOptions & { triggers: Trigger | Trigger[] },
    handler: Handler,
  ): InngestFunction;
  createFunction(
    options: FunctionOptions,
    trigger: Trigger | Trigger[],
    handler: Handler,
  ): InngestFunction;
  createFunction(
    options: FunctionOptions & { triggers?: Trigger | Trigger[] },
    triggerOrHandler: Trigger | Trigger[] | Handler,
    maybeHandler?: Handler,
  ): InngestFunction {
    const handler = (typeof triggerOrHandler === "function" ? triggerOrHandler : maybeHandler)!;
    const trigger =
      typeof triggerOrHandler === "function" ? (options.triggers ?? []) : triggerOrHandler;
    for (const key of [
      "concurrency",
      "throttle",
      "debounce",
      "batchEvents",
      "rateLimit",
      "priority",
      "cancelOn",
    ])
      if (options[key] !== undefined)
        refuse(
          `${options.id}'s ${key}`,
          "a function's runs here each get their own sandbox; remove it to deploy",
        );
    const triggers = Array.isArray(trigger) ? trigger : [trigger];
    if (!triggers.length) refuse(`${options.id} with no trigger`, "give it a cron or an event");
    const crons = triggers.flatMap((t) => ("cron" in t ? [cronOf(t.cron)] : []));
    const events = triggers.flatMap((t) => ("event" in t ? [t.event] : []));
    if (crons.length > 1)
      refuse(
        `${options.id}'s ${crons.length} cron triggers`,
        "a job has one schedule; split it into one function per cron",
      );
    const finish = options.timeouts?.finish
      ? Math.ceil(durationMs(options.timeouts.finish) / 1000)
      : undefined;
    registerTask({
      kind: "inngest",
      id: options.id,
      schedule: crons[0] ?? null,
      ...(events.length ? { events } : {}),
      ...(finish ? { maxDuration: finish } : {}),
      // Inngest retries 4 times unless told otherwise; a job makes at most 5 attempts.
      retry: { maxAttempts: Math.min(5, (options.retries ?? 4) + 1) },
      invoke: async ({ payload, attempt, runId }) => {
        const event: EventPayload = (payload as EventPayload | undefined) ?? {
          name: "inngest/scheduled.timer",
          data: { cron: crons[0]?.cron },
          ts: Date.now(),
        };
        try {
          return await handler({
            event,
            events: [event],
            step: stepTools(this),
            logger: console,
            runId,
            attempt: attempt - 1,
          });
        } catch (error) {
          // A NonRetriableError ends the run as succeeded-with-error, as
          // Inngest marks it failed but tries no more: exit 0 stops retries.
          if (error instanceof NonRetriableError) {
            console.error(`NonRetriableError: ${error.message}`);
            return undefined;
          }
          throw error;
        }
      },
    });
    return {
      id: (prefix?: string) => (prefix ? `${prefix}-${options.id}` : options.id),
      name: options.name ?? options.id,
      triggers,
    };
  }

  /** Runs every function of this app triggered by each event's name, once,
   * now, in a fresh sandbox, with the event as its payload. The functions
   * must be imported where this is called (as serve() imports them) and
   * deployed with `runtime jobs deploy`. */
  async send(payload: EventPayload | EventPayload[]): Promise<{ ids: string[] }> {
    const events = Array.isArray(payload) ? payload : [payload];
    const listening = [...tasksRegistry().values()].filter((t) => t.kind === "inngest");
    const { Runtime } = await import("../client.js");
    const runtime = new Runtime();
    const jobs = new Map<string, Awaited<ReturnType<typeof runtime.jobs.get>>>();
    for await (const job of await runtime.jobs.list({ limit: 100 }))
      if (job.state === "active" || job.state === "paused") jobs.set(job.name, job);
    const ids: string[] = [];
    for (const event of events) {
      const full = { id: crypto.randomUUID(), ts: Date.now(), data: {}, ...event };
      for (const fn of listening.filter((t) => t.events?.includes(event.name))) {
        const name = jobNameOf(this.id, fn.id);
        const template = jobs.get(name);
        if (!template)
          throw new Error(
            `No job ${name} for function "${fn.id}": deploy it with \`npx withruntime jobs deploy\`.`,
          );
        const body = Buffer.from(JSON.stringify(full)).toString("base64");
        if (body.length > 65_536) throw new Error(`Event ${event.name} is over 64 KiB as JSON.`);
        const d = template.definition;
        const run = await runtime.jobs.create({
          name: `${name.slice(0, 60)}-${Date.now().toString(36)}`,
          schedule: { at: Date.now() },
          command: [...d.command.argv.slice(0, 6), body],
          ...(d.image ? { image: d.image } : {}),
          compute: d.compute,
          timeoutSeconds: d.timeoutSeconds,
          retry: d.retry,
          ...(d.secrets?.length ? { secrets: d.secrets } : {}),
        });
        ids.push(run.id);
      }
    }
    return { ids };
  }
}

/** serve() of every adapter (inngest/next, /express, /hono, ...): nothing
 * calls the app's endpoint once its functions run as jobs, so it answers 410
 * with where they run now. */
export function serve(_options: { client: Inngest; functions: InngestFunction[] }) {
  const gone = () =>
    new Response(
      JSON.stringify({ message: "These functions run on Runtime Jobs now: `runtime jobs ls`." }),
      { status: 410, headers: { "content-type": "application/json" } },
    );
  const handler = Object.assign(gone, { GET: gone, POST: gone, PUT: gone });
  return handler;
}
