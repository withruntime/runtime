import { WEBHOOK_WATCH_TIMEOUT_MS } from "../api-defaults.js";
import type { RequestOptions, Transport } from "../transport.js";
import { RuntimeError } from "../errors.js";

export type FileEventType = "create" | "write" | "remove" | "rename" | "chmod" | "access";
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
  /** Only these event types; the five mutation types by default; access is opt-in. */
  events?: FileEventType[];
  /** Globs relative to the path: only matching paths are reported. */
  include?: string[];
  /** Globs relative to the path. An excluded directory is not watched at all. */
  exclude?: string[];
  /** Events are gathered this long and delivered together. Default 100. */
  batchMs?: number;
  /** The watch ends by itself after running this long. Default 1 hour; 0 runs until stopped or the sandbox ends. */
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
  /** Its changes go to the account's webhooks as `sandbox.files.changed`. */
  webhook?: boolean;
};
/** A watch whose changes Runtime sends to the account's webhooks. */
export type WebhookWatchOptions = Omit<
  WatchOptions,
  "onBatch" | "onNotice" | "onExit" | "timeoutMs"
> & {
  /** The watch ends by itself after running this long; 0 (the default here)
   * runs until stopped or the sandbox ends. */
  timeoutMs?: number;
  /** Its own id, 1 to 40 lowercase letters, digits or dashes. */
  id?: string;
};

type StreamEvent =
  | { k: "events"; events: FileEvent[]; cursor: number }
  | ({ cursor: number } & WatchNotice)
  | { k: "end"; reason: string; cursor: number }
  | { k: "paused"; cursor: number }
  | { k: "continue"; cursor: number }
  | {
      k: "failure";
      code: string;
      message: string;
      cursor: number;
      status?: number;
      hint?: string;
      requestId?: string;
    };

/** A running watch. Events arrive through the callbacks until `stop()`. */
export class WatchHandle {
  cursor: number;
  #stopped = false;
  /** stop() was called: deliver what the watch reports until its end. */
  #stopping = false;
  /** Callbacks under way. */
  #delivering = 0;
  #exitNotified = false;
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
    if (this.#stopped || this.#stopping) throw new Error("This watch was stopped");
    this.#abort = new AbortController();
    this.begin();
  }
  /** Stop the watch in the sandbox. What changed before the stop is still
   * delivered: the watch reports it and ends, and this returns once that has
   * arrived (at most 5 s). Called from inside a callback, it stops at once. */
  async stop(options?: RequestOptions): Promise<void> {
    if (this.#stopped || this.#stopping) return;
    this.#stopping = true;
    await this.t
      .json({ method: "DELETE", path: `${this.base}/${encodeURIComponent(this.id)}`, ...options })
      .catch(() => undefined);
    // Inside a callback, #following is awaiting the caller: waiting for it
    // here would make that callback await itself.
    if (this.#following && this.#delivering === 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.#following.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000);
        }),
      ]);
      clearTimeout(timer);
    }
    this.#stopped = true;
    this.#abort.abort();
    this.#notifyExit("stopped");
  }
  #notifyExit(reason: string) {
    if (this.#exitNotified) return;
    this.#exitNotified = true;
    this.options.onExit?.(reason);
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
            this.#delivering++;
            try {
              if (this.options.onBatch) await this.options.onBatch(event.events);
              if (this.#stopped) return;
              if (this.onEvent)
                for (const item of event.events) {
                  await this.onEvent(item);
                  if (this.#stopped) return;
                }
            } finally {
              this.#delivering--;
            }
          } else if (event.k === "continue") next = "continue";
          else if (event.k === "end" || event.k === "paused") {
            if (!this.#stopped) this.#notifyExit(event.k === "paused" ? "paused" : event.reason);
            return;
          } else if (event.k === "failure")
            throw new RuntimeError({
              code: event.code,
              status: event.status ?? 0,
              message: event.message,
              ...(event.hint ? { hint: event.hint } : {}),
              ...(event.requestId ? { requestId: event.requestId } : {}),
            });
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
    this.#exitNotified = false;
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
    /** Starts a watch whose changes Runtime sends to the account's webhooks
     * as `sandbox.files.changed` events, with nothing reading it here:
     *
     *   await sbx.files.watches.webhook("/workspace/app", { recursive: true });
     *
     * Runs until stopped (timeoutMs 0) unless given a timeout. */
    webhook: (path: string, input: WebhookWatchOptions = {}) => {
      const { idempotencyKey, signal, timeoutMs, ...rest } = input;
      return t.json<WatchInfo & { cursor: number }>({
        method: "POST",
        path: base,
        body: { path, ...rest, timeoutMs: timeoutMs ?? WEBHOOK_WATCH_TIMEOUT_MS, webhook: true },
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(signal ? { signal } : {}),
      });
    },
    stop: (id: string, options?: RequestOptions) =>
      t.json<{ stopped: boolean }>({
        method: "DELETE",
        path: `${base}/${encodeURIComponent(id)}`,
        ...options,
      }),
  };
}
