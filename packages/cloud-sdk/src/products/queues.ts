import { RuntimeError } from "../errors.js";
import { Page } from "../page.js";
import type { RequestOptions, Transport } from "../transport.js";
import { pause } from "../wait.js";

/** Private until launch.
 * This is the proposed management contract, not an installed API route.
 * SQS clients use the returned sqs URL with their existing client. */
export type RecordState = "creating" | "ready" | "updating" | "deleting" | "deleted" | "failed";
export type RecordResource = {
  id: string;
  name: string;
  labels: Record<string, string>;
  state: RecordState;
  createdAt: string;
  error?: { code: string; message: string; hint: string } | null;
};
export type QueueSettings = {
  visibilityTimeoutSeconds: number;
  retentionSeconds: number;
  maxMessageBytes: number;
  delaySeconds: number;
  fifo: boolean;
  deadLetter: { queue: string; maxReceives: number } | null;
};
export type Queue = RecordResource & {
  settings: QueueSettings;
  counts: { visible: number; inFlight: number; delayed: number };
  sqs: string;
};
export type CreateQueue = {
  name: string;
  labels?: Record<string, string>;
  settings?: Partial<QueueSettings>;
};
export type UpdateQueue = Partial<CreateQueue>;
export type RecordListQuery = {
  name?: string;
  label?: readonly string[];
  state?: readonly RecordState[];
  limit?: number;
  cursor?: string;
};
export type RecordWaitOptions = RequestOptions & { pollMs?: number };
export type QueueAttribute = { dataType: string; stringValue?: string; binaryValue?: string };
export type SendMessage = {
  body: string;
  attributes?: Record<string, QueueAttribute>;
  delaySeconds?: number;
  groupId?: string;
  dedupId?: string;
};
export type ReceiveMessages = { max?: number; waitSeconds?: number; visibilitySeconds?: number };
export type QueueMessage = SendMessage & { id: string; receiptHandle: string; receives: number };
export type MessageSent = { id: string; md5: string; sequenceNumber?: string };
export type ReceiptResult = {
  successful: string[];
  failed: { receiptHandle: string; code: string; message: string; hint: string }[];
};

/** A consume call handles messages sequentially. max counts handler attempts,
 * including failures. Omit max to run until cancelled. timeoutMs bounds each
 * network call, including settlement after cancellation, not the handler.
 * Choose visibilitySeconds longer than the handler's work; delivery is at least once. */
export type ConsumeOptions = ReceiveMessages & { signal?: AbortSignal; timeoutMs?: number };
export type ConsumeResult = {
  processed: number;
  acknowledged: number;
  retried: number;
  aborted: boolean;
};
export type QueueHandler = (message: QueueMessage, signal: AbortSignal) => unknown;

/** Stop waiting for user code on abort. Its rejection stays observed even if
 * it finishes later. Handlers should use the signal to stop their own work. */
function handleMessage(
  handler: QueueHandler,
  message: QueueMessage,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    const done = (success: boolean) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      resolve(success);
    };
    const abort = () => done(false);
    if (signal.aborted) {
      done(false);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    // Observe synchronous throws and late rejections by the same path.
    Promise.resolve()
      .then(() =>
        signal.aborted ? false : Promise.resolve(handler(message, signal)).then(() => true),
      )
      .then(done, () => done(false));
  });
}

/** Shared only by the private record products. The server owns field defaults
 * and protocol refusals; the SDK preserves their codes and recovery hints. */
