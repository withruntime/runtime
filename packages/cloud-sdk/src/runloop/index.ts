import { PagePromise, DevboxViewsCursorIDPage } from "./pagination.js";
import type { Runtime } from "../client.js";
import { Sandbox } from "../sandbox.js";
import type { CommandResult, SandboxInfo } from "../types.js";
import {
  DiskSnapshots,
  requestOptions,
  snapshotOptions,
  snapshotView,
  nativeOptions,
  type DevboxSnapshotDiskParams,
  type DevboxSnapshotView,
  type DiskSnapshotListParams,
} from "./snapshots.js";
export {
  DiskSnapshots,
  type DevboxSnapshotDiskParams,
  type DevboxSnapshotView,
  type DevboxSnapshotAsyncStatusView,
  type DiskSnapshotListParams,
} from "./snapshots.js";
export {
  PagePromise,
  DevboxSnapshotViewsDiskSnapshotsCursorIDPage,
  DevboxViewsCursorIDPage,
} from "./pagination.js";
import {
  client,
  CompatibilityError,
  create,
  destroy,
  execOptions,
  lookup,
  only,
  shellCommand,
  type ClientOptions,
} from "../compat/core.js";

export { CompatibilityError };
export class LongPollAbortError extends Error {
  constructor(
    message: string,
    readonly lastResult: unknown,
  ) {
    super(message);
    this.name = "LongPollAbortError";
  }
}
export class PollingTimeoutError extends Error {
  constructor(
    message: string,
    readonly lastResult: unknown,
  ) {
    super(`${message}. Last result: ${JSON.stringify(lastResult, null, 2)}`);
    this.name = "PollingTimeoutError";
  }
}
export class MaxAttemptsExceededError extends Error {
  constructor(
    message: string,
    readonly lastResult: unknown,
  ) {
    super(`${message}. Last result: ${JSON.stringify(lastResult, null, 2)}`);
    this.name = "MaxAttemptsExceededError";
  }
}
export interface LaunchParameters {
  architecture?: "x86_64" | "arm64" | null;
  custom_cpu_cores?: number | null;
  custom_gb_memory?: number | null;
  custom_disk_size?: number | null;
  resource_size_request?:
    "X_SMALL" | "SMALL" | "MEDIUM" | "LARGE" | "X_LARGE" | "XX_LARGE" | "CUSTOM_SIZE" | null;
  keep_alive_time_seconds?: number | null;
  launch_commands?: string[] | null;
}
export interface DevboxCreateParams {
  name?: string | null;
  metadata?: Record<string, string> | null;
  environment_variables?: Record<string, string> | null;
  file_mounts?: Record<string, string> | null;
  blueprint_id?: string | null;
  blueprint_name?: string | null;
  snapshot_id?: string | null;
  launch_parameters?: LaunchParameters | null;
}
export interface DevboxExecuteParams {
  command: string;
  shell_name?: string | null;
  attach_stdin?: boolean | null;
}
export interface DevboxExecutionDetailView {
  devbox_id: string;
  exit_status: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}
