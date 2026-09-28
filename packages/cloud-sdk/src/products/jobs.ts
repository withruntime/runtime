import { Page } from "../page.js";
import { RuntimeError, ServiceUnavailableError } from "../errors.js";
import type { RequestOptions, Transport } from "../transport.js";

/** A run's sandbox. Every field has a default; a run is a paid sandbox of this
 * size, billed at the sandbox rates. */
export type JobCompute = {
  region: string;
  vcpu: number;
  cpuMode: "shared" | "reserved";
  /** Guaranteed CPU in thousandths of a vCPU while shared. */
  cpuFloorMillis: number;
  memoryMiB: number;
  diskMiB: number;
  /** How long each run's sandbox is paid for, at most an hour. Defaults to
   * the timeout plus a minute to start. */
  durationSeconds: number;
  /** The most one run may hold, in microdollars. */
  maxCostMicros?: number;
};
export type JobSchedule =
  | { kind: "once"; /** Unix milliseconds. */ at: number }
  | { kind: "cron"; expression: string; timezone?: string };
export type JobDefinition = {
  name: string;
  schedule: JobSchedule;
  compute: JobCompute & { memoryGuarantee?: "reclaimable" };
  command: { argv: string[]; cwd?: string };
  timeoutSeconds: number;
  maxTotalCostMicros?: number;
  retry: { maxAttempts: number; backoffSeconds: number };
  secrets: Array<{ name: string; secretId: string }>;
};
export type Job = {
  id: string;
  name: string;
  definition: JobDefinition;
  state: "active" | "paused" | "canceled" | "finished";
  version: number;
  /** Unix milliseconds, or null when nothing more is scheduled. */
  nextRunAt: number | null;
  /** Why the last due run could not start, retried every 30 seconds:
   * `credits` (add credit), `capacity`, `cost_cap` (maxTotalCostMicros or a
   * key's daily limit) or `permission` (the key that made the job lost it). */
  blockedReason: "permission" | "capacity" | "credits" | "cost_cap" | null;
  createdAt: number;
  updatedAt: number;
};
export type JobRunState =
  | "provisioning"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "canceling"
  | "canceled"
  | "unknown";
/** One attempt of one occurrence, in a fresh sandbox (`resourceId`). */
export type JobRun = {
  id: string;
  jobId: string;
  occurrenceId: string;
  attempt: number;
  scheduledFor: number;
  resourceId: string;
  /** `unknown`: the outcome could not be observed (the sandbox stopped under
   * it). It is never retried by itself. */
  state: JobRunState;
  runGeneration: number;
  executionEpoch: number | null;
  deadlineAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  reason: string | null;
  logBytes: number;
  logsTruncated: boolean;
  createdAt: number;
};
export type JobLogs = {
  chunks: Array<{ offset: number; stream: "stdout" | "stderr"; text: string }>;
  /** Pass back as `cursor` for what follows. */
  nextCursor: number;
  truncated: boolean;
  /** The run has ended and every byte has been read. */
  complete: boolean;
};

/** What `jobs.create` takes. Everything but `name`, `schedule` and `command`
 * has a default. */
export type CreateJob = {
  /** Letters, digits, `.`, `_` and `-`, starting with a letter or digit; at most 80. */
  name: string;
  /** `{ at }` once (a Date, an ISO time or Unix milliseconds; a time already
   * past runs at once), or `{ cron: "0 3 * * *", timezone?: "Europe/Berlin" }`,
   * UTC by default. The raw API shape (`{ kind: ... }`) is accepted too. */
  schedule: { at: Date | string | number } | { cron: string; timezone?: string } | JobSchedule;
  /** An argv array, run as given (no shell); wrap a script in
   * `["bash", "-lc", "..."]`. Or `{ argv, cwd }`, cwd under /workspace. */
  command: string[] | { argv: string[]; cwd?: string };
  /** Seconds a run may take before it is stopped. Default 1800. */
  timeoutSeconds?: number;
  compute?: Partial<JobCompute>;
  /** Attempts per occurrence after a failure (exit code not 0), 1 to 5.
   * Default one attempt, no retry. */
  retry?: { maxAttempts: number; backoffSeconds: number };
  /** Job secrets (`runtime.secrets.set(name, { value, jobs: true })`) put
   * into the run's environment: `{ name: "ENV_NAME", secretId }`. */
  secrets?: Array<{ name: string; secretId: string }>;
  /** The most every run of this job together may hold, in microdollars. */
  maxTotalCostMicros?: number;
};

/** The size a run gets when `compute` leaves a field out: the sandbox
 * defaults, in the region `us-east-vin`. */
export const JOB_DEFAULTS = {
  region: "us-east-vin",
  vcpu: 2,
  cpuMode: "shared" as const,
  cpuFloorMillis: 50,
  memoryMiB: 4096,
  diskMiB: 4096,
  timeoutSeconds: 1800,
  /** Added to the timeout for the sandbox to start, within the hour. */
  startSeconds: 60,
};
/** A run is one sandbox: at most 16 vCPU and 64 GiB, a disk no smaller than
 * the system image, and paid for at most an hour. */
