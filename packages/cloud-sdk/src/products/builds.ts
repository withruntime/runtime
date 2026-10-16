/** Builds uses the shared request keys and paged lists.
 * Unwired until the build planner's production adapter is ready. */
import { ConnectionError, RuntimeError } from "../errors.js";
import { Page } from "../page.js";
import { timeoutSignal, type RequestOptions, type Transport } from "../transport.js";

export type BuildState =
  | "queued"
  | "fetching"
  | "building"
  | "deploying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded";
type Resource = {
  id: string;
  name: string | null;
  labels: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  error: { code: string; message: string } | null;
};
export type Build = Resource & {
  repositoryId: string;
  ref: string;
  /** The branch whose move asked for it, when the caller said. */
  branch: string | null;
  commit: string | null;
  state: BuildState;
  reason: string | null;
  /** Milliseconds per step once the runner is done (install, build, mirror,
   * fork, snapshot, total, ...); null until then. */
  timings: Record<string, number> | null;
  /** The saved server an App deploys, once a build of a repository with a
   * start command succeeded; null otherwise. */
  outputSnapshotId: string | null;
};
export type CreateBuild = {
  repositoryId: string;
  ref: string;
  /** The same branch and commit is one build; a newer build of the branch
   * supersedes older ones not yet ended. */
  branch?: string;
  name?: string;
  labels?: Record<string, string>;
};
/** A connected repository's settings changed in place; its id and builds
 * stay. A field left out stays as it is; a null name clears it. */
export type ChangeRepository = Partial<Omit<ConnectRepository, "provider" | "name" | "labels">> & {
  name?: string | null;
  labels?: Record<string, string>;
};
export type ConnectRepository = {
  provider: "github" | "git";
  repository: string;
  deploy: `app:${string}` | `function:${string}` | `container:${string}`;
  productionBranch?: string;
  previews?: boolean;
  /** The folder the build runs in; the repository's root by default. */
  rootDirectory?: string;
  /** Leave out to choose by the lockfile (bun, pnpm, Yarn or npm). */
  installCommand?: string | null;
  buildCommand?: string | null;
  /** Run after the build with PORT set; the build ends as this server,
   * answering healthPath with 200 and saved with its memory. */
  startCommand?: string | null;
  port?: number;
  healthPath?: string | null;
  /** Settings install and build are given. Never a secret: anyone who reads
   * the repository sees them. */
  buildEnv?: Record<string, string>;
  name?: string;
  labels?: Record<string, string>;
};
export type Repository = Resource & {
  provider: "github" | "git";
  repository: string;
  deploy: ConnectRepository["deploy"];
  productionBranch: string;
  previews: boolean;
  rootDirectory: string;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  port: number;
  healthPath: string | null;
  buildEnv: Record<string, string>;
  state: "connected" | "disconnected";
};
export type ListBuilds = {
  limit?: number;
  cursor?: string;
  name?: string;
  label?: string[];
  state?: BuildState[];
};
export type ListRepositories = Omit<ListBuilds, "state"> & { state?: Repository["state"][] };
export type BuildLine = {
  cursor: string | null;
  at: number;
  step: string | null;
  text: string;
  stream: "stdout" | "stderr";
};
export type FailingStep = { name: string; exitCode: number | null; lastLines: string[] };
export type BuildLog = {
  lines: BuildLine[];
  cursor: string | null;
  state: BuildState;
  reason: string | null;
  failingStep: FailingStep | null;
  hasMore: boolean;
  nextCursor: string | null;
};
export type BuildLogEvent =
  | ({ type: "line" } & BuildLine & { cursor: string })
  | { type: "gap"; cursor: string | null; earliestCursor: string }
  | {
      type: "terminal";
      cursor: string | null;
      state: "succeeded" | "failed" | "cancelled" | "superseded";
      reason: string;
      failingStep: FailingStep | null;
    };
type WireEvent =
  | BuildLogEvent
  | { type: "continue"; cursor: string | null }
  | { type: "error"; cursor: string | null; code: string; hint: string };
