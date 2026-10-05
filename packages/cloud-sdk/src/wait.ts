import type { RequestOptions } from "./transport.js";

/** A wait that an abort ends at once, rejecting with the signal's reason. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    function stop() {
      clearTimeout(timer);
      reject(abortError(signal!));
    }
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

/** How long a start waits for a first install (Chromium, the desktop) when
 * the caller sets no deadline. */
const INSTALL_WAIT_MS = 600_000;

/**
 * Calls `attempt` until it stops answering one of `codes` (something is
 * still installing), within one budget: the caller's `timeoutMs`, else ten
 * minutes. Each try gets what is left of it; a wait between tries ends at once
 * on abort, and no try starts once the budget cannot cover the wait the API
 * asked for: the installing error is thrown instead.
 */
export async function whileInstalling<T>(
  codes: readonly string[],
  options: RequestOptions | undefined,
  attempt: (options: RequestOptions) => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + (options?.timeoutMs || INSTALL_WAIT_MS);
  for (;;) {
    if (options?.signal?.aborted) throw abortError(options.signal);
    const left = Math.max(1, Math.ceil(deadline - performance.now()));
    try {
      return await attempt(options?.timeoutMs ? { ...options, timeoutMs: left } : { ...options });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const wait = (error as { retryAfterMs?: number }).retryAfterMs ?? 10_000;
      if (!code || !codes.includes(code) || performance.now() + wait > deadline) throw error;
      await pause(wait, options?.signal);
    }
  }
}