export const JOB_LIMITS = {
  maxVcpu: 16,
  maxMemoryMiB: 65_536,
  minDiskMiB: 3072,
  maxDurationSeconds: 3600,
  maxAttempts: 5,
  maxSecrets: 16,
};

function invalid(message: string, field: string): RuntimeError {
  return new RuntimeError({
    message,
    code: "invalid_request",
    status: 0,
    details: { field },
    hint: "Nothing was sent. Fix the field and call again.",
  });
}

/** Unix milliseconds from a Date, an ISO time or a number. */
export function jobTime(at: Date | string | number): number {
  const ms =
    at instanceof Date
      ? at.getTime()
      : typeof at === "number"
        ? at
        : /^\d+$/.test(at)
          ? Number(at)
          : Date.parse(at);
  if (!Number.isSafeInteger(ms) || ms < 0)
    throw invalid(
      `schedule.at must be a time: a Date, an ISO time such as 2026-10-01T03:00:00Z, or Unix milliseconds; got ${String(at)}.`,
      "schedule.at",
    );
  return ms;
}

/** The API's job body from `CreateJob`, with every default filled in and the
 * sandbox's size checked before anything is sent. */
export function jobBody(input: CreateJob): Record<string, unknown> {
  const s = input.schedule as Record<string, unknown>;
  let schedule: JobSchedule;
  if (s.kind === "once" || (s.kind === undefined && s.at !== undefined))
    schedule = { kind: "once", at: jobTime(s.at as Date | string | number) };
  else if (s.kind === "cron" || (s.kind === undefined && s.cron !== undefined)) {
    const expression = String(s.expression ?? s.cron).trim();
    if (expression.split(/\s+/).length !== 5)
      throw invalid(
        `A cron schedule has five fields, minute hour day-of-month month day-of-week, such as "0 3 * * *"; got "${expression}".`,
        "schedule.cron",
      );
    schedule = {
      kind: "cron",
      expression,
      ...(s.timezone === undefined ? {} : { timezone: s.timezone as string }),
    };
  } else throw invalid("schedule takes { at } or { cron }.", "schedule");
  const command = Array.isArray(input.command) ? { argv: input.command } : input.command;
  if (!command?.argv?.length)
    throw invalid('command is an argv array such as ["python3", "job.py"].', "command");
  const timeoutSeconds = input.timeoutSeconds ?? JOB_DEFAULTS.timeoutSeconds;
  const given = input.compute ?? {};
  const vcpu = given.vcpu ?? JOB_DEFAULTS.vcpu;
  const cpuMode = given.cpuMode ?? JOB_DEFAULTS.cpuMode;
  const compute: JobCompute = {
    region: given.region ?? JOB_DEFAULTS.region,
    vcpu,
    cpuMode,
    cpuFloorMillis:
      given.cpuFloorMillis ??
      (cpuMode === "reserved" ? vcpu * 1000 : Math.min(JOB_DEFAULTS.cpuFloorMillis, vcpu * 1000)),
    memoryMiB: given.memoryMiB ?? JOB_DEFAULTS.memoryMiB,
    diskMiB: given.diskMiB ?? JOB_DEFAULTS.diskMiB,
    durationSeconds:
      given.durationSeconds ??
      Math.min(JOB_LIMITS.maxDurationSeconds, timeoutSeconds + JOB_DEFAULTS.startSeconds),
    ...(given.maxCostMicros === undefined ? {} : { maxCostMicros: given.maxCostMicros }),
  };
  if (compute.vcpu > JOB_LIMITS.maxVcpu || compute.memoryMiB > JOB_LIMITS.maxMemoryMiB)
    throw invalid(
      `A run's sandbox is at most ${JOB_LIMITS.maxVcpu} vCPU and ${JOB_LIMITS.maxMemoryMiB / 1024} GiB of memory; asked for ${compute.vcpu} vCPU and ${compute.memoryMiB} MiB.`,
      compute.vcpu > JOB_LIMITS.maxVcpu ? "compute.vcpu" : "compute.memoryMiB",
    );
  if (compute.diskMiB < JOB_LIMITS.minDiskMiB)
    throw invalid(
      `A run's disk is at least ${JOB_LIMITS.minDiskMiB} MiB, the size of the system image; asked for ${compute.diskMiB}.`,
      "compute.diskMiB",
    );
  if (
    timeoutSeconds > compute.durationSeconds ||
    compute.durationSeconds > JOB_LIMITS.maxDurationSeconds
  )
    throw invalid(
      `timeoutSeconds (${timeoutSeconds}) must fit in the time a run is paid for (compute.durationSeconds ${compute.durationSeconds}), which is at most ${JOB_LIMITS.maxDurationSeconds} seconds.`,
      "timeoutSeconds",
    );
  return {
    name: input.name,
    schedule,
    compute,
    command,
    timeoutSeconds,
    ...(input.retry === undefined ? {} : { retry: input.retry }),
    ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
    ...(input.maxTotalCostMicros === undefined
      ? {}
      : { maxTotalCostMicros: input.maxTotalCostMicros }),
  };
}