export function recordResources<R extends RecordResource, C, U>(
  t: Transport,
  plural: "queues" | "streams",
) {
  const base = `/v1/${plural}`;
  const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
  const get = (id: string, options?: RequestOptions) =>
    t.json<R>({ ...options, method: "GET", path: path(id) });
  const list = async (query: RecordListQuery = {}, options?: RequestOptions): Promise<Page<R>> => {
    const page = await t.json<{ data: R[]; nextCursor: string | null }>({
      ...options,
      method: "GET",
      path: base,
      query,
    });
    return new Page(page.data, page.nextCursor, (cursor) => list({ ...query, cursor }, options));
  };
  return {
    create: (input: C, options?: RequestOptions) =>
      t.json<R>({ ...options, method: "POST", path: base, body: input }),
    get,
    list,
    update: (id: string, input: U, options?: RequestOptions) =>
      t.json<R>({ ...options, method: "POST", path: `${path(id)}:update`, body: input }),
    delete: (id: string, options?: RequestOptions) =>
      t.json<R>({ ...options, method: "DELETE", path: path(id) }),
    /** Poll one resource with a deadline across every read, including retries. */
    async wait(
      id: string,
      target: "ready" | "deleted" = "ready",
      options: RecordWaitOptions = {},
    ): Promise<R> {
      const { pollMs = 250, timeoutMs = 300_000, signal } = options;
      if (
        !Number.isSafeInteger(pollMs) ||
        pollMs < 0 ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 0
      )
        throw new RuntimeError({
          code: "invalid_request",
          status: 0,
          message: "pollMs and timeoutMs must be nonnegative safe integers.",
          hint: "Use milliseconds; zero timeout disables the deadline.",
        });
      const deadline = new AbortController();
      const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      const timer = timeoutMs ? setTimeout(() => deadline.abort(), timeoutMs) : undefined;
      try {
        for (;;) {
          combined.throwIfAborted();
          const current = await get(id, {
            signal: combined,
            timeoutMs: 0,
          });
          combined.throwIfAborted();
          if (current.state === "failed" || (current.state === "deleted" && target !== "deleted"))
            throw new RuntimeError({
              code: current.error?.code ?? "unexpected_state",
              status: 0,
              message: current.error?.message ?? `Resource reached ${current.state}.`,
              hint: current.error?.hint ?? "Read the resource before retrying the change.",
              details: { id, target, state: current.state },
            });
          if (current.state === target) return current;
          await pause(pollMs, combined);
        }
      } catch (cause) {
        if (!combined.aborted) throw cause;
        throw new RuntimeError({
          code: "timeout",
          status: 0,
          message: "Waiting ended before the target state was observed.",
          hint: "Read the resource to resume; retry a write with its original idempotency key.",
          cause,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Private until launch. No public Runtime property is installed here. */
export function queues(t: Transport) {
  const action = <T>(id: string, verb: string, body: unknown, options?: RequestOptions) =>
    t.json<T>({
      ...options,
      method: "POST",
      path: `/v1/queues/${encodeURIComponent(id)}:${verb}`,
      body,
    });
  return {
    ...recordResources<Queue, CreateQueue, UpdateQueue>(t, "queues"),
    send: (id: string, input: SendMessage, options?: RequestOptions) =>
      action<MessageSent>(id, "send", input, options),
    receive: (id: string, input: ReceiveMessages = {}, options?: RequestOptions) =>
      action<{ messages: QueueMessage[] }>(id, "receive", input, options),
    ack: (id: string, input: { receiptHandles: string[] }, options?: RequestOptions) =>
      action<ReceiptResult>(id, "ack", input, options),
    retry: (
      id: string,
      input: { receiptHandle: string; visibilitySeconds: number },
      options?: RequestOptions,
    ) => action<{ receiptHandle: string; visibilitySeconds: number }>(id, "retry", input, options),
    /** Receive, handle, then acknowledge. No acknowledgement precedes success.
     * A failed or cancelled handler releases its receipt at once. Aborting
     * during receive can lose its reply; that lease expires without an ack.
     * Settlement ignores the cancelled signal and has a bounded deadline.
     * A lost settlement reply is retried once with the same key, even when
     * transport retries were disabled. A remaining failure is thrown. */
    async consume(
      id: string,
      handler: QueueHandler,
      options: ConsumeOptions = {},
    ): Promise<ConsumeResult> {
      const { max, waitSeconds = 20, visibilitySeconds, timeoutMs = 30_000 } = options;
      for (const [field, value, minimum, maximum] of [
        ["max", max, 0, Number.MAX_SAFE_INTEGER],
        ["waitSeconds", waitSeconds, 0, 20],
        ["visibilitySeconds", visibilitySeconds, 0, 43_200],
        ["timeoutMs", timeoutMs, 1, 2_147_483_647],
      ] as const) {
        if (
          value !== undefined &&
          (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        )
          throw new RuntimeError({
            code: "invalid_request",
            status: 0,
            message: `${field} must be an integer from ${minimum} to ${maximum}.`,
            hint: "Correct the consume option; no message was received.",
          });
      }
      const signal = options.signal ?? new AbortController().signal;
      const result: ConsumeResult = { processed: 0, acknowledged: 0, retried: 0, aborted: false };
      const settle = async <T>(verb: "ack" | "retry", body: unknown): Promise<T> => {
        const request = { idempotencyKey: crypto.randomUUID(), timeoutMs };
        try {
          return await action<T>(id, verb, body, request);
        } catch (error) {
          if (
            !(error instanceof RuntimeError) ||
            !["connection_error", "timeout"].includes(error.code)
          )
            throw error;
          return action<T>(id, verb, body, request);
        }
      };
      while (!signal.aborted && (max === undefined || result.processed < max)) {
        let received: { messages: QueueMessage[] };
        try {
          received = await action(
            id,
            "receive",
            {
              max: 1,
              waitSeconds,
              ...(visibilitySeconds === undefined ? {} : { visibilitySeconds }),
            },
            { signal, timeoutMs, idempotencyKey: crypto.randomUUID() },
          );
        } catch (error) {
          if (!signal.aborted) throw error;
          break;
        }
        if (received.messages.length > 1)
          throw new RuntimeError({
            code: "invalid_response",
            status: 0,
            message: "Receive returned more than the one message requested.",
            hint: "No message was acknowledged; their visibility leases will expire.",
          });
        const message = received.messages[0];
        if (!message) {
          // Empty short polls must yield to cancellation and avoid a hot loop.
          await pause(100, signal).catch(() => {});
          continue;
        }
        let success = false;
        if (!signal.aborted) {
          result.processed++;
          success = await handleMessage(handler, message, signal);
        }
        if (success && !signal.aborted) {
          const ack = await settle<ReceiptResult>("ack", {
            receiptHandles: [message.receiptHandle],
          });
          const failed = ack.failed[0];
          if (failed || !ack.successful.includes(message.receiptHandle))
            throw new RuntimeError({
              code: failed?.code ?? "invalid_response",
              status: 0,
              message: failed?.message ?? "The receipt was not acknowledged.",
              hint:
                failed?.hint ??
                "Do not assume delivery completed; this message can be delivered again.",
              details: { receiptHandle: message.receiptHandle },
            });
          result.acknowledged++;
        } else {
          await settle("retry", { receiptHandle: message.receiptHandle, visibilitySeconds: 0 });
          result.retried++;
        }
      }
      result.aborted = signal.aborted;
      return result;
    },
    /** Purge returns the resource; follow its state with wait(id). */
    purge: (id: string, options?: RequestOptions) => action<Queue>(id, "purge", {}, options),
  };
}
