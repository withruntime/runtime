import type { RequestOptions, Transport } from "../transport.js";

export type FileEventType = "create" | "write" | "remove" | "rename" | "chmod";
export type FileEvent = {
  type: FileEventType;
  /** Absolute path in the sandbox. */
  path: string;
  isDir: boolean;
  /** rename: where it was. */
  oldPath?: string;
  /** write: how many writes were folded into this one event. */
  count?: number;
};
export type WatchNotice =
  | { k: "overflow"; dropped: number | null; reason: "kernel" | "rate" }
  | { k: "limit"; watches: number }
  | { k: "lost"; bytes: number };
export type WatchOptions = Omit<RequestOptions, "timeoutMs"> & {
  recursive?: boolean;
  /** Only these event types; all five by default. */
  events?: FileEventType[];
  /** Globs relative to the path: only matching paths are reported. */
  include?: string[];
  /** Globs relative to the path. An excluded directory is not watched at all. */
  exclude?: string[];
  /** Events are gathered this long and delivered together. Default 100. */
  batchMs?: number;
  /** The watch ends by itself after running this long. Default 1 hour. */
  timeoutMs?: number;
  maxWatches?: number;
  /** A batch at a time, rather than one call per event. */
  onBatch?: (events: FileEvent[]) => void | Promise<void>;
  /** Events were lost (a flood past the rate cap, the kernel's queue, or a
   * reader that fell more than 1 MiB behind): rescan what you care about. */
  onNotice?: (notice: WatchNotice) => void;
  /** The watch stopped: "stopped", "timeout", "root-removed", or "paused"
   * (the sandbox paused; call `resume()` once it runs again: nothing is lost). */
  onExit?: (reason: string) => void;
};
export type WatchInfo = {
  id: string;
  path: string;
  processId: string;
  state: string;
  startedAt: number;
};

type StreamEvent =
  | { k: "events"; events: FileEvent[]; cursor: number }
  | ({ cursor: number } & WatchNotice)
  | { k: "end"; reason: string; cursor: number }
  | { k: "paused"; cursor: number }
  | { k: "continue"; cursor: number }
  | { k: "failure"; code: string; message: string; cursor: number };

/** A running watch. Events arrive through the callbacks until `stop()`. */
export class WatchHandle {
  cursor: number;
  #stopped = false;
  #following: Promise<void> | undefined;
  #abort = new AbortController();
  constructor(
    private readonly t: Transport,
    private readonly base: string,
    readonly id: string,
    readonly path: string,
    cursor: number,
    private readonly options: WatchOptions,
    private readonly onEvent?: (event: FileEvent) => void | Promise<void>,
  ) {
    this.cursor = cursor;
  }
  /** Settles when the watch stops delivering (stopped, ended or paused). */
  get done(): Promise<void> {
    return this.#following ?? Promise.resolve();
  }
  /** Start delivering again from where it left off, after a pause. */
  resume(): void {
    if (this.#stopped) throw new Error("This watch was stopped");
    this.#abort = new AbortController();
    this.begin();
  }
  /** Stop the watch in the sandbox, and stop delivering. */
  async stop(options?: RequestOptions): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#abort.abort();
    await this.t
      .json({ method: "DELETE", path: `${this.base}/${encodeURIComponent(this.id)}`, ...options })
      .catch(() => undefined);
    await this.#following?.catch(() => undefined);
    this.options.onExit?.("stopped");
  }
  async #follow(): Promise<void> {
    for (;;) {
      let next: "continue" | "exit" = "exit";
      try {
        for await (const event of this.t.events<StreamEvent>({
          method: "GET",
          path: `${this.base}/${encodeURIComponent(this.id)}/events`,
          query: { cursor: this.cursor, follow: true },
          signal: this.#abort.signal,
          timeoutMs: 150_000,
        })) {
          this.cursor = event.cursor ?? this.cursor;
          if (event.k === "events") {
            if (this.options.onBatch) await this.options.onBatch(event.events);
            if (this.onEvent) for (const item of event.events) await this.onEvent(item);
          } else if (event.k === "continue") next = "continue";
          else if (event.k === "end" || event.k === "paused") {
            if (!this.#stopped)
              this.options.onExit?.(event.k === "paused" ? "paused" : event.reason);
            return;
          } else if (event.k === "failure") throw new Error(`${event.code}: ${event.message}`);
          else this.options.onNotice?.(event);
        }
      } catch (error) {
        if (this.#stopped || this.#abort.signal.aborted) return;
        throw error;
      }
      if (next !== "continue" || this.#stopped) return;
    }
  }
  /** @internal */
  begin() {
    this.#following = this.#follow();
    // An error surfaces through `done`; nothing is left unhandled meanwhile.
    this.#following.catch(() => undefined);
    return this;
  }
}

/** `sbx.files.watch(path, onEvent, options)`: E2B's `watchDir`, with
 * filters, batches, and a watch that survives a pause without losing events. */
export function watchDirectory(
  t: Transport,
  sandboxId: string,
  path: string,
  onEvent?: (event: FileEvent) => void | Promise<void>,
  options: WatchOptions = {},
): Promise<WatchHandle> {
  const base = `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files/watches`;
  const {
    recursive,
    events,
    include,
    exclude,
    batchMs,
    timeoutMs,
    maxWatches,
    idempotencyKey,
    signal,
  } = options;
  return t
    .json<{ id: string; path: string; cursor: number }>({
      method: "POST",
      path: base,
      body: {
        path,
        ...(recursive !== undefined ? { recursive } : {}),
        ...(events ? { events } : {}),
        ...(include ? { include } : {}),
        ...(exclude ? { exclude } : {}),
        ...(batchMs !== undefined ? { batchMs } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(maxWatches !== undefined ? { maxWatches } : {}),
      },
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(signal ? { signal } : {}),
    })
    .then((watch) =>
      new WatchHandle(t, base, watch.id, watch.path, watch.cursor ?? 0, options, onEvent).begin(),
    );
}

export function sandboxWatches(t: Transport, sandboxId: string) {
  const base = `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files/watches`;
  return {
    list: async (options?: RequestOptions) =>
      (await t.json<{ data: WatchInfo[] }>({ method: "GET", path: base, ...options })).data,
    /** Events after a cursor, without a stream: for polling. */
    read: (id: string, cursor = 0, input: { waitMs?: number } = {}, options?: RequestOptions) =>
      t.json<{
        events: FileEvent[];
        notices: Record<string, unknown>[];
        nextCursor: number;
        lostBytes: number;
        ended: boolean;
      }>({
        method: "GET",
        path: `${base}/${encodeURIComponent(id)}/events`,
        query: { cursor, ...(input.waitMs !== undefined ? { waitMs: input.waitMs } : {}) },
        ...options,
      }),
    stop: (id: string, options?: RequestOptions) =>
      t.json<{ stopped: boolean }>({
        method: "DELETE",
        path: `${base}/${encodeURIComponent(id)}`,
        ...options,
      }),
  };
}