export interface DevboxAsyncExecutionDetailView extends Partial<DevboxExecutionDetailView> {
  devbox_id: string;
  execution_id: string;
  status: "queued" | "running" | "completed";
}
export type RequestOptions = { signal?: AbortSignal; timeout?: number; idempotencyKey?: string };
export type LongPollRequestOptions = RequestOptions & {
  longPoll?: { timeoutMs?: number };
  polling?: {
    timeoutMs?: number;
    maxAttempts?: number;
    initialDelayMs?: number;
    pollingIntervalMs?: number;
  };
};
const sizes = {
  X_SMALL: [0.5, 1024, 4096],
  SMALL: [1, 2048, 4096],
  MEDIUM: [2, 4096, 8192],
  LARGE: [2, 8192, 16384],
  X_LARGE: [4, 16384, 16384],
  XX_LARGE: [8, 32768, 16384],
} as const;
const result = (id: string, r: CommandResult): DevboxExecutionDetailView => ({
  devbox_id: id,
  exit_status: r.exitCode,
  stdout: r.stdout,
  stderr: r.stderr,
  stdout_truncated: r.stdoutTruncated ?? false,
  stderr_truncated: r.stderrTruncated ?? false,
});
const SUSPENDED = "compat.runloop.suspended";
function view(sandbox: Sandbox) {
  const i = sandbox.info;
  return {
    id: i.id,
    name: i.name,
    metadata: Object.fromEntries(
      Object.entries(i.labels).filter(([k]) => k !== "compat.provider" && k !== SUSPENDED),
    ),
    status:
      i.state === "paused"
        ? "suspended"
        : i.state === "stopped"
          ? i.persistent && i.labels[SUSPENDED] === "true"
            ? "suspended"
            : "shutdown"
          : i.state === "stopping" && i.labels[SUSPENDED] === "true"
            ? "suspending"
            : i.state === "pausing"
              ? "suspending"
              : i.state === "starting"
                ? i.labels[SUSPENDED] === "true"
                  ? "resuming"
                  : "provisioning"
                : i.state,
    create_time_ms: Date.parse(i.createdAt),
    end_time_ms: i.endedAt ? Date.parse(i.endedAt) : null,
    capabilities: [],
    state_transitions: [],
    launch_parameters: {
      custom_cpu_cores: i.vcpu,
      custom_gb_memory: i.memoryMiB / 1024,
      custom_disk_size: i.diskMiB / 1024,
      keep_alive_time_seconds: i.timeoutSeconds,
      resource_size_request: "CUSTOM_SIZE" as const,
    },
  };
}
export type DevboxView = ReturnType<typeof view>;
export interface DevboxListParams {
  name?: string;
  limit?: number;
  starting_after?: string;
  metadata?: Record<string, string>;
  include_total_count?: boolean;
  status?:
    | "scheduled"
    | "queued"
    | "provisioning"
    | "initializing"
    | "running"
    | "suspending"
    | "suspended"
    | "resuming"
    | "failure"
    | "shutdown";
}
export class Runloop {
  readonly devboxes: Devboxes;
  constructor(options: ClientOptions & { bearerToken?: string; baseURL?: string } = {}) {
    const { bearerToken, baseURL, ...rest } = options;
    this.devboxes = new Devboxes(
      client({ ...rest, apiKey: rest.apiKey ?? bearerToken, baseUrl: rest.baseUrl ?? baseURL }),
    );
  }
}
export default Runloop;
export class Devboxes {
  readonly executions: Executions;
  readonly diskSnapshots: DiskSnapshots;
  private readonly transitions = new Map<string, Promise<unknown>>();
  private transition<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.transitions.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.transitions.set(id, pending);
    void pending
      .finally(() => {
        if (this.transitions.get(id) === pending) this.transitions.delete(id);
      })
      .catch(() => undefined);
    return pending;
  }
  constructor(private readonly runtime: Runtime) {
    this.executions = new Executions(runtime);
    this.diskSnapshots = new DiskSnapshots(runtime);
  }
  async create(input: DevboxCreateParams = {}, options: RequestOptions = {}) {
    only("Runloop", input, [
      "name",
      "metadata",
      "environment_variables",
      "file_mounts",
      "blueprint_id",
      "blueprint_name",
      "snapshot_id",
      "launch_parameters",
    ]);
    const p = input.launch_parameters ?? {};
    only("Runloop launch_parameters", p, [
      "architecture",
      "custom_cpu_cores",
      "custom_gb_memory",
      "custom_disk_size",
      "resource_size_request",
      "keep_alive_time_seconds",
      "launch_commands",
    ]);
    if (p.architecture === "arm64") throw new CompatibilityError("Runloop", "arm64 architecture");
    if ([input.blueprint_id, input.blueprint_name, input.snapshot_id].filter(Boolean).length > 1)
      throw new TypeError("Specify only one blueprint or snapshot.");
    const size =
      p.resource_size_request && p.resource_size_request !== "CUSTOM_SIZE"
        ? sizes[p.resource_size_request]
        : undefined;
    if ((p.custom_cpu_cores ?? size?.[0]) === 0.5)
      throw new CompatibilityError(
        "Runloop",
        "fractional CPU shape; Runtime sandbox CPU counts are whole cores",
      );
    const sandbox = await create(
      this.runtime,
      "runloop",
      {
        name: input.name ?? undefined,
        labels: input.metadata ?? undefined,
        image: input.blueprint_id ?? input.blueprint_name ?? undefined,
        snapshot: input.snapshot_id ?? undefined,
        vcpu: p.custom_cpu_cores ?? size?.[0],
        memoryMiB: p.custom_gb_memory ? p.custom_gb_memory * 1024 : size?.[1],
        diskMiB: p.custom_disk_size ? p.custom_disk_size * 1024 : size?.[2],
        timeoutSeconds: p.keep_alive_time_seconds ?? 3600,
        idlePauseSeconds: 0,
        onLeaseEnd: "stop",
      },
      input.environment_variables ?? undefined,
      async (sandbox) => {
        for (const [path, content] of Object.entries(input.file_mounts ?? {}))
          await sandbox.files.write(path, content);
        for (const command of p.launch_commands ?? [])
          await sandbox.exec(command, {
            ...(await execOptions(sandbox)),
            check: true,
            signal: options.signal,
          });
      },
    );
    return view(sandbox);
  }
  createAndAwaitRunning(input?: DevboxCreateParams, options?: RequestOptions) {
    return this.create(input, options);
  }
  async retrieve(id: string) {
    return view(await lookup(this.runtime, id));
  }
  async awaitRunning(id: string, options: LongPollRequestOptions = {}) {
    return this.waitForStatus(id, "running", options);
  }
  awaitDevboxRunning(id: string, options: LongPollRequestOptions = {}) {
    return this.awaitRunning(id, options);
  }
  async awaitSuspended(id: string, options: LongPollRequestOptions = {}) {
    return this.waitForStatus(id, "suspended", options);
  }
  private async waitForStatus(
    id: string,
    target: "running" | "suspended",
    options: LongPollRequestOptions,
  ) {
    const timeoutMs = options.longPoll?.timeoutMs ?? options.polling?.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
      throw new Error("timeoutMs must be positive");
    if (options.signal?.aborted) throw new LongPollAbortError("Long poll aborted", undefined);
    const deadline = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const signal =
      deadline && options.signal
        ? AbortSignal.any([deadline, options.signal])
        : (deadline ?? options.signal);
    let lastResult: ReturnType<typeof view> | undefined;
    try {
      const s = await this.runtime.sandboxes.get(id, { signal, timeoutMs: options.timeout });
      while (true) {
        signal?.throwIfAborted();
        const result = view(s);
        if (result.status === target) return result;
        const transitional =
          target === "running"
            ? ["starting", "resuming"].includes(s.state)
            : s.state === "stopping" && s.info.labels[SUSPENDED] === "true";
        if (!transitional)
          throw new Error(`Devbox ${id} is in non-${target} state ${result.status}`);
        // A status wait never wakes, restarts or otherwise changes a resource.
        await s.waitFor(target === "running" ? "running" : "stopped", {
          signal,
          timeoutSeconds: 60,
          timeoutMs: options.timeout ?? 65000,
        });
        lastResult = view(s);
      }
    } catch (error) {
      if (options.signal?.aborted) throw new LongPollAbortError("Long poll aborted", lastResult);
      if (deadline?.aborted)
        throw new PollingTimeoutError(`Long poll timed out after ${timeoutMs}ms`, lastResult);
      throw error;
    }
  }
  list(
    query?: DevboxListParams,
    options?: RequestOptions,
  ): PagePromise<DevboxView, DevboxViewsCursorIDPage<DevboxView>>;
  list(options?: RequestOptions): PagePromise<DevboxView, DevboxViewsCursorIDPage<DevboxView>>;
  list(
    query: DevboxListParams | RequestOptions = {},
    options: RequestOptions = {},
  ): PagePromise<DevboxView, DevboxViewsCursorIDPage<DevboxView>> {
    if (requestOptions(query)) return this.list({}, query);
    return new PagePromise(this.listPage(query, options));
  }
  private async listPage(
    query: DevboxListParams,
    options: RequestOptions,
  ): Promise<DevboxViewsCursorIDPage<DevboxView>> {
    only("Runloop list", query, [
      "name",
      "limit",
      "starting_after",
      "metadata",
      "status",
      "include_total_count",
    ]);
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0))
      throw new TypeError("limit must be positive");
    const values: DevboxView[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: SandboxInfo[]; nextCursor: string | null } =
        await this.runtime.transport.json({
          method: "GET",
          path: "/v1/sandboxes",
          query: {
            includeStopped: true,
            label: ["compat.provider:runloop"],
            cursor: cursor ?? undefined,
            limit: 100,
          },
          ...nativeOptions(options),
        });
      for (const info of page.data) {
        if (info.labels["compat.provider"] !== "runloop") continue;
        const value = view(new Sandbox(this.runtime.transport, info));
        if (
          (!query.name || value.name === query.name) &&
          (!query.status || value.status === query.status) &&
          Object.entries(query.metadata ?? {}).every(
            ([key, expected]) => value.metadata[key] === expected,
          )
        )
          values.push(value);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    const offset = query.starting_after
      ? values.findIndex((value) => value.id === query.starting_after) + 1
      : 0;
    if (query.starting_after && offset === 0)
      throw new TypeError("starting_after does not identify a matching devbox");
    const data = values.slice(offset, offset + (query.limit ?? 20));
    return new DevboxViewsCursorIDPage(
      data,
      offset + data.length < values.length,
      query.include_total_count === false ? 0 : values.length,
      (after) => this.listPage({ ...query, starting_after: after }, options),
    );
  }
  suspend(id: string) {
    return this.transition(id, async () => {
      const s = await lookup(this.runtime, id);
      if (s.state === "stopped") {
        if (s.info.persistent && s.info.labels[SUSPENDED] === "true") return view(s);
        throw new Error("A shut down Devbox cannot be suspended");
      }
      // ARCHITECTURE.md section 10: paid disk persistence must be admitted
      // before stop; an uncertain stop keeps retention enabled to preserve bytes.
      await s.update({ persistent: true, labels: { ...s.info.labels, [SUSPENDED]: "true" } });
      await s.stop();
      return view(s);
    });
  }
  resume(id: string) {
    return this.transition(id, async () => {
      const s = await lookup(this.runtime, id);
      if (s.state === "stopped") {
        if (!s.info.persistent || s.info.labels[SUSPENDED] !== "true")
          throw new Error("A shut down Devbox cannot be resumed");
        await s.restart();
      } else if (s.state === "paused" || s.state === "pausing") {
        // Migrate older adapter pauses through the same disk-only boundary.
        await s.update({ persistent: true, labels: { ...s.info.labels, [SUSPENDED]: "true" } });
        await s.stop();
        await s.restart();
      } else await s.waitFor("running");
      if (s.info.labels[SUSPENDED] !== undefined) {
        const labels = { ...s.info.labels };
        delete labels[SUSPENDED];
        await s.update({ labels });
      }
      return view(s);
    });
  }
  shutdown(id: string) {
    return this.transition(id, async () => {
      const s = await lookup(this.runtime, id);
      await destroy(s);
      return view(s);
    });
  }
  executeSync(id: string, body: DevboxExecuteParams, options?: RequestOptions) {
    return this.executions.executeSync(id, body, options);
  }
  executeAsync(id: string, body: DevboxExecuteParams, options?: RequestOptions) {
    return this.executions.executeAsync(id, body, options);
  }
  async executeAndAwaitCompletion(id: string, body: DevboxExecuteParams, options?: RequestOptions) {
    const execution = await this.executeAsync(id, body, options);
    return this.executions.awaitCompleted(id, execution.execution_id, options);
  }
  async readFileContents(id: string, body: { file_path: string }) {
    only("Runloop read", body, ["file_path"]);
    return (await lookup(this.runtime, id)).files.readText(body.file_path);
  }
  async writeFileContents(id: string, body: { file_path: string; contents: string }) {
    only("Runloop write", body, ["file_path", "contents"]);
    await (await lookup(this.runtime, id)).files.write(body.file_path, body.contents);
    return result(id, { stdout: "", stderr: "", exitCode: 0, timedOut: false });
  }
  snapshotDisk(
    id: string,
    body?: DevboxSnapshotDiskParams,
    options?: RequestOptions,
  ): Promise<DevboxSnapshotView>;
  snapshotDisk(id: string, options?: RequestOptions): Promise<DevboxSnapshotView>;
  async snapshotDisk(
    id: string,
    body: DevboxSnapshotDiskParams | RequestOptions = {},
    options: RequestOptions = {},
  ) {
    if (requestOptions(body)) return this.snapshotDisk(id, {}, body);
    const input = snapshotOptions(body);
    options.signal?.throwIfAborted();
    return this.transition(id, async () => {
      const sandbox = await this.runtime.sandboxes.get(id, nativeOptions(options));
      return snapshotView(await sandbox.snapshot({ ...input, ...nativeOptions(options) }));
    });
  }

  async snapshotDiskAsync(
    _id: string,
    _body?: DevboxSnapshotDiskParams | RequestOptions,
    _options?: RequestOptions,
  ): Promise<never> {
    throw new CompatibilityError(
      "Runloop",
      "asynchronous snapshot capture; use snapshotDisk until server-side capture/resume coordination is available",
    );
  }
  deleteDiskSnapshot(id: string, options?: RequestOptions) {
    return this.diskSnapshots.delete(id, options);
  }
  listDiskSnapshots(
    query?: DiskSnapshotListParams,
    options?: RequestOptions,
  ): ReturnType<DiskSnapshots["list"]>;
  listDiskSnapshots(options?: RequestOptions): ReturnType<DiskSnapshots["list"]>;
  listDiskSnapshots(query: DiskSnapshotListParams | RequestOptions = {}, options?: RequestOptions) {
    return requestOptions(query)
      ? this.diskSnapshots.list(query)
      : this.diskSnapshots.list(query, options);
  }
}
export class Executions {
  constructor(private readonly runtime: Runtime) {}
  async executeSync(id: string, body: DevboxExecuteParams, options: RequestOptions = {}) {
    only("Runloop execute", body, ["command", "shell_name", "attach_stdin"]);
    if (body.attach_stdin) throw new TypeError("attach_stdin requires executeAsync");
    const s = await lookup(this.runtime, id);
    return result(
      id,
      await s.exec(
        await shellCommand(s, body.command, body.shell_name),
        await execOptions(s, {
          signal: options.signal,
          timeoutMs: options.timeout,
          idempotencyKey: options.idempotencyKey,
          onStdout: () => {},
        }),
      ),
    );
  }
  async executeAsync(
    id: string,
    body: DevboxExecuteParams,
    options: RequestOptions = {},
  ): Promise<DevboxAsyncExecutionDetailView> {
    only("Runloop execute", body, ["command", "shell_name", "attach_stdin"]);
    if (body.shell_name && body.attach_stdin)
      throw new CompatibilityError("Runloop", "interactive stdin in a named shell");
    const s = await lookup(this.runtime, id);
    const p = await s.spawn(await shellCommand(s, body.command, body.shell_name), {
      ...(await execOptions(s, { signal: options.signal, idempotencyKey: options.idempotencyKey })),
      stdin: body.attach_stdin ? "pipe" : undefined,
    });
    return { devbox_id: id, execution_id: p.id, status: "running" };
  }
  async retrieve(id: string, execution: string): Promise<DevboxAsyncExecutionDetailView> {
    const p = await (await lookup(this.runtime, id)).processes.get(execution);
    return p.info.state === "running"
      ? { devbox_id: id, execution_id: execution, status: "running" }
      : { ...result(id, await p.wait()), execution_id: execution, status: "completed" };
  }
  async awaitCompleted(
    id: string,
    execution: string,
    options: RequestOptions = {},
  ): Promise<DevboxAsyncExecutionDetailView> {
    const p = await (await lookup(this.runtime, id)).processes.get(execution);
    return {
      ...result(id, await p.wait({ signal: options.signal })),
      execution_id: execution,
      status: "completed",
    };
  }
  async kill(id: string, execution: string, body: { kill_process_group?: boolean | null } = {}) {
    only("Runloop kill", body, ["kill_process_group"]);
    if (body.kill_process_group) throw new CompatibilityError("Runloop", "kill_process_group");
    await (await (await lookup(this.runtime, id)).processes.get(execution)).kill("SIGKILL");
    return this.retrieve(id, execution);
  }
  async sendStdIn(
    id: string,
    execution: string,
    body: { text?: string | null; signal?: "EOF" | "INTERRUPT" | null } = {},
  ) {
    const p = await (await lookup(this.runtime, id)).processes.get(execution);
    if (body.text || body.signal === "EOF")
      await p.write(body.text ?? "", { eof: body.signal === "EOF" });
    if (body.signal === "INTERRUPT") await p.kill("SIGINT");
    return { devbox_id: id, execution_id: execution, success: true };
  }
  async *streamStdoutUpdates(
    id: string,
    execution: string,
    query: { offset?: string } = {},
    options: RequestOptions = {},
  ) {
    yield* this.stream(id, execution, "stdout", query, options);
  }
  async *streamStderrUpdates(
    id: string,
    execution: string,
    query: { offset?: string } = {},
    options: RequestOptions = {},
  ) {
    yield* this.stream(id, execution, "stderr", query, options);
  }
  private async *stream(
    id: string,
    execution: string,
    channel: "stdout" | "stderr",
    query: { offset?: string },
    options: RequestOptions,
  ) {
    const p = await (await lookup(this.runtime, id)).processes.get(execution);
    let offset = 0;
    const from = Number(query.offset ?? 0);
    for await (const event of p.output({ signal: options.signal }))
      if (event.type === channel) {
        const bytes = new TextEncoder().encode(event.data);
        if (offset + bytes.length > from)
          yield {
            output: new TextDecoder().decode(bytes.subarray(Math.max(0, from - offset))),
            offset: Math.max(offset, from),
          };
        offset += bytes.length;
      } else if (event.type === "truncated")
        throw new Error("Runloop execution output was truncated by the host.");
  }
}