const enc = encodeURIComponent;

/** The API answers a product switched off where it runs with 503
 * `unavailable` and words that do not name it ("This product is not enabled
 * on this deployment."). This names the product, keeps the code, status and
 * request id, and says no retry will change it. */
export function switchedOff(product: string) {
  return (error: unknown): never => {
    if (error instanceof RuntimeError && error.code === "unavailable")
      throw new ServiceUnavailableError({
        message: `${product} are not enabled on this Runtime API yet.`,
        code: error.code,
        status: error.status,
        hint: `${product} are switched off here for now, so retrying will not help. Tell us you need them: runtime feedback "need ${product.toLowerCase()}".`,
        ...(error.requestId ? { requestId: error.requestId } : {}),
        ...(error.details ? { details: error.details } : {}),
        cause: error,
      });
    throw error;
  };
}

/** Scheduled jobs: a command run in a fresh sandbox, once or on a cron
 * schedule. Each run is a paid sandbox, charged at the sandbox rates through
 * the same holds and spending limits; the trial's hours do not fund jobs.
 *
 *   const job = await runtime.jobs.create({
 *     name: "nightly-report",
 *     schedule: { cron: "0 3 * * *", timezone: "Europe/Berlin" },
 *     command: ["python3", "/workspace/report.py"],
 *   });
 *
 * When jobs are switched off where you call, every method fails at once with
 * `ServiceUnavailableError` (code `unavailable`, "Jobs are unavailable."),
 * which retrying does not change. */
export function jobs(transport: Transport) {
  const off = switchedOff("Jobs");
  const t = {
    json: <T>(call: Parameters<Transport["json"]>[0]) => transport.json<T>(call).catch(off),
  };
  type Wire<T> = { items: T[]; nextCursor: string | null };
  const list = async (
    query: { limit?: number; cursor?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<Job>> => {
    const page = await t.json<Wire<Job>>({ method: "GET", path: "/v1/jobs", query, ...options });
    return new Page(page.items, page.nextCursor, (cursor) => list({ ...query, cursor }, options));
  };
  const runs = async (
    jobId: string,
    query: { limit?: number; cursor?: string } = {},
    options?: RequestOptions,
  ): Promise<Page<JobRun>> => {
    const page = await t.json<Wire<JobRun>>({
      method: "GET",
      path: `/v1/jobs/${enc(jobId)}/runs`,
      query,
      ...options,
    });
    return new Page(page.items, page.nextCursor, (cursor) =>
      runs(jobId, { ...query, cursor }, options),
    );
  };
  const verb = (id: string, action: "pause" | "resume" | "cancel", options?: RequestOptions) =>
    t.json<Job>({ method: "POST", path: `/v1/jobs/${enc(id)}:${action}`, body: {}, ...options });
  return {
    /** Schedule a job. Nothing runs until its time comes; a time already past
     * runs at once. Sizes, timeout and region default to a 2 vCPU, 4 GiB
     * sandbox for up to 30 minutes. */
    create: (input: CreateJob, options?: RequestOptions) =>
      t.json<Job>({ method: "POST", path: "/v1/jobs", body: jobBody(input), ...options }),
    /** Your jobs, oldest first. Await for a page, or `for await` for all. */
    list,
    get: (id: string, options?: RequestOptions) =>
      t.json<Job>({ method: "GET", path: `/v1/jobs/${enc(id)}`, ...options }),
    /** A job's runs, oldest first: each attempt of each occurrence. */
    runs,
    /** One run by its id. */
    run: (runId: string, options?: RequestOptions) =>
      t.json<JobRun>({ method: "GET", path: `/v1/job-runs/${enc(runId)}`, ...options }),
    /** A run's output from `cursor` (a byte offset, 0 by default), at most
     * `limitBytes` (4 to 65536, default 16384). Keep calling with `nextCursor`
     * until `complete`. A run keeps its last 256 KiB. */
    logs: (
      runId: string,
      query: { cursor?: number; limitBytes?: number } = {},
      options?: RequestOptions,
    ) =>
      t.json<JobLogs>({
        method: "GET",
        path: `/v1/job-runs/${enc(runId)}/logs`,
        query,
        ...options,
      }),
    /** Stop scheduling new runs; a run already going finishes. */
    pause: (id: string, options?: RequestOptions) => verb(id, "pause", options),
    resume: (id: string, options?: RequestOptions) => verb(id, "resume", options),
    /** End the job for good and stop any run in progress. A run that already
     * finished keeps its result. Cancelling again answers the same job. */
    cancel: (id: string, options?: RequestOptions) => verb(id, "cancel", options),
  };
}