/** cursor resumes a follow; pageCursor pages older search results. */
export type LogOptions = { follow?: boolean; cursor?: string; pageCursor?: string };
const terminal = new Set(["succeeded", "failed", "cancelled", "superseded"]);
function validFailure(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const step = value as FailingStep;
  return (
    typeof step.name === "string" &&
    (step.exitCode === null || Number.isSafeInteger(step.exitCode)) &&
    Array.isArray(step.lastLines) &&
    step.lastLines.length <= 20 &&
    step.lastLines.every((line) => typeof line === "string")
  );
}
function failure(code: string, hint: string, cursor: string | null) {
  return new RuntimeError({ code, status: 0, message: hint, hint, details: { cursor } });
}
function validCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    ![...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  );
}
/** Why a wait ended: the signal's own reason, always as an Error. */
const abortReason = (signal?: AbortSignal): Error =>
  signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason ?? "aborted"));

async function* boundedEvents<T>(
  source: AsyncGenerator<T>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  try {
    for (;;) {
      signal?.throwIfAborted();
      let abort: () => void = () => {};
      let next: IteratorResult<T>;
      try {
        next = await Promise.race([
          source.next(),
          new Promise<never>((_, reject) => {
            abort = () => reject(abortReason(signal));
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          }),
        ]);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // An injected transport can ignore abort while next() is pending. It must
    // not prevent the caller's deadline from resolving; request its cleanup.
    const closed = source.return(undefined);
    if (signal?.aborted) void closed.catch(() => {});
    else await closed;
  }
}

export function builds(t: Transport) {
  const path = (id: string) => `/v1/builds/${encodeURIComponent(id)}`;
  const list = async (query: ListBuilds = {}, options?: RequestOptions): Promise<Page<Build>> => {
    const page = await t.json<{ data: Build[]; nextCursor: string | null }>({
      method: "GET",
      path: "/v1/builds",
      query,
      ...options,
    });
    return new Page(page.data, page.nextCursor, (cursor) => list({ ...query, cursor }, options));
  };
  const listRepositories = async (
    query: ListRepositories = {},
    options?: RequestOptions,
  ): Promise<Page<Repository>> => {
    const page = await t.json<{ data: Repository[]; nextCursor: string | null }>({
      method: "GET",
      path: "/v1/repositories",
      query,
      ...options,
    });
    return new Page(page.data, page.nextCursor, (cursor) =>
      listRepositories({ ...query, cursor }, options),
    );
  };
  async function* follow(
    id: string,
    query: LogOptions,
    options: RequestOptions = {},
  ): AsyncGenerator<BuildLogEvent> {
    let cursor: string | null = query.cursor ?? null;
    if ((cursor !== null && !validCursor(cursor)) || query.pageCursor !== undefined)
      throw failure(
        "invalid_log_options",
        "Use an opaque cursor for follow; pageCursor is only for search pages.",
        cursor,
      );
    const seen = new Set<string>(cursor === null ? [] : [cursor]);
    let failures = 0;
    // Bound the entire follow when the caller sets a deadline, including
    // reconnections. Transport's per-request deadline alone resets on retry.
    const signal =
      (options.timeoutMs ?? 120_000) > 0
        ? AbortSignal.any([
            ...(options.signal ? [options.signal] : []),
            timeoutSignal(options.timeoutMs ?? 120_000),
          ])
        : options.signal;
    for (;;) {
      signal?.throwIfAborted();
      let continued = false;
      try {
        for await (const event of boundedEvents(
          t.events<WireEvent>({
            method: "GET",
            path: `${path(id)}/logs`,
            query: { follow: true, ...(cursor === null ? {} : { cursor }) },
            ...options,
            ...(signal ? { signal } : {}),
          }),
          signal,
        )) {
          signal?.throwIfAborted();
          if (!event || typeof event !== "object")
            throw failure(
              "build_log_invalid",
              "Retry the log from the last received cursor.",
              cursor,
            );
          if (event.cursor !== null && !validCursor(event.cursor))
            throw failure("build_log_invalid", "Retry from the last received cursor.", cursor);
          if (event.type === "line") {
            if (
              typeof event.text !== "string" ||
              !["stdout", "stderr"].includes(event.stream) ||
              !Number.isSafeInteger(event.at) ||
              event.at < 0 ||
              (event.step !== null && typeof event.step !== "string") ||
              !validCursor(event.cursor)
            )
              throw failure(
                "build_log_invalid",
                "Retry the log from the last received cursor.",
                cursor,
              );
            // Opaque physical positions cannot be ordered or incremented.
            if (seen.has(event.cursor)) continue;
            seen.add(event.cursor);
            if (seen.size > 10_000) seen.delete(seen.values().next().value!);
            cursor = event.cursor;
            failures = 0;
            yield event;
          } else if (event.type === "gap") {
            if (!validCursor(event.earliestCursor) || (cursor !== null && event.cursor !== cursor))
              throw failure("build_log_invalid", "Retry from the last received cursor.", cursor);
            cursor = event.cursor;
            yield event;
          } else if (event.type === "terminal") {
            if (
              (cursor !== null && event.cursor !== cursor) ||
              !terminal.has(event.state) ||
              typeof event.reason !== "string" ||
              !event.reason ||
              !validFailure(event.failingStep) ||
              (event.state !== "failed" && event.failingStep !== null)
            )
              throw failure(
                "build_log_invalid",
                "Retry the log from the last received cursor.",
                cursor,
              );
            yield event;
            return;
          } else if (event.type === "continue") {
            if (cursor !== null && event.cursor !== cursor)
              throw failure(
                "build_log_gap",
                "Resume from details.cursor; report a persistent missing log line.",
                cursor,
              );
            cursor = event.cursor;
            continued = true;
            break;
          } else if (event.type === "error") {
            if (
              event.cursor !== cursor ||
              typeof event.code !== "string" ||
              !event.code ||
              typeof event.hint !== "string" ||
              !event.hint
            )
              throw failure(
                "build_log_invalid",
                "Retry the log from the last received cursor.",
                cursor,
              );
            throw failure(event.code, event.hint, cursor);
          } else
            throw failure(
              "build_log_invalid",
              "Retry the log from the last received cursor.",
              cursor,
            );
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof SyntaxError)
          throw failure(
            "build_log_invalid",
            "The log contained invalid JSON; retry from details.cursor.",
            cursor,
          );
        // HTTP refusals and protocol errors are actionable, not connection
        // loss. The transport itself retries retryable HTTP responses.
        if (!(error instanceof TypeError) && !(error instanceof ConnectionError)) throw error;
      }
      if (!continued && ++failures > 3)
        throw failure(
          "build_log_interrupted",
          "Reconnect with logs(id, { follow: true, cursor: details.cursor }).",
          cursor,
        );
      // Prevent a disconnected service or repeated continuations busy-looping.
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(done, 50 * Math.max(1, failures));
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(abortReason(signal));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
  function logs(
    id: string,
    query: LogOptions & { follow: true },
    options?: RequestOptions,
  ): AsyncGenerator<BuildLogEvent>;
  function logs(
    id: string,
    query?: LogOptions & { follow?: false },
    options?: RequestOptions,
  ): Promise<BuildLog>;
  function logs(
    id: string,
    query: LogOptions,
    options?: RequestOptions,
  ): Promise<BuildLog> | AsyncGenerator<BuildLogEvent>;
  function logs(
    id: string,
    query: LogOptions = {},
    options?: RequestOptions,
  ): Promise<BuildLog> | AsyncGenerator<BuildLogEvent> {
    return query.follow
      ? follow(id, query, options)
      : t.json<BuildLog>({ method: "GET", path: `${path(id)}/logs`, query, ...options });
  }
  return {
    create: (input: CreateBuild, options?: RequestOptions) =>
      t.json<Build>({ method: "POST", path: "/v1/builds", body: input, ...options }),
    get: (id: string, options?: RequestOptions) =>
      t.json<Build>({ method: "GET", path: path(id), ...options }),
    list,
    logs,
    cancel: (id: string, options?: RequestOptions) =>
      t.json<Build>({ method: "POST", path: `${path(id)}:cancel`, ...options }),
    repositories: {
      connect: (input: ConnectRepository, options?: RequestOptions) =>
        t.json<Repository>({ method: "POST", path: "/v1/repositories", body: input, ...options }),
      list: listRepositories,
      update: (id: string, change: ChangeRepository, options?: RequestOptions) =>
        t.json<Repository>({
          method: "POST",
          path: `/v1/repositories/${encodeURIComponent(id)}:update`,
          body: change,
          ...options,
        }),
      disconnect: (id: string, options?: RequestOptions) =>
        t.json<Repository>({
          method: "DELETE",
          path: `/v1/repositories/${encodeURIComponent(id)}`,
          ...options,
        }),
    },
  };
}
