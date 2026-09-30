import type { Runtime } from "../client.js";
import type { Snapshot, SnapshotOptions } from "../snapshots.js";
import { RuntimeError } from "../errors.js";
import { CompatibilityError, only } from "../compat/core.js";
import {
  LongPollAbortError,
  PollingTimeoutError,
  MaxAttemptsExceededError,
  type RequestOptions,
  type LongPollRequestOptions,
} from "./index.js";
import { DevboxSnapshotViewsDiskSnapshotsCursorIDPage, PagePromise } from "./pagination.js";

export interface DevboxSnapshotDiskParams {
  name?: string | null;
  metadata?: Record<string, string> | null;
  commit_message?: string | null;
}
export interface DevboxSnapshotView {
  id: string;
  create_time_ms: number;
  metadata: Record<string, string>;
  source_devbox_id: string;
  commit_message?: string | null;
  name?: string | null;
  size_bytes?: number | null;
  source_blueprint_id?: string | null;
}
export interface DevboxSnapshotAsyncStatusView {
  status: "in_progress" | "error" | "complete" | "deleted";
  error_message?: string | null;
  snapshot?: DevboxSnapshotView | null;
}
export interface DiskSnapshotListParams {
  starting_after?: string;
  limit?: number;
  devbox_id?: string;
  include_total_count?: boolean;
  source_blueprint_id?: string;
  [key: `metadata[${string}]`]: string | undefined;
}
const PAYLOAD = "compat.runloop.snapshot.";
export function requestOptions(value: object): value is RequestOptions {
  const keys = Object.keys(value);
  return (
    keys.length > 0 && keys.every((key) => ["signal", "timeout", "idempotencyKey"].includes(key))
  );
}
export function nativeOptions(options: RequestOptions) {
  return {
    signal: options.signal,
    timeoutMs: options.timeout,
    idempotencyKey: options.idempotencyKey,
  };
}
export function snapshotOptions(body: DevboxSnapshotDiskParams): SnapshotOptions {
  only("Runloop snapshot", body, ["name", "metadata", "commit_message"]);
  if (
    body.commit_message != null &&
    (typeof body.commit_message !== "string" || body.commit_message.length > 1000)
  )
    throw new TypeError("commit_message must be a string of at most 1000 characters");
  if (body.name != null && typeof body.name !== "string")
    throw new TypeError("name must be a string");
  if (
    body.metadata != null &&
    (typeof body.metadata !== "object" ||
      Array.isArray(body.metadata) ||
      Object.values(body.metadata).some((value) => typeof value !== "string"))
  )
    throw new TypeError("metadata must contain string values");
  // Keep the entire public payload durable, including arbitrary names and the
  // official 1000-character commit message. Native labels have 256-char values.
  const payload = JSON.stringify({
    name: body.name ?? null,
    metadata: body.metadata ?? {},
    commit_message: body.commit_message ?? null,
  });
  const chunks: string[] = [];
  let chunk = "";
  for (const character of payload) {
    if (chunk.length + character.length > 256) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.length > 31)
    throw new CompatibilityError(
      "Runloop",
      "snapshot metadata exceeding Runtime's 31 label chunks",
    );
  const labels = {
    "compat.provider": "runloop",
    ...Object.fromEntries(
      chunks.map((chunk, index) => [`${PAYLOAD}${index.toString().padStart(2, "0")}`, chunk]),
    ),
  };
  // Match the spine's JSONB text bound, including its spaces between entries.
  // Count UTF-8 bytes and never split surrogate pairs into invalid JSON strings.
  const stored = `{${Object.entries(labels)
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(", ")}}`;
  if (new TextEncoder().encode(stored).length > 4096)
    throw new CompatibilityError(
      "Runloop",
      "snapshot metadata exceeding Runtime's 4096-byte label bound",
    );
  return {
    mode: "disk",
    labels,
  };
}
function labelsOf(snapshot: Snapshot): Record<string, string> {
  const value = snapshot.labels;
  return value && typeof value === "object"
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
}
export function snapshotView(snapshot: Snapshot): DevboxSnapshotView {
  if (snapshot.mode !== "disk")
    throw new CompatibilityError("Runloop", "using a memory snapshot as a disk snapshot");
  const labels = labelsOf(snapshot);
  const packed = Object.keys(labels)
    .filter((key) => key.startsWith(PAYLOAD))
    .sort()
    .map((key) => labels[key])
    .join("");
  const body: DevboxSnapshotDiskParams = packed
    ? (JSON.parse(packed) as DevboxSnapshotDiskParams)
    : {
        name: snapshot.name,
        metadata: Object.fromEntries(
          Object.entries(labels).filter(([key]) => !key.startsWith("compat.")),
        ),
      };
  return {
    id: snapshot.id,
    create_time_ms: Date.parse(snapshot.createdAt),
    metadata: body.metadata ?? {},
    source_devbox_id: snapshot.sourceSandboxId,
    commit_message: body.commit_message ?? null,
    name: body.name ?? null,
    size_bytes: snapshot.meteredBytes,
    source_blueprint_id: typeof snapshot.sourceImageId === "string" ? snapshot.sourceImageId : null,
  };
}
export class DiskSnapshots {
  constructor(private readonly runtime: Runtime) {}
  update(
    id: string,
    body?: DevboxSnapshotDiskParams,
    options?: RequestOptions,
  ): Promise<DevboxSnapshotView>;
  update(id: string, options?: RequestOptions): Promise<DevboxSnapshotView>;
  async update(
    id: string,
    body: DevboxSnapshotDiskParams | RequestOptions = {},
    options: RequestOptions = {},
  ): Promise<DevboxSnapshotView> {
    if (requestOptions(body)) return this.update(id, {}, body);
    snapshotOptions(body); // Reject invalid input before any request.
    for (let attempt = 0; ; attempt++) {
      const current = await this.runtime.snapshots.get(id, nativeOptions(options));
      const previous = snapshotView(current);
      const merged = {
        name: body.name === undefined ? previous.name : body.name,
        metadata: body.metadata === undefined ? previous.metadata : body.metadata,
        commit_message:
          body.commit_message === undefined ? previous.commit_message : body.commit_message,
      };
      const labels = snapshotOptions(merged).labels!;
      try {
        return snapshotView(
          await this.runtime.snapshots.update(
            id,
            { labels, ifLabels: labelsOf(current) },
            nativeOptions(options),
          ),
        );
      } catch (error) {
        if (
          !(error instanceof RuntimeError) ||
          error.code !== "snapshot_metadata_changed" ||
          attempt >= 2
        )
          throw error;
      }
    }
  }
  async awaitCompleted(
    id: string,
    options: LongPollRequestOptions = {},
  ): Promise<DevboxSnapshotAsyncStatusView> {
    const timeoutMs = options.longPoll?.timeoutMs ?? options.polling?.timeoutMs;
    const { maxAttempts, initialDelayMs = 0, pollingIntervalMs = 1000 } = options.polling ?? {};
    if (options.signal?.aborted) throw new LongPollAbortError("Polling aborted", undefined);
    for (const [name, value] of Object.entries({ initialDelayMs, pollingIntervalMs, maxAttempts }))
      if (value !== undefined && (!Number.isFinite(value) || value < 0))
        throw new Error(`${name} must be non-negative`);
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
      throw new Error("timeoutMs must be positive");
    const controller = new AbortController();
    const timer =
      timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    let lastResult: DevboxSnapshotAsyncStatusView | undefined;
    const delay = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const onAbort = () => {
          clearTimeout(wait);
          reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
        };
        const wait = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    try {
      let attempts = 0;
      while (true) {
        lastResult = await this.queryStatus(id, { ...options, signal });
        if (lastResult.status === "error")
          throw new Error(`Snapshot ${id} failed: ${lastResult.error_message || "Unknown error"}`);
        if (lastResult.status === "complete" || (maxAttempts === 0 && attempts === 0))
          return lastResult;
        if (maxAttempts !== undefined && attempts === maxAttempts)
          throw new MaxAttemptsExceededError(
            `Polling exceeded maximum attempts (${maxAttempts})`,
            lastResult,
          );
        await delay(attempts++ === 0 ? initialDelayMs : pollingIntervalMs);
      }
    } catch (error) {
      if (options.signal?.aborted) throw new LongPollAbortError("Polling aborted", lastResult);
      if (controller.signal.aborted)
        throw new PollingTimeoutError(`Polling timed out after ${timeoutMs}ms`, lastResult);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async queryStatus(
    id: string,
    options: RequestOptions = {},
  ): Promise<DevboxSnapshotAsyncStatusView> {
    const snapshot = await this.runtime.snapshots.get(id, nativeOptions(options));
    const view = snapshotView(snapshot);
    return {
      status:
        snapshot.state === "ready"
          ? "complete"
          : snapshot.state === "failed"
            ? "error"
            : snapshot.state === "deleted" || snapshot.state === "deleting"
              ? "deleted"
              : "in_progress",
      error_message: snapshot.error,
      snapshot: view,
    };
  }
  async delete(id: string, options: RequestOptions = {}): Promise<unknown> {
    snapshotView(await this.runtime.snapshots.get(id, nativeOptions(options)));
    await this.runtime.snapshots.delete(id, nativeOptions(options));
    return {};
  }
  list(
    query?: DiskSnapshotListParams,
    options?: RequestOptions,
  ): PagePromise<
    DevboxSnapshotView,
    DevboxSnapshotViewsDiskSnapshotsCursorIDPage<DevboxSnapshotView>
  >;
  list(
    options?: RequestOptions,
  ): PagePromise<
    DevboxSnapshotView,
    DevboxSnapshotViewsDiskSnapshotsCursorIDPage<DevboxSnapshotView>
  >;
  list(
    query: DiskSnapshotListParams | RequestOptions = {},
    options: RequestOptions = {},
  ): PagePromise<
    DevboxSnapshotView,
    DevboxSnapshotViewsDiskSnapshotsCursorIDPage<DevboxSnapshotView>
  > {
    if (requestOptions(query)) return this.list({}, query);
    return new PagePromise(this.page(query, options));
  }
  private async page(
    query: DiskSnapshotListParams,
    options: RequestOptions,
  ): Promise<DevboxSnapshotViewsDiskSnapshotsCursorIDPage<DevboxSnapshotView>> {
    options.signal?.throwIfAborted();
    const filters = Object.entries(query).filter(([key]) =>
      /^metadata\[[^\]]+\](\[in\])?$/.test(key),
    );
    only("Runloop snapshot list", query, [
      "starting_after",
      "limit",
      "devbox_id",
      "include_total_count",
      "source_blueprint_id",
      ...filters.map(([key]) => key),
    ]);
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0))
      throw new TypeError("limit must be positive");
    const values: DevboxSnapshotView[] = [];
    const page = await this.runtime.snapshots.list(
      { sandboxId: query.devbox_id },
      nativeOptions(options),
    );
    for await (const snapshot of page) {
      options.signal?.throwIfAborted();
      if (snapshot.mode !== "disk" || labelsOf(snapshot)["compat.provider"] !== "runloop") continue;
      const value = snapshotView(snapshot);
      if (query.source_blueprint_id && value.source_blueprint_id !== query.source_blueprint_id)
        continue;
      if (
        !filters.every(([key, expected]) => {
          const name = key.slice(9, key.indexOf("]"));
          return key.endsWith("[in]")
            ? typeof expected === "string" &&
                expected.split(",").includes(value.metadata[name] ?? "")
            : value.metadata[name] === expected;
        })
      )
        continue;
      values.push(value);
    }
    const total = values.length;
    const offset = query.starting_after
      ? values.findIndex((value) => value.id === query.starting_after) + 1
      : 0;
    if (query.starting_after && offset === 0)
      throw new TypeError("starting_after does not identify a matching snapshot");
    const data = values.slice(offset, offset + (query.limit ?? 20));
    return new DevboxSnapshotViewsDiskSnapshotsCursorIDPage(
      data,
      offset + data.length < total,
      query.include_total_count === false ? 0 : total,
      (after) => this.page({ ...query, starting_after: after }, options),
    );
  }
}
