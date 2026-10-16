import { RuntimeError } from "../errors.js";
import { Page } from "../page.js";
import type { RequestOptions, Transport } from "../transport.js";
import { pause } from "../wait.js";

/** The five verbs every resource product shares (CLOUD.md section 4, "One
 * shape for every interface"; packages/cloud/src/api/resource-product.ts),
 * and following one to a state. A product builds its client on these and
 * adds only its own verbs. */
export type ResourceRecord = {
  id: string;
  state: string;
  error: { code: string; message: string } | null;
};
export type ResourceListQuery<S extends string = string> = {
  name?: string;
  /** Repeated key:value filters; all must match. */
  label?: readonly string[];
  /** Defaults to the product's live states. */
  state?: readonly S[];
  /** 1 to 100; defaults to 50. */
  limit?: number;
  cursor?: string;
};
export type ResourceGetOptions<S extends string = string> = RequestOptions & {
  waitFor?: S;
  /** Server wait, 1 to 60 seconds; defaults to 30. Check the returned state. */
  timeoutSeconds?: number;
};
export type ResourceWaitOptions = RequestOptions & {
  /** Whole wait, including retries; defaults to 300000 ms. 0 disables it. */
  timeoutMs?: number;
  /** Delay between reads; defaults to 250 ms. */
  pollMs?: number;
};
export type ResourceDeleteOptions = ResourceWaitOptions & { wait?: boolean };

export const enc = encodeURIComponent;

function invalid(field: string): RuntimeError {
  return new RuntimeError({
    code: "invalid_request",
    status: 0,
    message: `${field} must be a finite, nonnegative number.`,
    hint: "Fix the option and call again; nothing was sent.",
    details: { field },
  });
}

/** One deadline covers the write, retries and every read. A timed-out delete
 * can be retried after a process restart with this same key. */
export async function following<T>(
  options: ResourceWaitOptions,
  work: (request: RequestOptions, pause: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const { pollMs = 250, timeoutMs = 300_000, signal, ...rest } = options;
  if (!Number.isFinite(pollMs) || pollMs < 0) throw invalid("pollMs");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw invalid("timeoutMs");
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = timeoutMs > 0 ? setTimeout(() => deadline.abort(), timeoutMs) : undefined;
  const request = { ...rest, timeoutMs: 0, signal: combined };
  const poll = () => pause(pollMs, combined);
  try {
    combined.throwIfAborted();
    const result = await work(request, poll);
    combined.throwIfAborted();
    return result;
  } catch (cause) {
    if (!combined.aborted) {
      // A read failure still belongs to the write that started this wait.
      // Keep its key so a caller can recover after losing the reply.
      if (cause instanceof RuntimeError && rest.idempotencyKey && !cause.idempotencyKey)
        throw new RuntimeError({
          message: cause.message,
          code: cause.code,
          status: cause.status,
          requestId: cause.requestId,
          hint: cause.hint,
          details: cause.details,
          retryAfterMs: cause.retryAfterMs,
          idempotencyKey: rest.idempotencyKey,
          cause,
        });
      throw cause;
    }
    throw new RuntimeError({
      code: "timeout",
      status: 0,
      message: "Waiting was cancelled or reached its deadline; the resource may still change.",
      hint: "Read the resource to resume waiting. Retry a write with the same idempotencyKey.",
      ...(rest.idempotencyKey === undefined ? {} : { idempotencyKey: rest.idempotencyKey }),
      cause,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** A resource product's client at `/v1/<path>`. A wait ends at its target
 * or at any of `settled`, which answers with the resource's error. */
export function resource<R extends ResourceRecord, C, U, S extends string = R["state"]>(
  t: Transport,
  path: string,
  settled: readonly S[],
) {
  const base = `/v1/${path}`;
  const get = (id: string, options: ResourceGetOptions<S> = {}): Promise<R> => {
    const { waitFor, timeoutSeconds, ...request } = options;
    return t.json<R>({
      method: "GET",
      path: `${base}/${enc(id)}`,
      query: { waitFor, timeoutSeconds },
      ...request,
    });
  };
  const list = async (
    query: ResourceListQuery<S> = {},
    options?: RequestOptions,
  ): Promise<Page<R>> => {
    const page = await t.json<{ data: R[]; nextCursor: string | null }>({
      method: "GET",
      path: base,
      query,
      ...options,
    });
    return new Page(page.data, page.nextCursor, (cursor) => list({ ...query, cursor }, options));
  };
  const follow = async (
    id: string,
    target: S,
    request: RequestOptions,
    pause: () => Promise<void>,
    initial?: R,
  ): Promise<R> => {
    let record = initial ?? (await get(id, request));
    for (;;) {
      if (record.state === target) return record;
      if ((settled as readonly string[]).includes(record.state))
        throw new RuntimeError({
          code: record.error?.code ?? "unexpected_state",
          status: 0,
          message:
            record.error?.message ?? `Expected ${target}, but ${id} reached ${record.state}.`,
          hint: "Read the resource and inspect its error before starting another change.",
          details: { id, state: record.state, target, resource: record },
          ...(request.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: request.idempotencyKey }),
        });
      await pause();
      record = await get(id, request);
    }
  };
  return {
    base,
    /** Defaults belong to the API, so the SDK does not override them. */
    create: (input: C, options?: RequestOptions) =>
      t.json<R>({ method: "POST", path: base, body: input, ...options }),
    get,
    list,
    update: (id: string, input: U, options?: RequestOptions) =>
      t.json<R>({ method: "POST", path: `${base}/${enc(id)}:update`, body: input, ...options }),
    wait: (id: string, target: S, options: ResourceWaitOptions = {}) =>
      following(options, (request, pause) => follow(id, target, request, pause)),
    delete: (id: string, options: ResourceDeleteOptions = {}): Promise<R> => {
      const { wait = false, pollMs, ...request } = options;
      const remove = (rest: RequestOptions) =>
        t.json<R>({ method: "DELETE", path: `${base}/${enc(id)}`, ...rest });
      if (!wait) return remove(request);
      return following(
        { ...request, pollMs, idempotencyKey: request.idempotencyKey ?? crypto.randomUUID() },
        async (rest, pause) => follow(id, "deleted" as S, rest, pause, await remove(rest)),
      );
    },
  };
}
